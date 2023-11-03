/**
 * AR.IO Gateway
 * Copyright (C) 2022-2023 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
import { default as Arweave } from 'arweave';
import EventEmitter from 'node:events';

import { ArweaveCompositeClient } from './arweave/composite-client.js';
import * as config from './config.js';
import { GatewayDataSource } from './data/gateway-data-source.js';
import { ReadThroughChunkDataCache } from './data/read-through-chunk-data-cache.js';
import { ReadThroughDataCache } from './data/read-through-data-cache.js';
import { SequentialDataSource } from './data/sequential-data-source.js';
import { TxChunksDataSource } from './data/tx-chunks-data-source.js';
import { StandaloneSqliteDatabase } from './database/standalone-sqlite.js';
import * as events from './events.js';
import { MatchTags } from './filters.js';
import { UniformFailureSimulator } from './lib/chaos.js';
import { currentUnixTimestamp } from './lib/time.js';
import log from './log.js';
import * as metrics from './metrics.js';
import { MemoryCacheArNSResolver } from './resolution/memory-cache-arns-resolver.js';
import { StreamingManifestPathResolver } from './resolution/streaming-manifest-path-resolver.js';
import { TrustedGatewayArNSResolver } from './resolution/trusted-gateway-arns-resolver.js';
import { FsBlockStore } from './store/fs-block-store.js';
import { FsChunkDataStore } from './store/fs-chunk-data-store.js';
import { FsDataStore } from './store/fs-data-store.js';
import { FsKVStore } from './store/fs-kv-store.js';
import { KvTransactionStore } from './store/kv-transaction-store.js';
import { LmdbKVStore } from './store/lmdb-kv-store.js';
import {
  BlockListValidator,
  BundleIndex,
  ChainIndex,
  ContiguousDataIndex,
  DataItemIndexWriter,
  MatchableItem,
  NestedDataIndexWriter,
  NormalizedDataItem,
  PartialJsonTransaction,
} from './types.js';
import { Ans104DataIndexer } from './workers/ans104-data-indexer.js';
import { Ans104Unbundler } from './workers/ans104-unbundler.js';
import { BlockImporter } from './workers/block-importer.js';
import { BundleRepairWorker } from './workers/bundle-repair-worker.js';
import { DataItemIndexer } from './workers/data-item-indexer.js';
import { TransactionFetcher } from './workers/transaction-fetcher.js';
import { TransactionImporter } from './workers/transaction-importer.js';
import { TransactionRepairWorker } from './workers/transaction-repair-worker.js';

process.on('uncaughtException', (error) => {
  metrics.uncaughtExceptionCounter.inc();
  log.error('Uncaught exception:', error);
});

const arweave = Arweave.init({});

// Stores

const txStore = new KvTransactionStore({
  log,
  kvBufferStore: (() => {
    log.info('Creating chain cache key/value store', {
      type: config.CHAIN_CACHE_TYPE,
    });
    switch (config.CHAIN_CACHE_TYPE) {
      case 'lmdb': {
        return new LmdbKVStore({
          lmdbOptions: {
            path: 'data/lmdb/partial-txs',
            // TODO: set sensible default options for LMDB client
          },
        });
      }
      case 'fs': {
        return new FsKVStore({
          baseDir: 'data/headers/partial-txs',
          tmpDir: 'data/tmp/partial-txs',
        });
      }
      default: {
        throw new Error(`Invalid chain cache type: ${config.CHAIN_CACHE_TYPE}`);
      }
    }
  })(),
});

// TODO: replace with KvBlockStore
const blockStore = new FsBlockStore({
  log,
  baseDir: 'data/headers/partial-blocks',
  tmpDir: 'data/tmp/partial-blocks',
});

export const arweaveClient = new ArweaveCompositeClient({
  log,
  arweave,
  trustedNodeUrl: config.TRUSTED_NODE_URL,
  skipCache: config.SKIP_CACHE,
  blockStore,
  txStore,
  failureSimulator: new UniformFailureSimulator({
    failureRate: config.SIMULATED_REQUEST_FAILURE_RATE,
  }),
});

export const db = new StandaloneSqliteDatabase({
  log,
  coreDbPath: 'data/sqlite/core.db',
  dataDbPath: 'data/sqlite/data.db',
  moderationDbPath: 'data/sqlite/moderation.db',
  bundlesDbPath: 'data/sqlite/bundles.db',
});

export const chainIndex: ChainIndex = db;
export const bundleIndex: BundleIndex = db;
export const contiguousDataIndex: ContiguousDataIndex = db;
export const blockListValidator: BlockListValidator = db;
export const nestedDataIndexWriter: NestedDataIndexWriter = db;
export const dataItemIndexWriter: DataItemIndexWriter = db;

// Workers
const eventEmitter = new EventEmitter();

export const blockImporter = new BlockImporter({
  log,
  chainSource: arweaveClient,
  chainIndex,
  eventEmitter,
  startHeight: config.START_HEIGHT,
  stopHeight: config.STOP_HEIGHT,
});

eventEmitter.on(events.BLOCK_TX_INDEXED, (tx) => {
  eventEmitter.emit(events.TX_INDEXED, tx);
});

const ans104TxMatcher = new MatchTags([
  { name: 'Bundle-Format', value: 'binary' },
  { name: 'Bundle-Version', valueStartsWith: '2.' },
]);

export const prioritizedTxIds = new Set<string>();

eventEmitter.on(events.TX_INDEXED, async (tx: MatchableItem) => {
  if (await ans104TxMatcher.match(tx)) {
    metrics.bundlesCounter.inc({
      bundle_format: 'ans-104',
      parent_type: 'transaction',
    });
    eventEmitter.emit(events.ANS104_TX_INDEXED, tx);
    eventEmitter.emit(events.ANS104_BUNDLE_INDEXED, tx);
  }
});

eventEmitter.on(
  events.ANS104_DATA_ITEM_DATA_INDEXED,
  async (item: MatchableItem) => {
    if (await ans104TxMatcher.match(item)) {
      metrics.bundlesCounter.inc({
        bundle_format: 'ans-104',
        parent_type: 'data_item',
      });
      eventEmitter.emit(events.ANS104_NESTED_BUNDLE_INDEXED, item);
      eventEmitter.emit(events.ANS104_BUNDLE_INDEXED, item);
    }
  },
);

export const txFetcher = new TransactionFetcher({
  log,
  chainSource: arweaveClient,
  eventEmitter,
});

// Async fetch block TXs that failed sync fetch
eventEmitter.on(events.BLOCK_TX_FETCH_FAILED, ({ id: txId }) => {
  txFetcher.queueTxId(txId);
});

const txImporter = new TransactionImporter({
  log,
  chainIndex,
  eventEmitter,
});

// Queue fetched TXs to
eventEmitter.addListener('tx-fetched', (tx: PartialJsonTransaction) => {
  txImporter.queueTx(tx);
});

export const txRepairWorker = new TransactionRepairWorker({
  log,
  chainIndex,
  txFetcher,
});

export const bundleRepairWorker = new BundleRepairWorker({
  log,
  bundleIndex,
  txFetcher,
  unbundleFilter: config.ANS104_UNBUNDLE_FILTER_STRING,
  indexFilter: config.ANS104_INDEX_FILTER_STRING,
  shouldBackfillBundles: config.BACKFILL_BUNDLE_RECORDS,
  filtersChanged: config.FILTER_CHANGE_REPROCESS,
});

// Configure contiguous data source
const chunkDataSource = new ReadThroughChunkDataCache({
  log,
  chunkSource: arweaveClient,
  chunkDataStore: new FsChunkDataStore({ log, baseDir: 'data/chunks' }),
});

const txChunksDataSource = new TxChunksDataSource({
  log,
  chainSource: arweaveClient,
  chunkSource: chunkDataSource,
});

const gatewayDataSource = new GatewayDataSource({
  log,
  trustedGatewayUrl: config.TRUSTED_GATEWAY_URL,
});

export const contiguousDataSource = new ReadThroughDataCache({
  log,
  dataSource: new SequentialDataSource({
    log,
    dataSources: [gatewayDataSource, txChunksDataSource, arweaveClient],
  }),
  dataStore: new FsDataStore({ log, baseDir: 'data/contiguous' }),
  contiguousDataIndex,
});

const ans104Unbundler = new Ans104Unbundler({
  log,
  eventEmitter,
  filter: config.ANS104_UNBUNDLE_FILTER,
  contiguousDataSource,
  dataItemIndexFilterString: config.ANS104_INDEX_FILTER_STRING,
});

eventEmitter.on(
  events.ANS104_BUNDLE_INDEXED,
  async (item: NormalizedDataItem | PartialJsonTransaction) => {
    try {
      await db.saveBundle({
        id: item.id,
        rootTransactionId: 'root_tx_id' in item ? item.root_tx_id : item.id,
        format: 'ans-104',
      });
      const prioritized = prioritizedTxIds.has(item.id);
      prioritizedTxIds.delete(item.id);
      if (await config.ANS104_UNBUNDLE_FILTER.match(item)) {
        metrics.bundlesMatchedCounter.inc({ bundle_format: 'ans-104' });
        await db.saveBundle({
          id: item.id,
          format: 'ans-104',
          unbundleFilter: config.ANS104_UNBUNDLE_FILTER_STRING,
          indexFilter: config.ANS104_INDEX_FILTER_STRING,
          queuedAt: currentUnixTimestamp(),
        });
        ans104Unbundler.queueItem(
          {
            index:
              'parent_index' in item && item.parent_index !== undefined
                ? item.parent_index
                : -1, // parent indexes are not needed for L1
            ...item,
          },
          prioritized,
        );
        metrics.bundlesQueuedCounter.inc({ bundle_format: 'ans-104' });
      } else {
        await db.saveBundle({
          id: item.id,
          format: 'ans-104',
          unbundleFilter: config.ANS104_UNBUNDLE_FILTER_STRING,
          skippedAt: currentUnixTimestamp(),
        });
      }
    } catch (error) {
      log.error('Error saving or queueing bundle', error);
    }
  },
);

eventEmitter.on(events.ANS104_UNBUNDLE_COMPLETE, async (bundleEvent: any) => {
  try {
    metrics.bundlesUnbundledCounter.inc({ bundle_format: 'ans-104' });
    db.saveBundle({
      id: bundleEvent.parentId,
      format: 'ans-104',
      dataItemCount: bundleEvent.itemCount,
      matchedDataItemCount: bundleEvent.matchedItemCount,
      unbundledAt: currentUnixTimestamp(),
    });
  } catch (error) {
    log.error('Error saving unbundle completion', error);
  }
});

const dataItemIndexer = new DataItemIndexer({
  log,
  eventEmitter,
  indexWriter: dataItemIndexWriter,
});

const ans104DataIndexer = new Ans104DataIndexer({
  log,
  eventEmitter,
  indexWriter: nestedDataIndexWriter,
});

eventEmitter.on(events.ANS104_DATA_ITEM_MATCHED, async (dataItem: any) => {
  metrics.dataItemsQueuedCounter.inc({ bundle_format: 'ans-104' });
  dataItemIndexer.queueDataItem(dataItem);
  ans104DataIndexer.queueDataItem(dataItem);
});

export const manifestPathResolver = new StreamingManifestPathResolver({
  log,
});

export const nameResolver = new MemoryCacheArNSResolver({
  log,
  resolver: new TrustedGatewayArNSResolver({
    log,
    trustedGatewayUrl: config.TRUSTED_ARNS_GATEWAY_URL,
  }),
});
