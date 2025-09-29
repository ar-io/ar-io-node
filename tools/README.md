# AR.IO Node Development Tools

This directory contains development and documentation tools for the AR.IO Node project.

## Tools

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

### `release-status`
Checks the current state of the repository and determines if it's ready for a release. This tool provides a comprehensive overview of version status, git branch, working tree cleanliness, changelog content, and docker image configurations.

**Usage:**
```bash
./tools/release-status
```

**Output Example:**
```
📊 AR.IO Node Release Status
============================
Current Version: 52-pre (development)
Branch: develop ✅
Working Tree: clean ✅
Changelog: Has unreleased entries ✅
Docker Images: Using 'latest' tags ✅
AR_IO_NODE_RELEASE: 52-pre ✅

Ready for Release: ✅ YES
Suggested Release Number: 52
```

**Use Cases:**
- Verify repository is ready for release preparation
- Check current development state and version
- Identify issues that need to be resolved before release
- Get suggested next release number

### `prepare-release`
Automates the initial steps of preparing a new release by updating version files, changelog dates, and docker configurations. This tool ensures consistent release preparation while validating preconditions.

**Usage:**
```bash
./tools/prepare-release <release-number> [--dry-run]

# Preview changes without applying them
./tools/prepare-release 52 --dry-run

# Actually prepare release 52
./tools/prepare-release 52
```

**Actions Performed:**
1. Validates preconditions (on develop branch, clean working tree)
2. Updates CHANGELOG.md to set release date for [Unreleased] section
3. Removes "-pre" suffix from version in `src/version.ts`
4. Updates `AR_IO_NODE_RELEASE` in `docker-compose.yaml`
5. Commits all changes with standard message format

**Safety Features:**
- Dry-run mode for testing changes
- Automatic rollback on errors
- Comprehensive validation before modifications
- Clear error messages with recovery instructions

**Use Cases:**
- Automate repetitive release preparation steps
- Ensure consistent release process across all releases
- Reduce manual errors in version and configuration updates
- Preview release changes before committing

### `finalize-release`
Finalizes a release by updating docker-compose.yaml with specific image SHAs from the container registry. This tool waits for any pending GitHub Actions to complete, fetches the latest image tags, validates they exist in git history, and commits the finalized configuration.

**Usage:**
```bash
./tools/finalize-release <release-number>

# Finalize release 52
./tools/finalize-release 52
```

**Actions Performed:**
1. Validates preconditions (on develop branch, clean working tree, correct version)
2. Waits for any running GitHub Actions to complete
3. Fetches current image tags from ghcr.io for core services
4. Validates that all image SHAs exist in git history
5. Updates docker-compose.yaml to use specific SHAs instead of "latest"
6. Commits all changes with auto-detected JIRA ticket reference

**Safety Features:**
- Comprehensive validation before modifications
- Automatic detection of JIRA ticket from recent commits
- Clear error messages with recovery instructions
- Skips observer and AO CU images (they remain pinned)

**Use Cases:**
- Complete the release preparation after image builds finish
- Ensure consistent, reproducible docker image versions
- Validate all release artifacts are properly available

### `test-release`
Tests a release by verifying all docker compose profiles work correctly with the finalized image SHAs. This tool automates the comprehensive testing steps required before final release tagging and deployment.

**Usage:**
```bash
./tools/test-release <release-number> [options]

# Test all profiles for release 52
./tools/test-release 52

# Keep containers running for debugging
./tools/test-release 52 --no-cleanup

# Test specific profile only
./tools/test-release 52 --profile clickhouse
```

**Test Profiles:**
1. **Default Profile**: Core services (envoy, core, redis, observer) - must remain stable
2. **Clickhouse Profile**: Adds clickhouse and clickhouse-auto-import containers
3. **Litestream Profile**: Adds litestream container (may exit if S3 not configured - expected)
4. **AO Integration**: Adds AO CU container (may restart if not configured - expected)

**Validation Features:**
- Verifies docker-compose.yaml uses specific image SHAs (not "latest")
- Checks container startup and stability over time
- Validates core containers remain running across all profiles
- Handles expected behaviors (litestream/AO exits due to configuration)
- Comprehensive test summary with pass/fail status

**Safety Features:**
- Prerequisites validation (branch, version, Docker availability)
- Automatic cleanup after tests (unless --no-cleanup specified)
- Clear error messages for debugging
- Exit code indicates overall test success/failure

**Use Cases:**
- Verify release configuration before final tagging
- Validate all docker compose profiles work with specific image SHAs
- Catch container startup or stability issues early
- Ensure consistent behavior across different deployment scenarios

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