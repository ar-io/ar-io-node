# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

AR.IO Node — Arweave gateway for accessing and indexing blockchain data, with
caching, ANS-104 bundle unbundling, and multi-source data retrieval.

## Tech stack

- Node.js v20 (see `.nvmrc`), TypeScript strict mode, ESM (`"type": "module"`)
- Test framework: **Node.js native `node:test`** (not Jest/Mocha/Vitest)
- Transpiler: SWC (via ts-node)
- Databases: SQLite (primary) + ClickHouse (analytics/GQL)
- Caching: Redis, LMDB, LRU in-memory
- HTTP: Express
- Observability: OpenTelemetry + Prometheus + Winston

## Commands

```bash
# Development
yarn start                    # Start service (requires .env file)
yarn watch                    # Start with nodemon (auto-restart on changes)
yarn build                    # Clean + compile TypeScript (prod)

# Testing
yarn test                     # Run all unit tests
yarn test:file src/path/to/file.test.ts  # Run a single test file
yarn test:e2e                 # Run end-to-end tests (in test/ directory)
yarn test:coverage            # Run tests with coverage report

# Linting & quality
yarn lint:check               # ESLint check
yarn lint:fix                 # ESLint auto-fix
yarn duplicate:check          # Detect code duplication (jscpd)
yarn deps:check               # Detect circular dependencies (madge)

# Database
yarn db:migrate               # Run SQLite migrations
yarn db:dump-test-schemas     # Regenerate test SQL schemas after migrations

# Service management (systemd-based)
yarn service:start / stop / restart / status / logs
```

## Discovery points

- Documentation index — `docs/INDEX.md`
- Env vars — `docs/envs.md` (keep this and `docker-compose.yaml` in sync when
  adding or removing env vars)
- Architecture diagrams — `docs/diagrams/`
- Release & worktree tooling — `tools/README.md`
- Reference repos (arweave, ao, HyperBEAM, etc.) — `.mrconfig`; run
  `mr update` to clone/update
- OpenAPI — `docs/openapi.yaml`

## Architecture load-bearing facts

- `src/system.ts` is the central DI wiring — all services, workers, data
  sources, resolvers, and lifecycle cleanup handlers are constructed here.
- `src/config.ts` parses all environment variables and exports typed
  constants — this is where new env vars are added.
- `src/data/` uses composite sources with fallback chains
  (cache → S3 → AR.IO peers → trusted gateways → Arweave nodes). Retrieval
  order is configurable via `ON_DEMAND_RETRIEVAL_ORDER` and
  `BACKGROUND_RETRIEVAL_ORDER`.
- Database access runs in a worker thread (`StandaloneSqlite`). The main
  process queues operations via message passing — never call SQLite
  synchronously from the main thread.
- Filters (`ANS104_UNBUNDLE_FILTER`, `ANS104_INDEX_FILTER`,
  `WEBHOOK_INDEX_FILTER`) share a composable JSON filter system — see
  `docs/filters.md`.
- Background workers (`src/workers/`) handle block importing, data importing,
  bundle unbundling, verification, and webhooks. Controlled by `START_WRITERS`.
- IPFS serving (`src/ipfs/`) is opt-in via `IPFS_ENABLED`. Uses a Kubo sidecar
  for content retrieval with its own cache, rate limiter, and blocklist. Routes
  mount before ArNS in `app.ts`. ArNS names whose ANT record has
  `targetProtocol: ipfs` resolve to a CID and are routed to the same IPFS
  handler by the ArNS middleware (`src/middleware/arns.ts`); the on-demand
  resolver reads `targetProtocol`. See `docs/ipfs-integration.md`.
- Responses include trust headers indicating verification status.
- HTTPSIG signs response headers (RFC 9421); `Content-Digest` is in
  `CO_SIGNABLE_HEADERS` so when present it binds the body to the signature.
  Cached and HEAD responses always emit it from the stored hash; small
  uncached responses (≤ `HTTPSIG_BODY_DIGEST_BUFFER_MAX_BYTES`, default 2 MiB)
  buffer + hash to emit it. Larger uncached bodies stream without a body
  digest. Chunks are bounded at 256 KiB so they always carry one.

## Gotchas

### Worktrees

`./tools/wt add <branch>` symlinks `.env` and `CLAUDE.local.md` from the main
checkout into the worktree but gives each worktree its own clean `data/`
directory (not shared).

### Testing a running service

When iterating against the local service: stop it, clear
`logs/service.log` (`rm logs/service.log && touch logs/service.log`), then
restart. Service logs are JSONL; OTEL spans are in `logs/otel-spans.jsonl`.

### Test logger

Always use `createTestLogger()` from `test/test-logger.ts` in test files —
never `winston.createLogger({ silent: true })`. Test output is written to
`logs/test.log` (overwritten each run), not the console.

### Test imports

Tests use `node:test` and `node:assert`:

```typescript
import { describe, it, before, after, mock } from 'node:test';
import { strict as assert } from 'node:assert';
```

Common test stubs are in `test/stubs.ts`, SQLite helpers in
`test/sqlite-helpers.ts`.

### Adding a database method

Five coordinated edits are required:

1. SQL statement in `src/database/sql/<schema>/` (named via `-- statementName`
   comment)
2. Worker implementation in `StandaloneSqlite`
3. Queue wrapper in the main database class
4. Case handler in the worker message handler
5. Interface signature in `types.d.ts`

### SQLite migration rules

- One `ALTER TABLE` per column (no comma-separated columns)
- Drop indexes before dropping their columns
- Avoid `DEFAULT` in `ALTER TABLE ADD COLUMN` — it rewrites the entire table
- Prefer `NULLS FIRST`/`NULLS LAST` over `COALESCE` in `ORDER BY` to preserve
  index usage
- Run `./test/dump-test-schemas` after applying migrations so the test SQL
  files stay current. Down migrations go in `migrations/down/` with the same
  filename.

### Auto-verify source adapters

Schema changes to SQLite `stable_*` tables, the Parquet export, or the
ClickHouse `transactions` table must be reflected in the corresponding
adapter under `src/tests/auto-verify/sources/` and in the canonical types
in `src/tests/auto-verify/types.ts`. The adapters project each source into
a shared canonical shape for comparison, so a silent divergence shows up
as `field_mismatch` / `missing_in_source` discrepancies rather than a
build error. Also re-check the staging/final table list in
`gateway-control.ts`'s `cleanClickHouseTables` when tables are added or
removed. See `docs/auto-verify.md`.

### Upload dry-run

For testing uploads without broadcasting to Arweave, see
`ARWEAVE_POST_DRY_RUN` and `ARWEAVE_POST_DRY_RUN_SKIP_VALIDATION` in
`docs/envs.md`.

### Git staging

Stage specific files. Do not use `git add .` or `git commit -A`.

### Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/) format
(`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`, etc.).

## Documentation hygiene

When changing behavior that affects documented contracts (env vars, APIs,
CLI tools), update the relevant file in `docs/` in the same PR. Use
`docs/INDEX.md` to find the right doc. Add new terms and concepts to
`docs/glossary.md`. Add or improve TSDoc comments on code you touch.
