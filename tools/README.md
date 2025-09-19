# AR.IO Node Development Tools

This directory contains development and documentation tools for the AR.IO Node project.

## Tools

### `generate-architecture-review.ts`
Analyzes the repository structure and generates a comprehensive markdown document covering:
- Directory structure and file organization
- Type system analysis
- Database schemas and SQL statements
- Module relationships and dependencies
- API surface analysis
- Test coverage metrics
- Internal tools and AI configuration
- Repository statistics

**Usage:**
```bash
node --import ./register.js tools/generate-architecture-review.ts
```

**Output:** `architecture-review.md` in the project root

### `generate-architecture-pdf`
Converts the architecture review markdown into an e-reader optimized PDF using pandoc with typst as the PDF engine.

**Dependencies:** `pandoc` and `typst` (available in the project's Nix flake)

**Usage:**
```bash
./tools/generate-architecture-pdf

# Skip test coverage generation (use cached results)
SKIP_COVERAGE=true ./tools/generate-architecture-pdf
```

**Output:** `architecture-review.pdf` in the project root, optimized for Kindle and other e-readers

### `sample-chunk-offsets`
Continuously samples random chunk offsets within the Arweave weave and tests chunk retrieval against a specified gateway URL, reporting success rates and performance statistics. Useful for monitoring gateway health and debugging chunk retrieval issues.

**Usage:**
```bash
./tools/sample-chunk-offsets --gateway https://ar-io.dev

# With custom delay between requests (500ms)
./tools/sample-chunk-offsets --gateway http://localhost:4000 --delay 500

# Test local gateway using external chain reference for weave size
./tools/sample-chunk-offsets --gateway http://localhost:4000 --chain-url https://arweave.net

# With verbose output showing each request
./tools/sample-chunk-offsets --gateway https://gateway.example.com --verbose

# With custom timeout and all options
./tools/sample-chunk-offsets --gateway https://ar-io.dev --delay 200 --timeout 15000 --verbose
```

**Options:**
- `--gateway <url>` - Gateway URL to test (required)
- `--chain-url <url>` - Chain reference URL for weave size discovery (optional)
- `--delay <ms>` - Delay between requests in milliseconds (default: 100)
- `--timeout <ms>` - Request timeout in milliseconds (default: 300000)
- `--max-offset <number>` - Override maximum offset for testing smaller ranges
- `--verbose` - Show detailed logs for each request
- `--help` - Show help message

**Output:**
The tool runs continuously until interrupted with Ctrl+C, then displays comprehensive statistics:
```
=== Chunk Offset Sampling Results ===
Gateway: https://ar-io.dev
Duration: 5m 32s
Total Attempts: 3,320
Successes: 3,150 (94.88%)
Failures: 170 (5.12%)
  - 404 Not Found: 150
  - 500 Server Error: 15
  - Timeout: 5
Response Times:
  - Min: 45ms
  - Max: 2,340ms
  - Average: 234ms
  - p50: 180ms
  - p95: 890ms
  - p99: 1,850ms
```

**Use Cases:**
- Monitor chunk retrieval health across the network
- Test gateway reliability and performance
- Debug offset-aware chunk retrieval issues
- Gather empirical data on chunk availability
- Validate gateway configuration and performance

## Workflow

To generate a complete architecture review document:

1. Run the analysis script to generate markdown
2. Convert to PDF for e-reader consumption

```bash
# Generate both markdown and PDF
./tools/generate-architecture-pdf

# Quick generation for testing (skips coverage analysis)
SKIP_COVERAGE=true ./tools/generate-architecture-pdf

# Or run steps separately
node --import ./register.js tools/generate-architecture-review.ts
pandoc architecture-review.md -o architecture-review.pdf --pdf-engine=typst --variable=papersize:a5
```

The resulting PDF is optimized for 6-inch e-readers with appropriate margins, font sizes, and table of contents for easy navigation.