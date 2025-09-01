/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { default as Arweave } from 'arweave';
import EventEmitter from 'node:events';
import fs from 'node:fs';
import { AOProcess, ARIO, Logger as ARIOLogger } from '@ar.io/sdk';
import postgres from 'postgres';

import { ArweaveCompositeClient } from './arweave/composite-client.js';
import * as config from './config.js';
import { GatewaysDataSource } from './data/gateways-data-source.js';
import { ReadThroughDataCache } from './data/read-through-data-cache.js';
import { SequentialDataSource } from './data/sequential-data-source.js';
import { TxChunksDataSource } from './data/tx-chunks-data-source.js';
import { RootParentDataSource } from './data/root-parent-data-source.js';
import { Ans104OffsetSource } from './data/ans104-offset-source.js';
import { DataImporter } from './workers/data-importer.js';
import { CompositeClickHouseDatabase } from './database/composite-clickhouse.js';
import { StandaloneSqliteDatabase } from './database/standalone-sqlite.js';
import * as events from './events.js';
import { MatchTags, TagMatch } from './filters.js';
import { UniformFailureSimulator } from './lib/chaos.js';
import { DnsResolver } from './lib/dns-resolver.js';
import {
  makeBlockStore,
  makeTxStore,
  makeSignatureStore,
  makeOwnerStore,
  makeDataItemAttributesStore,
  makeTransactionAttributesStore,
} from './init/header-stores.js';
import {
  CompositeRootTxIndex,
  GraphQLRootTxIndex,
  TurboRootTxIndex,
} from './discovery/index.js';
import { LRUCache } from 'lru-cache';
import { makeContiguousMetadataStore } from './init/metadata-store.js';
import { currentUnixTimestamp } from './lib/time.js';
import log from './log.js';
import * as metrics from './metrics.js';
import { StreamingManifestPathResolver } from './resolution/streaming-manifest-path-resolver.js';
import { FsDataStore } from './store/fs-data-store.js';
import {
  DataBlockListValidator,
  NameBlockListValidator,
  BundleIndex,
  DataItemRootTxIndex,
  ChainIndex,
  ChainOffsetIndex,
  ContiguousDataIndex,
  ContiguousDataSource,
  DataItemIndexWriter,
  GqlQueryable,
  NestedDataIndexWriter,
  NormalizedDataItem,
  PartialJsonTransaction,
  MatchableTxLike,
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
import {
  createChunkDataSource,
  createChunkMetadataSource,
} from './init/chunk-sources.js';
import { MempoolWatcher } from './workers/mempool-watcher.js';
import { DataVerificationWorker } from './workers/data-verification.js';
import { ArIODataSource } from './data/ar-io-data-source.js';
import { ArIOChunkSource } from './data/ar-io-chunk-source.js';
import { ArIOPeerManager } from './data/ar-io-peer-manager.js';
import { S3DataSource } from './data/s3-data-source.js';
import { connect } from '@permaweb/aoconnect';
import { DataContentAttributeImporter } from './workers/data-content-attribute-importer.js';
import { SignatureFetcher, OwnerFetcher } from './data/attribute-fetchers.js';
import { SQLiteWalCleanupWorker } from './workers/sqlite-wal-cleanup-worker.js';
import { KvArNSResolutionStore } from './store/kv-arns-name-resolution-store.js';
import { parquetExporter } from './routes/ar-io.js';
import { server } from './app.js';
import { awsClient } from './aws-client.js';
import { BlockedNamesCache } from './blocked-names-cache.js';
import { KvArNSRegistryStore } from './store/kv-arns-base-name-store.js';
import { FullChunkSource } from './data/full-chunk-source.js';
import { TurboRedisDataSource } from './data/turbo-redis-data-source.js';
import { TurboDynamoDbDataSource } from './data/turbo-dynamodb-data-source.js';

process.on('uncaughtException', (error) => {
  metrics.uncaughtExceptionCounter.inc();
  log.error('Uncaught exception:', error);
});

const arweave = Arweave.init({});

// IO/AO SDK

ARIOLogger.default.setLogLevel(config.AR_IO_SDK_LOG_LEVEL as any);

const networkProcess = ARIO.init({
  process: new AOProcess({
    processId: config.IO_PROCESS_ID,
    ao: connect({
      // @permaweb/aoconnect defaults will be used if these are not provided
      MU_URL: config.AO_MU_URL,
      CU_URL: config.NETWORK_AO_CU_URL,
      GRAPHQL_URL: config.AO_GRAPHQL_URL,
      GATEWAY_URL: config.AO_GATEWAY_URL,
    }),
  }),
});

// Initialize DNS resolver for preferred chunk GET nodes if configured
const dnsResolver =
  config.PREFERRED_CHUNK_GET_NODE_URLS.length > 0
    ? new DnsResolver({ log })
    : undefined;

export const arweaveClient = new ArweaveCompositeClient({
  log,
  arweave,
  trustedNodeUrl: config.TRUSTED_NODE_URL,
  skipCache: config.SKIP_CACHE,
  preferredChunkGetUrls: config.PREFERRED_CHUNK_GET_NODE_URLS,
  dnsResolver,
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

// Create shared cache for root TX lookups
// LRUCache v11 requires values to be objects, not primitives with undefined
type CachedParentBundle = { bundleId?: string };
const rootTxCache = new LRUCache<string, CachedParentBundle>({
  max: config.ROOT_TX_CACHE_MAX_SIZE,
  ttl: config.ROOT_TX_CACHE_TTL_MS,
});

// Build indexes based on configuration
const rootTxIndexes: DataItemRootTxIndex[] = [];

for (const sourceName of config.ROOT_TX_LOOKUP_ORDER) {
  switch (sourceName.toLowerCase()) {
    case 'db':
      // Database is always available and doesn't need cache
      rootTxIndexes.push(db);
      break;

    case 'turbo':
      rootTxIndexes.push(
        new TurboRootTxIndex({
          log,
          turboEndpoint: config.TURBO_ENDPOINT,
          requestTimeoutMs: config.TURBO_REQUEST_TIMEOUT_MS,
          requestRetryCount: config.TURBO_REQUEST_RETRY_COUNT,
          cache: rootTxCache,
        }),
      );
      break;

    case 'graphql':
      if (Object.keys(config.TRUSTED_GATEWAYS_URLS).length > 0) {
        rootTxIndexes.push(
          new GraphQLRootTxIndex({
            log,
            trustedGatewaysUrls: config.TRUSTED_GATEWAYS_URLS,
            cache: rootTxCache,
          }),
        );
      } else {
        log.warn('GraphQL source configured but no trusted gateways defined');
      }
      break;

    default:
      log.warn('Unknown root TX source in configuration', {
        source: sourceName,
      });
  }
}

// Fallback if no valid sources configured
if (rootTxIndexes.length === 0) {
  log.warn('No valid root TX sources configured, using default (db only)');
  rootTxIndexes.push(db);
}

// Create composite root TX index with circuit breakers
// This needs to be created early so it can be used by RootParentDataSource
export const rootTxIndex = new CompositeRootTxIndex({
  log,
  indexes: rootTxIndexes,
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
      username: config.CLICKHOUSE_USER,
      password: config.CLICKHOUSE_PASSWORD,
    });
  }

  return db;
})();

export type PostgreSQL = postgres.Sql;

export let legacyPsql: PostgreSQL | undefined = undefined;

if (config.CHUNK_METADATA_RETRIEVAL_ORDER.includes('legacy-psql')) {
  if (config.LEGACY_PSQL_CONNECTION_STRING !== undefined) {
    legacyPsql = postgres(config.LEGACY_PSQL_CONNECTION_STRING, {
      ...(config.LEGACY_PSQL_SSL_REJECT_UNAUTHORIZED && {
        ssl: {
          rejectUnauthorized: false,
        },
      }),
      ...(config.LEGACY_PSQL_PASSWORD_FILE !== undefined && {
        password: fs
          .readFileSync(config.LEGACY_PSQL_PASSWORD_FILE!, 'utf8')
          .trim(),
      }),
    });
  } else {
    // by throwing here we can make assumptions about legacyPsql being defined
    throw new Error(
      'LEGACY_PSQL_CONNECTION_STRING is required for legacy-psql chunk metadata source',
    );
  }
}

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
      dataType: 'headers',
    })
  : undefined;

const contiguousMetadataStore = makeContiguousMetadataStore({
  log,
  type: config.CONTIGUOUS_METADATA_CACHE_TYPE,
});

const contiguousDataCacheCleanupThresholdSeconds = parseInt(
  config.CONTIGUOUS_DATA_CACHE_CLEANUP_THRESHOLD,
);

// Only perform cleanup if the cleanup threshold is set
export const contiguousDataFsCacheCleanupWorker = !isNaN(
  contiguousDataCacheCleanupThresholdSeconds,
)
  ? new FsCleanupWorker({
      log,
      basePath: 'data/contiguous',
      dataType: 'contiguous_data',
      initialDelay: contiguousDataCacheCleanupThresholdSeconds * 1000, // Use cleanup threshold as initial delay
      shouldDelete: async (path) => {
        try {
          const stats = await fs.promises.stat(path);
          const hash = path.split('/').pop() ?? '';
          const metadata = await contiguousMetadataStore.get(hash);

          // Determine whether data is associated with a preferred name by
          // checking the list of most recently used names in the metadata
          // cache.
          let isPreferredArnsName = false;
          if (
            metadata?.mruArNSNames !== undefined &&
            Array.isArray(metadata.mruArNSNames)
          ) {
            isPreferredArnsName = metadata.mruArNSNames.some((name) =>
              config.PREFERRED_ARNS_NAMES.has(name),
            );
          }

          // If not found in mruArNSNames, check mruArNSBaseNames
          if (
            !isPreferredArnsName &&
            metadata?.mruArNSBaseNames !== undefined &&
            Array.isArray(metadata.mruArNSBaseNames)
          ) {
            isPreferredArnsName = metadata.mruArNSBaseNames.some((baseName) =>
              config.PREFERRED_ARNS_BASE_NAMES.has(baseName),
            );
          }

          // Preferred ArNS names have a different cleanup threshold
          const cleanupThresholdMs =
            (isPreferredArnsName
              ? config.PREFERRED_ARNS_CONTIGUOUS_DATA_CACHE_CLEANUP_THRESHOLD
              : contiguousDataCacheCleanupThresholdSeconds) * 1000;

          const mostRecentTimeMs =
            metadata?.accessTimestampMs ??
            (stats.atime > stats.mtime ? stats.atime : stats.mtime);

          const cleanupBeforeMs = new Date(Date.now() - cleanupThresholdMs);
          const shouldDeleteFile = mostRecentTimeMs <= cleanupBeforeMs;

          return shouldDeleteFile;
        } catch (err) {
          log.error(`Error getting file stats for ${path}`, err);
          return false;
        }
      },
    })
  : undefined;

const ans104BundleTagMatch: TagMatch[] = [
  { name: 'Bundle-Format', value: 'binary' },
  { name: 'Bundle-Version', valueStartsWith: '2.' },
];

const ans104TxMatcher = new MatchTags(
  ans104BundleTagMatch,
  log.child({ itemFilter: JSON.stringify({ tags: ans104BundleTagMatch }) }),
);

export const prioritizedTxIds = new Set<string>();

eventEmitter.on(events.TX_INDEXED, async (tx: MatchableTxLike) => {
  if (await ans104TxMatcher.match(tx)) {
    metrics.bundlesCounter.inc({
      bundle_format: 'ans-104',
      contiguous_data_type: 'transaction',
    });
    eventEmitter.emit(events.ANS104_TX_INDEXED, tx);
    eventEmitter.emit(events.ANS104_BUNDLE_INDEXED, tx);
  }
});

eventEmitter.on(
  events.ANS104_DATA_ITEM_DATA_INDEXED,
  async (item: MatchableTxLike) => {
    if (await ans104TxMatcher.match(item)) {
      metrics.bundlesCounter.inc({
        bundle_format: 'ans-104',
        contiguous_data_type: 'data_item',
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

const gatewaysDataSource = new GatewaysDataSource({
  log,
  trustedGatewaysUrls: config.TRUSTED_GATEWAYS_URLS,
});

export const arIOPeerManager = new ArIOPeerManager({
  log,
  networkProcess,
  nodeWallet: config.AR_IO_WALLET,
});

export const arIODataSource = new ArIODataSource({
  log,
  peerManager: arIOPeerManager,
});

export const arIOChunkSource = new ArIOChunkSource({
  log,
  peerManager: arIOPeerManager,
});

// Configure chunk sources using comma-separated retrieval orders
export const chunkMetaDataSource = createChunkMetadataSource({
  log,
  arweaveClient,
  legacyPsql,
  arIOChunkSource,
  chunkMetadataRetrievalOrder: config.CHUNK_METADATA_RETRIEVAL_ORDER,
  chunkMetadataSourceParallelism: config.CHUNK_METADATA_SOURCE_PARALLELISM,
});

const chunkDataSource = createChunkDataSource({
  log,
  arweaveClient,
  awsS3Client: awsClient?.S3,
  arIOChunkSource,
  chunkDataRetrievalOrder: config.CHUNK_DATA_RETRIEVAL_ORDER,
  chunkDataSourceParallelism: config.CHUNK_DATA_SOURCE_PARALLELISM,
});

export const chunkSource = new FullChunkSource(
  chunkMetaDataSource,
  chunkDataSource,
);

// Create the base TX chunks data source
const baseTxChunksDataSource = new TxChunksDataSource({
  log,
  chainSource: arweaveClient,
  chunkSource,
});

// ANS-104 offset source for parsing bundle headers
const ans104OffsetSource = new Ans104OffsetSource({
  log,
  dataSource: baseTxChunksDataSource,
});

// Regular chunks data source (no data item resolution)
const txChunksDataSource: ContiguousDataSource = baseTxChunksDataSource;

// Chunks data source with data item resolution
const txChunksDataItemSource = new RootParentDataSource({
  log,
  dataSource: baseTxChunksDataSource,
  dataItemRootTxIndex: rootTxIndex,
  ans104OffsetSource,
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

const turboS3DataSource =
  awsClient !== undefined &&
  config.AWS_S3_TURBO_CONTIGUOUS_DATA_BUCKET !== undefined
    ? new S3DataSource({
        log,
        s3Client: awsClient.S3,
        s3Bucket: config.AWS_S3_TURBO_CONTIGUOUS_DATA_BUCKET,
        s3Prefix: config.AWS_S3_TURBO_CONTIGUOUS_DATA_PREFIX,
        awsClient,
      })
    : undefined;

const turboElasticacheDataSource =
  config.AWS_ELASTICACHE_TURBO_HOST !== undefined
    ? new TurboRedisDataSource({
        redisHost: config.AWS_ELASTICACHE_TURBO_HOST,
        redisUseTls: config.AWS_ELASTICACHE_TURBO_USE_TLS,
        redisPort:
          config.AWS_ELASTICACHE_TURBO_PORT !== undefined
            ? +config.AWS_ELASTICACHE_TURBO_PORT
            : undefined,
        log,
      })
    : undefined;

const turboDynamoDBDataSource =
  config.AWS_DYNAMODB_TURBO_REGION !== undefined
    ? new TurboDynamoDbDataSource({
        log,
        region: config.AWS_DYNAMODB_TURBO_REGION,
        endpoint: config.AWS_DYNAMODB_TURBO_ENDPOINT,
        assumeRoleArn: config.AWS_DYNAMODB_TURBO_ASSUME_ROLE_ARN,
      })
    : undefined;

// Create chunk data cache cleanup worker
export const chunkDataFsCacheCleanupWorker =
  config.ENABLE_CHUNK_DATA_CACHE_CLEANUP
    ? new FsCleanupWorker({
        log,
        basePath: 'data/chunks',
        dataType: 'chunk_data',
        shouldDelete: async (path) => {
          try {
            const stats = await fs.promises.stat(path);
            // Use the more recent of atime or mtime, matching contiguous data cleanup pattern
            const mostRecentTimeMs =
              stats.atime > stats.mtime ? stats.atimeMs : stats.mtimeMs;
            const ageInSeconds = (Date.now() - mostRecentTimeMs) / 1000;

            // Delete if file is older than threshold
            if (
              config.CHUNK_DATA_CACHE_CLEANUP_THRESHOLD > 0 &&
              ageInSeconds > config.CHUNK_DATA_CACHE_CLEANUP_THRESHOLD
            ) {
              return true;
            }

            return false;
          } catch (error: any) {
            log.error('Error checking chunk file for cleanup', {
              path,
              error: error.message,
            });
            return false;
          }
        },
      })
    : undefined;

function getDataSource(sourceName: string): ContiguousDataSource | undefined {
  switch (sourceName) {
    case 's3':
      return s3DataSource;
    case 'turbo-s3':
      return turboS3DataSource;
    case 'turbo-elasticache':
      return turboElasticacheDataSource;
    case 'turbo-dynamodb':
      return turboDynamoDBDataSource;
    // Legacy names for backwards compatibility
    case 'ario-peer':
    case 'ar-io-peers': // Keep for backwards compatibility
    case 'ar-io-network': // New preferred name
      return arIODataSource;
    case 'trusted-gateways':
      return gatewaysDataSource;
    case 'chunks':
      return txChunksDataSource;
    case 'chunks-data-item':
      return txChunksDataItemSource;
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
  } else {
    throw new Error(`Data source ${sourceName} not found!`);
  }
}

const backgroundDataSources: ContiguousDataSource[] = [];
for (const sourceName of config.BACKGROUND_RETRIEVAL_ORDER) {
  const dataSource = getDataSource(sourceName);
  if (dataSource !== undefined) {
    backgroundDataSources.push(dataSource);
  } else {
    throw new Error(`Background data source ${sourceName} not found!`);
  }
}

const dataContentAttributeImporter = new DataContentAttributeImporter({
  log,
  contiguousDataIndex: contiguousDataIndex,
});
metrics.registerQueueLengthGauge('dataContentAttributeImporter', {
  length: () => dataContentAttributeImporter.queueDepth(),
});

// TODO: Reinstate an S3 data store here when configuration better supports it
const contiguousDataStore = new FsDataStore({
  log,
  baseDir: 'data/contiguous',
});

export const onDemandContiguousDataSource = new ReadThroughDataCache({
  log,
  dataSource: new SequentialDataSource({
    log,
    dataSources: onDemandDataSources,
  }),
  metadataStore: contiguousMetadataStore,
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
  metadataStore: contiguousMetadataStore,
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

export const verificationDataImporter = new DataImporter({
  log,
  contiguousDataSource: txChunksDataSource,
  workerCount: config.ANS104_DOWNLOAD_WORKERS,
  maxQueueSize: config.VERIFICATION_DATA_IMPORTER_QUEUE_SIZE,
});
metrics.registerQueueLengthGauge('verificationDataImporter', {
  length: () => verificationDataImporter.queueDepth(),
});
export const bundleDataImporter = new DataImporter({
  log,
  contiguousDataSource: backgroundContiguousDataSource,
  ans104Unbundler,
  workerCount: config.ANS104_DOWNLOAD_WORKERS,
  maxQueueSize: config.BUNDLE_DATA_IMPORTER_QUEUE_SIZE,
});
metrics.registerQueueLengthGauge('bundleDataImporter', {
  length: () => bundleDataImporter.queueDepth(),
});
export type QueueBundleResponse = {
  status: 'skipped' | 'queued' | 'error';
  error?: string;
};
export async function queueBundle(
  item: NormalizedDataItem | PartialJsonTransaction,
  isPrioritized = false,
  bypassFilter = false,
): Promise<QueueBundleResponse> {
  try {
    if ('root_tx_id' in item && item.root_tx_id === null) {
      log.debug('Skipping download of optimistically indexed data item', {
        id: item.id,
        rootTxId: item.root_tx_id,
        parentId: item.parent_id,
      });
      return { status: 'skipped' };
    }

    await db.saveBundle({
      id: item.id,
      rootTransactionId: 'root_tx_id' in item ? item.root_tx_id : item.id,
      format: 'ans-104',
    });

    if (bypassFilter || (await config.ANS104_UNBUNDLE_FILTER.match(item))) {
      metrics.bundlesMatchedCounter.inc({ bundle_format: 'ans-104' });
      const {
        unbundleFilterId,
        indexFilterId,
        previousUnbundleFilterId,
        previousIndexFilterId,
        lastFullyIndexedAt,
      } = await db.saveBundle({
        id: item.id,
        format: 'ans-104',
        unbundleFilter: config.ANS104_UNBUNDLE_FILTER_STRING,
        indexFilter: config.ANS104_INDEX_FILTER_STRING,
        queuedAt: currentUnixTimestamp(),
      });

      if (
        unbundleFilterId !== null &&
        indexFilterId !== null &&
        unbundleFilterId === previousUnbundleFilterId &&
        indexFilterId === previousIndexFilterId &&
        // Only skip bundles that have been fully unbundled
        lastFullyIndexedAt != null
      ) {
        log.info('Skipping fully unbundled bundle', {
          id: item.id,
        });
        return { status: 'skipped' };
      }

      bundleDataImporter.queueItem(
        {
          ...item,
          index:
            'parent_index' in item && item.parent_index !== undefined
              ? item.parent_index
              : -1, // parent indexes are not needed for L1
        },
        isPrioritized,
        bypassFilter,
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

    return { status: 'queued' };
  } catch (error: any) {
    log.error('Error saving or queueing bundle', {
      message: error.message,
      stack: error.stack,
    });

    return { status: 'error', error: 'Error queueing bundle' };
  }
}

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
    metrics.dataItemsUnbundledCounter.inc(
      { bundle_format: 'ans-104' },
      bundleEvent.itemCount,
    );
    db.saveBundle({
      id: bundleEvent.parentId,
      format: 'ans-104',
      dataItemCount: bundleEvent.itemCount,
      matchedDataItemCount: bundleEvent.matchedItemCount,
      duplicatedDataItemCount: bundleEvent.duplicatedItemCount,
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

export const arnsResolutionCache = new KvArNSResolutionStore({
  hashKeyPrefix: 'arns', // all arns resolution cache keys start with 'arns'
  kvBufferStore: createArNSKvStore({
    log,
    type: config.ARNS_CACHE_TYPE,
    redisUrl: config.REDIS_CACHE_URL,
    ttlSeconds: config.ARNS_CACHE_TTL_SECONDS,
    maxKeys: config.ARNS_CACHE_MAX_KEYS,
  }),
});

export const arnsRegistryCache = new KvArNSRegistryStore({
  hashKeyPrefix: 'registry', // all arns registry cache keys start with 'registry'
  kvBufferStore: createArNSKvStore({
    log,
    type: config.ARNS_CACHE_TYPE,
    redisUrl: config.REDIS_CACHE_URL,
    ttlSeconds: config.ARNS_CACHE_TTL_SECONDS,
    maxKeys: config.ARNS_CACHE_MAX_KEYS,
  }),
});

export const nameResolver = createArNSResolver({
  log,
  trustedGatewayUrl: config.TRUSTED_ARNS_GATEWAY_URL,
  resolutionOrder: config.ARNS_RESOLVER_PRIORITY_ORDER,
  networkProcess: networkProcess,
  resolutionCache: arnsResolutionCache,
  registryCache: arnsRegistryCache,
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

const transactionAttributesStore = makeTransactionAttributesStore({
  log,
});
const dataItemAttributesStore = makeDataItemAttributesStore({
  log,
});
export const signatureStore = makeSignatureStore({ log });
export const signatureFetcher = new SignatureFetcher({
  log,
  dataSource: onDemandContiguousDataSource,
  dataIndex: contiguousDataIndex,
  dataItemAttributesStore,
  transactionAttributesStore,
  chainSource: arweaveClient,
  signatureStore,
});

export const ownerStore = makeOwnerStore({ log });
export const ownerFetcher = new OwnerFetcher({
  log,
  dataSource: onDemandContiguousDataSource,
  dataIndex: contiguousDataIndex,
  dataItemAttributesStore,
  transactionAttributesStore,
  chainSource: arweaveClient,
  ownerStore: ownerStore,
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
      dataItemRootTxIndex: rootTxIndex,
      contiguousDataSource: gatewaysDataSource,
      chunkDataImporter: verificationDataImporter,
      bundleDataImporter,
      queueBundle,
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
      arIOPeerManager.stopUpdatingPeers();
      dataSqliteWalCleanupWorker?.stop();
      parquetExporter?.stop();
      await arnsResolutionCache.close();
      await arnsRegistryCache.close();
      await mempoolWatcher?.stop();
      await blockImporter.stop();
      await dataItemIndexer.stop();
      await txRepairWorker.stop();
      await txImporter.stop();
      await txFetcher.stop();
      await txOffsetImporter.stop();
      await txOffsetRepairWorker.stop();
      await verificationDataImporter.stop();
      await bundleDataImporter.stop();
      await bundleRepairWorker.stop();
      await ans104DataIndexer.stop();
      await ans104Unbundler.stop();
      await webhookEmitter.stop();
      await headerFsCacheCleanupWorker?.stop();
      await contiguousDataFsCacheCleanupWorker?.stop();
      await chunkDataFsCacheCleanupWorker?.stop();
      await dataVerificationWorker?.stop();
      // Stop DNS periodic re-resolution if running
      arweaveClient.stopDnsResolution();
      await db.stop();
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
