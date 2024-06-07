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
import dotenv from 'dotenv';
import { canonicalize } from 'json-canonicalize';
import crypto from 'node:crypto';
import { isMainThread } from 'node:worker_threads';

import { createFilter } from './filters.js';
import * as env from './lib/env.js';
import log from './log.js';

dotenv.config();

//
// HTTP server
//

// HTTP server port
export const PORT = +env.varOrDefault('PORT', '4000');

// API key for accessing admin HTTP entpoints
// It's set once in the main thread
let ADMIN_API_KEY;
if (isMainThread) {
  ADMIN_API_KEY = env.varOrDefault(
    'ADMIN_API_KEY',
    crypto.randomBytes(32).toString('base64url'),
  );
  if (env.varOrUndefined('ADMIN_API_KEY') === undefined) {
    log.info('Using a random admin key since none was set', { ADMIN_API_KEY });
  }
}
export { ADMIN_API_KEY };

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

//
// Data
//

// Data retrieval priority order
export const ON_DEMAND_RETRIEVAL_ORDER = env
  .varOrDefault(
    'ON_DEMAND_RETRIEVAL_ORDER',
    's3,trusted-gateway,chunks,tx-data',
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
export const ANS104_UNBUNDLE_FILTER_STRING = canonicalize(
  JSON.parse(env.varOrDefault('ANS104_UNBUNDLE_FILTER', '{"never": true}')),
);
export const ANS104_UNBUNDLE_FILTER = createFilter(
  JSON.parse(ANS104_UNBUNDLE_FILTER_STRING),
);

// Filter determining which ANS-104 data items to index
export const ANS104_INDEX_FILTER_STRING = canonicalize(
  JSON.parse(env.varOrDefault('ANS104_INDEX_FILTER', '{"never": true}')),
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

export const CONTRACT_ID = env.varOrDefault(
  'CONTRACT_ID',
  'bLAgYxAdX2Ry-nt6aH2ixgvJXbpsEYm28NgJgyqfs-U',
);

export const IO_PROCESS_ID = env.varOrDefault(
  'IO_PROCESS_ID',
  'GaQrvEMKBpkjofgnBi_B3IgIDmY_XYelVLB6GcRGrHc',
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

export const TRUSTED_ARNS_GATEWAY_URL = env.varOrDefault(
  'TRUSTED_ARNS_GATEWAY_URL',
  'https://__NAME__.arweave.dev',
);

export const TRUSTED_ARNS_RESOLVER_TYPE = env.varOrDefault(
  'TRUSTED_ARNS_RESOLVER_TYPE',
  'gateway',
);

export const TRUSTED_ARNS_RESOLVER_URL = env.varOrDefault(
  'TRUSTED_ARNS_RESOLVER_URL',
  TRUSTED_ARNS_GATEWAY_URL,
);

//
// Mempool watcher
//
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
//
export const AWS_ACCESS_KEY_ID = env.varOrUndefined('AWS_ACCESS_KEY_ID');
export const AWS_SECRET_ACCESS_KEY = env.varOrUndefined(
  'AWS_SECRET_ACCESS_KEY',
);
export const AWS_REGION = env.varOrUndefined('AWS_REGION');
export const AWS_ENDPOINT = env.varOrUndefined('AWS_ENDPOINT');
export const AWS_S3_BUCKET = env.varOrUndefined('AWS_S3_BUCKET');
export const AWS_S3_PREFIX = env.varOrUndefined('AWS_S3_PREFIX');

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
