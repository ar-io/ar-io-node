# Change Log

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Release 4] - 2024-01-11

### Added

- Added circuit breakers around data index access to reduce impact of DB access
  contention under heavy requests loads.
- Add support for configuring data source priority via the
  ON_DEMAND_RETRIEVAL_ORDER environment variable.

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
