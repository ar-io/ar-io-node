# ENVs
This document describes the environment variables that can be used to configure the `ar.io` node.

| ENV_NAME                       | TYPE                 | DEFAULT_VALUE                  | DESCRIPTION                                                                                                                     |
|--------------------------------|----------------------|--------------------------------|---------------------------------------------------------------------------------------------------------------------------------|
| START_HEIGHT                   | Number or "Infinity" | 0                              | Starting block height for node synchronization (0 = start from the beginning)                                                   |
| STOP_HEIGHT                    | Number or "Infinity" | "Infinity"                     | Stop block height for node synchronization (Infinity = keep syncing until stopped)                                              |
| TRUSTED_NODE_URL               | String               | "https://arweave.net"          | Arweave node to use for fetching data                                                                                           |
| TRUSTED_GATEWAY_URL            | String               | "https://arweave.net"          | Arweave node to use for proxying requests                                                                                       |
| TRUSTED_ARNS_GATEWAY_URL       | String               | "https://__NAME__.arweave.dev" | ArNS gateway                                                                                                                    |
| INSTANCE_ID                    | String               | ""                             | Adds an "INSTACE_ID" field to output logs                                                                                       |
| LOG_FORMAT                     | String               | "simple"                       | Sets the format of output logs, accepts "simple" and "json"                                                                     |
| SKIP_CACHE                     | Boolean              | false                          | If true, use indexed data as a cache and skip fetching data from the node                                                       |
| PORT                           | Number               | 4000                           | AR.IO node exposed port number                                                                                                  |
| SIMULATED_REQUEST_FAILURE_RATE | Number               | 0                              | Number from 0 to Infinity, representing the probability of a request failing                                                    |
| AR_IO_WALLET                   | String               | ""                             | Arweave wallet address used for staking and rewards                                                                             |
| ADMIN_API_KEY                  | String               | Generated                      | API key used for admin API requests (if not set, it's generated and logged into the console)                                    |
| BACKFILL_BUNDLE_RECORDS        | Boolean              | false                          | If true, ar.io node will start indexing missing bundles                                                                         |
| FILTER_CHANGE_REPROCESS        | Boolean              | false                          | If true, all indexed bundles will be reprocessed with the new filters (you can use this when you change the filters)            |
| ANS104_UNBUNDLE_FILTER         | String               | '{"never": true}'              | Only bundles compliant with this filter will be unbundled                                                                       |
| ANS104_INDEX_FILTER            | String               | '{"never": true}'              | Only bundles compliant with this filter will be indexed                                                                         |
| ARNS_ROOT_HOST                 | String               | undefined                      | Domain name for ArNS host                                                                                                       |
| SANDBOX_PROTOCOL               | String               | undefined                      | Protocol setting in process of creating sandbox domain in ArNS (ARNS_ROOT_HOST needs to be set for this env to have any effect) |
| START_WRITERS                  | Boolean              | true                           | If true, start indexing blocks, tx, ANS104 bundles                                                                              |
