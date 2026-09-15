# CDB64 Tools

Tools for generating, exporting, verifying, and uploading CDB64 index files. See
[cdb64-format.md](./cdb64-format.md) for the file format specification and
[cdb64-guide.md](./cdb64-guide.md) for operational guidance.

## Overview

| Tool | Description | Implementation |
|------|-------------|----------------|
| [`generate-cdb64-root-tx-index-rs`](#generate-cdb64-root-tx-index-rs) | Generate CDB64 from CSV (Rust, recommended) | Rust (`cdb64` napi) |
| [`generate-cdb64-root-tx-index`](#generate-cdb64-root-tx-index) | Generate CDB64 from CSV (JS fallback) | TypeScript |
| [`export-sqlite-to-cdb64`](#export-sqlite-to-cdb64) | Export from local `data.db` to CDB64 | TypeScript |
| [`export-cdb64-root-tx-index`](#export-cdb64-root-tx-index) | Export CDB64 back to CSV | TypeScript |
| [`upload-cdb64-to-arweave`](#upload-cdb64-to-arweave) | Upload partitioned CDB64 to Arweave | TypeScript (Turbo SDK) |
| [`verify-cdb64`](#verify-cdb64) | Verify CDB64 against CSV | TypeScript |
| [`scan-bundle-offsets`](#scan-bundle-offsets) | Scan root bundles' headers into CSV with offsets and item sizes | TypeScript |
| [`build-cdb64-napi`](#building-the-native-dependency) | Build the Rust napi-rs native module | Bash |

## CSV Format

The generate, export, and verify tools share a common CSV format for data item
to root transaction mappings:

```text
data_item_id,root_tx_id,path,root_data_item_offset,root_data_offset,data_item_size
```

**Columns:**

| Column | Required | Description |
|--------|----------|-------------|
| `data_item_id` | Yes | Base64URL-encoded data item ID (43 characters) |
| `root_tx_id` | Yes | Base64URL-encoded root transaction ID (43 characters) |
| `path` | No | JSON array of base64URL IDs for nested bundles (e.g., `["rootId","bundle1Id","parentId"]`) |
| `root_data_item_offset` | No | Byte offset of data item within root transaction |
| `root_data_offset` | No | Byte offset of data within root transaction |
| `data_item_size` | No | Total data item size in bytes (header + payload) |

- If offset columns are present, **both** must be provided
- `data_item_size` requires both offset columns and must be at least the
  header size (`root_data_offset - root_data_item_offset`). Without it the
  gateway searches the bundle header to find where the item ends; with it,
  one read of the item header is enough (see
  [Item size](cdb64.md#item-size)). Existing five-column files remain valid;
  as before, every row in a file must have the same number of columns.
- Headers are auto-detected and skipped, or can be explicitly skipped with
  `--skip-header`
- Comment lines starting with `#` are ignored

**Value format variants** (determined by which columns are populated):

| Format | Columns Used | Use Case |
|--------|-------------|----------|
| Simple | `data_item_id`, `root_tx_id` | Legacy: root TX ID only |
| Complete | All except `path` | Legacy: root TX ID + byte offsets (+ optional item size) |
| Path | `data_item_id`, `root_tx_id`, `path` | Nested bundles: traversal path |
| Path Complete | All columns | Nested bundles: path + byte offsets (+ optional item size) |

## scan-bundle-offsets

Produces CSV input with offsets **and item sizes** for every data item in a
list of root bundles, nested bundles included. Only each bundle's item index
and item headers are read, through range requests to a gateway's
`/raw/<rootTxId>`.

```bash
./tools/scan-bundle-offsets --input roots.txt --output offsets.csv --details details.csv
./tools/generate-cdb64-root-tx-index-rs --input offsets.csv --partitioned --output-dir ./index/
```

| Option | Description |
|--------|-------------|
| `--input <path>` | Root bundle IDs, one per line or first CSV column (`-` for stdin) |
| `--bundle <id>` | Root bundle ID to scan (repeatable) |
| `--gateway <url>` | Gateway to read from (default `http://localhost:4000`) |
| `--output <path>` | Output CSV in the format above (appended to when resuming) |
| `--details <path>` | Optional `root_tx_id,data_item_id,depth,signature_type,content_type,is_bundle,data_item_size` |
| `--progress <path>` | Progress file (default `<output>.progress`) |
| `--concurrency <n>` | Roots scanned in parallel (default 2) |
| `--window-bytes <n>` | Largest coalesced header read (default 1 MiB) |
| `--header-guess-bytes <n>` | Bytes read per item when coalescing (default 2 KiB) |
| `--timeout-ms <n>`, `--retries <n>` | Per-request timeout and retries (defaults 60000, 3) |

How it works and what it verifies:

- **Size.** The root's size comes from the `Content-Range` total of a 32-byte
  range read of `/raw`. A HEAD isn't used, because a HEAD for an uncached ID
  makes the gateway fetch the whole root in the background. An ID the gateway
  reports as a data item (`X-AR-IO-Root-Transaction-Id` differs) is refused,
  since offsets must be relative to an L1 transaction.
- **Index.** The item index must fit in the bundle, and the listed items must
  end exactly at the bundle's size.
- **Headers.** Every item header is decoded, and the SHA-256 of its signature
  must equal the ID in the index. Items tagged `Bundle-Format: binary` and
  `Bundle-Version: 2.0.0` are scanned recursively. Their items get a `path` of
  `[root, ..., parent]` and offsets relative to the root.
- **Coalesced reads.** Consecutive items share one range read while it spans at
  most `--window-bytes`, each contributing up to `--header-guess-bytes`, so
  bundles of small items read nearly sequentially and bundles of large items
  read a few KiB per item.
- **Failures.** A root that fails verification is recorded as `failed` in the
  progress file and contributes no rows. A nested bundle that fails is reported
  as a warning, and the root's other items are still written.
- **Resuming.** A root's rows are appended only after the whole root is scanned.
  Re-running the same command skips roots recorded as `ok`.

## generate-cdb64-root-tx-index-rs

Generates a CDB64 index file from a CSV file using the **Rust-backed `cdb64`
library**. This is the recommended tool for single-file generation due to better
performance.

### Usage

```bash
./tools/generate-cdb64-root-tx-index-rs [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--input, -i <path>` | Input CSV file path (required) |
| `--output, -o <path>` | Output CDB64 file path (required unless `--partitioned`) |
| `--partitioned` | Enable partitioned output (splits by key prefix into `00.cdb`-`ff.cdb`) |
| `--output-dir <path>` | Output directory for partitioned index (required with `--partitioned`) |
| `--skip-header` | Skip the first line of the CSV (default: false) |
| `--force, -f` | Overwrite output file/directory if it exists |
| `--help, -h` | Show usage information |

**Examples:**

```bash
# Single file output
./tools/generate-cdb64-root-tx-index-rs --input mappings.csv --output index.cdb

# Partitioned output (256 partition files)
./tools/generate-cdb64-root-tx-index-rs --input data.csv --partitioned --output-dir ./index/

# Overwrite existing output
./tools/generate-cdb64-root-tx-index-rs -i mappings.csv -o index.cdb --force
```

## generate-cdb64-root-tx-index

Generates a CDB64 index file from a CSV file using the **TypeScript
implementation**. This is the fallback tool when the Rust native dependency is
not available. Accepts identical options to the Rust variant.

### Usage

```bash
./tools/generate-cdb64-root-tx-index [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--input, -i <path>` | Input CSV file path (required) |
| `--output, -o <path>` | Output CDB64 file path (required unless `--partitioned`) |
| `--partitioned` | Enable partitioned output (splits by key prefix into `00.cdb`-`ff.cdb`) |
| `--output-dir <path>` | Output directory for partitioned index (required with `--partitioned`) |
| `--skip-header` | Skip the first line of the CSV (default: false) |
| `--force, -f` | Overwrite output file/directory if it exists |
| `--help, -h` | Show usage information |

**Examples:**

```bash
# Single file output
./tools/generate-cdb64-root-tx-index --input mappings.csv --output index.cdb

# Partitioned output
./tools/generate-cdb64-root-tx-index --input data.csv --partitioned --output-dir ./index/
```

## export-sqlite-to-cdb64

Exports root TX mappings from the local `data.db` SQLite database directly to
CDB64 format. Reads from the `contiguous_data_ids` table and produces simple or
complete format values depending on whether offset data is available.

**Important:** Stop the ar-io-node service before running this tool to ensure
data consistency during the export.

### Usage

```bash
./tools/export-sqlite-to-cdb64 [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--data-db <path>` | Path to `data.db` file (default: `./data/sqlite/data.db`) |
| `--output, -o <path>` | Output CDB64 file path (required unless `--partitioned`) |
| `--partitioned` | Enable partitioned output (splits by key prefix into `00.cdb`-`ff.cdb`) |
| `--output-dir <path>` | Output directory for partitioned index (required with `--partitioned`) |
| `--help, -h` | Show usage information |

**Examples:**

```bash
# Single file output (uses default data.db path)
./tools/export-sqlite-to-cdb64 --output root-tx-index.cdb

# Custom database path
./tools/export-sqlite-to-cdb64 --data-db /path/to/data.db --output root-tx-index.cdb

# Partitioned output
./tools/export-sqlite-to-cdb64 --partitioned --output-dir ./root-tx-index/
```

## export-cdb64-root-tx-index

Exports a CDB64 index file back to CSV format. Iterates over all entries in the
CDB64 file and writes them as CSV rows in the shared CSV format. Supports
writing to a file or to stdout.

### Usage

```bash
./tools/export-cdb64-root-tx-index [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--input, -i <path>` | Input CDB64 file path (required) |
| `--output, -o <path>` | Output CSV file path (required, use `"-"` for stdout) |
| `--no-header` | Omit CSV header row |
| `--help, -h` | Show usage information |

**Examples:**

```bash
# Export to CSV file
./tools/export-cdb64-root-tx-index --input index.cdb --output data.csv

# Export to stdout (progress/summary goes to stderr)
./tools/export-cdb64-root-tx-index --input index.cdb --output -

# Export without header row
./tools/export-cdb64-root-tx-index --input index.cdb --output data.csv --no-header
```

## upload-cdb64-to-arweave

Uploads partitioned CDB64 partition files (`.cdb`) to Arweave using the Turbo
SDK and generates a manifest with `arweave-byte-range` location types for
byte-range reads from Arweave gateways. The upload operates in three phases:

1. **Phase 1 (Upload):** Uploads each partition file to Turbo, saving the data
   item ID with an `arweave-pending` location type. Saves atomically after each
   upload for resumability.
2. **Phase 2 (Resolve):** Polls the Turbo offsets API to get root bundle IDs and
   byte offsets, updating each partition to `arweave-byte-range` location type.
3. **Phase 3 (Manifest Upload, optional):** Uploads the final manifest to
   Arweave via Turbo or directly to L1.

### Usage

```bash
./tools/upload-cdb64-to-arweave [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--input, -i <path>` | Input directory with partitioned CDB64 (required) |
| `--wallet, -w <path>` | Path to Arweave JWK wallet file (required) |
| `--output, -o <path>` | Output manifest path (default: `<input>/manifest-arweave.json`) |
| `--name, -n <name>` | Descriptive name for this CDB index (added to tags) |
| `--dry-run` | Show cost estimate and exit without uploading |
| `--resume` | Resume from previous partial upload/resolution |
| `--upload-only` | Upload partitions but skip offset resolution phase |
| `--resolve-only` | Skip upload, only resolve offsets for pending partitions |
| `--upload-manifest` | Upload final manifest via Turbo after all partitions resolved |
| `--upload-manifest-l1` | Upload final manifest directly to Arweave L1 (not bundled) |
| `--concurrency <n>` | Parallel uploads (default: 1) |
| `--app-name <name>` | App-Name tag (default: `"AR.IO-CDB64"`) |
| `--verbose` | Show detailed per-partition progress |
| `--help, -h` | Show usage information |

**Mutually exclusive options:**

- `--upload-only` and `--resolve-only` cannot be used together
- `--upload-manifest` and `--upload-manifest-l1` cannot be used together

**Examples:**

```bash
# Dry run to see cost estimate
./tools/upload-cdb64-to-arweave -i ./index -w ./wallet.json --dry-run

# Phase 1 only: upload partitions
./tools/upload-cdb64-to-arweave -i ./index -w ./wallet.json --upload-only

# Phase 2 only: resolve offsets for already-uploaded partitions
./tools/upload-cdb64-to-arweave -i ./index -w ./wallet.json --resolve-only

# Full upload with manifest via Turbo
./tools/upload-cdb64-to-arweave -i ./index -w ./wallet.json -n "root-tx-index" --upload-manifest

# Resume interrupted upload
./tools/upload-cdb64-to-arweave -i ./index -w ./wallet.json --resume

# Parallel uploads
./tools/upload-cdb64-to-arweave -i ./index -w ./wallet.json --concurrency 4
```

## verify-cdb64

Verifies that IDs from a CSV file exist in a CDB64 index file. Supports
sequential and random sampling modes, and can optionally compare root TX ID
values against the CSV. Exits with code 1 if any IDs are missing, mismatched, or
produce errors.

### Usage

```bash
./tools/verify-cdb64 --cdb64 <file> --csv <file> [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--cdb64 <file>` | CDB64 file to verify against (required) |
| `--csv <file>` | CSV file with IDs in first column (required) |
| `--compare-values` | Compare root TX IDs against second column in CSV |
| `--mode <mode>` | Sampling mode: `random` or `sequential` (default: `sequential`) |
| `--count <n>` | Number of IDs to check (default: all for sequential, 1000 for random) |
| `--skip-header` | Skip the first row of CSV |
| `--verbose` | Show each missing/mismatched ID |
| `--json` | Output results as JSON |
| `--help, -h` | Show usage information |

**Sampling modes:**

- **sequential** - Reads IDs in order from the start of the file. Checks all IDs
  unless `--count` limits it.
- **random** - Samples random IDs by seeking to random file positions. Defaults
  to 1000 samples.

**Examples:**

```bash
# Basic verification (sequential, all IDs)
./tools/verify-cdb64 --cdb64 root-tx-index.cdb --csv ids.csv

# Verify values match CSV (existence + value comparison)
./tools/verify-cdb64 --cdb64 root-tx-index.cdb --csv ids.csv --compare-values --skip-header

# Sequential mode - check first 1000
./tools/verify-cdb64 --cdb64 root-tx-index.cdb --csv ids.csv --count 1000

# Random mode - sample 500 random IDs
./tools/verify-cdb64 --cdb64 root-tx-index.cdb --csv ids.csv --mode random --count 500

# Show missing/mismatched IDs
./tools/verify-cdb64 --cdb64 root-tx-index.cdb --csv ids.csv --verbose

# JSON output for scripting
./tools/verify-cdb64 --cdb64 root-tx-index.cdb --csv ids.csv --mode random --json
```

## Workflows

### Export from SQLite, verify, and upload

```bash
# 1. Stop the service for a consistent snapshot
yarn service:stop

# 2. Export from data.db to partitioned CDB64
./tools/export-sqlite-to-cdb64 --partitioned --output-dir ./root-tx-index/

# 3. Restart the service
yarn service:start

# 4. Export CDB64 back to CSV for verification
./tools/export-cdb64-root-tx-index --input ./root-tx-index/00.cdb --output ./verify.csv

# 5. Verify the exported CDB64 (random sample)
./tools/verify-cdb64 --cdb64 ./root-tx-index/00.cdb --csv ./verify.csv --mode random --count 5000
# Note: Steps 4-5 are a round-trip sanity check verifying that the CDB64
# export/import pipeline works correctly for a single partition. This does
# NOT verify all partitions or compare against the original SQLite database.

# 6. Dry run to check upload cost
./tools/upload-cdb64-to-arweave -i ./root-tx-index -w ./wallet.json --dry-run

# 7. Upload to Arweave with manifest
./tools/upload-cdb64-to-arweave -i ./root-tx-index -w ./wallet.json -n "root-tx-index" --upload-manifest
```

### Generate partitioned index from CSV

```bash
# 1. Generate partitioned CDB64 from CSV (Rust, recommended)
./tools/generate-cdb64-root-tx-index-rs --input mappings.csv --partitioned --output-dir ./index/

# 2. Verify against original CSV (random sample)
./tools/verify-cdb64 --cdb64 ./index/00.cdb --csv mappings.csv --mode random --count 10000 --compare-values --skip-header

# 3. Upload to Arweave
./tools/upload-cdb64-to-arweave -i ./index -w ./wallet.json -n "my-index" --upload-manifest --concurrency 4
```

## Building the Native Dependency

The `cdb64` package is a Rust-based native module that must be compiled for your
platform. It's listed as an optional dependency and may not have pre-built
binaries available.

**Prerequisites:**

- Rust toolchain (install via [rustup](https://rustup.rs/))
- Node.js development headers

**Build steps:**

```bash
./tools/build-cdb64-napi
```

After building, you should see a `.node` file in `node_modules/cdb64/node/`:

- Linux (glibc): `cdb64.linux-x64-gnu.node`
- Linux (musl): `cdb64.linux-x64-musl.node`
- macOS (Intel): `cdb64.darwin-x64.node`
- macOS (Apple Silicon): `cdb64.darwin-arm64.node`

**Troubleshooting:**

If you see an error like:

```text
Error: Cannot find module 'cdb64-linux-x64-gnu'
```

This means the native module hasn't been built. Follow the build steps above.

**Note:** The build artifacts are not committed to git and must be rebuilt after:

- Fresh `yarn install`
- Updating the `cdb64` dependency
- Switching between platforms
