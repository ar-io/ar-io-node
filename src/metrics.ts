/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import * as promClient from 'prom-client';
import { Gauge } from 'prom-client';

/* eslint-disable */
// @ts-ignore
import PrometheusMetrics from 'opossum-prometheus';
import CircuitBreaker from 'opossum';
import winston from 'winston';

/**
 * @deprecated Use setUpCircuitBreakerListenerMetrics instead.
 */
export const circuitBreakerMetrics = new PrometheusMetrics({
  registry: promClient.register,
});

//
// Global error metrics
//

export const errorsCounter = new promClient.Counter({
  name: 'errors_total',
  help: 'Total error count',
});

export const uncaughtExceptionCounter = new promClient.Counter({
  name: 'uncaught_exceptions_total',
  help: 'Count of uncaught exceptions',
});

//
// Global bundle metrics
//

export const bundlesCounter = new promClient.Counter({
  name: 'bundles_total',
  help: 'Count of all bundles seen',
  labelNames: ['bundle_format', 'contiguous_data_type'],
});

export const bundlesMatchedCounter = new promClient.Counter({
  name: 'bundles_matched_total',
  help: 'Count of bundles matched for unbundling',
  labelNames: ['bundle_format'],
});

export const bundlesQueuedCounter = new promClient.Counter({
  name: 'bundles_queued_total',
  help: 'Count of bundles queued for unbundling',
  labelNames: ['bundle_format'],
});

export const bundlesUnbundledCounter = new promClient.Counter({
  name: 'bundles_unbundled_total',
  help: 'Count of bundles unbundled',
  labelNames: ['bundle_format'],
});

export const dataItemsUnbundledCounter = new promClient.Counter({
  name: 'data_items_unbundled_total',
  help: 'Count of data items unbundled for potential indexing',
  labelNames: ['bundle_format'],
});

export const dataItemsQueuedCounter = new promClient.Counter({
  name: 'data_items_queued_total',
  help: 'Count of data items queued for indexing',
  labelNames: ['bundle_format'],
});

export const dataItemsIndexedCounter = new promClient.Counter({
  name: 'data_items_indexed_total',
  help: 'Count of data items indexed',
  labelNames: ['parent_type'],
});

export const dataItemDataIndexedCounter = new promClient.Counter({
  name: 'data_item_data_indexed_total',
  help: 'Count of data item data indexed',
  labelNames: ['parent_type'],
});

export const dataItemLastIndexedTimestampSeconds = new promClient.Gauge({
  name: 'data_item_last_indexed_timestamp_seconds',
  help: 'Timestamp of the last indexed data item',
});
dataItemLastIndexedTimestampSeconds.setToCurrentTime();

//
// Arweave client metrics
//

export const arweavePeerInfoErrorCounter = new promClient.Counter({
  name: 'arweave_peer_info_errors_total',
  help: 'Count of failed Arweave peer info requests',
});

export const arweavePeerRefreshErrorCounter = new promClient.Counter({
  name: 'arweave_peer_referesh_errors_total',
  help: 'Count of errors refreshing the Arweave peers list',
});

export const arweavePoaCounter = new promClient.Counter({
  name: 'arweave_poa_total',
  help: 'Count of fetched blocks with PoA attached',
});

export const arweavePoa2Counter = new promClient.Counter({
  name: 'arweave_poa2_total',
  help: 'Count of fetched blocks with PoA2 attached',
});

export const arweaveTxFetchCounter = new promClient.Counter({
  name: 'arweave_tx_fetch_total',
  help: 'Count of fetched transactions',
  labelNames: ['node_type'],
});

export const arweaveChunkPostCounter = new promClient.Counter({
  name: 'arweave_chunk_post_total',
  help: 'Counts individual POST request to endpoint',
  labelNames: ['endpoint', 'status', 'role'],
});

export const arweaveChunkBroadcastCounter = new promClient.Counter({
  name: 'arweave_chunk_broadcast_total',
  help: 'Counts successful broadcast accounting for min threshold count etc',
  labelNames: ['status'],
});

//
// SQLite metrics
//

export const sqliteMethodDurationSummary = new promClient.Summary({
  name: 'standalone_sqlite_method_duration_seconds',
  help: 'StandaloneSqlite method call durations',
  labelNames: ['worker', 'role', 'method'],
});

export const sqliteMethodDuplicateCallsCounter = new promClient.Counter({
  name: 'standalone_sqlite_method_duplicate_calls_total',
  help: 'StandaloneSqlite method call duplicate count',
  labelNames: ['method'],
});

export const sqliteWalCheckpointPages = new promClient.Gauge({
  name: 'sqlite_wal_checkpoint_pages',
  help: 'Number of pages in the WAL',
  labelNames: ['db', 'type'],
});

export const sqliteInFlightOps = new promClient.Gauge({
  name: 'sqlite_in_flight_ops',
  help: 'Number of in-flight SQLite operations',
  labelNames: ['worker', 'role'],
});

//
// Block importer metrics
//

export const blockImporterRunningGauge = new promClient.Gauge({
  name: 'block_importer_running',
  help: 'Depth of the last observed chain fork',
});

export const forksCounter = new promClient.Counter({
  name: 'forks_total',
  help: 'Count of chain forks observed',
});

export const lastForkDepthGauge = new promClient.Gauge({
  name: 'last_fork_depth',
  help: 'Depth of the last observed chain fork',
});

export const blocksImportedCounter = new promClient.Counter({
  name: 'blocks_imported_total',
  help: 'Count of blocks imported',
});

export const transactionsImportedCounter = new promClient.Counter({
  name: 'block_transactions_imported_total',
  help: 'Count of transactions imported',
});

export const missingTransactionsCounter = new promClient.Counter({
  name: 'missing_block_transactions_total',
  help: 'Count of block transactions that could not be immediately fetched',
});

export const blockImportErrorsCounter = new promClient.Counter({
  name: 'block_import_errors_total',
  help: 'Count of block import errors',
});

export const lastHeightImported = new promClient.Gauge({
  name: 'last_height_imported',
  help: 'Height of the last block imported',
});

//
// Redis Cache Metrics
//

export const redisConnectionErrorsCounter = new promClient.Counter({
  name: 'redis_connection_errors_total',
  help: 'Number of errors connecting to redis',
});

export const redisErrorCounter = new promClient.Counter({
  name: 'redis_errors_total',
  help: 'Number of errors redis cache has received',
});

export const arnsCacheHitCounter = new promClient.Counter({
  name: 'arns_cache_hit_total',
  help: 'Number of hits in the arns cache',
});

export const arnsCacheMissCounter = new promClient.Counter({
  name: 'arns_cache_miss_total',
  help: 'Number of misses in the arns cache',
});

export const arnsNameCacheDurationSummary = new promClient.Summary({
  name: 'arns_name_cache_duration_ms',
  help: 'Time in ms it takes to fetch and cache arns base names',
});

export const arnsNameCacheHitCounter = new promClient.Counter({
  name: 'arns_name_cache_hit_total',
  help: 'Number of hits in the arns name cache',
});

export const arnsNameCacheMissCounter = new promClient.Counter({
  name: 'arns_name_cache_miss_total',
  help: 'Number of misses in the arns name cache',
});

export const arnsNameCacheHydrationPagesCounter = new promClient.Counter({
  name: 'arns_name_cache_hydration_pages_total',
  help: 'Total number of pages fetched during ArNS cache hydration',
});

export const arnsNameCacheHydrationRetriesCounter = new promClient.Counter({
  name: 'arns_name_cache_hydration_retries_total',
  help: 'Total number of retry attempts during ArNS cache hydration',
});

export const arnsNameCacheHydrationFailuresCounter = new promClient.Counter({
  name: 'arns_name_cache_hydration_failures_total',
  help: 'Number of failed hydration attempts for ArNS cache',
});

export const arnsBaseNameCacheEntriesGauge = new promClient.Gauge({
  name: 'arns_base_name_cache_entries',
  help: 'Current number of base name entries in the ArNS name cache',
});

export const arnsNameCacheDebounceTriggeredCounter = new promClient.Counter({
  name: 'arns_name_cache_debounce_triggered_total',
  help: 'Number of debounce triggers for ArNS cache refresh',
  labelNames: ['type'],
});

export const arnsResolutionTime = new promClient.Summary({
  name: 'arns_resolution_time_ms',
  help: 'Time in ms it takes to resolve an arns name',
});

export const arnsResolutionResolverCount = new promClient.Counter({
  name: 'arns_resolution_resolver_count',
  help: 'Number of resolution made by the resolver',
  labelNames: ['resolver'],
});

//
// Data source metrics
//

export const getDataErrorsTotal = new promClient.Counter({
  name: 'get_data_errors_total',
  help: 'Count of requests errors',
  labelNames: ['class', 'source'] as const,
});

export const getDataStreamErrorsTotal = new promClient.Counter({
  name: 'get_data_stream_errors_total',
  help: 'Count of data stream errors',
  labelNames: ['class', 'source', 'request_type'] as const,
});

export const getDataStreamSuccessesTotal = new promClient.Counter({
  name: 'get_data_stream_successes_total',
  help: 'Count of data stream successes',
  labelNames: ['class', 'source', 'request_type'] as const,
});

export const dataRequestChunksHistogram = new promClient.Histogram({
  name: 'data_request_chunks',
  help: 'Number of chunks fetched per data request',
  labelNames: ['class', 'source', 'request_type'] as const,
  buckets: [1, 5, 20, 100, 500],
});

export const dataRequestFirstChunkLatency = new promClient.Histogram({
  name: 'data_request_first_chunk_latency_ms',
  help: 'Time to first chunk in milliseconds',
  labelNames: ['class', 'source', 'request_type'] as const,
  buckets: [50, 200, 1000, 5000],
});

//
// Chunk source metrics
//

export const requestChunkTotal = new promClient.Counter({
  name: 'request_chunk_total',
  help: 'Count of each individual chunk http request, status can be "error" or "success", source_type can be "trusted" or "peer".',
  labelNames: ['status', 'class', 'method', 'source', 'source_type'] as const,
});

export const getChunkTotal = new promClient.Counter({
  name: 'get_chunk_total',
  help: 'Higher level count of chunk discovery, counts when the caller request for chunk ends, stores the status of the request',
  labelNames: ['status', 'class', 'method'] as const,
});

//
// Queue length metrics
//

const queues: { [key: string]: { length: () => number } } = {};
export function registerQueueLengthGauge(
  name: string,
  queue: { length: () => number },
) {
  queues[name] = queue;
}

export const queueLengthGauge = new Gauge({
  name: 'queue_length',
  help: 'Current length of queues',
  labelNames: ['queue_name'],
  collect() {
    Object.entries(queues).forEach(([queueName, queue]) => {
      this.set({ queue_name: queueName }, queue.length());
    });
  },
});

//
// Filesystem cleanup metrics
//

export const filesCleanedTotal = new promClient.Counter({
  name: 'files_cleaned_total',
  help: 'Count of files deleted by the filesystem cleanup worker',
});

//
// Cache storage metrics
//

export const cacheObjectsTotal = new promClient.Gauge({
  name: 'cache_objects_total',
  help: 'Current number of objects in cache',
  labelNames: ['store_type', 'data_type'] as const,
});

export const cacheSizeBytes = new promClient.Gauge({
  name: 'cache_size_bytes',
  help: 'Current cache size in bytes',
  labelNames: ['store_type', 'data_type'] as const,
});

//
// Circuit breaker metrics
//
const breakerSourceNames = [
  // Keep this list alphabetized
  'ar-io-data-source',
  'ar-io-peer-manager',
  'get-data-attributes',
  'get-data-item-attributes',
  'get-data-parent',
  'get-transaction-attributes',
  'turbo_elasticache',
  'turbo_dynamodb',
] as const;
export type BreakerSource = (typeof breakerSourceNames)[number];
const breakerSources: BreakerSource[] = [...breakerSourceNames];

export const circuitBreakerOpenCount = createCounter({
  name: 'circuit_breaker_open_count',
  help: 'Count of occasions when a circuit breaker has opened',
  labelNames: ['breaker'],
  expectedLabelNames: {
    breaker: breakerSources,
  },
});

export const circuitBreakerState = createGauge({
  name: 'circuit_breaker_state',
  help: 'State of the circuit breaker (1 is open, 0 is closed, 0.5 is half open)',
  labelNames: ['breaker'],
  expectedLabelNames: {
    breaker: breakerSources,
  },
});

//
// Helper functions
//

type CounterCfgPlusLabelValues = promClient.CounterConfiguration<string> & {
  expectedLabelNames?: Record<string, string[]>;
};

function createCounter(
  config: CounterCfgPlusLabelValues,
): promClient.Counter<string> {
  const counter = new promClient.Counter(config);
  // Initialize the counter to zero so it will print right away
  if (config.expectedLabelNames) {
    for (const [labelName, labelValues] of Object.entries(
      config.expectedLabelNames,
    )) {
      for (const labelValue of labelValues) {
        counter.inc({ [labelName]: labelValue }, 0);
      }
    }
  } else {
    counter.inc(0);
  }
  return counter;
}

type GaugeCfgPlusLabelValues = promClient.GaugeConfiguration<string> & {
  expectedLabelNames?: Record<string, string[]>;
};

function createGauge(config: GaugeCfgPlusLabelValues): Gauge<string> {
  const gauge = new Gauge(config);
  // Initialize the gauge to zero so it will print right away
  if (config.expectedLabelNames) {
    for (const [labelName, labelValues] of Object.entries(
      config.expectedLabelNames,
    )) {
      for (const labelValue of labelValues) {
        gauge.set({ [labelName]: labelValue }, 0);
      }
    }
  } else {
    gauge.set(0);
  }
  return gauge;
}

export function setUpCircuitBreakerListenerMetrics(
  breakerName: BreakerSource,
  breaker: CircuitBreaker,
  logger?: winston.Logger | undefined,
) {
  breaker.on('open', () => {
    circuitBreakerOpenCount.inc({
      breaker: breakerName,
    });
    circuitBreakerState.set(
      {
        breaker: breakerName,
      },
      1,
    );
    logger?.error(`${breakerName} circuit breaker opened`);
  });
  breaker.on('close', () => {
    circuitBreakerState.set(
      {
        breaker: breakerName,
      },
      0,
    );
    logger?.info(`${breakerName} circuit breaker closed`);
  });
  breaker.on('halfOpen', () => {
    circuitBreakerState.set(
      {
        breaker: breakerName,
      },
      0.5,
    );
    logger?.info(`${breakerName} circuit breaker half-open`);
  });
}
