# ENVs

This document describes the environment variables that can be used to configure the `ar.io` node.

| ENV_NAME | TYPE | DEFAULT_VALUE | DESCRIPTION |
| ---------------------------------------- | -------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| START_HEIGHT | Number or "Infinity" | 0 | Starting block height for node synchronization (0 = start from the beginning) |
| STOP_HEIGHT | Number or "Infinity" | "Infinity" | Stop block height for node synchronization (Infinity = keep syncing until stopped) |
| TRUSTED_NODE_URL | String | "https://arweave.net" | Arweave node to use for fetching data |
| TRUSTED_GATEWAY_URL | String | "https://arweave.net" | Arweave node to use for proxying requests |
| TRUSTED_GATEWAYS_URLS | String | TRUSTED_GATEWAY_URL | A JSON map of gateways and priority |
| TRUSTED_ARNS_GATEWAY_URL | String | "https://__NAME__.arweave.dev" | ArNS gateway |
| INSTANCE_ID | String | "" | Adds an "INSTANCE_ID" field to output logs |
| LOG_FORMAT | String | "simple" | Sets the format of output logs, accepts "simple" and "json" |
| SKIP_CACHE | Boolean | false | If true, skips the local cache and always fetches headers from the node |
| PORT | Number | 4000 | ar.io node exposed port number |
| SIMULATED_REQUEST_FAILURE_RATE | Number | 0 | Number from 0 to 1, representing the probability of a request failing |
| AR_IO_WALLET | String | "" | Arweave wallet address used for staking and rewards |
| ADMIN_API_KEY | String | Generated | API key used for admin API requests (if not set, it's generated and logged into the console) |
| BACKFILL_BUNDLE_RECORDS | Boolean | false | If true, ar.io node will start indexing missing bundles |
| FILTER_CHANGE_REPROCESS | Boolean | false | If true, all indexed bundles will be reprocessed with the new filters (you can use this when you change the filters) |
| ON_DEMAND_RETRIEVAL_ORDER | String | s3,trusted-gateways,chunks,tx-data | Data source retrieval order for on-demand data requests |
| BACKGROUND_RETRIEVAL_ORDER | String | chunks,s3,trusted-gateways,chunks,tx-data | Data source retrieval order for background data requests (i.e., unbundling) |
| ANS104_UNBUNDLE_FILTER | String | {"never": true} | Only bundles compliant with this filter will be unbundled |
| ANS104_INDEX_FILTER | String | {"never": true} | Only bundles compliant with this filter will be indexed |
| ANS104_DOWNLOAD_WORKERS | String | 5 | Sets the number of ANS-104 bundles to attempt to download in parallel |
| ANS104_UNBUNDLE_WORKERS | Number | 0, or 1 if filters are set | Sets the number of workers used to handle unbundling |
| WRITE_ANS104_DATA_ITEM_DB_SIGNATURES | Boolean | true | If true, the data item signatures will be written to the database. |
| WRITE_TRANSACTION_DB_SIGNATURES | Boolean | true | If true, the transactions signatures will be written to the database. |
| ENABLE_DATA_DB_WAL_CLEANUP | Boolean | false | If true, the data database WAL cleanup worker will be enabled |
| ENABLE_BACKGROUND_DATA_VERIFICATION | Boolean | false | If true, unverified data will be verified in background |
| MAX_DATA_ITEM_QUEUE_SIZE | Number | 100000 | Sets the maximum number of data items to queue for indexing before skipping indexing new data items |
| ARNS_ROOT_HOST | String | undefined | Domain name for ArNS host |
| SANDBOX_PROTOCOL | String | undefined | Protocol setting in process of creating sandbox domain in ArNS (ARNS_ROOT_HOST needs to be set for this env to have any effect) |
| START_WRITERS | Boolean | true | If true, start indexing blocks, tx, ANS104 bundles |
| RUN_OBSERVER | Boolean | true | If true, runs the Observer alongside the gateway to generate Network compliance reports |
| MIN_RELEASE_NUMBER | String | 0 | Sets the minimum Gateway release version to check while doing a gateway version assessment |
| AR_IO_NODE_RELEASE | String | 0 | Sets the current ar.io node version to be set on X-AR-IO-Node-Release header on requests to the reference gateway |
| OBSERVER_WALLET | String | "<example>" | The public wallet address of the wallet being used to sign report upload transactions and contract interactions for Observer |
| CHUNKS_DATA_PATH | String | "./data/chunks" | Sets the location for chunked data to be saved. If omitted, chunked data will be stored in the `data` directory |
| CONTIGUOUS_DATA_PATH | String | "./data/contiguous" | Sets the location for contiguous data to be saved. If omitted, contiguous data will be stored in the `data` directory |
| HEADERS_DATA_PATH | String | "./data/headers" | Sets the location for header data to be saved. If omitted, header data will be stored in the `data` directory |
| SQLITE_DATA_PATH | String | "./data/sqlite" | Sets the location for sqlite indexed data to be saved. If omitted, sqlite data will be stored in the `data` directory |
| DUCKDB_DATA_PATH | String | "./data/duckdb" | Sets the location for duckdb data to be saved. If omitted, duckdb data will be stored in the `data` directory |
| TEMP_DATA_PATH | String | "./data/tmp" | Sets the location for temporary data to be saved. If omitted, temporary data will be stored in the `data` directory |
| LMDB_DATA_PATH | String | "./data/LMDB" | Sets the location for LMDB data to be saved. If omitted, LMDB data will be stored in the `data` directory |
| CHAIN_CACHE_TYPE | String | "redis" | Sets the method for caching chain data, defaults redis if gateway is started with docker-compose, otherwise defaults to LMDB |
| REDIS_CACHE_URL | String (URL) | "redis://localhost:6379" | URL of Redis database to be used for caching |
| REDIS_CACHE_TTL_SECONDS | Number | 28800 | TTL value for Redis cache, defaults to 8 hours (28800 seconds) |
| ENABLE_FS_HEADER_CACHE_CLEANUP | Boolean | true if starting with docker, otherwise false | If true, periodically deletes cached header data |
| NODE_JS_MAX_OLD_SPACE_SIZE | Number | 2048 or 8192, depending on number of workers | Sets the memory limit, in Megabytes, for NodeJs. Default value is 2048 if using less than 2 unbundle workers, otherwise 8192 |
| SUBMIT_CONTRACT_INTERACTIONS | Boolean | true | If true, Observer will submit its generated reports to the ar.io Network |
| REDIS_MAX_MEMORY | String | 256mb | Sets the max memory allocated to Redis |
| REDIS_EXTRA_FLAGS | String | --save "" --appendonly no | Additional CLI flags passed to Redis |
| WEBHOOK_TARGET_SERVERS | String | undefined | Target servers for webhooks |
| WEBHOOK_INDEX_FILTER | String | {"never": true} | Only emit webhooks for transactions and data items compliant with this filter |
| WEBHOOK_BLOCK_FILTER | String | {"never": true} | Only emit webhooks for blocks compliant with this filter |
| CONTIGUOUS_DATA_CACHE_CLEANUP_THRESHOLD | Number | undefined | Sets the age threshold in seconds; files older than this are candidates for contiguous data cache cleanup |
| ENABLE_MEMPOOL_WATCHER | Boolean | false | If true, the observer will start indexing pending tx from the mempool |
| MEMPOOL_POLLING_INTERVAL_MS | Number | 30000 | Sets the mempool polling interval in milliseconds |
| TAG_SELECTIVITY | String | Refer to config.ts | A JSON map of tag names to selectivity weights used to order SQLite tag joins |
| MAX_EXPECTED_DATA_ITEM_INDEXING_INTERVAL_SECONDS | Number | undefined | Sets the max expected data item indexing interval in seconds |
| AR_IO_SQLITE_BACKUP_S3_BUCKET_NAME | String | "" | S3-compatible bucket name, used by the Litestream backup service |
| AR_IO_SQLITE_BACKUP_S3_BUCKET_REGION | String | "" | S3-compatible bucket region, used by the Litestream backup service |
| AR_IO_SQLITE_BACKUP_S3_BUCKET_ACCESS_KEY | String | "" | S3-compatible bucket access_key credential, used by Litestream backup service, omit if using resource-based IAM role |
| AR_IO_SQLITE_BACKUP_S3_BUCKET_SECRET_KEY | String | "" | S3-compatible bucket access_secret_key credential, used by Litestream backup service, omit if using resource-based IAM role |
| AR_IO_SQLITE_BACKUP_S3_BUCKET_PREFIX | String | "" | A prepended prefix for the S3 bucket where SQLite backups are stored. |
| AWS_ACCESS_KEY_ID | String | undefined | AWS access key ID for accessing AWS services |
| AWS_SECRET_ACCESS_KEY | String | undefined | AWS secret access key for accessing AWS services |
| AWS_REGION | String | undefined | AWS region where the resources are located |
| AWS_ENDPOINT | String | undefined | Custom endpoint for AWS services |
| AWS_S3_CONTIGUOUS_DATA_BUCKET | String | undefined | AWS S3 bucket name used for storing data |
| AWS_S3_CONTIGUOUS_DATA_PREFIX | String | undefined | Prefix for the S3 bucket to organize data |
| CHUNK_POST_MIN_SUCCESS_COUNT | String | "3" | minimum count of 200 responses for of a given chunk to be considered properly seeded |
