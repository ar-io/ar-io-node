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
import { BlockOffsetMapping } from './arweave/block-offset-mapping.js';
import { ArweavePeerManager } from './peers/arweave-peer-manager.js';
import * as config from './config.js';
import { GatewaysDataSource } from './data/gateways-data-source.js';
import { FilteredContiguousDataSource } from './data/filtered-contiguous-data-source.js';
import { ReadThroughDataCache } from './data/read-through-data-cache.js';
import { SequentialDataSource } from './data/sequential-data-source.js';
import { TxChunksDataSource } from './data/tx-chunks-data-source.js';
import { RootParentDataSource } from './data/root-parent-data-source.js';
import { Ans104OffsetSource } from './data/ans104-offset-source.js';
import { CompositeTxOffsetSource } from './data/composite-tx-offset-source.js';
import { DatabaseTxOffsetSource } from './data/database-tx-offset-source.js';
import { ChainTxOffsetSource } from './data/chain-tx-offset-source.js';
import { CompositeTxBoundarySource } from './data/composite-tx-boundary-source.js';
import { DatabaseTxBoundarySource } from './data/database-tx-boundary-source.js';
import { ChainTxBoundarySource } from './data/chain-tx-boundary-source.js';
import { TxPathValidationSource } from './data/tx-path-validation-source.js';
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
  GatewaysRootTxIndex,
  CachedGatewayOffsets,
  GraphQLRootTxIndex,
  TurboRootTxIndex,
  CachedTurboOffsets,
  Cdb64RootTxIndex,
} from './discovery/index.js';
import { LRUCache } from 'lru-cache';
import { makeContiguousMetadataStore } from './init/metadata-store.js';
import { currentUnixTimestamp } from './lib/time.js';
import log from './log.js';
import * as metrics from './metrics.js';
import { StreamingManifestPathResolver } from './resolution/streaming-manifest-path-resolver.js';
import { FsDataStore } from './store/fs-data-store.js';
import { FsChunkDataStore } from './store/fs-chunk-data-store.js';
import { FsChunkMetadataStore } from './store/fs-chunk-metadata-store.js';
import {
  DataBlockListValidator,
  NameBlockListValidator,
  BundleIndex,
  DataItemRootIndex,
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
import { SymlinkCleanupWorker } from './workers/symlink-cleanup-worker.js';
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
import { ArIOPeerManager } from './peers/ar-io-peer-manager.js';
import { S3DataSource } from './data/s3-data-source.js';
import { connect } from '@permaweb/aoconnect';
import { DataContentAttributeImporter } from './workers/data-content-attribute-importer.js';
import { SignatureFetcher, OwnerFetcher } from './data/attribute-fetchers.js';
import { SQLiteWalCleanupWorker } from './workers/sqlite-wal-cleanup-worker.js';
import { KvArNSResolutionStore } from './store/kv-arns-name-resolution-store.js';
import { awsClient } from './aws-client.js';
import { BlockedNamesCache } from './blocked-names-cache.js';
import { KvArNSRegistryStore } from './store/kv-arns-base-name-store.js';
import { ChunkRetrievalService } from './data/chunk-retrieval-service.js';
import { FullChunkSource } from './data/full-chunk-source.js';
import { RebroadcastingChunkSource } from './data/rebroadcasting-chunk-source.js';
import { TurboRedisDataSource } from './data/turbo-redis-data-source.js';
import { TurboDynamoDbDataSource } from './data/turbo-dynamodb-data-source.js';
import { CompositeDataAttributesSource } from './data/composite-data-attributes-source.js';
import { ContiguousDataAttributesStore } from './types.js';
import { createRateLimiter } from './limiter/factory.js';
import { createPaymentProcessor } from './payments/factory.js';

// Shutdown registry for managing cleanup handlers
type CleanupHandler = {
  name: string;
  handler: () => Promise<void>;
};

const cleanupHandlers: CleanupHandler[] = [];

/**
 * Register a cleanup handler to be called during shutdown.
 * Handlers are called in the order they are registered.
 *
 * @param name - Descriptive name for the handler (for logging)
 * @param handler - Async function that performs cleanup
 */
export function registerCleanupHandler(
  name: string,
  handler: () => Promise<void>,
): void {
  cleanupHandlers.push({ name, handler });
  log.debug(`Registered cleanup handler: ${name}`);
}

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

// Create Arweave peer manager
export const arweavePeerManager = new ArweavePeerManager({
  log,
  trustedNodeUrl: config.TRUSTED_NODE_URL,
  preferredChunkGetUrls: config.PREFERRED_CHUNK_GET_NODE_URLS,
  preferredChunkPostUrls: config.PREFERRED_CHUNK_POST_NODE_URLS,
  ignoreUrls: config.ARWEAVE_NODE_IGNORE_URLS,
  peerInfoTimeoutMs: 5000,
  refreshIntervalMs: 10 * 60 * 1000, // 10 minutes
  temperatureDelta: config.WEIGHTED_PEERS_TEMPERATURE_DELTA,
  dnsResolver,
});

// Create block offset mapping for optimizing binary search
const blockOffsetMapping = new BlockOffsetMapping({
  log,
  filePath: new URL('./data/offset-block-mapping.json', import.meta.url)
    .pathname,
});

export const arweaveClient = new ArweaveCompositeClient({
  log,
  arweave,
  trustedNodeUrl: config.TRUSTED_NODE_URL,
  skipCache: config.SKIP_CACHE,
  peerManager: arweavePeerManager,
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
  blockOffsetMapping,
});
metrics.registerQueueLengthGauge('arweaveClientRequests', {
  length: () => arweaveClient.queueDepth(),
});

// Rate limiter and payment processor
export const rateLimiter = createRateLimiter();
export const paymentProcessor = createPaymentProcessor();

export const db = new StandaloneSqliteDatabase({
  log,
  coreDbPath: 'data/sqlite/core.db',
  dataDbPath: 'data/sqlite/data.db',
  moderationDbPath: 'data/sqlite/moderation.db',
  bundlesDbPath: 'data/sqlite/bundles.db',
  tagSelectivity: config.TAG_SELECTIVITY,
});

// Transaction offset source with database primary and chain fallback
export const txOffsetSource = new CompositeTxOffsetSource({
  log,
  primarySource: new DatabaseTxOffsetSource({ log, db }),
  fallbackSource: config.CHUNK_OFFSET_CHAIN_FALLBACK_ENABLED
    ? new ChainTxOffsetSource({ log, arweaveClient })
    : undefined,
  fallbackEnabled: config.CHUNK_OFFSET_CHAIN_FALLBACK_ENABLED,
  fallbackConcurrencyLimit: config.CHUNK_OFFSET_CHAIN_FALLBACK_CONCURRENCY,
});

export const dataAttributesStore: ContiguousDataAttributesStore =
  new CompositeDataAttributesSource({
    log,
    source: db,
  });

// Create shared cache for root TX lookups
// LRUCache v11 requires values to be objects, not primitives with undefined
type CachedParentBundle = { bundleId?: string };
const rootTxCache = new LRUCache<string, CachedParentBundle>({
  max: config.ROOT_TX_CACHE_MAX_SIZE,
  ttl: config.ROOT_TX_CACHE_TTL_MS,
});

// Create separate cache for Turbo offsets
const turboOffsetsCache = new LRUCache<string, CachedTurboOffsets>({
  max: config.ROOT_TX_CACHE_MAX_SIZE,
  ttl: config.ROOT_TX_CACHE_TTL_MS,
});

// Create separate cache for gateway offsets
const gatewayOffsetsCache = new LRUCache<string, CachedGatewayOffsets>({
  max: config.ROOT_TX_CACHE_MAX_SIZE,
  ttl: config.ROOT_TX_CACHE_TTL_MS,
});

// Build indexes based on configuration
const rootTxIndexes: DataItemRootIndex[] = [];

for (const sourceName of config.ROOT_TX_LOOKUP_ORDER) {
  switch (sourceName.toLowerCase()) {
    case 'turbo':
      rootTxIndexes.push(
        new TurboRootTxIndex({
          log,
          turboEndpoint: config.TURBO_ENDPOINT,
          requestTimeoutMs: config.TURBO_REQUEST_TIMEOUT_MS,
          requestRetryCount: config.TURBO_REQUEST_RETRY_COUNT,
          cache: turboOffsetsCache,
        }),
      );
      break;

    case 'gateways':
      if (Object.keys(config.GATEWAYS_ROOT_TX_URLS).length > 0) {
        rootTxIndexes.push(
          new GatewaysRootTxIndex({
            log,
            trustedGatewaysUrls: config.GATEWAYS_ROOT_TX_URLS,
            requestTimeoutMs: config.GATEWAYS_ROOT_TX_REQUEST_TIMEOUT_MS,
            rateLimitBurstSize: config.GATEWAYS_ROOT_TX_RATE_LIMIT_BURST_SIZE,
            rateLimitTokensPerInterval:
              config.GATEWAYS_ROOT_TX_RATE_LIMIT_TOKENS_PER_INTERVAL,
            rateLimitInterval: config.GATEWAYS_ROOT_TX_RATE_LIMIT_INTERVAL,
            cache: gatewayOffsetsCache,
          }),
        );
      } else {
        log.warn('Gateways source configured but no gateways defined');
      }
      break;

    case 'graphql':
      if (Object.keys(config.GRAPHQL_ROOT_TX_GATEWAYS_URLS).length > 0) {
        rootTxIndexes.push(
          new GraphQLRootTxIndex({
            log,
            trustedGatewaysUrls: config.GRAPHQL_ROOT_TX_GATEWAYS_URLS,
            cache: rootTxCache,
          }),
        );
      } else {
        log.warn('GraphQL source configured but no GraphQL gateways defined');
      }
      break;

    case 'db':
      rootTxIndexes.push(db as DataItemRootIndex);
      break;

    case 'cdb': {
      const cdb64RootTxIndex = new Cdb64RootTxIndex({
        log,
        cdbPath: 'data/cdb64-root-tx-index',
        watch: config.CDB64_ROOT_TX_INDEX_WATCH,
      });
      rootTxIndexes.push(cdb64RootTxIndex);
      registerCleanupHandler('cdb64-root-tx-index', async () => {
        await cdb64RootTxIndex.close();
      });
      break;
    }

    default:
      log.warn('Unknown root TX source in configuration', {
        source: sourceName,
      });
  }
}

// Validate that at least one source is configured
if (rootTxIndexes.length === 0) {
  log.warn(
    'No valid root TX sources configured - root resolution will be unavailable',
  );
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
      // Connection pool settings
      max: config.LEGACY_PSQL_MAX_CONNECTIONS,
      idle_timeout: config.LEGACY_PSQL_IDLE_TIMEOUT_SECONDS,
      connect_timeout: config.LEGACY_PSQL_CONNECT_TIMEOUT_SECONDS,
      max_lifetime: config.LEGACY_PSQL_MAX_LIFETIME_SECONDS,

      // SSL configuration - when true (default), enforces strict certificate validation.
      // When false, disables validation for self-signed certs (common cloud provider workaround)
      ...(!config.LEGACY_PSQL_SSL_REJECT_UNAUTHORIZED && {
        ssl: {
          rejectUnauthorized: false,
        },
      }),

      // Password from file
      ...(config.LEGACY_PSQL_PASSWORD_FILE !== undefined && {
        password: fs
          .readFileSync(config.LEGACY_PSQL_PASSWORD_FILE!, 'utf8')
          .trim(),
      }),

      // Server-level timeouts (sent to PostgreSQL)
      connection: {
        statement_timeout: config.LEGACY_PSQL_STATEMENT_TIMEOUT_MS,
        idle_in_transaction_session_timeout:
          config.LEGACY_PSQL_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      },
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

const baseGatewaysDataSource = new GatewaysDataSource({
  log,
  trustedGatewaysUrls: config.TRUSTED_GATEWAYS_URLS,
});

// Wrap with filtering for general gateway forwarding
const gatewaysDataSource = new FilteredContiguousDataSource({
  log,
  dataSource: baseGatewaysDataSource,
  blockedOrigins: config.TRUSTED_GATEWAYS_BLOCKED_ORIGINS,
  blockedIpsAndCidrs: config.TRUSTED_GATEWAYS_BLOCKED_IPS_AND_CIDRS,
});

export const arIOPeerManager = new ArIOPeerManager({
  log,
  networkProcess,
  nodeWallet: config.AR_IO_WALLET,
});

export const arIODataSource = new ArIODataSource({
  log,
  peerManager: arIOPeerManager,
  dataAttributesStore,
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

const fullChunkSource = new FullChunkSource(
  chunkMetaDataSource,
  chunkDataSource,
);

// Conditionally wrap with rebroadcasting if sources are configured
export const chunkSource =
  config.CHUNK_REBROADCAST_SOURCES.length > 0
    ? new RebroadcastingChunkSource({
        log,
        chunkSource: fullChunkSource,
        chunkBroadcaster: arweaveClient,
        options: {
          sources: config.CHUNK_REBROADCAST_SOURCES,
          rateLimitTokens: config.CHUNK_REBROADCAST_RATE_LIMIT_TOKENS,
          rateLimitInterval: config.CHUNK_REBROADCAST_RATE_LIMIT_INTERVAL,
          maxConcurrent: config.CHUNK_REBROADCAST_MAX_CONCURRENT,
          dedupTtlSeconds: config.CHUNK_REBROADCAST_DEDUP_TTL_SECONDS,
          minSuccessCount: config.CHUNK_REBROADCAST_MIN_SUCCESS_COUNT,
        },
      })
    : fullChunkSource;

// Create stores for ChunkRetrievalService fast path (cache lookup by absoluteOffset)
const chunkDataStore = new FsChunkDataStore({
  log,
  baseDir: 'data/chunks',
});

const chunkMetadataStore = new FsChunkMetadataStore({
  log,
  baseDir: 'data/chunks/metadata',
});

// Transaction boundary sources for chunk retrieval
// Uses DB-first strategy: DB (fastest) → tx_path validation → chain (slowest)
const dbBoundarySource = new DatabaseTxBoundarySource({ log, db });

const txPathBoundarySource = new TxPathValidationSource({
  log,
  unvalidatedChunkSource: arIOChunkSource,
  arweaveClient,
});

const chainBoundarySource = config.CHUNK_OFFSET_CHAIN_FALLBACK_ENABLED
  ? new ChainTxBoundarySource({ log, arweaveClient })
  : undefined;

const txBoundarySource = new CompositeTxBoundarySource({
  log,
  dbSource: dbBoundarySource,
  txPathSource: txPathBoundarySource,
  chainSource: chainBoundarySource,
});

// ChunkRetrievalService encapsulates the chunk retrieval pipeline with fast path support
export const chunkRetrievalService = new ChunkRetrievalService({
  log,
  chunkSource,
  txBoundarySource,
  chunkDataStore,
  chunkMetadataStore,
});

// Create the base TX chunks data source
const baseTxChunksDataSource = new TxChunksDataSource({
  log,
  chainSource: arweaveClient,
  chunkSource,
});

// ANS-104 offset source for parsing bundle headers from chunks
const ans104ChunksOffsetSource = new Ans104OffsetSource({
  log,
  dataSource: baseTxChunksDataSource,
});

// ANS-104 offset source for parsing bundle headers from trusted gateways
const ans104GatewaysOffsetSource = new Ans104OffsetSource({
  log,
  dataSource: baseGatewaysDataSource,
});

// Offset-aware version of gateways data source that uses cached upstream offsets
// Uses unfiltered base source to avoid blocking legitimate chunk retrieval
const offsetAwareGatewaysDataSource = new RootParentDataSource({
  log,
  dataSource: baseGatewaysDataSource,
  dataAttributesStore,
  dataItemRootTxIndex: rootTxIndex,
  ans104OffsetSource: ans104GatewaysOffsetSource,
  fallbackToLegacyTraversal: config.ENABLE_DATA_ITEM_ROOT_TX_SEARCH,
  allowPassthroughWithoutOffsets: config.ENABLE_PASSTHROUGH_WITHOUT_OFFSETS,
});

// Regular chunks data source (no data item resolution)
const txChunksDataSource: ContiguousDataSource = baseTxChunksDataSource;

// Chunks data source with offset-aware data item resolution
const txChunksOffsetAwareSource = new RootParentDataSource({
  log,
  dataSource: baseTxChunksDataSource,
  dataAttributesStore,
  dataItemRootTxIndex: rootTxIndex,
  ans104OffsetSource: ans104ChunksOffsetSource,
  fallbackToLegacyTraversal: config.ENABLE_DATA_ITEM_ROOT_TX_SEARCH,
  allowPassthroughWithoutOffsets: config.ENABLE_PASSTHROUGH_WITHOUT_OFFSETS,
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
        dataAttributesStore,
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

// Dead symlink cleanup worker
// Runs periodically to remove symlinks pointing to deleted files
const symlinkCleanupWorker = config.ENABLE_CHUNK_SYMLINK_CLEANUP
  ? new SymlinkCleanupWorker({
      log,
      directories: [
        'data/chunks/data/by-absolute-offset',
        'data/chunks/metadata/by-absolute-offset',
      ],
      intervalMs: config.CHUNK_SYMLINK_CLEANUP_INTERVAL * 1000,
    })
  : undefined;

symlinkCleanupWorker?.start();

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
    case 'trusted-gateways-offset-aware':
      return offsetAwareGatewaysDataSource;
    case 'chunks':
      return txChunksDataSource;
    case 'chunks-offset-aware':
      return txChunksOffsetAwareSource;
    case 'chunks-data-item': // Deprecated: use 'chunks-offset-aware' instead
      return txChunksOffsetAwareSource;
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
  dataAttributesStore,
  dataContentAttributeImporter,
  skipCache: config.SKIP_DATA_CACHE,
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
  dataAttributesStore,
  dataContentAttributeImporter,
  skipCache: config.SKIP_DATA_CACHE,
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

    // Call registered cleanup handlers first (e.g., HTTP server, parquet exporter)
    for (const { name, handler } of cleanupHandlers) {
      try {
        log.debug(`Running cleanup handler: ${name}`);
        await handler();
        log.debug(`Cleanup handler completed: ${name}`);
      } catch (error: any) {
        log.error(`Error in cleanup handler: ${name}`, {
          error: error.message,
          stack: error.stack,
        });
      }
    }

    // Clean up system components
    eventEmitter.removeAllListeners();
    arIOPeerManager.stopUpdatingPeers();
    dataSqliteWalCleanupWorker?.stop();
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
    symlinkCleanupWorker?.stop();
    await dataVerificationWorker?.stop();

    // Stop DNS periodic re-resolution if running
    arweavePeerManager.stopDnsResolution();
    arweavePeerManager.stopAutoRefresh();
    arweavePeerManager.stopBucketRefresh();

    // Close Postgres connections
    if (legacyPsql !== undefined) {
      try {
        await legacyPsql.end({ timeout: 5 });
        log.debug('Postgres connections closed');
      } catch (error: any) {
        log.error('Error closing Postgres connections', {
          error: error.message,
        });
      }
    }

    await db.stop();

    log.info('Shutdown complete');
    process.exit(exitCode);
  }
};

// Handle shutdown signals
process.on('SIGINT', async () => {
  await shutdown();
});

process.on('SIGTERM', async () => {
  await shutdown();
});
