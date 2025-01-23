# Environment Variables

A list of environment variables that are used by the ar.io node and its
components. These can be found in the [`src/config.ts`][src/config.ts] file.

## Server Configuration

| Variable                      | Description                                | Default      |
| ----------------------------- | ------------------------------------------ | ------------ |
| PORT                          | HTTP server port                           | 4000         |
| ADMIN_API_KEY                 | API key for accessing admin HTTP endpoints | Random value |
| ADMIN_API_KEY_FILE            | File containing admin API key              | -            |
| HEALTHCHECK_INTERVAL_SECONDS  | Interval for healthcheck                   | 60           |
| HEALTHCHECK_TIMEOUT_SECONDS   | Timeout for healthcheck                    | 10           |
| HEALTHCHECK_FAILURE_THRESHOLD | Failure threshold for healthcheck          | 3            |
| HEALTHCHECK_SUCCESS_THRESHOLD | Success threshold for healthcheck          | 2            |

## AWS Configuration

| Variable                      | Description                   | Default |
| ----------------------------- | ----------------------------- | ------- |
| AWS_ACCESS_KEY_ID             | AWS access key ID             | -       |
| AWS_SECRET_ACCESS_KEY         | AWS secret access key         | -       |
| AWS_REGION                    | AWS region                    | -       |
| AWS_ENDPOINT                  | AWS endpoint URL              | -       |
| AWS_S3_CONTIGUOUS_DATA_BUCKET | S3 bucket for contiguous data | -       |
| AWS_S3_CONTIGUOUS_DATA_PREFIX | S3 prefix for contiguous data | -       |

## AR.IO Network

| Variable           | Description        | Default |
| ------------------ | ------------------ | ------- |
| AR_IO_WALLET       | AR.IO wallet       | -       |
| IO_PROCESS_ID      | AR.IO process ID   | -       |
| AR_IO_NODE_RELEASE | AR.IO node release | -       |

## AO Configuration

| Variable       | Description             | Default |
| -------------- | ----------------------- | ------- |
| AO_MU_URL      | AO Memory Unit URL      | -       |
| AO_CU_URL      | AO Compute Unit URL     | -       |
| AO_GRAPHQL_URL | AO GraphQL endpoint URL | -       |
| AO_GATEWAY_URL | AO Gateway URL          | -       |

## ARNS Configuration

| Variable                                                  | Description                                            | Default           |
| --------------------------------------------------------- | ------------------------------------------------------ | ----------------- |
| ARNS_ROOT_HOST                                            | Root host for ARNS                                     | -                 |
| ARNS_CACHE_TYPE                                           | Cache type for ARNS resolution data                    | lmdb              |
| ARNS_CACHE_MAX_KEYS                                       | Maximum number of keys to store in cache               | 10000             |
| ARNS_CACHE_TTL_SECONDS                                    | TTL for resolved data in cache                         | 3600              |
| ARNS_NAMES_CACHE_TTL_SECONDS                              | TTL for base names in cache                            | 300               |
| ARNS_NAME_LIST_CACHE_MISS_REFRESH_INTERVAL_SECONDS        | Refresh interval of base ArNS name cache on cache miss | 10                |
| ARNS_NAME_LIST_CACHE_HIT_REFRESH_INTERVAL_SECONDS         | Refresh interval of base ArNS name cache on cache hit  | 3600              |
| ARNS_RESOLVER_OVERRIDE_TTL_SECONDS                        | Override ANT record TTL                                | 0                 |
| ARNS_RESOLVER_PRIORITY_ORDER                              | Resolution priority order                              | on-demand,gateway |
| TRUSTED_ARNS_GATEWAY_URL                                  | Trusted ArNS gateway URL                               | -                 |
| ARNS_ON_DEMAND_CIRCUIT_BREAKER_TIMEOUT_MS                 | AO CU response timeout                                 | 15000             |
| ARNS_ON_DEMAND_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE | Circuit breaker error threshold                        | 50                |
| ARNS_ON_DEMAND_CIRCUIT_BREAKER_ROLLING_COUNT_TIMEOUT_MS   | Circuit breaker rolling count timeout                  | 60000             |
| ARNS_ON_DEMAND_CIRCUIT_BREAKER_RESET_TIMEOUT_MS           | Circuit breaker reset timeout                          | 300000            |
| ARNS_ANT_STATE_CACHE_MISS_REFRESH_INTERVAL_SECONDS        | Refresh interval of ANT state cache on cache miss      | 10                |
| ARNS_ANT_STATE_CACHE_HIT_REFRESH_INTERVAL_SECONDS         | Refresh interval of ANT state cache on cache hit       | 300               |

## Sandboxing

| Variable            | Description                          | Default |
| ------------------- | ------------------------------------ | ------- |
| SANDBOX_PROTOCOL    | Protocol for sandboxing redirects    | https   |
| SANDBOX_HOST        | Host for sandboxing redirects        | -       |
| SANDBOX_PORT        | Port for sandboxing redirects        | -       |
| SANDBOX_PATH_PREFIX | Path prefix for sandboxing redirects | -       |

## Arweave Nodes

| Variable                               | Description                                | Default |
| -------------------------------------- | ------------------------------------------ | ------- |
| TRUSTED_NODE_URL                       | Trusted Arweave node URL                   | -       |
| TRUSTED_GATEWAY_URL                    | Trusted gateway URL                        | -       |
| TRUSTED_GATEWAYS_URLS                  | Trusted gateways URLs and weights          | -       |
| CHUNK_POST_URLS                        | Chunk POST URLs                            | -       |
| SECONDARY_CHUNK_POST_URLS              | Secondary chunk POST URLs                  | -       |
| SECONDARY_CHUNK_POST_CONCURRENCY_LIMIT | Secondary chunk POST concurrency limit     | -       |
| SECONDARY_CHUNK_POST_MIN_SUCCESS_COUNT | Secondary chunk POST minimum success count | -       |
| CHUNK_POST_RESPONSE_TIMEOUT_MS         | Chunk POST response timeout                | -       |
| CHUNK_POST_ABORT_TIMEOUT_MS            | Chunk POST abort timeout                   | -       |

## Header Cache

| Variable         | Description               | Default |
| ---------------- | ------------------------- | ------- |
| CHAIN_CACHE_TYPE | Cache type for chain data | lmdb    |
| REDIS_CACHE_URL  | Redis URL                 | -       |
| REDIS_USE_TLS    | Whether to use TLS        | false   |

## Data Retrieval

| Variable                   | Description                         | Default |
| -------------------------- | ----------------------------------- | ------- |
| ON_DEMAND_RETRIEVAL_ORDER  | Order for on-demand data retrieval  | -       |
| BACKGROUND_RETRIEVAL_ORDER | Order for background data retrieval | -       |

## Contiguous Data Cache

| Variable                                | Description                                 | Default |
| --------------------------------------- | ------------------------------------------- | ------- |
| CONTIGUOUS_DATA_CACHE_CLEANUP_THRESHOLD | Threshold for contiguous data cache cleanup | -       |

## Data Verification

| Variable                                      | Description                               | Default |
| --------------------------------------------- | ----------------------------------------- | ------- |
| ENABLE_BACKGROUND_DATA_VERIFICATION           | Enable background data verification       | false   |
| BACKGROUND_DATA_VERIFICATION_INTERVAL_SECONDS | Interval for background data verification | 600     |

## Filesystem Cleanup

| Variable                                 | Description                                                                 | Default |
| ---------------------------------------- | --------------------------------------------------------------------------- | ------- |
| FS_CLEANUP_WORKER_BATCH_SIZE             | Number of files to process in each batch                                    | 2000    |
| FS_CLEANUP_WORKER_BATCH_PAUSE_DURATION   | Pause duration between batches in milliseconds                              | 5000    |
| FS_CLEANUP_WORKER_RESTART_PAUSE_DURATION | Pause duration before restarting cleanup from the beginning in milliseconds | 3600000 |
| ENABLE_FS_HEADER_CACHE_CLEANUP           | Whether to enable filesystem header cache cleanup                           | false   |

## Indexing

| Variable                        | Description                                                                                             | Default |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- | ------- |
| START_HEIGHT                    | Starting block height                                                                                   | -       |
| STOP_HEIGHT                     | Stopping block height                                                                                   | -       |
| WRITE_TRANSACTION_DB_SIGNATURES | Whether to write transaction signatures to the database                                                 | false   |
| FILTER_CHANGE_REPROCESS         | Whether to attempt to rematch old bundles using the current filter                                      | false   |
| BACKFILL_BUNDLE_RECORDS         | Whether to backfill bundle records (only needed for DBs that existed before unbundling was implemented) | false   |
| MAX_DATA_ITEM_QUEUE_SIZE        | Maximum number of data items to queue for indexing before skipping indexing new data items              | 100000  |
| BUNDLE_DATA_IMPORTER_QUEUE_SIZE | Maximum number of bundles to queue for unbundling before skipping unbundling new bundles                | 1000    |
| DATA_ITEM_FLUSH_COUNT_THRESHOLD | Maximum number of data items indexed to flush stable data items                                         | 1000    |
| MAX_FLUSH_INTERVAL_SECONDS      | Maximum interval in seconds to flush stable data items                                                  | 600     |
| ENABLE_DATA_DB_WAL_CLEANUP      | Whether to enable the data database WAL cleanup worker                                                  | false   |

## Mempool Watcher

| Variable                    | Description                  | Default |
| --------------------------- | ---------------------------- | ------- |
| ENABLE_MEMPOOL_WATCHER      | Enable mempool watcher       | false   |
| MEMPOOL_POLLING_INTERVAL_MS | Interval for mempool polling | 30000   |

## ANS104 Configuration

| Variable                             | Description                                               | Default |
| ------------------------------------ | --------------------------------------------------------- | ------- |
| ANS104_UNBUNDLE_FILTER               | Filter for unbundling transactions                        | -       |
| ANS104_INDEX_FILTER                  | Filter for indexing bundle items                          | -       |
| ANS104_UNBUNDLE_WORKERS              | Number of ANS-104 unbundling workers                      | 1       |
| ANS104_DOWNLOAD_WORKERS              | Number of ANS-104 bundle downloads to attempt in parallel | 5       |
| WRITE_ANS104_DATA_ITEM_DB_SIGNATURES | Whether to write data item signatures to the database     | false   |
| WRITE_TRANSACTION_DB_SIGNATURES      | Whether to write transaction signatures to the database   | false   |

## GraphQL Configuration

| Variable        | Description          | Default |
| --------------- | -------------------- | ------- |
| GRAPHQL_URL     | GraphQL URL          | -       |
| TAG_SELECTIVITY | Selectivity for tags | -       |

## ClickHouse Configuration

| Variable       | Description    | Default |
| -------------- | -------------- | ------- |
| CLICKHOUSE_URL | ClickHouse URL | -       |

## Webhook Configuration

| Variable               | Description                                    | Default |
| ---------------------- | ---------------------------------------------- | ------- |
| WEBHOOK_TARGET_SERVERS | Comma-separated list of webhook target servers | -       |
| WEBHOOK_INDEX_FILTER   | Filter for triggering webhooks                 | -       |
| WEBHOOK_BLOCK_FILTER   | Filter for block-based webhook triggers        | -       |

## Development and Testing

| Variable                            | Description                                 | Default |
| ----------------------------------- | ------------------------------------------- | ------- |
| SKIP_CACHE                          | Whether to bypass header cache              | false   |
| SIMULATED_REQUEST_FAILURE_RATE      | Rate to simulate request failures (0-1)     | 0       |
| GET_DATA_CIRCUIT_BREAKER_TIMEOUT_MS | Circuit breaker timeout for data operations | 500     |
| MEMPOOL_POLLING_INTERVAL_MS         | Interval for mempool polling                | 30000   |
| START_HEIGHT                        | Starting block height                       | -       |
| START_WRITERS                       | Enable/disable writers                      | false   |
| ENABLE_METRICS_ENDPOINT             | Enable metrics endpoint                     | -       |
| LOG_LEVEL                           | Logging level                               | debug   |
| AR_IO_SDK_LOG_LEVEL                 | SDK logging level                           | debug   |
