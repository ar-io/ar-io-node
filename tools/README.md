# AR.IO Node Development Tools

This directory contains development and documentation tools for the AR.IO Node project.

## Tools

### `fetch-with-hint`
Fetches a data item from the gateway using client-supplied root TX ID and nesting path hints. Resolves the root L1 transaction via GraphQL `bundledIn` traversal, then sends the request with `X-AR-IO-Root-Transaction-Id` and `X-AR-IO-Root-Path` headers so the gateway can skip server-side index lookups. Alternatively, can supply pre-computed byte offsets to skip bundle parsing entirely.

**Usage:**
```bash
# Fetch a data item using hint headers (output to stdout)
./tools/fetch-with-hint <data-item-id>

# Specify gateway and save to file
./tools/fetch-with-hint <data-item-id> --gateway http://localhost:4000 --output data.bin

# Use a different GraphQL endpoint with verbose output
./tools/fetch-with-hint <data-item-id> --graphql https://arweave.net/graphql --verbose

# Use direct offset hints (skips GraphQL resolution and bundle parsing)
./tools/fetch-with-hint <data-item-id> --root-tx-id <root-tx> --offset 12345 --size 6789
```

**Options:**
- `--gateway <url>` - Gateway URL to fetch from (default: `http://localhost:4000`)
- `--graphql <url>` - GraphQL endpoint for root path resolution (default: `https://arweave.net/graphql`)
- `--output <file>` - Write output to file instead of stdout
- `--offset <n>` - Data item offset hint (byte offset of item start within root TX)
- `--size <n>` - Data item size hint (total item size including headers)
- `--root-tx-id <id>` - Root TX ID (use with `--offset`/`--size` to skip GraphQL resolution)
- `--verbose` - Show resolution details (root TX, path, response info)
- `--help` - Show help message

### `generate-architecture-pdf`
Analyzes the repository structure and generates a comprehensive architecture review document in both markdown and PDF formats. The analysis covers:
- Directory structure and file organization
- Type system analysis
- Database schemas and SQL statements
- Module relationships and dependencies
- API surface analysis
- Test coverage metrics
- Internal tools and AI configuration
- Repository statistics

The tool then converts the markdown into an e-reader optimized PDF using pandoc with typst as the PDF engine.

**Dependencies:** `pandoc` and `typst` (available in the project's Nix flake)

**Usage:**
```bash
./tools/generate-architecture-pdf

# Skip test coverage generation (use cached results)
SKIP_COVERAGE=true ./tools/generate-architecture-pdf
```

**Output:**
- `architecture-review.md` - Comprehensive markdown analysis
- `architecture-review.pdf` - E-reader optimized PDF (Kindle format)

### `test-chunk-retrieval`
Load testing tool for chunk retrieval endpoints. Tests `/chunk/{offset}` requests with configurable concurrency, duration, and resource monitoring. Useful for stress testing, identifying resource leaks, and validating stability under load.

**Usage:**
```bash
# Basic load test for 60 seconds (10 concurrent requests)
./tools/test-chunk-retrieval --gateway http://localhost:4000 --duration 60

# High concurrency with file descriptor tracking
./tools/test-chunk-retrieval --gateway http://localhost:4000 \
  --concurrency 100 --duration 120 --track-fds $(pgrep -f "node.*system")

# Fixed count test
./tools/test-chunk-retrieval --gateway http://localhost:4000 \
  --count 5000 --concurrency 50

# Stress test
./tools/test-chunk-retrieval --gateway http://localhost:4000 \
  --concurrency 500 --duration 300

# With chain reference for weave size
./tools/test-chunk-retrieval --gateway http://localhost:4000 \
  --chain-url https://arweave.net --duration 60
```

**Options:**
- `--gateway <url>` - Gateway URL to test (required)
- `--concurrency <n>` - Number of parallel requests (default: 10)
- `--count <n>` - Stop after N total requests
- `--duration <seconds>` - Run for specified duration
- `--delay <ms>` - Delay between requests per slot (default: 0)
- `--timeout <ms>` - Request timeout in milliseconds (default: 30000)
- `--chain-url <url>` - Chain reference URL for weave size discovery
- `--max-offset <number>` - Override maximum offset for testing
- `--track-fds <pid>` - Track file descriptors for specified PID (Linux only)
- `--fd-interval <ms>` - FD sampling interval in ms (default: 1000)
- `--verbose` - Show detailed logs for each request
- `--help` - Show help message

**Output:**
```text
=== Chunk Retrieval Load Test Results ===
Gateway: http://localhost:4000
Duration: 2m 0s
Concurrency: 100
Requests/sec: 104.5
Total Requests: 12,543
Successes: 11,987 (95.57%)
Failures: 556 (4.43%)

Status Codes:
  - 200 OK: 11,987
  - 404 Not Found: 312
  - 0 Network Error: 244

Error Codes:
  - ECONNABORTED: 189
  - ECONNRESET: 55
  - EMFILE: 3 [RESOURCE EXHAUSTION]

Response Times:
  - Min: 8ms
  - Max: 5,234ms
  - Avg: 156ms
  - p50: 98ms
  - p95: 567ms
  - p99: 1,892ms

File Descriptor Tracking (PID: 12345):
  - Initial: 127
  - Final: 412
  - Min: 127
  - Max: 523
  - Average: 298.4
  - Delta: +285
  - WARNING: Significant FD growth detected!
```

**Use Cases:**
- Load test chunk retrieval under high concurrency
- Identify resource leaks (file descriptors, connections)
- Validate stability fixes under sustained load
- Stress test gateway configuration limits
- Monitor resource usage during load tests

### `generate-offset-mapping`
Generates a static offset-to-block mapping file that maps Arweave weave byte offsets to approximate block heights. This mapping is used to optimize binary search when looking up transactions by offset, reducing the search space from the entire blockchain to a much smaller range.

**Usage:**
```bash
./tools/generate-offset-mapping

# With custom gateway
./tools/generate-offset-mapping --gateway https://arweave.net

# With custom output path
./tools/generate-offset-mapping --output ./custom-mapping.json
```

**Options:**
- `--gateway <url>` - Gateway URL to fetch block data (default: https://arweave.net)
- `--output <path>` - Output file path (default: src/data/offset-block-mapping.json)
- `--help` - Show help message

**Output:**
Generates a JSON file containing:
- Version and generation timestamp
- Current chain height and weave size
- Intervals at 5TB increments mapping offset to block height

**Performance Impact:**
- Reduces binary search iterations from ~21 to ~15 (approximately 29% reduction)
- Most significant improvement during cold starts when block caches are empty
- Each iteration saved is one fewer network call to fetch a block

**Use Cases:**
- Update the offset mapping before each release
- Generate fresh mapping if the included one becomes outdated
- Create custom mappings for testing purposes

### `arweave-partitions-to-heights`
Converts Arweave storage partition files to height ranges for data analysis and partitioning operations. This tool helps translate between Arweave's partition-based storage system and height-based queries.

**Usage:**
```bash
./tools/arweave-partitions-to-heights [options]
```

**Use Cases:**
- Convert storage partitions to height ranges for data queries
- Analyze data distribution across storage partitions
- Support migration and data management operations
- Enable height-based analytics on partitioned data

### `queue-missing-bundles`
Streams a CSV of `(data_item_id, bundle_id, ...)` rows, identifies the data items missing from ClickHouse, and POSTs the associated bundles to `/ar-io/admin/queue-bundle` on a running core service. Deduplicates bundle IDs within the run, handles HTTP 429 backpressure from the bundle importer queue with exponential backoff, and streams the input so tens of millions of rows fit in bounded memory. The CSV header is optional and auto-detected; the first two columns (data item ID, bundle ID) are used and any remaining columns are ignored. Defaults for the core port, admin API key, and ClickHouse credentials are read from `.env`.

**Usage:**
```bash
# Defaults from .env: http://localhost:${CORE_PORT:-4000} and http://${CLICKHOUSE_HOST:-localhost}:${CLICKHOUSE_PORT_2:-8123}
./tools/queue-missing-bundles --input data-items.csv

# Dry run (check ClickHouse but don't POST)
./tools/queue-missing-bundles --input data-items.csv --dry-run

# Read from stdin with custom endpoints / parallelism
cat data-items.csv | ./tools/queue-missing-bundles --input - \
  --core-url http://localhost:4000 \
  --clickhouse-url http://localhost:8123 \
  --batch-size 20000 --concurrency 8
```

Run `./tools/queue-missing-bundles --help` for the full flag list.

## Release tools

Small, composable primitives used by the release workflow. Each tool does one
thing — reads state, or applies one narrow mutation. All tools are idempotent
where sensible. Orchestration (preflight checks, commits, GitHub Actions
polling, docker profile testing, tagging) is handled by the `release` skill
under `.claude/skills/release/`. See also `docs/processes/release.md`.

### `release-info`
Prints release-related state from the working tree.

**Usage:**
```bash
./tools/release-info          # human-readable
./tools/release-info --json   # JSON output
```

**Output (JSON mode):**
```json
{
  "version": "52-pre",
  "versionIsPre": true,
  "arIoNodeRelease": "52-pre",
  "changelogUnreleasedHasContent": true,
  "imageTags": {
    "ENVOY_IMAGE_TAG": "latest",
    "CORE_IMAGE_TAG": "latest",
    "CLICKHOUSE_AUTO_IMPORT_IMAGE_TAG": "latest",
    "LITESTREAM_IMAGE_TAG": "latest",
    "OBSERVER_IMAGE_TAG": "21098d2ab630348d56339a745f020374a699d378"
  }
}
```

### `set-version`
Updates the `release` constant in `src/version.ts`.

```bash
./tools/set-version 52       # release
./tools/set-version 53-pre   # pre-release
```

### `set-ar-io-node-release`
Updates the default for `AR_IO_NODE_RELEASE` in `docker-compose.yaml`.

```bash
./tools/set-ar-io-node-release 52
./tools/set-ar-io-node-release 53-pre
```

### `set-image-tag`
Updates the default for a single `*_IMAGE_TAG` env var in
`docker-compose.yaml`. Value must be `latest` or a 40-character git SHA.

```bash
./tools/set-image-tag CORE_IMAGE_TAG latest
./tools/set-image-tag CORE_IMAGE_TAG 21098d2ab630348d56339a745f020374a699d378
```

### `changelog-release`
Replaces the `## [Unreleased]` heading in `CHANGELOG.md` with
`## [Release N] - DATE`. Date defaults to today (UTC).

```bash
./tools/changelog-release 52
./tools/changelog-release 52 --date 2026-04-17
```

### `changelog-add-unreleased`
Inserts a fresh `## [Unreleased]` section (with empty Added/Changed/Fixed
subheadings) before the most recent `## [Release N]` heading. Idempotent if
an `[Unreleased]` section already exists.

```bash
./tools/changelog-add-unreleased
```

### `wt`
Git worktree helper for parallel development. Creates worktrees under `wt/<branch>` with `.env` and `CLAUDE.local.md` symlinked from the main checkout.

**Usage:**
```bash
# Create a new branch off develop with a worktree
./tools/wt add my-feature

# Check out an existing branch into a worktree
./tools/wt add my-feature --existing

# Remove a worktree
./tools/wt rm my-feature

# List all worktrees
./tools/wt ls
```

**Behavior:**
- Creates worktree at `wt/<branch>/`
- Symlinks `.env` and `CLAUDE.local.md` from the main checkout (if they exist)
- Runs `yarn install` in the new worktree automatically
- Each worktree gets a clean `data/` directory (not shared with main checkout)

**Use Cases:**
- Work on a feature branch while keeping develop clean for reviews
- Run tests on one branch while developing on another
- Quickly switch between multiple in-flight features

## Workflow

To generate a complete architecture review document:

1. Run the analysis script to generate markdown
2. Convert to PDF for e-reader consumption

```bash
# Generate both markdown and PDF
./tools/generate-architecture-pdf

# Quick generation for testing (skips coverage analysis)
SKIP_COVERAGE=true ./tools/generate-architecture-pdf

# Or convert existing markdown to PDF manually
pandoc architecture-review.md -o architecture-review.pdf --pdf-engine=typst --variable=papersize:a5
```

The resulting PDF is optimized for 6-inch e-readers with appropriate margins, font sizes, and table of contents for easy navigation.