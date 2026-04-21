# Overview

Release 33 and greater have experimental support for both exporting Parquet
files from the SQLite DBs maintained by the gateway and importing those files
into ClickHouse. ClickHouse's high-performance query engine and advanced data
compression allow gateways to handle larger data sets while the use of Parquet
supports sharing indexing work across gateways by reusing their outputs in the
form of Parquet files.

> [!NOTE]
> This guide assumes you are using Docker Compose on Linux. Other OSes and
> container orchestration tools can be made to work as well, but are not
> covered in this document.

> [!IMPORTANT]
> ClickHouse **24.8 or later** is required (projections on
> `ReplacingMergeTree` are production-safe from 24.8). The
> `docker-compose.yaml` default image (`clickhouse-server:26.3`) satisfies
> this. Operators upgrading from an earlier release of ar-io-node need to
> migrate to the consolidated single `transactions` table (previously split
> across `id_transactions`, `owner_transactions`, and `target_transactions`).
> The simplest path is to drop those tables and re-import from Parquet.
> Operators who want to preserve `expires_at` state or avoid the re-import
> can use the in-place path instead — see [In-place upgrade](#in-place-upgrade)
> below.

# Usage

Below is an example of how to configure your gateway to serve a complete
historical ArDrive index and index new ArDrive bundles on an ongoing basis.

> [!NOTE]
> While we currently only offer ArDrive Parquet snapshots, we are
> interested in hearing from users about what other data sets would be useful
> and may provide more options in the future.

## Configure the ar-io-node

In order to perform the initial import and ongoing export of bundle data items
to ClickHouse, configure the gateway with an admin password, ClickHouse
password, and bundle indexing filters.

Place the following `.env` in the root ar-io-node directory:
```sh
#ADMIN_API_KEY=<example> # CHANGE THIS VALUE AND UNCOMMENT!
#CLICKHOUSE_PASSWORD=<example> # CHANGE THIS VALUE AND UNCOMMENT!
CLICKHOUSE_URL="http://clickhouse:8123"
ANS104_UNBUNDLE_FILTER='{ "and": [ { "not": { "or": [ { "tags": [ { "name": "Bundler-App-Name", "value": "Warp" } ] }, { "tags": [ { "name": "Bundler-App-Name", "value": "Redstone" } ] }, { "tags": [ { "name": "Bundler-App-Name", "value": "KYVE" } ] }, { "tags": [ { "name": "Bundler-App-Name", "value": "AO" } ] }, { "attributes": { "owner_address": "-OXcT1sVRSA5eGwt2k6Yuz8-3e3g9WJi5uSE99CWqsBs" } }, { "attributes": { "owner_address": "ZE0N-8P9gXkhtK-07PQu9d8me5tGDxa_i4Mee5RzVYg" } }, { "attributes": { "owner_address": "6DTqSgzXVErOuLhaP0fmAjqF4yzXkvth58asTxP3pNw" } } ] } }, { "tags": [ { "name": "App-Name", "valueStartsWith": "ArDrive" } ] } ] }'
ANS104_INDEX_FILTER='{ "tags": [ { "name": "App-Name", "value": "ArDrive-App" } ] }'
```

## Download and import the Parquet

Run the following in the ar-io-node root directory:

```sh
curl -L https://arweave.net/JVmsuD2EmFkhitzWN71oi9woADE4WUfvrbBYgremCBM -o 2025-04-23-ardrive-ans104-parquet.tar.gz
tar -xzf 2025-04-23-ardrive-ans104-parquet.tar.gz
mv 2025-04-23-ardrive-ans104-parquet/* data/parquet
docker compose --profile clickhouse up clickhouse -d
./scripts/clickhouse-import --input-dir data/parquet --all-partitions
docker compose --profile clickhouse down
```

The import process should take 10 - 20 minutes depending on your hardware and
will log progress as it proceeds. One completed, if you have the ClickHouse
client installed, you can confirm the data was successfully imported with the
following command:

```sh
clickhouse client --password <your-password> -h localhost -q 'SELECT COUNT(DISTINCT id) FROM transactions'
```

The query will take a second or two to run and should output `32712311`.

## Download and move the SQLite DB snapshot

The Arweave base layer SQLite DB snapshots are significantly larger than the
Parquet files and not as easy to incrementally update, so we distribute them
using BitTorrent. You can download them using the torrent client of your
choice. Below is an example of doing this using Transmission:

```sh
transmission-cli "magnet:?xt=urn:btih:62ca6e05248e6df59fac9e38252e9c71951294ed&dn=2025-04-23-sqlite.tar.gz&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=http%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fopen.demonii.com%3A1337%2Fannounce&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451%2Fannounce&tr=udp%3A%2F%2Fp4p.arenabg.com%3A1337%2Fannounce&tr=https%3A%2F%2Ftracker.bt4g.com%3A443%2Fannounce"
```

Once you have a copy of the SQLite DB snapshot, run the commands below in the
ar-io-node root directory.

> [!WARNING]
> This will erase your existing SQLite DB. Be sure to create a copy first if
> you'd like to preserve it.

```sh
tar -xzf 2025-04-23-sqlite.tar.gz
rm data/sqlite/*
mv 2025-04-23-sqlite/* data/sqlite
```

## Start the ar-io-node

```sh
docker compose --profile clickhouse up -d
```

This will start the ar-io-node with ClickHouse and automatically export
data items to ClickHouse after they are unbundled.

## Run a GraphQL with ClickHouse

The following GraphQL query will verify that ClickHouse is working as expected
by retreiving a data item imported from Parquet:

```sh
curl -g -X POST \
  -H "Content-Type: application/json" \
  -d '{"query":"query { transactions(ids: [\"YSNwoYB01EFIzbs6HmkGUjjxHW3xuqh-rckYhi0av4A\"]) { edges { node { block { height } bundledIn { id } } } } }"}' \
  http://localhost:3000/graphql

# Expected output:
# {"data":{"transactions":{"edges":[{"node":{"block":{"height":1461918},"bundledIn":{"id":"ylhb0PqDtG5HwBg00_RYztUl0x2RuKvbNzT6YiNR2JA"}}}]}}}
```

## Schema layout

The ClickHouse schema consists of three staging tables
(`staging_blocks`, `staging_transactions`, `staging_tags`) used during
Parquet import, and a single final `transactions` table. The final table
includes:

- Partitioning by `intDiv(height, 100000)` for partition pruning on
  height-bounded queries.
- `bloom_filter` skip indexes on `id` and `target` for fast point and
  recipient-filter queries.
- `bloom_filter` skip indexes on `tag_names` and `tag_values`
  (materialized columns projected from `tags` via
  `arrayMap(x -> x.N, tags)`) for fast tag-filter queries. Skip indexes
  cannot match lambda expressions directly, so the arrays are projected
  into their own columns and indexed there.
- `PROJECTION owner_projection` with body
  `SELECT *, tag_names, tag_values` sorted by
  `(owner_address, height, block_transaction_index, is_data_item, id)`
  for owner-filtered queries. The `tag_names` / `tag_values` must be
  listed explicitly in the projection body so the optimizer can serve
  tag-filtered queries from it — they're `MATERIALIZED`, so `SELECT *`
  alone would exclude them.
- `Delta + ZSTD(1)` codecs on monotonic timestamp columns and
  `LowCardinality` on `content_type` for reduced storage.

See `src/database/clickhouse/schema.sql` and
`src/database/clickhouse/ttl-schema.sql` for the full definition.

## Tag-based TTL Rules

By default ClickHouse retains imported transactions indefinitely. Operators
can define TTL rules that expire rows by tag content or by uploader owner
address — useful for short-lived app data (ephemeral chat, test uploads,
specific content types) or for data from a short-retention uploader. A
top-level `default_ttl_seconds` can apply a fallback TTL to every row that
no rule matched, and individual rules can opt rows out of expiry entirely
with `never_expire: true`. A top-level `l1_never_expires: true` keeps all
L1 transactions (`is_data_item = 0`) indefinitely regardless of
`default_ttl_seconds` or matching rules.

Rules live in a YAML file at `config/clickhouse-ttl-rules.yaml`
(override the host path with `CLICKHOUSE_TTL_RULES_PATH`). The repo ships a
committed template at `config/clickhouse-ttl-rules.example.yaml` — copy it
to activate rules:

```sh
cp config/clickhouse-ttl-rules.example.yaml config/clickhouse-ttl-rules.yaml
# then edit config/clickhouse-ttl-rules.yaml
```

The real filename is gitignored so operator policies aren't committed.
`clickhouse-auto-import` mounts the file into the container and loads it at
the top of every import cycle via `scripts/clickhouse-load-ttl-rules.py`.
Normalized rules are written to four source tables; two dictionaries
(`ttl_tag_rules`, `ttl_owner_rules`) layered over the exact-match tables
refresh on a 60–300 s `LIFETIME` and are used by
`migrate_staging_to_final` to compute `transactions.expires_at` on every
staging→final insert. If the file doesn't exist at import time the loader
logs a warning and skips the reload step; any previously loaded rules
remain active, and if no rules have ever been loaded rows get
`expires_at = NULL`.

### Rules file format

```yaml
# Optional: applied when no rule matches a row. Omit to keep unmatched rows
# indefinitely (the prior default).
default_ttl_seconds: 2592000    # 30 days

# Optional: keep all L1 transactions (is_data_item = 0) forever, regardless
# of default_ttl_seconds or matching rules. Pair with default_ttl_seconds
# to expire bundled data items while retaining the L1 layer.
l1_never_expires: true

rules:
  # Tag rules (field defaults to "tag")
  - tag_name: App-Name
    tag_value: ephemeral-chat
    ttl_seconds: 86400          # 1 day

  - tag_name: App-Name
    tag_value: test-
    match: prefix
    ttl_seconds: 3600           # 1 hour

  - tag_name: Content-Type      # use match: prefix to catch parameterized
    tag_value: image/gif        # forms like "image/gif; charset=utf-8"
    match: prefix
    ttl_seconds: 2592000

  # Exempt rule: use `never_expire: true` in place of `ttl_seconds` to opt
  # matching rows out of expiry entirely (overrides default_ttl_seconds
  # and any other TTL rule that might also match).
  - tag_name: App-Name
    tag_value: ArDrive
    match: prefix
    never_expire: true

  # Owner rules (value is base64url, as operators see on Arweave)
  - field: owner_address
    value: abcDEF0123...xyz
    ttl_seconds: 604800

  - field: owner_address
    value: test-uploader-
    match: prefix
    ttl_seconds: 3600
```

Defaults: `field` is `tag`, `match` is `exact`. A rule must set exactly one
of `ttl_seconds` (positive integer) or `never_expire: true`.

### Behavior

- **Precedence** (first applicable branch wins):
  1. `l1_never_expires: true` AND row is L1 (`is_data_item = 0`) →
     `expires_at = NULL`.
  2. Any matching rule with `never_expire: true` → `expires_at = NULL`.
  3. One or more matching TTL rules → shortest `ttl_seconds` wins.
  4. `default_ttl_seconds` set at the top level → that value is applied.
  5. Otherwise → `expires_at` is `NULL` and the row is kept indefinitely.
- **Normalization.** `tag_name` is lower-cased + trimmed on both sides;
  `tag_value` is trimmed but case-preserving. Owner `value` is stored as
  the operator-supplied base64url string and compared against
  `base64URLEncode(owner_address)` at query time — so prefix rules match
  textually (e.g. a 6-character base64url prefix works), not on raw bytes.
- **Content-Type parameters.** There is no special handling for Content-Type.
  To match `image/gif; charset=utf-8` use `match: prefix` with
  `tag_value: image/gif`.
- **No backfill in v1.** Rules apply only to rows imported after the rules
  are loaded; previously-imported rows keep their existing `expires_at`
  (or `NULL`).
- **Fail-open.** A missing, unreadable, or malformed rules file logs a
  warning and exits 0; previously loaded rules remain active and imports
  proceed normally. If ClickHouse rejects a write mid-load, the loader
  best-effort truncates the four rule tables and retries the dictionary
  reload with a short backoff. On the happy recovery path the cycle sees
  no TTL rules; if the retries still can't reload the dictionaries, prefix
  rules are cleared but exact-match dictionaries may briefly serve stale
  entries until the next successful load. The loader's stderr identifies
  which case fired.

### Inspecting loaded rules

```sh
clickhouse client --password <your-password> -q 'SELECT * FROM ttl_tag_rules_src'
clickhouse client --password <your-password> -q 'SELECT * FROM ttl_tag_prefix_rules'
clickhouse client --password <your-password> -q 'SELECT * FROM ttl_owner_rules_src'
clickhouse client --password <your-password> -q 'SELECT * FROM ttl_owner_prefix_rules'
clickhouse client --password <your-password> -q 'SELECT * FROM ttl_settings FINAL'
```

### Backfilling existing rows (optional)

Rules don't apply retroactively. To compute `expires_at` for previously
imported rows, operators can run a mutation against `transactions` using
the same lookup logic as `migrate_staging_to_final`:

```sql
ALTER TABLE transactions
UPDATE expires_at = <same expression used at import time>
WHERE 1;
```

This is a heavy mutation and should be scheduled off-peak.

## In-place upgrade

Operators upgrading an existing deployment who want to avoid the full
drop-and-re-import can use the idempotent ALTERs that ship in
`src/database/clickhouse/schema.sql`. The import script runs the
`expires_at` column-add and TTL rewrite on every cycle, so they apply
automatically on first startup. The one manual step is rebuilding
`owner_projection` with the new body so tag-filter queries can be served
from it:

```sql
ALTER TABLE transactions DROP PROJECTION IF EXISTS owner_projection;
ALTER TABLE transactions ADD PROJECTION owner_projection (
  SELECT *, tag_names, tag_values
  ORDER BY (owner_address, height, block_transaction_index, is_data_item, id)
);
ALTER TABLE transactions MATERIALIZE PROJECTION owner_projection;
```

`MATERIALIZE PROJECTION` rewrites every part, so it's not run
automatically — that would re-trigger on every import cycle. Track
progress with:

```sql
SELECT * FROM system.mutations
WHERE table = 'transactions' AND NOT is_done;
```

Fresh deployments (and deployments that went through the drop + re-import
path) get the correct projection body from `CREATE TABLE` and do not
need this step.

## Rollback

If a re-import using the consolidated schema causes problems, revert as
follows:

```sh
# Stop the gateway
docker compose --profile clickhouse down

# Drop the consolidated table
clickhouse client --password <your-password> -q 'DROP TABLE IF EXISTS transactions'

# Check out the pre-consolidation schema and import script. Use the
# commit immediately preceding 50029213 (the PE-9059 consolidation):
git checkout 50029213^ -- \
  src/database/clickhouse/schema.sql \
  src/database/clickhouse/ttl-schema.sql \
  scripts/clickhouse-import

# Re-import from the Parquet snapshot (unchanged source of truth)
docker compose --profile clickhouse up clickhouse -d
./scripts/clickhouse-import --input-dir data/parquet --all-partitions
```
