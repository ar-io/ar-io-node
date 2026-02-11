# CDB64 Operator Guide

This guide covers configuration, usage, and troubleshooting of CDB64-based root transaction indexes for AR.IO Gateway operators.

## Table of Contents

- [Overview](#overview)
- [Configuration](#configuration)
- [Source Types](#source-types)
- [Local Directory Setup](#local-directory-setup)
- [Remote Sources](#remote-sources)
- [Partitioned Indexes](#partitioned-indexes)
- [Performance Tuning](#performance-tuning)
- [Troubleshooting](#troubleshooting)
- [Migration Guide](#migration-guide)

## Overview

CDB64 indexes provide O(1) lookups for mapping data item IDs to their root transaction IDs. This enables efficient retrieval of nested bundle data items without querying external services.

**Benefits:**

- **Fast lookups**: Constant-time key lookups via hash tables
- **Offline operation**: No external API dependencies for indexed data items
- **Multiple sources**: Combine local files, HTTP endpoints, and Arweave-stored indexes
- **Hot reloading**: Add/remove index files without gateway restart

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CDB64_ROOT_TX_INDEX_SOURCES` | `data/cdb64-root-tx-index` | Comma-separated list of index sources |
| `CDB64_ROOT_TX_INDEX_WATCH` | `true` | Enable file watching for local directories |
| `ROOT_TX_LOOKUP_ORDER` | `db,gateways,cdb,graphql` | Order of lookup sources (CDB64 enabled by default) |
| `CDB64_REMOTE_RETRIEVAL_ORDER` | `gateways,chunks` | Data sources for fetching remote CDB64 files |
| `CDB64_REMOTE_CACHE_MAX_REGIONS` | `100` | Max cached byte-range regions per remote source |
| `CDB64_REMOTE_CACHE_TTL_MS` | `300000` | TTL for cached regions (5 minutes) |
| `CDB64_REMOTE_REQUEST_TIMEOUT_MS` | `30000` | Request timeout for remote sources (30 seconds) |
| `CDB64_REMOTE_MAX_CONCURRENT_REQUESTS` | `4` | Max concurrent HTTP requests per remote source |

### Enabling CDB64 Lookups

To use CDB64 indexes, add `cdb` to your `ROOT_TX_LOOKUP_ORDER`:

```bash
# Prefer CDB64, fall back to database, then external services
ROOT_TX_LOOKUP_ORDER=cdb,db,gateways,graphql

# CDB64 only (no external lookups)
ROOT_TX_LOOKUP_ORDER=cdb,db
```

## Source Types

The `CDB64_ROOT_TX_INDEX_SOURCES` variable accepts multiple source types:

### Local File

A single CDB64 file:

```bash
CDB64_ROOT_TX_INDEX_SOURCES=/path/to/index.cdb
```

### Local Directory

A directory containing multiple `.cdb` files (all loaded automatically):

```bash
CDB64_ROOT_TX_INDEX_SOURCES=/path/to/indexes/
```

### Partitioned Directory

A directory containing `manifest.json` and partitioned `.cdb` files:

```bash
CDB64_ROOT_TX_INDEX_SOURCES=/path/to/partitioned-index/
```

### HTTP URL

A CDB64 file served over HTTP/HTTPS:

```bash
CDB64_ROOT_TX_INDEX_SOURCES=https://example.com/indexes/root-tx.cdb
```

### Partitioned HTTP

A partitioned index with manifest served over HTTP:

```bash
CDB64_ROOT_TX_INDEX_SOURCES=https://example.com/indexes/manifest.json
```

### Arweave Transaction

A CDB64 file stored as an Arweave transaction (43-character base64url ID):

```bash
CDB64_ROOT_TX_INDEX_SOURCES=ABC123def456ghi789jkl012mno345pqr678stu90v
```

### Arweave Byte Range

A CDB64 file stored within a bundle, accessed via byte-range:

```bash
# Format: rootTxId:offset:size
CDB64_ROOT_TX_INDEX_SOURCES=ABC123...:1024:500000
```

### Multiple Sources

Combine multiple sources (comma-separated, searched in order):

```bash
CDB64_ROOT_TX_INDEX_SOURCES=/local/indexes/,https://cdn.example.com/index.cdb,ABC123...
```

## Local Directory Setup

### Basic Setup

1. Create the index directory:
   ```bash
   mkdir -p data/cdb64-root-tx-index
   ```

2. Add CDB64 files to the directory:
   ```bash
   cp my-index.cdb data/cdb64-root-tx-index/
   ```

3. The gateway automatically loads all `.cdb` and `.cdb64` files from the directory.

### File Watching

When `CDB64_ROOT_TX_INDEX_WATCH=true` (default), the gateway monitors the directory for changes:

- **Adding files**: New `.cdb` files are automatically loaded
- **Removing files**: Deleted files are automatically unloaded
- **No restart required**: Changes take effect within seconds

**Note:** Only one directory can be watched at a time. If multiple directory sources are configured, only the first is watched.

### Disabling File Watching

For production environments with static indexes:

```bash
CDB64_ROOT_TX_INDEX_WATCH=false
```

This reduces filesystem overhead when indexes don't change.

## Remote Sources

### HTTP Sources

HTTP sources support byte-range requests for efficient random access:

```bash
CDB64_ROOT_TX_INDEX_SOURCES=https://s3.amazonaws.com/bucket/index.cdb
```

**Requirements:**
- Server must support HTTP Range requests
- Server should return `Accept-Ranges: bytes` header

### Arweave Sources

For Arweave-stored indexes, the gateway uses its configured data retrieval pipeline:

```bash
# Single transaction containing the CDB64 file
CDB64_ROOT_TX_INDEX_SOURCES=ABC123...

# Data item within a bundle (requires byte-range support)
CDB64_ROOT_TX_INDEX_SOURCES=RootTxId:1024:500000
```

Configure the retrieval order for remote CDB64 files:

```bash
# Try gateways first, then reconstruct from L1 chunks
CDB64_REMOTE_RETRIEVAL_ORDER=gateways,chunks

# Use Arweave node tx-data endpoint (slower but works for all data)
CDB64_REMOTE_RETRIEVAL_ORDER=gateways,chunks,tx-data
```

## Partitioned Indexes

For very large indexes, partitioning splits data across 256 files by key prefix. This enables:

- Manageable file sizes
- Parallel I/O
- Lazy loading (only accessed partitions are opened)
- Flexible storage (mix local and remote partitions)

### Directory Structure

```text
index/
  manifest.json    # Index manifest with partition metadata
  00.cdb           # Records with keys starting 0x00
  01.cdb           # Records with keys starting 0x01
  ...
  ff.cdb           # Records with keys starting 0xff
```

### Local Partitioned Index

```bash
CDB64_ROOT_TX_INDEX_SOURCES=/path/to/partitioned-index/
```

The gateway detects partitioned indexes by the presence of `manifest.json`.

### Remote Partitioned Index

```bash
# HTTP
CDB64_ROOT_TX_INDEX_SOURCES=https://cdn.example.com/index/manifest.json

# Arweave (manifest stored as transaction)
CDB64_ROOT_TX_INDEX_SOURCES=ManifestTxId:manifest

# Arweave byte-range (manifest within a bundle)
CDB64_ROOT_TX_INDEX_SOURCES=RootTxId:1024:5000:manifest
```

### Manifest Watching

For local partitioned indexes, the gateway watches `manifest.json` for changes. When the manifest is updated (e.g., via atomic rename), the index is automatically reloaded.

## Performance Tuning

### Cache Configuration

For remote sources, tune the byte-range cache:

```bash
# More cached regions for high-traffic gateways
CDB64_REMOTE_CACHE_MAX_REGIONS=500

# Longer TTL for stable indexes
CDB64_REMOTE_CACHE_TTL_MS=600000  # 10 minutes
```

### Concurrency Limits

Prevent request pile-up when reading from slow remote sources:

```bash
# Increase for fast CDNs
CDB64_REMOTE_MAX_CONCURRENT_REQUESTS=8

# Decrease for rate-limited endpoints
CDB64_REMOTE_MAX_CONCURRENT_REQUESTS=2
```

### Request Timeouts

Adjust timeouts based on your network conditions:

```bash
# Longer timeout for high-latency connections
CDB64_REMOTE_REQUEST_TIMEOUT_MS=60000  # 1 minute
```

### Lookup Order Optimization

Place faster sources first in the lookup order:

```bash
# Local CDB64 first (fastest), then database, then remote services
ROOT_TX_LOOKUP_ORDER=cdb,db,gateways,graphql
```

## Troubleshooting

### Index Not Loading

**Symptoms:** Logs show "Failed to initialize CDB64 source"

**Check:**
1. File exists and is readable by the gateway process
2. File has correct extension (`.cdb` or `.cdb64`)
3. File is a valid CDB64 file (not corrupted)

```bash
# Check file permissions
ls -la data/cdb64-root-tx-index/

# Verify file is valid CDB64 (should show header info)
xxd data/cdb64-root-tx-index/index.cdb | head -20
```

### File Watching Not Working

**Symptoms:** New files not detected, removed files still queried

**Check:**
1. `CDB64_ROOT_TX_INDEX_WATCH=true` is set
2. Only one directory source is configured (first is watched)
3. Files have correct extensions

**Logs to look for:**
```text
CDB64 file watcher started
CDB64 file added
CDB64 source removed
```

### Remote Source Errors

**Symptoms:** Timeouts, connection errors for HTTP/Arweave sources

**Check:**
1. Network connectivity to the source
2. HTTP Range request support (for HTTP sources)
3. Arweave data availability (for Arweave sources)

**Adjust configuration:**
```bash
# Increase timeout
CDB64_REMOTE_REQUEST_TIMEOUT_MS=60000

# Use more reliable retrieval sources
CDB64_REMOTE_RETRIEVAL_ORDER=gateways,chunks
```

### Partitioned Index Errors

**Symptoms:** "Manifest contains file locations" error for Arweave sources

**Cause:** Arweave-hosted manifests cannot reference local files.

**Solution:** Ensure the manifest uses `arweave-id`, `arweave-byte-range`, or `http` location types for all partitions.

### Memory Issues

**Symptoms:** High memory usage, OOM errors

**Note:** CDB64 readers only keep the 4KB header in memory. If you see high memory usage, check:

1. Number of open index files
2. Cache configuration for remote sources
3. Other gateway memory consumers

## Migration Guide

### From Database-Only Lookups

1. Generate CDB64 indexes from your database or external sources
2. Add `cdb` to `ROOT_TX_LOOKUP_ORDER`
3. Configure `CDB64_ROOT_TX_INDEX_SOURCES`
4. Restart gateway

### From Single File to Partitioned

1. Generate partitioned index with manifest
2. Replace source path with partitioned directory
3. Gateway detects partitioned format automatically

### Adding Remote Backup Sources

Combine local and remote sources for redundancy:

```bash
# Local first, remote backup
CDB64_ROOT_TX_INDEX_SOURCES=/local/indexes/,https://backup.example.com/index.cdb
```

---

## Related Documentation

- **[CDB64 File Format Specification](cdb64-format.md)** - Technical format details
- **[CDB64 Tools Reference](cdb64-tools.md)** - CLI tools for creating and managing indexes
- **[Environment Variables](envs.md)** - Complete environment variable reference
