# AR.IO Parquet Export with Apache Iceberg Support

## Overview

This document describes the enhanced Parquet export system for AR.IO Node that implements the requirements from PE-8500 without requiring Dagster as a dependency. The system provides:

- Configurable height-based partitioning
- Crash recovery and checkpointing
- Apache Iceberg metadata generation
- Standard warehouse directory structure
- Compatibility with analytics tools (DuckDB, Spark, etc.)

## Architecture

### Components

1. **parquet-export-v2**: Enhanced bash script for exporting SQLite data to Parquet
2. **generate-iceberg-metadata**: Python script for generating minimal Apache Iceberg metadata for DuckDB
3. **Warehouse Structure**: Standard Iceberg-compatible directory layout

### Directory Structure

```
data/
├── staging/                     # Temporary staging area
│   └── job-{timestamp}_{pid}/   # Job-specific staging
│       ├── .checkpoint          # Recovery checkpoint
│       └── {table}/             # Temporary Parquet files
└── local/
    └── warehouse/               # Final data warehouse
        ├── blocks/              # Blocks table
        │   ├── data/            # Parquet data files
        │   │   └── height={start}-{end}/*.parquet
        │   └── metadata/        # Iceberg metadata
        │       ├── v1.metadata.json
        │       ├── metadata.json -> v1.metadata.json
        │       └── manifest-*.json
        ├── transactions/        # Transactions table
        │   ├── data/
        │   └── metadata/
        └── tags/               # Tags table
            ├── data/
            └── metadata/
```

## Usage

### Basic Export

```bash
# Export a range of blocks with default settings
./scripts/parquet-export-v2 \
  --startHeight 1000000 \
  --endHeight 1010000
```

### Advanced Export with Custom Partitioning

```bash
./scripts/parquet-export-v2 \
  --startHeight 1000000 \
  --endHeight 2000000 \
  --heightPartitionSize 5000 \      # 5000 blocks per partition
  --maxFileRows 1000000 \            # Max 1M rows per file
  --includeL1Transactions \          # Include L1 transactions
  --includeL1Tags \                  # Include L1 tags
  --warehouseDir /path/to/warehouse
```

### Crash Recovery

If an export is interrupted:

```bash
# Resume from last checkpoint
./scripts/parquet-export-v2 \
  --startHeight 1000000 \
  --endHeight 2000000 \
  --resume
```

### Generate Iceberg Metadata

After export completes:

```bash
./scripts/generate-iceberg-metadata \
  --datasets-dir data/datasets/default \
  --datasets-root http://localhost:4000/local/datasets/default
```

## Configuration Options

### parquet-export-v2

| Option | Default | Description |
|--------|---------|-------------|
| `--startHeight` | Required | Starting block height |
| `--endHeight` | Required | Ending block height |
| `--heightPartitionSize` | 1000 | Number of blocks per partition |
| `--maxFileRows` | 1000000 | Maximum rows per Parquet file |
| `--includeL1Transactions` | false | Include L1 transactions |
| `--includeL1Tags` | false | Include L1 transaction tags |
| `--coreDb` | data/sqlite/core.db | Core database path |
| `--bundlesDb` | data/sqlite/bundles.db | Bundles database path |
| `--stagingDir` | data/staging | Staging directory |
| `--warehouseDir` | data/local/warehouse | Warehouse directory |
| `--resume` | false | Resume from checkpoint |

### generate-iceberg-metadata

| Option | Default | Description |
|--------|---------|-------------|
| `--datasets-dir` | data/datasets/default | Datasets directory containing Parquet data |
| `--datasets-root` | (optional) | Optional datasets root URI for HTTP access (e.g., http://localhost:4000/local/datasets/default) |

## Querying the Data

### DuckDB

```sql
-- Install required extensions
INSTALL httpfs;
LOAD httpfs;
INSTALL iceberg;
LOAD iceberg;

-- Query blocks (local)
SELECT COUNT(*) FROM iceberg_scan('data/datasets/default/blocks');

-- Query blocks (remote via HTTP)
SELECT COUNT(*) FROM iceberg_scan('http://localhost:4000/local/datasets/default/blocks/metadata/v1.metadata.json');

-- Aggregate transactions by height
SELECT 
  height, 
  COUNT(*) as tx_count,
  SUM(data_size) as total_data_size
FROM iceberg_scan('data/datasets/default/transactions')
GROUP BY height
ORDER BY height
LIMIT 10;

-- Find specific tags
SELECT * FROM iceberg_scan('data/datasets/default/tags')
WHERE CAST(tag_name AS VARCHAR) = 'App-Name' 
AND CAST(tag_value AS VARCHAR) LIKE 'ArDrive%'
LIMIT 10;
```

### Apache Spark

```python
# Configure Spark with Iceberg
spark.conf.set("spark.sql.catalog.ar_io", "org.apache.iceberg.spark.SparkCatalog")
spark.conf.set("spark.sql.catalog.ar_io.type", "hadoop")
spark.conf.set("spark.sql.catalog.ar_io.warehouse", "data/local/warehouse")

# Query tables
df = spark.table("ar_io.default.blocks")
df.filter(df.height.between(1000000, 1001000)).show()
```

## Important Notes

### Iceberg Metadata Format

The `generate-iceberg-metadata` script generates **Avro-formatted** Iceberg metadata files with minimal overhead specifically for DuckDB compatibility. This approach:

- ✅ **Works with**: DuckDB's Iceberg extension (production Avro format)
- ✅ **Supports**: Both local file access and HTTP remote access
- ✅ **Provides**: Lightweight metadata generation without full PyIceberg overhead
- ✅ **Enables**: Remote analytics via HTTP with absolute URLs
- ✅ **Production ready**: Standard Iceberg format compatible with most tools

The metadata format includes all necessary Iceberg structures (schemas, partitions, snapshots, manifests) in standard Avro format with proper HTTP URL support for remote access.

## Key Features

### 1. Configurable Partitioning

The `heightPartitionSize` parameter controls how many blocks are grouped into each partition. This affects:
- Query performance (smaller partitions = better partition pruning)
- File organization (larger partitions = fewer directories)
- Memory usage during export

### 2. Crash Recovery

The system maintains checkpoints after each partition is processed:
- Checkpoint file: `staging/job-*/. checkpoint`
- Contains last successfully processed height
- Use `--resume` flag to continue from checkpoint
- Staging files are preserved on failure

### 3. Atomic Operations

Files are first written to staging, then moved atomically to warehouse:
- Prevents partial data visibility
- Ensures consistency during failures
- No cleanup needed for incomplete exports

### 4. Memory Efficiency

The export process:
- Processes one partition at a time
- Clears DuckDB tables after each partition
- Limits memory usage regardless of total data size

## Migration from Dagster

While PE-8500 originally specified Dagster, this implementation provides the same functionality without the dependency:

| Dagster Feature | Bash Implementation |
|-----------------|-------------------|
| Asset orchestration | Sequential partition processing |
| Error handling | Trap handlers and exit codes |
| Checkpointing | File-based checkpoint system |
| Observability | Progress messages and logs |
| Staging | Temporary directory with atomic moves |

Future migration to Dagster (or other orchestrators) would be straightforward:
1. Wrap bash scripts as Dagster assets
2. Use same warehouse structure
3. Maintain same Iceberg metadata format

## Troubleshooting

### Export Fails with "Database locked"

Ensure no other processes are accessing the SQLite databases. Increase busy timeout if needed.

### Out of Memory

Reduce `maxFileRows` or `heightPartitionSize` to process smaller chunks.

### Resume Not Working

Check that staging directory contains checkpoint file. The job ID must match.

### Iceberg Metadata Compatibility

The generated JSON metadata works with DuckDB but may not work with all Iceberg tools. For broader compatibility, use PyIceberg or Java Iceberg libraries to generate Avro-formatted manifests.

## Future Enhancements

1. **ClickHouse Integration**: Add optional ClickHouse ingestion after export
2. **Incremental Updates**: Support appending new data to existing tables
3. **Parallel Processing**: Export multiple partitions concurrently
4. **Avro Manifests**: Generate proper Avro-formatted Iceberg manifests
5. **Data Validation**: Add checksums and row count verification
6. **Compression Options**: Support different compression codecs
7. **Schema Evolution**: Handle schema changes over time

## Performance Considerations

- **Partition Size**: Larger partitions (5000-10000 blocks) reduce overhead but increase memory usage
- **File Size**: Keep files under 1GB for optimal query performance
- **Compression**: ZSTD provides good balance of size and speed
- **Staging Location**: Use fast local storage for staging directory

## Testing

Run the test script to verify the system:

```bash
./scripts/test-parquet-export
```

This will:
1. Export a small height range
2. Generate Iceberg metadata
3. Display the warehouse structure
4. Show sample queries