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
// Nodes
//

// Trusted Arweave node URL (for syncing the chain and retrieving chunks)
export const TRUSTED_NODE_URL = env.varOrDefault(
  'TRUSTED_NODE_URL',
  'https://arweave.net',
);

// Trusted gateway URL (for retrieving contiguous data)
export const TRUSTED_GATEWAY_URL = env.varOrDefault(
  'TRUSTED_GATEWAY_URL',
  'https://arweave.net',
);

// Trusted gateway URLs (for retrieving contiguous data)
export const TRUSTED_GATEWAYS_URLS = JSON.parse(
  env.varOrDefault(
    'TRUSTED_GATEWAYS_URLS',
    JSON.stringify({
      [TRUSTED_GATEWAY_URL]: 1,
    }),
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

export const ARWEAVE_NODE_IGNORE_URLS: string[] =
  env.varOrUndefined('ARWEAVE_NODE_IGNORE_URLS')?.split(',') ?? [];

// Trusted chunk POST URLs (for posting chunks received at /chunk)
export const CHUNK_POST_URLS = env
  .varOrDefault('CHUNK_POST_URLS', `${TRUSTED_NODE_URL}/chunk`)
  .split(',');

export const CHUNK_POST_CONCURRENCY_LIMIT_STRING = env.varOrUndefined(
  'CHUNK_POST_CONCURRENCY_LIMIT',
);
export const CHUNK_POST_CONCURRENCY_LIMIT =
  CHUNK_POST_CONCURRENCY_LIMIT_STRING !== undefined
    ? +CHUNK_POST_CONCURRENCY_LIMIT_STRING
    : 2;

const SECONDARY_CHUNK_POST_URLS_STRING = env.varOrUndefined(
  'SECONDARY_CHUNK_POST_URLS',
);
export const SECONDARY_CHUNK_POST_URLS =
  SECONDARY_CHUNK_POST_URLS_STRING !== undefined
    ? SECONDARY_CHUNK_POST_URLS_STRING.split(',')
    : [];

const SECONDARY_CHUNK_POST_CONCURRENCY_LIMIT_STRING = env.varOrUndefined(
  'SECONDARY_CHUNK_POST_CONCURRENCY_LIMIT',
);
export const SECONDARY_CHUNK_POST_CONCURRENCY_LIMIT =
  SECONDARY_CHUNK_POST_CONCURRENCY_LIMIT_STRING !== undefined
    ? +SECONDARY_CHUNK_POST_CONCURRENCY_LIMIT_STRING
    : 2;

const SECONDARY_CHUNK_POST_MIN_SUCCESS_COUNT_STRING = env.varOrUndefined(
  'SECONDARY_CHUNK_POST_MIN_SUCCESS_COUNT',
);
export const SECONDARY_CHUNK_POST_MIN_SUCCESS_COUNT =
  SECONDARY_CHUNK_POST_MIN_SUCCESS_COUNT_STRING !== undefined
    ? +SECONDARY_CHUNK_POST_MIN_SUCCESS_COUNT_STRING
    : 1;

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

export const CHUNK_POST_MIN_SUCCESS_COUNT = +env.varOrDefault(
  'CHUNK_POST_MIN_SUCCESS_COUNT',
  '3',
);

//
// Data
//

// On-demand data retrieval priority order
export const ON_DEMAND_RETRIEVAL_ORDER = env
  .varOrDefault(
    'ON_DEMAND_RETRIEVAL_ORDER',
    's3,trusted-gateways,chunks,tx-data,ar-io-peers',
  )
  .split(',');

// Background data retrieval priority order
export const BACKGROUND_RETRIEVAL_ORDER = env
  .varOrDefault(
    'BACKGROUND_RETRIEVAL_ORDER',
    'chunks,s3,trusted-gateways,tx-data',
  )
  .split(',');

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

// Filter determining which ANS-104 bundles to unbundle
export const ANS104_UNBUNDLE_FILTER_PARSED = JSON.parse(
  env.varOrDefault('ANS104_UNBUNDLE_FILTER', '{"never": true}'),
);
export const ANS104_UNBUNDLE_FILTER_STRING = canonicalize(
  ANS104_UNBUNDLE_FILTER_PARSED,
);
export const ANS104_UNBUNDLE_FILTER = createFilter(
  JSON.parse(ANS104_UNBUNDLE_FILTER_STRING),
);

// Filter determining which ANS-104 data items to index
export const ANS104_INDEX_FILTER_PARSED = JSON.parse(
  env.varOrDefault('ANS104_INDEX_FILTER', '{"never": true}'),
);
export const ANS104_INDEX_FILTER_STRING = canonicalize(
  ANS104_INDEX_FILTER_PARSED,
);
export const ANS104_INDEX_FILTER = createFilter(
  JSON.parse(ANS104_INDEX_FILTER_STRING),
);

// The number of ANS-104 worker threads to run
export const ANS104_UNBUNDLE_WORKERS = +env.varOrDefault(
  'ANS104_UNBUNDLE_WORKERS',
  ANS104_UNBUNDLE_FILTER.constructor.name === 'NeverMatch' ? '0' : '1',
);

// The number of ANS-104 bundle downloads to attempt in parallel
export const ANS104_DOWNLOAD_WORKERS = +env.varOrDefault(
  'ANS104_DOWNLOAD_WORKERS',
  ANS104_UNBUNDLE_FILTER.constructor.name === 'NeverMatch' ? '0' : '5',
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

export const BUNDLE_REPAIR_RETRY_BATCH_SIZE = +env.varOrDefault(
  'BUNDLE_REPAIR_RETRY_BATCH_SIZE',
  '1000',
);

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
// Verification
//

// Whether or not to enable the background data verification worker
export const ENABLE_BACKGROUND_DATA_VERIFICATION =
  env.varOrDefault('ENABLE_BACKGROUND_DATA_VERIFICATION', 'false') === 'true';

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

// ClickHouse URL
export const CLICKHOUSE_URL = env.varOrUndefined('CLICKHOUSE_URL');

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
// Header caching
//

// Cache type (lmdb, fs, or redis)
export const CHAIN_CACHE_TYPE = env.varOrDefault('CHAIN_CACHE_TYPE', 'lmdb');

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

// Whether or not to cleanup filesystem header cache files
export const ENABLE_FS_HEADER_CACHE_CLEANUP =
  env.varOrDefault('ENABLE_FS_HEADER_CACHE_CLEANUP', 'false') === 'true';

// The threshold in seconds to cleanup the filesystem contiguous data cache
export const CONTIGUOUS_DATA_CACHE_CLEANUP_THRESHOLD = env.varOrDefault(
  'CONTIGUOUS_DATA_CACHE_CLEANUP_THRESHOLD',
  '',
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
);

// Block filter to use for webhooks
export const WEBHOOK_BLOCK_FILTER_STRING = canonicalize(
  JSON.parse(env.varOrDefault('WEBHOOK_BLOCK_FILTER', '{"never": true}')),
);
export const WEBHOOK_BLOCK_FILTER = createFilter(
  JSON.parse(WEBHOOK_BLOCK_FILTER_STRING),
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
  .varOrDefault('ARNS_RESOLVER_PRIORITY_ORDER', 'on-demand,gateway')
  .split(',');

export const ARNS_COMPOSITE_RESOLVER_TIMEOUT_MS = +env.varOrDefault(
  'ARNS_COMPOSITE_RESOLVER_TIMEOUT_MS',
  '3000',
);

export const ARNS_ON_DEMAND_CIRCUIT_BREAKER_TIMEOUT_MS = +env.varOrDefault(
  'ARNS_ON_DEMAND_CIRCUIT_BREAKER_TIMEOUT_MS',
  `${5 * 1000}`, // 5 seconds
);

export const ARNS_ON_DEMAND_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE =
  +env.varOrDefault(
    'ARNS_ON_DEMAND_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE',
    '50',
  );

export const ARNS_ON_DEMAND_CIRCUIT_BREAKER_ROLLING_COUNT_TIMEOUT_MS =
  +env.varOrDefault(
    'ARNS_ON_DEMAND_CIRCUIT_BREAKER_ROLLING_COUNT_TIMEOUT_MS',
    `${60 * 1000}`, // 1 minute
  );

export const ARNS_ON_DEMAND_CIRCUIT_BREAKER_RESET_TIMEOUT_MS =
  +env.varOrDefault(
    'ARNS_ON_DEMAND_CIRCUIT_BREAKER_RESET_TIMEOUT_MS',
    `${5 * 60 * 1000}`, // 5 minutes
  );

export const ARNS_NAMES_CACHE_TTL_SECONDS = +env.varOrDefault(
  'ARNS_NAMES_CACHE_TTL_SECONDS',
  `${60 * 60}`, // 1 hour
);

export const ARNS_NAME_LIST_CACHE_MISS_REFRESH_INTERVAL_SECONDS =
  +env.varOrDefault(
    'ARNS_NAME_LIST_CACHE_MISS_REFRESH_INTERVAL_SECONDS',
    `${10}`, // 10 seconds
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
  'https://__NAME__.arweave.net',
);

//
// Mempool watcher
//

export const ENABLE_MEMPOOL_WATCHER =
  env.varOrDefault('ENABLE_MEMPOOL_WATCHER', 'false') === 'true';

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
export const AWS_REGION = env.varOrUndefined('AWS_REGION');
export const AWS_ENDPOINT = env.varOrUndefined('AWS_ENDPOINT');

export const AWS_S3_CONTIGUOUS_DATA_BUCKET = env.varOrUndefined(
  'AWS_S3_CONTIGUOUS_DATA_BUCKET',
);
export const AWS_S3_CONTIGUOUS_DATA_PREFIX = env.varOrUndefined(
  'AWS_S3_CONTIGUOUS_DATA_PREFIX',
);

//
// Development and testing
//

// Whether or not to bypass the header cache
export const SKIP_CACHE = env.varOrDefault('SKIP_CACHE', 'false') === 'true';

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

export const AO_MU_URL = env.varOrUndefined('AO_MU_URL');
export const AO_CU_URL = env.varOrUndefined('AO_CU_URL');
export const AO_GRAPHQL_URL = env.varOrUndefined('AO_GRAPHQL_URL');
export const AO_GATEWAY_URL = env.varOrUndefined('AO_GATEWAY_URL');
