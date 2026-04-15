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
> this. Operators upgrading from an earlier release of ar-io-node must drop
> the previous `transactions`, `id_transactions`, `owner_transactions`, and
> `target_transactions` tables and re-import from Parquet — the schema was
> consolidated into a single `transactions` table with skip indexes and
> projections.

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
- A `bloom_filter` skip index on `id` for fast point lookups.
- A `bloom_filter` skip index on `tags` for fast tag-filter queries.
- `PROJECTION owner_projection` sorted by
  `(owner_address, height, block_transaction_index, is_data_item, id)`
  for owner-filtered queries.
- A `bloom_filter` skip index on `target` for fast recipient-filter
  queries.
- `Delta + ZSTD(1)` codecs on monotonic timestamp columns and
  `LowCardinality` on `content_type` / `signature_type` for reduced
  storage.

See `src/database/clickhouse/schema.sql` for the full definition.

## Tag-based TTL Rules

ClickHouse retains imported transactions indefinitely unless an operator
defines a matching TTL rule. Rules let you expire rows by tag content or
by uploader owner address — useful for short-lived app data (ephemeral
chat, test uploads, specific content types) or for data from a
short-retention uploader.

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
logs a warning and proceeds; rule tables stay empty and all rows get
`expires_at = NULL`.

### Rules file format

```yaml
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

  # Owner rules (value is base64url, as operators see on Arweave)
  - field: owner_address
    value: abcDEF0123...xyz
    ttl_seconds: 604800

  - field: owner_address
    value: test-uploader-
    match: prefix
    ttl_seconds: 3600
```

Defaults: `field` is `tag`, `match` is `exact`.

### Behavior

- **Shortest TTL wins.** If multiple rules match a row (e.g. both a tag rule
  and an owner rule), `expires_at` is computed from the smallest `ttl_seconds`.
- **No match → `NULL` `expires_at` → kept indefinitely.**
- **Normalization.** `tag_name` is lower-cased + trimmed on both sides;
  `tag_value` is trimmed but case-preserving; the loader base64url-decodes
  owner `value` into raw bytes so matching happens against the stored
  `owner_address` BLOB directly.
- **Content-Type parameters.** There is no special handling for Content-Type.
  To match `image/gif; charset=utf-8` use `match: prefix` with
  `tag_value: image/gif`.
- **No backfill in v1.** Rules apply only to rows imported after the rules
  are loaded; previously-imported rows keep their existing `expires_at`
  (or `NULL`).
- **Fail-open.** A missing or malformed rules file logs a warning and exits
  cleanly; existing rules remain in place and the import proceeds.

### Inspecting loaded rules

```sh
clickhouse client --password <your-password> -q 'SELECT * FROM ttl_tag_rules_src'
clickhouse client --password <your-password> -q 'SELECT * FROM ttl_tag_prefix_rules'
clickhouse client --password <your-password> -q 'SELECT * FROM ttl_owner_rules_src'
clickhouse client --password <your-password> -q 'SELECT * FROM ttl_owner_prefix_rules'
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

## Rollback

If a re-import using the consolidated schema causes problems, revert as
follows:

```sh
# Stop the gateway
docker compose --profile clickhouse down

# Drop the consolidated table
clickhouse client --password <your-password> -q 'DROP TABLE IF EXISTS transactions'

# Check out the prior schema and import script
git checkout <pre-PE-9059-tag> -- \
  src/database/clickhouse/schema.sql \
  scripts/clickhouse-import

# Re-import from the Parquet snapshot (unchanged source of truth)
docker compose --profile clickhouse up clickhouse -d
./scripts/clickhouse-import --input-dir data/parquet --all-partitions
```

