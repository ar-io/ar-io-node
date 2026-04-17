# CLAUDE.md

AR.IO Node — Arweave gateway for accessing and indexing blockchain data, with
caching, ANS-104 bundle unbundling, and multi-source data retrieval.

## Discovery points

- Commands — `package.json` scripts (dev, build, service, test, lint,
  migrations, duplicate/deps checks)
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
- Responses include trust headers indicating verification status.

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

### Upload dry-run

For testing uploads without broadcasting to Arweave, see
`ARWEAVE_POST_DRY_RUN` and `ARWEAVE_POST_DRY_RUN_SKIP_VALIDATION` in
`docs/envs.md`.

### Git staging

Stage specific files. Do not use `git add .` or `git commit -A`.

## Documentation hygiene

When changing behavior that affects documented contracts (env vars, APIs,
CLI tools), update the relevant file in `docs/` in the same PR. Use
`docs/INDEX.md` to find the right doc. Add new terms and concepts to
`docs/glossary.md`. Add or improve TSDoc comments on code you touch.
