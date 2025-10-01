## Documentation

- The project includes a comprehensive glossary at `docs/glossary.md`
- When adding new concepts, features, or technical terms, update the glossary
- Keep glossary definitions concise and focused on concepts rather than implementation details
- Organize new terms into the appropriate existing sections
- When modifying code, add or improve JSDoc comments where possible to enhance documentation

## Processes

- Process documentation is located in `docs/processes/`
- The release process is documented at `docs/processes/release.md`

## Releases

- Releases are tagged with rN in git where N is a monotonically increasing
  integer value.

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
