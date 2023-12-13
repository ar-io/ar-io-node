# Change Log

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Release 3] - 2023-12-05

### Added

- Release number in `/ar-io/info` response.
- Redis header cache implementation (#62).
  - New default header cache (replaces old FS cache).
- LMDB header cache implementation (#60).
  - Intended for use in development only.
  - Enable by setting `CHAIN_CACHE_TYPE=lmdb`.
- Filesystem header cache cleanup worker (#68).
  - Enabled by default to cleanup old filesystem cache now that Redis
    is the new default.
- Support for parallel ANS-104 unbundling (#65).
