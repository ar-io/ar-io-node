# Change Log

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- **Rate Limiter**: Complete Redis/Valkey-based rate limiting system with:
  - Token bucket algorithm with configurable limits per IP and resource
  - IP allowlist support with CIDR block matching
  - Lua scripts for atomic Redis operations
  - Support for both cluster and non-cluster Redis deployments
  - Configuration via environment variables:
    - `ENABLE_RATE_LIMITER`: Enable/disable rate limiting (default: false)
    - `RATE_LIMITER_RESOURCE_TOKENS_PER_BUCKET`: Resource token bucket size (default: 10000)
    - `RATE_LIMITER_RESOURCE_REFILL_PER_SEC`: Resource token refill rate (default: 100)
    - `RATE_LIMITER_IP_TOKENS_PER_BUCKET`: IP token bucket size (default: 2000)
    - `RATE_LIMITER_IP_REFILL_PER_SEC`: IP token refill rate (default: 20)
    - `RATE_LIMITER_IPS_AND_CIDRS_ALLOWLIST`: Comma-separated allowlist of IPs/CIDRs
    - `RATE_LIMITER_REDIS_ENDPOINT`: Redis endpoint (default: localhost:6379)
    - `RATE_LIMITER_REDIS_USE_TLS`: Enable TLS for Redis (default: false)
    - `RATE_LIMITER_REDIS_USE_CLUSTER`: Use Redis cluster mode (default: false)
- **Chunk Offset Concurrency Control**: Added `CHUNK_OFFSET_CHAIN_FALLBACK_CONCURRENCY` config (default: 5) to limit concurrent fallback requests to the Arweave network, preventing resource exhaustion under high load
- **Observer Metrics**: Added comprehensive Prometheus metrics for observer performance including:
  - Ownership, ArNS name, and offset assessment metrics with pass/fail tracking
  - Report generation timing and success/failure counters
  - Gateway assessment overall status tracking
  - AR.IO node release version as global label on all metrics
  - `/ar-io/observer/metrics` endpoint for Prometheus scraping

### Changed

- **Security Updates**: Updated dependencies to address security vulnerabilities:
  - @ar.io/sdk to 3.20.0
  - @dha-team/arbundles to 1.0.4
  - axios to 1.12.0
  - Multiple other minor/patch updates for security fixes
- **Observer Performance Improvements**:
  - Reduced default offset observation sample rate from 5% to 1% to minimize observation failures under load
  - Added quick chunk validation to skip expensive binary search operations
  - Reduced concurrent connections and serialized ownership checks for better reliability
  - Optimized timeout configurations (7 seconds) for more reliable assessments

### Fixed

- **GraphQL Pagination**: Corrected transaction ID sorting to match ClickHouse binary ordering, eliminating duplicate transactions across consecutive query pages
- **Security Vulnerabilities**:
  - Resolved critical elliptic ECDSA private key extraction vulnerability
  - Resolved secp256k1 ECDH private key extraction vulnerability
- **Metrics**: Only increment `requestChunkTotal` counter for actual chunk requests
- **API Response**: Replaced `syncBuckets` with `bucketCount` in `/ar-io/peers` response