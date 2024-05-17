# Change Log

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

- Added experimental support for streaming SQLite backups to S3 (and compatible
  services) using [Litestream](https://litestream.io/). Start the service using
  the docker-compose "litestream" profile to use it, and see the
  `AR_IO_SQLITE_BACKUP_*` [environment variables documentation](docs/env.md) for
  further details.
- Added `/ar-io/admin/queue-bundle` endpoint for queueing bundles for import
  for import before they're in the mempool. In the future this will enable
  optimistic indexing when combined with a local trusted bundler.
- Added support for triggering webhooks when blocks are imported matching the
  filter specified by the `WEBHOOK_BLOCK_FILTER` environment variable.
- Added experimental support for indexing transactions and related data items
  from the mempool. Enable it by setting ENABLE_MEMPOOL_WATCHER to 'true'.
- Made on-demand data caching circuit breakers configurable via the
  `GET_DATA_CIRCUIT_BREAKER_TIMEOUT_MS` environment variable. This allows gateway
  operators to decide how much latency they will tolerate when serving data in
  exchange for more complete data indexing and caching.
- Rename cache header from `X-Cached` to `X-Cache` to mimic typical CDN
  practices.
- Add X-AR-IO-Hops and X-AR-IO-Origin headers in preparation for future
  peer-to-peer functionality.
- Upgrade to Node.js v20 and switch to native test runner.

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
