# Parquet Dataset Repartitioning

The `parquet-repartition` script allows you to take an existing Parquet dataset and repartition it by tag values (e.g., Drive-Id, App-Name) or owner addresses for more efficient querying.

## Features

- **Tag-based partitioning**: Organize data by any tag field for efficient filtering
- **Owner-based partitioning**: Organize data by transaction owner addresses for wallet-centric analysis
- **Height sub-partitioning**: Optionally preserve height-based partitions within tag/owner partitions
- **Iceberg compatible**: Generates proper metadata for Apache Iceberg tables
- **Special character support**: Handles tags with hyphens, unicode, and other special characters
- **Base64URL encoding**: Uses filesystem-safe base64URL encoding for owner addresses
- **File size management**: Automatically splits large partitions into multiple files
- **Untagged data handling**: Option to include transactions/blocks without the specified tag (tag mode only)
- **Specific filtering**: Process only specific tag values or owner addresses
- **Progress tracking**: Detailed timing and progress information
- **Dry run mode**: Preview operations without making changes

## Usage

### Basic Usage

```bash
# Partition dataset by Drive-Id (tag mode)
./scripts/parquet-repartition \
  --input-dir data/datasets/default \
  --output-dir data/datasets/by-drive \
  --tag-name "Drive-Id" \
  --generate-iceberg

# Partition dataset by owner address (owner mode)
./scripts/parquet-repartition \
  --input-dir data/datasets/default \
  --output-dir data/datasets/by-owner \
  --partition-by-owner \
  --min-occurrences 100 \
  --generate-iceberg
```

### Specific Owner or Tag Processing

```bash
# Process specific owner address
./scripts/parquet-repartition \
  --input-dir data/datasets/default \
  --output-dir data/datasets/by-owner \
  --partition-by-owner \
  --owner-address "9_666Wkk2GzL0LGd3xhb0jY7HqNy71BaV4sULQlJsBQ="

# Process specific tag value
./scripts/parquet-repartition \
  --input-dir data/datasets/default \
  --output-dir data/datasets/by-drive \
  --tag-name "Drive-Id" \
  --tag-value "specific-drive-id-here"
```

### With Height Sub-partitions

```bash
# Partition by App-Name, preserving height-based sub-partitions
./scripts/parquet-repartition \
  --input-dir data/datasets/default \
  --output-dir data/datasets/by-app \
  --tag-name "App-Name" \
  --preserve-height \
  --height-partition-size 1000 \
  --include-untagged

# Owner partitioning with height preservation
./scripts/parquet-repartition \
  --input-dir data/datasets/default \
  --output-dir data/datasets/by-owner \
  --partition-by-owner \
  --preserve-height \
  --height-partition-size 5000
```

### Dry Run

```bash
# Preview tag-based partitioning
./scripts/parquet-repartition \
  --input-dir data/datasets/default \
  --output-dir data/datasets/by-drive \
  --tag-name "Drive-Id" \
  --dry-run

# Preview owner-based partitioning
./scripts/parquet-repartition \
  --input-dir data/datasets/default \
  --output-dir data/datasets/by-owner \
  --partition-by-owner \
  --dry-run
```

## Output Structure

### Single-level Partitioning (Tag Mode)

```
output/
├── blocks/
│   └── data/
│       ├── drive_id=<value1>/
│       │   └── *.parquet
│       └── drive_id=<value2>/
│           └── *.parquet
├── transactions/
│   └── data/
│       ├── drive_id=<value1>/
│       │   └── *.parquet
│       └── drive_id=<value2>/
│           └── *.parquet
└── tags/
    └── data/
        ├── drive_id=<value1>/
        │   └── *.parquet
        └── drive_id=<value2>/
            └── *.parquet
```

### Single-level Partitioning (Owner Mode)

```
output/
├── blocks/
│   └── data/
│       ├── owner_address=<base64url_addr1>/
│       │   └── *.parquet
│       └── owner_address=<base64url_addr2>/
│           └── *.parquet
├── transactions/
│   └── data/
│       ├── owner_address=<base64url_addr1>/
│       │   └── *.parquet
│       └── owner_address=<base64url_addr2>/
│           └── *.parquet
└── tags/
    └── data/
        ├── owner_address=<base64url_addr1>/
        │   └── *.parquet
        └── owner_address=<base64url_addr2>/
            └── *.parquet
```

### Two-level Partitioning (with --preserve-height)

```
output/
└── transactions/
    └── data/
        └── drive_id=<value>/
            ├── height=0-999/
            │   └── *.parquet
            ├── height=1000-1999/
            │   └── *.parquet
            └── height=2000-2999/
                └── *.parquet
```

## Key Options

### Partitioning Mode
- `--tag-name NAME`: Partition by tag values (tag mode)
- `--partition-by-owner`: Partition by owner addresses (owner mode)

### Specific Processing
- `--tag-value VALUE`: Process only specific tag value (requires `--tag-name`)
- `--owner-address ADDR`: Process only specific owner address (requires `--partition-by-owner`)

### General Options
- `--preserve-height`: Keep height-based sub-partitions within each partition
- `--include-untagged`: Create a partition for items that don't have the specified tag (tag mode only)
- `--max-file-rows`: Split large partitions into multiple files (default: 1,000,000 rows)
- `--generate-iceberg`: Generate Apache Iceberg metadata for the new partition structure
- `--show-timing`: Display detailed timing information for performance analysis

### Filtering Options
- `--min-occurrences N`: Only process values with at least N occurrences
- `--max-partitions N`: Process only top N values by occurrence count
- `--skip-partitions N`: Skip first N partitions (for pagination)

## Special Character Handling

The script properly handles special characters in both modes:

### Tag Mode
- **Hyphens/dashes**: `Drive-Id-123-abc` → `drive_id=Drive-Id-123-abc/`
- **Unicode characters**: Properly encoded in Iceberg metadata
- **File system safe**: Problematic characters (`/\:*?"<>|`) are replaced with underscores in directory names

### Owner Mode
- **Base64URL encoding**: Owner addresses use filesystem-safe base64URL encoding
- **Example**: `9/666Wkk2GzL0LGd3xhb0jY7HqNy71BaV4sULQlJsBQ=` → `9_666Wkk2GzL0LGd3xhb0jY7HqNy71BaV4sULQlJsBQ=`
- **Automatic conversion**: Script handles conversion between base64URL (input) and standard base64 (database queries)

## Performance Considerations

- **Memory usage**: Processes one value at a time (tag or owner) to manage memory efficiently
- **Parallel processing**: Uses DuckDB's parallel Parquet reading for performance
- **File splitting**: Large partitions are automatically split to maintain query performance
- **Owner mode efficiency**: Direct queries on transaction table owner_address column
- **Height-based chunking**: Available for both modes to handle large datasets
- **Progress tracking**: Use `--show-timing` to monitor performance and identify bottlenecks

## Integration with Existing Scripts

This script is designed to work with datasets created by:
- `parquet-export`: Main export script that creates height-partitioned datasets
- `generate-iceberg-metadata`: Generates Iceberg metadata (automatically called if `--generate-iceberg` is used)

## Examples by Use Case

### ArDrive Data Analysis
```bash
# Partition by Drive-Id for per-drive analytics
./scripts/parquet-repartition \
  --input-dir data/datasets/default \
  --output-dir data/datasets/ardrive \
  --tag-name "Drive-Id" \
  --include-untagged \
  --generate-iceberg
```

### Wallet-Based Analytics
```bash
# Partition by owner address for wallet analysis
./scripts/parquet-repartition \
  --input-dir data/datasets/default \
  --output-dir data/datasets/wallets \
  --partition-by-owner \
  --min-occurrences 50 \
  --generate-iceberg

# Analyze specific high-value wallet
./scripts/parquet-repartition \
  --input-dir data/datasets/default \
  --output-dir data/datasets/whale-analysis \
  --partition-by-owner \
  --owner-address "9_666Wkk2GzL0LGd3xhb0jY7HqNy71BaV4sULQlJsBQ=" \
  --preserve-height
```

### Application Analytics
```bash
# Partition by App-Name with height sub-partitions for time-series analysis
./scripts/parquet-repartition \
  --input-dir data/datasets/default \
  --output-dir data/datasets/apps \
  --tag-name "App-Name" \
  --preserve-height \
  --height-partition-size 5000 \
  --generate-iceberg
```

### Content Type Analysis
```bash
# Partition by Content-Type tag
./scripts/parquet-repartition \
  --input-dir data/datasets/default \
  --output-dir data/datasets/content \
  --tag-name "Content-Type" \
  --max-file-rows 500000 \
  --generate-iceberg
```

## Prerequisites

- `duckdb` command-line tool installed and in PATH
- Sufficient disk space in staging directory (default: `data/etl/staging`)
- For Iceberg metadata: Python 3 with `pyiceberg[pyarrow,duckdb,sql]` installed

## Troubleshooting

### Common Issues

1. **"No Parquet files found"**: Ensure input directory has the correct structure (`blocks/data/`, `transactions/data/`, `tags/data/`)

2. **"Tag not found"**: Use `--dry-run` to see discovered tag values, check exact spelling and case sensitivity

3. **Memory issues**: Reduce `--max-file-rows` or ensure sufficient staging disk space

4. **Permission errors**: Check write permissions on output and staging directories

### Performance Tips

1. Use `--show-timing` to identify slow operations
2. Consider using SSDs for staging directory
3. For very large datasets, process in smaller height ranges first
4. Monitor disk space during processing