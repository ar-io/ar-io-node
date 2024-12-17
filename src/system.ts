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
import fs from 'node:fs';
import { AOProcess, IO } from '@ar.io/sdk';
import awsLite from '@aws-lite/client';
import awsLiteS3 from '@aws-lite/s3';

import { ArweaveCompositeClient } from './arweave/composite-client.js';
import * as config from './config.js';
import { GatewaysDataSource } from './data/gateways-data-source.js';
import { ReadThroughChunkDataCache } from './data/read-through-chunk-data-cache.js';
import { ReadThroughDataCache } from './data/read-through-data-cache.js';
import { SequentialDataSource } from './data/sequential-data-source.js';
import { TxChunksDataSource } from './data/tx-chunks-data-source.js';
import { BundleDataImporter } from './workers/bundle-data-importer.js';
import { CompositeClickHouseDatabase } from './database/composite-clickhouse.js';
import { StandaloneSqliteDatabase } from './database/standalone-sqlite.js';
import * as events from './events.js';
import { MatchTags } from './filters.js';
import { UniformFailureSimulator } from './lib/chaos.js';
import {
  makeBlockStore,
  makeTxStore,
  makeSignatureStore,
} from './init/header-stores.js';
import { currentUnixTimestamp } from './lib/time.js';
import log from './log.js';
import * as metrics from './metrics.js';
import { StreamingManifestPathResolver } from './resolution/streaming-manifest-path-resolver.js';
import { FsChunkDataStore } from './store/fs-chunk-data-store.js';
import { FsDataStore } from './store/fs-data-store.js';
import {
  DataBlockListValidator,
  NameBlockListValidator,
  BundleIndex,
  ChainIndex,
  ChainOffsetIndex,
  ContiguousDataIndex,
  ContiguousDataSource,
  DataItemIndexWriter,
  GqlQueryable,
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
import { createArNSKvStore, createArNSResolver } from './init/resolvers.js';
import { MempoolWatcher } from './workers/mempool-watcher.js';
import { DataVerificationWorker } from './workers/data-verification.js';
import { ArIODataSource } from './data/ar-io-data-source.js';
import { S3DataSource } from './data/s3-data-source.js';
import { connect } from '@permaweb/aoconnect';
import { DataContentAttributeImporter } from './workers/data-content-attribute-importer.js';
import { SignatureFetcher } from './data/signature-fetcher.js';
import { SQLiteWalCleanupWorker } from './workers/sqlite-wal-cleanup-worker.js';
import { KvArnsStore } from './store/kv-arns-store.js';
import { parquetExporter } from './routes/ar-io.js';
import { server } from './app.js';
import { S3DataStore } from './store/s3-data-store.js';
import { BlockedNamesCache } from './blocked-names-cache.js';

process.on('uncaughtException', (error) => {
  metrics.uncaughtExceptionCounter.inc();
  log.error('Uncaught exception:', error);
});

const arweave = Arweave.init({});

// IO/AO SDK

const arIO = IO.init({
  process: new AOProcess({
    processId: config.IO_PROCESS_ID,
    ao: connect({
      // @permaweb/aoconnect defaults will be used if these are not provided
      MU_URL: config.AO_MU_URL,
      CU_URL: config.AO_CU_URL,
      GRAPHQL_URL: config.AO_GRAPHQL_URL,
      GATEWAY_URL: config.AO_GATEWAY_URL,
    }),
  }),
});

export const awsClient =
  config.AWS_ACCESS_KEY_ID !== undefined &&
  config.AWS_SECRET_ACCESS_KEY !== undefined &&
  config.AWS_REGION !== undefined
    ? await awsLite({
        accessKeyId: config.AWS_ACCESS_KEY_ID,
        secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
        endpoint: config.AWS_ENDPOINT,
        region: config.AWS_REGION,
        plugins: [awsLiteS3],
      })
    : undefined;

export const arweaveClient = new ArweaveCompositeClient({
  log,
  arweave,
  trustedNodeUrl: config.TRUSTED_NODE_URL,
  chunkPostUrls: config.CHUNK_POST_URLS,
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
metrics.registerQueueLengthGauge('arweaveClientRequests', {
  length: () => arweaveClient.queueDepth(),
});

export const db = new StandaloneSqliteDatabase({
  log,
  coreDbPath: 'data/sqlite/core.db',
  dataDbPath: 'data/sqlite/data.db',
  moderationDbPath: 'data/sqlite/moderation.db',
  bundlesDbPath: 'data/sqlite/bundles.db',
  tagSelectivity: config.TAG_SELECTIVITY,
});

export const chainIndex: ChainIndex = db;
export const chainOffsetIndex: ChainOffsetIndex = db;
export const bundleIndex: BundleIndex = db;
export const contiguousDataIndex: ContiguousDataIndex = db;
export const dataBlockListValidator: DataBlockListValidator = db;
export const nameBlockListValidator: NameBlockListValidator = db;
export const nestedDataIndexWriter: NestedDataIndexWriter = db;
export const dataItemIndexWriter: DataItemIndexWriter = db;
export const gqlQueryable: GqlQueryable = (() => {
  if (config.CLICKHOUSE_URL !== undefined) {
    return new CompositeClickHouseDatabase({
      log,
      gqlQueryable: db,
      url: config.CLICKHOUSE_URL,
    });
  }

  return db;
})();

// Workers
export const eventEmitter = new EventEmitter();
eventEmitter.setMaxListeners(100);

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
metrics.registerQueueLengthGauge('txFetcher', {
  length: () => txFetcher.queueDepth(),
});

// Async fetch block TXs that failed sync fetch
eventEmitter.on(events.BLOCK_TX_FETCH_FAILED, ({ id: txId }) => {
  txFetcher.queueTxId({ txId });
});

const txImporter = new TransactionImporter({
  log,
  chainIndex,
  eventEmitter,
});
metrics.registerQueueLengthGauge('txImporter', {
  length: () => txImporter.queueDepth(),
});

// Queue fetched TXs to
eventEmitter.addListener(events.TX_FETCHED, (tx: PartialJsonTransaction) => {
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
metrics.registerQueueLengthGauge('txOffsetImporter', {
  length: () => txOffsetImporter.queueDepth(),
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

const gatewaysDataSource = new GatewaysDataSource({
  log,
  trustedGatewaysUrls: config.TRUSTED_GATEWAYS_URLS,
});

const arIODataSource = new ArIODataSource({
  log,
  arIO,
  nodeWallet: config.AR_IO_WALLET,
});

const s3DataSource =
  awsClient !== undefined && config.AWS_S3_CONTIGUOUS_DATA_BUCKET !== undefined
    ? new S3DataSource({
        log,
        s3Client: awsClient.S3,
        s3Bucket: config.AWS_S3_CONTIGUOUS_DATA_BUCKET,
        s3Prefix: config.AWS_S3_CONTIGUOUS_DATA_PREFIX,
        awsClient,
      })
    : undefined;

function getDataSource(sourceName: string): ContiguousDataSource | undefined {
  switch (sourceName) {
    case 's3':
      return s3DataSource;
    case 'ario-peer':
      return arIODataSource;
    case 'trusted-gateways':
      return gatewaysDataSource;
    case 'chunks':
      return txChunksDataSource;
    case 'tx-data':
      return arweaveClient;
    default:
      throw new Error(`Unknown data source: ${sourceName}`);
  }
}

const onDemandDataSources: ContiguousDataSource[] = [];
for (const sourceName of config.ON_DEMAND_RETRIEVAL_ORDER) {
  const dataSource = getDataSource(sourceName);
  if (dataSource !== undefined) {
    onDemandDataSources.push(dataSource);
  }
}

const backgroundDataSources: ContiguousDataSource[] = [];
for (const sourceName of config.BACKGROUND_RETRIEVAL_ORDER) {
  const dataSource = getDataSource(sourceName);
  if (dataSource !== undefined) {
    backgroundDataSources.push(dataSource);
  }
}

const dataContentAttributeImporter = new DataContentAttributeImporter({
  log,
  contiguousDataIndex: contiguousDataIndex,
});
metrics.registerQueueLengthGauge('dataContentAttributeImporter', {
  length: () => dataContentAttributeImporter.queueDepth(),
});

const contiguousDataStore =
  awsClient !== undefined && config.AWS_S3_CONTIGUOUS_DATA_BUCKET !== undefined
    ? new S3DataStore({
        log,
        baseDir: 'data/contiguous',
        s3Client: awsClient.S3,
        s3Prefix: config.AWS_S3_CONTIGUOUS_DATA_PREFIX,
        s3Bucket: config.AWS_S3_CONTIGUOUS_DATA_BUCKET,
      })
    : new FsDataStore({
        log,
        baseDir: 'data/contiguous',
      });

export const onDemandContiguousDataSource = new ReadThroughDataCache({
  log,
  dataSource: new SequentialDataSource({
    log,
    dataSources: onDemandDataSources,
  }),
  dataStore: contiguousDataStore,
  contiguousDataIndex,
  dataContentAttributeImporter,
});

export const backgroundContiguousDataSource = new ReadThroughDataCache({
  log,
  dataSource: new SequentialDataSource({
    log,
    dataSources: backgroundDataSources,
  }),
  dataStore: contiguousDataStore,
  contiguousDataIndex,
  dataContentAttributeImporter,
});

export const dataItemIndexer = new DataItemIndexer({
  log,
  eventEmitter,
  indexWriter: dataItemIndexWriter,
});
metrics.registerQueueLengthGauge('dataItemIndexer', {
  length: () => dataItemIndexer.queueDepth(),
});

const ans104DataIndexer = new Ans104DataIndexer({
  log,
  eventEmitter,
  indexWriter: nestedDataIndexWriter,
  contiguousDataIndex,
});
metrics.registerQueueLengthGauge('ans104DataIndexer', {
  length: () => ans104DataIndexer.queueDepth(),
});

const shouldUnbundleDataItems = () =>
  ans104DataIndexer.queueDepth() < config.MAX_DATA_ITEM_QUEUE_SIZE &&
  dataItemIndexer.queueDepth() < config.MAX_DATA_ITEM_QUEUE_SIZE;

const ans104Unbundler = new Ans104Unbundler({
  log,
  eventEmitter,
  filter: config.ANS104_UNBUNDLE_FILTER,
  contiguousDataSource: backgroundContiguousDataSource,
  dataItemIndexFilterString: config.ANS104_INDEX_FILTER_STRING,
  workerCount: config.ANS104_UNBUNDLE_WORKERS,
  shouldUnbundle: shouldUnbundleDataItems,
});
metrics.registerQueueLengthGauge('ans104Unbundler', {
  length: () => ans104Unbundler.queueDepth(),
});

export const bundleDataImporter = new BundleDataImporter({
  log,
  contiguousDataSource: backgroundContiguousDataSource,
  ans104Unbundler,
  workerCount: config.ANS104_DOWNLOAD_WORKERS,
  maxQueueSize: config.BUNDLE_DATA_IMPORTER_QUEUE_SIZE,
});
metrics.registerQueueLengthGauge('bundleDataImporter', {
  length: () => bundleDataImporter.queueDepth(),
});

async function queueBundle(
  item: NormalizedDataItem | PartialJsonTransaction,
  isPrioritized = false,
  bypassFilter = false,
) {
  try {
    if ('root_tx_id' in item && item.root_tx_id === null) {
      log.debug('Skipping download of optimistically indexed data item', {
        id: item.id,
        rootTxId: item.root_tx_id,
        parentId: item.parent_id,
      });
      return;
    }

    await db.saveBundle({
      id: item.id,
      rootTransactionId: 'root_tx_id' in item ? item.root_tx_id : item.id,
      format: 'ans-104',
    });

    if (bypassFilter || (await config.ANS104_UNBUNDLE_FILTER.match(item))) {
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
          ...item,
          index:
            'parent_index' in item && item.parent_index !== undefined
              ? item.parent_index
              : -1, // parent indexes are not needed for L1
        },
        isPrioritized,
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
  } catch (error: any) {
    log.error('Error saving or queueing bundle', {
      message: error.message,
      stack: error.stack,
    });
  }
}

// Queue bundles from the queue-bundle route
eventEmitter.on(
  events.ANS104_BUNDLE_QUEUED,
  async (item: NormalizedDataItem | PartialJsonTransaction) => {
    await queueBundle(item, true, true);
  },
);

// Queue L1 bundles
eventEmitter.on(
  events.ANS104_TX_INDEXED,
  async (item: NormalizedDataItem | PartialJsonTransaction) => {
    const isPrioritized = prioritizedTxIds.has(item.id);
    prioritizedTxIds.delete(item.id);

    await queueBundle(item, isPrioritized);
  },
);

// Queue nested bundles
eventEmitter.on(
  events.ANS104_NESTED_BUNDLE_INDEXED,
  async (item: NormalizedDataItem | PartialJsonTransaction) => {
    await queueBundle(item, true);
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
  } catch (error: any) {
    log.error('Error saving unbundle completion', {
      parentId: bundleEvent.parentId,
      message: error.message,
      stack: error.stack,
    });
  }
});

eventEmitter.on(events.ANS104_DATA_ITEM_MATCHED, async (dataItem: any) => {
  metrics.dataItemsQueuedCounter.inc({ bundle_format: 'ans-104' });
  dataItemIndexer.queueDataItem(dataItem);
  ans104DataIndexer.queueDataItem(dataItem);
});

export const manifestPathResolver = new StreamingManifestPathResolver({
  log,
});

export const arnsResolverCache = new KvArnsStore({
  kvBufferStore: createArNSKvStore({
    log,
    type: config.ARNS_CACHE_TYPE,
    redisUrl: config.REDIS_CACHE_URL,
    ttlSeconds: config.ARNS_CACHE_TTL_SECONDS,
    maxKeys: config.ARNS_CACHE_MAX_KEYS,
    useTls: config.REDIS_USE_TLS,
  }),
});

export const nameResolver = createArNSResolver({
  log,
  trustedGatewayUrl: config.TRUSTED_ARNS_GATEWAY_URL,
  resolutionOrder: config.ARNS_RESOLVER_PRIORITY_ORDER,
  networkProcess: arIO,
  cache: arnsResolverCache,
  overrides: {
    ttlSeconds: config.ARNS_RESOLVER_OVERRIDE_TTL_SECONDS,
    // TODO: other overrides like fallback txId if not found in resolution
  },
});

const webhookEmitter = new WebhookEmitter({
  eventEmitter,
  targetServersUrls: config.WEBHOOK_TARGET_SERVERS,
  indexFilter: config.WEBHOOK_INDEX_FILTER,
  blockFilter: config.WEBHOOK_BLOCK_FILTER,
  log,
});
metrics.registerQueueLengthGauge('webhookEmitter', {
  length: () => webhookEmitter.queueDepth(),
});

export const mempoolWatcher = config.ENABLE_MEMPOOL_WATCHER
  ? new MempoolWatcher({
      log,
      chainSource: arweaveClient,
      txFetcher,
      mempoolPollingIntervalMs: config.MEMPOOL_POLLING_INTERVAL_MS,
    })
  : undefined;

export const signatureStore = makeSignatureStore({ log });
export const signatureFetcher = new SignatureFetcher({
  log,
  dataSource: onDemandContiguousDataSource,
  dataIndex: contiguousDataIndex,
  chainSource: arweaveClient,
  signatureStore,
});

const dataSqliteWalCleanupWorker = config.ENABLE_DATA_DB_WAL_CLEANUP
  ? new SQLiteWalCleanupWorker({
      log,
      db,
      dbName: 'data',
    })
  : undefined;

if (dataSqliteWalCleanupWorker !== undefined) {
  dataSqliteWalCleanupWorker.start();
}

const dataVerificationWorker = config.ENABLE_BACKGROUND_DATA_VERIFICATION
  ? new DataVerificationWorker({
      log,
      contiguousDataIndex,
      contiguousDataSource: gatewaysDataSource,
    })
  : undefined;

if (dataVerificationWorker !== undefined) {
  dataVerificationWorker.start();
}

export const blockedNamesCache = new BlockedNamesCache({
  log,
  cacheTTL: 3600,
  fetchInterval: 3600000,
  fetchBlockedNames: () => nameBlockListValidator.getBlockedNames(),
});

let isShuttingDown = false;

export const shutdown = async (exitCode = 0) => {
  if (isShuttingDown) {
    log.info('Shutdown already in progress');
  } else {
    isShuttingDown = true;
    log.info('Shutting down...');
    server.close(async () => {
      log.debug('Web server stopped successfully');
      eventEmitter.removeAllListeners();
      arIODataSource.stopUpdatingPeers();
      dataSqliteWalCleanupWorker?.stop();
      parquetExporter?.stop();
      await arnsResolverCache.close();
      await mempoolWatcher?.stop();
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
      await dataVerificationWorker?.stop();

      process.exit(exitCode);
    });
  }
};

// Handle shutdown signals
process.on('SIGINT', async () => {
  await shutdown();
});

process.on('SIGTERM', async () => {
  await shutdown();
});
