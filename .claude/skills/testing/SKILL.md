---
name: testing
description: Decision guide for testing in the ar-io-node repo — which test layer to use, how to run it, and which helpers to reach for. Use when writing a new test, picking a layer (unit / property / e2e / auto-verify / parquet integration / load test), running the suite or a single file, debugging a test failure, or when a schema or pipeline change needs cross-source verification. Triggers: "write a test for X", "run the tests", "which test layer", "run e2e", "run auto-verify", "load test the gateway", "test parquet export", "test against a running service".
---

# Testing in ar-io-node

## Layer decision

Pick the narrowest layer that can fail on the change.

| Layer | Lives in | Runner | When to use |
|-------|----------|--------|-------------|
| **Unit** | `src/**/*.test.ts` | `yarn test` / `yarn test:file <path>` | Pure logic, SQL wrappers, filters, route handlers (with `supertest`), middleware, data-source composition. Default choice. |
| **Property** | `src/**/*.property.test.ts` | same as unit | Invariants: determinism, output shape, distribution, round-trip. Uses `fast-check`. See `src/lib/cdb64.property.test.ts` for pattern. |
| **E2E** | `test/end-to-end/*.test.ts` | `yarn test:e2e` | Full request lifecycle through real containers: admin APIs, ArNS, bundler sidecar, webhook delivery, moderation, Prometheus metrics. Requires Docker. |
| **Auto-verify** | `src/tests/auto-verify/` | `yarn test:auto-verify:indexing` | Cross-source indexing reconciliation (SQLite / Parquet / bundle-parser / ClickHouse). Use after schema changes to `stable_*` tables, the Parquet export, or ClickHouse `transactions`. |
| **Parquet / ClickHouse scripts** | `scripts/tests/parquet/test-*` | bash, run directly | Parquet export correctness & perf, ClickHouse import pipeline, TTL rules loader. Operate against a populated local DB. |
| **Load / stability** | `tools/test-chunk-retrieval`, `tools/test-data-retrieval` | bash, run directly | Stress endpoints for FD leaks, ECONNRESET patterns, p99 latency. Needs a running gateway. |
| **GraphQL perf probe** | `test/perf/gql-perf` | bash, `GRAPHQL_URL=… ./test/perf/gql-perf` | Ad-hoc timing comparisons across gateway endpoints. |

**Escalate when a change crosses boundaries.** A unit test on a SQL wrapper is not enough if the change also alters the `stable_*` schema — add or update an auto-verify adapter. A unit test on the Parquet exporter isn't enough if row counts could drift — run `scripts/tests/parquet/test-parquet-export`.

## Running tests

| Command | What it does |
|---------|--------------|
| `yarn test` | All unit+property tests, sequential (`--test-concurrency 1`). |
| `yarn test:file src/foo/bar.test.ts` | Single unit test file. Pass multiple paths if needed. |
| `yarn test:coverage` | Full suite with HTML + text coverage via c8. |
| `yarn test:file:coverage <path>` | Single file with coverage. |
| `yarn test:e2e` | All e2e tests. Builds the core image unless `USE_PREBUILT_IMAGE=true`. |
| `yarn test:auto-verify:indexing` | Auto-verify run. Driven by `.env` + `AUTO_VERIFY_*` vars. |
| `yarn lint:check` / `yarn lint:fix` | ESLint. |
| `yarn duplicate:check` / `yarn deps:ci` | jscpd and madge circular-dep gate. |

**Tag filtering** (unit + e2e): wrap test bodies with `isTestFiltered(tags)` from `test/utils.ts` and set `TEST_ONLY_TAGS=slow,integration` or `TEST_SKIP_TAGS=flaky`. CI runs e2e with `TEST_SKIP_TAGS=flaky`.

**Single e2e file**: `yarn test:file test/end-to-end/indexing.test.ts` works — `test:file` just forwards args to `node --test`.

## Writing unit tests

- **Test runner**: `node:test` (`describe`, `it`, `before`, `after`, `beforeEach`). Imports: `import { describe, it } from 'node:test'; import assert from 'node:assert';` (or `import { strict as assert } from 'node:assert'`).
- **Logger — always** `createTestLogger()` from `test/test-logger.ts`. Never `winston.createLogger({ silent: true })`. Test output goes to `logs/test.log` (overwritten each run), not the console.
- **SQLite tests**: import the shared handles from `test/sqlite-helpers.ts` (`coreDb`, `dataDb`, `bundlesDb`, `moderationDb`). The helper creates fresh DBs from `test/*-schema.sql` in `before` and truncates all tables in `afterEach`. Do not construct your own `Sqlite` instance.
- **Schema files are generated.** If a migration changes a `stable_*` or `new_*` table, regenerate with `./test/dump-test-schemas` (requires populated `data/sqlite/*.db`) and commit the result.
- **Stubs & fixtures**: `test/stubs.ts` (`ArweaveChainSourceStub`, manifest streams, ANS-104 bundle stream), `test/mock_files/` (txs, manifests, block id maps), `test/mocks/` (e.g. `mock-redis-token-bucket.ts`).
- **HTTP handlers**: mount the router on an Express app and drive it with `supertest`. Pattern in `src/middleware/httpsig.test.ts`, `src/routes/data/handlers.test.ts`.
- **Property tests**: `fast-check` is in devDeps. Use `.property.test.ts` suffix to signal intent. Fix a seed when collisions/distribution matter; keep `numRuns` modest so the suite stays under a minute.

## Writing e2e tests

- Use `composeUp()` / `cleanDb()` from `test/end-to-end/utils.ts`. It wraps `DockerComposeEnvironment` (testcontainers) around the real `docker-compose.yaml` with sensible defaults and exposes `START_HEIGHT`, `STOP_HEIGHT`, filters, and `ADMIN_API_KEY='secret'`.
- `USE_PREBUILT_IMAGE=true` reuses a pre-built `core` image (CI does this). Local runs rebuild from the Dockerfile.
- Wait helpers in the same file: `waitForBlocks`, `waitForBundleToBeIndexed`, `waitForTxToBeIndexed`, `waitForDataItemToBeIndexed`, `waitForLogMessage`. Prefer these over hand-rolled polling.
- Tear down with `compose.down()` in `after(...)`. Forgetting this leaks containers across runs and tends to manifest as port conflicts on 4000/5432/8123.

## Auto-verify

See `docs/auto-verify.md` for the full spec. Key triggers:

- Schema change to `stable_blocks` / `stable_transactions` / `stable_data_items` (or their tag tables) → update the matching adapter under `src/tests/auto-verify/sources/` and the canonical types in `src/tests/auto-verify/types.ts`.
- Parquet export schema change → same, update `ParquetSource`.
- ClickHouse `transactions` schema change → update `ClickHouseSource` and the table-cleanup list in `gateway-control.ts`'s `cleanClickHouseTables`.

A silent adapter divergence shows up as `field_mismatch` / `missing_in_source` discrepancies rather than a build error, so the adapters are the first thing to re-verify after a schema change.

Run knobs: `AUTO_VERIFY_ITERATIONS=N` to shuffle and sample, `AUTO_VERIFY_FAIL_FAST=true` while iterating, `AUTO_VERIFY_PRESERVE_CACHE=false` only when changing a `data.db` migration.

## Parquet / ClickHouse integration scripts

All under `scripts/tests/parquet/`. They assume a populated `data/sqlite/` and run the real export binary:

| Script | Use for |
|--------|---------|
| `test-parquet-export` | Small export + `--verifyCount`. First thing to run after changing `scripts/parquet-export` or a projected column. |
| `test-parquet-full` | L1+L2, bigger range. Catches per-partition edge cases. |
| `test-parquet-performance` | Sweep partition sizes (5/10/25/50). Use when changing batching. |
| `test-timing` / `test-query-timing` | `[TIMING]` breakdowns; use to isolate slow SQL in export. |
| `test-data-integrity` | Post-hoc: verify field formats in an export directory. |
| `test-clickhouse-integration` | End-to-end export → clickhouse-import. Run after schema or loader changes. |
| `test-clickhouse-ttl-rules` | TTL rules loader only (PE-9058 path). |

They read config via `scripts/lib/common.sh` (`load_env`, `load_clickhouse_config`). Height ranges are hardcoded to ranges present in the fixture DB — if `data/sqlite/core.db` doesn't cover the range, expect empty results rather than a failure.

## Load / stability tests

- `tools/test-chunk-retrieval` — stress `/chunk/{offset}`. Supports `--concurrency`, `--duration`, `--track-fds <pid>` for FD leak detection on Linux. Output includes p50/p95/p99, status code histogram, resource-exhaustion flag (`EMFILE`, `ENFILE`, `ENOMEM`).
- `tools/test-data-retrieval` — same shape, for `/raw/{id}` and similar. See `tools/README.md` for flags.

Use these when validating a fix for a reported leak or a latency regression, not as part of the normal dev loop.

## Iterating against a running service

When a test needs the real service running (load tools, parquet scripts, ad-hoc curl):

1. `yarn service:stop`
2. `rm logs/service.log && touch logs/service.log` (JSONL log; easier to diff when empty)
3. `yarn service:start`
4. Exercise the feature.
5. `yarn service:logs` or tail `logs/service.log`; OTEL spans land in `logs/otel-spans.jsonl`.

## Gotchas

- **Tests run sequentially** (`--test-concurrency 1`). Don't add parallelism assumptions; don't rely on test isolation via parallelism.
- **`sqlite-helpers.ts` truncates in `afterEach`, not `beforeEach`.** The first test in a file starts with an empty DB from the `before` hook; later tests inherit cleared-but-migrated state. Inserting in `before` is dangerous because `afterEach` will delete it.
- **`bundle_formats` is preserved across truncation** (see the `tbl_name != 'bundle_formats'` filter). If a test depends on an empty `bundle_formats`, wipe it explicitly.
- **E2E fixtures are byte files in `test/end-to-end/files/`** (BDI, data items). Don't synthesize them at runtime.
- **Auto-verify's gateway spawns through `scripts/service`**, which reads `.env`. `BACKGROUND_RETRIEVAL_ORDER` governs bundle reachability during unbundling, not `ON_DEMAND_RETRIEVAL_ORDER` — if unbundling stalls, check trusted-gateway reachability first.
- **Coverage reports** land in `coverage/` (c8). Don't commit.
- **Single-test focus**: `node:test` has no `.only`. Use `TEST_ONLY_TAGS` or narrow via `yarn test:file <path>`; combine with `--test-name-pattern` if needed (pass through `yarn test:file`).
