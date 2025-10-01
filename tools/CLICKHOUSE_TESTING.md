# ClickHouse GraphQL Testing Tool

This tool systematically tests the ClickHouse GraphQL implementation by comparing results against arweave.net, with a focus on Drive-Id tags and owner addresses.

## Features

- **Transaction Count Discovery**: Queries ClickHouse directly to find high-volume drives and owners
- **Comprehensive Comparison**: Compares transaction data between local ClickHouse and arweave.net
- **Duplicate Detection**: Identifies duplicate transactions within and across result sets
- **Missing Item Detection**: Finds transactions present in one source but not the other
- **Pagination Testing**: Tests pagination consistency in both HEIGHT_ASC and HEIGHT_DESC directions
- **Detailed Reporting**: Generates HTML, JSON, and CSV reports with comprehensive metrics

## Prerequisites

- Node.js with TypeScript support
- ClickHouse instance running and accessible
- Local AR.IO node with GraphQL endpoint
- Internet access to query arweave.net

## Installation

The tool is included with the AR.IO node codebase. Ensure dependencies are installed:

```bash
yarn install
```

## Quick Start

### Auto-Discovery Mode

Discover and test the top entities by transaction count:

```bash
# Test top 10 drives and owners
./tools/test-clickhouse-graphql --auto-discover --top 10

# Test only drives
./tools/test-clickhouse-graphql --discover-drives --top 5

# Test only owners
./tools/test-clickhouse-graphql --discover-owners --top 5
```

### Manual Testing

Test specific entities:

```bash
# Test specific drive
./tools/test-clickhouse-graphql --drive-id "your-drive-id-here"

# Test specific owner
./tools/test-clickhouse-graphql --owner "owner-address-here"

# Test multiple entities
./tools/test-clickhouse-graphql --drive-id "drive1" --drive-id "drive2" --owner "owner1"
```

### Custom Configuration

Use a configuration file for repeated testing:

```bash
# Copy and modify the example config
cp tools/example-test-config.json my-test-config.json

# Run with custom config
./tools/test-clickhouse-graphql --config my-test-config.json --auto-discover
```

## Configuration

Configuration can be provided via command line arguments or a JSON file:

### JSON Configuration File

```json
{
  "clickhouse": {
    "url": "http://localhost:8123",
    "user": "default",
    "password": ""
  },
  "endpoints": {
    "local": "http://localhost:4000/graphql",
    "remote": "https://arweave.net/graphql"
  },
  "discovery": {
    "topDrives": 20,
    "topOwners": 20,
    "minTransactionCount": 100
  },
  "testing": {
    "pageSize": 100,
    "maxPagesPerTest": 10,
    "testBothDirections": true
  }
}
```

### Command Line Options

```bash
--config <file>              Use configuration file
--drive-id <id>              Test specific drive ID
--owner <address>            Test specific owner address
--auto-discover              Auto-discover entities by transaction count
--discover-drives            Discover and test drives
--discover-owners            Discover and test owners
--top <n>                    Number of top entities to test
--sample-size <n>            Alias for --top
--clickhouse-url <url>       ClickHouse URL (default: http://localhost:8123)
--clickhouse-user <user>     ClickHouse user (default: default)
--clickhouse-password <pwd>  ClickHouse password
--local-endpoint <url>       Local GraphQL endpoint (default: http://localhost:4000/graphql)
--remote-endpoint <url>      Remote GraphQL endpoint (default: https://arweave.net/graphql)
--export-csv <file>          Export results to CSV file
--help                       Show help message
```

## Output Structure

Results are saved in `test-results/runs/` with a timestamp-based directory structure:

```
test-results/
├── runs/
│   └── 2025-01-22-10-30-45/          # Timestamp-based run directory
│       ├── config.json                # Test configuration snapshot
│       ├── discovery/
│       │   ├── drive-counts.json      # Drive-ID transaction counts
│       │   ├── owner-counts.json      # Owner transaction counts
│       │   └── summary.json           # Discovery phase summary
│       ├── tests/
│       │   ├── drives/
│       │   │   ├── drive_<id>_test.json
│       │   │   └── drive_<id>_details.jsonl
│       │   └── owners/
│       │       ├── owner_<addr>_test.json
│       │       └── owner_<addr>_details.jsonl
│       ├── comparisons/
│       │   ├── duplicates.json        # All duplicates found
│       │   ├── missing.json           # Missing transactions
│       │   └── discrepancies.json     # Data mismatches
│       ├── report.html                # Human-readable HTML report
│       ├── report.json                # Machine-readable summary
│       └── metrics.json               # Performance metrics
└── latest -> runs/2025-01-22-10-30-45 # Symlink to latest run
```

## Report Analysis

### HTML Report

Open `test-results/latest/report.html` in a browser for an interactive view of:
- Test summary and statistics
- Performance metrics comparison
- Detailed issue breakdown
- Entity-by-entity results

### JSON Report

Machine-readable summary in `test-results/latest/report.json` containing:
- Complete test results
- Issue categorization
- Performance metrics
- Entity metadata

### CSV Export

Export results to CSV for spreadsheet analysis:

```bash
./tools/test-clickhouse-graphql --export-csv results.csv
```

## Understanding Results

### Issue Types

- **Duplicates**: Same transaction ID appears multiple times
- **Missing**: Transaction exists in one source but not the other
- **Discrepancies**: Same transaction has different field values

### Severity Levels

- **Critical**: Core transaction data differs (ID, owner, amount, etc.)
- **Minor**: Non-essential differences (timestamps, formatting)
- **Informational**: Expected differences (owner keys, metadata)

### Pagination Issues

- **Inconsistent Ordering**: Results not properly sorted by height
- **Missing Transactions**: Gaps in pagination sequences
- **Duplicate Across Pages**: Same transaction appears on multiple pages

## Troubleshooting

### Connection Issues

1. **ClickHouse Connection Failed**
   - Verify ClickHouse is running: `curl http://localhost:8123/ping`
   - Check credentials and URL in configuration

2. **Local GraphQL Endpoint Failed**
   - Verify AR.IO node is running with GraphQL enabled
   - Check endpoint URL (typically `http://localhost:4000/graphql`)

3. **Remote GraphQL Endpoint Failed**
   - Check internet connectivity
   - Verify arweave.net is accessible

### Performance Issues

1. **Slow Queries**
   - Reduce `pageSize` in configuration
   - Lower `maxPagesPerTest` to limit scope
   - Test fewer entities at once

2. **Timeout Errors**
   - Increase query timeout in GraphQL client
   - Check network latency to remote endpoint

### Data Issues

1. **No Drive-Ids Found**
   - Verify ClickHouse has ArDrive data
   - Check if Drive-Id tags are properly indexed
   - Try lowering `minTransactionCount`

2. **No Owners Found**
   - Verify owner_transactions table is populated
   - Check ClickHouse indexing status

## Advanced Usage

### Testing Specific Height Ranges

```bash
# Test entities with transactions in specific height range
./tools/test-clickhouse-graphql --auto-discover --min-height 1000000 --max-height 1100000
```

### Custom Comparison Settings

Create a configuration file with custom comparison rules:

```json
{
  "comparison": {
    "strictComparison": true,
    "checkOwnerKeys": true,
    "tolerateTimestampDifference": 0,
    "ignoreFields": []
  }
}
```

### Continuous Monitoring

Set up scheduled testing to monitor data consistency:

```bash
# Run hourly with cron
0 * * * * /path/to/ar-io-node/tools/test-clickhouse-graphql --auto-discover --top 5
```

## Contributing

When modifying the testing tool:

1. Update type definitions in the main script
2. Add comprehensive error handling
3. Include progress logging for long operations
4. Update documentation for new features
5. Test with various ClickHouse and GraphQL configurations