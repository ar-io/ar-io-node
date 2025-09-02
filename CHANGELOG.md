# Change Log

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

### Changed

### Fixed

## [Release 48] - 2025-09-02

This is an optional release that introduces Turbo root transaction ID lookups,
DNS resolution for preferred chunk nodes, and automatic data item resolution
from chunks. These features continue the network's journey toward complete
independence from legacy infrastructure while improving retrieval performance
and reliability.

### Added

- Added Turbo root transaction ID source with configurable lookup order and
  circuit breakers (configurable via `ROOT_TX_INDEX_` environment variables),
  enabling efficient data item to root transaction resolution via Turbo's
  API with automatic failover handling.
- Added `chunks-data-item` data source option for retrieval orders that enables
  automatic data item resolution within ANS-104 bundles. When used in
  `ON_DEMAND_RETRIEVAL_ORDER` or `BACKGROUND_RETRIEVAL_ORDER`, this source
  transparently resolves data items to their root transactions and calculates
  correct byte ranges, allowing direct retrieval of data items from chunks
  without requiring separate data item indexing.
- Added DNS resolution for preferred chunk GET and POST nodes with automatic
  failover, enabling dynamic resolution of node hostnames to IP addresses with
  configurable refresh intervals.
- Added `X-AR-IO-Node-Release` header to all outbound HTTP requests for better
  network observability and version tracking.

### Changed

- Updated default `ON_DEMAND_RETRIEVAL_ORDER` from
  `trusted-gateways,chunks,tx-data,ar-io-network` to
  `trusted-gateways,ar-io-network,chunks-data-item,tx-data`, removing the
  deprecated `chunks` source and prioritizing AR.IO network retrieval.

## [Release 47] - 2025-08-25

This is an optional release that lays the groundwork for the gateway network to
become completely independent of the legacy arweave.net gateway by enabling
data item retrieval directly from chunks using root transaction ID lookups. It
also introduces comprehensive distributed tracing for improved observability.

### Added

- Added comprehensive OpenTelemetry distributed tracing with proper span linking
  across all data request operations, providing end-to-end visibility from HTTP
  requests through data source failovers, cache operations, and peer retrievals
  with hierarchical parent-child span relationships.
- Added `RootParentDataSource` and `Ans104OffsetSource` to enable retrieving
  data items by ID directly from chunks when only the root transaction ID is
  indexed, transparently resolving data items to their root transactions and
  calculating correct byte ranges within ANS-104 bundles (temporarily disabled
  pending additional offset sources).

### Changed

### Fixed

- Removed incorrect `Content-Digest` header from chunk endpoint which was
  misleadingly representing only chunk data hash instead of complete JSON
  response body hash (will be reintroduced with correct semantics).

## [Release 46] - 2025-08-18

This is a recommended release that introduces AR.IO network chunk retrieval with
cryptographic validation and enhanced observability. Gateway operators can now
retrieve chunks directly from AR.IO peers with the same security guarantees as
Arweave network chunks, significantly improving chunk caching and retrieval
performance.

### Added

- Added AR.IO network chunk source enabling chunk retrieval from AR.IO peers
  with weighted peer selection, retry logic, and cryptographic validation to
  prevent serving of corrupted or malicious data.
- Added comprehensive OpenTelemetry tracing for chunk retrieval operations
  providing visibility into performance, cache behavior, and source attribution
  across the entire pipeline.
- Added HEAD request support to `/chunk/{offset}` endpoint with ETag headers
  for efficient caching and conditional request handling with If-None-Match
  support.
- Added chunk source headers for traceability: `X-AR-IO-Chunk-Source-Type`
  indicating data source, `X-AR-IO-Chunk-Host` with peer hostname, and
  `X-Cache` for cache status.
- Added RFC 9530 `Content-Digest` header support for standard-compliant content
  integrity verification in data and chunk responses.
- Added configurable composite chunk sources with parallelism control via
  `CHUNK_DATA_RETRIEVAL_ORDER` and `CHUNK_METADATA_RETRIEVAL_ORDER` environment
  variables supporting comma-separated source ordering.
- Added OpenAPI documentation for `/ar-io/peers` endpoint.

### Changed

- Renamed `ar-io-peers` to `ar-io-network` as the preferred configuration name
  while maintaining backwards compatibility.
- Enhanced `/ar-io/peers` endpoint to include both data and chunk weights for
  AR.IO gateway peers.

### Fixed

- Fixed ArNS custom 404 pages to prevent incorrect ArNS headers from being
  propagated to other gateways.

## [Release 45] - 2025-08-11

This is an optional release that enhances chunk broadcasting with improved preferred
peer management, adds a hash-based partitioning filter for distributed data processing,
fixes ArNS basename cache refresh issues, and includes comprehensive documentation
improvements with a new glossary of AR.IO Node terminology.

### Added

- Added hash partitioning filter (`MatchHashPartition`) for distributing
  transaction and data item processing across multiple nodes with configurable
  partition ranges.
- Added comprehensive glossary documentation covering AR.IO Node terminology,
  concepts, and architectural components.

### Changed

- Improved chunk broadcasting preferred peer management with doubled default
  per-node queue depth threshold and ensured preferred peers are always
  prioritized first.
- Enhanced circuit breaker metrics with more detailed labels for better
  monitoring of data source failures.
- Improved ArNS resolution to properly propagate 404 errors from trusted
  gateway resolution (a more complete fix is coming in the next release).
- Expanded OTEL tracing to include ArNS cache operations for improved
  observability of name resolution and cache hydration.

### Fixed

- Fixed unreliable ArNS basename cache refreshes by adding retry logic for
  pagination failures and replacing p-debounce with timestamp-based debouncing
  for more predictable behavior.
- Fixed undefined headers handling in data requests.
- Fixed invalid cache hits by ensuring base64url encoded IDs are properly
  validated before use.
- Fixed routes data handling for undefined IDs in validity checks.

## [Release 44] - 2025-07-28

This is a recommended release that introduces efficient range request support
for contiguous data retrieval from chunks, adds bundle metadata columns with
offset indexing to improve offset availability throughout the network, enhances
Merkle path parsing compatibility, and includes comprehensive documentation for
offsets and Merkle paths.

### Added

- Added efficient range request support for chunk data retrieval, enabling
  optimized verifiable contiguous data fetching directly from Arweave nodes.
- Added bundle metadata columns to `data.db` to improve offset availability
  across the gateway network.
- Added OTEL (OpenTelemetry) tracing support for chunk POST operations,
  providing better observability for chunk broadcasting performance.
- Added OTEL environment variables to `docker-compose.yaml` for easier
  configuration of distributed tracing.
- Added comprehensive Arweave Merkle tree structure documentation detailing
  the data organization and validation rules.
- Added detailed documentation explaining Arweave transaction and chunk offset
  calculations.
- Added merkle-path-parser with full Arweave compatibility for improved
  Merkle proof validation.

### Changed

- Implemented promise-based chunk caching system replacing the previous WeakMap
  implementation, improving memory efficiency and cache reliability.
- Extended CompositeChunkSource to implement all chunk interfaces, providing
  a more unified chunk data access layer.

## [Release 43] - 2025-07-21

This is a recommended release that enables data verification by default for data
items linked to ArNS names, improves chunk broadcasting efficiency, and adds
automatic chunk data cache cleanup.

### Added

- Added automatic chunk data cache cleanup functionality with configurable
  retention period. Chunks are now automatically removed after 4 hours by default
  (configurable via `CHUNK_DATA_CACHE_CLEANUP_THRESHOLD`). The cleanup can be
  disabled by setting `ENABLE_CHUNK_DATA_CACHE_CLEANUP=false`. This helps manage
  disk space usage while maintaining cache performance benefits.
- Added demand-driven opt-out background verification for ArNS data. When ArNS
  names are requested, the system now proactively verifies the underlying data
  asynchronously in the background by unbundling verified chunk data retrieved
  directly from Arweave nodes. This ensures ArNS-served content is prioritized
  for verification, improving data integrity guarantees for frequently accessed
  named content.

### Changed

- Simplified chunk data storage by removing the dual-storage approach (by-hash
  and by-dataroot with symlinks). Chunks are now stored directly by data root
  only, reducing complexity and improving performance.
- Revamped chunk broadcasting architecture from 3-tier system to unified
  peer-based approach. Chunk broadcasting now uses individual fastq queues per
  peer with configurable concurrency and queue depth protection. Added support
  for preferred chunk POST peers via `PREFERRED_CHUNK_POST_URLS` environment
  variable. Configuration defaults have been optimized:
  `CHUNK_POST_PEER_CONCURRENCY` now defaults to match
  `CHUNK_POST_MIN_SUCCESS_COUNT` (3) to avoid over-broadcasting, and
  `CHUNK_POST_PER_NODE_CONCURRENCY` defaults to match
  `CHUNK_POST_QUEUE_DEPTH_THRESHOLD` (10) for consistent per-node load
  management. This change improves broadcast reliability and performance while
  simplifying the codebase by removing circuit breakers and tier-based logic.
- Modified `DataVerificationWorker` to ensure data item IDs (not just root IDs)
  have their retry count incremented, preventing IDs from being stuck without
  retry attempts. This improves the reliability of the data verification
  process.

### Fixed

- Fixed experiment bash Parquet export script generating filenames with
  `count_star()` instead of actual row counts for blocks and tags files. The
  script now correctly uses the `-noheader` flag when retrieving counts for
  filename generation.
- Fixed missing directory existence checks in FsCleanupWorker to prevent errors
  when attempting to scan non-existent directories during filesystem cleanup
  operations.

## [Release 42] - 2025-07-14

This is an optional release that improves peer request traceability, adds
HyperBEAM URL support, and includes draft AI-generated technical documentation.

### Added

- Added support for optional HyperBEAM URL configuration via
  `AO_ANT_HYPERBEAM_URL` environment variable. In the future this allows ANT
  processes to use HyperBEAM nodes for caching and serving state, reducing
  pressure on compute units for simple read requests.
- Added AI-generated technical documentation covering AR.IO gateway
  architecture, data retrieval, Arweave connectivity, ArNS name resolution
  system, centralization analysis, and database architecture. These guides in
  `docs/drafts/` are generally correct but should not be considered
  authoritative.
- Added origin and release information to query string parameters in outbound
  requests to both peer gateways and trusted gateways. Data requests now
  include `ar-io-hops`, `ar-io-origin`, `ar-io-origin-release`,
  `ar-io-arns-record`, and `ar-io-arns-basename` as query parameters,
  improving network observability and request tracing across the entire
  gateway network.

### Changed

- Implemented X-AR-IO header initialization for outbound peer requests while
  removing `x-ar-io-origin` and `x-ar-io-origin-node-release` headers from
  responses. This change maintains necessary header functionality for peer
  communication while reducing unnecessary header overhead in responses.
- Updated `@ar.io/sdk` dependency to support optional HyperBEAM URL
  functionality.

## [Release 41] - 2025-06-30

Upgrading to this release is recommended but not urgent due to improvements in
peer data fetching safety.

### Added

- Added preferred chunk GET node URLs configuration via
  `PREFERRED_CHUNK_GET_NODE_URLS` environment variable to enable chunk-specific
  peer prioritization. Preferred URLs receive a weight of 100 for
  prioritization and the system selects 10 peers per attempt by default.
- Added hash validation for peer data fetching by including
  `X-AR-IO-Expected-Digest` header in peer requests when hash is available,
  validating peer responses against expected hash, and immediately rejecting
  mismatched data.
- Added `DOCKER_NETWORK_NAME` environment variable to configure the Docker
  network name used by Docker Compose.
- Added draft guide for running a community gateway.
- Added draft data verification architecture document.

### Changed

- Removed trusted node fallback for chunk retrieval. Chunks are now retrieved
  exclusively from peers, with the retry count increased from 3 to 50 to ensure
  reliability without the trusted node fallback.

### Fixed

- Fixed inverted logic preventing symlink creation in `FsChunkDataStore`.
- Fixed `Content-Length` header for range requests and 304 responses, properly
  setting header for single and multipart range requests and removing entity
  headers from 304 Not Modified responses per RFC 7232.
- Fixed `MaxListenersExceeded` warnings by adding `setMaxListeners` to
  read-through data cache.
- Fixed potential memory leaks in read-through data cache by using `once`
  instead of `on` for `error` and `end` event listeners.

## [Release 40] - 2025-06-23

This is an optional release that primarily improves caching when data is
fetched from peers.

### Added

- Added experimental `flush-to-stable` script for manual database maintenance.
  This script allows operators to manually flush stable chain and data item
  tables, mirroring the logic of
  `StandaloneSqliteDatabase.flushStableDataItems`.
  **WARNING: This script is experimental and directly modifies database contents.
  Use with caution and ensure proper backups before running.**

### Changed

- Replaced yesql with custom SQL loader that handles comments better, improving
  SQL file parsing and maintenance.
- Switched to SPDX license headers to reduce LLM token usage, making the
  codebase more efficient for AI-assisted development.
- Improved untrusted data handling and hash validation in cache operations. The
  cache now allows caching when a hash is available for validation even for
  untrusted data sources, but only finalizes the cache when the computed hash
  matches a known trusted hash. This prevents cache poisoning while still
  allowing data caching from untrusted sources when the data can be validated.

## [Release 39] - 2025-06-17

This release enhances observability and reliability with new cache metrics,
improved data verification capabilities, and automatic failover between chain
data sources. The addition of ArNS-aware headers enables better data
prioritization across the gateway network. This is a recommended but not urgent
upgrade.

### Added

- Added filesystem cache metrics with cycle-based tracking. Two new Prometheus
  metrics track cache utilization: `cache_objects_total` (number of objects in
  cache) and `cache_size_bytes` (total cache size in bytes). Both metrics include
  `store_type` and `data_type` labels to differentiate between cache types (e.g.,
  headers, contiguous_data). Metrics are updated after each complete cache scan
  cycle, providing accurate visibility into filesystem cache usage.
- Added `X-AR-IO-Data-Id` header to all data responses. This header shows the
  actual data ID being served, whether from a direct ID request or manifest path
  resolution, providing transparency about the content being delivered.
- Added automatic data item indexing when data verification is enabled. When
  `ENABLE_BACKGROUND_DATA_VERIFICATION` is set to true, the system now
  automatically enables data item indexing (`ANS104_UNBUNDLE_FILTER`) with an
  `always: true` filter if no filter is explicitly configured. This ensures
  bundles are unbundled to verify that data items are actually contained in
  the bundle associated with the Arweave transaction's data root.
- Added ArNS headers to outbound gateway requests to enable data prioritization.
  The `generateRequestAttributes` function now includes ArNS context headers
  (`X-ArNS-Name`, `X-ArNS-Basename`, `X-ArNS-Record`) in requests to other
  gateways and Arweave nodes, allowing downstream gateways to effectively
  prioritize ArNS data requests.
- Added configurable Docker Compose host port environment variables
  (`CORE_PORT`, `ENVOY_PORT`, `CLICKHOUSE_PORT`, `CLICKHOUSE_PORT_2`,
  `CLICKHOUSE_PORT_3`, `OBSERVER_PORT`) to allow flexible port mapping while
  maintaining container-internal port compatibility and security.
- Added Envoy aggregate cluster configuration for automatic failover between
  primary and fallback chain data sources. The primary cluster (default:
  arweave.net:443) uses passive outlier detection while the fallback cluster
  (default: peers.arweave.xyz:1984) uses active health checks. This enables
  zero-downtime failover between HTTPS and HTTP endpoints with configurable
  `FALLBACK_NODE_HOST` and `FALLBACK_NODE_PORT` environment variables.

### Changed

- Streamlined background data retrieval to reduce reliance on centralized sources.
  The default `BACKGROUND_RETRIEVAL_ORDER` now only includes `chunks,s3`, removing
  `trusted-gateways` and `tx-data` from the default configuration. This prioritizes
  verifiable chunk data and S3 storage for background operations like unbundling.
- Removed ar-io.net from default trusted gateways list and removed
  TRUSTED_GATEWAY_URL default value to reduce load on ar-io.net now that P2P data
  retrieval is re-enabled. Existing deployments with TRUSTED_GATEWAY_URL
  explicitly set will continue to work for backwards compatibility.

## [Release 38] - 2025-06-09

This release focuses on data integrity and security improvements, introducing
trusted data verification and enhanced header information for data requests.
Upgrading to this release is recommended but not urgent.

### Added

- Added `X-AR-IO-Trusted` header to indicate data source trustworthiness in
  responses. This header helps clients understand whether data comes from a
  trusted source and works alongside the existing `X-AR-IO-Verified` header to
  provide data integrity information. The system now filters peer data by
  requiring peers to indicate their content is either verified or trusted,
  protecting against misconfigured peers that may inadvertently serve
  unintended content (e.g., provider default landing pages) instead of actual
  Arweave data.
- Added If-None-Match header support for HTTP conditional requests enabling
  better client-side caching efficiency. When clients send an If-None-Match
  header that matches the ETag, the gateway returns a 304 Not Modified response
  with an empty body, reducing bandwidth usage and improving performance.
- Added digest and hash headers for data HEAD requests to enable client-side
  data integrity verification.
- Added EC2 IMDS (instance-profile) credential support for S3 data access,
  improving AWS authentication in cloud environments.
- Added trusted data flag to prevent caching of data from untrusted sources,
  ensuring only verified and reliable content is stored locally while still
  allowing serving of untrusted data when necessary.

### Changed

- Re-enabled ar-io-peers as fallback data source in configuration for improved
  data availability.
- Updated trusted node configuration to use arweave.net as the default trusted
  node URL.
- Updated ETag header format to use properly quoted strings (e.g., `"hash"`
  instead of `hash`) following HTTP/1.1 specification standards for improved
  compatibility with caching proxies and clients.

## [Release 37] - 2025-06-03

This is a _recommended release_ due to the included observer robustness
improvements. It also adds an important new feature - data verification for
preferred ArNS names. When preferred ArNS names are set, the bundles containing
the data they point to will be locally unbundled (verifying data item
signatures), and the data root for the bundle will be compared to the data root
in the Arweave chain (establishing that the data is on Arweave). To enable this
feature, set your preferred ArNS names, turn on unbundling by setting
`ANS104_DOWNLOAD_WORKERS` and `ANS104_UNBUNDLE_WORKERS` both to 1, and set your
`ANS104_INDEX_FILTER` to a filter that will match the data items for your
preferred names. If you don't know the filter, use `{"always": true}`, but be
aware this will index the entire bundle for the IDs related to your preferred
names.

Note: this release contains migrations to `data.db`. If your node appears
unresponsive please check `core` service logs to determine whether migrations
are running and wait for them to finish.

### Added

- Added prioritized data verification system for preferred ArNS names,
  focusing computational resources on high-priority content while enabling
  flexible root transaction discovery through GraphQL fallback support.
- Added verification retry prioritization system with tracking of retry counts,
  priority levels, and attempt timestamps to ensure bundles do not get stuck
  retrying forever.
- Added improved observer functionality with best-of-2 observations and higher
  compression for more reliable network monitoring.
- Added `MAX_VERIFICATION_RETRIES` environment variable (default: 5) to limit
  verification retry attempts and prevent infinite loops for consistently
  failing data items.
- Added retry logic with exponential backoff for GraphQL queries to handle rate
  limiting (429) and server errors with improved resilience when querying
  trusted gateways for root bundle IDs.

### Changed

- Updated dependencies: replaced deprecated express-prometheus-middleware with
  the actively maintained express-prom-bundle library and updated prom-client
  to v15.1.3 for better compatibility and security.
- Updated Linux setup documentation to use modern package installation methods,
  replacing apt-key yarn installation with npm global install and updating
  Node.js/nvm versions.
- Improved route metrics normalization with explicit whitelist function for
  better granularity and proper handling of dynamic segments.

### Fixed

- Fixed docker-compose configuration to use correct NODE_MAX_OLD_SPACE_SIZE
  environment variable name.
- Fixed production TypeScript build configuration to exclude correct "test"
  directory path.
- Fixed Parquet exporter to properly handle data item block_transaction_index
  exports, preventing NULL value issues.
- Fixed bundles system to copy root_parent_offset when flushing data items to
  maintain data integrity.
- Fixed ClickHouse auto-import script to handle Parquet export not_started
  status properly.
- Fixed docker-compose ClickHouse configuration to not pass conflicting
  PARQUET_PATH environment variable to container scripts.
- Fixed verification process for data items that have not been unbundled by
  adding queue bundle support and removing bundle join constraint to ensure
  proper verification of data items without indexed root parents.

## [Release 36] - 2025-05-27

This is a recommended but not essential upgrade. The most important changes are
the preferred ArNS caching feature for improved performance on frequently
accessed content and the observer's 80% failure threshold to prevent invalid
reports during network issues.

### Added

- Added preferred ArNS caching functionality that allows configuring lists of
  ArNS names to be cached longer via `PREFERRED_ARNS_NAMES` and
  `PREFERRED_ARNS_BASE_NAMES` environment variables. When configured, these names
  will be cleaned from the filesystem cache after
  `PREFERRED_ARNS_CONTIGUOUS_DATA_CACHE_CLEANUP_THRESHOLD` instead of the
  standard cleanup threshold (`CONTIGUOUS_DATA_CACHE_CLEANUP_THRESHOLD`). This
  is accomplished by maintaining an MRU (Most Recently Used) list of ArNS names
  in the contiguous metadata cache. When filesystem cleanup runs, it checks
  this list to determine which cleanup threshold to apply. This feature enables
  gateway operators to ensure popular or important ArNS names remain cached
  longer, improving performance for frequently accessed content.
- Added ArNS headers to responses: `X-ArNS-Name`, `X-ArNS-Basename`, and
  `X-ArNS-Record` to help identify which ArNS names were used in the resolution.

### Changed

- Updated observer to prevent report submission when failure rate exceeds 80%.
  This threshold helps guard against both poorly operated observers and
  widespread network issues. In the case of a widespread network issue, the
  assumption is that most gateway operators are well intentioned and will work
  together to troubleshoot and restore both observations and network stability,
  rather than submitting reports that would penalize functioning gateways.
- Updated default trusted gateway in docker-compose Envoy configuration to
  ar-io.net for improved robustness and alignment with core service
  configuration.
- Improved range request performance by passing ranges directly to getData
  implementations rather than streaming all data and extracting ranges.

### Fixed

- Fixed missing cache headers (`X-Cache` and other data headers) in range
  request responses to ensure consistent cache header behavior across all request
  types.
- Fixed async streaming for multipart range requests by using async iteration
  instead of synchronous reads, preventing potential data loss.
- Fixed ArNS resolution to properly exclude www subdomain from resolution
  logic.
- Fixed test reliability issues by properly awaiting stream completion before
  making assertions.
- Fixed chunk broadcasting to not await peer broadcasts, as they are
  best-effort operations.

## [Release 35] - 2025-05-19

This is a low upgrade priority release. It contains a small caching improvement
and routing fix. Upgrading to help test it is appreciated but not essential.

### Changed

- Adjusted filesystem data expiration to be based on last request times rather
  than file access times which may be inaccurate.
- Adjusted CORS headers to include `content-*` headers.

### Fixed

- Fixed regex used to expose `/api-docs` when an apex ArNS name is set.

## [Release 34] - 2025-05-05

Given the resilience provided by adding a second trusted gateway URL, it is
recommended that everyone upgrade to this release.

### Added

- Added peer list endpoints for retrieving information about Arweave peers and
  ar.io gateway peers.
- Added ar-io.net as a secondary trusted gateway to increase data retrieval
  resilience by eliminating a single point of failure.
- Added circuit breaker for Arweave peer chunk posting.

### Changed

- Created directories for DuckDB and Parquet to help avoid permission issues
  by the directories being created by containers.

### Fixed

- Fixed GraphQL ClickHouse error when returning block ID and timestamp.
- Fixed the tx-chunks-data-source to throw a proper error (resulting in a 404)
  when the first chunk is missing rather than streaming a partial response.

## [Release 33] - 2025-05-05

### Added

- Added a [Parquet and ClickHouse usage guide]. Using ArDrive as an example, it
  provides step by step instructions about how to bulk load Parquet and
  configure continuous ingest of bundled data items into ClickHouse. This
  allows the ar-io-node to support performant GraphQL queries on larger data
  sets and fascilitates sharing indexing work across gateways via distribution
  of Parquet files.
- Added support for configurable ArNS 404 pages using either:
  - `ARNS_NOT_FOUND_TX_ID`: Transaction ID for custom 404 content
  - `ARNS_NOT_FOUND_ARNS_NAME`: ArNS name to resolve for 404 content
- Added experimental `/chunk/<offset>` GET route for serving chunk data by
  absolute offset either the local cache.
- Added support for `AWS_SESSION_TOKEN` in the S3 client configuration.
- Expanded ArNS OTEL tracing to improve resolution behavior observability.
- Added support for setting a ClickHouse username and password via the
  `CLICKHOUSE_USERNAME` and `CLICKHOUSE_PASSWORD` environment variable. When
  using ClickHouse, `CLICKHOUSE_PASSWORD` should always be set. However,
  `CLICKHOUSE_USERNAME` can be left unset. The username `default` will be used
  in that case.
- Added support for configuring the port used to connect to ClickHouse via
  the `CLICKHOUSE_PORT` environment variable.

### Changed

- Disabled ClickHouse import timing logging by default. It can be enabled via
  environment variable - `DEBUG` when running the service standalone or
  `CLICKHOUSE_DEBUG` when using Docker Compose
- Upgraded to ClickHouse 25.4.

### Fixed

- Ensure `.env` is read in `clickhouse-import` script.

## [Release 32] - 2025-04-22

### Changed

- Reenabled parallel ArNS resolution with removal of misplaced global limit.
  Refer to release 30 notes for more details on configuration and rationale.
- Added a timeout for the last ArNS resolver in `ARNS_RESOLVER_PRIORITY_ORDER`.
  It defaults to 30 seconds and is configurable using
  `ARNS_COMPOSITE_LAST_RESOLVER_TIMEOUT_MS`. This helps prevent promise build
  up if the last resolver stalls.

### Fixed

- Fixed apex ArNS name handling when a subdomain is present in
  `ARNS_ROOT_HOST`.
- Fixed a case where fork recovery could stall due to early flushing of
  unstable chain data.
- Restored observer logs by removing unintentional default log level override
  in `docker-compose.yaml`.

## [Release 31] - 2025-04-11

### Changed

- Improved peer TX header fetching by fetching from a wider range of peers and
  up/down weighting peers based on success/failure.

### Fixed

- Rolled back parallel ArNS resolution changes that were causing ArNS
  resolution to slow down over time.

## [Release 30] - 2025-04-04

### Added

- Added support for filtering Winston logs with a new `LOG_FILTER` environment
  variable.
  - Example filter: `{"attributes":{"class":"ArweaveCompositeClient"}}` to only
    show logs from that class.
  - Use `CORE_LOG_FILTER` environment variable when running with
    docker-compose.
- Added parallel ArNS resolution capability.
  - Configured via `ARNS_MAX_CONCURRENT_RESOLUTIONS` (default: 1).
  - This foundation enables future enhancements to ArNS resolution and should
    generally not be adjusted at present.

### Changed

- Improved ClickHouse auto-import script with better error handling and
  continuous operation through errors.
- Reduced maximum header request rate per second to trusted node to load on
  community gateways.
- Optimized single owner and recipient queries on ClickHouse with specialized
  sorted tables.
- Used ID sorted ClickHouse table for ID queries to improve performance.

### Fixed

- Fixed data alignment in Parquet file name height boundaries to ensure
  consistent import boundaries.
- Removed trailing slashes from AO URLs to prevent issues when passing them to
  the SDK.
- Only prune SQLite data when ClickHouse import succeeds to prevent data loss
  during exports.

## [Release 29] - 2025-03-21

### Changed

- Temporarily default to trusted gateway ArNS resolution to reduce CU load as
  much possible. On-demand CU resolution is still available as a fallback and
  the order can be modified by setting `ARNS_RESOLVER_PRIORITY_ORDER`.
- Remove duplicate network process call in on-demand resolver.
- Don't wait for network process debounces in the on-demand resolver.
- Slow network process dry runs no longer block fallback to next resolver.

### Added

- Added support for separate CUs URLs for the network and ANT processes via the
  `NETWORK_AO_CU_URL` and `ANT_AO_CU_URL` process URLs respectively. If either
  is missing the `AO_CU_URL` is used instead with a fallback to the SDK default
  URL if `AO_CU_URL` is also unspecified.
- Added CU URLs to on-demand ArNS resolver logs.
- Added circuit breakers for AR.IO network process CU dry runs. By default
  they use a 1 minute timeout and open after 30% failure over a 10 minute
  window and reset after 20 minutes.

### Fixed

- Owners in GraphQL results are now correctly retrieved from data based on
  offsets when using ClickHouse.

## [Release 28] - 2025-03-17

### Changed

- Raised name not found name list refresh interval to 2 minutes to reduce load
  on CUs. This increases the maximum amount of time a user may wait for a new
  name to be available. Future releases will introduce other changes to
  mitigate this delay.
- Adjusted composite ArNS resolver to never timeout resolutions from the last
  ArNS resolver in the resolution list.

### Added

- Added support for serving a given ID or ArNS name from the apex domain of a
  gateway. If using an ID, set the `APEX_TX_ID` environment variable. If using
  an ArNS name, set the `APEX_ARNS_NAME` environment variable.
- Added `BUNDLE_REPAIR_UPDATE_TIMESTAMPS_INTERVAL_SECONDS`,
  `BUNDLE_REPAIR_BACKFILL_INTERVAL_SECONDS`, and
  `BUNDLE_REPAIR_FILTER_REPROCESS_INTERVAL_SECONDS` environment variables to
  control the interval for retrying failed bundles, backfilling bundle records,
  and reprocessing bundles after a filter change. Note: the latter two are
  rairly used. Queuing bundles for reprocessing via the
  `/ar-io/admin/queue-bundle` endpoint is usually preferrable to automatic
  reprocessing as it is faster and offers more control over the reprocessing
  behavior.

### Fixed

- Signatures in GraphQL results are now correctly retrieved from data based on
  offsets when using ClickHouse.
- Adjusted exported Parquet file names to align with expectations of ClickHouse
  import script.
- Ensured that bundle indexing status is properly reset when bundles are
  manually queued after an unbundling filture change has been made.

## [Release 27] - 2025-02-20

### Changed

- Set process IDs for mainnet.
- Increase default AO CU WASM memory limit to 17179869184 to support mainnet
  process.

## [Release 26] - 2025-02-13

### Added

- Added a per resolver timeout in the composite ArNS resolver. When the
  composite resolver attempts resolution it is applied to each resolution
  attempt. It is configurable via the `ARNS_COMPOSITE_RESOLVER_TIMEOUT_MS` and
  defaults to 3 seconds in order to allow a fallback attempt before the default
  observer timeout of 5 seconds.
- Added a `TURBO_UPLOAD_SERVICE_URL` environment variable to support
  configuration of the bundler used by the observer (TurboSDK defaults are
  used if not set).
- Added a `REPORT_DATA_SINK` environment variable that enables switching the
  method used to post observer reports. With the default, `turbo`, it sends
  data items via a Turbo compatible bundler. Switching it to `arweave` will
  post base layer transactions directly to Arweave instead.
- Added a `/ar-io/admin/bundle-status/<id>` endpoint that returns the counters
  and timestamps from the `bundles` row in `data.db`. This can be used for
  monitoring unbundling progress and scripting (e.g., to skip requeuing already
  queued bundles).
- Added more complete [documentation](docs/filters.md) for filters.

### Changed

- Use arweave.net as the default GraphQL URL for AO CUs since most gateways
  will not have a complete local AO data item index.
- Use a default timeout of 5 seconds when refreshing Arweave peers to prevent
  stalled peer refreshes.
- Cache selected gateway peer weights for the amount of time specified by the
  `GATEWAY_PEERS_WEIGHTS_CACHE_DURATION_MS` environment variable with a default
  of 5 seconds to avoid expensive peer weight recomputation on each request.
- Chunk broadcasts to primary nodes occur in parallel with a concurrency limit
  defaulting to 2 and configurable via the `CHUNK_POST_CONCURRENCY_LIMIT`
  environment variable.
- Added circuit breakers for primary chunk node POSTs to avoid overwhelming
  chunk nodes when they are slow to respond.

### Fixed

- Properly cleanup timeout and event listener when terminating the data
  root computation worker.
- Count chunk broadcast exceptions as errors in the
  `arweave_chunk_broadcast_total` metric.

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
  the `BACKGROUND_DATA_VERIFICATION_INTERVAL_SECONDS` environment variable.
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

- Fix data caching failure caused by incorrect method name in getData\* circuit
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

[Parquet and ClickHouse usage guide]: ./docs/parquet-and-clickhouse-usage.md
[PR 68]: https://github.com/ar-io/ar-io-node/pull/68
[PR 65]: https://github.com/ar-io/ar-io-node/pull/65
[PR 64]: https://github.com/ar-io/ar-io-node/pull/64
[PR 62]: https://github.com/ar-io/ar-io-node/pull/62
[PR 61]: https://github.com/ar-io/ar-io-node/pull/61
[PR 60]: https://github.com/ar-io/ar-io-node/pull/60
