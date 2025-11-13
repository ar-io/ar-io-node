# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

AR.IO Node is a gateway for accessing and indexing Arweave blockchain data. It acts as a "Permaweb CDN" providing fast, verified access to Arweave data through intelligent caching, ANS-104 bundle unbundling, and multi-source data retrieval.

## Common Commands

### Development
- Install dependencies: `yarn install`
- Start development server: `yarn start`
- Watch mode with auto-restart: `yarn watch`
- Build for production: `yarn build`
- Run production build: `yarn start:prod`

### Testing
- Run all tests: `yarn test`
- Run individual test file: `yarn test:file src/path/to/test.ts`
- Run individual test with coverage: `yarn test:file:coverage src/path/to/test.ts`
- Run tests with coverage: `yarn test:coverage`
- Run e2e tests: `yarn test:e2e`

### Linting and Code Quality
- Check for lint issues: `yarn lint:check`
- Fix lint issues: `yarn lint:fix`
- Check for code duplication: `yarn duplicate:check`
- Check for circular dependencies: `yarn deps:check`
- Generate dependency graph: `yarn deps:graph`

## Architecture

### High-Level Structure

The codebase follows a layered architecture:

1. **Routes Layer** (`src/routes/`) - Express.js HTTP endpoints for data, chunks, GraphQL, ArNS, etc.
2. **System Layer** (`src/system.ts`) - Central initialization of all services, workers, databases, and data sources
3. **Workers Layer** (`src/workers/`) - Background processes for data import, unbundling, verification, and repair
4. **Data Layer** (`src/data/`) - Composite data sources implementing fallback chains for data retrieval
5. **Database Layer** (`src/database/`) - SQLite databases (core, data, bundles, moderation) with worker-based queuing
6. **Store Layer** (`src/store/`) - KV stores (LMDB, Redis, filesystem) for caching headers and data

### Key Architectural Patterns

#### Composite Pattern for Data Sources
Data retrieval uses composite sources that try multiple backends in order:
- `CompositeChunkDataSource` - tries local cache, S3, AR.IO peers, trusted gateways, Arweave nodes
- `CompositeTxOffsetSource` - tries database, ANS-104 offsets, chain offsets
- Components implement common interfaces (`ChunkDataSource`, `ContiguousDataSource`, etc.)

#### Read-Through Caching
- `ReadThroughDataCache` wraps upstream sources and caches results to filesystem
- Configurable retrieval order via `ON_DEMAND_RETRIEVAL_ORDER` and `BACKGROUND_RETRIEVAL_ORDER`
- Cache locations: `data/contiguous/`, `data/lmdb/`, `data/headers/`

#### Worker-Based Database Access
- Main process queues database operations via message passing
- Worker thread (`StandaloneSqlite`) executes queries to avoid blocking
- Pattern: queue method in main class → worker handler → worker implementation

#### Filter System
Filters control which transactions/bundles are unbundled and indexed:
- Declarative JSON syntax supporting tags, attributes, logical operators (and/or/not)
- Implemented as composable filter classes (`MatchAll`, `MatchAny`, `MatchTags`, etc.)
- Environment variables: `ANS104_UNBUNDLE_FILTER`, `ANS104_INDEX_FILTER`, `WEBHOOK_INDEX_FILTER`
- Same filter system used for webhooks and log filtering

#### Dependency Injection via system.ts
`src/system.ts` is the central initialization point that wires all dependencies:
- Creates all data sources, databases, workers, resolvers, clients
- Manages lifecycle (startup/shutdown) via cleanup handlers
- Workers and routes receive dependencies as constructor parameters

### Data Flow

#### Reading Data (GET requests)
1. Request arrives at route handler (e.g., `/raw/:id`)
2. ArNS resolution if needed (via `CompositeArNSResolver`)
3. Lookup transaction/data item metadata in databases
4. Retrieve data via `ContiguousDataSource` (tries cache → S3 → peers → gateways)
5. Return with trust headers indicating verification status

#### Writing Data (Chunk uploads)
1. POST to `/chunk` endpoint validates chunk format
2. Broadcasts chunk to configured Arweave nodes and peers
3. Gateway acts as relay only - doesn't create transactions

#### Background Indexing
1. `BlockImporter` polls for new blocks from trusted Arweave node
2. `TransactionImporter` processes transactions from blocks
3. `Ans104Unbundler` downloads bundles matching `ANS104_UNBUNDLE_FILTER`
4. `Ans104DataIndexer` indexes data items matching `ANS104_INDEX_FILTER`
5. `DataVerificationWorker` verifies data integrity using Merkle roots

## Documentation

- The project includes a comprehensive glossary at `docs/glossary.md`
- When adding new concepts, features, or technical terms, update the glossary
- Keep glossary definitions concise and focused on concepts rather than implementation details
- Organize new terms into the appropriate existing sections
- When modifying code, add or improve TSDoc comments where possible to enhance documentation

### Rate Limiter and x402 Documentation

- Comprehensive operator guide at `docs/x402-and-rate-limiting.md`
- When modifying rate limiting functionality, update the guide:
  - If adding/removing rate limited endpoints: update "Rate Limited Endpoints" section
  - If changing environment variables: update both the guide and `docs/envs.md`
  - If changing payment flow or token consumption: update "How They Work Together" section
  - If changing configuration options: update configuration reference tables
- When adding rate limiter or x402 related terms, add them to the "Rate Limiter & x402 Payment Protocol" section in the glossary

## Scratch Directory

- The `/scratch` directory is for work-in-progress files that should not be committed to git
- Use it for:
  - Draft design documents and analysis notes
  - Work-in-progress ticket descriptions and issue summaries
  - Investigation notes and debugging artifacts
  - Temporary markdown files during development
- All files are automatically ignored by git; the directory is tracked via `.gitkeep`

## Processes

- Process documentation is located in `docs/processes/`
- The release process is documented at `docs/processes/release.md`

## Releases

- Releases are tagged with rN in git where N is a monotonically increasing
  integer value.
- Release automation scripts are in `tools/`:
  - `release-status` - Check if repo is ready for release
  - `prepare-release` - Automate version updates and changelog
  - `finalize-release` - Update docker images with commit SHAs after builds
  - `test-release` - Test all docker compose profiles
  - `post-release` - Cleanup and prepare for next development cycle
  - See `tools/README.md` for detailed documentation of each script

## Database Migrations

- Create new migrations with: `yarn db:migrate create --folder migrations --name <schema>.description.sql`
- Apply migrations with: `yarn db:migrate up`
- Apply specific migration: `yarn db:migrate up --name <migration-filename>`
- Revert migrations with: `yarn db:migrate down --step N` or `yarn db:migrate down --name <migration-filename>`
- Check migration status: Query `migrations` table in `data/sqlite/core.db`
- After applying migrations, update test schemas with: `./test/dump-test-schemas`
- Down migrations go in `migrations/down/` with the same filename

### SQLite Migration Notes

- SQLite requires separate `ALTER TABLE` statements for each column addition/removal (no comma-separated columns)
- When dropping columns with associated indexes, drop the indexes first
- Use `DROP INDEX IF EXISTS` to avoid errors if index doesn't exist
- When consolidating multiple migrations, ensure old migration files are removed to avoid duplicate execution
- Avoid DEFAULT values in ALTER TABLE ADD COLUMN as they require rewriting the entire table
- Use NULLS FIRST/LAST in ORDER BY instead of COALESCE to preserve index usage

## SQL Statement Organization

- SQL statements are organized in `src/database/sql/<schema>/` directories
- Each SQL file contains named statements as comments (e.g., `-- statementName`)
- Statements are automatically loaded and prepared by the database module
- SQL statement names should be descriptive about the operation (e.g., `updateVerificationPriority` for UPDATE)
- Method names at the interface level should hide implementation details (e.g., `saveVerificationPriority` for insert/update/upsert)
- Exception: When the operation itself is the interface (e.g., `incrementVerificationRetryCount`), use the same name at both levels

## Adding Database Methods

When adding a new database method:
1. Add the SQL statement to the appropriate file in `src/database/sql/<schema>/`
2. Add the method implementation in the worker class (e.g., in `StandaloneSqlite`)
3. Add the queue wrapper method in the main database class
4. Add the case handler in the worker message handler
5. Add the method signature to the appropriate interface in `types.d.ts`

## Testing

- Run all tests with: `yarn test`
- Run individual test files with: `yarn test:file src/path/to/test.ts`
- Run individual test files with coverage: `yarn test:file:coverage src/path/to/test.ts`
- Run tests with coverage: `yarn test:coverage`
- Run e2e tests: `yarn test:e2e`
- Mock functions in tests use: `mock.fn()` and reset with `mock.restoreAll()` in afterEach
- Database schemas in tests come from `test/*.sql` files

### Dry-Run Mode for Upload Testing

The gateway supports a dry-run mode for testing transaction and chunk uploads without posting to the Arweave network:

```bash
# Enable dry-run mode
ARWEAVE_POST_DRY_RUN=true yarn start
```

**Important**: When dry-run mode is enabled:
- Connect directly to **port 4000** (the Node.js app) to use dry-run mode
- Port 3000 (Envoy) will still proxy `/tx` requests to arweave.net
- Both `POST /tx` (transaction headers) and `POST /chunk` requests are simulated
- Returns 200 OK success responses to clients as if transactions were posted
- Perfect for testing apps like ArDrive and large uploads without burning AR tokens
- All validation and processing still occurs, only the final network broadcast is skipped

### Test Logging

- All test output is automatically logged to `logs/test.log` instead of the console
- Test log file is overwritten on each test run for a clean slate
- Use `createTestLogger()` from `test/test-logger.ts` in all test files
- Logger automatically includes test context (suite name, test case name) in log entries
- Never use `winston.createLogger({ silent: true })` - always use the test logger helper

#### Creating Test Loggers

```typescript
import { createTestLogger } from '../../test/test-logger.js';

// Basic usage with suite name
const log = createTestLogger({ suite: 'ArIOChunkSource' });

// With suite and test name
const log = createTestLogger({
  suite: 'ArIOChunkSource',
  test: 'should fetch chunk data'
});

// With additional metadata
const log = createTestLogger({
  suite: 'DataIndex',
  metadata: { database: 'test.db' }
});
```

#### Viewing Test Logs

- Check `logs/test.log` after running tests to debug failures
- Log format matches production format (JSON or simple based on LOG_FORMAT)
- Test context included in each log entry (testSuite, testCase fields)

## Database Schemas

- Main schemas: `core` (blocks/transactions), `data` (contiguous data), `bundles` (ANS-104), `moderation`
- Schema dumps are in `test/` directory (e.g., `test/data-schema.sql`)
- Bundles schema shows good patterns for retry tracking with timestamps
- Use `currentUnixTimestamp()` helper for timestamp fields
- When implementing similar features, check existing patterns (e.g., bundles retry system for verification retries)

## Service and Data Management

### Service Control
- Start service: `yarn service:start`
- Stop service: `yarn service:stop`
- View logs: `yarn service:logs`
- Service logs are in `logs/service.log` (JSONL format - one JSON object per line)
- OTEL spans are in `logs/otel-spans.jsonl`
- When testing changes: stop service, clear logs (`rm logs/service.log && touch logs/service.log`), then restart

### Database Management
- Database files are in `data/sqlite/` directory
- To reset databases: `rm data/sqlite/*.db && yarn db:migrate up`
- Always stop the service before manually deleting database files
- Query databases with: `sqlite3 data/sqlite/<schema>.db "<SQL>"`

### Cache Management
- Contiguous data cache is in `data/contiguous/data/` and `data/contiguous/tmp/`
- Cached files are organized by hash in subdirectories (e.g., `IX/zl/IXzlt26pAoko02PrP8Zith9UiJWidZLxxHEDfGK91jg`)
- Cache files may require sudo to delete due to service ownership
- To clear cache without full reset: stop service, delete cache files, restart service
- Data caching is controlled by `SKIP_DATA_CACHE` environment variable (default: false)

## Git Workflow

- Never use `git commit -A` or `git add .`. Add the individual files you want instead.

## Code Quality

### Linting
- After making changes be sure to run 'yarn lint:check'.
- If lint issues are found, run 'yarn lint:fix' to fix them.

### Duplicate Detection
- Check for code duplication: `yarn duplicate:check`
- Generate HTML report: `yarn duplicate:report`
- CI duplicate check: `yarn duplicate:ci`

### Dependency Analysis
- Check for circular dependencies: `yarn deps:check`
- Generate dependency graph: `yarn deps:graph`
- Find orphan modules: `yarn deps:orphans`
- Find leaf modules: `yarn deps:leaves`
- Show dependency summary: `yarn deps:summary`
- CI dependency check: `yarn deps:ci`

## Reference Repositories

The project includes reference repositories managed by `mr` (myrepos) in the `repos/` directory. These can be used for understanding Arweave internals and related protocols:

- **repos/arweave** - Core Arweave node implementation (Erlang)
  - Source: https://github.com/ArweaveTeam/arweave
  - Reference for: Block structure, transaction formats, mining protocols, network protocols

- **repos/arweave-js** - JavaScript/TypeScript client library for Arweave
  - Source: https://github.com/ArweaveTeam/arweave-js
  - Reference for: Transaction creation, signing, API interactions, data formatting

- **repos/HyperBEAM** - Erlang BEAM VM running in WebAssembly
  - Source: https://github.com/permaweb/HyperBEAM
  - Reference for: AO process execution, WASM integration

- **repos/ao** - The AO computer - Actor Oriented smart contracts on Arweave
  - Source: https://github.com/permaweb/ao
  - Reference for: AO protocol, message passing, process scheduling, compute units

- **repos/ar-io-observer** - AR.IO network observer and monitoring tools
  - Source: https://github.com/ar-io/ar-io-observer
  - Reference for: Network monitoring, gateway health checks, observation protocols

Use `mr update` to clone/update these repositories. They are excluded from git tracking via `.gitignore`.
