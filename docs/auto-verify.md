# Auto-Verify

Cross-source verification tool for gateway indexing. For a set of block
ranges, auto-verify drives the gateway through a full indexing cycle, then
reconciles the resulting bundle and transaction data across multiple
independently-derived sources to catch drift.

## What it does

For each block range (see `src/tests/auto-verify/block-ranges.json`):

1. Clean indexing state (core.db, bundles.db, moderation.db; optionally
   data.db and contiguous/LMDB caches too).
2. Start the gateway with `START_HEIGHT` / `STOP_HEIGHT` pinned to the range
   and filters set to `{"always": true}`.
3. Wait for blocks to be indexed and bundles to be fully unbundled.
4. Prefetch bundle bytes from the local gateway (used later by the
   bundle-parser source).
5. Stop the gateway and flush `new_*` tables to `stable_*`.
6. Export the range to Parquet via `ParquetExporter`.
7. Optionally import the Parquet into ClickHouse (staging → final).
8. Collect canonical blocks, transactions, and data items from every
   source and run field-by-field comparison.
9. Write a JSON report per iteration plus a final summary.

## Sources reconciled

| Source | What it reads | Notes |
|--------|---------------|-------|
| `sqlite` | `stable_blocks`, `stable_transactions`, `stable_data_items`, and their tag tables | Produced by normal gateway indexing. |
| `parquet` | The Parquet files written by `ParquetExporter` (read via DuckDB) | Verifies the export path. |
| `bundle-parser` | Re-parses raw bundle bytes fetched from the local gateway | Independent of the indexing pipeline — catches bugs in how the unbundler extracts data items. `rootParentOffset` is excluded (not derivable from raw bytes). |
| `clickhouse` | `transactions FINAL` | Only when `AUTO_VERIFY_CLICKHOUSE_URL` is set. Verifies the Parquet → ClickHouse import path. |

Blocks are compared only across `sqlite` and `parquet` (ClickHouse has no
standalone blocks table and bundle-parser doesn't produce blocks).

## Running

```sh
yarn test:auto-verify:indexing
```

The gateway process spawned by the test picks up `.env` via
`scripts/service start`, so any `TRUSTED_GATEWAYS_URLS`,
`BACKGROUND_RETRIEVAL_ORDER`, or similar settings there apply to the
run. `ADMIN_API_KEY`, `ANS104_UNBUNDLE_FILTER`, `ANS104_INDEX_FILTER`,
`START_HEIGHT`, and `STOP_HEIGHT` are overridden by the harness.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTO_VERIFY_ITERATIONS` | `0` (all ranges) | If > 0, shuffle `block-ranges.json` and run the first N. |
| `AUTO_VERIFY_REFERENCE_URL` | `https://arweave.net` | Trusted gateway used by `bundle-parser` as a secondary source when the local gateway can't serve a bundle. |
| `AUTO_VERIFY_GATEWAY_URL` | `http://localhost:4000` | URL of the local gateway spawned by the harness. |
| `AUTO_VERIFY_RESULTS_DIR` | `<cwd>/data/test-auto-verify` | Where per-iteration reports and the Parquet staging dir are written. |
| `AUTO_VERIFY_FAIL_FAST` | `false` | Exit on the first iteration with discrepancies. |
| `AUTO_VERIFY_PRESERVE_CACHE` | `true` | When `false`, also wipe `data.db`, `data/contiguous/`, and `data/lmdb/` between iterations. Slower but fully isolated. |
| `AUTO_VERIFY_CLICKHOUSE_URL` | unset | ClickHouse HTTP URL (e.g. `http://localhost:8123`). Enables the ClickHouse source. |
| `CLICKHOUSE_HOST` / `CLICKHOUSE_PORT` / `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` | `localhost` / `9000` / `default` / empty | Used by the `scripts/clickhouse-import` call, not by the adapter's query client. |

## Gotchas

### Background retrieval order governs bundle reachability

Bundle data fetches during unbundling use `BACKGROUND_RETRIEVAL_ORDER`,
not `ON_DEMAND_RETRIEVAL_ORDER`. If every gateway in the trusted list
fails (e.g. arweave.net 502, turbo-gateway.com timeout), unbundling
stalls and `matched_data_item_count` stays NULL for that bundle. Include
`chunks` in the list (e.g.
`BACKGROUND_RETRIEVAL_ORDER=trusted-gateways,chunks`) so the gateway
falls through to chunk-level retrieval from Arweave nodes when the
gateway endpoints refuse. The default (`chunks`) already does this;
explicit overrides don't.

### Bundle indexing timeout

`waitForIndexingComplete` gives bundle unbundling 5 minutes. If a bundle
never finishes unbundling in that window, the harness prints "Bundle
indexing timed out — proceeding with partially indexed bundles" and
continues. The iteration will then report `missing_in_source`
discrepancies for the data items that never indexed. This is expected
when upstream gateways are unreachable; investigate the gateway's
retrieval chain before treating the discrepancy as a real bug.

### ClickHouse schema drift

The `ClickHouseSource` queries `FROM transactions FINAL` against the
consolidated PE-9059 schema. If `AUTO_VERIFY_CLICKHOUSE_URL` points at a
ClickHouse instance with an older schema (separate `id_transactions`,
`owner_transactions`, `target_transactions`), the `clickhouse-import`
call will fail schema validation before the adapter even runs. Drop the
old tables and let `clickhouse-import` recreate them.

### Preserve-cache semantics

`AUTO_VERIFY_PRESERVE_CACHE=true` (the default) keeps `data.db` across
iterations. Because `data.db` migrations are tracked in `core.db` which
*is* wiped, the harness pre-registers the `data.db` migration names so
Umzug skips them on the next `yarn db:migrate up`. If you change a
`data.db` migration, run with `AUTO_VERIFY_PRESERVE_CACHE=false` once
to force a clean rebuild.

### Results directory

Each iteration writes `iteration-<N>.json`; the final summary is
`summary.json`. The Parquet staging dir (`<resultsDir>/parquet-staging`)
is recreated every iteration — don't store anything there you want to
keep.
