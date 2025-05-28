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

## Data Verification System

- Data verification tracks retry attempts with:
  - `verification_retry_count` - incremented on each failed verification
  - `verification_priority` - higher values are verified first (default 0)
  - `first_verification_attempted_at` - timestamp of first retry
  - `last_verification_attempted_at` - timestamp of most recent retry
- Verification order: priority DESC, retry_count ASC, id ASC
- On successful verification:
  - `verified` is set to true
  - `verification_retry_count` is reset to 0
  - Timestamp fields are cleared (set to NULL)
- The retry pattern follows the same approach used for bundle retries

## SQL Statement Organization

- SQL statements are organized in `src/database/sql/<schema>/` directories
- Each SQL file contains named statements as comments (e.g., `-- statementName`)
- Statements are automatically loaded and prepared by the database module

## Adding Database Methods

When adding a new database method:
1. Add the SQL statement to the appropriate file in `src/database/sql/<schema>/`
2. Add the method implementation in the worker class (e.g., in `StandaloneSqlite`)
3. Add the queue wrapper method in the main database class
4. Add the case handler in the worker message handler
5. Add the method signature to the appropriate interface in `types.d.ts`

## Testing

- Run specific tests with: `node --no-deprecation --import ./register.js --test src/path/to/test.ts`
- Run all tests matching a pattern with: `node --no-deprecation --import ./register.js --test src/**/*.test.ts`
- Mock functions in tests use: `mock.fn()` and reset with `mock.restoreAll()` in afterEach
- Database schemas in tests come from `test/*.sql` files

## Database Schemas

- Main schemas: `core` (blocks/transactions), `data` (contiguous data), `bundles` (ANS-104), `moderation`
- Schema dumps are in `test/` directory (e.g., `test/data-schema.sql`)
- Bundles schema shows good patterns for retry tracking with timestamps
- Use `currentUnixTimestamp()` helper for timestamp fields
- When implementing similar features, check existing patterns (e.g., bundles retry system for verification retries)
