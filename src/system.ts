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
import { Server } from 'node:http';
import fs from 'node:fs';

import { ArweaveCompositeClient } from './arweave/composite-client.js';
import * as config from './config.js';
import { GatewayDataSource } from './data/gateway-data-source.js';
import { ReadThroughChunkDataCache } from './data/read-through-chunk-data-cache.js';
import { ReadThroughDataCache } from './data/read-through-data-cache.js';
import { SequentialDataSource } from './data/sequential-data-source.js';
import { TxChunksDataSource } from './data/tx-chunks-data-source.js';
import { BundleDataImporter } from './workers/bundle-data-importer.js';
import { StandaloneSqliteDatabase } from './database/standalone-sqlite.js';
import * as events from './events.js';
import { MatchTags } from './filters.js';
import { UniformFailureSimulator } from './lib/chaos.js';
import { makeBlockStore, makeTxStore } from './init/header-stores.js';
import { currentUnixTimestamp } from './lib/time.js';
import log from './log.js';
import * as metrics from './metrics.js';
import { MemoryCacheArNSResolver } from './resolution/memory-cache-arns-resolver.js';
import { StreamingManifestPathResolver } from './resolution/streaming-manifest-path-resolver.js';
import { FsChunkDataStore } from './store/fs-chunk-data-store.js';
import { FsDataStore } from './store/fs-data-store.js';
import {
  BlockListValidator,
  BundleIndex,
  ChainIndex,
  ChainOffsetIndex,
  ContiguousDataSource,
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
import { FsCleanupWorker } from './workers/fs-cleanup-worker.js';
import { TransactionFetcher } from './workers/transaction-fetcher.js';
import { TransactionImporter } from './workers/transaction-importer.js';
import { TransactionRepairWorker } from './workers/transaction-repair-worker.js';
import { TransactionOffsetImporter } from './workers/transaction-offset-importer.js';
import { TransactionOffsetRepairWorker } from './workers/transaction-offset-repair-worker.js';
import { WebhookEmitter } from './workers/webhook-emitter.js';
import { createArNSResolver } from './init/resolvers.js';

process.on('uncaughtException', (error) => {
  metrics.uncaughtExceptionCounter.inc();
  log.error('Uncaught exception:', error);
});

const arweave = Arweave.init({});

export const arweaveClient = new ArweaveCompositeClient({
  log,
  arweave,
  trustedNodeUrl: config.TRUSTED_NODE_URL,
  skipCache: config.SKIP_CACHE,
  blockStore: makeBlockStore({
    log,
    type: config.CHAIN_CACHE_TYPE,
  }),
  txStore: makeTxStore({
    log,
    type: config.CHAIN_CACHE_TYPE,
  }),
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
export const chainOffsetIndex: ChainOffsetIndex = db;
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

export const headerFsCacheCleanupWorker = config.ENABLE_FS_HEADER_CACHE_CLEANUP
  ? new FsCleanupWorker({
      log,
      basePath: 'data/headers',
    })
  : undefined;

const contiguousDataCacheCleanupThresholdInSeconds = parseInt(
  config.CONTIGUOUS_DATA_CACHE_CLEANUP_THRESHOLD,
);

export const contiguousDataFsCacheCleanupWorker = !isNaN(
  contiguousDataCacheCleanupThresholdInSeconds,
)
  ? new FsCleanupWorker({
      log,
      basePath: 'data/contiguous',
      shouldDelete: async (path) => {
        try {
          const stats = await fs.promises.stat(path);
          const mostRecentTime =
            stats.atime > stats.mtime ? stats.atime : stats.mtime;

          const currentTimestamp = Date.now();

          const thresholdDate = new Date(
            currentTimestamp -
              contiguousDataCacheCleanupThresholdInSeconds * 1000,
          );

          return mostRecentTime <= thresholdDate;
        } catch (err) {
          log.error(`Error getting file stats for ${path}`, err);
          return false;
        }
      },
    })
  : undefined;

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

const txOffsetImporter = new TransactionOffsetImporter({
  log,
  chainSource: arweaveClient,
  chainOffsetIndex,
});

export const txOffsetRepairWorker = new TransactionOffsetRepairWorker({
  log,
  chainOffsetIndex,
  txOffsetIndexer: txOffsetImporter,
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

const dataSources: ContiguousDataSource[] = [];
for (const sourceName of config.ON_DEMAND_RETRIEVAL_ORDER) {
  switch (sourceName) {
    case 'trusted-gateway':
      dataSources.push(gatewayDataSource);
      break;
    case 'chunks':
      dataSources.push(txChunksDataSource);
      break;
    case 'tx-data':
      dataSources.push(arweaveClient);
      break;
    default:
      throw new Error(`Unknown data source: ${sourceName}`);
  }
}

export const contiguousDataSource = new ReadThroughDataCache({
  log,
  dataSource: new SequentialDataSource({
    log,
    dataSources,
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
  workerCount: config.ANS104_UNBUNDLE_WORKERS,
});

const bundleDataImporter = new BundleDataImporter({
  log,
  contiguousDataSource,
  ans104Unbundler,
  workerCount: config.ANS104_DOWNLOAD_WORKERS,
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
        bundleDataImporter.queueItem(
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
  contiguousDataIndex,
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
  resolver: createArNSResolver({
    log,
    type: config.TRUSTED_ARNS_RESOLVER_TYPE,
    url: config.TRUSTED_ARNS_RESOLVER_URL,
  }),
});

const webhookEmitter = new WebhookEmitter({
  eventEmitter,
  targetServersUrls: config.WEBHOOK_TARGET_SERVERS,
  indexFilter: config.WEBHOOK_INDEX_FILTER,
  log,
});

let isShuttingDown = false;

export const shutdown = async (express: Server) => {
  if (isShuttingDown) {
    log.info('Shutdown already in progress');
  } else {
    isShuttingDown = true;
    log.info('Shutting down...');
    express.close(async () => {
      log.debug('Web server stopped successfully');
      eventEmitter.removeAllListeners();
      await blockImporter.stop();
      await dataItemIndexer.stop();
      await txRepairWorker.stop();
      await txImporter.stop();
      await txFetcher.stop();
      await txOffsetImporter.stop();
      await txOffsetRepairWorker.stop();
      await bundleDataImporter.stop();
      await bundleRepairWorker.stop();
      await ans104DataIndexer.stop();
      await ans104Unbundler.stop();
      await webhookEmitter.stop();
      await db.stop();
      await headerFsCacheCleanupWorker?.stop();
      await contiguousDataFsCacheCleanupWorker?.stop();

      process.exit(0);
    });
  }
};
