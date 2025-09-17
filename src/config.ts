/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { canonicalize } from 'json-canonicalize';
import { isMainThread } from 'node:worker_threads';
import { existsSync, readFileSync } from 'node:fs';

import { createFilter } from './filters.js';
import * as env from './lib/env.js';
import { release } from './version.js';
import logger from './log.js';
import { verificationPriorities } from './constants.js';

//
// HTTP server
//

// HTTP server port
export const PORT = +env.varOrDefault('PORT', '4000');

// API key for accessing admin HTTP endpoints
// It's set once in the main thread
export let ADMIN_API_KEY = isMainThread
  ? env.varOrRandom('ADMIN_API_KEY')
  : undefined;

const ADMIN_API_KEY_FILE = isMainThread
  ? env.varOrUndefined('ADMIN_API_KEY_FILE')
  : undefined;

if (ADMIN_API_KEY_FILE !== undefined) {
  if (!existsSync(ADMIN_API_KEY_FILE)) {
    throw new Error(`ADMIN_API_KEY_FILE not found: ${ADMIN_API_KEY_FILE}`);
  }
  ADMIN_API_KEY = readFileSync(ADMIN_API_KEY_FILE).toString().trim();
}

//
// Redis
//

// Redis URL
export const REDIS_CACHE_URL = env.varOrDefault(
  'REDIS_CACHE_URL',
  'redis://localhost:6379',
);

export const REDIS_USE_TLS =
  env.varOrDefault('REDIS_USE_TLS', 'false') === 'true';

// Default Redis TTL
export const REDIS_CACHE_TTL_SECONDS = +env.varOrDefault(
  'REDIS_CACHE_TTL_SECONDS',
  `${60 * 60 * 8}`, // 8 hours by default
);

//
// Nodes
//

// Trusted Arweave node URL (for syncing the chain and retrieving chunks)
export const TRUSTED_NODE_URL = env.varOrDefault(
  'TRUSTED_NODE_URL',
  'https://arweave.net',
);

// Default preferred chunk GET nodes (data-1 through data-12.arweave.xyz)
const DEFAULT_PREFERRED_CHUNK_GET_NODE_URLS = [
  'http://data-1.arweave.xyz:1984',
  'http://data-2.arweave.xyz:1984',
  'http://data-3.arweave.xyz:1984',
  'http://data-4.arweave.xyz:1984',
  'http://data-5.arweave.xyz:1984',
  'http://data-6.arweave.xyz:1984',
  'http://data-7.arweave.xyz:1984',
  'http://data-8.arweave.xyz:1984',
  'http://data-9.arweave.xyz:1984',
  'http://data-10.arweave.xyz:1984',
  'http://data-11.arweave.xyz:1984',
  'http://data-12.arweave.xyz:1984',
];

// Preferred URLs for chunk GET requests (comma-separated URLs)
const PREFERRED_CHUNK_GET_NODE_URLS_STRING = env.varOrUndefined(
  'PREFERRED_CHUNK_GET_NODE_URLS',
);
export const PREFERRED_CHUNK_GET_NODE_URLS =
  PREFERRED_CHUNK_GET_NODE_URLS_STRING !== undefined
    ? PREFERRED_CHUNK_GET_NODE_URLS_STRING.split(',').map((url) => url.trim())
    : DEFAULT_PREFERRED_CHUNK_GET_NODE_URLS;

// Validate preferred chunk GET URLs
PREFERRED_CHUNK_GET_NODE_URLS.forEach((url) => {
  try {
    new URL(url);
  } catch (error) {
    throw new Error(`Invalid URL in PREFERRED_CHUNK_GET_NODE_URLS: ${url}`);
  }
});

// DNS resolution interval for preferred chunk nodes (in seconds)
export const PREFERRED_CHUNK_NODE_DNS_RESOLUTION_INTERVAL_SECONDS =
  +env.varOrDefault(
    'PREFERRED_CHUNK_NODE_DNS_RESOLUTION_INTERVAL_SECONDS',
    '3600', // 1 hour by default
  );

// Trusted gateway URL (for retrieving contiguous data)
export const TRUSTED_GATEWAY_URL = env.varOrUndefined('TRUSTED_GATEWAY_URL');

// Trusted gateway URLs (for retrieving contiguous data)
export const TRUSTED_GATEWAYS_URLS = JSON.parse(
  env.varOrDefault(
    'TRUSTED_GATEWAYS_URLS',
    TRUSTED_GATEWAY_URL !== undefined
      ? JSON.stringify({ [TRUSTED_GATEWAY_URL]: 1 })
      : '{ "https://arweave.net": 1}',
  ),
) as Record<string, number>;

// Validate URLs and weights
Object.entries(TRUSTED_GATEWAYS_URLS).forEach(([url, weight]) => {
  try {
    new URL(url);
  } catch (error) {
    throw new Error(`Invalid URL in TRUSTED_GATEWAYS_URLS: ${url}`);
  }
  if (typeof weight !== 'number' || weight <= 0) {
    throw new Error(
      `Invalid weight in TRUSTED_GATEWAYS_URLS for ${url}: ${weight}`,
    );
  }
});

// Trusted gateways blocked origins (origins to reject when forwarding)
export const TRUSTED_GATEWAYS_BLOCKED_ORIGINS = env
  .varOrDefault('TRUSTED_GATEWAYS_BLOCKED_ORIGINS', '')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

// Validate blocked origins
TRUSTED_GATEWAYS_BLOCKED_ORIGINS.forEach((origin) => {
  if (typeof origin !== 'string' || origin.trim().length === 0) {
    throw new Error(
      `Invalid origin in TRUSTED_GATEWAYS_BLOCKED_ORIGINS: ${origin}`,
    );
  }
});

// Trusted gateways blocked CIDR ranges to reject when forwarding
export const TRUSTED_GATEWAYS_BLOCKED_CIDRS = env
  .varOrDefault('TRUSTED_GATEWAYS_BLOCKED_CIDRS', '')
  .split(',')
  .map((cidr) => cidr.trim())
  .filter((cidr) => cidr.length > 0);

// Validate blocked CIDR ranges
TRUSTED_GATEWAYS_BLOCKED_CIDRS.forEach((cidr) => {
  if (typeof cidr !== 'string' || cidr.trim().length === 0) {
    throw new Error(`Invalid CIDR in TRUSTED_GATEWAYS_BLOCKED_CIDRS: ${cidr}`);
  }
  if (!cidr.includes('/')) {
    throw new Error(
      `Invalid CIDR format in TRUSTED_GATEWAYS_BLOCKED_CIDRS: ${cidr} (must include /prefix)`,
    );
  }
});

export const TRUSTED_GATEWAYS_REQUEST_TIMEOUT_MS = +env.varOrDefault(
  'TRUSTED_GATEWAYS_REQUEST_TIMEOUT_MS',
  '10000',
);

// Root TX index lookup order configuration
export const ROOT_TX_LOOKUP_ORDER = env
  .varOrDefault('ROOT_TX_LOOKUP_ORDER', 'db,turbo')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

// Shared root TX cache configuration
export const ROOT_TX_CACHE_MAX_SIZE = +env.varOrDefault(
  'ROOT_TX_CACHE_MAX_SIZE',
  '10000',
);
export const ROOT_TX_CACHE_TTL_MS = +env.varOrDefault(
  'ROOT_TX_CACHE_TTL_MS',
  '300000', // 5 minutes
);

// Turbo endpoint configuration
export const TURBO_ENDPOINT = env.varOrDefault(
  'TURBO_ENDPOINT',
  'https://turbo.ardrive.io',
);
export const TURBO_REQUEST_TIMEOUT_MS = +env.varOrDefault(
  'TURBO_REQUEST_TIMEOUT_MS',
  '10000',
);
export const TURBO_REQUEST_RETRY_COUNT = +env.varOrDefault(
  'TURBO_REQUEST_RETRY_COUNT',
  '3',
);

// Circuit breaker configuration for root TX index lookups
// Support both old and new environment variable names for backward compatibility
export const ROOT_TX_INDEX_CIRCUIT_BREAKER_FAILURE_THRESHOLD =
  +env.varOrDefault(
    'ROOT_TX_INDEX_CIRCUIT_BREAKER_FAILURE_THRESHOLD',
    env.varOrDefault('CIRCUIT_BREAKER_FAILURE_THRESHOLD', '5'),
  );
export const ROOT_TX_INDEX_CIRCUIT_BREAKER_TIMEOUT_MS = +env.varOrDefault(
  'ROOT_TX_INDEX_CIRCUIT_BREAKER_TIMEOUT_MS',
  env.varOrDefault('CIRCUIT_BREAKER_TIMEOUT_MS', '60000'), // 1 minute
);
export const ROOT_TX_INDEX_CIRCUIT_BREAKER_SUCCESS_THRESHOLD =
  +env.varOrDefault(
    'ROOT_TX_INDEX_CIRCUIT_BREAKER_SUCCESS_THRESHOLD',
    env.varOrDefault('CIRCUIT_BREAKER_SUCCESS_THRESHOLD', '2'),
  );

export const WEIGHTED_PEERS_TEMPERATURE_DELTA = +env.varOrDefault(
  'WEIGHTED_PEERS_TEMPERATURE_DELTA',
  '2',
);

export const GATEWAY_PEERS_WEIGHTS_CACHE_DURATION_MS = +env.varOrDefault(
  'GATEWAY_PEERS_WEIGHTS_CACHE_DURATION_MS',
  `${5 * 1000}`, // 5 seconds
);

// the size of the array from which the average performance is calculated
// this average is used to give a weight to the peers. Longer window means
// a better average is calculated, but it shouldn't matter too much.
export const GATEWAY_PEERS_REQUEST_WINDOW_COUNT = +env.varOrDefault(
  'GATEWAY_PEERS_REQUEST_WINDOW_COUNT',
  '20',
);

export const ARWEAVE_NODE_IGNORE_URLS: string[] =
  env.varOrUndefined('ARWEAVE_NODE_IGNORE_URLS')?.split(',') ?? [];

// Default preferred chunk POST nodes (tip-2 through tip-4.arweave.xyz)
const DEFAULT_PREFERRED_CHUNK_POST_NODE_URLS = [
  'http://tip-2.arweave.xyz:1984',
  'http://tip-3.arweave.xyz:1984',
  'http://tip-4.arweave.xyz:1984',
];

// Preferred chunk POST URLs (prioritized over discovered peers)
const PREFERRED_CHUNK_POST_NODE_URLS_STRING = env.varOrUndefined(
  'PREFERRED_CHUNK_POST_NODE_URLS',
);
export const PREFERRED_CHUNK_POST_NODE_URLS =
  PREFERRED_CHUNK_POST_NODE_URLS_STRING !== undefined
    ? PREFERRED_CHUNK_POST_NODE_URLS_STRING.split(',').map((url) => url.trim())
    : DEFAULT_PREFERRED_CHUNK_POST_NODE_URLS;

// Validate preferred chunk POST URLs
PREFERRED_CHUNK_POST_NODE_URLS.forEach((url) => {
  try {
    new URL(url);
  } catch (error) {
    throw new Error(`Invalid URL in PREFERRED_CHUNK_POST_NODE_URLS: ${url}`);
  }
});

// Maximum queue depth before skipping a peer for chunk POST
export const CHUNK_POST_QUEUE_DEPTH_THRESHOLD = +env.varOrDefault(
  'CHUNK_POST_QUEUE_DEPTH_THRESHOLD',
  '20',
);

// Minimum number of successful chunk POST responses required
export const CHUNK_POST_MIN_SUCCESS_COUNT = +env.varOrDefault(
  'CHUNK_POST_MIN_SUCCESS_COUNT',
  '3',
);

// Maximum number of peers to broadcast to in parallel
export const CHUNK_POST_PEER_CONCURRENCY = +env.varOrDefault(
  'CHUNK_POST_PEER_CONCURRENCY',
  String(CHUNK_POST_MIN_SUCCESS_COUNT),
);

// Maximum number of concurrent chunk posts per node
export const CHUNK_POST_PER_NODE_CONCURRENCY = +env.varOrDefault(
  'CHUNK_POST_PER_NODE_CONCURRENCY',
  String(CHUNK_POST_QUEUE_DEPTH_THRESHOLD),
);

// Maximum number of concurrent peer info requests during refresh
export const PEER_REFRESH_CONCURRENCY = +env.varOrDefault(
  'PEER_REFRESH_CONCURRENCY',
  '50',
);

// Initial weight for preferred chunk POST peers
export const PREFERRED_CHUNK_POST_WEIGHT = +env.varOrDefault(
  'PREFERRED_CHUNK_POST_WEIGHT',
  '100',
);

// Cache duration for sorted chunk POST peers
export const CHUNK_POST_SORTED_PEERS_CACHE_DURATION_MS = +env.varOrDefault(
  'CHUNK_POST_SORTED_PEERS_CACHE_DURATION_MS',
  '10000', // 10 seconds
);

// Chunk POST response timeout in milliseconds
const CHUNK_POST_RESPONSE_TIMEOUT_MS_STRING = env.varOrUndefined(
  'CHUNK_POST_RESPONSE_TIMEOUT_MS',
);
export const CHUNK_POST_RESPONSE_TIMEOUT_MS =
  CHUNK_POST_RESPONSE_TIMEOUT_MS_STRING !== undefined
    ? +CHUNK_POST_RESPONSE_TIMEOUT_MS_STRING
    : undefined;

// Chunk POST abort timeout in milliseconds
const CHUNK_POST_ABORT_TIMEOUT_MS_STRING = env.varOrUndefined(
  'CHUNK_POST_ABORT_TIMEOUT_MS',
);
export const CHUNK_POST_ABORT_TIMEOUT_MS =
  CHUNK_POST_ABORT_TIMEOUT_MS_STRING !== undefined
    ? +CHUNK_POST_ABORT_TIMEOUT_MS_STRING
    : undefined;

// Arweave network peer post success goal
// setting to 0 means this behaviour is disabled.
export const ARWEAVE_PEER_CHUNK_POST_MIN_SUCCESS_COUNT = +env.varOrDefault(
  'ARWEAVE_PEER_CHUNK_POST_MIN_SUCCESS_COUNT',
  '2',
);

// The maximum number of peers to attempt to POST to before giving up
export const ARWEAVE_PEER_CHUNK_POST_MAX_PEER_ATTEMPT_COUNT = +env.varOrDefault(
  'ARWEAVE_PEER_CHUNK_POST_MAX_PEER_ATTEMPT_COUNT',
  '5',
);

if (
  ARWEAVE_PEER_CHUNK_POST_MAX_PEER_ATTEMPT_COUNT <
  ARWEAVE_PEER_CHUNK_POST_MIN_SUCCESS_COUNT
) {
  throw new Error(
    'ARWEAVE_PEER_CHUNK_POST_MAX_ATTEMPT_PEER_COUNT must be greater than or equal to ARWEAVE_PEER_CHUNK_POST_MIN_SUCCESS_COUNT',
  );
}

// If ARWEAVE_PEER_CHUNK_POST_MIN_SUCCESS_COUNT is set non-zero, this
// value defines how many chunks to post to peers in parallel.
export const ARWEAVE_PEER_CHUNK_POST_CONCURRENCY_LIMIT = +env.varOrDefault(
  'ARWEAVE_PEER_CHUNK_POST_CONCURRENCY_LIMIT',
  '3',
);

//
// Data
//

// On-demand data retrieval priority order
// Available sources: 'ar-io-network', 'trusted-gateways', 'trusted-gateways-offset-aware', 'chunks', 'chunks-offset-aware', 'chunks-data-item', 'tx-data', 's3', 'turbo-s3', 'turbo-elasticache', 'turbo-dynamodb'
// - 'chunks': Standard chunk retrieval for transactions
// - 'chunks-offset-aware': Chunk retrieval with automatic data item resolution and offset-aware parent traversal
// - 'chunks-data-item': Deprecated alias for 'chunks-offset-aware' (kept for backwards compatibility)
// - 'trusted-gateways-offset-aware': Trusted gateways with upstream offset support (uses cached offsets, no searching)
// Legacy sources: 'ar-io-peers', 'ario-peer' (use 'ar-io-network' instead)
export const ON_DEMAND_RETRIEVAL_ORDER = env
  .varOrDefault(
    'ON_DEMAND_RETRIEVAL_ORDER',
    'trusted-gateways,ar-io-network,chunks-offset-aware,tx-data',
  )
  .split(',');

// Background data retrieval priority order
export const BACKGROUND_RETRIEVAL_ORDER = env
  .varOrDefault('BACKGROUND_RETRIEVAL_ORDER', 'chunks')
  .split(',');

// Cache type for contiguous metadata (access time, etc.). Defaults to 'node'
// here for development but is set to 'redis' in 'docker-compose.yaml'.
export const CONTIGUOUS_METADATA_CACHE_TYPE = env.varOrDefault(
  'CHUNK_METADATA_CACHE_TYPE',
  'node',
);

// Chunk data retrieval priority order (comma-separated list of sources)
// Available sources: 'ar-io-network', 'arweave-network', 'legacy-s3'
export const CHUNK_DATA_RETRIEVAL_ORDER = env
  .varOrDefault('CHUNK_DATA_RETRIEVAL_ORDER', 'ar-io-network,arweave-network')
  .split(',');

// Chunk metadata retrieval priority order (comma-separated list of sources)
// Available sources: 'ar-io-network', 'arweave-network', 'legacy-psql'
export const CHUNK_METADATA_RETRIEVAL_ORDER = env
  .varOrDefault(
    'CHUNK_METADATA_RETRIEVAL_ORDER',
    'ar-io-network,arweave-network',
  )
  .split(',');

// Parallelism configuration for composite chunk sources
export const CHUNK_DATA_SOURCE_PARALLELISM = +env.varOrDefault(
  'CHUNK_DATA_SOURCE_PARALLELISM',
  '1',
);

export const CHUNK_METADATA_SOURCE_PARALLELISM = +env.varOrDefault(
  'CHUNK_METADATA_SOURCE_PARALLELISM',
  '1',
);

//
// Indexing
//

// Whether or not to run indexing processes (used on readers when running with
// replication)
export const START_WRITERS =
  env.varOrDefault('START_WRITERS', 'true') === 'true';

// Indexing range
export const START_HEIGHT = +env.varOrDefault('START_HEIGHT', '0');
export const STOP_HEIGHT = +env.varOrDefault('STOP_HEIGHT', 'Infinity');

//
// Verification
//

// Whether or not to enable the background data verification worker
export const ENABLE_BACKGROUND_DATA_VERIFICATION =
  env.varOrDefault('ENABLE_BACKGROUND_DATA_VERIFICATION', 'true') === 'true';

// Whether to fallback to legacy root traversal when attributes are incomplete
export const ENABLE_LEGACY_ROOT_TRAVERSAL_FALLBACK =
  env.varOrDefault('ENABLE_LEGACY_ROOT_TRAVERSAL_FALLBACK', 'true') === 'true';

export const BACKGROUND_DATA_VERIFICATION_INTERVAL_SECONDS = +env.varOrDefault(
  'BACKGROUND_DATA_VERIFICATION_INTERVAL_SECONDS',
  '600', // 10 minutes
);

export const BACKGROUND_DATA_VERIFICATION_WORKER_COUNT = +env.varOrDefault(
  'BACKGROUND_DATA_VERIFICATION_WORKER_COUNT',
  '1',
);

export const BACKGROUND_DATA_VERIFICATION_STREAM_TIMEOUT_MS = +env.varOrDefault(
  'BACKGROUND_DATA_VERIFICATION_STREAM_TIMEOUT_MS',
  `${1000 * 30}`, // 30 seconds
);

export const MIN_DATA_VERIFICATION_PRIORITY = +env.varOrDefault(
  'MIN_DATA_VERIFICATION_PRIORITY',
  `${verificationPriorities.arns}`, // Verify all ArNS data (priority 60+) and preferred names (priority 80)
);

export const MAX_VERIFICATION_RETRIES = +env.varOrDefault(
  'MAX_VERIFICATION_RETRIES',
  '5', // Maximum number of verification retry attempts
);

// Filter determining which ANS-104 bundles to unbundle
export const ANS104_UNBUNDLE_FILTER_PARSED = JSON.parse(
  env.varOrDefault('ANS104_UNBUNDLE_FILTER', '{"never": true}'),
);
export const ANS104_UNBUNDLE_FILTER_STRING = canonicalize(
  ANS104_UNBUNDLE_FILTER_PARSED,
);
export const ANS104_UNBUNDLE_FILTER = createFilter(
  JSON.parse(ANS104_UNBUNDLE_FILTER_STRING),
  logger,
);

// Auto-enable data item indexing when verification is enabled
const getDefaultIndexFilter = () => {
  const explicitFilter = env.varOrUndefined('ANS104_INDEX_FILTER');
  // If filter is explicitly set, use it as-is
  if (explicitFilter !== undefined) {
    return explicitFilter;
  }
  // If verification is enabled, auto-enable data item indexing, otherwise disable it
  return ENABLE_BACKGROUND_DATA_VERIFICATION
    ? '{"always": true}'
    : '{"never": true}';
};

// Filter determining which ANS-104 data items to index
export const ANS104_INDEX_FILTER_PARSED = JSON.parse(getDefaultIndexFilter());
export const ANS104_INDEX_FILTER_STRING = canonicalize(
  ANS104_INDEX_FILTER_PARSED,
);
export const ANS104_INDEX_FILTER = createFilter(
  JSON.parse(ANS104_INDEX_FILTER_STRING),
  logger,
);

// Auto-enable workers when verification is enabled (even if unbundle filter is "never")
const getDefaultWorkerCount = (defaultCount: string) => {
  const isNeverMatch = ANS104_UNBUNDLE_FILTER.constructor.name === 'NeverMatch';

  // If verification is enabled, we need workers for verification-driven unbundling
  if (ENABLE_BACKGROUND_DATA_VERIFICATION) {
    return defaultCount;
  }

  // If verification is disabled and unbundle filter is "never", no workers needed
  if (isNeverMatch) {
    return '0';
  }

  return defaultCount;
};

// The number of ANS-104 worker threads to run
export const ANS104_UNBUNDLE_WORKERS = +env.varOrDefault(
  'ANS104_UNBUNDLE_WORKERS',
  getDefaultWorkerCount('1'),
);

// The number of ANS-104 bundle downloads to attempt in parallel
export const ANS104_DOWNLOAD_WORKERS = +env.varOrDefault(
  'ANS104_DOWNLOAD_WORKERS',
  getDefaultWorkerCount('5'),
);

// Whether or not to attempt to rematch old bundles using the current filter
export const FILTER_CHANGE_REPROCESS =
  env.varOrDefault('FILTER_CHANGE_REPROCESS', 'false') === 'true';

// Whether or not to backfill bundle records (only needed for DBs that existed
// before unbundling was implemented)
export const BACKFILL_BUNDLE_RECORDS =
  env.varOrDefault('BACKFILL_BUNDLE_RECORDS', 'false') === 'true';

// Whether or not to write the data item signatures to the database
export const WRITE_ANS104_DATA_ITEM_DB_SIGNATURES =
  env.varOrDefault('WRITE_ANS104_DATA_ITEM_DB_SIGNATURES', 'false') === 'true';

// Whether or not to write the transaction signatures to the database
export const WRITE_TRANSACTION_DB_SIGNATURES =
  env.varOrDefault('WRITE_TRANSACTION_DB_SIGNATURES', 'false') === 'true';

// Whether or not to enable the data database WAL cleanup worker
export const ENABLE_DATA_DB_WAL_CLEANUP =
  env.varOrDefault('ENABLE_DATA_DB_WAL_CLEANUP', 'false') === 'true';

// The maximum number of data items to queue for indexing before skipping
// indexing new data items
export const MAX_DATA_ITEM_QUEUE_SIZE = +env.varOrDefault(
  'MAX_DATA_ITEM_QUEUE_SIZE',
  '100000',
);

// The maximum number of bundles to queue for unbundling before skipping
export const BUNDLE_DATA_IMPORTER_QUEUE_SIZE = +env.varOrDefault(
  'BUNDLE_DATA_IMPORTER_QUEUE_SIZE',
  '1000',
);

// The maximum number of data imports to queue for verification purposes
export const VERIFICATION_DATA_IMPORTER_QUEUE_SIZE = +env.varOrDefault(
  'VERIFICATION_DATA_IMPORTER_QUEUE_SIZE',
  '1000',
);

// The maximum number of data items indexed to flush stable data items
export const DATA_ITEM_FLUSH_COUNT_THRESHOLD = +env.varOrDefault(
  'DATA_ITEM_FLUSH_COUNT_THRESHOLD',
  '1000',
);

// The interval in seconds to flush stable data items
export const MAX_FLUSH_INTERVAL_SECONDS = +env.varOrDefault(
  'MAX_FLUSH_INTERVAL_SECONDS',
  '600',
);

export const BUNDLE_REPAIR_RETRY_INTERVAL_SECONDS = +env.varOrDefault(
  'BUNDLE_REPAIR_RETRY_INTERVAL_SECONDS',
  '300', // 5 minutes
);

export const BUNDLE_REPAIR_UPDATE_TIMESTAMPS_INTERVAL_SECONDS =
  +env.varOrDefault(
    'BUNDLE_REPAIR_UPDATE_TIMESTAMPS_INTERVAL_SECONDS',
    '300', // 5 minutes
  );

export const BUNDLE_REPAIR_BACKFILL_INTERVAL_SECONDS = +env.varOrDefault(
  'BUNDLE_REPAIR_BACKFILL_INTERVAL_SECONDS',
  '900', // 15 minutes
);

export const BUNDLE_REPAIR_FILTER_REPROCESS_INTERVAL_SECONDS =
  +env.varOrDefault(
    'BUNDLE_REPAIR_FILTER_REPROCESS_INTERVAL_SECONDS',
    '300', // 15 minutes
  );

export const BUNDLE_REPAIR_RETRY_BATCH_SIZE = +env.varOrDefault(
  'BUNDLE_REPAIR_RETRY_BATCH_SIZE',
  '5000',
);

//
// PostgreSQL
//

// A URL format of: postgres://username:password@host:port/database
// the password can be omitted and passed in as filesystem path
export const LEGACY_PSQL_CONNECTION_STRING = env.varOrUndefined(
  'LEGACY_PSQL_CONNECTION_STRING',
);

// The path to the file containing the password for the PostgreSQL connection
// this enhances security by not exposing the password in the connection string.
// This is ar-io specific environment variable,
// note that postgres.js also respects built-in env-vars like PGHOST, PGPORT etc.
// see more: https://github.com/porsager/postgres?tab=readme-ov-file#environmental-variables
export const LEGACY_PSQL_PASSWORD_FILE = env.varOrUndefined(
  'LEGACY_PSQL_PASSWORD_FILE',
);

// very common workaround needed for various cloud providers
// see more: https://github.com/porsager/postgres?tab=readme-ov-file#ssl
export const LEGACY_PSQL_SSL_REJECT_UNAUTHORIZED =
  env.varOrDefault('LEGACY_PSQL_SSL_REJECT_UNAUTHORIZED', 'true') === 'true';

//
// File system cleanup
//

// The number of files to process in each batch during cleanup
export const FS_CLEANUP_WORKER_BATCH_SIZE = +env.varOrDefault(
  'FS_CLEANUP_WORKER_BATCH_SIZE',
  '2000',
);

// The pause duration between cleanup batches in milliseconds
export const FS_CLEANUP_WORKER_BATCH_PAUSE_DURATION = +env.varOrDefault(
  'FS_CLEANUP_WORKER_BATCH_PAUSE_DURATION',
  '5000',
);

// The pause duration before restarting cleanup from the beginning in milliseconds
export const FS_CLEANUP_WORKER_RESTART_PAUSE_DURATION = +env.varOrDefault(
  'FS_CLEANUP_WORKER_RESTART_PAUSE_DURATION',
  `${1000 * 60 * 60 * 4}`, // every 4 hours
);

//
// GraphQL
//

export const TAG_SELECTIVITY = JSON.parse(
  env.varOrDefault(
    'TAG_SELECTIVITY',
    JSON.stringify({
      'Parent-Folder-Id': 20,
      Message: 20,
      'Drive-Id': 10,
      Process: 10,
      Recipient: 10,
      'App-Name': -10,
      'Content-Type': -10,
      'Data-Protocol': -10,
    }),
  ),
) as Record<string, number>;

// ClickHouse
export const CLICKHOUSE_URL = env.varOrUndefined('CLICKHOUSE_URL');
export const CLICKHOUSE_USER = env.varOrUndefined('CLICKHOUSE_USER');
export const CLICKHOUSE_PASSWORD = env.varOrUndefined('CLICKHOUSE_PASSWORD');

//
// Healthchecks
//

export const MAX_EXPECTED_DATA_ITEM_INDEXING_INTERVAL_SECONDS_STRING =
  env.varOrUndefined('MAX_EXPECTED_DATA_ITEM_INDEXING_INTERVAL_SECONDS');

export const MAX_EXPECTED_DATA_ITEM_INDEXING_INTERVAL_SECONDS =
  MAX_EXPECTED_DATA_ITEM_INDEXING_INTERVAL_SECONDS_STRING !== undefined
    ? +MAX_EXPECTED_DATA_ITEM_INDEXING_INTERVAL_SECONDS_STRING
    : undefined;

//
// ArNS and sandboxing
//

// The root host name to use for ArNS
export const ARNS_ROOT_HOST = env.varOrUndefined('ARNS_ROOT_HOST');
export const ROOT_HOST_SUBDOMAIN_LENGTH =
  ARNS_ROOT_HOST !== undefined ? ARNS_ROOT_HOST.split('.').length - 2 : 0;

// The protocol to use for sandboxing redirects (defaults to https)
export const SANDBOX_PROTOCOL = env.varOrUndefined('SANDBOX_PROTOCOL');

//
// AR.IO network
//

// The wallet for this gateway
export const AR_IO_WALLET = env.varOrUndefined('AR_IO_WALLET');

export const IO_PROCESS_ID = env.varOrDefault(
  'IO_PROCESS_ID',
  'qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE',
);

export const AR_IO_NODE_RELEASE = env.varOrDefault(
  'AR_IO_NODE_RELEASE',
  release,
);

//
// Apex domain customization
//

export const APEX_TX_ID = env.varOrUndefined('APEX_TX_ID');

export const APEX_ARNS_NAME = env.varOrUndefined('APEX_ARNS_NAME');
if (APEX_TX_ID !== undefined && APEX_ARNS_NAME !== undefined) {
  throw new Error(
    'APEX_TX_ID and APEX_ARNS_NAME are mutually exclusive but both are set.',
  );
}
if (APEX_ARNS_NAME !== undefined && ARNS_ROOT_HOST === undefined) {
  throw new Error('ARNS_ROOT_HOST must be defined when APEX_ARNS_NAME is used');
}

//
// ArNS 404 customization
//

export const ARNS_NOT_FOUND_TX_ID = env.varOrUndefined('ARNS_NOT_FOUND_TX_ID');

export const ARNS_NOT_FOUND_ARNS_NAME = env.varOrDefault(
  'ARNS_NOT_FOUND_ARNS_NAME',
  'unregistered_arns',
);

//
// Header caching
//

// Cache type (lmdb, fs, or redis - defaults to redis in docker-compose.yaml)
export const CHAIN_CACHE_TYPE = env.varOrDefault('CHAIN_CACHE_TYPE', 'lmdb');

// Whether or not to cleanup filesystem header cache files
export const ENABLE_FS_HEADER_CACHE_CLEANUP =
  env.varOrDefault('ENABLE_FS_HEADER_CACHE_CLEANUP', 'false') === 'true';

//
// Chunk data caching
//

// Whether or not to cleanup filesystem chunk cache files
export const ENABLE_CHUNK_DATA_CACHE_CLEANUP =
  env.varOrDefault('ENABLE_CHUNK_DATA_CACHE_CLEANUP', 'true') === 'true';

// The threshold in seconds to cleanup the filesystem chunk data cache
export const CHUNK_DATA_CACHE_CLEANUP_THRESHOLD = +env.varOrDefault(
  'CHUNK_DATA_CACHE_CLEANUP_THRESHOLD',
  `${60 * 60 * 4}`, // 4 hours by default
);

//
// Contiguous data caching
//

// The threshold in seconds to cleanup the filesystem contiguous data cache
export const CONTIGUOUS_DATA_CACHE_CLEANUP_THRESHOLD = env.varOrDefault(
  'CONTIGUOUS_DATA_CACHE_CLEANUP_THRESHOLD',
  '',
);

// The threshold in seconds to cleanup data associated with prefered ArNS from
// the filesystem contiguous data cache
export const PREFERRED_ARNS_CONTIGUOUS_DATA_CACHE_CLEANUP_THRESHOLD =
  +env.varOrDefault(
    'PREFERRED_ARNS_CONTIGUOUS_DATA_CACHE_CLEANUP_THRESHOLD',
    `${60 * 60 * 24 * 30}`, // 30 days
  );

// The set of full (not base or undernames) ArNS names to preferentially cache
export const PREFERRED_ARNS_NAMES = new Set(
  env.varOrDefault('PREFERRED_ARNS_NAMES', '').split(','),
);

// The set of base ArNS names to preferentially cache
export const PREFERRED_ARNS_BASE_NAMES = new Set(
  env.varOrDefault('PREFERRED_ARNS_BASE_NAMES', '').split(','),
);

//
// Webhooks
//

// The webhook target servers
export const WEBHOOK_TARGET_SERVERS_VALUE = env.varOrUndefined(
  'WEBHOOK_TARGET_SERVERS',
);
export const WEBHOOK_TARGET_SERVERS =
  WEBHOOK_TARGET_SERVERS_VALUE !== undefined
    ? WEBHOOK_TARGET_SERVERS_VALUE.split(',')
    : [];

// The index filter to use for webhooks
export const WEBHOOK_INDEX_FILTER_STRING = canonicalize(
  JSON.parse(env.varOrDefault('WEBHOOK_INDEX_FILTER', '{"never": true}')),
);
export const WEBHOOK_INDEX_FILTER = createFilter(
  JSON.parse(WEBHOOK_INDEX_FILTER_STRING),
  logger,
);

// Block filter to use for webhooks
export const WEBHOOK_BLOCK_FILTER_STRING = canonicalize(
  JSON.parse(env.varOrDefault('WEBHOOK_BLOCK_FILTER', '{"never": true}')),
);
export const WEBHOOK_BLOCK_FILTER = createFilter(
  JSON.parse(WEBHOOK_BLOCK_FILTER_STRING),
  logger,
);

//
// ArNS Resolution
//

export const AR_IO_SDK_LOG_LEVEL = env.varOrDefault(
  'AR_IO_SDK_LOG_LEVEL',
  'none',
);

export const ARNS_CACHE_TYPE = env.varOrDefault('ARNS_CACHE_TYPE', 'node');

// Amount of time that entries stay in the cache (ArNS record TTL still applies
// on top of this)
export const ARNS_CACHE_TTL_SECONDS = +env.varOrDefault(
  'ARNS_CACHE_TTL_SECONDS',
  `${60 * 60 * 24}`, // 24 hours
);

// The maximum amount of time to wait for resolution from AO if there is a
// cached value that can be served. When the timeout occurs, caches will still
// be refreshed in the background.
export const ARNS_CACHED_RESOLUTION_FALLBACK_TIMEOUT_MS = +env.varOrDefault(
  'ARNS_CACHED_RESOLUTION_FALLBACK_TIMEOUT_MS',
  '250',
);

export const ARNS_RESOLVER_OVERRIDE_TTL_SECONDS_STRING = env.varOrUndefined(
  'ARNS_RESOLVER_OVERRIDE_TTL_SECONDS',
);

export const ARNS_RESOLVER_ENFORCE_UNDERNAME_LIMIT =
  env.varOrDefault('ARNS_RESOLVER_ENFORCE_UNDERNAME_LIMIT', 'true') === 'true';

export const ARNS_RESOLVER_OVERRIDE_TTL_SECONDS =
  ARNS_RESOLVER_OVERRIDE_TTL_SECONDS_STRING !== undefined
    ? +ARNS_RESOLVER_OVERRIDE_TTL_SECONDS_STRING
    : undefined;

export const ARNS_CACHE_MAX_KEYS = +env.varOrDefault(
  'ARNS_CACHE_MAX_KEYS',
  '10000',
);

export const ARNS_RESOLVER_PRIORITY_ORDER = env
  .varOrDefault('ARNS_RESOLVER_PRIORITY_ORDER', 'gateway,on-demand')
  .split(',');

export const ARNS_COMPOSITE_RESOLVER_TIMEOUT_MS = +env.varOrDefault(
  'ARNS_COMPOSITE_RESOLVER_TIMEOUT_MS',
  '3000',
);

export const ARNS_COMPOSITE_LAST_RESOLVER_TIMEOUT_MS = +env.varOrDefault(
  'ARNS_COMPOSITE_LAST_RESOLVER_TIMEOUT_MS',
  '30000',
);

export const ARNS_NAMES_CACHE_TTL_SECONDS = +env.varOrDefault(
  'ARNS_NAMES_CACHE_TTL_SECONDS',
  `${60 * 60}`, // 1 hour
);

export const ARNS_MAX_CONCURRENT_RESOLUTIONS = +env.varOrDefault(
  'ARNS_MAX_CONCURRENT_RESOLUTIONS',
  '1',
);

// Controls the maximum time allowed for requests to AO for ARIO process state.
// By default, requests should resolve in less than 3 seconds, but we set to 60
// seconds to account for the worst case scenario. If requests exceed this
// timeout, they will be considered failed and may trigger the circuit breaker
// if the error threshold is reached.
export const ARIO_PROCESS_DEFAULT_CIRCUIT_BREAKER_TIMEOUT_MS =
  +env.varOrDefault(
    'ARIO_PROCESS_DEFAULT_CIRCUIT_BREAKER_TIMEOUT_MS',
    `${60 * 1000}`, // 60 seconds
  );

// Controls the percentage of failed requests to AO for ARIO process state that
// will trigger the circuit breaker to open. This is set to a relatively low
// threshold (30%) to compensate for the extended timeout (10 seconds)
// configured above.
export const ARIO_PROCESS_DEFAULT_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE =
  +env.varOrDefault(
    'ARIO_PROCESS_DEFAULT_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE',
    '30', // 30% failure limit before circuit breaker opens
  );

// Defines the time window for tracking errors when retrieving ARIO process
// state from AO The circuit breaker counts failures within this rolling time
// window to determine if the error threshold percentage has been exceeded
export const ARIO_PROCESS_DEFAULT_CIRCUIT_BREAKER_ROLLING_COUNT_TIMEOUT_MS =
  +env.varOrDefault(
    'ARIO_PROCESS_DEFAULT_CIRCUIT_BREAKER_ROLLING_COUNT_TIMEOUT_MS',
    `${10 * 60 * 1000}`, // 10 minutes
  );

// Defines how long the circuit breaker stays in the open state after being
// triggered During this period, all requests to AO for ARIO process state will
// be rejected immediately After this timeout expires, the circuit breaker
// transitions to half-open state to test if AO is responsive again
export const ARIO_PROCESS_DEFAULT_CIRCUIT_BREAKER_RESET_TIMEOUT_MS =
  +env.varOrDefault(
    'ARIO_PROCESS_DEFAULT_CIRCUIT_BREAKER_RESET_TIMEOUT_MS',
    `${20 * 60 * 1000}`, // 20 minutes
  );

export const ARNS_NAME_LIST_CACHE_MISS_REFRESH_INTERVAL_SECONDS =
  +env.varOrDefault(
    'ARNS_NAME_LIST_CACHE_MISS_REFRESH_INTERVAL_SECONDS',
    `${2 * 60}`, // 2 minutes
  );

export const ARNS_NAME_LIST_CACHE_HIT_REFRESH_INTERVAL_SECONDS =
  +env.varOrDefault(
    'ARNS_NAME_LIST_CACHE_HIT_REFRESH_INTERVAL_SECONDS',
    `${60 * 60}`, // 1 hour
  );

export const ARNS_ANT_STATE_CACHE_HIT_REFRESH_WINDOW_SECONDS =
  +env.varOrDefault(
    'ARNS_ANT_STATE_CACHE_HIT_REFRESH_WINDOW_SECONDS',
    `${30}`, // 30 seconds
  );

// TODO: support multiple gateway urls
export const TRUSTED_ARNS_GATEWAY_URL = env.varOrDefault(
  'TRUSTED_ARNS_GATEWAY_URL',
  'https://__NAME__.ar-io.net',
);

//
// Mempool watcher
//

export const ENABLE_MEMPOOL_WATCHER =
  env.varOrDefault('ENABLE_MEMPOOL_WATCHER', 'false') === 'true';

//
// Datasets endpoint
//

export const ENABLE_DATASETS_ENDPOINT =
  env.varOrDefault('ENABLE_DATASETS_ENDPOINT', 'false') === 'true';

export const MEMPOOL_POLLING_INTERVAL_MS = +env.varOrDefault(
  'MEMPOOL_POLLING_INTERVAL_MS',
  '30000', // 30 seconds
);

//
// AWS settings
//

export const AWS_ACCESS_KEY_ID = env.varOrUndefined('AWS_ACCESS_KEY_ID');
export const AWS_SECRET_ACCESS_KEY = env.varOrUndefined(
  'AWS_SECRET_ACCESS_KEY',
);
// The session token is optional, but if it is set, it must be used
export const AWS_SESSION_TOKEN = env.varOrUndefined('AWS_SESSION_TOKEN');
export const AWS_REGION = env.varOrUndefined('AWS_REGION');
export const AWS_ENDPOINT = env.varOrUndefined('AWS_ENDPOINT');

export const AWS_S3_CONTIGUOUS_DATA_BUCKET = env.varOrUndefined(
  'AWS_S3_CONTIGUOUS_DATA_BUCKET',
);
export const AWS_S3_CONTIGUOUS_DATA_PREFIX = env.varOrUndefined(
  'AWS_S3_CONTIGUOUS_DATA_PREFIX',
);
export const AWS_S3_TURBO_CONTIGUOUS_DATA_BUCKET = env.varOrUndefined(
  'AWS_S3_TURBO_CONTIGUOUS_DATA_BUCKET',
);
export const AWS_S3_TURBO_CONTIGUOUS_DATA_PREFIX = env.varOrUndefined(
  'AWS_S3_TURBO_CONTIGUOUS_DATA_PREFIX',
);
export const AWS_ELASTICACHE_TURBO_HOST = env.varOrUndefined(
  'AWS_ELASTICACHE_TURBO_HOST',
);
export const AWS_ELASTICACHE_TURBO_USE_TLS =
  env.varOrDefault('AWS_ELASTICACHE_TURBO_USE_TLS', 'false') === 'true';

export const AWS_ELASTICACHE_TURBO_PORT = env.varOrUndefined(
  'AWS_ELASTICACHE_TURBO_PORT',
);

export const AWS_DYNAMODB_TURBO_REGION = env.varOrUndefined(
  'AWS_DYNAMODB_TURBO_REGION',
);

export const AWS_DYNAMODB_TURBO_ENDPOINT = env.varOrUndefined(
  'AWS_DYNAMODB_TURBO_ENDPOINT',
);

export const AWS_DYNAMODB_TURBO_ASSUME_ROLE_ARN = env.varOrUndefined(
  'AWS_DYNAMODB_TURBO_ASSUME_ROLE_ARN',
);

// Chunk data source specifically set-up for interoperability with
// the legacy arweave gateways
export const LEGACY_AWS_S3_CHUNK_DATA_BUCKET = env.varOrUndefined(
  'LEGACY_AWS_S3_CHUNK_DATA_BUCKET',
);

// Optional prefix for chunk data in the legacy S3 bucket, if omitted,
// the root of the bucket will be /{dataRoot}/{relativeOffset}
export const LEGACY_AWS_S3_CHUNK_DATA_PREFIX = env.varOrUndefined(
  'LEGACY_AWS_S3_CHUNK_DATA_PREFIX',
);

//
// Development and testing
//

// Whether or not to bypass the header cache
export const SKIP_CACHE = env.varOrDefault('SKIP_CACHE', 'false') === 'true';

// Whether or not to bypass the data cache (read-through data cache)
export const SKIP_DATA_CACHE =
  env.varOrDefault('SKIP_DATA_CACHE', 'false') === 'true';

// The rate (0 - 1) at which to simulate request failures
export const SIMULATED_REQUEST_FAILURE_RATE = +env.varOrDefault(
  'SIMULATED_REQUEST_FAILURE_RATE',
  '0',
);

// Circuit breaker timeout for getDataParentCircuitBreaker and getDataAttributesCircuitBreaker
export const GET_DATA_CIRCUIT_BREAKER_TIMEOUT_MS = +env.varOrDefault(
  'GET_DATA_CIRCUIT_BREAKER_TIMEOUT_MS',
  '500',
);

//
// AO
//

// TODO: move this
/**
 * Removes trailing slashes from URLs
 * @param url The URL to sanitize
 * @returns The sanitized URL without trailing slashes or undefined if input was undefined
 */
function sanitizeUrl(url: string | undefined): string | undefined {
  if (url === undefined) {
    return undefined;
  }
  return url.replace(/\/+$/, '');
}

export const AO_MU_URL = sanitizeUrl(env.varOrUndefined('AO_MU_URL'));
export const AO_CU_URL = sanitizeUrl(env.varOrUndefined('AO_CU_URL'));
export const NETWORK_AO_CU_URL = sanitizeUrl(
  env.varOrUndefined('NETWORK_AO_CU_URL') ?? AO_CU_URL,
);
export const ANT_AO_CU_URL = sanitizeUrl(
  env.varOrUndefined('ANT_AO_CU_URL') ?? AO_CU_URL,
);
export const AO_GRAPHQL_URL = env.varOrUndefined('AO_GRAPHQL_URL');
export const AO_GATEWAY_URL = env.varOrUndefined('AO_GATEWAY_URL');
export const AO_ANT_HYPERBEAM_URL = env.varOrUndefined('AO_ANT_HYPERBEAM_URL');
