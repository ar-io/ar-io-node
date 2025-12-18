# CDB64 Tools

Tools for working with CDB64 index files. See [cdb64-format.md](./cdb64-format.md) for the file format specification.

## generate-cdb64-root-tx-index-rs

The `tools/generate-cdb64-root-tx-index-rs` script generates CDB64 index files from CSV input. It uses the Rust-backed `cdb64` library for improved performance.

### Usage

```bash
./tools/generate-cdb64-root-tx-index-rs --input <csv-file> --output <cdb-file> [--skip-header]
```

**Options:**
- `--input <path>` - Input CSV file path (required)
- `--output <path>` - Output CDB64 file path (required)
- `--skip-header` - Skip the first line of the CSV (default: false)
- `--help` - Show usage information

**Example:**
```bash
./tools/generate-cdb64-root-tx-index-rs --input data-item-mappings.csv --output index.cdb
```

## Building the Native Dependency

The `cdb64` package is a Rust-based native module that must be compiled for your platform. It's listed as an optional dependency and may not have pre-built binaries available.

**Prerequisites:**
- Rust toolchain (install via [rustup](https://rustup.rs/))
- Node.js development headers

**Build steps:**

```bash
# Navigate to the cdb64 node bindings directory
cd node_modules/cdb64/node

# Install build dependencies
yarn install

# Build the native module
yarn build

# Return to project root
cd ../../..
```

After building, you should see a `.node` file in `node_modules/cdb64/node/`:
- Linux (glibc): `cdb64.linux-x64-gnu.node`
- Linux (musl): `cdb64.linux-x64-musl.node`
- macOS (Intel): `cdb64.darwin-x64.node`
- macOS (Apple Silicon): `cdb64.darwin-arm64.node`

**Troubleshooting:**

If you see an error like:
```
Error: Cannot find module 'cdb64-linux-x64-gnu'
```

This means the native module hasn't been built. Follow the build steps above.

**Note:** The build artifacts are not committed to git and must be rebuilt after:
- Fresh `yarn install`
- Updating the `cdb64` dependency
- Switching between platforms
