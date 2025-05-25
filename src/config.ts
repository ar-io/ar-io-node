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
import { canonicalize } from 'json-canonicalize';
import { isMainThread } from 'node:worker_threads';
import { existsSync, readFileSync } from 'node:fs';

import { createFilter } from './filters.js';
import * as env from './lib/env.js';
import { release } from './version.js';
import logger from './log.js';

//
// HTTP server
//

// HTTP server port
export const PORT = env.intVar('PORT', 4000);

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

export const REDIS_USE_TLS = env.boolVar('REDIS_USE_TLS', false);

// Default Redis TTL
export const REDIS_CACHE_TTL_SECONDS = env.intVar(
  'REDIS_CACHE_TTL_SECONDS',
  60 * 60 * 8,
);

//
// Nodes
//

// Trusted Arweave node URL (for syncing the chain and retrieving chunks)
export const TRUSTED_NODE_URL = env.varOrDefault(
  'TRUSTED_NODE_URL',
  'https://ar-io.net',
);

// Trusted gateway URL (for retrieving contiguous data)
export const TRUSTED_GATEWAY_URL = env.varOrUndefined('TRUSTED_GATEWAY_URL');

// Trusted gateway URLs (for retrieving contiguous data)
export const TRUSTED_GATEWAYS_URLS = JSON.parse(
  env.varOrDefault(
    'TRUSTED_GATEWAYS_URLS',
    TRUSTED_GATEWAY_URL !== undefined
      ? JSON.stringify({ [TRUSTED_GATEWAY_URL]: 1 })
      : '{ "https://arweave.net": 1, "https://ar-io.net": 2}',
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

export const TRUSTED_GATEWAYS_REQUEST_TIMEOUT_MS = +env.varOrDefault(
  'TRUSTED_GATEWAYS_REQUEST_TIMEOUT_MS',
  '10000',
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
export const GATEWAY_PEERS_REQUEST_WINDOW_COUNT = env.intVar(
  'GATEWAY_PEERS_REQUEST_WINDOW_COUNT',
  20,
);

export const ARWEAVE_NODE_IGNORE_URLS: string[] = env.optionalListVar(
  'ARWEAVE_NODE_IGNORE_URLS',
);

// Trusted chunk POST URLs (for posting chunks received at /chunk)
export const CHUNK_POST_URLS = env.listVar(
  'CHUNK_POST_URLS',
  `${TRUSTED_NODE_URL}/chunk`,
);

export const CHUNK_POST_CONCURRENCY_LIMIT = env.intVar(
  'CHUNK_POST_CONCURRENCY_LIMIT',
  2,
);

export const SECONDARY_CHUNK_POST_URLS = env.optionalListVar(
  'SECONDARY_CHUNK_POST_URLS',
);

export const SECONDARY_CHUNK_POST_CONCURRENCY_LIMIT = env.intVar(
  'SECONDARY_CHUNK_POST_CONCURRENCY_LIMIT',
  2,
);

export const SECONDARY_CHUNK_POST_MIN_SUCCESS_COUNT = env.intVar(
  'SECONDARY_CHUNK_POST_MIN_SUCCESS_COUNT',
  1,
);

// Chunk POST response timeout in milliseconds
export const CHUNK_POST_RESPONSE_TIMEOUT_MS = env.optionalIntVar(
  'CHUNK_POST_RESPONSE_TIMEOUT_MS',
);

// Chunk POST abort timeout in milliseconds
export const CHUNK_POST_ABORT_TIMEOUT_MS = env.optionalIntVar(
  'CHUNK_POST_ABORT_TIMEOUT_MS',
);

export const CHUNK_POST_MIN_SUCCESS_COUNT = env.intVar(
  'CHUNK_POST_MIN_SUCCESS_COUNT',
  3,
);

// Arweave network peer post success goal
// setting to 0 means this behaviour is disabled.
export const ARWEAVE_PEER_CHUNK_POST_MIN_SUCCESS_COUNT = env.intVar(
  'ARWEAVE_PEER_CHUNK_POST_MIN_SUCCESS_COUNT',
  2,
);

// The maximum number of peers to attempt to POST to before giving up
export const ARWEAVE_PEER_CHUNK_POST_MAX_PEER_ATTEMPT_COUNT = env.intVar(
  'ARWEAVE_PEER_CHUNK_POST_MAX_PEER_ATTEMPT_COUNT',
  5,
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
export const ON_DEMAND_RETRIEVAL_ORDER = env.listVar(
  'ON_DEMAND_RETRIEVAL_ORDER',
  's3,trusted-gateways,chunks,tx-data',
);

// Background data retrieval priority order
export const BACKGROUND_RETRIEVAL_ORDER = env.listVar(
  'BACKGROUND_RETRIEVAL_ORDER',
  'chunks,s3,trusted-gateways,tx-data',
);

// Cache type for contigous metadata (access time, etc.). Defaults to 'node'
// here for development but is set to 'redis' in 'docker-compose.yaml'.
export const CONTIGUOUS_METADATA_CACHE_TYPE = env.varOrDefault(
  'CHUNK_METADATA_CACHE_TYPE',
  'node',
);

// By default it looks for chunk from the filesystem's dataDir
// but it can be configured to use an s3 bucket that assumes a
// specific kind of layout of /{dataRoot}/{relativeOffset}
export const CHUNK_DATA_SOURCE_TYPE = env.varOrDefault(
  'CHUNK_DATA_SOURCE_TYPE',
  'fs',
) as 'fs' | 'legacy-s3';

// By default is uses FsChunkMetadataStore marked here as 'fs'
// but it can be configured to use a "legacy" PostgreSQL database
// that has a specific table "chunks" with specific columns. This
// is designed for legacy arweave gateway support.
export const CHUNK_METADATA_SOURCE_TYPE = env.varOrDefault(
  'CHUNK_METADATA_SOURCE_TYPE',
  'fs',
) as 'fs' | 'legacy-psql';

//
// Indexing
//

// Whether or not to run indexing processes (used on readers when running with
// replication)
export const START_WRITERS = env.boolVar('START_WRITERS', true);

// Indexing range
export const START_HEIGHT = env.intVar('START_HEIGHT', 0);
export const STOP_HEIGHT = +env.varOrDefault('STOP_HEIGHT', 'Infinity');

// Filter determining which ANS-104 bundles to unbundle
export const ANS104_UNBUNDLE_FILTER_PARSED = env.jsonVar(
  'ANS104_UNBUNDLE_FILTER',
  { never: true },
);
export const ANS104_UNBUNDLE_FILTER_STRING = canonicalize(
  ANS104_UNBUNDLE_FILTER_PARSED,
);
export const ANS104_UNBUNDLE_FILTER = createFilter(
  JSON.parse(ANS104_UNBUNDLE_FILTER_STRING),
  logger,
);

// Filter determining which ANS-104 data items to index
export const ANS104_INDEX_FILTER_PARSED = env.jsonVar('ANS104_INDEX_FILTER', {
  never: true,
});
export const ANS104_INDEX_FILTER_STRING = canonicalize(
  ANS104_INDEX_FILTER_PARSED,
);
export const ANS104_INDEX_FILTER = createFilter(
  JSON.parse(ANS104_INDEX_FILTER_STRING),
  logger,
);

// The number of ANS-104 worker threads to run
export const ANS104_UNBUNDLE_WORKERS = env.intVar(
  'ANS104_UNBUNDLE_WORKERS',
  ANS104_UNBUNDLE_FILTER.constructor.name === 'NeverMatch' ? 0 : 1,
);

// The number of ANS-104 bundle downloads to attempt in parallel
export const ANS104_DOWNLOAD_WORKERS = env.intVar(
  'ANS104_DOWNLOAD_WORKERS',
  ANS104_UNBUNDLE_FILTER.constructor.name === 'NeverMatch' ? 0 : 5,
);

// Whether or not to attempt to rematch old bundles using the current filter
export const FILTER_CHANGE_REPROCESS = env.boolVar(
  'FILTER_CHANGE_REPROCESS',
  false,
);

// Whether or not to backfill bundle records (only needed for DBs that existed
// before unbundling was implemented)
export const BACKFILL_BUNDLE_RECORDS = env.boolVar(
  'BACKFILL_BUNDLE_RECORDS',
  false,
);

// Whether or not to write the data item signatures to the database
export const WRITE_ANS104_DATA_ITEM_DB_SIGNATURES = env.boolVar(
  'WRITE_ANS104_DATA_ITEM_DB_SIGNATURES',
  false,
);

// Whether or not to write the transaction signatures to the database
export const WRITE_TRANSACTION_DB_SIGNATURES = env.boolVar(
  'WRITE_TRANSACTION_DB_SIGNATURES',
  false,
);

// Whether or not to enable the data database WAL cleanup worker
export const ENABLE_DATA_DB_WAL_CLEANUP = env.boolVar(
  'ENABLE_DATA_DB_WAL_CLEANUP',
  false,
);

// The maximum number of data items to queue for indexing before skipping
// indexing new data items
export const MAX_DATA_ITEM_QUEUE_SIZE = env.intVar(
  'MAX_DATA_ITEM_QUEUE_SIZE',
  100000,
);

// The maximum number of bundles to queue for unbundling before skipping
export const BUNDLE_DATA_IMPORTER_QUEUE_SIZE = env.intVar(
  'BUNDLE_DATA_IMPORTER_QUEUE_SIZE',
  1000,
);

// The maximum number of data imports to queue for verification purposes
export const VERIFICATION_DATA_IMPORTER_QUEUE_SIZE = env.intVar(
  'VERIFICATION_DATA_IMPORTER_QUEUE_SIZE',
  1000,
);

// The maximum number of data items indexed to flush stable data items
export const DATA_ITEM_FLUSH_COUNT_THRESHOLD = env.intVar(
  'DATA_ITEM_FLUSH_COUNT_THRESHOLD',
  1000,
);

// The interval in seconds to flush stable data items
export const MAX_FLUSH_INTERVAL_SECONDS = env.intVar(
  'MAX_FLUSH_INTERVAL_SECONDS',
  600,
);

export const BUNDLE_REPAIR_RETRY_INTERVAL_SECONDS = env.intVar(
  'BUNDLE_REPAIR_RETRY_INTERVAL_SECONDS',
  300,
); // 5 minutes

export const BUNDLE_REPAIR_UPDATE_TIMESTAMPS_INTERVAL_SECONDS = env.intVar(
  'BUNDLE_REPAIR_UPDATE_TIMESTAMPS_INTERVAL_SECONDS',
  300,
);

export const BUNDLE_REPAIR_BACKFILL_INTERVAL_SECONDS = env.intVar(
  'BUNDLE_REPAIR_BACKFILL_INTERVAL_SECONDS',
  900,
); // 15 minutes

export const BUNDLE_REPAIR_FILTER_REPROCESS_INTERVAL_SECONDS = env.intVar(
  'BUNDLE_REPAIR_FILTER_REPROCESS_INTERVAL_SECONDS',
  300,
);

export const BUNDLE_REPAIR_RETRY_BATCH_SIZE = env.intVar(
  'BUNDLE_REPAIR_RETRY_BATCH_SIZE',
  5000,
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
export const LEGACY_PSQL_SSL_REJECT_UNAUTHORIZED = env.boolVar(
  'LEGACY_PSQL_SSL_REJECT_UNAUTHORIZED',
  true,
);

//
// File system cleanup
//

// The number of files to process in each batch during cleanup
export const FS_CLEANUP_WORKER_BATCH_SIZE = env.intVar(
  'FS_CLEANUP_WORKER_BATCH_SIZE',
  2000,
);

// The pause duration between cleanup batches in milliseconds
export const FS_CLEANUP_WORKER_BATCH_PAUSE_DURATION = env.intVar(
  'FS_CLEANUP_WORKER_BATCH_PAUSE_DURATION',
  5000,
);

// The pause duration before restarting cleanup from the beginning in milliseconds
export const FS_CLEANUP_WORKER_RESTART_PAUSE_DURATION = env.intVar(
  'FS_CLEANUP_WORKER_RESTART_PAUSE_DURATION',
  1000 * 60 * 60 * 4,
); // every 4 hours

//
// Verification
//

// Whether or not to enable the background data verification worker
export const ENABLE_BACKGROUND_DATA_VERIFICATION = env.boolVar(
  'ENABLE_BACKGROUND_DATA_VERIFICATION',
  false,
);

export const BACKGROUND_DATA_VERIFICATION_INTERVAL_SECONDS = env.intVar(
  'BACKGROUND_DATA_VERIFICATION_INTERVAL_SECONDS',
  600,
); // 10 minutes

export const BACKGROUND_DATA_VERIFICATION_WORKER_COUNT = env.intVar(
  'BACKGROUND_DATA_VERIFICATION_WORKER_COUNT',
  1,
);

export const BACKGROUND_DATA_VERIFICATION_STREAM_TIMEOUT_MS = env.intVar(
  'BACKGROUND_DATA_VERIFICATION_STREAM_TIMEOUT_MS',
  1000 * 30,
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

export const MAX_EXPECTED_DATA_ITEM_INDEXING_INTERVAL_SECONDS =
  env.optionalIntVar('MAX_EXPECTED_DATA_ITEM_INDEXING_INTERVAL_SECONDS');

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
export const ENABLE_FS_HEADER_CACHE_CLEANUP = env.boolVar(
  'ENABLE_FS_HEADER_CACHE_CLEANUP',
  false,
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
  env.listVar('PREFERRED_ARNS_NAMES', ''),
);

// The set of base ArNS names to preferentially cache
export const PREFERRED_ARNS_BASE_NAMES = new Set(
  env.listVar('PREFERRED_ARNS_BASE_NAMES', ''),
);

//
// Webhooks
//

// The webhook target servers
export const WEBHOOK_TARGET_SERVERS = env.optionalListVar(
  'WEBHOOK_TARGET_SERVERS',
);

// The index filter to use for webhooks
export const WEBHOOK_INDEX_FILTER_STRING = canonicalize(
  env.jsonVar('WEBHOOK_INDEX_FILTER', { never: true }),
);
export const WEBHOOK_INDEX_FILTER = createFilter(
  JSON.parse(WEBHOOK_INDEX_FILTER_STRING),
  logger,
);

// Block filter to use for webhooks
export const WEBHOOK_BLOCK_FILTER_STRING = canonicalize(
  env.jsonVar('WEBHOOK_BLOCK_FILTER', { never: true }),
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
export const ARNS_CACHE_TTL_SECONDS = env.intVar(
  'ARNS_CACHE_TTL_SECONDS',
  60 * 60 * 24,
);

// The maximum amount of time to wait for resolution from AO if there is a
// cached value that can be served. When the timeout occurs, caches will still
// be refreshed in the background.
export const ARNS_CACHED_RESOLUTION_FALLBACK_TIMEOUT_MS = env.intVar(
  'ARNS_CACHED_RESOLUTION_FALLBACK_TIMEOUT_MS',
  250,
);

export const ARNS_RESOLVER_OVERRIDE_TTL_SECONDS = env.optionalIntVar(
  'ARNS_RESOLVER_OVERRIDE_TTL_SECONDS',
);
export const ARNS_RESOLVER_ENFORCE_UNDERNAME_LIMIT = env.boolVar(
  'ARNS_RESOLVER_ENFORCE_UNDERNAME_LIMIT',
  true,
);

export const ARNS_CACHE_MAX_KEYS = env.intVar('ARNS_CACHE_MAX_KEYS', 10000);

export const ARNS_RESOLVER_PRIORITY_ORDER = env.listVar(
  'ARNS_RESOLVER_PRIORITY_ORDER',
  'gateway,on-demand',
);

export const ARNS_COMPOSITE_RESOLVER_TIMEOUT_MS = env.intVar(
  'ARNS_COMPOSITE_RESOLVER_TIMEOUT_MS',
  3000,
);

export const ARNS_COMPOSITE_LAST_RESOLVER_TIMEOUT_MS = env.intVar(
  'ARNS_COMPOSITE_LAST_RESOLVER_TIMEOUT_MS',
  30000,
);

export const ARNS_NAMES_CACHE_TTL_SECONDS = env.intVar(
  'ARNS_NAMES_CACHE_TTL_SECONDS',
  60 * 60,
);

export const ARNS_MAX_CONCURRENT_RESOLUTIONS = env.intVar(
  'ARNS_MAX_CONCURRENT_RESOLUTIONS',
  1,
);

// Controls the maximum time allowed for requests to AO for ARIO process state.
// By default, requests should resolve in less than 3 seconds, but we set to 60
// seconds to account for the worst case scenario. If requests exceed this
// timeout, they will be considered failed and may trigger the circuit breaker
// if the error threshold is reached.
export const ARIO_PROCESS_DEFAULT_CIRCUIT_BREAKER_TIMEOUT_MS = env.intVar(
  'ARIO_PROCESS_DEFAULT_CIRCUIT_BREAKER_TIMEOUT_MS',
  60 * 1000,
);

// Controls the percentage of failed requests to AO for ARIO process state that
// will trigger the circuit breaker to open. This is set to a relatively low
// threshold (30%) to compensate for the extended timeout (10 seconds)
// configured above.
export const ARIO_PROCESS_DEFAULT_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE =
  env.intVar(
    'ARIO_PROCESS_DEFAULT_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE',
    30,
  );

// Defines the time window for tracking errors when retrieving ARIO process
// state from AO The circuit breaker counts failures within this rolling time
// window to determine if the error threshold percentage has been exceeded
export const ARIO_PROCESS_DEFAULT_CIRCUIT_BREAKER_ROLLING_COUNT_TIMEOUT_MS =
  env.intVar(
    'ARIO_PROCESS_DEFAULT_CIRCUIT_BREAKER_ROLLING_COUNT_TIMEOUT_MS',
    10 * 60 * 1000,
  );

// Defines how long the circuit breaker stays in the open state after being
// triggered During this period, all requests to AO for ARIO process state will
// be rejected immediately After this timeout expires, the circuit breaker
// transitions to half-open state to test if AO is responsive again
export const ARIO_PROCESS_DEFAULT_CIRCUIT_BREAKER_RESET_TIMEOUT_MS = env.intVar(
  'ARIO_PROCESS_DEFAULT_CIRCUIT_BREAKER_RESET_TIMEOUT_MS',
  20 * 60 * 1000,
);

export const ARNS_NAME_LIST_CACHE_MISS_REFRESH_INTERVAL_SECONDS = env.intVar(
  'ARNS_NAME_LIST_CACHE_MISS_REFRESH_INTERVAL_SECONDS',
  2 * 60,
);

export const ARNS_NAME_LIST_CACHE_HIT_REFRESH_INTERVAL_SECONDS = env.intVar(
  'ARNS_NAME_LIST_CACHE_HIT_REFRESH_INTERVAL_SECONDS',
  60 * 60,
);

export const ARNS_ANT_STATE_CACHE_HIT_REFRESH_WINDOW_SECONDS = env.intVar(
  'ARNS_ANT_STATE_CACHE_HIT_REFRESH_WINDOW_SECONDS',
  30,
);

// TODO: support multiple gateway urls
export const TRUSTED_ARNS_GATEWAY_URL = env.varOrDefault(
  'TRUSTED_ARNS_GATEWAY_URL',
  'https://__NAME__.ar-io.net',
);

//
// Mempool watcher
//

export const ENABLE_MEMPOOL_WATCHER = env.boolVar(
  'ENABLE_MEMPOOL_WATCHER',
  false,
);

export const MEMPOOL_POLLING_INTERVAL_MS = env.intVar(
  'MEMPOOL_POLLING_INTERVAL_MS',
  30000,
); // 30 seconds

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

// Chunk data source speficially set-up for interoperability with
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
export const SKIP_CACHE = env.boolVar('SKIP_CACHE', false);

// The rate (0 - 1) at which to simulate request failures
export const SIMULATED_REQUEST_FAILURE_RATE = env.intVar(
  'SIMULATED_REQUEST_FAILURE_RATE',
  0,
);

// Circuit breaker timeout for getDataParentCircuitBreaker and getDataAttributesCircuitBreaker
export const GET_DATA_CIRCUIT_BREAKER_TIMEOUT_MS = env.intVar(
  'GET_DATA_CIRCUIT_BREAKER_TIMEOUT_MS',
  500,
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
export const AO_MU_URL = env.urlVar('AO_MU_URL');
export const AO_CU_URL = env.urlVar('AO_CU_URL');
export const NETWORK_AO_CU_URL = env.urlVar('NETWORK_AO_CU_URL') ?? AO_CU_URL;
export const ANT_AO_CU_URL = env.urlVar('ANT_AO_CU_URL') ?? AO_CU_URL;
export const AO_GRAPHQL_URL = env.varOrUndefined('AO_GRAPHQL_URL');
export const AO_GATEWAY_URL = env.varOrUndefined('AO_GATEWAY_URL');
