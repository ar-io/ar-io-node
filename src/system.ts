/**
 * AR.IO Gateway
 * Copyright (C) 2023 Permanent Data Solutions, Inc
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
import * as promClient from 'prom-client';

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
import log from './log.js';
import { MemoryCacheArNSResolver } from './resolution/memory-cache-arns-resolver.js';
import { StreamingManifestPathResolver } from './resolution/streaming-manifest-path-resolver.js';
import { TrustedGatewayArNSResolver } from './resolution/trusted-gateway-arns-resolver.js';
import { FsBlockStore } from './store/fs-block-store.js';
import { FsChunkDataStore } from './store/fs-chunk-data-store.js';
import { FsDataStore } from './store/fs-data-store.js';
import { FsTransactionStore } from './store/fs-transaction-store.js';
import {
  BlockListValidator,
  ChainIndex,
  ContiguousDataIndex,
  DataItemIndexWriter,
  MatchableItem,
  NestedDataIndexWriter,
  PartialJsonTransaction,
} from './types.js';
import { Ans104DataIndexer } from './workers/ans104-data-indexer.js';
import { Ans104Unbundler } from './workers/ans104-unbundler.js';
import { BlockImporter } from './workers/block-importer.js';
import { DataItemIndexer } from './workers/data-item-indexer.js';
import { TransactionFetcher } from './workers/transaction-fetcher.js';
import { TransactionImporter } from './workers/transaction-importer.js';
import { TransactionRepairWorker } from './workers/transaction-repair-worker.js';

// Global errors counter
export const errorsCounter = new promClient.Counter({
  name: 'errors_total',
  help: 'Total error count',
});

// Uncaught exception handler
export const uncaughtExceptionCounter = new promClient.Counter({
  name: 'uncaught_exceptions_total',
  help: 'Count of uncaught exceptions',
});
process.on('uncaughtException', (error) => {
  uncaughtExceptionCounter.inc();
  log.error('Uncaught exception:', error);
});

const arweave = Arweave.init({});

export const arweaveClient = new ArweaveCompositeClient({
  log,
  metricsRegistry: promClient.register,
  arweave,
  trustedNodeUrl: config.TRUSTED_NODE_URL,
  skipCache: config.SKIP_CACHE,
  blockStore: new FsBlockStore({
    log,
    baseDir: 'data/headers/partial-blocks',
    tmpDir: 'data/tmp/partial-blocks',
  }),
  txStore: new FsTransactionStore({
    log,
    baseDir: 'data/headers/partial-txs',
    tmpDir: 'data/tmp/partial-txs',
  }),
  failureSimulator: new UniformFailureSimulator({
    failureRate: config.SIMULATED_REQUEST_FAILURE_RATE,
  }),
});

export const db = new StandaloneSqliteDatabase({
  log,
  metricsRegistry: promClient.register,
  coreDbPath: 'data/sqlite/core.db',
  dataDbPath: 'data/sqlite/data.db',
  moderationDbPath: 'data/sqlite/moderation.db',
  bundlesDbPath: 'data/sqlite/bundles.db',
});

export const chainIndex: ChainIndex = db;
export const contiguousDataIndex: ContiguousDataIndex = db;
export const blockListValidator: BlockListValidator = db;
export const nestedDataIndexWriter: NestedDataIndexWriter = db;
export const dataItemIndexWriter: DataItemIndexWriter = db;

// Workers
const eventEmitter = new EventEmitter();

export const blockImporter = new BlockImporter({
  log,
  metricsRegistry: promClient.register,
  errorsCounter,
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

eventEmitter.on(events.TX_INDEXED, async (tx: MatchableItem) => {
  if (await ans104TxMatcher.match(tx)) {
    eventEmitter.emit(events.ANS104_TX_INDEXED, tx);
  }
});

const txFetcher = new TransactionFetcher({
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

// Configure contigous data source
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
});

eventEmitter.on(
  events.ANS104_TX_INDEXED,
  async (tx: PartialJsonTransaction) => {
    if (await config.ANS104_UNBUNDLE_FILTER.match(tx)) {
      ans104Unbundler.queueItem({
        index: -1, // parent indexes are not needed for L1
        ...tx,
      });
    }
  },
);

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

eventEmitter.on(events.ANS104_DATA_ITEM_UNBUNDLED, async (dataItem: any) => {
  if (await config.ANS104_INDEX_FILTER.match(dataItem)) {
    dataItemIndexer.queueDataItem(dataItem);
    ans104DataIndexer.queueDataItem(dataItem);
  }
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
