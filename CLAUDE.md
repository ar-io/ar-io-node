# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

AR.IO Node — Arweave gateway for accessing and indexing blockchain data, with
caching, ANS-104 bundle unbundling, and multi-source data retrieval.

## Commands

| Task | Command |
|------|---------|
| Install | `yarn install` |
| Init/upgrade SQLite | `yarn db:migrate up` |
| Run the service | `yarn start` (add `START_HEIGHT=N` only right after a fresh migration) |
| Watch mode | `yarn watch` |
| Unit + property tests | `yarn test` |
| **Single test file** | `yarn test:file src/path/to/file.test.ts` |
| E2E (needs Docker) | `yarn test:e2e` |
| Lint | `yarn lint:check` / `yarn lint:fix` |
| Typecheck (incl. tests) | `yarn typecheck` |
| Build | `yarn build` |
| Circular deps / dupes | `yarn deps:ci` / `yarn duplicate:check` |

`build-core.yml` runs on every push (any branch) and runs `build`,
`lint:check` and `test:ci` — not `typecheck`. Its docker build and `test:e2e`
steps run only on `develop`. `test-core.yml` (manual dispatch only) is the one
workflow that also runs `typecheck`. Nothing runs on `pull_request`. `yarn build`
uses `tsconfig.prod.json`, which excludes `*.test.ts`, so `yarn typecheck` is
the only thing that type-checks test code — run it locally. It currently fails
with hundreds of pre-existing errors, so the useful check is "no new errors
compared with `develop`", not a clean exit.

E2E tests (`test/end-to-end/`) come in two kinds. `getCoreContainer` suites
run the image tagged `core`. `composeUp` suites run whatever image
`docker-compose.yaml` resolves, `ghcr.io/ar-io/ar-io-core:${CORE_IMAGE_TAG:-latest}`.
Without `USE_PREBUILT_IMAGE=true`, both kinds build from the local Dockerfile.
If you set it, give one build both tags (see `build-core.yml`) and export
`CORE_IMAGE_TAG`. Otherwise the `composeUp` suites quietly pull the published
`latest` and test old code.

For test-layer selection (unit / property / e2e / auto-verify / parquet /
load), use the `testing` skill in `.claude/skills/`; `release` and
`ar-io-gateway-operator` live there too.

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
- The indexing pipeline is event-driven: `src/system.ts` wires workers
  together through a shared `eventEmitter` using the names in `src/events.ts`.
  Block importer → `TX_INDEXED` → unbundle-filter match →
  `ANS104_BUNDLE_INDEXED` → unbundler → data-item indexer. Once a data item's
  data is indexed (`ANS104_DATA_ITEM_DATA_INDEXED`), a filter match re-emits
  `ANS104_BUNDLE_INDEXED`, so nested bundles recurse through the same path. To trace a stage, grep `system.ts` for its event.
- SQLite is split into five DBs under `data/sqlite/`: `core` (L1 blocks/txs),
  `data` (content hashes, cache metadata), `bundles` (data items),
  `moderation`, `chunks`. Each has `new_*` (unstable, near tip) and `stable_*`
  tables. Migrations are named `<timestamp>.<db>.<name>.sql`; the `<db>`
  segment chooses the target DB file.
- GraphQL goes through `gqlQueryable` in `system.ts`: SQLite, optionally
  wrapped by `CompositeClickHouseDatabase` (ClickHouse for stable history, fed
  by `ClickHouseStreamer`) and optionally merged with upstream gateways via
  `GatewaysGqlQueryable`.
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
- HTTPSIG signs response headers (RFC 9421); `Content-Digest` is in
  `CO_SIGNABLE_HEADERS` so when present it binds the body to the signature.
  Cached and HEAD responses always emit it from the stored hash; small
  uncached responses (≤ `HTTPSIG_BODY_DIGEST_BUFFER_MAX_BYTES`, default 2 MiB)
  buffer + hash to emit it. Larger uncached bodies stream without a body
  digest. Chunks are bounded at 256 KiB so they always carry one. Index band
  files (`/ar-io/indexes`) are signed through the `X-AR-IO-Index-File`
  trigger; `Repr-Digest` is co-signable too, so a signed 206 is bound to the
  whole file.

- The `index-swarm` sidecar (`src/index-swarm/`) shares signed index bands
  between gateways over HTTP and, with the torrent engine (compose profile
  `index-swarm-torrent`), BitTorrent. Anything a publisher, peer or engine
  supplies is untrusted: files are checked against signed digests, a
  torrent against signed infohashes and file list, and a torrent download is
  copied and hashed out of `swarm/` before install, never installed in place.

## Conventions

- **Branching**: branches are cut from and merged back to `develop`; `main`
  only moves at release time. Open PRs against `develop`, not `main`.
- **ESM + NodeNext**: relative imports must carry a `.js` extension even in
  TypeScript (`import { x } from '../lib/y.js'`). Node 20 (`.nvmrc`),
  `"type": "module"`, run via `ts-node/esm` + SWC (`register.js`).
- **License header**: every `.ts` file must start with the AGPL header in
  `resources/license.header.js` — `eslint-plugin-header` fails the build
  without it. Copy it when creating a new file.
- **Node protocol imports**: `node:fs`, not `fs` (`unicorn/prefer-node-protocol`).
- **`strict-boolean-expressions` is on**: write explicit `!== undefined` /
  `.length > 0` rather than relying on truthiness.
- **Design principles** (README): code to interfaces, keep IO separate from
  logic, make processes idempotent, and keep every component runnable in a
  single process. In tests, use in-memory implementations and sociable tests
  in preference to mocks and stubs.
- Stage specific files. Do not use `git add .` or `git commit -A`.
- Use [Conventional Commits](https://www.conventionalcommits.org/) format
  (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`, etc.).

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

## Documentation hygiene

When changing behavior that affects documented contracts (env vars, APIs,
CLI tools), update the relevant file in `docs/` in the same PR. Use
`docs/INDEX.md` to find the right doc. Add new terms and concepts to
`docs/glossary.md`. Add or improve TSDoc comments on code you touch.
