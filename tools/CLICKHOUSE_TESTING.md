# ClickHouse GraphQL Testing Tool

`./tools/test-clickhouse-graphql` systematically compares the local AR.IO node
GraphQL endpoint against `arweave.net`, with a focus on Drive-Id tags and owner
addresses. It also runs database-level integrity checks against the local
ClickHouse instance.

## What it does

- **Transaction count discovery**: queries ClickHouse directly to find high-volume
  drives (by `Drive-Id` tag) and owners by transaction count.
- **Cross-endpoint comparison**: issues the same GraphQL query against the local
  endpoint and `arweave.net`, then diffs the result sets.
- **Duplicate / missing / discrepancy detection**: identifies transactions that
  appear more than once, transactions present in only one source, and field-level
  mismatches.
- **Pagination consistency**: walks pages in both `HEIGHT_ASC` and `HEIGHT_DESC`
  and checks ordering and cross-page duplicates.
- **Database integrity**: samples ClickHouse rows and verifies they round-trip
  through both GraphQL endpoints (and vice versa).
- **Reporting**: writes HTML, JSON, and CSV reports under
  `test-results/runs/<timestamp>/` with a `latest` symlink.

## Prerequisites

- Local ar-io-node service running (GraphQL on `http://localhost:${CORE_PORT}/graphql`).
- ClickHouse reachable (defaults read from `.env`).
- Internet access for `arweave.net`.

## Configuration

The bash wrapper loads `.env` via `node --env-file`, so variables defined there
are picked up automatically. Canonical names (matching `docker-compose.yaml` and
the rest of the project):

| Variable | Default | Purpose |
|---|---|---|
| `CORE_PORT` | `4000` | Local ar-io-node port. Used to build `http://localhost:${CORE_PORT}/graphql`. |
| `CLICKHOUSE_HOST` | `localhost` | ClickHouse host. |
| `CLICKHOUSE_PORT_2` | `8123` | ClickHouse HTTP port. |
| `CLICKHOUSE_USER` | `default` | ClickHouse user. |
| `CLICKHOUSE_PASSWORD` | _(empty)_ | ClickHouse password. |

CLI flags override env values. See `--help` for the full list.

### Config file

You can instead pass a JSON config with `--config`. See
`tools/example-test-config.json` for the shape. All top-level keys are optional —
anything you omit falls back to the env/CLI defaults:

```json
{
  "clickhouse": { "url": "http://localhost:8123", "user": "default", "password": "" },
  "endpoints": {
    "local": "http://localhost:4000/graphql",
    "remote": "https://arweave.net/graphql"
  },
  "discovery": { "topDrives": 10, "topOwners": 10, "minTransactionCount": 100 },
  "testing": {
    "pageSize": 100,
    "maxPagesPerTest": 100,
    "testBothDirections": true,
    "maxTransactionsPerEntity": 10000,
    "allowPartialComparisons": false
  },
  "databaseIntegrity": {
    "enabled": true,
    "enableDuplicateCheck": true,
    "enableMissingCheck": true,
    "sampleSize": 1000,
    "checkRemoteGraphql": true
  }
}
```

## Usage

```bash
# Auto-discover and test top 10 drives + owners
./tools/test-clickhouse-graphql --auto-discover --top 10

# Target a specific drive
./tools/test-clickhouse-graphql --drive-id <drive-id>

# Target a specific owner
./tools/test-clickhouse-graphql --owner <owner-address>

# Multiple entities in one run
./tools/test-clickhouse-graphql --drive-id drive1 --drive-id drive2 --owner owner1

# Config-driven
./tools/test-clickhouse-graphql --config tools/example-test-config.json --auto-discover

# Allow partial comparisons for entities with many transactions
./tools/test-clickhouse-graphql --auto-discover --allow-partial

# Tighter maxTransactionsPerEntity for faster iteration
./tools/test-clickhouse-graphql --auto-discover --max-transactions 5000

# Verbose — logs every GraphQL query
./tools/test-clickhouse-graphql --drive-id <drive-id> --verbose
```

Run `./tools/test-clickhouse-graphql --help` for the full flag list.

## Output

```
test-results/
├── runs/
│   └── 2026-04-23-10-30-45/
│       ├── config.json            # Snapshot of the config used
│       ├── discovery/
│       │   ├── drive-counts.json
│       │   ├── owner-counts.json
│       │   └── summary.json
│       ├── tests/
│       │   ├── drives/drive_<id>_test.json
│       │   └── owners/owner_<addr>_test.json
│       ├── comparisons/
│       │   ├── duplicates.json
│       │   ├── missing.json
│       │   └── discrepancies.json
│       ├── report.html            # Interactive summary
│       ├── report.json            # Machine-readable summary
│       └── metrics.json
└── latest -> runs/2026-04-23-10-30-45
```

Open `test-results/latest/report.html` in a browser for the interactive view.

## Interpreting results

- **Duplicates**: same transaction ID appears more than once in a result set.
- **Missing**: transaction exists in one source but not the other.
- **Discrepancies**: same transaction has different field values between sources.

Severity:

- **Critical**: core transaction data differs (id, owner, amount, etc.).
- **Minor**: non-essential differences.
- **Informational**: expected differences (e.g. owner keys, which the gateway
  may omit for data items).

Pagination issues:

- **Order violations**: results not sorted consistently by height.
- **Cross-page duplicates**: same transaction on multiple pages.

## Troubleshooting

### Can't reach ClickHouse

```bash
curl http://localhost:8123/ping   # should return "Ok."
```

Check `CLICKHOUSE_HOST` / `CLICKHOUSE_PORT_2` in `.env`. The ClickHouse container
binds `${CLICKHOUSE_PORT_2:-8123}` on the host.

### Can't reach local GraphQL

```bash
curl -X POST http://localhost:4000/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"{ transactions(first:1){ edges { node { id } } } }"}'
```

Check `CORE_PORT`, and that the service is running.

### No Drive-Ids discovered

- The ClickHouse `transactions` table may not be populated yet (data items are
  unbundled asynchronously).
- Lower `minTransactionCount` in `discovery` if you want to see smaller drives.

### Slow queries or timeouts

- Lower `pageSize` and/or `maxPagesPerTest` in config.
- Reduce `--top` or test fewer entities at once.
- Set `--max-transactions` to cap per-entity transaction fetching.

## Schema note

The tool reads directly from the ClickHouse `transactions` table. There is no
separate `owner_transactions` table in the current schema — owner aggregation
is done with `GROUP BY owner_address FROM transactions`.
