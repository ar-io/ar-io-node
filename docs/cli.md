# The `ar-io-node` CLI

`ar-io-node` is the gateway's command-line tool. Its first commands build and
check [index bands](index-swarm.md#producing-bands); every other command is a
command of the `ar.io` CLI from `@ar.io/sdk`, run with the same arguments.

It follows the `ar.io` CLI's conventions, so the two behave alike:

- flat, kebab-case command names (`index-band-build`, `get-gateway`);
- a command's result is printed as indented JSON on **stdout**, with exit code
  `0`;
- an error's message goes to **stderr** (its stack trace with `--debug`), with
  exit code `1`. A check that fails prints its full result, as JSON, on stderr;
- logs go to stderr too, so stdout can be parsed.

If you are a script or an agent, read [For scripts and
agents](#for-scripts-and-agents) first.

## Running it

From the gateway's directory (where `.env` and `docker-compose.yaml` are),
`tools/ar-io-node` runs it in the core image named by `CORE_IMAGE_TAG`, so the
host needs only Docker:

```bash
./tools/ar-io-node --help
./tools/ar-io-node network-help        # the ar.io commands it runs for you
```

The wrapper mounts only what a command needs:

| Commands | Mounted |
| --- | --- |
| `index-band-*` | `INDEX_SWARM_DATA_PATH` (default `./data/indexes`) at `data/indexes`, and the gateway's Docker network (`DOCKER_NETWORK_NAME`, default `ar-io-network`), so `--gateway-url http://core:4000` reaches the gateway |
| `index-band-export` | Also `SQLITE_DATA_PATH` (default `./data/sqlite`) read-only at `data/sqlite`; `CLICKHOUSE_URL`, `CLICKHOUSE_USER` and `CLICKHOUSE_PASSWORD`, passed by name, so not on the command line (`docker inspect` of the running container shows them); and `INDEX_EXPORT_SECRETS_DIR`, if set, read-only at `/run/secrets/index-export` for peers' password files |
| any `ar.io` command | Nothing, except the file a `--wallet-file` (`-w`) names, read-only. A relative path is taken from where you ran the wrapper |

It runs as your user, so what it writes is yours, and
`data/indexes/published/<index>` must be writable by you. Ctrl-C stops a
command; a build interrupted that way leaves its scratch copy in
`data/indexes/export/.band-build-*`, which the next build removes once nothing
has been written in it for a day (or delete it yourself).

Band commands never take a key. For `ar.io` commands that sign, prefer
`--wallet-file` to `--private-key`: an inline key is visible in `ps` and
`docker inspect`.

Settings (`CORE_IMAGE_TAG`, `INDEX_SWARM_DATA_PATH`, `DOCKER_NETWORK_NAME`)
come from your shell if set there, else from `.env`, as for compose. Set
`AR_IO_NODE_CLI_IMAGE` to run another image. From a checkout, run
`node --import ./register.js src/cli/cli.ts <command>`.

### Paths

Inside the container, the data directory is `data/indexes`. The wrapper
rewrites any `--input`, `--band-dir`, `--publish-dir`, `--work-dir` or `--output` that
points inside `INDEX_SWARM_DATA_PATH` (absolute, or relative to where you ran
it) to its `data/indexes/...` form, so all of these work:

```bash
./tools/ar-io-node index-band-verify --band-dir "$INDEX_SWARM_DATA_PATH/published/root-tx-index/<band>" ...
./tools/ar-io-node index-band-verify --band-dir data/indexes/published/root-tx-index/<band> ...
./tools/ar-io-node index-band-verify --band-dir "$(jq -r .dir build.json)" ...   # a build's own "dir"
```

A path outside the data directory is passed through unchanged, and a band
command refuses to write there (it would land inside the container and be
lost). An input file elsewhere goes in on stdin: `--input - < records.csv`.
The `dir` a build reports is the container path (`data/indexes/...`).

## `index-band-build`

Builds one band from CSV records, checks a sample of its headers against
their root transactions, and publishes it:

```bash
./tools/ar-io-node index-band-build --input - --skip-header \
  --publisher <this gateway's wallet> --kind d --height-range 2010500,tip \
  --gateway-url https://turbo-gateway.com < records.csv
```

The band is built under `--work-dir` and renamed into `--publish-dir`, where
the index-swarm sidecar publishes it. Both must be on one filesystem (the
defaults are). An existing band is never overwritten: building the same
records again reports `"unchanged": true`, without checking or writing.

**Input:** CSV in the columns of `tools/generate-cdb64-root-tx-index`, plus a
height:

```text
data_item_id,root_tx_id,path,root_data_item_offset,root_data_offset,data_item_size,height
```

- Only the first two columns are required. `path` must be empty: bands don't
  carry nested bundle paths yet.
- When one ID appears more than once, the highest `height` wins; at equal
  heights a record with offsets beats one without, and any remaining tie is
  broken the same way whatever the input order, so a rebuild gives the same
  band id.
- A malformed row (an ID that isn't 43 base64url characters, a number that
  isn't a non-negative integer) fails the build with its line number.
- A well-formed record the band can't use is **dropped and counted**: offsets
  that don't frame a header (the header span must be 1 byte to 1 MiB), only
  one of the two offsets, or a value too large to address. A few per thousand
  is normal for real data (37 of 4,000 in the test below); the build logs a
  warning with the count.

| Option | Meaning |
| --- | --- |
| `--input <path>` | The CSV, or `-` for stdin. Required |
| `--skip-header` | Skip the CSV's first line |
| `--publisher <wallet>` | The publishing gateway's registered wallet. It names the band (so ids are unique to a publisher) and is not otherwise checked. Required |
| `--kind <kind>` | `d` (delta), `r` (recent), `h` (history), or another name of up to 8 lowercase letters and digits. Required |
| `--height-range <from,to>` | The heights the band covers, e.g. `2010500,tip`; `tip` for a band that follows the tip. It is declared in the band's metadata (subscribers use it to order installs); records are not filtered by it. Required |
| `--supersedes <ids>` | Comma-separated ids of bands this one replaces. Not checked against what exists: the sidecar stops offering the named bands and deletes them after `INDEX_SWARM_SUPERSEDE_GRACE_SECONDS`, and warns once about an id it doesn't hold (see [band metadata](index-swarm.md#band-metadata)) |
| `--metadata <json>` | A JSON object of extra band metadata |
| `--publish-dir <path>` | Where the band is published, one directory per band (default `data/indexes/published/root-tx-index`) |
| `--work-dir <path>` | Scratch space for the build (default `data/indexes/export`) |
| `--gateway-url <url>` | The gateway the header check reads root transactions from. Required unless `--skip-header-check`. See [Choosing `--gateway-url`](#choosing---gateway-url) |
| `--read-timeout <ms>` | How long the check waits for each root read (default 30000) |
| `--skip-header-check` | Publish without the header check |
| `--sample-size <n>` | Entries the check samples (default 150) |
| `--dry-run` | Build and check, but publish nothing |

**The header check** samples entries with offsets and range-reads each one's
root transaction. A band fails if any header is wrong (its signature hash
isn't the ID, or it doesn't end where the payload starts, or the offsets run
past the end of the root), if fewer than 80% of the sample could be read and
passed, or if the band has fewer than 1,000 entries. A failed band is not
published, and the command exits 1 with the result on stderr. A band can pass
with a few entries the gateway couldn't serve: they are listed in `errors`
and count against the 80%, but aren't evidence the band is wrong.

## `index-band-verify`

Runs the header check on a built or installed band:

```bash
./tools/ar-io-node index-band-verify \
  --band-dir data/indexes/published/root-tx-index/<band> \
  --gateway-url https://turbo-gateway.com
```

| Option | Meaning |
| --- | --- |
| `--band-dir <path>` | The band's directory (it holds `manifest.json`). Required |
| `--gateway-url <url>` | As for `index-band-build`. Required |
| `--read-timeout <ms>` | As for `index-band-build` (default 30000) |
| `--sample-size <n>` | Entries to check (default 150) |

It prints the result and exits 1 if the band fails.

## `index-band-export`

Writes one record source's records for a height range as CSV, the format
`index-band-build` reads, with a header line. For checking what a source
gives and for one-off builds; the `index-export` service merges several
sources itself, by rank, which a CSV can't carry.

```bash
./tools/ar-io-node index-band-export --source '{"type":"clickhouse"}' \
  --from 2010000 --to 2011000 --output data/indexes/export/records.csv
./tools/ar-io-node index-band-build --input data/indexes/export/records.csv \
  --skip-header --publisher <wallet> --kind d --height-range 2010000,2011000 \
  --gateway-url https://turbo-gateway.com --dry-run
```

| Option | Meaning |
| --- | --- |
| `--source <json>` | One source, as an `INDEX_EXPORT_SOURCES` entry: `{"type":"clickhouse"}` (this gateway's, from `CLICKHOUSE_*`), `{"type":"clickhouse","url":…,"user":…,"passwordFile":…}` (a peer's), `{"type":"sqlite"}` (`data/sqlite/bundles.db`, or `"path"`), or `{"type":"csv","path":…}` (an overlay directory). Default: this gateway's ClickHouse if `CLICKHOUSE_URL` is set, else its SQLite |
| `--from <height>` / `--to <height>` | The heights to export, both included. Required |
| `--output <path>` | The CSV to write, under `data/indexes` through the wrapper. Written under a `.partial` name and renamed when complete. Required |
| `--force` | Replace `--output` if it exists |

Where each source reads from, through the wrapper:

- **This gateway's ClickHouse:** `CLICKHOUSE_URL` as the container sees it,
  on the gateway's Docker network (`http://clickhouse:8123`, not
  `localhost`).
- **A peer's ClickHouse:** its `url` must be reachable from the container,
  and `passwordFile` is the container path,
  `/run/secrets/index-export/<file>`, readable by your user. The peer's
  ClickHouse user must be allowed to change settings (`readonly=0` or `2`);
  the queries set their own limits and are refused under a `readonly=1`
  profile.
- **SQLite:** `data/sqlite/bundles.db`, opened read-only, which needs the
  gateway running (its `-wal` and `-shm` files present). On a gateway with
  ClickHouse it holds only what import hasn't taken yet.
- **An overlay:** a directory under `data/indexes`. Each file is named for
  the heights it covers, `<from>-<to>.csv`, and files may not overlap;
  anything else in the directory (`*.tmp`, `*.partial`, dot-files) is
  ignored. Write a file under a temp name and rename it into place, and
  don't preserve an old modification time (`cp -p`): the file's age is how
  a stale overlay shows. An export renamed into an overlay directory becomes
  authoritative over every other source within its heights, so put only a
  bundler's own records there.

What it exports, from either index:

- **Data items only**, one record per item: from ClickHouse, the row at the
  highest height, latest inserted, so a re-bundled item gives its later root.
- **Offsets relative to the root, only where proven**: `root_parent_offset`
  plus the item's own, when `root_parent_offset` matches the parent's
  payload. A nested item whose `root_parent_offset` is 0 or unknown may hold
  relative offsets (unbundled before #907 was fixed) or absolute ones
  (resolved on demand), so it is tested against its parent's payload:
  starting before it and fitting it as relative means relative, and it is
  repaired (`repaired`); fitting it as absolute but running past it as
  relative means absolute, and it is kept. Items nested deeper are placed
  only along an unbroken chain of `root_parent_offset`s. Anything unproven
  gives the item's root without offsets, counted in `unrepaired` by reason
  (`ambiguous`, `no_parent`, `inconsistent`, `deep`).
- **Left out and counted** in `dropped`: L1 transactions, items without a
  root or whose root is the item itself, and items of size 0.

ClickHouse queries are read-only and bounded (2 threads, 4 GB with a GROUP BY
spilling to disk past 2 GB, 600 s, low priority, cancelled if the client goes
away), a thousand blocks at a time; a window that still runs out of memory is
retried in halves. Each item's parent comes from the same query. SQLite is
read along its height index, 5,000 rows per statement, with parents by
primary key.

### `index-band-export` result

From a real run (a thousand blocks of a gateway's own ClickHouse; the
records then passed the header check against turbo-gateway.com, 150 of 150):

```json
{
  "output": "data/indexes/export/records.csv",
  "source": "clickhouse",
  "rank": 0,
  "heightRange": [2000000, 2000999],
  "rowsRead": 19747,
  "records": 19747,
  "rootOnly": 0,
  "repaired": 0,
  "unrepaired": {},
  "dropped": {},
  "seconds": 0.3
}
```

`dropped` counts rows left out, by reason: `not_data_item`, `no_root`,
`root_is_item`, `zero_size`, and for an overlay `no_height` and
`outside_coverage`.

## `index-l1-import`

Fills this gateway's `core.db` from installed `parquet-l1` bands, so it
starts from a published index instead of walking the chain block by block.
See "L1 bands" in [index-swarm.md](index-swarm.md) for what a band is and
how one arrives.

**The gateway must be stopped.** The command refuses a `core.db` another
writer holds rather than racing it, and refuses one that still holds
unstable (`new_*`) blocks, which an import would be written beneath. Run
`yarn db:migrate up` first: a `core.db` that has not got the import ledger
is refused too.

```bash
docker compose -f docker-compose.yaml -f docker-compose.override.yaml stop core
docker compose -f docker-compose.yaml -f docker-compose.override.yaml \
  run --rm --no-deps -T core ar-io-node index-l1-import \
  --bands-dir data/indexes/installed/parquet-l1 \
  --core-db data/sqlite/core.db
```

`--no-deps` matters: without it `run` starts the services `core` depends on,
and `stop core` alone does not keep them from bringing it back. Name every
compose file you normally use — passing `-f` at all turns off loading
`docker-compose.override.yaml` automatically.

Bands are imported in height order, lowest first. The run stops at the
first band that fails, because bands must land as a contiguous run — the
block importer rewinds across a gap and gives up after 18 blocks. What was
imported before the failure is kept and recorded, so running the command
again carries on from there.

| Option | |
|---|---|
| `--bands-dir` | A directory of bands, as the sidecar installs them. Required |
| `--core-db` | The gateway's `core.db`. Required |
| `--max-bands` | Import at most this many bands, then stop |
| `--cache-mib` | SQLite page cache for the import, in MiB (default 1024) |

Running it again when there is nothing to do is a no-op: each band is
recorded in `parquet_l1_imports` as it lands, and a band already held is
skipped.

**Interruption is safe.** A band is written to the ledger before its first
row and completed after its last, and importing it clears its height range
first, so a band a crash left part way is imported again over whatever it
managed to write. Progress is read from that ledger, not from
`stable_blocks`: a band writes all of its blocks long before its
transactions, so how far `stable_blocks` reaches says nothing about how
much of a band landed. Every write is idempotent, so a band imported twice
leaves `core.db` exactly as importing it once does.

**Before it starts** the command estimates the space the run needs — about
300 bytes per row, plus 4 GiB held back for the write-ahead log and for the
gateway afterwards — and refuses rather than running out of disk inside a
write transaction. If it refuses, free space or import in stages with
`--max-bands`.

**While a band lands** it logs `Importing a band` to stderr once a minute,
naming the table it is on and the rows it has written of the rows the band
holds. The largest bands take over half an hour, so this is how you tell a
slow import from a stuck one.

**Give it a page cache.** `--cache-mib` is the single biggest lever on a
long import. A bootstrap spends its time maintaining indexes, and SQLite's
own default cache is 2 MB: once the indexes outgrow it every insert
becomes random I/O and the rate falls as the database fills. Measured
full-chain on vilenarios.com with the default, the rate decayed from
31,730 rows/s at 8 GB to 7,758 at 27 GB; raising the cache to 8 GiB held
10,739 rows/s at 69 GB, on a database two and a half times larger. Set it
to whatever the box can spare.

**What to expect.** Measured on vilenarios.com against real bands. A
single band into an empty database is fast: the sparse first 100,000
heights take about 10 seconds, and the busiest 100,000 (46,606,658 rows)
about half an hour, leaving a 12.1 GB `core.db` — roughly 260 bytes a
row.

**A full bootstrap is much slower than those numbers suggest**, and the
difference is not small. The same 42.9M-row band imports at 26,653 rows/s
into an empty database and 11,238 rows/s when the database has already
reached 50 GB: index maintenance, not CPU or the band. Budget for the
whole chain accordingly rather than multiplying the single-band figure.
Allow about 2 GB of WAL beside the database while a band is landing, and
the band's own size on disk.

The whole chain was, at the time of writing, 23 bands and 12.8 GB on disk
holding 468,501,488 rows to height 2,014,135 — the tip band is rebuilt as
the chain grows, so expect those numbers to have moved. Expect **about
120 GB of `core.db`** (a gateway that indexed the same chain itself holds
120.7 GB) and the best part of a day. `--max-bands` splits that across several runs; the ledger makes each
one pick up where the last stopped.

No `ANALYZE` or `VACUUM` is wanted afterwards. The rows are written in
primary-key order into tables the migrations already analysed, and a
`VACUUM` of a 120 GB database would rewrite the lot for nothing. If the
process is killed outright, the `-wal` file beside `core.db` is not a
problem to clear by hand — the next process to open the database replays
it.

**Afterwards.** The block importer continues from the highest height
imported. Transactions that arrive this way never emit `TX_INDEXED`, so
historical bundles are not unbundled unless you also run with
`BACKFILL_BUNDLE_RECORDS`. A transaction a block lists that its band did
not carry is written to `missing_transactions`, and the gateway backfills
it the usual way.

### `index-l1-import` result

```json
{
  "coreDb": "data/sqlite/core.db",
  "bandsDir": "data/indexes/installed/parquet-l1",
  "haveTo": 99999,
  "imported": 1,
  "rows": 125179,
  "missingTransactions": 0,
  "skipped": [
    { "heightRange": [0, 4999], "reason": "covered_by_a_wider_band" }
  ],
  "bands": [
    { "heightRange": [0, 99999], "result": "imported", "rows": 125179, "seconds": 10 }
  ],
  "seconds": 10.4
}
```

`haveTo` is the highest height `core.db` holds when the run ends. A band's
`result` is `imported` or `refused`; a refused one also carries `reason`,
and `refused` appears at the top level. **A refused band fails the
command**: the bands below it are imported and kept, but the result goes
to stderr and the exit code is 1, so a script notices. Run it again to
carry on from what landed. `skipped` lists the bands the run had
no use for, each with a `reason`: `already_imported`,
`covered_by_a_wider_band` (a tip band inside a whole one), or
`below_what_core_db_holds`.

## `index-l1-verify`

Checks this gateway's L1 index against the weave size the chain itself
commits to, and against its own internal arithmetic. Read-only, so the
gateway can stay up.

```bash
docker compose -f docker-compose.yaml -f docker-compose.override.yaml \
  run --rm --no-deps -T core ar-io-node index-l1-verify \
  --core-db data/sqlite/core.db
```

**Why this is worth running.** Above the 2.0 fork (height 422,250) a
block's `tx_root` recomputes from its transactions, so each block's
transaction set proves itself. Below the fork `tx_root` is empty, and a
pre-2.0 block's identity hash cannot be recomputed from an index at all:
it commits to the full wallet list at that height, to the recall block's
whole binary, and to every transaction's bytes including its data and
signature. Modern Arweave nodes do not attempt it either — they take
everything below the fork from a hardcoded block index.

What is left is an accounting identity, and it is exact. A pre-2.0 block
added its transactions' `data_size` to the weave, so for every height

```
weave_size(h) - weave_size(h-1) = block_size(h) = sum of data_size
```

Those differences telescope, and the first post-2.0 block commits its own
`weave_size` in the segment its identity hash is taken over. So a single
trusted block hash pins the total size of every transaction beneath it.

| Option | |
|---|---|
| `--core-db` | The gateway's `core.db`. Required |
| `--from` | Lowest height to check. Defaults to the lowest held |
| `--to` | Highest height to check. Defaults to the fork, or the highest held if lower |
| `--anchor-from` | Comma-separated nodes to ask for the anchor block hashes. Omitted, nothing outside the index vouches for it |
| `--anchor-min` | How many sources must answer per anchor height (default 2) |

An index reaching below the fork is checked up to the fork and no
further: above it `tx_root` is the stronger proof, and reading on costs
tens of millions of rows for nothing. An index starting above the fork is
read whole. Measured: 422,251 blocks in **2.7 seconds**.

**The chain binding.** `hash_list_merkle` is a running commitment to every
block hash below it, and the command rebuilds that recurrence the whole
way — including folding heights 0 to 94,998 for the fork-1.6 seed. Only
the fork-2.0 seed is unrebuildable from stored fields. That is what makes
**one** trusted block hash pin every `indep_hash` beneath it. Without it
the chain is only as strong as `previous_block`, which an index that
fabricated the whole thing self-consistently would satisfy just as well.

`--anchor-from` gets that hash from somewhere independent and is the only
part of this command that asks anyone else:

```bash
ar-io-node index-l1-verify --core-db data/sqlite/core.db \
  --anchor-from http://15.235.234.171:1984,http://208.69.78.61:1984,http://148.113.226.53:1984
```

Prefer raw Arweave nodes (port 1984) over gateways: they are a different
implementation from this one, so their agreement is worth more. Any
gateway's `/peers` lists them. Each anchor height needs `--anchor-min`
sources to answer (default 2) and every source that answers must agree —
**one source is a single point of trust, which is what the anchor exists
to remove**, so a single reachable source fails the check. Sources that
cannot be reached are reported but do not count as disagreement. The
command works offline without it, and says so rather than implying
anything vouches for the index.

Both sides of the fork are anchored automatically: the fork-2.0 seed
breaks the recurrence, so heights below it are anchored at 422,249 and
heights above at the top of the range.

**What it proves.** Given the identity hash of the anchor block, no
transaction below the fork can have been invented, dropped, or had its
size changed, and the index is contiguous, correctly linked, and bound to
that anchor block by block.

**What it does not prove.** Membership of a *particular* pre-2.0 block.
The intermediate `weave_size` values are not committed individually, so
transactions could in principle be moved between pre-2.0 blocks with
those values adjusted to match. Closing that needs agreement between
independent gateways, which is corroboration rather than proof. Do not
describe pre-2.0 membership as cryptographically verified.

Above the weave offset where Arweave began padding each transaction to a
chunk boundary (`STRICT_DATA_SPLIT_THRESHOLD`, 30,607,159,107,830, which
the weave passed around height 800,000) the identity stops holding. Those
blocks are counted as skipped rather than reported as wrong, and a range
with any skipped block is not reported as anchored.

### `index-l1-verify` result

```json
{
  "coreDb": "data/sqlite/core.db",
  "heightRange": [0, 422250],
  "blocks": 422251,
  "anchored": true,
  "anchorHeight": 422250,
  "weaveSize": "407672420044",
  "accountedFor": "407672420044",
  "merkleChecked": 422249,
  "merkleSkipped": 1,
  "accountingChecked": 422250,
  "accountingSkipped": 0,
  "ok": true,
  "checks": [
    { "name": "contiguous", "ok": true, "detail": "..." },
    { "name": "linked", "ok": true, "detail": "..." },
    { "name": "hash_list_merkle", "ok": true, "detail": "..." },
    { "name": "anchor_hash", "ok": true, "detail": "422249: 3 sources agree; ..." },
    { "name": "block_size", "ok": true, "detail": "..." },
    { "name": "weave_accounting", "ok": true, "detail": "..." },
    { "name": "anchor", "ok": true, "detail": "..." }
  ],
  "seconds": 2.7
}
```

`ok` is every check passing. `anchored` says whether the top of the range
commits its own weave size, and whether every block in it could be
accounted for — without that, the checks only show the range is
self-consistent. `weaveSize` and `accountedFor` are strings, because the
weave is larger than a JSON number holds exactly. A failing check carries
`failures` (at most 20, each naming a height, what was found and what was
expected) and `more` for the rest. **When `ok` is false the command fails**:
the same JSON goes to stderr and the exit code is 1, so a script cannot
read a broken index as a good one.

## For scripts and agents

Every `ar-io-node` command is non-interactive and answers in one shape, so a
script or an agent can drive it without parsing prose.

### The contract

| | Success | Failure |
| --- | --- | --- |
| Exit code | `0` | `1` (`130` when interrupted with Ctrl-C) |
| stdout | Exactly one JSON value, the command's result | Empty |
| stderr | Log lines (`info:`, `warn:`) only | Log lines, then either one line of error text, or (for a band refused by the header check, or a failed verify) the result as JSON |

- **Read stdout, branch on the exit code.** Never parse stderr for success;
  log lines may change.
- `--help`, `--version` and `network-help` print text, not JSON. Each
  command's `--help` ends with an example and this contract. `--version`
  prints the `@ar.io/sdk` version the `ar.io` commands run.
- **No prompts.** Band commands never ask for confirmation and never take a
  key. (`ar.io` commands that write do prompt unless given
  `--skip-confirmation`; see their help.)
- **Safe to retry.** A band's id is derived from its content, publisher,
  kind and heights, so building the same records again gives the same id and
  reports `"unchanged": true` without checking or writing. A build that fails
  or is interrupted publishes nothing.
- **Paths:** pass the `dir` a build reports straight back as `--band-dir`;
  see [Paths](#paths).
- **No network** except range reads of root transactions from
  `--gateway-url` during the header check, and `index-band-export`'s reads
  from the ClickHouse it is given. Band commands make no Solana RPC calls.

### `index-band-build` result

From a real run (4,000 records from a gateway's own index, checked against
turbo-gateway.com):

```json
{
  "id": "d-h2000000-tip-f5b1208c-0dac038f25bc",
  "dir": "data/indexes/published/root-tx-index/d-h2000000-tip-f5b1208c-0dac038f25bc",
  "published": true,
  "unchanged": false,
  "dryRun": false,
  "records": 3963,
  "rootOnly": 0,
  "duplicates": 0,
  "dropped": 37,
  "sizeDropped": 0,
  "heightRange": [2000000, null],
  "supersedes": [],
  "contentDigest": "…",
  "headerCheck": {
    "status": "passed",
    "passed": true,
    "reasons": [],
    "totalRecords": 3963,
    "checked": 150,
    "ok": 149,
    "wrong": [],
    "errors": [{ "id": "…", "error": "timeout of 30000ms exceeded" }]
  }
}
```

| Field | Meaning |
| --- | --- |
| `id` | The band's id |
| `dir` | Where the band is, as a container path; `null` on a dry run of a band not already published |
| `published` / `unchanged` | `published` when this run published it; `unchanged` when an identical band was already there. **The band is in place when either is true** |
| `records` | Entries written. `rootOnly` of them have no offsets; `duplicates` lost to a better record for the same ID |
| `dropped` / `sizeDropped` | Records refused as invalid (normal in small numbers), and records whose size was dropped while their offsets were kept |
| `headerCheck.status` | Always present: `passed`, `failed`, `already-published` (an identical band was there; nothing was checked) or `skipped` (`--skip-header-check`). The other fields are present only when the check ran |

A band the check refuses exits `1` and prints this object on stderr, with
`published: false`, `headerCheck.status: "failed"` and a `rejected` array of
reasons.

### `index-band-verify` result

`{ "bandDir", "passed", "reasons", "totalRecords", "checked", "ok", "wrong", "errors" }`.
`wrong` lists entries whose header doesn't match (`id`, `reason`); `errors`
lists entries the gateway couldn't serve (`id`, `error`), which count against
the 80% pass ratio but are not evidence the band is wrong. Exit `1`, with the
object on stderr, when `passed` is false.

### Example

```bash
if out=$(./tools/ar-io-node index-band-build --input - --skip-header \
    --publisher "$WALLET" --kind d --height-range "$FROM,tip" \
    --gateway-url https://turbo-gateway.com < records.csv); then
  dir=$(jq -r .dir <<<"$out")              # in place: .published or .unchanged
  ./tools/ar-io-node index-band-verify --band-dir "$dir" \
    --gateway-url https://turbo-gateway.com >/dev/null
else
  echo "band refused or failed; see stderr" >&2
fi
```

### Choosing `--gateway-url`

The check range-reads up to 150 root transactions. A gateway that has to
fetch them from the network itself can time out on many of them, and the
band is then refused for being under 80% checked, not for being wrong (the
reason says how many couldn't be read, and why). Use a gateway that already
holds the roots, typically the one whose index produced the records, or
`https://turbo-gateway.com`; or raise `--read-timeout`. Measured on
2026-10-01 with 4,000 recent records on a gateway without those roots cached:

| `--gateway-url` | `--read-timeout` | Result | Time |
| --- | --- | --- | --- |
| `http://core:4000` | 30 s (default) | Refused: 108 of 150 passed, 42 reads timed out | 3 min 47 s |
| `http://core:4000` | 120 s | Passed: 149 of 150 | 7 min 8 s |
| `https://turbo-gateway.com` | 30 s (default) | Passed: 149 of 150 | 40 s |

### Errors and what to do

| stderr says | Cause | Fix |
| --- | --- | --- |
| `--input is required` (or `--publisher`, `--kind`, `--height-range`, `--band-dir`) | A required option is missing | Pass it |
| `error: unknown option '--x'` | A misspelt or unsupported option | Check `--help` |
| `--gateway-url is required unless --skip-header-check` | No gateway for the check | Pass `--gateway-url`, or `--skip-header-check` to publish unchecked |
| `--input X cannot be read; through tools/ar-io-node, pipe it on stdin …` | The file isn't there, or is outside the data directory | `--input - < X`, or put X under `INDEX_SWARM_DATA_PATH` |
| `--band-dir X is not a band (no manifest.json)` | Not a band directory, or outside the data directory | Use a path under `INDEX_SWARM_DATA_PATH`, or a build's `dir` |
| `Line N: data_item_id is not a 43-character ID (a header line? use --skip-header)` | A header line, or a malformed ID | `--skip-header`, or fix line N |
| `Line N: nested bundle paths are not supported in bands yet` | The `path` column is set | Leave it empty |
| `Invalid --height-range: …` | Not `<from>,<to>` or `<from>,tip`, or `to` below `from` | Fix the range |
| `Invalid sample-size: …` (or `read-timeout`) | Not a positive integer | Fix the value |
| `--metadata is not valid JSON` (or `must be a JSON object`) | | Pass a JSON object |
| `--publish-dir … is outside data/indexes …` (or `--work-dir`) | Through the wrapper, only the data directory is mounted | Use a directory under it |
| `… checked entries passed, under 80%; N could not be read …` | The gateway couldn't serve enough roots | See [Choosing `--gateway-url`](#choosing---gateway-url) |
| `N of M checked entries are wrong` | Offsets that don't point at the item's header | Fix the source of the records; don't publish |
| `… exists but is not a band …` | Something else is at the band's path | Remove it |
| `workDir … and publishDir … must be on the same filesystem` | The final rename can't cross filesystems | Put both under one mount (the defaults are) |
| `ar-io-node: … predates this tool` | `CORE_IMAGE_TAG` names an image without the CLI | Upgrade, or set `AR_IO_NODE_CLI_IMAGE` |

## `ar.io` commands

Any command `ar-io-node` doesn't own runs as the `ar.io` CLI of the
`@ar.io/sdk` the gateway depends on (`ar-io-node --version` shows which), with
the same arguments, output and exit code:

```bash
./tools/ar-io-node get-gateway --address <wallet>
./tools/ar-io-node help get-gateway     # that command's help
./tools/ar-io-node network-help
```

They are the SDK's commands, unchanged: they use the SDK's own network
defaults and flags (`--mainnet`, `--rpc-url` and the program-id options), not
the gateway's settings, and the gateway itself never runs them. Check a
command's help for which network it targets and what it needs.
