# Change Log

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- **Block Search Optimization**: Ship static offset-to-block mapping to optimize
  binary search when looking up transactions by offset
  - Reduces block search iterations from ~21 to ~15 (~29% reduction)
  - Most significant impact during cold starts when block caches are empty
  - Each saved iteration means one fewer network call to fetch a block
  - Includes generation tool (`tools/generate-offset-mapping`) for updating
    mapping before releases

- **tx_path Chunk Validation**: Optimize chunk retrieval with a DB-first lookup
  strategy that falls back to tx_path Merkle proof validation for unindexed data
  - Lookup order: Database (fastest) → tx_path validation → Chain binary search (slowest)
  - tx_path proofs are cryptographically validated against the block's tx_root
  - Eliminates expensive chain binary search when tx_path is available from peers

- **Chunk Cache by Absolute Offset**: Enable chunk cache lookups by absolute
  weave offset for faster retrieval when chunk data is already cached
  - Creates symlinks indexed by absolute offset for O(1) cache lookups
  - Background worker periodically cleans up dead symlinks when cached data expires
  - Configurable via `ENABLE_CHUNK_SYMLINK_CLEANUP` (default: true) and
    `CHUNK_SYMLINK_CLEANUP_INTERVAL` (default: 24 hours)

### Changed

- **AR.IO Peer Chunk Retrieval Optimization**: Improved chunk retrieval
  performance from AR.IO network peers
  - Reduced per-peer request timeout from 10 seconds to 1 second
  - Changed from sequential to parallel peer requests (3 peers raced simultaneously)
  - Reduced retry strategy from 5 attempts to 2 attempts with different peers
  - Selects all peers upfront to ensure different peers on each retry attempt
  - Worst-case latency reduced from ~150 seconds to ~4 seconds
  - Maximum peer requests reduced from 15 to 6

### Fixed

## [Release 59] - 2025-11-24

This is a **recommended release** due to important fixes for nested bundle data
item offset handling that could cause incorrect data retrieval. The release
fixes offset calculations in both the TurboDynamoDB data source and database
root TX lookups, ensuring correct data is served for deeply nested bundle
items. It also includes fixes for ArNS manifest path encoding and Observer
wallet failure reporting for shared FQDN gateways. New features include a
dry-run mode for testing transaction uploads without posting to the network,
and a monitoring tool for historical DHA chunk nodes.

### Added

- **Historical DHA Chunk Nodes Monitoring Tool**: New operator utility for
  monitoring response times and availability of Arweave data endpoints
  (`tools/monitor-historical-dha-chunk-nodes`)
  - Monitors data-N (1-17) and tip-N (1-5) endpoints with configurable ranges
  - Continuous monitoring mode with real-time table output and statistics
  - JSON export with detailed results and metadata
  - Note: This is a special-purpose tool included for reference and potential
    usefulness to operators debugging data retrieval issues

- **Dry-Run Mode for Upload Testing**: New `ARWEAVE_POST_DRY_RUN` environment
  variable enables testing transaction and chunk uploads without posting to the
  Arweave network
  - When enabled, both `POST /tx` and `POST /chunk` requests are simulated with
    200 OK responses
  - Works on both port 3000 (Envoy) and port 4000 (direct to Node.js app)
  - Envoy routing is conditional: routes to core for dry-run, to Arweave nodes
    when disabled
  - Perfect for testing apps like ArDrive and large uploads without burning AR
    tokens
  - By default, transactions are validated (signature verification) and chunks
    are validated (merkle proof verification) before returning success
  - Set `ARWEAVE_POST_DRY_RUN_SKIP_VALIDATION=true` to skip validation for faster
    testing
  - Only the final network broadcast is skipped

### Changed

- When CDP API keys are provided (`CDP_API_KEY_ID` and `CDP_API_KEY_SECRET`),
  the gateway now automatically uses the Coinbase facilitator with enhanced
  Onramp integration, overriding the `X_402_USDC_FACILITATOR_URL` setting

### Fixed

- **PostgreSQL SSL Configuration**: Fixed inverted SSL flag logic where
  `LEGACY_PSQL_SSL_REJECT_UNAUTHORIZED=true` (default) was incorrectly disabling
  certificate validation instead of enabling it
  - Now correctly applies strict SSL validation by default
  - Set to `false` to disable certificate validation for cloud providers with
    self-signed certificates

- **PostgreSQL Connection Timeouts**: Added timeout configuration for the legacy
  PostgreSQL chunk metadata source to prevent system hangs
  - Server-side `statement_timeout` (default: 5s) prevents queries from running
    forever
  - `idle_in_transaction_session_timeout` (default: 10s) cleans up stuck
    transactions
  - Connection pool settings: `max`, `idle_timeout`, `connect_timeout`,
    `max_lifetime`
  - All settings configurable via environment variables
    (`LEGACY_PSQL_STATEMENT_TIMEOUT_MS`, etc.)
  - Graceful Postgres connection cleanup on shutdown
  - Prevents the chunk serving system from becoming completely unresponsive when
    Postgres is slow or unreachable

- **Security Dependency Updates**: Fixed 6 security vulnerabilities identified by
  `yarn audit`
  - Added `tar@7.5.2` resolution to fix moderate severity race condition in
    duckdb-async dependency chain
  - Upgraded `@cucumber/cucumber`, `@testcontainers/localstack`, `testcontainers`,
    and `rimraf` to fix high severity glob CLI command injection vulnerabilities
  - Upgraded `viem` to ^2.39.3
  - All existing resolutions (secp256k1, elliptic, ws, semver) remain required for
    vulnerabilities in `@dha-team/arbundles` transitive dependencies

- **ArNS Manifest Path Encoding**: Fixed manifest paths with URL-encoded
  characters (e.g., spaces as `%20`) failing when accessed via ArNS subdomain
  - Direct TX ID access worked because Express auto-decodes `req.params`
  - ArNS subdomain access failed because `req.path` is not auto-decoded
  - Now decodes manifest paths in the ArNS middleware for consistent behavior
- **TurboDynamoDB Data Source**: Fixed nested bundle data items having incorrect
  `rootDataItemOffset` values when retrieved from Turbo's DynamoDB
  - The raw data path was overwriting correct absolute offsets cached from the
    `rootParentInfo` path with incorrect values (offset: 0, dataOffset: payloadDataStart)
  - Now preserves the correct offsets by only caching size and contentType from raw data
- **Database Root TX Offset Lookup**: Fixed `getRootTxFromData` returning incorrect
  offset for nested bundle data items
  - Was returning `root_parent_offset` (parent bundle offset) instead of
    `root_data_item_offset` (absolute data item offset)
  - Added fallback calculations for `rootDataItemOffset` and `rootDataOffset` when
    pre-computed values are NULL
- **Observer**: Updated to 2515e6a - Fixed incorrect wallet failure reporting
  for shared FQDN gateways
  - When multiple wallets share the same FQDN, now correctly identifies which
    specific wallets failed ownership verification
  - Reports non-matching wallets as failed even when gateway passes overall
  - Ensures save-observations contract interactions accurately reflect actual
    ownership failures
- BUNDLER_URLS environment variable was missing from docker-compose.yaml
- x402 payment processor now correctly uses Coinbase CDP facilitator when CDP
  credentials are configured

## [Release 58] - 2025-11-10

This is a **recommended release** due to significant improvements in data
retrieval efficiency and payment system reliability. This release introduces a
new raw binary chunk data endpoint providing ~40% bandwidth savings,
comprehensive rate limit balance management APIs, and intelligent OpenTelemetry
tail-based sampling for cost-effective observability. The release also includes
critical payment validation fixes and enhanced bundler service discovery for
improved client integration.

> **⚠️ EXPERIMENTAL FEATURES**: The rate limiter and x402 payment protocol are
> experimental features subject to change. API endpoints, parameters, behavior,
> and configuration options (environment variables) may evolve in future
> releases as these systems continue to be developed. See
> [docs/x402-and-rate-limiting.md](docs/x402-and-rate-limiting.md) for
> comprehensive documentation.

### Added

- **Raw Binary Chunk Data Endpoint**: New `/chunk/<offset>/data` endpoint
  returns raw binary chunk data (`application/octet-stream`) with metadata in
  response headers instead of base64url-encoded JSON
  - Provides ~40% bandwidth savings compared to the base64url-encoded
    `/chunk/<offset>` endpoint
  - Supports both GET and HEAD requests
  - Returns comprehensive metadata in custom headers:
    - `X-Arweave-Chunk-Data-Path` - Base64url-encoded merkle proof path for
      chunk verification
    - `X-Arweave-Chunk-Data-Root` - Merkle tree root hash
    - `X-Arweave-Chunk-Start-Offset` - Absolute start offset of chunk in the
      weave
    - `X-Arweave-Chunk-Relative-Start-Offset` - Chunk offset relative to its
      transaction's data
    - `X-Arweave-Chunk-Read-Offset` - Number of bytes to skip from the start
      of the returned chunk to reach the requested offset
    - `X-Arweave-Chunk-Tx-Data-Size` - Total data size of the transaction
      containing this chunk
    - `X-Arweave-Chunk-Tx-Id` - Transaction ID containing this chunk
    - `X-Arweave-Chunk-Tx-Start-Offset` - Absolute start offset of the
      transaction in the weave
    - `X-Arweave-Chunk-Tx-Path` - Transaction-level merkle path (when available)
    - `X-Arweave-Chunk-Source` - Data source identifier (e.g., `arweave`,
      `trusted-gateway`)
    - `X-Arweave-Chunk-Source-Version` - Version identifier of the data source
  - Supports ETag-based conditional requests (304 Not Modified)
  - Supports `Content-Digest` header (RFC 9530) for data integrity verification
  - Rate limited at 256 KiB (raw chunk size) vs. 360 KiB for base64url
    endpoint, resulting in lower per-chunk fees
- **Bundler Service Discovery**: The `/ar-io/info` endpoint now includes a
  `bundlers` field for client service discovery
  - Configurable via `BUNDLER_URLS` environment variable (comma-separated URLs)
  - Defaults to `https://turbo.ardrive.io/`
  - URLs are validated on startup with descriptive error messages
  - Returns array of objects with `url` property
  - Enables clients to discover available bundler services for data uploads
- **Rate Limit Balance Management API**: New REST API endpoints for querying
  and managing rate limit bucket balances
  - `GET /ar-io/rate-limit/ip/:ip` - Query IP-based rate limit bucket balance
  - `POST /ar-io/rate-limit/ip/:ip` - Top up IP-based bucket via x402 payment
    or admin API key
  - `GET /ar-io/rate-limit/resource` - Query resource-based bucket balance with
    optional query parameters (`method`, `resource`, `host`)
  - `POST /ar-io/rate-limit/resource` - Top up resource-based bucket via x402
    payment or admin API key
  - Dual authentication: x402 payment protocol (public) or admin API key
    (private/testing via `ADMIN_API_KEY` environment variable)
  - 10x capacity multiplier applied to x402 payments compared to raw admin
    top-ups
  - Smart defaults for resource endpoints (method defaults to GET, host
    defaults to current request host)
  - Enables programmatic balance queries and top-ups for testing and automated
    payment workflows
- **OpenTelemetry Collector with Tail-Based Sampling** ⚠️ **EXPERIMENTAL**: New
  OTEL Collector sidecar in docker-compose deployments implements intelligent
  tail-based sampling to reduce telemetry costs by 80-95% while maintaining
  complete visibility into errors, performance issues, and paid traffic. This
  feature is experimental and subject to change in future releases
  - Five intelligent sampling policies make decisions after traces complete:
    - 100% of traces with errors (5xx responses, exceptions)
    - 100% of slow requests exceeding configurable threshold (default: 2 seconds)
    - 100% of x402 verified payment requests for billing and compliance
    - 100% of paid rate limit token usage for revenue tracking
    - 1% (configurable) of successful, fast, unpaid requests for baseline metrics
  - Traces flow through architecture: ar-io-node → otel-collector → telemetry backend
  - Support for multiple telemetry backends via environment variables:
    - Honeycomb (`OTEL_COLLECTOR_HONEYCOMB_API_KEY`)
    - Grafana Cloud Tempo (`OTEL_COLLECTOR_GRAFANA_CLOUD_API_KEY`)
    - Datadog (`OTEL_COLLECTOR_DATADOG_API_KEY`)
    - New Relic (`OTEL_COLLECTOR_NEW_RELIC_API_KEY`)
    - Elastic APM (`OTEL_COLLECTOR_ELASTIC_API_KEY`)
  - Configurable sampling rates for each policy via environment variables:
    - `OTEL_TAIL_SAMPLING_SUCCESS_RATE` - Baseline success sampling (default: 1%)
    - `OTEL_TAIL_SAMPLING_SLOW_THRESHOLD_MS` - Slow request threshold (default: 2000ms)
    - `OTEL_TAIL_SAMPLING_ERROR_RATE` - Error sampling rate (default: 100%)
    - `OTEL_TAIL_SAMPLING_SLOW_RATE` - Slow request sampling rate (default: 100%)
    - `OTEL_TAIL_SAMPLING_PAID_TRAFFIC_RATE` - Paid traffic sampling (default: 100%)
    - `OTEL_TAIL_SAMPLING_PAID_TOKENS_RATE` - Paid token sampling (default: 100%)
  - Optional deployment via docker-compose profile (`docker compose --profile otel up`)
  - Set `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318` when using the
    profile, or configure it to send traces directly to an external backend to
    bypass the local collector
  - Enhanced span attributes for paid traffic tracking including client IP,
    payment verification status, and token consumption

### Changed

- **Chunk Request Routing**: Removed Envoy proxy route for GET `/chunk/`
  requests - all chunk endpoints now route directly to the AR.IO gateway
  application instead of being proxied to trusted Arweave nodes. This enables
  rate limiting, x402 payment processing, and local caching for chunk requests
- **Transaction-Level Merkle Path Support**: The `/chunk/<offset>` endpoint now
  includes `tx_path` in JSON responses when available (both GET and HEAD
  requests), providing transaction-level merkle proofs
- **Observer**: Updated to fcd0f36 - Doubled offset observation sample rate to
  2% for improved network robustness
- **AR.IO Info Endpoint Structure**: The `bundlers` field in `/ar-io/info`
  endpoint response is now nested under `services.bundlers` instead of being a
  top-level field for improved API organization and future extensibility
- **Rate Limiter Bucket Keys**: Standardized bucket key format across Redis and
  Memory rate limiter implementations - extracted shared utility functions to
  `src/limiter/utils.ts` for consistent key generation
- **Browser Paywall for Chunk Requests**: Optimized payment flow for chunk
  endpoints (`/chunk/*`) in browser paywall mode to use direct URL payment
  instead of redirect endpoint
  - **Browser only**: This optimization only affects requests detected as browser
    requests (Accept includes text/html AND User-Agent includes Mozilla)
  - **API flows unchanged**: Programmatic API payments continue to work the same
    way for all endpoints
  - Reduces latency by eliminating redirect round-trip for small chunk requests
  - Paywall sends payment directly to original chunk URL with x-payment header
  - Payment verification, settlement, and token granting happen inline before
    serving content
  - Other browser endpoints (transactions, manifests) continue using redirect
    endpoint for larger content
  - Both approaches use the same payment verification and settlement process

### Documentation

- Updated OpenAPI specification with comprehensive documentation for new
  `/chunk/<offset>/data` endpoint (GET and HEAD methods)
- Improved OpenAPI specification with complete header documentation for
  transaction data and chunk endpoints, including ANS-104 bundle navigation
  headers, data verification headers, and detailed examples with offset
  calculations
- Updated rate limiting documentation to include both chunk endpoint pricing
  models
- Updated glossary to reference both chunk endpoint formats
- Updated x402 and rate limiting documentation to explain chunk-specific direct
  payment flow and general redirect flow for browser paywall requests

### Fixed

- **Payment Processor and x402 Validation**: Multiple improvements to payment
  validation and error handling
  - Prevent infinite redirect loop on payment failure - browser paywall now
    shows user-friendly error page instead of redirecting
  - Validate payment type before settlement to prevent charging users without
    granting rate limit tokens
  - Prevent silent success when payment settlement cannot grant tokens - now
    returns error instead of charging without providing service
  - Validate resource target format before settling payment to prevent invalid
    payment processing
  - Validate Host header presence and format before processing payments to
    prevent malformed payment requests
  - Use configured capacity multiplier instead of hardcoded value in payment
    processor for consistent multiplier application
  - Update paywall redirect URL to use new canonical path for consistency with
    updated route structure
- **Rate Limiter Configuration**: Fixed configuration handling for consistent behavior
  - Ensure consistent resource key normalization across Redis and Memory rate
    limiter implementations to prevent cache misses
  - Use configurable capacity multiplier in rate limit routes instead of
    hardcoded values for consistency with payment processor

## [Release 57] - 2025-11-03

This is a **recommended release**. This release focuses on improving gateway
infrastructure with enhanced CDN compatibility and a new gateway-based offset
discovery system. Key improvements include a new root transaction index using
HEAD requests to AR.IO gateways, configurable Cache-Control headers for better
CDN integration, and numerous bug fixes for proxy support. The release also
includes extensive documentation improvements.

> **⚠️ EXPERIMENTAL FEATURES**: The rate limiter and x402 payment protocol are
> experimental features subject to change. API endpoints, parameters, behavior,
> and configuration options (environment variables) may evolve in future
> releases as these systems continue to be developed. See
> [docs/x402-and-rate-limiting.md](docs/x402-and-rate-limiting.md) for
> comprehensive documentation.

### Added

- **GatewaysRootTxIndex for Offset Discovery**: New root transaction index
  using HEAD requests to AR.IO gateways for discovering data item offsets
  - Multi-gateway support with priority tiers and automatic fallback (single
    attempt per gateway to prevent thundering herd)
  - Per-gateway rate limiting with TokenBucket
  - LRU caching for offset results
  - Configuration via `GATEWAYS_ROOT_TX_URLS`,
    `GATEWAYS_ROOT_TX_REQUEST_TIMEOUT_MS`,
    `GATEWAYS_ROOT_TX_RATE_LIMIT_BURST_SIZE`,
    `GATEWAYS_ROOT_TX_RATE_LIMIT_TOKENS_PER_INTERVAL`,
    `GATEWAYS_ROOT_TX_RATE_LIMIT_INTERVAL`, `GATEWAYS_ROOT_TX_CACHE_SIZE`
- **Configurable Cache-Control Private Directive**: CDN compatibility via
  `CACHE_PRIVATE_SIZE_THRESHOLD` (default: 100 MB) and
  `CACHE_PRIVATE_CONTENT_TYPES` environment variables
  - Adds `private` directive to Cache-Control headers for content exceeding
    size threshold or matching content types
  - Ensures rate limiting and x402 payment requirements are enforced even when
    CDNs are deployed in front of ar-io-node
- **Enhanced Rate Limiting Observability**: Client IP now logged separately in
  rate limit exceeded messages for better debugging and monitoring

### Fixed

- **Proxy Support Fixes**:
  - Fixed x402 resource URLs to use `SANDBOX_PROTOCOL` when behind reverse
    proxies/CDNs
  - Fixed inconsistent IP extraction between rate limiter bucket keys and
    allowlist checks
- **Chunk Endpoint Performance**: Apply rate limits before expensive txResult
  lookup
  - Reordered operations to check rate limits first, improving performance
    under high load
- **Cache-Control Content Type Matching**: Normalize content types by stripping
  parameters (e.g., `text/html; charset=utf-8` → `text/html`)
  - Ensures proper Cache-Control header matching for configured content types

### Documentation

- Comprehensive rate limiting documentation cleanup (~200-300 lines of
  duplication removed)
- Documented all 4 rate limit metrics (request, IP, chunk, x402 token
  consumption)
- Added automated payment workflow testing examples for x402
- Removed private key export recommendations from x402 testing examples
- Clarified complete IP extraction fallback order for proxy scenarios
- Clarified Cloudflare header extraction behavior
- Removed redundant mentions of x402 requiring rate limiter

## [Release 56] - 2025-10-27

This is a recommended release due to fixes for nested bundle offset
calculations.

This release continues the x402 payment protocol expansion from Release 55,
extending payment and rate limiting support to the chunk endpoint and adding
comprehensive operator documentation. The `/ar-io/info` endpoint now exposes
rate limiter and payment configuration for programmatic gateway discovery.
This release also includes important fixes for nested bundle offset calculations
that could affect data retrieval, making it a recommended upgrade for all
operators.

> **⚠️ EXPERIMENTAL FEATURES**: The rate limiter and x402 payment protocol are
> experimental features subject to change. API endpoints, parameters, behavior,
> and configuration options (environment variables) may evolve in future
> releases as these systems continue to be developed. See
> [docs/x402-and-rate-limiting.md](docs/x402-and-rate-limiting.md) for
> comprehensive documentation.

### Added

- **Chunk Endpoint Payment and Rate Limiting**: Added x402 payment and rate
  limiting support to `GET /chunk/:offset` endpoint for gateway monetization
  and traffic control:
  - Uses fixed size assumption (~360 KiB) for predictable pricing without
    waiting for chunk retrieval
  - Configurable via `CHUNK_GET_BASE64_SIZE_BYTES` environment variable
    (default: 368,640 bytes)
  - HEAD requests consume one token (to prevent spam)
  - 304 Not Modified responses consume one token (to prevent spam)
  - Compatible with all existing x402 and rate limiter configuration
- **Configuration Validation**: Added startup validation that ensures
  `ENABLE_RATE_LIMITER=true` when `ENABLE_X_402_USDC_DATA_EGRESS=true`. The
  application will fail to start with a clear error message if x402 is enabled
  without the rate limiter, since x402 payments require rate limiting to
  function (402 responses are only sent when rate limits are exceeded)
- **Gateway Info Endpoint**: The `/ar-io/info` endpoint now exposes rate limiter
  and x402 payment configuration when these features are enabled. This allows
  clients to programmatically discover gateway capabilities, pricing, and limits.
  New optional response fields:
  - `rateLimiter` - Per-resource and per-IP bucket capacities, refill rates, and
    byte convenience fields (when `ENABLE_RATE_LIMITER=true`)
  - `x402` - Payment network, wallet address, facilitator URL, per-byte pricing
    with min/max bounds, example costs for common sizes (1KB/1MB/1GB), and
    capacity multiplier for paid tier (when `ENABLE_X_402_USDC_DATA_EGRESS=true`)
- **x402 and Rate Limiter Documentation**: Added comprehensive operator guide at
  `docs/x402-and-rate-limiting.md` covering x402 payment protocol and rate
  limiting configuration:
  - Configuration via `.env` files with detailed examples
  - Secrets management using volume mounts for Coinbase Develop Program
    credentials
  - Complete list of rate limited endpoints including `GET /chunk/:offset`
  - Token consumption patterns and pricing models for all endpoints
  - Integration with x402 facilitator services
  - Testing and troubleshooting guidance
- **Coinbase Developer Platform Environment Variables**: Added environment
  variables for Coinbase Developer Platform (CDP) integration:
  - `CDP_API_KEY_ID` - CDP API key identifier
  - `CDP_API_KEY_SECRET` - CDP API secret key
  - `CDP_API_KEY_SECRET_FILE` - Load CDP secret from file for improved security

### Changed

- **Glossary**: Added new "Rate Limiter & x402 Payment Protocol" section
  consolidating related terms:
  - Facilitator - Payment verification and settlement service
  - Rate Limiter - Traffic control system overview
  - Rate Limiter Token Types - Paid vs regular token pools
  - Token Bucket Algorithm - Rate limiting algorithm details
  - x402 Protocol - HTTP 402 payment protocol definition
- **CDP Environment Variables**: Refactored Coinbase Developer Platform API key
  configuration:
  - Removed `X_402_CDP_CLIENT_KEY_FILE` (client key is public, doesn't need
    file-based loading)
  - Split into separate `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` variables
  - Added `CDP_API_KEY_SECRET_FILE` for secure file-based loading of sensitive
    API secret

### Fixed

- **Docker Compose Configuration**: Added `ENABLE_DATA_ITEM_ROOT_TX_SEARCH` and
  `ENABLE_PASSTHROUGH_WITHOUT_OFFSETS` environment variables to
  `docker-compose.yaml`, `.env.example`, and `docs/envs.md`. These options
  control offset-aware data source behavior and were previously only defined in
  `src/config.ts`, making them unavailable for Docker Compose users to configure
  via `.env` files
- **Data Handler Rate Limiting**: Fixed rate limiting for non-indexed data by:
  - Removing `dataAttributes !== undefined` check that prevented rate limiting
    before data indexing
  - Using `data.size` (always available) as primary source for content size
    calculation with fallback to `dataAttributes?.size`
  - Aligning content size calculation with actual `Content-Length` header values
  - Ensuring consistent rate limiting across all data endpoints (raw data,
    manifest, and bundled data)
- **Nested Bundle Data Item Offset Calculation**: Fixed multiple
  offset calculation issues affecting nested bundle data item retrieval:
  - Corrected Turbo DynamoDB dataOffset to use absolute semantics (offset +
    headerSize) instead of relative semantics, ensuring consistency with bundle
    parsing and type documentation
  - Fixed rootDataItemOffset calculation to include target item's offset, not
    just parent dataOffset values
  - Fixed region boundary validation to handle offset=0 correctly (was
    incorrectly skipping validation due to truthy checks)
  - Added backward compatibility fallback for data without dataOffset attributes
- **304 Not Modified Pre-Charging**: Prevented 304 Not Modified responses from
  being pre-charged with full content size before checking If-None-Match
  headers. Now correctly predicts 304 responses and applies minimal token charge
  without denying legitimate cached requests

## [Release 55] - 2025-10-20

This is an optional release focused on x402 payment protocol improvements.

This release represents a major milestone in the gateway x402 payment protocol
implementation. The x402 capabilities have evolved from an MVP supporting only
limited data endpoints to a full, mostly feature-complete solution. The browser
paywall now uses redirect mode to properly handle content-type metadata, and
rate limiting has been extended to work correctly across all content delivery
paths including manifests, ArNS names, and range requests.

> **⚠️ EXPERIMENTAL FEATURES**: The rate limiter and x402 payment protocol are
> experimental features subject to change. API endpoints, parameters, behavior,
> and configuration options (environment variables) may evolve in future
> releases as these systems continue to be developed. See
> [docs/x402-and-rate-limiting.md](docs/x402-and-rate-limiting.md) for
> comprehensive documentation.

### Added

- **Token Consumption Metrics**: New `rate_limit_tokens_consumed_total`
  Prometheus counter for monitoring rate limiter usage with labels:
  - `bucket_type` (ip/resource) - Which bucket consumed tokens
  - `token_type` (paid/regular) - Which token pool was used
  - `domain` - Domain consuming the tokens
  - Enables monitoring and alerting on token consumption patterns
- **Environment Variables**:
  - `RATE_LIMITER_TYPE`: Configure rate limiter implementation ("memory" for
    development/testing, "redis" for production)
  - `CDP_API_KEY_SECRET_FILE`: Load CDP secret API key from file instead of
    environment variable for improved security (for Coinbase Onramp integration)
  - `RATE_LIMITER_ARNS_ALLOWLIST`: Comma-separated list of ArNS names that
    bypass rate limiting and payment verification

### Changed

- **Token Consumption Priority**: Changed token consumption order to prioritize
  regular tokens:
  - Regular tokens consumed first, then paid tokens
  - Paid tokens now act as overflow capacity instead of being consumed
    immediately
  - Paid token balance still provides bypass of per-resource rate limits
  - This change provides better value to paying users as paid tokens last
    longer
- **Rate Limiting and Payment Architecture**: Refactored internal architecture
  for improved maintainability (no operator-visible behavior changes beyond those
  listed above)

### Fixed

- **X402 Browser Paywall**: Implemented redirect mode to fix blob URL
  content-type handling issues:
  - Browser requests now receive proper redirects after payment verification
  - Resolves content-type metadata loss that occurred with blob URLs
  - Preserves original content metadata in browser delivery
- **Rate Limiting for Manifests and ArNS**: Fixed rate limits to correctly
  apply to manifest-resolved and ArNS resources:
  - Rate limits now apply after manifest resolution to actual content size
  - ArNS resources are now properly rate limited
  - Ensures consistent rate limiting across all content delivery paths
- **Range Request Token Consumption**: Fixed rate limiter to charge tokens
  based on actual bytes served in range requests instead of full content size
- **Rate Limiter Token Tracking**: Fixed internal token bucket tracking to
  properly record consumption in all edge cases
- **Token Consumption for Non-Data Responses**: Prevented token consumption for
  304 Not Modified and HEAD responses which don't transfer content data

## [Release 54] - 2025-10-13

This is a **recommended release** due to the improvements to chunk observation
and retrieval. The release enhances peer selection for chunk operations,
introduces experimental X402 payment protocol support, and enables offset
observation enforcement by default to strengthen network reliability.

> **⚠️ EXPERIMENTAL FEATURES**: The rate limiter and x402 payment protocol are
> experimental features subject to change. API endpoints, parameters, behavior,
> and configuration options (environment variables) may evolve in future
> releases as these systems continue to be developed. See
> [docs/x402-and-rate-limiting.md](docs/x402-and-rate-limiting.md) for
> comprehensive documentation.

### Added

- **X402 Payment Protocol (Experimental)**: Optional USDC-based payment
  system for accessing rate-limited content. This feature is experimental
  and will be rapidly built out in upcoming releases.
  - Dynamic content-based pricing (default: $0.0000000001/byte = $0.10/GB)
  - USDC payments via Coinbase facilitator on Base network (mainnet and
    testnet supported)
  - Rate limiter integration with 10x capacity multiplier for paid tier
  - Proportional bucket top-off capped to actual price paid
  - HTML paywall for browser clients, JSON responses for API clients
  - Settlement timeout protection (5s default)
  - Configuration via 13 new `X_402_*` environment variables (see
    `.env.example` for details)
  - **Note**: Currently only applies to `/<id>` and `/raw/<id>` endpoints
    for non-manifests
- Expanded default preferred chunk GET node pool from 12 to 22 nodes,
  adding data-13 through data-17 (5 additional data nodes) and tip-1
  through tip-5 (5 tip nodes) for improved redundancy and load
  distribution across the Arweave network.
- Added GraphQL as third fallback option in `ROOT_TX_LOOKUP_ORDER` (after
  db and turbo) to prevent lookup failures when Turbo's circuit breaker
  is open, enabling more resilient root transaction discovery.
- Added deterministic weight-based peer selection for chunk operations
  (both GET and POST). Peers are now sorted by weight in descending order
  and top N selected, ensuring preferred peers (weight 100) are always
  tried first instead of probabilistic selection.
- Added preferred peer weight preservation for chunk operations to prevent
  weight degradation for operator-configured preferred peers during
  temporary failures. Preferred peers maintain their initial weight (100)
  regardless of success/failure, honoring operator configuration while
  allowing discovered peers to adapt based on performance.

### Changed

- **Observer**: Enabled offset observation enforcement by default.
  `OFFSET_OBSERVATION_ENFORCEMENT_ENABLED` now defaults to `true` instead
  of `false`. Gateway assessments will fail if offset validation fails,
  strengthening network reliability requirements. Operators can opt-out by
  explicitly setting `OFFSET_OBSERVATION_ENFORCEMENT_ENABLED=false`.
- Reduced logging verbosity by moving DNS resolution and sync bucket
  operational logs from debug/info to silly level. DNS resolution messages
  ('Resolving hostname', 'Resolved IPv4/IPv6 addresses') and sync bucket
  updates ('Parsed ETF sync buckets', 'Updated sync buckets') now use
  silly level, while completion and peer selection messages remain at
  debug level for visibility.

### Fixed

- Fixed preferred peer weight preservation to only apply to chunk
  operations (GET/POST) instead of all operation categories. Previously,
  preferred chunk peers maintained constant weight across chain, getChunk,
  and postChunk operations. Now preferred chunk peers can undergo normal
  warming/cooling when used for chain operations, preventing indefinite
  selection of peers that perform poorly for chain operations while still
  maintaining constant weight for chunk operations.
- Fixed ANS-104 data item header parsing for Ethereum signatures (type 3)
  by using correct 65-byte uncompressed public key length instead of
  20-byte address length. This resolves "Invalid buffer" errors when
  parsing Ethereum-signed data items. Also updated
  `MAX_DATA_ITEM_HEADER_SIZE` from 6228 to 8257 bytes to account for
  MultiAptos signature type (largest supported), and replaced custom
  signature/owner length methods with `getSignatureMeta()` from arbundles
  library for consistency.
- Fixed root TX discovery to use non-blocking rate limiting instead of
  blocking when rate limits are reached. Services now use
  `tryRemoveTokens()` and skip rate-limited gateways/sources immediately
  rather than waiting indefinitely, preventing request blocking and
  improving responsiveness. Also fixed GraphQL service to return
  `dataSize` instead of incorrect `size` field.

### Known Issues

- The x402 browser paywall currently uses blob URLs for content delivery
  after successful payment. This causes issues with content-type handling
  and browser behavior as the blob URL doesn't preserve the original
  content metadata. **We plan to fix this in upcoming releases** by
  either contributing to the x402 SDK to add a page reload option, or
  implementing a custom paywall template that properly handles redirects
  after payment verification.

## [Release 53] - 2025-10-06

This is an optional release that introduces root transaction offset tracking
for nested bundles and observer performance improvements. The release enables
more efficient data retrieval through comprehensive offset tracking with Turbo
and GraphQL integration, while improving observer reliability with increased
chunk validation success rates.

### Added

- **Root Transaction and Offset Tracking**: Comprehensive offset tracking
  system for nested ANS-104 bundles:
  - Turbo `/offsets` endpoint integration for accurate root transaction
    discovery and offset calculations
  - Handles multi-level nested bundles with cumulative offset tracking
  - Cycle detection and maximum nesting depth protection (10 levels)
  - Database persistence of root transaction IDs and absolute offset values
- **GraphQL Root TX Index**: Dedicated GraphQL endpoint configuration for root
  transaction lookups:
  - `GRAPHQL_ROOT_TX_GATEWAYS_URLS`: JSON object mapping GraphQL endpoints to
    weights (default: `{"https://arweave-search.goldsky.com/graphql": 1}`)
  - Parent chain traversal with metadata extraction (content type, size)
  - Fallback mechanism when Turbo is unavailable
  - Configurable lookup order via `ROOT_TX_LOOKUP_ORDER` (default: "db,turbo")
- **Database Migration**: Added offset tracking columns to
  `contiguous_data_ids` table:
  - `root_transaction_id`: Top-level Arweave transaction containing the data
  - `root_data_item_offset`: Absolute position where data item headers begin in
    root bundle
  - `root_data_offset`: Absolute position where data payload begins in root
    bundle
- **HTTP Headers**: New headers exposing absolute root offset information:
  - `X-AR-IO-Root-Data-Item-Offset`: Enables direct byte-range requests to data
    item headers
  - `X-AR-IO-Root-Data-Offset`: Enables direct byte-range requests to data
    payloads
- **Outbound Rate Limiting for External APIs**: Token bucket rate limiting for
  outbound calls to Turbo and GraphQL services (separate from the Redis-based
  inbound rate limiter added in Release 52):
  - Turbo API: Configurable via `TURBO_ROOT_TX_RATE_LIMIT_BURST_SIZE` (default: 5),
    `TURBO_ROOT_TX_RATE_LIMIT_TOKENS_PER_INTERVAL` (default: 6),
    `TURBO_ROOT_TX_RATE_LIMIT_INTERVAL` (default: "minute")
  - GraphQL API: Configurable via `GRAPHQL_ROOT_TX_RATE_LIMIT_BURST_SIZE` (default: 5),
    `GRAPHQL_ROOT_TX_RATE_LIMIT_TOKENS_PER_INTERVAL` (default: 6),
    `GRAPHQL_ROOT_TX_RATE_LIMIT_INTERVAL` (default: "minute")
  - Prevents excessive API usage and respects external service limits (defaults
    to 6 requests per minute = 1 per 10 seconds)
- **Configuration Options**:
  - `ENABLE_DATA_ITEM_ROOT_TX_SEARCH`: Enable/disable root transaction search
    for data items in offset-aware sources (default: true)
  - `ENABLE_PASSTHROUGH_WITHOUT_OFFSETS`: Control whether offset-aware sources
    allow data retrieval without offset information (default: true)
  - Dedicated rate limiting configuration for Turbo and GraphQL root TX lookups
  - Separate GraphQL gateway configuration for root lookups vs data retrieval
- **Documentation and Testing**:
  - Comprehensive bundle offsets documentation in
    `docs/drafts/bundle-offsets.md`
  - Rate limiting behavior tests validating token accumulation and request
    delays
  - Enhanced test coverage for offset tracking and nested bundle scenarios

### Changed

- **Observer**: Increased `OFFSET_SAMPLE_COUNT` default from 3 to 4 to improve
  chunk validation success rate with early stopping
- Increased rate limiter defaults to accommodate larger response payloads:
  - `RATE_LIMITER_RESOURCE_TOKENS_PER_BUCKET`: 10,000 → 1,000,000 tokens (~10 MiB → ~976 MiB bucket capacity)
  - `RATE_LIMITER_IP_TOKENS_PER_BUCKET`: 2,000 → 100,000 tokens (~2 MiB → ~98 MiB bucket capacity)
  - Resource refill rate remains 100 tokens/second (~98 KiB/s)
  - IP refill rate remains 20 tokens/second (~20 KiB/s)
  - Note: 1 token = 1 KiB (where 1 KiB = 1,024 bytes) of response data, minimum 1 token per request
  - Rate limiter remains disabled by default (`ENABLE_RATE_LIMITER=false`)
- **Performance Optimization**: RootParentDataSource now uses pre-computed root
  offsets when available:
  - Skip bundle traversal entirely when offsets are cached in database
  - Direct offset-based data retrieval without parent chain traversal
  - Use `rootDataOffset` to skip headers when fetching data payloads
  - Significantly reduces latency for nested bundle data retrieval

### Fixed

- **Security**: Resolved transitive dependency vulnerabilities by adding yarn
  resolutions:
  - `ws@7.5.10`: Fixed DoS vulnerability when handling requests with many HTTP
    headers (CVE in ws <7.5.10)
  - `semver@7.6.3`: Fixed Regular Expression Denial of Service (ReDoS)
    vulnerability (CVE in semver <7.5.2)

## [Release 52] - 2025-09-29

This is a **recommended release** that introduces critical observer reliability
improvements and a new Redis-based rate limiting system. The release significantly
improves observer stability under load through reduced sample rates, optimized
timeouts, and better concurrency management. Additionally, it introduces a complete
rate limiting solution with token bucket algorithm and IP allowlist support for
enhanced DDoS protection.

> **⚠️ EXPERIMENTAL FEATURES**: The rate limiter and x402 payment protocol are
> experimental features subject to change. API endpoints, parameters, behavior,
> and configuration options (environment variables) may evolve in future
> releases as these systems continue to be developed. See
> [docs/x402-and-rate-limiting.md](docs/x402-and-rate-limiting.md) for
> comprehensive documentation.

### Added

- **Rate Limiter**: Complete Redis/Valkey-based rate limiting system with:
  - Token bucket algorithm with configurable limits per IP and resource
  - IP allowlist support with CIDR block matching
  - Lua scripts for atomic Redis operations
  - Support for both cluster and non-cluster Redis deployments
  - Configuration via environment variables:
    - `ENABLE_RATE_LIMITER`: Enable/disable rate limiting (default: false)
    - `RATE_LIMITER_RESOURCE_TOKENS_PER_BUCKET`: Resource token bucket size
      (default: 10000)
    - `RATE_LIMITER_RESOURCE_REFILL_PER_SEC`: Resource token refill rate
      (default: 100)
    - `RATE_LIMITER_IP_TOKENS_PER_BUCKET`: IP token bucket size (default: 2000)
    - `RATE_LIMITER_IP_REFILL_PER_SEC`: IP token refill rate (default: 20)
    - `RATE_LIMITER_IPS_AND_CIDRS_ALLOWLIST`: Comma-separated allowlist of
      IPs/CIDRs
    - `RATE_LIMITER_REDIS_ENDPOINT`: Redis endpoint (default: localhost:6379)
    - `RATE_LIMITER_REDIS_USE_TLS`: Enable TLS for Redis (default: false)
    - `RATE_LIMITER_REDIS_USE_CLUSTER`: Use Redis cluster mode (default: false)
- **Chunk Offset Concurrency Control**: Added
  `CHUNK_OFFSET_CHAIN_FALLBACK_CONCURRENCY` config (default: 5) to limit
  concurrent fallback requests to the Arweave network, preventing resource
  exhaustion under high load
- **Observer Metrics**: Added comprehensive Prometheus metrics for observer
  performance including:
  - Ownership, ArNS name, and offset assessment metrics with pass/fail tracking
  - Report generation timing and success/failure counters
  - Gateway assessment overall status tracking
  - AR.IO node release version as global label on all metrics
  - `/ar-io/observer/metrics` endpoint for Prometheus scraping

### Changed

- **Security Updates**: Updated dependencies to address security
  vulnerabilities:
  - @ar.io/sdk to 3.20.0
  - @dha-team/arbundles to 1.0.4
  - axios to 1.12.0
  - Multiple other minor/patch updates for security fixes
- **Observer Performance Improvements**:
  - Reduced default offset observation sample rate from 5% to 1% to minimize
    observation failures under load
  - Added quick chunk validation to skip expensive binary search operations
  - Reduced concurrent connections and serialized ownership checks for better
    reliability
  - Optimized timeout configurations (7 seconds) for more reliable assessments

### Fixed

- **GraphQL Pagination**: Corrected transaction ID sorting to match ClickHouse
  binary ordering, eliminating duplicate transactions across consecutive query
  pages
- **Security Vulnerabilities**:
  - Resolved critical elliptic ECDSA private key extraction vulnerability
  - Resolved secp256k1 ECDH private key extraction vulnerability
- **Metrics**: Only increment `requestChunkTotal` counter for actual chunk
  requests
- **API Response**: Replaced `syncBuckets` with `bucketCount` in `/ar-io/peers`
  response

## [Release 51] - 2025-09-22

This is a **recommended release** that introduces significant enhancements to
metrics, observer capabilities, gateway filtering, and performance. The release
includes metrics improvements with release tracking, major observer enhancements
with offset observation capabilities, enhanced trusted gateway filtering to
prevent caching issues, and optimized chunk retrieval performance.

### Added

- **Metrics Enhancement**: Added release number as default label to all
  Prometheus metrics, enabling filtering and comparison across releases
- **Enhanced Data Stream Metrics**: Added comprehensive byte tracking with
  `getDataStreamBytesTotal` counter and `getDataStreamSizeHistogram` with 4
  buckets (100KB, 1MB, 10MB, 100MB)
- **Peer Metrics**: Added metrics for preferred peers and peer types, tracking
  "preferred" vs regular "peer" sources and "bucket" vs "general" peer selection
- **Observer Offset Observation**: Added complete V1 implementation of offset
  observation with cryptographic chunk validation using arweave.js validatePath()
  for enhanced data integrity verification. This feature is currently in testing
  phase and will be gradually enabled across the network
- **Observer Gateway Sampling**: Added configurable gateway sampling for offset
  observations with `OFFSET_OBSERVATION_SAMPLE_RATE` (default 5%)
- **Observer Reference Gateway Comparison**: Added chunk availability comparison
  against reference gateway to identify gateway-specific vs network-wide issues
- **Observer Configuration Controls**: Added `OFFSET_OBSERVATION_ENFORCEMENT_ENABLED`
  to control whether offset failures cause gateway assessment failures (default: false)
- **Trusted Gateway Filtering**: Added comprehensive IP and origin filtering for
  trusted gateways with support for CIDR blocks and X-Real-IP header to prevent
  gateway loops and unexpected caching behavior
- **Chunk Offset Sampling Tool**: Added gateway health monitoring tool for chunk
  offset sampling (see `tools/sample-chunk-offsets`)
- **Storage Partition Converter**: Added Arweave storage partition to height
  range converter script (see `tools/arweave-partitions-to-heights`)

### Changed

- **Request Type Labels**: Simplified metric request_type labels to 'full'
  (complete data) and 'range' (partial data) for consistency
- **Peer Management**: Refactored peer management architecture with extracted
  ArweavePeerManager from ArweaveCompositeClient
- **Cache Management**: Improved cache handling with proper timer cleanup in
  NodeCache
- **Chunk Retrieval Optimization**: Optimized chunk retrieval to use single
  peer selection per request, reducing overhead
- **Offset-Aware Architecture**: Implemented TxOffsetSource architecture for
  more efficient chunk retrieval with sync bucket support

### Fixed

- **Root Transaction Detection**:
  - Enhanced logic to prevent incorrect root detection for self-referencing
    transactions
  - Added early exit for self-referencing root transactions
- **Data Cache**: Fixed data cache to respect SKIP_DATA_CACHE setting and skip
  writes when disabled

## [Release 50] - 2025-09-15

This is a **recommended release** due to cache safety improvements that prevent
caching incomplete data and enhance data validation reliability.

This release introduces significant robustness improvements with offset-aware
data sources, experimental datasets HTTP endpoint for analytics workloads, and
enhanced Parquet/Iceberg tooling. It also includes important fixes for data
validation and root parent traversal.

### Added

- **Offset-Aware Data Sources**: Added two new offset-aware data sources that
  leverage cached upstream offset attributes for improved performance:
  - `chunks-offset-aware` (renamed from `chunks-data-item` with backwards
    compatibility) - enables automatic data item resolution within ANS-104
    bundles using cached offsets
  - `trusted-gateways-offset-aware` - uses cached upstream offsets without
    expensive searching for faster data retrieval
- **Cache Skip Configuration**: Added `SKIP_DATA_CACHE` environment variable to
  bypass cache retrieval and always fetch from upstream sources for testing and
  debugging
- **Datasets HTTP Endpoint (Experimental)**: Added optional `/local/datasets`
  endpoint (disabled by default) for HTTP access to Parquet files and Iceberg
  metadata, enabling remote DuckDB queries. Note: This feature is experimental
  and subject to change
- **Datasets Proxy Configuration**: Added configurable datasets proxy via Envoy
  with `DATASETS_PROXY_HOST` and `DATASETS_PROXY_PORT` environment variables
- **Parquet Repartitioning Tool**: Added comprehensive `parquet-repartition`
  script supporting both tag-based and owner address-based partitioning with
  height chunking and Iceberg metadata generation
- **Minimal Iceberg Metadata Generator**: Added lightweight
  `generate-minimal-iceberg-metadata` script optimized for DuckDB compatibility
  with HTTP URL support
- **Multi-Architecture Support**: Added multi-arch support to ClickHouse
  auto-import Docker image for broader platform compatibility

### Changed

- **Default Retrieval Order**: Updated default `ON_DEMAND_RETRIEVAL_ORDER` to
  use new `chunks-offset-aware` name (backwards compatible with
  `chunks-data-item`)
- **Iceberg Metadata Implementation**: Replaced complex PyIceberg-based
  implementation with minimal fastavro-based version for better performance and
  DuckDB compatibility
- **Zero-Size Data Handling**: Skip caching and indexing for zero-size data to
  prevent unnecessary storage operations

### Fixed

- **Root Parent Traversal**: Fixed RootParentDataSource to properly handle root
  transactions without cached attributes
- **Data Size Validation**: Added validation to prevent caching incomplete data
  and prevent ID to hash mapping queue on partial stream errors
- **Parquet Export Issues**: Fixed CSV column type specification to prevent
  DuckDB type inference errors
- **ClickHouse Build Workflow**: Updated build workflow to include missing file
  paths

## [Release 49] - 2025-09-07

This is an optional release that significantly improves the ClickHouse ETL pipeline with better performance, reliability, and Apache Iceberg metadata support. While optional for most users, this release is important for anyone experimenting with Parquet exports and ClickHouse integration.

### Added

- **Apache Iceberg Metadata Generation**: Added `generate-iceberg-metadata`
  script to create Apache Iceberg table metadata for exported Parquet datasets,
  enabling compatibility with query engines like DuckDB and Spark. Controlled by
  new `ENABLE_ICEBERG_GENERATION` environment variable (default: false).
  **Note: Iceberg metadata generation is still under active development and
  currently incomplete.**

- **HyperBEAM Sidecar Support**: Added optional HyperBEAM container
  configuration with `.env.hb.example` template for running AO processes
  alongside the gateway.

- **ETL Configuration Documentation**: Documented existing ClickHouse
  auto-import environment variables in `.env.example`:
  - `CLICKHOUSE_AUTO_IMPORT_SLEEP_INTERVAL` - interval between import cycles
    (default: 3600 seconds)
  - `CLICKHOUSE_AUTO_IMPORT_HEIGHT_INTERVAL` - batch size in blocks (default:
    10000)
  - `CLICKHOUSE_AUTO_IMPORT_MAX_ROWS_PER_FILE` - Parquet file size limit
    (default: 1000000)

### Changed

- **ETL Pipeline Architecture**: Refactored the ClickHouse ETL pipeline for
  improved reliability and modularity:
  - Implemented staging-based workflow to prevent data corruption
  - Changed from API-based triggering to direct script execution
  - Made L1 transaction export the default behavior
  - Changed default export location from `data/parquet` to
    `data/datasets/default`
  - **Performance**: Greatly improved query performance through better index
    usage in the refactored pipeline
  - **Stability**: Fixed issue where the 'core' service would occasionally
    crash due to long-running SQLite queries

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
