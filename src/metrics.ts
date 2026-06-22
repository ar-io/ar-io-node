/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { performance } from 'node:perf_hooks';

import * as promClient from 'prom-client';
import { Gauge } from 'prom-client';

/* eslint-disable */
// @ts-ignore
import PrometheusMetrics from 'opossum-prometheus';
import CircuitBreaker from 'opossum';
import winston from 'winston';

import { AR_IO_NODE_RELEASE } from './config.js';
import { Semaphore } from './lib/semaphore.js';

// Set default labels for all metrics
promClient.register.setDefaultLabels({
  release: AR_IO_NODE_RELEASE,
});

// prom-client default Node.js process metrics:
//   process_resident_memory_bytes, process_cpu_*, nodejs_heap_size_*,
//   nodejs_eventloop_lag_seconds (and quantiles), nodejs_gc_duration_seconds,
//   nodejs_active_handles_total, nodejs_active_requests_total, etc.
// These are essential for diagnosing event-loop saturation / GC pressure.
promClient.collectDefaultMetrics();

// Single-number summary of how busy the main thread is (0..1). Far more
// diagnostic than lag percentiles for catching saturation: lag alone can sit
// near zero until the loop is fully pegged. Sampled at scrape time.
let lastELU = performance.eventLoopUtilization();
new Gauge({
  name: 'nodejs_event_loop_utilization',
  help: 'Fraction of wallclock the event loop has been busy since the last scrape (0..1)',
  collect() {
    const next = performance.eventLoopUtilization();
    const delta = performance.eventLoopUtilization(next, lastELU);
    lastELU = next;
    this.set(delta.utilization);
  },
});

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

// Errors that escape route handlers / earlier middleware and reach the
// terminal Express error handler. Before this existed such errors fell to
// Express's default finalhandler as unlogged, generic 500s — this counter
// (plus the handler's logging) makes that previously-invisible path visible.
export const unhandledRequestErrorsCounter = new promClient.Counter({
  name: 'unhandled_request_errors_total',
  help: 'Count of errors reaching the terminal Express error handler',
  labelNames: ['method', 'status'],
});

// Chunk serves cut short by the handler's wall-clock deadline
// (CHUNK_SERVE_DEADLINE_MS). A rising rate means the retrieval cascade is
// routinely exceeding the deadline — tune the deadline or the upstream load,
// not a bug on its own. Use to size CHUNK_SERVE_DEADLINE_MS vs the proxy cap.
export const chunkServeDeadlineExceededCounter = new promClient.Counter({
  name: 'chunk_serve_deadline_exceeded_total',
  help: 'Count of chunk serves aborted by the handler wall-clock deadline',
  labelNames: ['method'],
});

//
// GraphQL root TX lookup batching metrics
//

export const graphqlRootTxBatchesTotal = new promClient.Counter({
  name: 'graphql_root_tx_batches_total',
  help: 'Count of batched GraphQL root-tx queries issued, by endpoint',
  labelNames: ['endpoint'],
});

export const graphqlRootTxBatchSize = new promClient.Histogram({
  name: 'graphql_root_tx_batch_size',
  help: 'Number of IDs per batched GraphQL root-tx query, by endpoint',
  labelNames: ['endpoint'],
  buckets: [1, 2, 5, 10, 25, 50, 100],
});

export const graphqlRootTxBatchShedTotal = new promClient.Counter({
  name: 'graphql_root_tx_batch_shed_total',
  help: 'Count of root-tx lookups shed because the batch queue was at max depth',
});

export const graphqlRootTxBatchTokenWaitTimeoutTotal = new promClient.Counter({
  name: 'graphql_root_tx_batch_token_wait_timeout_total',
  help: 'Count of batches that gave up waiting for a rate-limit token, by endpoint',
  labelNames: ['endpoint'],
});

//
// Optimistic chunk ingest cache metrics
//

export const chunkIngestCacheCounter = new promClient.Counter({
  name: 'chunk_ingest_cache_total',
  help: 'Count of POST /chunk optimistic-cache outcomes',
  labelNames: ['result'] as const,
});

export const chunkIngestConfirmedCounter = new promClient.Counter({
  name: 'chunk_ingest_confirmed_total',
  help: 'Count of tx-indexed events that confirmed pending chunk placements',
});

// The instrument that turns the confirmation-timeout defaults from "reasoned"
// into "measured": observe the real cached_at -> confirmed_at distribution on
// the live gateway, then tune CHUNK_INGEST_*_CONFIRMATION_TIMEOUT_SECONDS.
export const chunkIngestConfirmationLatencySeconds = new promClient.Histogram({
  name: 'chunk_ingest_confirmation_latency_seconds',
  help: 'Seconds between an optimistic chunk being cached and its data_root confirming on-chain',
  buckets: [10, 30, 60, 120, 300, 600, 1800, 3600, 7200, 21600, 86400],
});

export const chunkIngestEvictedCounter = new promClient.Counter({
  name: 'chunk_ingest_evicted_total',
  help: 'Count of optimistically-cached chunks evicted by the GC sweep',
  labelNames: ['reason'] as const,
});

export const chunkIngestPendingBytesGauge = new promClient.Gauge({
  name: 'chunk_ingest_pending_bytes',
  help: 'Estimated bytes held by pending (unconfirmed) ingest-cached chunks',
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

// Distribution of data-item counts per unbundled bundle. Use for correlating
// queue/heap spikes with the *trigger* bundle's size — without this, we only
// see data_items_unbundled_total rising and can't tell if it's a single
// monster bundle or a steady stream of small ones.
export const bundleDataItemCountHistogram = new promClient.Histogram({
  name: 'bundle_data_item_count',
  help: 'Distribution of data item counts per unbundled bundle',
  labelNames: ['bundle_format'],
  buckets: [1, 10, 100, 1000, 10_000, 100_000, 500_000, 1_000_000, 5_000_000],
});

// Wall-clock seconds spent in a single bundle download attempt
// (from contiguousDataSource.getData → stream end / error). Labelled by
// `outcome` so we can separately observe success vs error tails. Wide
// buckets because turbo bundles can legitimately take many minutes.
export const bundleDownloadDurationSeconds = new promClient.Histogram({
  name: 'bundle_download_duration_seconds',
  help: 'Wall-clock duration of a bundle download attempt',
  labelNames: ['outcome'],
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600, 1200, 1800, 3600],
});

// Reported size (in bytes) of the contiguous data backing each bundle
// download attempt. Useful for correlating size with download duration —
// answers "are slow downloads big, or are big downloads also slow when
// they finish?"
export const bundleDownloadSizeBytes = new promClient.Histogram({
  name: 'bundle_download_size_bytes',
  help: 'Bundle download size in bytes (as reported by contiguousDataSource)',
  labelNames: ['outcome'],
  buckets: [
    1_024, 10_240, 102_400, 1_048_576, 10_485_760, 104_857_600, 1_073_741_824,
    10_737_418_240,
  ],
});

// Count of items dropped by DataImporter because its queue was at
// maxQueueSize. Critical for diagnosing retry-lane effectiveness: if this
// is high while BundleRepairWorker.retryLargeBundles is running, retries
// are being silently absorbed.
export const dataImporterQueueFullSkipsCounter = new promClient.Counter({
  name: 'data_importer_queue_full_skips_total',
  help: 'Items dropped by DataImporter due to full queue',
  labelNames: ['importer'],
});

export const dataItemsQueuedCounter = new promClient.Counter({
  name: 'data_items_queued_total',
  help: 'Count of data items queued for indexing',
  labelNames: ['bundle_format'],
});

// Per-phase counters for DataImporter.download(). Exposes where a worker
// is when the bundle pipeline wedges (queue pegged at cap, no completions).
//   started:        function entry, before any await
//   got_data:       contiguousDataSource.getData() returned successfully
//   getData_errored: getData() rejected (peer exhaustion, network error, etc.)
//   stream_ended:   response stream emitted 'end' (full read)
//   stream_errored: response stream emitted 'error' (stall, abort, peer cut)
// Read as deltas:
//   (started - got_data - getData_errored)            = workers stuck in source chain
//   (got_data - stream_ended - stream_errored)        = workers waiting on stream events
export const dataImporterPhaseCounter = new promClient.Counter({
  name: 'data_importer_worker_phase_total',
  help: 'DataImporter worker progression through download() phases. Subtract pairs to find stuck workers.',
  labelNames: ['phase'],
});

export const dataItemsIndexedCounter = new promClient.Counter({
  name: 'data_items_indexed_total',
  help: 'Count of data items indexed',
  labelNames: ['parent_type'],
});

export const dataItemsDroppedCounter = new promClient.Counter({
  name: 'data_items_dropped_total',
  help: 'Count of data items dropped because the indexer queue was at its cap',
  labelNames: ['queue_name'],
});

export const dataItemQueueRejectedCounter = new promClient.Counter({
  name: 'data_item_queue_rejected_total',
  help: 'Count of queue-data-item admin requests rejected before enqueue, by reason (batch_too_large, backpressure)',
  labelNames: ['reason'],
});

// `Ans104Unbundler.queueItem` may decide not to enqueue a bundle for
// unbundling. Every such skip is a bundle whose data items will not enter
// the indexer pipeline through this call (the same bundle may still be
// re-queued later via `bundle-repair-worker`). Tracked separately from
// `data_items_dropped_total` because the unit is bundles not items, and
// because the upstream cause differs from indexer-queue cap pressure.
//
//   reason="no_workers"        — ANS104_UNBUNDLE_WORKERS is 0; the
//                                unbundler is intentionally disabled.
//   reason="high_queue_depth"  — `shouldUnbundle()` returned false
//                                (downstream backpressure from the
//                                data-item indexer queue).
//   reason="queue_full"        — the unbundler's own fastq queue is at
//                                `maxQueueSize` and the item wasn't
//                                prioritized.
export const bundlesUnbundleSkippedCounter = new promClient.Counter({
  name: 'bundles_unbundle_skipped_total',
  help: 'Count of bundles skipped by Ans104Unbundler.queueItem and never enqueued for unbundling',
  labelNames: ['reason'],
});

// Liveness instrumentation for the unbundle pipeline. The Ans104Unbundler
// fastq worker (`unbundle`) has no timeout: if a parse hangs, its slot is
// held forever, and once all slots are held the queue stops draining. These
// metrics make a stall provable and localizable:
//
//   bundles_unbundle_in_flight pinned at the worker count, while
//   bundles_unbundle_started_total is flat and queue_length is non-empty,
//   means the unbundler is hung — not merely slow.
//
//   started_total advancing while ans104_parser_jobs_started_total is flat
//   => the hang is before the parse stage (download/pipeline).
//   jobs_started advancing but no completions => the hang is in a parse
//   worker.
//   ans104_parser_worker_pool_size declining toward 0 => workers are
//   exiting without respawn (only non-zero exit codes trigger a respawn).
export const bundlesUnbundleStartedCounter = new promClient.Counter({
  name: 'bundles_unbundle_started_total',
  help: 'Count of Ans104Unbundler.unbundle invocations (fastq job starts).',
});

export const bundlesUnbundleInFlightGauge = new promClient.Gauge({
  name: 'bundles_unbundle_in_flight',
  help: 'Ans104Unbundler.unbundle invocations currently in progress. Pinned at the worker count with no completions indicates the unbundler is hung.',
});

export const ans104ParserWorkerPoolSizeGauge = new promClient.Gauge({
  name: 'ans104_parser_worker_pool_size',
  help: 'Live Ans104Parser worker threads. A monotonic decline toward 0 means workers are exiting without being respawned.',
});

export const ans104ParserWorkerExitsCounter = new promClient.Counter({
  name: 'ans104_parser_worker_exits_total',
  help: 'Ans104Parser worker thread exits, labelled by exit code.',
  labelNames: ['exit_code'],
});

export const ans104ParserJobsStartedCounter = new promClient.Counter({
  name: 'ans104_parser_jobs_started_total',
  help: 'Parse jobs dispatched to the Ans104Parser worker pool (reached the post-download parse stage).',
});

export const ans104ParserJobTimeoutsCounter = new promClient.Counter({
  name: 'ans104_parser_job_timeouts_total',
  help: 'Parse jobs killed by ANS104_PARSE_JOB_TIMEOUT_MS — worker thread hung inside parseBundle without exiting or posting a terminal message. Always paired with an ans104_parser_worker_exits_total increment.',
});

export const ans104ParserGetDataWallClockFiresCounter = new promClient.Counter({
  name: 'ans104_parser_get_data_wall_clock_fires_total',
  help: 'Ans104Parser.parseBundle getData wall-clock cap fires — the AbortSignal-based getDataTimeoutMs did not propagate through the data-source cascade, and the Promise.race fallback rejected the await. Each increment marks one previously-permanent worker stall recovered.',
});

// Observability for `BundleRepairWorker`. The worker has no direct view of
// "successful repair" (whether a re-queued bundle eventually transitions to
// fully indexed happens downstream of this worker), but the combination of
// these signals lets operators answer it indirectly:
//
//   sent-for-repair rate   = rate(bundle_repair_retries_total{kind="retry"}[5m])
//   current backlog        = bundle_repair_pending_bundles
//   throughput             = -derivative(bundle_repair_pending_bundles[15m])
//                            (negative slope of backlog == net repair throughput)
//   cycle health           = rate(bundle_repair_errors_total[15m]),
//                            histogram_quantile(0.95, ... cycle_duration ...)
//
// `kind` label cardinality is bounded at the four cycle methods:
// retry | timestamp_update | backfill | filter_reprocess.
export const bundleRepairRetriesCounter = new promClient.Counter({
  name: 'bundle_repair_retries_total',
  help: 'Bundles re-queued by bundle-repair-worker (per cycle kind)',
  labelNames: ['kind'],
});

export const bundleRepairCycleDurationHistogram = new promClient.Histogram({
  name: 'bundle_repair_cycle_duration_seconds',
  help: 'Wall-clock duration of each bundle-repair-worker cycle, by kind',
  labelNames: ['kind'],
  buckets: [0.05, 0.5, 1, 5, 30, 60, 300, 600],
});

export const bundleRepairErrorsCounter = new promClient.Counter({
  name: 'bundle_repair_errors_total',
  help: 'Bundle-repair-worker cycle errors, by kind',
  labelNames: ['kind'],
});

export const bundleRepairPendingBundlesGauge = new promClient.Gauge({
  name: 'bundle_repair_pending_bundles',
  help: 'Bundles awaiting full indexing (matched_data_item_count > 0 AND last_fully_indexed_at IS NULL AND last_skipped_at IS NULL). Refreshed once per `updateBundleTimestamps` cycle.',
});

// Full unbundling backlog. Deliberately not named with "repair": most of
// this count is bundles awaiting their first unbundling, not repairs.
// bundle_repair_pending_bundles only counts the matched_data_item_count > 0
// subset — bundles that already unbundled once — so it under-reports total
// outstanding work by orders of magnitude when most of the backlog has
// never been successfully unbundled. This gauge is the complete picture.
export const bundlesUnbundlingBacklogGauge = new promClient.Gauge({
  name: 'bundles_unbundling_backlog',
  help: 'Full unbundling backlog: all bundles still awaiting unbundling work (last_fully_indexed_at IS NULL AND last_skipped_at IS NULL AND matched_data_item_count IS NULL or > 0). Includes bundles never successfully unbundled, unlike bundle_repair_pending_bundles. Refreshed once per `updateBundleTimestamps` cycle.',
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
// GraphQL resolver metrics
//

export const graphqlRequestsCounter = new promClient.Counter({
  name: 'graphql_requests_total',
  help:
    'Count of GraphQL requests received by the Apollo server. ' +
    'Incremented once per request at `requestDidStart`, so it covers every ' +
    'shape that hits the GraphQL endpoint — Query, Mutation, Subscription, ' +
    'introspection, and even malformed/validation-failing requests. The ' +
    'right denominator for the disconnect rate ' +
    '(`graphql_resolver_cancellations_total / graphql_requests_total`) ' +
    'because every cancelled request is, by definition, a request first.',
});

export const graphqlQueriesCounter = new promClient.Counter({
  name: 'graphql_queries_total',
  help:
    'Count of top-level Query resolver invocations, labeled by resolver name. ' +
    'Increments per resolver hit, so a request with multiple top-level Query ' +
    'fields increments multiple times. Captures resolver-level fan-out ' +
    'volume, NOT request volume — use `graphql_requests_total` for the ' +
    'denominator of any per-request rate (e.g. disconnect rate).',
  labelNames: ['resolver'],
});

export const graphqlRequestDurationHistogram = new promClient.Histogram({
  name: 'graphql_request_duration_seconds',
  help: 'Duration of top-level GraphQL resolver execution',
  labelNames: ['resolver'],
  buckets: [0.001, 0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30],
});

export const graphqlResolverCancellationsCounter = new promClient.Counter({
  name: 'graphql_resolver_cancellations_total',
  help:
    'Count of GraphQL resolver signal aborts. `client_disconnect` fires when ' +
    'the express request socket closes; `deadline_exceeded` fires when the ' +
    'server-side `GRAPHQL_RESOLVER_DEADLINE_MS` timer elapses first.',
  labelNames: ['reason'],
});

//
// Attribute fetcher metrics (signature/owner pipeline)
//

export const attributeFetchCounter = new promClient.Counter({
  name: 'attribute_fetch_total',
  help:
    'Count of owner/signature attribute fetch attempts by source and outcome. ' +
    '`source` records where the value came from (or where we gave up): ' +
    '`store` (signatureStore/ownerStore KV), `attributes` (inline value in ' +
    'data_item/transaction attributes), `parent_data` (bytes via ' +
    'fetchDataFromParent — data items only), `chain` (chainSource — ' +
    'transactions only), `derived` (secp256k1 owner-from-tx recovery), ' +
    '`incomplete_root` (PE-9073 guard fired). `outcome` is one of `hit`, ' +
    '`aborted`, `error`, `not_found`.',
  labelNames: ['kind', 'subject', 'source', 'outcome'],
});

export const attributeFetchDurationHistogram = new promClient.Histogram({
  name: 'attribute_fetch_duration_seconds',
  help: 'Duration of owner/signature attribute fetch operations',
  labelNames: ['kind', 'subject', 'source'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30],
});

// Owner-key cache observability (PE-9120). Hit/miss and timing by cache key
// reuse attribute_fetch_total / attribute_fetch_duration_seconds via the
// `store_address` (shared owner_address key — cross-item reuse) and `store_id`
// (per-item / admin key) sources. This counter additionally tracks concurrent
// fetches collapsed by the address-keyed in-flight coalescer.
export const ownerFetchCoalescedCounter = new promClient.Counter({
  name: 'owner_fetch_coalesced_total',
  help:
    'Count of owner-key fetches served by joining an in-flight fetch for the ' +
    'same owner address instead of issuing a new one (PE-9120 coalescer). ' +
    'High relative to owner `parent_data`/`chain` fetches means intra-page ' +
    'dedup is working.',
  labelNames: ['subject'],
});

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

export const arweavePeerSyncBucketErrorCounter = new promClient.Counter({
  name: 'arweave_peer_sync_bucket_errors_total',
  help: 'Count of failed sync bucket fetch requests from Arweave peers',
});

export const arweavePeerSyncBucketUpdateCounter = new promClient.Counter({
  name: 'arweave_peer_sync_bucket_updates_total',
  help: 'Count of successful sync bucket updates from Arweave peers',
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

export const arweavePeerChunkQueuesGauge = new promClient.Gauge({
  name: 'arweave_peer_chunk_queues_size',
  help: 'Number of peer chunk queues in memory',
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
// ClickHouse Export Visibility Metrics
//

// Lowest height still present in stable_data_items. Flat over multiple
// auto-import cycles indicates the prune step is no-op-ing — usually
// because backfill writes at low heights keep landing with an indexed_at
// newer than the prune threshold, so SQLite never shrinks and every
// cycle restarts from the same low bucket.
export const minStableDataItemHeight = new promClient.Gauge({
  name: 'min_stable_data_item_height',
  help: 'Lowest height present in stable_data_items (MIN(height)).',
});

// Cached value of `SELECT max(height) FROM transactions` on ClickHouse.
// Gap from `last_height_imported` is the ClickHouse sync lag — historical
// GQL queries route to ClickHouse below this height, so a wide gap means
// stable_data_items in the gap are invisible to GQL when
// CLICKHOUSE_SQLITE_MIN_HEIGHT_ENABLED is true.
export const clickhouseMaxImportedHeight = new promClient.Gauge({
  name: 'clickhouse_max_imported_height',
  help: 'Max height present in the ClickHouse `transactions` table (refreshed lazily).',
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

/**
 * Incremented when {@link CompositeArNSResolver} returns a cached resolution
 * because a fresh resolution attempt resolved with no resolved id — distinct
 * from the timeout-triggered cached fallback. Tracks how often the gateway
 * is serving stale data due to upstream (names cache / Solana RPC) returning
 * `undefined` faster than the cached-resolution fallback timeout.
 */
export const arnsCachedResolutionFallbackOnEmptyCounter =
  new promClient.Counter({
    name: 'arns_cached_resolution_fallback_on_empty_total',
    help: 'Count of times CompositeArNSResolver returned a cached resolution because fresh resolution had no resolved id (no error/timeout)',
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
// Stream metrics
//

export const clientDisconnectsTotal = new promClient.Counter({
  name: 'client_disconnects_total',
  help: 'Count of client disconnects during data streaming',
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

export const getDataStreamBytesTotal = new promClient.Counter({
  name: 'get_data_stream_bytes_total',
  help: 'Total bytes streamed successfully',
  labelNames: ['class', 'source', 'request_type'] as const,
});

export const getDataStreamSizeHistogram = new promClient.Histogram({
  name: 'get_data_stream_size_bytes',
  help: 'Distribution of data stream sizes in bytes',
  labelNames: ['class', 'source', 'request_type'] as const,
  buckets: [102400, 1048576, 10485760, 104857600], // 100KB, 1MB, 10MB, 100MB
});

// Incremented when GatewaysDataSource sent a Range request but the upstream
// answered with a full 200 body instead of a 206 partial-content response.
// `outcome` distinguishes the cases:
//   - 'sliced':                    we accepted the 200 and sliced locally
//                                  (region.offset <= the configured cap)
//   - 'rejected_offset_too_high':  region.offset exceeded the cap, so we
//                                  rejected the response and let the data
//                                  source chain fall through to the next
//                                  priority tier instead of burning
//                                  region.offset bytes of bandwidth
// The metric surfaces which gateways are doing this and the per-gateway
// rate of each outcome, so operators can tune
// GATEWAYS_RANGE_ACCEPT_200_MAX_OFFSET.
export const gatewayRangeIgnoredTotal = new promClient.Counter({
  name: 'gateway_range_ignored_total',
  help: 'Count of Range requests where the upstream returned a full 200 body, with outcome label for accepted (sliced locally) vs rejected (offset above threshold)',
  labelNames: ['gateway_url', 'priority', 'outcome'] as const,
});

// PE-9099: count of upstream responses rejected because the caller-supplied
// `acceptContentType` predicate refused the response's content-type. The
// known case is `text/html` parking pages cached in the legacy gateway's
// S3 layer from a Sept-2024 outage of `gateway.bundlr.network`. Operators
// can correlate the per-gateway rate to know which upstream caches are
// still serving poison.
export const gatewayContentTypeRejectedTotal = new promClient.Counter({
  name: 'gateway_content_type_rejected_total',
  help: 'Count of upstream responses rejected by the caller-supplied content-type predicate (e.g., text/html when expecting bundle bytes).',
  labelNames: ['gateway_url', 'priority', 'content_type'] as const,
});

// PE-9099: count of local on-disk cache entries evicted by the lazy
// poison-detection in ReadThroughDataCache when a caller's
// `acceptContentType` predicate refuses the stored content-type. The
// blob is deleted and the request falls through to upstream; the next
// successful cache write replaces the entry with clean bytes.
export const poisonedCacheEvictionsTotal = new promClient.Counter({
  name: 'poisoned_cache_evictions_total',
  help: 'Count of on-disk cache blobs evicted because their stored content-type was rejected by the caller predicate (lazy heal of poisoned cache entries).',
  labelNames: ['content_type'] as const,
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

export const chunkFirstDataTimeoutsTotal = new promClient.Counter({
  name: 'chunk_first_data_timeouts_total',
  help: 'Count of first-data timeouts in TxChunksDataSource',
  labelNames: ['request_type'] as const,
});

//
// Negative data cache metrics
//

export const negativeCacheHitsTotal = new promClient.Counter({
  name: 'negative_cache_hits_total',
  help: 'Count of negative cache hits (requests short-circuited)',
});

export const negativeCacheMissesTotal = new promClient.Counter({
  name: 'negative_cache_misses_total',
  help: 'Count of negative cache misses (requests not in negative cache)',
});

export const negativeCachePromotionsTotal = new promClient.Counter({
  name: 'negative_cache_promotions_total',
  help: 'Count of IDs promoted from miss tracker to negative cache',
});

export const negativeCacheEvictionsTotal = new promClient.Counter({
  name: 'negative_cache_evictions_total',
  help: 'Count of IDs evicted from negative cache (successful retrieval)',
});

export const negativeCacheSize = new promClient.Gauge({
  name: 'negative_cache_size',
  help: 'Current number of entries in the negative cache',
});

export const missTrackerSize = new promClient.Gauge({
  name: 'miss_tracker_size',
  help: 'Current number of entries in the miss tracker',
});

export const negativeCacheRePromotionsTotal = new promClient.Counter({
  name: 'negative_cache_repromotions_total',
  help: 'Count of IDs re-promoted to negative cache',
});

export const promotionHistorySize = new promClient.Gauge({
  name: 'promotion_history_size',
  help: 'Current number of entries in promotion history tracker',
});

export const negativeCachePromotionsSuppressedTotal = new promClient.Counter({
  name: 'negative_cache_promotions_suppressed_total',
  help: 'Count of promotions suppressed due to unhealthy system state',
});

//
// Chunk source metrics
//

export const requestChunkTotal = new promClient.Counter({
  name: 'request_chunk_total',
  help: 'Count of each individual chunk http request, status can be "error" or "success", source_type can be "trusted", "preferred", or "peer", peer_type can be "bucket" or "general".',
  labelNames: [
    'status',
    'class',
    'method',
    'source',
    'source_type',
    'peer_type',
  ] as const,
});

export const getChunkTotal = new promClient.Counter({
  name: 'get_chunk_total',
  help: 'Higher level count of chunk discovery, counts when the caller request for chunk ends, stores the status of the request',
  labelNames: ['status', 'class', 'method'] as const,
});

export const chunkPeerTransitionTotal = new promClient.Counter({
  name: 'chunk_peer_transition_total',
  help: 'Count of chunk retrieval attempts that required fallback from bucket to general peers',
  labelNames: ['method'] as const,
});

//
// Chunk rebroadcasting metrics
//

export const chunkRebroadcastAttemptsTotal = new promClient.Counter({
  name: 'chunk_rebroadcast_attempts_total',
  help: 'Count of chunk rebroadcast attempts',
});

export const chunkRebroadcastSuccessesTotal = new promClient.Counter({
  name: 'chunk_rebroadcast_successes_total',
  help: 'Count of successful chunk rebroadcasts',
});

export const chunkRebroadcastFailuresTotal = new promClient.Counter({
  name: 'chunk_rebroadcast_failures_total',
  help: 'Count of failed chunk rebroadcasts',
});

export const chunkRebroadcastSkippedTotal = new promClient.Counter({
  name: 'chunk_rebroadcast_skipped_total',
  help: 'Count of skipped chunk rebroadcasts',
  labelNames: ['reason'] as const,
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
// Contiguous data cache metrics
//

export const contiguousDataCacheHitTotal = new promClient.Counter({
  name: 'contiguous_data_cache_hit_total',
  help: 'Count of contiguous data cache hits in ReadThroughDataCache',
  labelNames: ['request_type'] as const,
});

export const contiguousDataCacheMissTotal = new promClient.Counter({
  name: 'contiguous_data_cache_miss_total',
  help: 'Count of contiguous data cache misses where data was found upstream',
  labelNames: ['request_type'] as const,
});

export const contiguousDataCacheNotFoundTotal = new promClient.Counter({
  name: 'contiguous_data_cache_not_found_total',
  help: 'Count of contiguous data cache misses where data was not found in any source',
  labelNames: ['request_type'] as const,
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
  'composite-sqlite-gql',
  'get-data-attributes',
  'get-data-item-attributes',
  'get-data-parent',
  'get-transaction-attributes',
  'graphql-root-tx-index',
  'hyperbeam-root-tx-index',
  'turbo-root-tx-index',
  'turbo_dynamodb',
  'turbo_elasticache',
] as const;
export type BreakerSource = (typeof breakerSourceNames)[number];
const breakerSources: BreakerSource[] = [...breakerSourceNames];

// Breakers where cardinality is dimensioned by an endpoint URL as well as
// the breaker name. Kept separate from BreakerSource so the zero-init logic
// for label-only breaker metrics doesn't create empty always-zero series.
const endpointBreakerSourceNames = ['gateways-gql'] as const;
export type EndpointBreakerSource = (typeof endpointBreakerSourceNames)[number];

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

export const circuitBreakerEndpointOpenCount = new promClient.Counter({
  name: 'circuit_breaker_endpoint_open_count',
  help: 'Count of occasions when a per-endpoint circuit breaker has opened',
  labelNames: ['breaker', 'endpoint'],
});

export const circuitBreakerEndpointState = new Gauge({
  name: 'circuit_breaker_endpoint_state',
  help: 'State of the per-endpoint circuit breaker (1 is open, 0 is closed, 0.5 is half open)',
  labelNames: ['breaker', 'endpoint'],
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

export function setUpEndpointCircuitBreakerListenerMetrics(
  breakerName: EndpointBreakerSource,
  endpoint: string,
  breaker: CircuitBreaker,
  logger?: winston.Logger | undefined,
) {
  const labels = { breaker: breakerName, endpoint };
  circuitBreakerEndpointState.set(labels, 0);
  circuitBreakerEndpointOpenCount.inc(labels, 0);

  breaker.on('open', () => {
    circuitBreakerEndpointOpenCount.inc(labels);
    circuitBreakerEndpointState.set(labels, 1);
    logger?.error(`${breakerName} circuit breaker opened`, { endpoint });
  });
  breaker.on('close', () => {
    circuitBreakerEndpointState.set(labels, 0);
    logger?.info(`${breakerName} circuit breaker closed`, { endpoint });
  });
  breaker.on('halfOpen', () => {
    circuitBreakerEndpointState.set(labels, 0.5);
    logger?.info(`${breakerName} circuit breaker half-open`, { endpoint });
  });
}

//
// Rate Limiter metrics
//

export const rateLimitExceededTotal = new promClient.Counter({
  name: 'rate_limit_exceeded_total',
  help: 'Total number of requests that exceeded rate limits',
  labelNames: ['limit_type', 'domain'],
});

export const rateLimitRequestsTotal = new promClient.Counter({
  name: 'rate_limit_requests_total',
  help: 'Total number of requests processed by rate limiter',
  labelNames: ['domain'],
});

export const rateLimitBytesBlockedTotal = new promClient.Counter({
  name: 'rate_limit_bytes_blocked_total',
  help: 'Total number of bytes that would have been served if not rate limited',
  labelNames: ['domain'],
});

export const rateLimitTokensConsumedTotal = new promClient.Counter({
  name: 'rate_limit_tokens_consumed_total',
  help: 'Total tokens consumed by rate limiter with breakdown by bucket and token type',
  labelNames: ['bucket_type', 'token_type', 'domain'],
});

//
// Root TX Index metrics
//

export const rootTxLookupTotal = new promClient.Counter({
  name: 'root_tx_lookup_total',
  help: 'Total root TX index lookups by source and status',
  labelNames: ['source', 'status', 'has_offsets'] as const,
});

export const rootTxLookupDurationSummary = new promClient.Summary({
  name: 'root_tx_lookup_duration_ms',
  help: 'Duration of root TX lookups in milliseconds by source',
  labelNames: ['source'] as const,
});

export const rootTxCacheHitTotal = new promClient.Counter({
  name: 'root_tx_cache_hit_total',
  help: 'Cache hits in root TX index LRU caches',
  labelNames: ['source'] as const,
});

export const rootTxCacheMissTotal = new promClient.Counter({
  name: 'root_tx_cache_miss_total',
  help: 'Cache misses in root TX index LRU caches',
  labelNames: ['source'] as const,
});

export const compositeRootTxLookupTotal = new promClient.Counter({
  name: 'composite_root_tx_lookup_total',
  help: 'Total composite root TX lookups with final outcome',
  labelNames: ['status', 'winning_source', 'has_complete_offsets'] as const,
});

export const compositeRootTxLookupDurationSummary = new promClient.Summary({
  name: 'composite_root_tx_lookup_duration_ms',
  help: 'Total duration of composite root TX lookups',
});

//
// Root TX Semaphore metrics
//

const semaphores: { [key: string]: Semaphore } = {};
export function registerSemaphoreMetrics(name: string, semaphore: Semaphore) {
  semaphores[name] = semaphore;
}

export const rootTxSemaphoreAvailablePermits = new Gauge({
  name: 'root_tx_semaphore_available_permits',
  help: 'Available permits in root TX semaphores',
  labelNames: ['name'],
  collect() {
    Object.entries(semaphores).forEach(([name, semaphore]) => {
      this.set({ name }, semaphore.availablePermits());
    });
  },
});

export const rootTxSemaphoreQueueLength = new Gauge({
  name: 'root_tx_semaphore_queue_length',
  help: 'Number of waiters queued for root TX semaphore permits',
  labelNames: ['name'],
  collect() {
    Object.entries(semaphores).forEach(([name, semaphore]) => {
      this.set({ name }, semaphore.queueLength());
    });
  },
});

export const rootTxSemaphoreTimeoutTotal = new promClient.Counter({
  name: 'root_tx_semaphore_timeout_total',
  help: 'Total semaphore acquire timeouts in root TX lookups',
  labelNames: ['name'] as const,
});

//
// ANS-104 Offset Source metrics
//

export const ans104OffsetLookupTotal = new promClient.Counter({
  name: 'ans104_offset_lookup_total',
  help: 'Total ANS-104 offset lookups by method and result',
  labelNames: ['method', 'status'] as const,
});

export const ans104OffsetLookupDurationSummary = new promClient.Summary({
  name: 'ans104_offset_lookup_duration_ms',
  help: 'Duration of ANS-104 offset lookups in milliseconds',
  labelNames: ['method'] as const,
});

export const ans104OffsetPathDepthHistogram = new promClient.Histogram({
  name: 'ans104_offset_path_depth',
  help: 'Depth of bundle path in path-guided offset lookups',
  buckets: [2, 3, 4],
});

//
// Cache re-verification metrics
//

export const cacheRetryAttemptsTotal = new promClient.Counter({
  name: 'cache_retry_attempts_total',
  help: 'Stochastic cache re-verification attempts',
  labelNames: ['trust_status'] as const,
});

export const cacheRetryMatchesTotal = new promClient.Counter({
  name: 'cache_retry_matches_total',
  help: 'Cache re-verification hash matches',
});

export const cacheRetryMismatchesTotal = new promClient.Counter({
  name: 'cache_retry_mismatches_total',
  help: 'Cache re-verification hash mismatches',
});

export const cacheEvictionsTotal = new promClient.Counter({
  name: 'cache_evictions_total',
  help: 'Cache evictions due to hash mismatch',
});

//
// Background range cache metrics
//

export const backgroundRangeCacheTriggeredTotal = new promClient.Counter({
  name: 'background_range_cache_triggered_total',
  help: 'Background full-item cache fetches triggered after range cache misses',
});

export const backgroundRangeCacheCompletedTotal = new promClient.Counter({
  name: 'background_range_cache_completed_total',
  help: 'Background full-item cache fetches completed successfully',
});

export const backgroundRangeCacheFailedTotal = new promClient.Counter({
  name: 'background_range_cache_failed_total',
  help: 'Background full-item cache fetches that failed',
});

export const backgroundRangeCacheSkippedTotal = new promClient.Counter({
  name: 'background_range_cache_skipped_total',
  help: 'Background full-item cache fetches skipped',
  labelNames: ['reason'] as const,
});

//
// Sampling data source metrics
//

export const samplingDecisionTotal = new promClient.Counter({
  name: 'sampling_decision_total',
  help: 'Count of sampling decisions by source and outcome',
  labelNames: ['source', 'decision'] as const,
});

export const samplingRequestTotal = new promClient.Counter({
  name: 'sampling_request_total',
  help: 'Count of sampled requests by source and status',
  labelNames: ['source', 'status'] as const,
});

export const samplingLatencyMs = new promClient.Histogram({
  name: 'sampling_latency_ms',
  help: 'Latency of sampled requests in milliseconds',
  labelNames: ['source', 'status'] as const,
  buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10000],
});

//
// Envoy EDS peer discovery metrics
//

export const envoyEdsPeersDiscovered = new promClient.Gauge({
  name: 'envoy_eds_peers_discovered',
  help: 'Number of IPs found via DNS resolution',
});

export const envoyEdsPeersHealthy = new promClient.Gauge({
  name: 'envoy_eds_peers_healthy',
  help: 'Number of peers responding to /info',
});

export const envoyEdsPeersFull = new promClient.Gauge({
  name: 'envoy_eds_peers_full',
  help: 'Number of peers classified as full nodes',
});

export const envoyEdsPeersPartial = new promClient.Gauge({
  name: 'envoy_eds_peers_partial',
  help: 'Number of peers classified as partial nodes',
});

export const envoyEdsPeersExcluded = new promClient.Gauge({
  name: 'envoy_eds_peers_excluded',
  help: 'Number of peers excluded due to height outliers',
});

export const envoyEdsReferenceHeight = new promClient.Gauge({
  name: 'envoy_eds_reference_height',
  help: 'Computed reference height for peer classification',
});

export const envoyEdsHealthCheckCyclesTotal = new promClient.Counter({
  name: 'envoy_eds_health_check_cycles_total',
  help: 'Total number of completed health check cycles',
});

export const envoyEdsHealthCheckErrorsTotal = new promClient.Counter({
  name: 'envoy_eds_health_check_errors_total',
  help: 'Total number of failed /info requests',
});

export const envoyEdsFileWritesTotal = new promClient.Counter({
  name: 'envoy_eds_file_writes_total',
  help: 'Total number of EDS file writes',
  labelNames: ['cluster'] as const,
});

//
// HTTPSIG response signing
//

export const httpSigResponsesSignedTotal = new promClient.Counter({
  name: 'httpsig_responses_signed_total',
  help: 'Total HTTP responses signed with HTTPSIG',
});

export const httpSigSigningDuration = new promClient.Histogram({
  name: 'httpsig_signing_duration_seconds',
  help: 'Time to sign HTTP responses',
  buckets: [0.00001, 0.00005, 0.0001, 0.0005, 0.001],
});

export const httpSigErrorsTotal = new promClient.Counter({
  name: 'httpsig_errors_total',
  help: 'Total HTTPSIG signing errors',
});

//
// IPFS metrics
//

export const ipfsRequestsTotal = new promClient.Counter({
  name: 'ipfs_requests_total',
  help: 'Total IPFS content requests',
  labelNames: ['route_type', 'status'] as const,
});

export const ipfsCacheHitTotal = new promClient.Counter({
  name: 'ipfs_cache_hit_total',
  help: 'IPFS content cache hits',
});

export const ipfsCacheMissTotal = new promClient.Counter({
  name: 'ipfs_cache_miss_total',
  help: 'IPFS content cache misses',
});

export const ipfsContentSizeHistogram = new promClient.Histogram({
  name: 'ipfs_content_size_bytes',
  help: 'Distribution of IPFS content sizes',
  buckets: [1024, 102400, 1048576, 10485760, 104857600],
});

export const ipfsRequestDurationHistogram = new promClient.Histogram({
  name: 'ipfs_request_duration_seconds',
  help: 'Duration of IPFS content requests',
  labelNames: ['route_type', 'cache_status'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export const ipfsBlockedTotal = new promClient.Counter({
  name: 'ipfs_blocked_total',
  help: 'IPFS requests blocked by CID blocklist',
});

//
// Chunk metadata anchor (offset → tx + data_root via reference peer
// `/chunk/{offset}/data` headers, cross-checked against the chain).
// See src/data/chunk-metadata-anchor-source.ts and ar-io/ar-io-node#681.
//

/**
 * Counter of chunk-metadata-anchor lookup outcomes. The `result` label
 * mirrors the observer's `observer_chunk_metadata_anchor_total` so
 * dashboards stay consistent across the two services.
 *
 * Labels (`result`):
 * - `hit`              — peer headers parsed AND chain cross-check passed
 * - `cache_hit`        — same tx already anchored; offset confirmed in range
 * - `metadata_missing` — peer didn't return required headers
 * - `mismatch`         — chain disagreed with peer; falls through to next source
 * - `error`            — HTTP/network failure; falls through
 */
export const chunkMetadataAnchorTotal = new promClient.Counter({
  name: 'ario_chunk_metadata_anchor_total',
  help: 'Outcomes of chunk-metadata-anchor TxBoundary lookups',
  labelNames: ['result'],
});

/**
 * Counter of retrieval-hint headers emitted on outbound proxy forwards.
 * Together with the inbound hint parsing already in place, this measures
 * how often the network is self-warming — every emit is a chance for the
 * receiving gateway to skip the `bundledIn` traversal it would otherwise
 * perform.
 *
 * Labels (`kind`):
 * - `root_id`     — `X-AR-IO-Root-Transaction-Id` was sent
 * - `path`        — `X-AR-IO-Root-Path` was sent (comma-separated parent chain)
 * - `byte_offset` — `X-AR-IO-Root-Item-Offset` + `X-AR-IO-Root-Item-Size` pair was sent
 */
export const hintEmittedTotal = new promClient.Counter({
  name: 'ario_hint_emitted_total',
  help: 'Retrieval-hint headers emitted on outbound forwards',
  labelNames: ['kind'],
});

/**
 * Counter of Content-Digest emission outcomes on data and chunk
 * responses. Helps tune `HTTPSIG_BODY_DIGEST_BUFFER_MAX_BYTES` from
 * real traffic.
 *
 * Labels:
 * - `source`: `cache_hit` | `computed_buffered` | `skipped_size_unknown`
 *   | `skipped_too_large` | `skipped_disabled` | `overran_threshold`
 *   | `short_read`
 * - `path`: `data` | `chunk` — separates the two routes so chunks
 *   (always small, always hashable) can be observed independently of
 *   data responses.
 */
export const httpSigContentDigestTotal = new promClient.Counter({
  name: 'httpsig_content_digest_total',
  help: 'Content-Digest emission outcomes on data and chunk responses',
  labelNames: ['source', 'path'],
});

// String-union types for the `httpSigContentDigestTotal` labels. The
// underlying prom-client Counter accepts arbitrary strings, so use the
// `incHttpSigContentDigest` wrapper below for compile-time typo safety
// — direct `.inc({ source: 'whatever' })` calls bypass the check.
export type HttpSigDigestSource =
  | 'cache_hit'
  | 'computed_buffered'
  | 'skipped_disabled'
  | 'skipped_size_unknown'
  | 'skipped_too_large'
  | 'overran_threshold'
  | 'short_read';
export type HttpSigDigestPath = 'data' | 'chunk';

export function incHttpSigContentDigest(labels: {
  source: HttpSigDigestSource;
  path: HttpSigDigestPath;
}): void {
  httpSigContentDigestTotal.inc(labels);
}

/**
 * Gauge of aggregate bytes currently held in memory by buffered-digest
 * in-flight computations. Each in-flight buffered request contributes
 * up to `HTTPSIG_BODY_DIGEST_BUFFER_MAX_BYTES`. Watch this to detect
 * concurrency-driven memory pressure on the digest path.
 */
export const httpSigBufferedBytesInflight = new promClient.Gauge({
  name: 'httpsig_buffered_bytes_inflight',
  help: 'Aggregate bytes held in memory by buffered-digest in-flight reads',
});

export const httpSigInitFailedTotal = new promClient.Counter({
  name: 'httpsig_init_failed_total',
  help: 'HTTPSIG signing initialization failed at startup; signing is disabled',
});

//
// Optimistic L1 transaction indexing (corner C)
//

/**
 * Count of L1 transactions submitted to the optimistic-tx admin ingest
 * endpoint (`POST /ar-io/admin/queue-optimistic-tx`). `result`:
 *   - `indexed`  — authenticated and inserted into `new_transactions`
 *                  (height NULL = pending until mined)
 *   - `invalid`  — rejected; the tx signature/id did not verify
 *   - `disabled` — rejected; `OPTIMISTIC_TX_INDEXING_ENABLED` is false
 */
export const optimisticTxIngestedCounter = new promClient.Counter({
  name: 'optimistic_tx_ingested_total',
  help: 'Count of L1 txs submitted to the optimistic-tx ingest endpoint by result',
  labelNames: ['result'],
});

/**
 * Count of times the data-verification worker WITHHELD a verified=1 stamp
 * because the root transaction is not yet mined (`height IS NULL`) — i.e. an
 * optimistically-indexed tx with no on-chain block yet. This is the serving
 * guard firing: proof the gateway never marks data `verified` for a tx with no
 * block. Scoped to unmined data, so normal mined data is unaffected. A
 * steadily-draining value is healthy (optimistic txs awaiting their block); a
 * persistently high / non-draining value indicates optimistic txs that never
 * mined. Also the magnitude signal for the LIMIT-1000 batch-occupancy residual
 * (see data-verification.ts): measure this on a busy gateway before gating the
 * verification SELECT on mined-status.
 */
export const optimisticTxVerificationBlockedCounter = new promClient.Counter({
  name: 'optimistic_tx_verification_blocked_total',
  help: 'Count of verification attempts withheld because the root tx is not yet mined (optimistic / NULL height)',
});
