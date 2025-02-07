# Change Log

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Release 25] - 2025-02-07

### Added

- Added support for indexing and querying ECDSA signed Arweave transactions.
- Expanded the OpenAPI specification to cover the entire gateway API and
  commonly used Arweave node routes.
- ArNS undername record count limits are now enforced. Undernames are sorted
  based on their ANT configured priority with a fallback to name comparisons
  when priorities conflict or are left unspecified. Enforcement is enabled by
  default but can be disabled by setting the
  `ARNS_RESOLVER_ENFORCE_UNDERNAME_LIMIT` to `false`.

### Changed

- Renamed the `ario-peer` data source to `ar-io-peers` for consistency and
  clarity. `ario-peer` will continue to work for backwards compatibility but is
  considered deprecated.
- Use AR.IO gateway peers from the ar.io gateway address registry (GAR) as the
  last fallback for fetching data when responding to client data requests. This
  has the benefit of making the network more resilient to trusted gateway
  disruptions, but it can also result in nodes serving data from less trusted
  sources if it is not found in the trusted gateway. This can be disabled by
  using a custom `ON_DEMAND_RETRIEVAL_ORDER` that does not include
  `ar-io-peers`.
- Arweave data chunk requests are sent to the trusted node first with a
  fallback to Arweave peers when chunks are unavailable on the trusted node.
  This provides good performance by default with a fallback in case there are
  issues retrieving chunks from the trusted node.
- Increased the observer socket timeout to 5 seconds to accommodate initial
  slow responses for uncached ArNS resolutions.
- Disabled writing base layer Arweave signatures to the SQLite DB by default to
  save disk space. When signatures are required to satisfy GraphQL requests,
  they are retrieved from headers on the trusted node.

### Fixed

- Updated dependencies to address security issues.
- Improved reliability of failed bundle indexing retries.
- Fixed failure to compute data roots for verification for base layer data
  larger than 2GiB.
- Fixed observer healthcheck by correcting node.js path in healthcheck script.

## [Release 24] - 2025-02-03

### Added

- Added a `ARNS_ANT_STATE_CACHE_HIT_REFRESH_WINDOW_SECONDS` environment
  variable that determines the number of seconds before the end of the TTL at
  which to start attempting to refresh the ANT state.
- Added a `TRUSTED_GATEWAYS_REQUEST_TIMEOUT_MS` environment that defaults to
  10,000 and sets the number of milliseconds to wait before timing out request
  to trusted gateways.
- Added `BUNDLE_REPAIR_RETRY_INTERVAL_SECONDS` and
  `BUNDLE_REPAIR_RETRY_BATCH_SIZE` environment variables to control the time
  between queuing batches of bundle retries and the number of data items
  retrieved when constructing batches of bundles to retry.
- Added support for configuring the ar.io SDK log level via the
  `AR_IO_SDK_LOG_LEVEL` environment variable.
- Added a `request_chunk_total` Prometheus counter with `status`, `source` (a
  URL) and `source_type` (`trusted` or `peer`) labels to track success/failure
  of chunk retrieval in the Arweave network per source.
- Added a `get_chunk_total` Prometheus metric to count chunk retrieval
  success/failure per chunk.
- Added `arns_cache_hit_total` and `arns_cache_miss_total` Prometheus counters
  to track ArNS cache hits and misses for individual names respectively.
- Added `arns_name_cache_hit_total` and `arns_name_cache_miss_total` Prometheus
  counters to track ArNS name list cache hits and misses
  respectively.
- Added a `arns_resolution_duration_ms` Prometheus metric that tracks summary
  statistics for the amount of time it takes to resolve ArNS names.

### Changed

- In addition to the trusted node, the Arweave network is now searched for
  chunks by default. All chunks retrieved are verified against data roots
  indexed from a trusted Arweave node to ensure their validity.
- Default to a 24 hour cache TTL for the ArNS name cache. Record TTLs still
  override this, but in cases where resolution via AO CU is slow or fails, the
  cache will be used. In the case of slow resolution, CU based resolution will
  proceed in the background and update the cache upon completion.
- Switched to the `ioredis` library for better TLS support.
- Updated minor dependency minor versions (more dependencies will be updated in
  the next release).
- Bundles imports will no longer be re-attempted for bundles that have already
  been fully unbundled using the current filters if they are matched or
  manually queued again.
- Replaced references `docker-compose` in the docs with the more modern `docker
  compose`.

### Fixed

- Ensure duplicate data item IDs are ignored when comparing counts to determine
  if a bundle has been fully unbundled.
- Fixed worker threads failing to shut down properly when the main process
  stopped.
- Ensure bundle import attempt counts are incremented when bundles are skipped
  to avoid repeatedly attempting to import skipped bundles.
- Use observe that correctly ensure failing gateways are penalized in the AR.IO
  AO process.

## [Release 23] - 2025-01-13

### Added

- Added `FS_CLEANUP_WORKER_BATCH_SIZE`,
  `FS_CLEANUP_WORKER_BATCH_PAUSE_DURATION`, and
  `FS_CLEANUP_WORKER_RESTART_PAUSE_DURATION` environment variables to allow
  configuration of number of contiguous data files cleaned up per batch, the
  pause between each batch, and the pause before restarting the entire cleanup
  process again.
- Added `data_items_unbundled_total` Prometheus metric that counts the total
  number of data items unbundled, including those that did not match the
  unbundling filter.
- Added a `parent_type` label that can be one of `transaction` or `data_item`
  to data item indexing metrics.
- Added a `files_cleaned_total` total Prometheus metric to enable monitoring of
  contiguous data cleanup.
- Added support for specifying the admin API via a file specified by the
  `ADMIN_API_KEY_FILE` environment variable.
- Added experimental support for posting chunks in a non-blocking way to
  secondary nodes specified via a comma separate list in the
  `SECONDARY_CHUNK_POST_URLS` environment variable.

### Changed

- Renamed the `parent_type` lable to `contiguous_data_type` on bundle metrics
  to more accurately reflect the meaning of the label.
- Reduced the maximum time to refresh the ArNS name list to 10 seconds to
  minimize delays in ArNS availability after a new name is registered.
- Changed `/ar-io/admin/queue-bundle` to wait for `bundles` rows to be written
  to the DB before responding to ensure that errors that occur due to DB
  contention are not silently ignored.
- Data items are now flushed even when block indexing is stopped. This allows
  for indexing batches of data items using the admin API with block indexing
  disabled.
- Adjust services in `docker-compose` to use `unless-stopped` as their restart
  policy. This guards against missing restarts in the case where service
  containers exit with a success status even when they shouldn't.

### Fixed

- Added missing `created_at` field in `blocked_names` table.
- Fixed broken ArNS undername resolution.

## [Release 22] - 2024-12-18

### Added

- Added the ability to block and unblock ArNS names (e.g., to comply with
  hosting provider TOS). To block a name, POST `{ "name": "<name to block>" }`
  to `/ar-io/admin/block-name`. To unblock a name, POST
  `{ "name": "<name to unblock>" }` to `/ar-io/admin/unblock-name`.

### Changed

- Return an HTTP 429 response to POSTs to `/ar-io/admin/queue-bundle` when the
  bundle data import queue is full so that scripts queuing bundles can wait
  rather than overflowing it.

### Fixed

- Adjust ArNS length limit from <= 48 to <= 51 to match the limit enforced by
  the AO process.

## [Release 21] - 2024-12-05

### Added

- Added a ClickHouse auto-import service. When enabled, it calls the Parquet
  export API, imports the exported Parquet into ClickHouse, moves the Parquet
  files to an `imported` subdirectory, and deletes data items in SQLite up to
  where the Parquet export ended. To use it, run Docker Compose with the
  `clickhouse` profile, set the `CLICKHOUSE_URL` to `http://clickhouse:8123`,
  and ensure you have set an `ADMIN_KEY`.
  Using this configuration, the core service will also combine results from
  ClickHouse and SQLite when querying transaction data via GraphQL. Note: if
  you have a large number of data items in SQLite, the first export and
  subsequent delete may take an extended period. Also, this functionality is
  considered **experimental**. We expect there are still bugs to be found in it
  and we may make breaking changes to the ClickHouse schema in the future. If
  you choose to use it in production (not yet recommended), we suggest backing
  up copies of the Parquet files found in `data/parquet/imported` so that they
  can be reimported if anything goes wrong or future changes require it.
- Added a background data verification process that will attempt to recompute
  data roots for bundles and compare them to data roots indexed from Arweave
  nodes. When the data roots match, all descendant data items will be marked as
  verified. This enables verification of data initially retrieived from sources,
  like other gateways, that serve contiguous data instead of verifiable chunks.
  Data verification can be enabled by setting the
  `ENABLE_BACKGROUND_DATA_VERIFICATION` environment variable to true. The
  interval between attempts to verify batches of bundles is configurable using
  the  `BACKGROUND_DATA_VERIFICATION_INTERVAL_SECONDS` environment variable.
- Added a `CHUNK_POST_MIN_SUCCESS_COUNT` environment variable to configure how
  many Arweave nodes must accept a chunk before a chunk broadcast is considered
  successful.
- Added `arweave_chunk_post_total` and `arweave_chunk_broadcast_total`
  Prometheus metrics to respectively track the number of successful chunk POSTs
  to Arweave nodes and the number of chunks successfully broadcast.
- When resolving ArNS names, the entire list of names is now cached instead of
  individually checking whether each name exists. This reduces the load on AO
  CUs since the entire list can be reused across multiple requests for
  different names. Note: due to the default 5 minute interval between name list
  refreshes, newly registered may now take longer to resolver after initial
  registration. We intend to make further caching refinements to address this
  in the future.
- Added support for multiple prioritized trusted gateways configurable by
  setting the `TRUSTED_GATEWAYS_URLS` environment variable to a JSON value
  containing a mapping of gateway hosts to priorities. Data requests are sent
  to other gateways in ascending priority order. If multiple gateways share the
  same priority, all the gateways with the same priority are tried in a random
  order before continuing on to the next priority.
- Added support for caching contiguous data in S3. It is enabled by default
  when the `AWS_S3_CONTIGUOUS_DATA_BUCKET` and `AWS_S3_CONTIGUOUS_DATA_PREFIX`
  environment variables are set.

### Changed

- `trusted-gateway` was changed to `trusted-gateways` in
  `ON_DEMAND_RETRIEVAL_ORDER` and `BACKGROUND_RETRIEVAL_ORDER`.
- Renamed the S3 contiguous environment variables - `AWS_S3_BUCKET` to
  `AWS_S3_CONTIGUOUS_DATA_BUCKET` and `AWS_S3_PREFIX` to
  `AWS_S3_CONTIGUOUS_DATA_PREFIX`.

## [Release 20] - 2024-11-15

### Added

- Exposed the core service chunk POST endpoint via Envoy. It accepts a Arweave
  data chunk and broadcasts it to either the comma separated list of URLs
  specified by the CHUNK_POST_URLs environment variable or, if none are
  specified, the `/chunk` path on URL specified by the TRUST_GATEWAY_URL
  environment variable.
- Added a `X-AR-IO-Root-Transaction-Id` HTTP header to data responses
  containing the root base layer transaction ID for the ID in question if it's
  been indexed.
- Added a `X-AR-IO-Data-Item-Data-Offset` HTTP header containing the offset of
  the data item relative to the root bundle base layer transaction for it. In
  conjunction with `X-AR-IO-Root-Transaction-Id`, it enables retrieving data
  for data item IDs from base layer data using first a `HEAD` request to
  retrieve the root ID and data offset followed by a range request into the
  root bundle. This greatly increases the likelihood of retriving data item
  data by ID since only an index into the base layer and Arweave chunk
  availability is needed for this access method to succeed.
- Added an experimental ClickHouse service to `docker-compose.yaml` (available
  via the `clickhouse` profile). This will be used as a supplemental GraphQL DB
  in upcoming releases.
- Added a data item indexing healthcheck that can be enabled by setting the
  `RUN_AUTOHEAL` environment variable to `true`. When enabled, it will restart
  the `core` service if no data items have been indexed since the value
  specified by the `MAX_EXPECTED_DATA_ITEM_INDEXING_INTERVAL_SECONDS`
  environment variable.

## [Release 19] - 2024-10-21

### Fixed

- Adjusted data item flushing to use the bundle DB worker instead of the core
  DB worker to prevent write contention and failed flushes under heavy
  unbundling load.

### Added

- Added `X-AR-IO-Digest`, `X-AR-IO-Stable`, `X-AR-IO-Verified`, and `ETag`
  headers. `X-AR-IO-Digest` contains a base64 URL encoded representation of the
  SHA-256 hash of the data item data. It may be empty if the gateway has not
  previously cached the data locally. `X-AR-IO-Stable` contains either `true`
  or `false` depending on whether the associated Arweave transaction is more
  than 18 blocks old or not. `X-AR-IO-Verified` contains either `true` if the
  gateway has verified the data root of the L1 transaction or the L1 root
  parent of the data item or `false` if it has not. `ETag` contains the same
  value a `X-AR-IO-Digest` and is used to improve HTTP caching efficiency.
- Added support for using a different data source for on-demand and background
  data retrieval. Background data retrieval is used when unbundling. The
  background retrieval data source order is configurable using the
  `BACKGROUND_RETRIEVAL_ORDER` environment variable and defaults to
  `chunks,s3,trusted-gateway,tx-data`. Priority is given to chunk retrieval
  since chunks are verifiable.
- Added an `/ar-io/admin/export-parquet/status` to support monitoring of
  in-progress Parquet export status.
- Added `sqlite_in_flight_ops` Prometheus metric with `worker` (`core`,
  `bundles`, `data`, or `moderation`) and `role` (`read` or `write`) labels to
  support monitoring the number of in-flight DB operations.
- Added experimental Grafana and Prometheus based observability stack. See the
  "Monitoring and Observability" section of the README for more details.

### Changed

- Bundle data is now retrieved as chunks from Arweave nodes by default so that
  data roots can be compared against the chain (see entry about background
  retrieval above).
- Changed observer configuration to use 8 instead of 5 chosen names. These are
  combined with 2 names prescribed from the contract for a total of 10 names
  observed each epoch to provide increased ArNS observation coverage.
- Verification status is set on data items when unbundling a parent that has
  already been verified.

## [Release 18] - 2024-10-01

### Fixed

- Improved performance of data attributes query that was preventing `data.db`
  WAL flushing.

### Added

- Added WAL `sqlite_wal_checkpoint_pages` Prometheus metric to help monitor WAL
  flushing.
- Added a POST `/ar-io/admin/export-parquet` endpoint that can be used to
  export the contents of the SQLite3 core and bundle DBs as Parquet. To trigger
  an export, POST JSON containing `outputDir`, `startHeight`, `endHeight`, and
  `maxFileRows` keys. The resulting Parquet files can then be queried directly
  using DuckDB or loaded into another system (e.g. ClickHouse). Scripts will be
  provided to help automate the latter in a future release.
- Added `ARNS_RESOLVER_OVERRIDE_TTL_SECONDS` that can be used to force ArNS
  names to refresh before their TTLs expire.
- Added a GET `/ar-io/resolver/:name` endpoint that returns an ArNS resolution
  for the given name.

### Changed

- Removed ArNS resolver service in favor of integrated resolver. If a
  standalone resolver is still desired, the core service can be run with the
  `START_WRITERS` environment variable set to `false`. This will disable
  indexing while preserving resolver functionality.
- Deduplicated writes to `data.db` to improve performance and reduce WAL growth
  rate.

## [Release 17] - 2024-09-09

### Notes

- This release includes a **LONG RUNNING MIGRATION**. Your node may appear
  unresponsive while it is running. It is best to wait for it to complete. If
  it fails or is interrupted, removing your SQLite DBs (in `data/sqlite` by
  default) should resolve the issue, provided you are willing to lose your
  GraphQL index and let your node rebuild it.

### Fixed

- Use the correct environment variable to populate WEBHOOK_BLOCK_FILTER in
  `docker-compose.yaml`.
- Don't cache data regions retrieved to satisfy range requests to avoid
  unnecessary storage overhead and prevent inserting invalid ID to hash
  mappings into the data DB.

### Added

- Added a new ClickHouse based DB backend. It can be used in combination with
  the SQLite DB backend to enable batch loading of historical data from
  Parquet. It also opens up the possibility of higher DB performance and
  scalability. In its current state it should be considered a technology
  preview. It won't be useful to most users until we either provide Parquet
  files to load into it or automate flushing of the SQLite DB to it (both are
  planned in future release). It is not intended to be standalone solution. It
  supports bulk loading and efficient GraphQL querying of transactions and data
  items, but it relies on SQLite (or potentially another OLTP in the future) to
  index recent data. These limitations allow greatly simplified schema and
  query construction. Querying the new ClickHouse DB for transaction and data
  items via GraphQL is enabled by setting the 'CLICKHOUSE_URL' environment
  variable.
- Added the ability to skip storing transaction signatures in the DB by setting
  WRITE_TRANSACTION_DB_SIGNATURES to false. Missing signatures are fetched from
  the trusted Arweave node when needed for GraphQL results.
- Added a Redis backed signature cache to support retrieving optimistically
  indexed data item signatures in GraphQL queries when writing data items
  signatures to the DB has been disabled.
- Added on-demand and composite ArNS resolvers. The on-demand resolver
  fetches results directly from an AO CU. The composite resolver attempts
  resolution in the order specified by the ARNS_RESOLVER_PRIORITY_ORDER
  environment variable (defaults to 'on-demand,gateway').
- Added a queue_length Prometheus metric to fasciliate monitoring queues and
  inform future optimizations
- Added SQLite WAL cleanup worker to help manage the size of the `data.db-wal`
  file. Future improvements to `data.db` usage are also planned to further
  improve WAL management.

### Changed

- Handle data requests by ID on ArNS sites. This enables ArNS sites to use
  relative links to data by ID.
- Replaced ARNS_RESOLVER_TYPE with ARNS_RESOLVER_PRIORITY_ORDER (defaults to
  'on-demand,gateway').
- Introduced unbundling back pressure. When either data item data or GraphQL
  indexing queue depths are more than the value specified by the
  MAX_DATA_ITEM_QUEUE_SIZE environment variable (defaults to 100000),
  unbundling is paused until the queues length falls bellow that threshold.
  This prevents the gateway from running out of memory when the unbundling rate
  exceeds the indexing rate while avoiding wasteful bundle reprocessing.
- Prioritized optimistic data item indexing by inserting optimistic data items
  at the front of the indexing queues.
- Prioritized nested bundle indexing by inserting nested bundles at the front
  of the unbundling queue.

## [Release 16] - 2024-08-09

### Fixed

- Fixed promise leak caused by missing await when saving data items to the DB.
- Modified ArNS middleware to not attempt resolution when receiving requests
  for a different hostname than the one specified by `ARNS_ROOT_HOST`.

### Added

- Added support for returning `Content-Encoding` HTTP headers based on user
  specified `Content-Encoding` tags.
- Added `isNestedBundle` filter enables that matches any nested bundle when
  indexing. This enables composite unbundling filters that match a set of L1
  tags and bundles nested under them.
- Added ability to skip writing ANS-104 signatures to the DB and load them
  based on offsets from the data instead. This significantly reduces the size
  of the bundles DB. It can be enabled by setting the
  `WRITE_ANS104_DATA_ITEM_DB_SIGNATURES` environment variable to `false`.
- Added `data_item_data_indexed_total` Prometheus counter to count data items
  with data attributes indexed.

### Changed

- Queue data attributes writes when serving data rather than writing them
  syncronously.
- Reduced the default data indexer count to 1 to lessen the load on the data
  DB.
- Switched a number of overly verbose info logs to debug level.
- Removed docker-compose on-failure restart limits to ensure that services
  restart no matter how many times they fail.
- Modified the `data_items_indexed_total` Prometheus counter to count data
  items indexed for GraphQL querying instead of data attributes.
- Increased aggressiveness of contiguous data cleanup. It now pauses 5 seconds
  instead of 10 seconds per batch and runs every 4 hours instead of every 24
  hours.

## [Release 15] - 2024-07-19

### Fixed

- Fixed query error that was preventing bundles from being marked as fully
  imported in the database.

### Added

- Adjusted data item indexing to record data item signature types in the DB. This
  helps distinguish between signatures using different key formats, and will
  enable querying by signature type in the future.
- Adjusted data item indexing to record offsets for data items within bundles
  and signatures and owners within data items. In the future this will allow us
  to avoid saving owners and signatures in the DB and thus considerably reduce
  the size of the bundles DB.
- Added `ARNS_CACHE_TTL_MS` environment variable to control the TTL of ARNS cache
  entries (defaults to 1 hour).
- Added support for multiple ranges in a single HTTP range request.
- Added experimental chunk POST endpoint that broadcasts chunks to the
  comma-separate list of URLS in the `CHUNK_BROADCAST_URLS` environment
  variable. It is available at `/chunk` on the internal gateway service port
  (4000 by default) but is not yet exposed through Envoy.
- Added support for running an AO CU adjacent to the gateway (see README.md for
  details).
- Added `X-ArNS-Process-Id` to ArNS resolved name headers.
- Added a set of `AO_...` environment variables for specifying which AO
  URLs should be used (see `docker-compose.yaml` for the complete list). The
  `AO_CU_URL` is of particular use since the core and resolver services only
  perform AO reads and only the CU is needed for reads.

### Changed

- Split the monolithic `docker-compose.yaml` into `docker-compose.yaml`,
  `docker-compose.bundler.yaml`, and `docker-compose.ao.yaml` (see README for
  details).
- Replaced references to 'docker-compose' with 'docker compose' in the docs
  since the former is mostly deprecated.
- Reduce max fork depth from 50 to 18 inline to reflect Arweave 2.7.2 protocol
  changes.
- Increased the aggressiveness of bundle reprocessing by reducing reprocessing
  interval from 10 minutes to 5 minutes and raising reprocessing batch size
  from 100 to 1000.
- Use a patched version of Litestream to work around insufficient S3 multipart
  upload size in the upstream version.

## [Release 14] - 2024-06-26

### Fixed

- Correctly handle manifest `index` after `paths`.

## [Release 13] - 2024-06-24

### Added

- Added support for optimistically reading data items uploaded using the
  integrated Turbo bundler via the LocalStack S3 interface.
- Added `X-AR-IO-Origin-Node-Release` header to outbound data requests.
- Added `hops`, `origin`, and `originNodeRelease` query params to
  outbound data requests.
- Added support for `fallback` in v0.2 manifests that is used if no path in
  the the manifest is matched.

### Changed

- Updated Observer to read prescribed names from and write observations to the
  ar.io AO network process.
- Updated Resolver to read from the ar.io AO network process.

### Fixed

- Modified optimistic indexing of data items to use a null `parent_id` when
  inserting into the DB instead of a placeholder value. This prevents
  unexpected non-null `bundledIn` values in GraphQL results for optimistically
  indexed data items.
- Modified GraphQL query logic to require an ID for single block GraphQL
  queries. Previously queries missing an ID were returning an internal SQLite
  error. This represents a small departure from arweave.net's query logic which
  returns the latest block for these queries. We recommend querying `blocks`
  instead of `block` in cases where the latest block is desired.
- Adjusted Observer health check to reflect port change to 5050.

### Security

- Modified docker-compose.yaml to only expose Redis, PostgreSQL, and
  LocalStack ports internally. This protects gateways that neglect to deploy
  behind a firewall, reverse proxy, or load balancer.

## [Release 12] - 2024-06-05

### Added

- Added `/ar-io/admin/queue-data-item` endpoint for queuing data item
  headers for indexing before the bundles containing them are
  processed. This allows trusted bundlers to make their data items
  quickly available to be queried via GraphQL without having to wait for bundle
  data submission or unbundling.
- Added experimental support for retrieving contiguous data from S3. See
  `AWS_*` [environment variables documentation](docs/env.md) for configuration
  details. In conjuction with a local Turbo bundler this allows optimistic
  bundle (but not yet data item) retrieval.
- Add experimental support for fetching data from gateway peers. It can be
  enabled by adding `ario-peer` to `ON_DEMAND_RETRIEVAL_ORDER`. Note: do not
  expect this work reliably yet! This functionality is in active development
  and will be improved in future releases.
- Add `import_attempt_count` to `bundle` records to enable future bundle import
  retry optimizations.

### Changed

- Removed `version` from `docker-compose.yaml` to avoid warnings with recent
  versions of `docker-compose`
- Switched default observer port from 5000 to 5050 to avoid conflict on OS X.
  Since Envoy is used to provide external access to the observer API this
  should have no user visible effect.

## [Release 11] - 2024-05-21

### Added

- Added `arweave_tx_fetch_total` Prometheus metric to track counts of
  transaction headers fetched from the trusted node and Arweave network peers.

### Fixed

- Revert to using unnamed bind mounts due to cross platform issues with named
  volumes.

## [Release 10] - 2024-05-20

### Added

- Added experimental support for streaming SQLite backups to S3 (and compatible
  services) using [Litestream](https://litestream.io/). Start the service using
  the docker-compose 'litestream' profile to use it, and see the
  `AR_IO_SQLITE_BACKUP_*` [environment variables documentation](docs/env.md) for
  further details.
- Added `/ar-io/admin/queue-bundle` endpoint for queuing bundles for import
  before they're in the mempool. In the future, this will enable optimistic
  indexing when combined with a local trusted bundler.
- Added support for triggering webhooks when blocks are imported that match the
  filter specified by the `WEBHOOK_BLOCK_FILTER` environment variable.
- Added experimental support for indexing transactions and related data items
  from the mempool. Enable it by setting the `ENABLE_MEMPOOL_WATCHER` environment
  variable to 'true'.
- Made on-demand data caching circuit breakers configurable via the
  `GET_DATA_CIRCUIT_BREAKER_TIMEOUT_MS` environment variable. This allows gateway
  operators to decide how much latency they will tolerate when serving data in
  exchange for more complete data indexing and caching.
- Added `X-AR-IO-Hops` and `X-AR-IO-Origin` headers in preparation for future
  peer-to-peer data functionality.

### Changed

- Renamed cache header from `X-Cached` to `X-Cache` to mimic typical CDN
  practices.
- Upgrade to Node.js v20 and switch to the native test runner.

## [Release 9] - 2024-04-10

### Added

- Added experimental Farcaster Frames support enabling simple Areave based
  Frames with button navigation. Transaction and data item data is now served
  under `/local/farcaster/frame/<ID>`. `/local` is used as a prefix to indicate
  this functionality is both experimental and local to a particular the gateway
  rather than part of the global gateway API. Both GET and POST requests are
  supported.
- Added an experimental local ArNS resolver. When enabled it removes dependence
  on arweave.net for ArNS resolution! Enable it by setting `RUN_RESOLVER=true`,
  `TRUSTED_ARNS_RESOLVER_TYPE=resolver`, and
  `TRUSTED_ARNS_RESOLVER_URL=http://resolver:6000` in your `.env` file.
- Added a `CONTIGUOUS_DATA_CACHE_CLEANUP_THRESHOLD` environment variable
  that represents a threshold age in seconds to be compared with a contiguous
  data file age. If file is older than the amount of seconds set in the
  enviroment variable it will be deleted.
- Added an 'X-Cached' header to data responses to indicate when data is served
  from the local cache rather than being retrieved from an external source. This
  is helpful for interfacing with external systems, debugging, and end-to-end
  testing.
- Save hashes for unbundled data items during indexing. This enables reduction
  in data storage via hash based deduplication as well as more efficient
  peer-to-peer data retrieval in the future.

## [Release 8] - 2024-03-14

### Added

- Add GraphQL SQL query debug logging to support trouble shooting and
  performance optimization.
- Add support for indexing data items (not GraphQL querying) based solely on
  tag name (example use case: indexing all IPFS CID tagged data items).

### Changes

- Observer data sampling now uses randomized ranges to generate content hashes.
- Reference gateway ArNS resolutions are now cached to improve report
  generation performance.
- Contract interactions are now tested before posting using `dryWrite` to avoid
  submitting interactions that would fail.
- `/ar-io/observer/info` now reports `INVALID` for wallets that fail to load.

### Fixed

- Fix data caching failure caused by incorrect method name in getData* circuit
  breakers.
- Fix healthcheck when ARNS_ROOT_HOST includes a subdomain.

## [Release 7] - 2024-02-14

### Added

- Add support for notifiying other services of transactions and data items
  using webhooks (see README for details).
- Add support for filter negation (particularly useful for excluding large
  bundles from indexing).
- Improve unbundling throughput by decoupling data fetching from unbundling.
- Add Envoy and core service ARM builds.

### Changed

- Improve resource cleanup and shutdown behavior.
- Don't save Redis data to disk by default to help prevent memory issues on
  startup for small gateways.
- Reduce the amount of data sampled from large files by the observer.
- Ensure block poa2 field is not cached to reduce memory consumption.

## [Release 6] - 2024-01-29

### Fixed

- Update observer to improve reliability of contract state synchronization and
  evaluation.

## [Release 5] - 2024-01-25

### Added

- Added transaction offset indexing to support future data retrieval
  capabilities.
- Enabled IPv6 support in Envoy config.
- Added ability to configure observer report generation interval via the
  REPORT_GENERATION_INTERVAL_MS environment variable (intended primarily for
  development and testing).

### Changed

- Updated observer to properly handle FQDN conflicts.
- Renamed most created_at columns to indexed_at for consistency and clarity.

### Fixed

- Updated LMDB version to remove Buffer workaround and fix occassional block
  cache errors.

## [Release 4] - 2024-01-11

### Added

- Added circuit breakers around data index access to reduce impact of DB access
  contention under heavy requests loads.
- Added support for configuring data source priority via the
  ON_DEMAND_RETRIEVAL_ORDER environment variable.
- Updated observer to a version that retrieves epoch start and duration from
  contract state.

### Changed

- Set the Redis max memory eviction policy to `allkeys-lru`.
- Reduced default Redis max memory from 2GB to 256MB.
- Improved predictability and performance of GraphQL queries.
- Eliminated unbundling worker threads when filters are configured to skip
  indexing ANS-104 bundles.
- Reduced the default number of ANS-104 worker threads from 2 to 1 when
  unbundling is enabled to conserve memory.
- Increased nodejs max old space size to 8GB when ANS-104 workers > 1.

### Fixed

- Adjusted paths for chunks indexed by data root to include the full data root.

## [Release 3] - 2023-12-05

### Added

- Support range requests ([PR 61], [PR 64])
  - Note: serving multiple ranges in a single request is not yet supported.
- Release number in `/ar-io/info` response.
- Redis header cache implementation ([PR 62]).
  - New default header cache (replaces old FS cache).
- LMDB header cache implementation ([PR 60]).
  - Intended for use in development only.
  - Enable by setting `CHAIN_CACHE_TYPE=lmdb`.
- Filesystem header cache cleanup worker ([PR 68]).
  - Enabled by default to cleanup old filesystem cache now that Redis
    is the new default.
- Support for parallel ANS-104 unbundling ([PR 65]).

### Changed

- Used pinned container images tags for releases.
- Default to Redis header cache when running via docker-compose.
- Default to LMDB header cache when running via `yarn start`.

### Fixed

- Correct GraphQL pagination for transactions with duplicate tags.

[PR 68]: https://github.com/ar-io/ar-io-node/pull/68
[PR 65]: https://github.com/ar-io/ar-io-node/pull/65
[PR 64]: https://github.com/ar-io/ar-io-node/pull/64
[PR 62]: https://github.com/ar-io/ar-io-node/pull/62
[PR 61]: https://github.com/ar-io/ar-io-node/pull/61
[PR 60]: https://github.com/ar-io/ar-io-node/pull/60
