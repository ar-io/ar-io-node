# ArDrive Sync Audit Prompt — read-only, multi-gateway

A self-contained prompt you can paste into a Claude Code session on any
AR.IO gateway host to produce a comparable ArDrive coverage report.
Tolerates missing ClickHouse, different DB paths, and distroless
containers.

**Use it when:** comparing ArDrive coverage across gateways, validating
that a backfill is making progress, or generating a one-shot status
snapshot for an operator/audit conversation.

**Output it to a file** so you can diff between gateways:

```bash
> /tmp/ardrive-sync-$(hostname)-$(date -u +%Y%m%d).md
```

---

## Prompt to paste

```text
ArDrive sync audit — read-only diagnostic. NO CHANGES.

Goal: report how much ArDrive data this gateway has indexed, in a format
I can compare across gateways. Run the queries below verbatim (adjust
paths if needed) and present results in the exact table structure shown
at the end.

== Step 1: locate SQLite DBs ==
Default candidates (in order):
  /var/lib/ar-io-node/dbs/indexer/sqlite/bundles.db
  /opt/ar-io-node/data/sqlite/bundles.db
  /var/lib/ar-io-node/dbs/core/sqlite/bundles.db
  /programs/ar-io-node/data/sqlite/bundles.db
If not found, search:
  sudo find /var/lib /opt /programs -maxdepth 6 -name 'bundles.db' 2>/dev/null

== Step 2: detect ClickHouse ==
  sudo docker ps --format '{{.Names}}' | grep -i clickhouse | grep -v auto-import | head -1
If empty, note "ClickHouse not present on this gateway" and skip step 4.

== Step 3: SQLite query (hot/recent tier) ==
Use a READ-ONLY connection (sqlite3 -readonly) since the gateway is
writing to this DB concurrently.

3a) Bundle tier counters:
  sqlite3 -readonly <bundles_db_path> "
  SELECT 'SQLITE_BUNDLES_TOTAL' AS k, COUNT(*) AS v FROM bundles
  UNION ALL SELECT 'SQLITE_BUNDLES_UNBUNDLED',        COUNT(*) FROM bundles WHERE data_item_count IS NOT NULL
  UNION ALL SELECT 'SQLITE_BUNDLES_SKIPPED_FILTER',   COUNT(*) FROM bundles WHERE first_skipped_at IS NOT NULL AND data_item_count IS NULL
  UNION ALL SELECT 'SQLITE_BUNDLES_STUCK_GE5_ATTEMPTS', COUNT(*) FROM bundles WHERE import_attempt_count >= 5 AND data_item_count IS NULL
  UNION ALL SELECT 'SQLITE_DATA_ITEMS_STABLE',        COUNT(*) FROM stable_data_items
  UNION ALL SELECT 'SQLITE_DATA_ITEMS_NEW',           COUNT(*) FROM new_data_items;"

3b) ArDrive App-Name breakdown (SQLite hot tier):
  sqlite3 -readonly <bundles_db_path> "
  SELECT
    CAST(v.value AS TEXT) AS app_name,
    COUNT(*) AS data_items,
    printf('%.2f', SUM(di.data_size)/1024.0/1024.0/1024.0) AS gb
  FROM stable_data_item_tags t
  JOIN tag_names n  ON n.hash = t.tag_name_hash
  JOIN tag_values v ON v.hash = t.tag_value_hash
  JOIN stable_data_items di ON di.id = t.data_item_id
  WHERE CAST(n.name AS TEXT) = 'App-Name'
    AND lower(CAST(v.value AS TEXT)) LIKE 'ardrive%'
  GROUP BY v.value ORDER BY data_items DESC;"

3c) Freshness:
  sqlite3 -readonly <bundles_db_path> "
  SELECT 'last_bundle_unbundled',  datetime(MAX(last_unbundled_at),      'unixepoch') FROM bundles WHERE last_unbundled_at IS NOT NULL
  UNION ALL SELECT 'last_item_indexed_stable', datetime(MAX(indexed_at), 'unixepoch') FROM stable_data_items WHERE indexed_at IS NOT NULL;"

== Step 4: ClickHouse queries (full-history archive) ==
Skip if no ClickHouse container.
CH=<clickhouse_container_from_step_2>

4a) Totals + height range:
  sudo docker exec $CH clickhouse-client --query "
  SELECT 'CH_TOTAL_DATA_ITEMS' AS k, count() AS v FROM default.transactions WHERE is_data_item = 1
  UNION ALL SELECT 'CH_HEIGHT_MIN', min(height) FROM default.transactions
  UNION ALL SELECT 'CH_HEIGHT_MAX', max(height) FROM default.transactions
  FORMAT TSV"

4b) ArDrive App-Name breakdown:
  sudo docker exec $CH clickhouse-client --query "
  SELECT
    arrayElement(tag_values, indexOf(tag_names, 'App-Name')) AS app_name,
    count() AS data_items,
    round(sum(data_size)/1024/1024/1024, 2) AS gb
  FROM default.transactions
  WHERE is_data_item = 1
    AND has(tag_names, 'App-Name')
    AND lower(arrayElement(tag_values, indexOf(tag_names, 'App-Name'))) LIKE 'ardrive%'
  GROUP BY app_name ORDER BY data_items DESC FORMAT PrettyCompact"

4c) ArFS Entity-Type breakdown:
  sudo docker exec $CH clickhouse-client --query "
  SELECT
    ifNull(arrayElement(tag_values, indexOf(tag_names, 'Entity-Type')),'(empty)') AS entity_type,
    count() AS items,
    round(sum(data_size)/1024/1024/1024, 2) AS gb
  FROM default.transactions
  WHERE is_data_item = 1 AND has(tag_names, 'ArFS')
  GROUP BY entity_type ORDER BY items DESC FORMAT PrettyCompact"

4d) Union footprint (ArFS OR ArDrive-*):
  sudo docker exec $CH clickhouse-client --query "
  SELECT
    count() AS data_items,
    round(sum(data_size)/1024/1024/1024, 2) AS total_gb,
    min(height) AS first_height,
    max(height) AS last_height
  FROM default.transactions
  WHERE is_data_item = 1
    AND (
      has(tag_names, 'ArFS')
      OR (has(tag_names, 'App-Name')
          AND lower(arrayElement(tag_values, indexOf(tag_names, 'App-Name'))) LIKE 'ardrive%')
    )
  FORMAT PrettyCompact"

4e) Backfill rate (last 30 days, monthly):
  sudo docker exec $CH clickhouse-client --query "
  SELECT
    toStartOfDay(block_timestamp) AS day,
    count() AS items_indexed
  FROM default.transactions
  WHERE is_data_item = 1
    AND has(tag_names, 'ArFS')
    AND block_timestamp >= now() - INTERVAL 30 DAY
  GROUP BY day ORDER BY day DESC LIMIT 30 FORMAT PrettyCompact"

== Step 5: gateway identity ==
  hostname
  curl -s -m 3 http://localhost:4000/ar-io/info | python3 -c \
    'import sys,json; d=json.load(sys.stdin); print(d.get("wallet"),d.get("release"))'
  grep -E '^ANS104_UNBUNDLE_FILTER=' /opt/ar-io-node/.env /programs/ar-io-node/.env 2>/dev/null | head -1

== Step 6: present results in this exact format ==

# ArDrive Sync Report — <hostname>
- Gateway wallet: <wallet>
- Release: <release>
- Unbundle filter: <filter or "default (none set)">
- Report time: <UTC timestamp>
- Last unbundled: <timestamp>  ← freshness indicator
- Last item indexed (stable): <timestamp>

## Bundles (SQLite)
- Total seen: <n>
- Unbundled: <n>
- Skipped by filter: <n>
- Stuck (>=5 retry attempts): <n>   ← if non-trivial, flag as a backfill backlog signal

## ArDrive footprint — union of ArFS-tagged + ArDrive App-Name
(Use ClickHouse numbers; if no ClickHouse, use SQLite and note it)

| Source | Data items | Total GB | Height range |
|---|---:|---:|---|
| ClickHouse (full history) | <n> | <gb> | <min> → <max> |
| SQLite (hot tier only) | <n> | <gb> | — |

## By App-Name (ClickHouse if present)
| App-Name | Data items | GB |
|---|---:|---:|
| <each variant from query> | | |

## By ArFS Entity-Type (ClickHouse if present)
| Entity-Type | Items | GB |
|---|---:|---:|
| file     | | |
| folder   | | |
| drive    | | |
| snapshot | | |

## Notes
- If ClickHouse missing: state explicitly and note SQLite-only figures
  underrepresent total (SQLite is hot tier, prune watermark removes older
  items).
- If any SQLite query errors on a missing column, report which column
  and continue with the rest.
- Do NOT make any changes. Read-only audit.
```

---

## Two operator suggestions

1. **Persist per-gateway reports** so you can diff them and watch
   trajectories:
   ```bash
   > /tmp/ardrive-sync-$(hostname)-$(date -u +%Y%m%d).md
   ```
   Then `diff` between gateways or paste into a spreadsheet.

2. **Use the "ClickHouse full history" row for cross-gateway
   comparison.** That's the apples-to-apples metric. SQLite counts
   depend on each gateway's prune watermark, which can differ across
   deployments.

## Apples-to-apples gotchas (saved from past runs)

- **`stable_data_items` does not contain everything matched.** The
  bundle-level `matched_data_item_count` is updated when a bundle is
  fully unbundled (and counts items that pass `ANS104_INDEX_FILTER`),
  but those items only enter `stable_data_items` after a separate
  promotion pass. Big backlog gaps between the two are normal during
  catch-up. For "what's queryable now" use `stable + new`. For "what
  we've validated" use `SUM(matched_data_item_count)`. For
  cross-gateway comparison use **ClickHouse**.
- **The SQLite hot tier is intentionally truncated.** If two gateways
  have very different `SQLITE_DATA_ITEMS_STABLE` it's the prune
  watermark, not actual coverage. Confirm via ClickHouse.
- **Distroless containers lack `cat`, `head`, `wc`.** All shell
  utilities (including the sqlite/clickhouse client probes inside
  `docker exec`) should be confined to commands available in the
  client image. `clickhouse-client` itself is present; piping through
  busybox is not. For host-side inspection of compiled JS or files,
  prefer `docker cp` over `docker exec cat`.
- **`bundles.db` is being written to by the running gateway.** Use
  `sqlite3 -readonly` so a concurrent writer can't deadlock the audit
  query.
- **`has(tag_names, 'X')` is a linear scan in ClickHouse.** For a
  ~14M-row `transactions` table this still completes in a few seconds,
  but if it ever doesn't, narrow with `is_data_item = 1` first (it's
  already in every query).
