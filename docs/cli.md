# The `ar-io-node` CLI

`ar-io-node` is the gateway's command-line tool. Its first commands build and
check [index bands](index-export.md); every other command is a
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
| `index-l1-*` | `INDEX_SWARM_DATA_PATH` read-only at `data/indexes`; `SQLITE_DATA_PATH` at `data/sqlite`, read-write for `index-l1-import` and read-only for `index-l1-verify` and `index-l1-audit`; for `index-l1-verify --bands-dir`, a spill folder (below); and the gateway's Docker network, so `--data-from`, `--anchor-from` or `--registry-url` can name `http://core:4000`. A `--publication` file is mapped like the other paths |
| `index-census` | `SQLITE_DATA_PATH` read-only at `data/sqlite`; `CLICKHOUSE_URL`, `CLICKHOUSE_USER` and `CLICKHOUSE_PASSWORD`, passed by name; `INDEX_SWARM_DATA_PATH` at `data/indexes`, the only place `--output` may go; and the gateway's Docker network, where `CLICKHOUSE_URL` points |
| `index-l2-*` | `INDEX_SWARM_DATA_PATH` read-only at `data/indexes`, and the gateway's Docker network, so `--gateway-url` can name `http://core:4000` |
| any `ar.io` command | Nothing, except the file a `--wallet-file` (`-w`) names, read-only. A relative path is taken from where you ran the wrapper |

It runs as your user, so what it writes is yours, and
`data/indexes/published/<index>` must be writable by you. `index-l1-import`
is the exception: it runs as the owner of the `core.db` it writes (root, on
a Docker install), so the files it adds beside the database match it.
Ctrl-C stops a
command; a build interrupted that way leaves its scratch copy in
`data/indexes/export/.band-build-*`, which the next build removes once nothing
has been written in it for a day (or delete it yourself).

Band commands never take a key. For `ar.io` commands that sign, prefer
`--wallet-file` to `--private-key`: an inline key is visible in `ps` and
`docker inspect`.

Settings (`CORE_IMAGE_TAG`, `INDEX_SWARM_DATA_PATH`, `SQLITE_DATA_PATH`, `DOCKER_NETWORK_NAME`)
come from your shell if set there, else from `.env`, as for compose. Set
`AR_IO_NODE_CLI_IMAGE` to run another image. From a checkout, run
`node --import ./register.js src/cli/cli.ts <command>`.

### Paths

Inside the container, the data directory is `data/indexes` and the SQLite
directory `data/sqlite`. The wrapper rewrites any `--input`, `--band-dir`,
`--publish-dir`, `--work-dir`, `--output`, `--bands-dir` or `--core-db` that
points inside a mounted directory (absolute, or relative to where you ran it)
to its form in the container, so all of these work:

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
- When one ID appears more than once, the highest `height` wins, and at equal
  heights a record with offsets beats one without. Any remaining tie is broken
  the same way whatever the input order, so a rebuild gives the same band id.
- A malformed row (an ID that isn't 43 base64url characters, a number that
  isn't a non-negative integer) fails the build with its line number.
- A well-formed record the band can't use is **dropped and counted**. That
  covers offsets that don't frame a header (the header span must be 1 byte to
  1 MiB), only one of the two offsets, and a value too large to address. A few per thousand
  is normal for real data (37 of 4,000 in the test below); the build logs a
  warning with the count.

| Option | Meaning |
| --- | --- |
| `--input <path>` | The CSV, or `-` for stdin. Required |
| `--skip-header` | Skip the CSV's first line |
| `--publisher <wallet>` | The publishing gateway's registered wallet. It names the band (so ids are unique to a publisher) and is not otherwise checked. Required |
| `--kind <kind>` | `d` (delta), `r` (recent), `h` (history), or another name of up to 8 lowercase letters and digits. Required |
| `--height-range <from,to>` | The heights the band covers, e.g. `2010500,tip`; `tip` for a band that follows the tip. It is declared in the band's metadata (subscribers use it to order installs); records are not filtered by it. Required |
| `--supersedes <ids>` | Comma-separated ids of bands this one replaces. Not checked against what exists: the sidecar stops offering the named bands and deletes them after `INDEX_SWARM_SUPERSEDE_GRACE_SECONDS`, and warns once about an id it doesn't hold (see [band metadata](index-export.md#band-metadata)) |
| `--metadata <json>` | A JSON object of extra band metadata |
| `--publish-dir <path>` | Where the band is published, one directory per band (default `data/indexes/published/root-tx-index`) |
| `--work-dir <path>` | Scratch space for the build (default `data/indexes/export`) |
| `--gateway-url <url>` | The gateway the header check reads root transactions from. Required unless `--skip-header-check`. See [Choosing `--gateway-url`](#choosing---gateway-url) |
| `--read-timeout <ms>` | How long the check waits for each root read (default 30000) |
| `--skip-header-check` | Publish without the header check |
| `--sample-size <n>` | Entries the check reads (default 150), from a pool ten times that |
| `--dry-run` | Build and check, but publish nothing |

**The header check** samples entries with offsets and range-reads each one's
root transaction. A band fails if any header is wrong: its signature hash
isn't the ID, it doesn't end where the payload starts, or the offsets run
past the end of the root (416, or a short range). It also fails if fewer
than 80% of the entries read passed, if fewer than 40 passed (80% of 50,
or of a smaller sample: this bites only when roots that are gone use the
pool up), or if the band has fewer than 1,000 entries. A
failed band is not published, and the command exits 1 with the result on
stderr. A band can pass with a few entries the gateway couldn't serve (a
timeout, a 429, a 5xx): they are listed in `errors` and count against the
80%, but aren't evidence the band is wrong.

**Roots that are gone.** Old history can sit under root transactions no
gateway has any more. The check samples a pool of ten candidates for each
entry it is to read and walks it in random order: an entry whose root the
gateway answers 404 for is `unreadable`, neither passed nor wrong and left
out of the 80%, and that root is not asked for again. The check goes on
until it has read `--sample-size` entries or the pool runs out, and the
result says how many were unreadable and what share of those tried
(`unreadableShare`, an estimate of how much of the band's history is gone).
When too few could be verified, the reason says how many were unreadable.

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
| `--gateway-url <url>` | As for `index-band-build`. This or `--arweave-nodes` is required |
| `--arweave-nodes <urls>` | Read the roots from these Arweave nodes instead (comma-separated, or `default`), proving every byte against the chain and finding each root in a block on two machines: see [Reading from the chain](index-verification.md#reading-from-the-chain---arweave-nodes). Exclusive with `--gateway-url` |
| `--allow-agreement` | With `--arweave-nodes`: accept a root whose signature arweave-js won't verify when two other machines serve the same signed header (default: such a root is an error) |
| `--read-timeout <ms>` | As for `index-band-build` (default 30000) |
| `--sample-size <n>` | Entries to read (default 150), from a pool ten times that |

It prints the result and exits 1 if the band fails. Roots the gateway
answers 404 for are passed over, as for `index-band-build`. An entry whose header
has the right id and length but a tag count field that disagrees with its
tag bytes (written so by some early bundlers) passes: the item is
malformed, not its offsets wrong. Such entries are listed under
`malformed`, and counted in `malformedTags`.

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
  (resolved on demand). It is tested against its parent's payload. Starting
  before the payload and fitting it as relative means relative, and the item
  is repaired (`repaired`). Fitting it as absolute but running past it as
  relative means absolute, and it is kept. Items nested deeper are placed
  only along an unbroken chain of `root_parent_offset`s. Anything unproven
  gives the item's root without offsets, counted in `unrepaired` by reason
  (`ambiguous`, `no_parent`, `inconsistent`, `deep`).
- **Left out and counted** in `dropped`: L1 transactions, items without a
  root or whose root is the item itself, and items of size 0.

ClickHouse queries are read-only and bounded: 2 threads, 4 GB with a GROUP
BY spilling to disk past 2 GB, 600 s, low priority, and cancelled if the
client goes away. They read a thousand blocks at a time, and a window that
still runs out of memory is retried in halves. Each item's parent comes from the same query. SQLite is
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

Fills this gateway's `core.db` from installed `parquet-l1` bands, so it has
the chain's history without walking it block by block. See
[L1 bands](index-publication.md#l1-bands) for what a band is, and
[subscribing](index-swarm.md#subscribing) for how one arrives.

It runs two ways:

- **While the gateway runs, with `--fill`.** The usual way, and what the
  gateway does by itself with `L1_BAND_IMPORT_ENABLED=true`.
  `tools/index-swarm-setup --subscribe <publisher wallet> --l1` subscribes
  to a publisher's L1 bands and sets that.
- **With the gateway stopped.** The fastest way to load a whole chain into
  an empty database, at the price of the gateway being down while it runs.

Either way, run `yarn db:migrate up` first (the gateway's entrypoint does):
a `core.db` without the import ledger is refused. Only one import or fill
runs against a `core.db` at a time; a second is refused with `Another
import or fill is running`. Through `tools/ar-io-node`, the command runs as
whoever owns the `core.db` it writes (root, on a Docker install), so the
files it adds beside the database match it.

### Nothing is written that was not verified first

Before a band's first row reaches SQLite, both modes check it:

1. **The band, whole**, with the same code as
   [`index-l1-verify --bands-dir`](#index-l1-verify) (lookups aside, since
   nothing imports them): its name is its identity, its files and columns
   are the layout's, its tables digest to what `band.json` says, and every
   block, transaction, link, tag and wallet row passes the judge.
2. **Its edges, against `core.db`.** The first height written must build on
   the block `core.db` holds below it (`previous_block`, and
   `hash_list_merkle` where the era lets it be computed), and the block
   `core.db` holds above the last height written must build on the band.
3. **A binding to the chain.** The block above, when `core.db` holds one
   (in `stable_blocks`, or, above them, `new_blocks`) and it may vouch: a
   block the gateway synced from its own nodes, or one an earlier import
   wrote bound `anchored` or `held` without accepting a gap
   (`--allow-unanchored`, `--allow-unbound`, `--allow-incomplete`,
   `--allow-unverified-format1`; each range's binding is recorded in the
   ledger). From the 2.0 fork the band's `hash_list_merkle` recurrence then
   binds every block hash, weave size and `tx_root` beneath it. Otherwise
   an anchor fetched with `--anchor-from` (as `index-l1-verify` does, at
   the band's top). With neither, the run is refused unless
   `--allow-unanchored`.
4. **The sample.** What the binding does not reach — transaction ids, their
   order, every transaction field, and block fields beyond the hash, weave
   size, `tx_root`, link and size — is checked by the same keyed sample of
   headers and signatures as `index-l1-verify` (`--sample-blocks`,
   `--sample-txs`, `--sample-format1`, from the `--anchor-from` sources).
   Without sources, with `--sample-txs 0`, or with `--sample-format1 0`
   over any format-1 transaction with data from the 2.0 fork (a witnessed
   root binds its size and root, never that it is format 1), the run
   is refused unless `--allow-unsampled`, and then that part is not
   checked against the chain. A sample that refutes the band refuses it
   ("the sample refutes the bands"); one that could not be read (too many
   draws unanswered in any band), or whose anchor no source answered,
   refuses it as `refusal: "unreadable"` — an outage, not evidence, and a
   later run tries again. Sources that resolve to fewer distinct machines
   than `--anchor-min` (never fewer than two) are refused before any band
   is read: they can neither refute nor attest.
5. **What nothing binds is refused unless accepted.** Blocks below the 2.0
   fork (`--allow-unbound`); blocks whose transactions or owners' keys the
   band lacks (`--allow-incomplete`); blocks holding a format-1
   transaction with data (`--allow-unverified-format1`). See
   [what the checks bind](#what-binds-what). An `l1-4` band's witnesses
   bind the first and last, so a whole chain of `l1-4` bands imports with
   **no `--allow-*` flag**. An `l1-3` band carries none, so every `l1-3`
   band below height 2,000,000 is still refused without these flags.

Each band's result carries what bound it (`boundBy`, `binding`), every flag
that accepted something (`accepted`), what is left `unbound` or `skipped`,
the sample, and the `assurance` text.

A band whose rows change after the check (bands live on a shared volume)
is still caught as it is written, against its digests. **A refused band
removes nothing that was there before.** Over heights that already held
rows (the gateway's own, a band imported before, a republished band), an
import writes the band as one transaction, so a failure rolls back to
exactly what was there, ledger row included; over empty heights, only the
rows this attempt committed are cleared, with its ledger row. A fill
writes only heights the gateway lacks, and refuses a range that holds rows
other than an unfinished earlier run's.

**Which bands are read.** The directory is listed explicitly, never
globbed. A directory with a readable `band.json` is a band. One without
(a retired copy, whose `band.json` the index-swarm sidecar removes first,
or a stray directory) is ignored. Two installed generations of one band
with the same tables are read once. Anything else — a `band.json` that
cannot be read or parsed, two generations with different tables, or a
directory not named for what it holds (`l1-h<from>-<to>-<tag>-<digest>`,
with the heights in its `band.json` and the first 12 hex digits of its
tables' digest) — refuses the run, named. A `--bands-dir` that is missing
or cannot be read is an error, never "nothing to import".

### While the gateway runs (`--fill`)

```bash
./tools/ar-io-node index-l1-import --fill \
  --bands-dir data/indexes/installed/parquet-l1 \
  --core-db data/sqlite/core.db
```

A fill writes only the heights `core.db` lacks at or below the top of
`stable_blocks` (before the gateway's first flush, just below its lowest
unflushed block). That is everything beneath what the block importer
writes itself, so nothing the gateway indexed is rewritten and nothing it
is about to write is touched. The one exception is a range an interrupted
import or fill left unfinished, which is cleared and written again whole. The same command covers a gateway that began
mid-chain, a hole in the middle of what a gateway holds, and a new gateway:
with `L1_BAND_IMPORT_ENABLED=true`, an empty `core.db` and no
`START_HEIGHT`, the block importer starts at the chain tip and the history
beneath it arrives from the bands.

It writes a batch of rows per transaction and pauses after each, so the
gateway's own writers, which wait up to 30 seconds for the lock, get in
between. That makes it slower than an import with the gateway stopped; in
return the gateway indexes and serves throughout. Each band is still
verified whole, as above, even when only part of it is written. Ranges are
filled from the top down, so each is bound by the block the gateway holds
above it: its own, or one the range above it just wrote and verified. The
run stops at the first range refused; `--max-bands` keeps the highest
ranges.

A band published before its range was fully mined (the publisher's tip
band) fills only as far as the blocks it holds. Heights no installed band
holds yet come back as `uncovered`: bands still downloading, and the
heights between the newest band and where a new gateway began, which the
publisher's next tip band holds, usually within a day.

Interrupting a fill is safe. Each range is recorded in the ledger before
its first row, and a range left unfinished is cleared and written again by
the next run, although its blocks are already there. The gateway's worker
runs a fill every `L1_BAND_IMPORT_INTERVAL_SECONDS` (default 600), so a run
that stops is retried and new bands are filled as they arrive; a run with
nothing to fill writes nothing to `core.db`. Its runs are counted in
`l1_band_import_runs_total{result}` (`filled`, `idle`, `failed`,
`deferred`, `unreadable`), with
`l1_band_import_rows_total` and `l1_band_import_uncovered_heights`. A run
that refuses a band, or cannot read the bands directory, counts as
`failed`. The one quiet case is a bands directory that was never created
(nothing installed yet): the worker does not run the fill, counts `idle`,
and logs why (a warning when the parent directory is missing too, or after
six runs). A refused fill is not re-verified every interval: the worker
waits, twice as long each time (up to a day), until the bands directory
changes, counting `deferred`. A fill refused only because its sources
could not be read is a warning, counted `unreadable`, and tried again after
an interval, twice as long each time it repeats (up to two hours), and at
once when the bands directory changes. The worker anchors and samples against
`L1_BAND_IMPORT_SAMPLE_FROM` (by default the trusted node and the trusted
gateways not marked `trusted: false`), and warns at its first run when
those resolve to fewer than two distinct machines, since then the sample
can refute and attest nothing. It passes `--allow-unbound --allow-unverified-format1` only with
`L1_BAND_IMPORT_ALLOW_UNVERIFIED=true` (never `--allow-incomplete`), and
`--allow-unsampled` only with `L1_BAND_IMPORT_ALLOW_UNSAMPLED=true`.

### With the gateway stopped

This is for a `core.db` the gateway has not run on yet: a new gateway's,
just migrated. The command refuses a `core.db` another writer holds rather
than racing it, and refuses one that holds unstable (`new_*`) blocks,
which an import would be written beneath. A gateway that has run always
holds some: it moves blocks to `stable_*` only once they are at least 18
deep.
So for a gateway that already runs, use `--fill`.

```bash
docker compose -f docker-compose.yaml -f docker-compose.override.yaml stop core
./tools/ar-io-node index-l1-import \
  --bands-dir data/indexes/installed/parquet-l1 \
  --core-db data/sqlite/core.db
docker compose -f docker-compose.yaml -f docker-compose.override.yaml up -d --no-deps core
```

Name every compose file you normally use: passing `-f` at all turns off
loading `docker-compose.override.yaml` automatically.

Every planned band is verified first, as one contiguous run anchored once
at its top; a plan that does not verify writes nothing. With an empty
`core.db` there is no block above to bind the bands, so give
`--anchor-from` (or accept `--allow-unanchored`). Bands are then imported
in height order, lowest first. The run stops at the first band that fails,
because bands must land as a contiguous run — the block importer rewinds
across a gap and gives up after 18 blocks. The bands imported before the
failure are kept and recorded, so running the command again carries on
from there; the band that failed is cleared.

**Filling in history beneath a gateway that began mid-chain** is
`--fill`'s job, with the gateway running. Stopped, the command would refuse
such a gateway's `core.db` for its unstable blocks. `--from` and `--to`
remain for a database with none, such as a copy whose `new_*` rows were
cleared: by default the run continues upward from the highest height it
holds, and these bound it instead:

```bash
# core.db holds 1,000,000 upward; fill in everything below it
./tools/ar-io-node index-l1-import --bands-dir ... --core-db ... --from 0 --to 999999
```

This is safe because a band clears and rewrites only its own height
range, so importing below what is held cannot disturb it. `--to` means a
backfill need not redo the part you already have. The run's own
contiguity is still enforced: a gap *inside* it is refused.

**Mind the hole.** A backfill done in stages leaves heights uncovered
between runs, and the block importer rewinds across a gap. The command works
out what will still be missing, from every run of heights `core.db` actually
holds rather than its lowest and highest, so a gap left *between* two
earlier backfills is seen. It warns, and carries the gaps in the result as
`holes`. It does not refuse — staged backfill would be impossible if
it did — so **check `holes` is empty before starting the gateway**.

Two things `--from` does not do. It will not redo a band the ledger
already records as imported, which is skipped as `already_imported`. And
it does not repair missing transactions *inside* heights you already
hold: `core.db` reaching the tip means nothing plans, whatever is missing
underneath.

| Option | |
|---|---|
| `--bands-dir` | A directory of bands: as the sidecar installs them (`<band id>~<generation>`), or as a publisher writes them (by band id). Of two generations of one band with the same tables, the newer is read. Required, and must be readable |
| `--core-db` | The gateway's `core.db`. Required |
| `--fill` | Fill only what `core.db` lacks beneath what the gateway writes itself, with the gateway running |
| `--from` | Start here instead of continuing above what `core.db` holds. With `--fill`, fill nothing below it |
| `--to` | Stop after the band covering this height. With `--fill`, fill nothing above it |
| `--max-bands` | Import at most this many bands, then stop. With `--fill`, at most this many ranges |
| `--cache-mib` | SQLite page cache for the import, in MiB (default 1024) |
| `--anchor-from` | Comma-separated sources to anchor the bands' top at, where `core.db` holds no block above them (as `index-l1-verify`) |
| `--anchor-min` | Distinct machines that must agree on that anchor (default and minimum 2) |
| `--allow-unanchored` | Import bands nothing binds to the chain (no block above, no anchor) |
| `--allow-unbound` | Import pre-2.0 blocks no witnessed fold binds (every one in an `l1-3` band) |
| `--allow-incomplete` | Import blocks whose transactions or owners' keys the band lacks |
| `--allow-unverified-format1` | Import blocks whose `tx_root` cannot be recomputed (a format-1 transaction with data and no witnessed v1 root: every one in an `l1-3` band) |
| `--allow-unsampled` | Import with no sample (no `--anchor-from`), or with `--sample-txs 0`, or with `--sample-format1 0` over any format-1 transaction with data from the 2.0 fork (witnessed or not: only the draw checks format 1) |
| `--sample-blocks`, `--sample-txs`, `--sample-format1`, `--seed`, `--concurrency` | The sample, as `index-l1-verify` |
| `--read-timeout` | Milliseconds each read from a source may take (default 30000) |
| `--spill-max` | The most the check's DuckDB may spill, as a DuckDB size (default 128GB) |
| `--spill-reserve-gb` | Space always left free beside `core.db` under the spill, in GB (default 100) |
| `--duckdb-threads <n>` | DuckDB's threads, 1 to 64 (default 1; DuckDB 1.4 can crash merging a spilled aggregate on more, [duckdb#23757](https://github.com/duckdb/duckdb/pull/23757)) |

The check's DuckDB spills to a folder of its own beside `core.db`
(`.duckdb-import-*`), capped at `--spill-max`, at 80% of the space free
there, and never into the last `--spill-reserve-gb`; it is removed when the
run ends, and a folder a killed run left is removed by a later run once
its heartbeat is a day old.

Running it again when there is nothing to do is a no-op: each band is
recorded in `parquet_l1_imports` as it lands, and a band already held is
skipped.

**Interruption is safe.** A band is written to the ledger before its first
row and completed after its last. Importing a band clears its height range
first, so a band a crash left part way is imported again over whatever it
managed to write. Progress is read from that ledger, not from
`stable_blocks`: a band writes all of its blocks long before its
transactions, so how far `stable_blocks` reaches says nothing about how
much of a band landed. Every write is idempotent, so a band imported twice
leaves `core.db` exactly as importing it once does.

**Before it starts** the command estimates the space the run needs: about
300 bytes per row, plus 4 GiB held back for the write-ahead log and for the
gateway afterwards. It refuses rather than running out of disk inside a
write transaction. If it refuses, free space or import in stages with
`--max-bands`.

**While a band lands** it logs `Importing a band` to stderr once a minute,
naming the table it is on and the rows it has written of the rows the band
holds. The largest bands take over half an hour, so this is how you tell a
slow import from a stuck one.

**Give it a page cache.** `--cache-mib` is the biggest lever on a long
import. A bootstrap spends its time maintaining indexes, and SQLite's own
default cache is 2 MB: once the indexes outgrow it, every insert becomes
random I/O and the rate falls as the database fills. With an 8 GiB cache a
full bootstrap keeps about four times the rate it falls to with the
default. Set it to whatever the host can spare.

**What to expect.** A single band into an empty database is fast: the
sparse first 100,000 heights take about 10 seconds, and the busiest about
half an hour. A full bootstrap is slower than that suggests, because the
rate falls as the database grows. The whole chain takes about 15 hours on
12 cores and leaves a `core.db` of about 120 GB, the same size as a gateway
that indexed the chain itself. Allow about 2 GB of WAL beside the database
while a band lands. `--max-bands` splits the import across several runs;
the ledger makes each one pick up where the last stopped.

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
and `refused` appears at the top level. A plan refused by the check before
writing reports one refused band (the plan's first) with the check's
reason, and nothing written. **A refused band fails the command**: the
bands below it are imported and kept, the refused one is cleared, the
result goes to stderr and the exit code is 1, so a script notices. Run it
again to carry on from what landed. A band the ledger records under the
same id but with a different digest (republished) is not held, and is
imported again, wherever its heights lie, and listed in `republished`.
`skipped` lists the bands the run had
no use for, each with a `reason`: `already_imported`,
`covered_by_a_wider_band` (a tip band inside a whole one),
`below_what_core_db_holds`, or `above_the_requested_range` (past `--to`).
`holes` appears only when heights are uncovered, read from the runs of
heights `core.db` holds when the run ends (so a band refused part way
shows), and is the one field to check before starting the gateway.

With `--fill`:

```json
{
  "coreDb": "data/sqlite/core.db",
  "bandsDir": "data/indexes/installed/parquet-l1",
  "mode": "fill",
  "ceiling": 2019421,
  "filled": 1,
  "rows": 3301442,
  "missingTransactions": 0,
  "uncovered": [],
  "ranges": [
    { "heightRange": [1900000, 1999999], "heights": [1900000, 1917899], "result": "imported", "rows": 3301442, "seconds": 1380 }
  ],
  "seconds": 1384.6
}
```

`ceiling` is the highest height the run could write, -1 when the gateway
holds no blocks yet. Each of `ranges` is one band's heights that were
missing: `heightRange` is the band's, `heights` what it wrote. `rows`
also counts every owner (`wallets`) row of the band: owners carry no
height, so each is written unless `core.db` already has it, and counted
either way. `uncovered` lists the heights at or below the ceiling that
`core.db` lacks and no installed band holds yet.
As without `--fill`, a refused range fails the command and carries
`reason`, with the result on stderr.

## `index-l1-verify`

Checks an L1 index against the chain: anchored at its top block, judged
block by block, and sampled where nothing else binds it. Read-only, so the
gateway can stay up. **It fails closed**: what it cannot bind is listed,
and fails the run unless an `--allow-*` flag accepts it.

Two views of the same index. `--core-db` is the **operator's**: does this
gateway's own database hold the chain? `--bands-dir` is the **consumer's**:
a directory of bands checked with no gateway and no database at all.
Anyone deciding whether to install someone else's bands — another
gateway, an analyst, an agent — can check them before importing a byte.
Given both, the command checks `core.db`. A set holding an `l1-1` band is
refused: that layout copied columns its publisher's gateway held (a
pre-fork `tx_root`, a format-1 `data_root`, the last `Content-Type`), which
no check can bind; rebuild it (`index-export` rebuilds `l1-1` bands once).
The importer refuses it the same way. Only bands carry
[witnesses](#what-binds-what) (`l1-4`): `--core-db` holds none, so there
every pre-2.0 block is `unbound.pre20` and every block holding a format-1
transaction with data `unbound.txRootFormat1`, as under `l1-3`.

```bash
# the consumer's view: no gateway involved
./tools/ar-io-node index-l1-verify --bands-dir data/indexes/installed/parquet-l1 \
  --publication https://<publisher gateway>/ar-io/indexes \
  --registry-url http://core:4000 \
  --anchor-from https://<gateway one>,https://<gateway two>

# the operator's view
./tools/ar-io-node index-l1-verify --core-db data/sqlite/core.db \
  --anchor-from https://<gateway one>,https://<gateway two>
```

Both views read rows into the **same** judge (`judge.ts`), over the same
chain rules (`chain.ts`), and a differential test runs the two over one
chain and requires the same verdicts and counts. The importer and the
exporter run that judge too, so a publisher and its consumers cannot drift
on what a right band is.

### What binds what

An index agreeing with itself proves nothing: a fabricated chain built by
Arweave's rules passes every self-check. What ties it to the real chain:

- **The anchor** (`--anchor-from`). The block at the top of the range is
  fetched (`/block/height/N`) from every source given. Names that resolve
  to a shared address count as one machine. At least `--anchor-min`
  machines (default 2) must serve it; each header's identity hash is
  recomputed from its own fields, for every era from the 2.0 fork; every
  source that answered must give the same hash; and the index's row must
  equal the header field by field (`indep_hash`, `previous_block`,
  `nonce`, `hash`, timestamp, difficulty, cumulative difficulty,
  `last_retarget`, `reward_addr`, `reward_pool`, `block_size`,
  `weave_size`, the USD rates, `hash_list_merkle`, `wallet_list`,
  `tx_root`), with its transaction ids in block order, from the links and
  from the transactions table. A header the command cannot recompute
  exactly — an unknown key (a later fork), an ECDSA or non-4096-bit
  `reward_key`, a non-empty double-signing proof or non-empty block tags,
  none of which any tested mainnet header carried — is a failure, never a
  pass. A range ending at 422,249 is anchored at the fork block, whose
  `previous_block` binds it. A range ending lower is anchored at its top
  when it ends at a pinned height (99,999, 199,999, 299,999, 399,999) and
  both of its witnessed folds reach the pins there (`anchor.pinned: true`,
  no header fetched): those pins fold on to block 422,250's
  `hash_list_merkle`, so a pre-2.0 band verifies and imports with no
  `--allow-unanchored`. A run whose folds stop short of a pin is not
  anchored. An anchor needs no source, but the block draw does: a run
  anchored this way with no `--anchor-from` fails `sample_blocks` unless
  `--allow-unsampled`, since the order of its blocks' transactions is
  checked by nothing else.
- **The `hash_list_merkle` recurrence.** From the 2.0 fork each block's
  `hash_list_merkle` folds the hash, weave size and `tx_root` of every
  block below it, so an anchored top binds those three for every post-2.0
  block in the range. The links then bind each `previous_block`, the weave
  each `block_size`, and a recomputed `tx_root` each block's transactions'
  data sizes and data roots (not their ids: `tx_root` drops them).
- **The sample.** Nothing above binds transaction ids, their order, any
  other transaction field, or any other block field. Checking them all
  means fetching every header (about 800 GB) or every signature (no index
  stores them), so the command draws a keyed uniform sample: headers of
  `--sample-blocks` blocks (default 1000) across the range, fetched by the
  index's own hash (`/block/hash/H`), recomputed, and compared field by
  field, by height and by transaction order. Below the 2.0 fork no header
  recomputes, so a drawn pre-2.0 block is fetched by height from every
  source and checked against the header `--anchor-min` distinct machines
  serve alike: **attested**, the sources' word rather than a proof, counted
  as `blocksAttested` (that is what binds a pre-2.0 block's transaction
  order, which its 2.0 hash does not); `--sample-txs` transactions per band
  (default 1000; per 100,000 heights of a `core.db`) drawn over the whole
  range, pre-2.0 included, each fetched (`/tx/{id}`) and checked against
  its signature over the segment rebuilt from the index's columns, the id
  as the signature's SHA-256; and `--sample-format1` format-1 transactions
  with data per band (default 200) drawn from the 2.0 fork, which catches a
  format-2 transaction relabelled format 1: to escape `tx_root` (no
  witness), or with its own data root as a witness, which `tx_root` passes. A draw whose owner key the index lacks is fetched all
  the same: a signature hashing to its id shows the id is real, and its
  fields, and the owner address the index holds (the SHA-256 of the owner
  each answer states, or of the key an ECDSA signature recovers), are then
  attested. A format-1 transaction with data is signed over its data,
  which every machine asked sends in full: one budget of 4 GB per band
  covers both transaction draws and counts every copy (a band of 1,000
  pre-2.0 draws measured about 1.22 GB at two copies). Past it a draw is
  left unverified (`txsOverBudget`, `format1OverBudget`, counted as
  unreadable), but its format and data size are still compared
  (`/tx/{id}/format`, `/tx/{id}/data_size`). ar.io gateways answer
  `/tx/{id}/format` with a 500, so against them that check is the size
  alone, and the draw's reason says which was compared. If every source
  says it has no such transaction, its block is asked, as below. A format-1
  transaction with more than 10 MiB of data was never valid and is refuted
  from the index alone. Refuted draws are counted as `txsRefuted` and
  `format1Refuted`, never as checked.

  RSA signatures are verified exactly as Arweave verifies them
  (`rsa_pss:verify/4`, and `verify_legacy/4` for blocks at or below the
  2.4 fork), not by OpenSSL, which is stricter: Arweave masks the bits
  above the modulus length and accepts a salt of any length, and real
  mined transactions rely on it.

  **What a signature proves.** For an RSA format-2 transaction (and a
  format-1 one with a denomination) the segment is a deep hash, so a
  verifying signature proves every field, from any one source. It does not
  for two kinds: an **ECDSA** transaction, whose owner is recovered from
  the signature, so some key verifies for any fields (the owner is checked
  to be the key the signature's recovery id gives); and a **format-1**
  transaction without a denomination, whose segment is a plain
  concatenation, so the boundaries between quantity and reward, anchor and
  tags, tag names and values are unsigned (the consensus rules that fix
  some of them — canonical decimals, target length, anchor length, data at
  most 10 MiB, no format 1 from 2,000,000 — are checked, each from the
  block the chain applies it: a block's transactions are validated with
  the height of the block below it). For those the fields must be the
  same from `--anchor-min` distinct machines (never fewer than two): such
  draws are counted as `txsAttested`, the sources' word, not a proof.

  **Verdicts.** A recomputed header, or a verifying signature, proves
  itself: one source decides. A refutation on a source's word — answers
  that do not verify, fields that differ — needs `--anchor-min` distinct
  machines saying so, and never fewer than two: a single lying source
  makes a draw unreadable, never a failure, and with sources that resolve
  to one machine the sample says so in `warnings`. Absence refutes only
  when every source was heard, none answered, and that many machines said
  404: one busy source may hold what the others lack. A 404 alone never
  refutes a format-1 transaction, because since Arweave be18c1be
  (2026-08-31) nodes deliberately hide some real format-1 transactions
  without a denomination from `GET /tx`; its block is asked instead. If
  the block, as the chain serves it (its header recomputed to the index's
  hash, or below the 2.0 fork the same transaction list from that many
  machines), does not list the id, the draw is refuted; so is it when no
  source has a block with the index's hash and that many machines agree
  the chain's block at that height is another (the index's block is not
  the chain's). If the block lists the id, or none of that can be had,
  the draw is unreadable. Only answers whose
  signature verified count toward agreement. More than 20% of any one kind
  of draw (blocks, transactions, format-1) unreadable in any one band
  fails the sample as unreadable, each kind and band listing its own
  unreadable draws. `sample.detects` says what a pass
  means: the share of forged rows that would have been caught with 95%
  probability, counting every unreadable draw as possibly forged (in the
  weakest band, for transactions). A forgery confined to fewer rows may
  pass. `--seed` repeats a run.

What two agreeing sources mean depends on who they are. Two ar.io gateways
both route `/block/` to their operators' chosen Arweave nodes, so their
agreement is those choices agreeing, not two independent nodes; two
gateways proxying one upstream count as two machines. A source that
redirects is not followed (it counts as unheard), so a redirect cannot make
one machine answer for two. The result names each source and the address
it was counted as.

**The witnesses** (`l1-4` bands; see
[index-publication.md](index-publication.md#witness-files)) bind the two
kinds of block the rest cannot:

- **A block holding a format-1 transaction with data.** Its `tx_root` leaf
  is the root of that transaction's data, which no header carries. The
  band's `witness_v1_data_roots` gives it; `tx_root` is recomputed with
  it: equal, and the block is bound like any other; unequal, and `tx_root`
  fails (never `unbound`). A row for anything but a format-1 transaction
  with data at its height, a repeated row, or a row out of order fails
  `witnesses`, and so does a format-1 transaction whose `data_root` column
  is not NULL (its root is the witness's; a column beside it would be
  imported and bound by nothing).
- **A block below the 2.0 fork.** Its identity hash cannot be recomputed:
  from the 1.6 fork it is a deep hash over its header fields and the full
  wallet list; below it, a SHA-384 over the header as JSON with the full
  hash list and wallet list; no header carries either list. Arweave's 2.0
  fork bound them instead through the 2.0 seed of `hash_list_merkle`: block
  422,250's is `block_index_to_merkle_root` over every pre-2.0 block's
  `[indep_hash, weave_size, transition tx_root]`, folded from height 0.
  The band's `witness_fork_2_0` gives each block's transition `tx_root`
  (recomputed from its transactions and their witnessed v1 roots, and
  required equal) and the fold after it (recomputed from the fold below,
  and required equal). The fold starts from empty at height 0, or from a
  fold pinned in this build at heights 99,999, 199,999, 299,999, 399,999
  and 422,249 (recomputed from Arweave's own 2.0 checkpoint by a test); a
  fold that reaches another value at a pin, or at block 422,250's
  `hash_list_merkle`, fails `hash_list_merkle`. That fold binds each block's
  hash, weave size and transition `tx_root` to the chain, and through the
  root its transactions' sizes and data roots. It does not bind the rest of
  the header (timestamp, difficulties, `last_retarget`, nonce, `hash`,
  reward address and pool, `wallet_list`) nor the transaction ids. Those are
  bound by the block's **2.0 hash** (`witness_fork_2_0.h2`): the 2.0–2.4
  identity-hash rule over the 1.0 header with its transition `tx_root` and
  sorted transaction ids, the hash Arweave lists for each pre-2.0 block in
  `genesis_data/hash_list_1_0` and checks every pre-2.0 header a node
  syncs against (`ar_header_sync`). Each is recomputed from the band's own
  fields and must equal the witness (`hash_list_1_0` fails otherwise), and
  their fold, `SHA-384(fold ‖ h2)` from empty at 0, must equal the fold of
  `hash_list_1_0` pinned at the same five heights (recomputed from the file
  by a test). These fields are **Arweave-checkpointed**: bound to the list
  Arweave ships, not to a hash the chain's own blocks reach. A run of
  pre-2.0 blocks is bound once **both** folds reach their pins (and every
  block's 2.0 hash recomputes); block 422,250's `hash_list_merkle` alone is
  not enough. Under `--skip-tx-root` such blocks are not counted in
  `foldBound`. Block 422,250's `hash_list_merkle` is checked against the
  fold through 422,249 whenever the range holds both, witnesses or not.

**Column by column**, for an `l1-4` band: what binds each column the
importer writes, by era. `chain`: a hash or root the chain commits to and
the verifier recomputes; `checkpoint`: a pre-2.0 block's 2.0 hash, folded
to Arweave's pinned `hash_list_1_0`; `signature`: the transaction's
signature, checked on the sample; `sample`: compared on sampled headers
only (below the 2.0 fork attested: the header `--anchor-min` machines
agree on, no header recomputing there); `canonical`: one value, or one
recomputed from the band, anything else fails; `none`: nothing checks it
(no column is). `src/lib/parquet-l1/column-bindings.ts` is the source, and its test
fails when this table, a column, or a binding drifts, or a column is
`none`; the result's `assurance` lists the `sample` and `signature`
columns.

<!-- column-bindings:start -->
| Column | pre-1.6 | 1.6–2.0 | 2.0–2.5 | 2.5+ | Why |
|---|---|---|---|---|---|
| `blocks.indep_hash` | `chain` | `chain` | `chain` | `chain` | below 2.0: in the 2.0 seed fold to FORK_2_0_FOLD_PINS (judge.ts stepFork20); from 2.0: in the hash_list_merkle recurrence to the anchored top (judge.ts, anchor.ts) |
| `blocks.height` | `chain` | `chain` | `chain` | `chain` | each block is judged at its height against the one below (contiguous); the folds and recurrence are positional |
| `blocks.previous_block` | `chain` | `chain` | `chain` | `chain` | equal to the chain-bound indep_hash of the block below (judge.ts 'linked'). Stored as: empty bytes at genesis, never NULL |
| `blocks.nonce` | `checkpoint` | `checkpoint` | `sample` | `sample` | below 2.0: in the block's 2.0 hash (judge.ts recomputeH2, folded to FORK_2_0_H2_PINS), and compared on sampled headers; from 2.0: not in hash_list_merkle, compared field by field on the anchor block and sampled headers (anchor.ts compareHeaderWithBlock) |
| `blocks.hash` | `checkpoint` | `checkpoint` | `sample` | `sample` | below 2.0: in the block's 2.0 hash (judge.ts recomputeH2, folded to FORK_2_0_H2_PINS), and compared on sampled headers; from 2.0: not in hash_list_merkle, compared field by field on the anchor block and sampled headers (anchor.ts compareHeaderWithBlock) |
| `blocks.block_timestamp` | `checkpoint` | `checkpoint` | `sample` | `sample` | below 2.0: in the block's 2.0 hash (judge.ts recomputeH2, folded to FORK_2_0_H2_PINS), and compared on sampled headers; from 2.0: not in hash_list_merkle, compared field by field on the anchor block and sampled headers (anchor.ts compareHeaderWithBlock) |
| `blocks.last_retarget` | `checkpoint` | `checkpoint` | `sample` | `sample` | below 2.0: in the block's 2.0 hash (judge.ts recomputeH2, folded to FORK_2_0_H2_PINS), and compared on sampled headers; from 2.0: not in hash_list_merkle, compared field by field on the anchor block and sampled headers (anchor.ts compareHeaderWithBlock) |
| `blocks.diff` | `checkpoint` | `checkpoint` | `sample` | `sample` | below 2.0: in the block's 2.0 hash (judge.ts recomputeH2, folded to FORK_2_0_H2_PINS), and compared on sampled headers; from 2.0: not in hash_list_merkle, compared field by field on the anchor block and sampled headers (anchor.ts compareHeaderWithBlock). Stored as: decimal text: N.0 below the 1.8 fork (a float, as gateways stored it), N from it; no leading zero |
| `blocks.cumulative_diff` | `checkpoint` | `checkpoint` | `sample` | `sample` | below 2.0: in the block's 2.0 hash (judge.ts recomputeH2, folded to FORK_2_0_H2_PINS), and compared on sampled headers; from 2.0: not in hash_list_merkle, compared field by field on the anchor block and sampled headers (anchor.ts compareHeaderWithBlock). Stored as: NULL below the 1.6 fork; N.0 below 1.8; N from it; no leading zero |
| `blocks.reward_addr` | `checkpoint` | `checkpoint` | `sample` | `sample` | below 2.0: in the block's 2.0 hash (judge.ts recomputeH2, folded to FORK_2_0_H2_PINS), and compared on sampled headers; from 2.0: not in hash_list_merkle, compared field by field on the anchor block and sampled headers (anchor.ts compareHeaderWithBlock). Stored as: the address, or empty bytes for unclaimed: never NULL nor the word |
| `blocks.reward_pool` | `checkpoint` | `checkpoint` | `sample` | `sample` | below 2.0: in the block's 2.0 hash (judge.ts recomputeH2, folded to FORK_2_0_H2_PINS), and compared on sampled headers; from 2.0: not in hash_list_merkle, compared field by field on the anchor block and sampled headers (anchor.ts compareHeaderWithBlock). Stored as: decimal text N, no leading zero |
| `blocks.wallet_list` | `checkpoint` | `checkpoint` | `sample` | `sample` | below 2.0: in the block's 2.0 hash (judge.ts recomputeH2, folded to FORK_2_0_H2_PINS), and compared on sampled headers; from 2.0: not in hash_list_merkle, compared field by field on the anchor block and sampled headers (anchor.ts compareHeaderWithBlock). Stored as: the digest, never NULL |
| `blocks.tx_count` | `chain` | `chain` | `chain` | `chain` | the number of links (judge.ts 'tx_count'), each a leaf of the recomputed (transition) tx_root |
| `blocks.block_size` | `chain` | `chain` | `chain` | `chain` | the growth of the chain-bound weave_size (judge.ts 'block_size') |
| `blocks.weave_size` | `chain` | `chain` | `chain` | `chain` | below 2.0: in the 2.0 seed fold; from 2.0: in the hash_list_merkle recurrence |
| `blocks.usd_to_ar_rate_dividend` | `canonical` | `canonical` | `canonical` | `sample` | below 2.5: NULL, no header carried it (judge.ts checkCanonicalBlock, 'canonical'); from 2.5: compared on the anchor block and sampled headers |
| `blocks.usd_to_ar_rate_divisor` | `canonical` | `canonical` | `canonical` | `sample` | below 2.5: NULL, no header carried it (judge.ts checkCanonicalBlock, 'canonical'); from 2.5: compared on the anchor block and sampled headers |
| `blocks.scheduled_usd_to_ar_rate_dividend` | `canonical` | `canonical` | `canonical` | `sample` | below 2.5: NULL, no header carried it (judge.ts checkCanonicalBlock, 'canonical'); from 2.5: compared on the anchor block and sampled headers |
| `blocks.scheduled_usd_to_ar_rate_divisor` | `canonical` | `canonical` | `canonical` | `sample` | below 2.5: NULL, no header carried it (judge.ts checkCanonicalBlock, 'canonical'); from 2.5: compared on the anchor block and sampled headers |
| `blocks.hash_list_merkle` | `canonical` | `chain` | `chain` | `chain` | below 1.6: empty (judge.ts 'hash_list_merkle'); from 1.6: the recurrence over the chain-bound hashes below (the 1.6 seed, then SHA-384 of the one below and its hash; from 2.0 the block-index fold). Stored as: NULL below the 1.6 fork, never empty bytes |
| `blocks.tx_root` | `canonical` | `canonical` | `chain` | `chain` | below 2.0: NULL in the band, the protocol had none; the import writes the witnessed transition root instead (fork_2_0.tx_root); from 2.0: recomputed from the block's transactions and in the recurrence. Stored as: NULL below the 2.0 fork; empty bytes for a block without transactions from it |
| `transactions.id` | `checkpoint` | `checkpoint` | `sample` | `sample` | equal to its link (judge.ts 'position'); below 2.0 the links' ids are in the 2.0 hash; from 2.0 tx_root drops ids, so they are compared on sampled headers and by sampled signatures |
| `transactions.block_transaction_index` | `sample` | `sample` | `sample` | `sample` | the link's position (judge.ts 'position'); no hash binds the order below 2.0 (the 2.0 hash sorts the ids), so on every era it is compared with sampled headers' txs (sample.ts; below 2.0 attested: the header --anchor-min machines agree on) |
| `transactions.is_data_item` | `canonical` | `canonical` | `canonical` | `canonical` | false (verify-bands.ts 'canonical'); not written to core.db |
| `transactions.target` | `signature` | `signature` | `signature` | `signature` | signed by the transaction, checked on the transaction sample (sample.ts judgeTx) |
| `transactions.quantity` | `signature` | `signature` | `signature` | `signature` | signed by the transaction, checked on the transaction sample (sample.ts judgeTx) |
| `transactions.reward` | `signature` | `signature` | `signature` | `signature` | signed by the transaction, checked on the transaction sample (sample.ts judgeTx) |
| `transactions.owner_address` | `signature` | `signature` | `signature` | `signature` | signed by the transaction, checked on the transaction sample (sample.ts judgeTx) |
| `transactions.anchor` | `signature` | `signature` | `signature` | `signature` | last_tx, signed by the transaction, checked on the transaction sample |
| `transactions.tag_count` | `signature` | `signature` | `signature` | `signature` | the number of its tag rows (judge.ts 'tag_count'), which are signed |
| `transactions.data_size` | `chain` | `chain` | `chain` | `chain` | a leaf of the recomputed (transition) tx_root, and the weave accounting |
| `transactions.data_root` (format 2) | `canonical` | `canonical` | `chain` | `chain` | its leaf in the recomputed tx_root; no format 2 below 2.0 (judge.ts 'nulls') |
| `transactions.data_root` (format 1) | `canonical` | `canonical` | `canonical` | `canonical` | NULL under l1-4: the root is witness_v1_data_roots', which tx_root checks (judge.ts checkCanonicalFormat1, 'witnesses') |
| `transactions.format` | `canonical` | `canonical` | `sample` | `sample` | below 2.0: 1 (judge.ts 'nulls'); from 2.0 only the format-1 draw shows a format-1 transaction is one (--sample-format1, refused at 0 without --allow-unsampled) |
| `transactions.height` | `chain` | `chain` | `chain` | `chain` | the height of its link (judge.ts 'position') |
| `transactions.content_type` | `canonical` | `canonical` | `canonical` | `canonical` | derived from tags: the first such tag by position, names compared without case, NULL without one (layout.ts firstTagValue), recomputed from the band's tags (judge.ts checkDerivedColumns, 'canonical'); the tags themselves are bound as their transaction is (signature, sampled) |
| `transactions.content_encoding` | `canonical` | `canonical` | `canonical` | `canonical` | derived from tags: the first such tag by position, names compared without case, NULL without one (layout.ts firstTagValue), recomputed from the band's tags (judge.ts checkDerivedColumns, 'canonical'); the tags themselves are bound as their transaction is (signature, sampled) |
| `transactions.offset` | `chain` | `chain` | `chain` | `chain` | NULL, or the weave offset its data ends at, recomputed from the chain-bound weave_size, block_size and the block's sizes in tx_root order with the 2.5 padding (judge.ts checkDerivedColumns, 'canonical'); NULL with no data and in the genesis block |
| `transactions.signature` | `checkpoint` | `checkpoint` | `sample` | `sample` | NULL, or one whose SHA-256 is the id (verify-bands.ts 'canonical'), so bound as the id is |
| `block_transactions.height` | `chain` | `chain` | `chain` | `chain` | the link's block, by height, its indep_hash chain-bound (judge.ts 'rows') |
| `block_transactions.block_transaction_index` | `sample` | `sample` | `sample` | `sample` | as transactions.block_transaction_index: compared with sampled headers' txs, below 2.0 attested |
| `block_transactions.transaction_id` | `checkpoint` | `checkpoint` | `sample` | `sample` | below 2.0: in the block's 2.0 hash (sorted); from 2.0 compared on sampled headers |
| `tags.height` | `chain` | `chain` | `chain` | `chain` | a transaction at that height (verify-bands.ts 'tags'), whose position it takes |
| `tags.id` | `checkpoint` | `checkpoint` | `sample` | `sample` | a transaction at that height, bound as its id is |
| `tags.tag_index` | `signature` | `signature` | `signature` | `signature` | signed by the transaction, checked on the transaction sample; indexed 0 to n-1 (judge.ts tag_count) |
| `tags.tag_name` | `signature` | `signature` | `signature` | `signature` | signed by the transaction, checked on the transaction sample; indexed 0 to n-1 (judge.ts tag_count) |
| `tags.tag_value` | `signature` | `signature` | `signature` | `signature` | signed by the transaction, checked on the transaction sample; indexed 0 to n-1 (judge.ts tag_count) |
| `tags.is_data_item` | `canonical` | `canonical` | `canonical` | `canonical` | false (verify-bands.ts 'canonical'); not written to core.db |
| `v1_data_roots.height` | `chain` | `chain` | `chain` | `chain` | a format-1 transaction with data at that height (witnesses.ts checkBandWitnesses) |
| `v1_data_roots.id` | `checkpoint` | `checkpoint` | `sample` | `sample` | that transaction, bound as its id is; every one of the band's has a row |
| `v1_data_roots.data_root` | `chain` | `chain` | `chain` | `chain` | its leaf in the recomputed (transition) tx_root (judge.ts checkTxRoot); the import writes it over any root the gateway kept (import.ts IMPORT_SQL.witnessDataRoot) |
| `fork_2_0.height` | `chain` | `chain` | `canonical` | `canonical` | one row per pre-2.0 height of the band, none from 2.0 (witnesses.ts checkBandWitnesses) |
| `fork_2_0.tx_root` | `chain` | `chain` | `canonical` | `canonical` | the transition tx_root, recomputed from the block's transactions and in the 2.0 seed fold to its pins (judge.ts stepFork20); the import writes it as the block's tx_root (import.ts IMPORT_SQL.witnessTxRoot) |
| `fork_2_0.fold` | `chain` | `chain` | `canonical` | `canonical` | recomputed from the fold below and the block, to the pins (judge.ts stepFork20) |
| `fork_2_0.h2` | `checkpoint` | `checkpoint` | `canonical` | `canonical` | recomputed from the block's fields, and folded to hash_list_1_0's pins (judge.ts recomputeH2) |
| `wallets.address` | `signature` | `signature` | `signature` | `signature` | the SHA-256 of the key (verify-bands.ts 'wallets'); the key is checked by sampled signatures |
| `wallets.public_modulus` | `signature` | `signature` | `signature` | `signature` | verifies the signatures of the transactions sampled |
<!-- column-bindings:end -->

**What nothing binds** is reported in `unbound`, by class, and fails the
run unless accepted:

- `pre20` — blocks below the 2.0 fork that the witnessed folds do not bind
  (`--allow-unbound`, which accepts this class only): every one in a band
  without witnesses (`l1-3` and older). In an `l1-4` band a block left
  unbound (no `witness_fork_2_0` row, a 2.0 hash that cannot be taken from
  its fields, folds that reach no pin) is listed here too, but also fails
  `witnesses`: the `--allow-*` flags accept unbound blocks of bands without
  witnesses only, never a stripped `l1-4` band's.
- `txRootFormat1` — blocks holding a format-1 transaction with data whose
  v1 data root no witness gives (`--allow-unverified-format1`): that leaf
  is the root of data the index does not store, so **every field of every
  transaction in such a block** is bound only by the sample (the format-1
  draw is what catches a transaction relabelled into the class). Under
  `l1-3` this is every such post-2.0 block: 208,812 of 1,604,083 in the
  published bands, the last at height 1,999,999. Under `l1-4`, only a
  transaction whose data no node serves, and such a band is published as
  `l1-3`; an `l1-4` band's block counted here also fails `witnesses`.
- `incomplete` — blocks the index holds only part of: a link whose
  transaction it lacks (so `tx_root` and the weave accounting cannot be
  checked), or a transaction whose owner's key it lacks (so its signature
  cannot be) (`--allow-incomplete`). An exporter publishes a tip band like
  this, counting what it lacks.

Without `--anchor-from` nothing outside the index vouches for it: the
result is `anchored: false`, `anchor` and `sample` are in `skipped`, and
the run fails unless `--allow-unanchored`. The `weave_accounting` check
(each block grew the weave by exactly its transactions' `data_size`, below
the offset where Arweave began padding data to a chunk) is self-consistency
on its own, and says so.

### The checks

| Check | |
|---|---|
| `identity` | Bands: each directory is named `l1-h<from>-<to>-<tag>-<digest>` in canonical decimals, its heights are its `band.json`'s, and its digest is its tables'; with `--publication`, its tag is the publisher's |
| `coverage` | Bands: they cover every height asked for, each band whole |
| `publication` | With `--publication`: every band is listed in the signed publication, every file with the size and SHA-256 signed, and every band it lists in the range is here |
| `files` | Bands: every entry is a readable band holding exactly its layout's files |
| `schema` | Bands: every Parquet file has exactly its layout's columns, in order, with its types |
| `tables` | Bands: each table's rows are in the table's order, inside the band's heights, and digest to what `band.json` says |
| `lookups` | Bands of `l1-3` and `l1-4`: each lookup file is in key order and holds exactly the rows its tables give and its `band.json` describes |
| `contiguous`, `linked` | Every height once; each `previous_block` is the hash below |
| `hash_list_merkle` | The recurrence in each era's form, the 1.6 seed folded from height 0 when the range starts there; the 2.0 seed against the fold through 422,249; a witnessed fold against each pinned fold it reaches |
| `block_size`, `weave_accounting` | Each block grew the weave by its `block_size`, and (below the padding threshold) by its transactions' `data_size` |
| `tx_root` | Recomputed from each post-2.0 block's transactions, with the 2.5 padding and the witnessed v1 data roots; below the 2.0 fork, the transition `tx_root` from each block's transactions against its witness |
| `witnesses` | Bands of `l1-4`: each witness file in its order, digesting to what `band.json` says, every row inside the band, well formed, and for a format-1 transaction with data at its height; each witnessed fold the fold of the block below and the block; no format-1 transaction with a `data_root` |
| `hash_list_1_0` | Bands of `l1-4`: each pre-2.0 block's 2.0 hash recomputes from its fields, ids and transition `tx_root` to its witness, and their fold reaches the pinned fold of Arweave's `hash_list_1_0` |
| `sample_format1` | Format-1 transactions with data from the 2.0 fork and none drawn (`--sample-format1 0`, every count 0, or no `--anchor-from`): fails unless `--allow-unsampled` (only the format-1 draw checks they are format 1) |
| `sample_blocks` | With sources, `--sample-blocks 0`; or anchored (by pinned folds) with no sample at all: fails unless `--allow-unsampled` (only the block draw checks transaction order and the header fields no hash carries) |
| `nulls` | Every key and commitment column is set: a NULL is a failure, never read as zero. Also format 1 or 2, and no format 2 below the 2.0 fork |
| `position`, `tx_count` | Each transaction sits at the link of its height and index, links run 0 to n-1, and `tx_count` is their number |
| `tag_count`, `owners`, `wallets` | Tags match `tag_count` and run 0 to n-1, every tag belongs to a transaction at its height (bands); every transaction has an owner, and one whose key the index lacks puts its block in `unbound.incomplete`; every wallet key hashes to its address (RSA and ECDSA alike) |
| `rows` | No transaction or link at a height without a block, and none outside the index's blocks |
| `anchor`, `sample`, `unbound` | As above |

With `--core-db`, whether every tag row belongs to a transaction is not
looked for (the tags table has no height index, and such a row is
unreachable by every reader); `tag_orphans` is in `skipped`.

### Which bands are read

The directory is listed explicitly; no band is read by a glob. A directory
with a readable `band.json` is a band, read by its own files' paths.
One without (a retired copy, whose `band.json` the index-swarm sidecar
unlinks first, or a stray directory), and any non-directory, is ignored,
listed in `ignored`, and never read. Two installed generations of one band
with the same tables are read once, the newer, and the other listed in
`duplicates`; with different tables they fail `files`. A `band.json` that
cannot be read or parsed fails `files`; a directory not named for what it
holds fails `identity`. Bands only partly inside `--from`/`--to` are
listed in `partial`, not checked, and fail `coverage`, as do heights asked
for that no band covers. A set that overlaps or leaves a hole is refused
outright. A `--bands-dir` that is missing or cannot be read is refused.

`--publication` binds the bands to the publication their publisher signed,
as [`index-l2-verify`](#index-l2-verify) does: the document's signature
against `--publisher-key` (or the key `--registry-url`'s registry names),
its expiry (`--allow-expired`), the one `parquet-l1` index it lists
(`--index` when it lists more), and every file's size and SHA-256. Without
it the result is `publisherBound: false` and `publication` is in
`skipped`.

Checking the lookups needs more than the 2 GB DuckDB is given, so it
spills to a folder of its own under the system temp directory (`TMPDIR`;
through `tools/ar-io-node`, `data/tmp/index-verify` on the node's data
disk, mounted at `/tmp`), removed when the run ends. The spill is capped at
`--spill-max` (default 128GB), at 80% of the space free there when the run
starts, and never into the last `--spill-reserve-gb` (default 100) of it;
with no room left under that the run is refused before it starts, unless
`--skip-lookups`. A folder a killed run left is removed by a later run once
its heartbeat is a day old.

| Option | |
|---|---|
| `--core-db` | The gateway's `core.db`, opened read-only. Required, unless `--bands-dir` is given |
| `--bands-dir` | A directory of bands to check instead, with no gateway and no database |
| `--from`, `--to` | The heights to check. Default: everything held |
| `--anchor-from` | Comma-separated Arweave nodes or gateways (`/block/height/N`, `/block/hash/H`, `/tx/{id}`) to anchor and sample from |
| `--anchor-min` | Distinct machines that must serve the anchor block, all with the same recomputed hash (default and minimum 2) |
| `--allow-unanchored` | Pass without an anchor, or with one that did not bind |
| `--allow-unbound` | Pass with pre-2.0 blocks no witnessed fold binds |
| `--allow-incomplete` | Pass with blocks whose transactions or owners' keys the index lacks |
| `--sample-format1` | Format-1 transactions with data per band drawn from the 2.0 fork (default 200; 0 to skip): what catches a format-2 transaction relabelled format 1, witnessed or not |
| `--allow-unverified-format1` | Pass with blocks whose `tx_root` needs a format-1 data root no witness gives |
| `--allow-unsampled` | Pass with `--sample-blocks 0`, or with no format-1 draw (`--sample-format1 0`, every count 0, or no `--anchor-from`) over format-1 transactions with data from the 2.0 fork |
| `--sample-blocks` | Blocks whose headers are sampled (default 1000; 0 to skip): recomputed from the 2.0 fork, attested by `--anchor-min` machines below it. Needs `--anchor-from` |
| `--sample-txs` | Transactions per band whose signatures are sampled (default 1000; 0 to skip). Needs `--anchor-from` |
| `--seed` | Seeds the samples (the result reports the seed drawn when none is given) |
| `--concurrency` | Sample fetches in flight (default 8) |
| `--read-timeout` | Milliseconds each read from a source may take (default 30000) |
| `--publication`, `--publisher-key`, `--registry-url`, `--index`, `--allow-expired` | With `--bands-dir`: bind the bands to their signed publication |
| `--skip-tx-root` | Leave out the `tx_root` recomputation, the one check that reads every transaction |
| `--skip-lookups` | With `--bands-dir`, leave out the lookup check |
| `--spill-max`, `--spill-reserve-gb` | Bound the lookup check's spill (above) |
| `--duckdb-threads <n>` | DuckDB's threads per database, 1 to 64 (default 1; DuckDB 1.4 can crash merging a spilled aggregate on more, [duckdb#23757](https://github.com/duckdb/duckdb/pull/23757)) |

`--skip-tx-root`, `--skip-lookups` and `--sample-blocks 0 --sample-txs 0`
are listed in `skipped` and, being asked for, in `accepted`.

### `index-l1-verify` result

One shape in both views:

```json
{
  "mode": "core-db",
  "coreDb": "data/sqlite/core.db",
  "ok": true,
  "heightRange": [1900000, 1999999],
  "blocks": 100000,
  "anchored": true,
  "anchor": {
    "height": 1999999,
    "indepHash": "…",
    "recomputed": true,
    "machines": 2,
    "sources": [
      { "url": "https://<gateway one>", "machine": "…", "indepHash": "…" },
      { "url": "https://<gateway two>", "machine": "…", "indepHash": "…" }
    ],
    "mismatches": [],
    "problems": []
  },
  "unbound": {
    "txRootFormat1": { "blocks": 101, "heights": [1900123, "…"], "reason": "…" }
  },
  "sample": {
    "seed": 7, "machines": 2, "confirm": 2,
    "blocksDrawn": 1000, "blocksChecked": 1000, "blocksAttested": 0, "blocksUnreadable": 0,
    "txsDrawn": 1000, "txsChecked": 997, "txsAttested": 3, "txsUnreadable": 0, "txsOverBudget": 0,
    "txsRefuted": 0, "format1Drawn": 200, "format1Checked": 200, "format1Refuted": 0, "format1Unreadable": 0, "format1OverBudget": 0,
    "empty": [], "warnings": [],
    "detects": ["…"]
  },
  "skipped": ["tag_orphans", "publication"],
  "accepted": ["--allow-unverified-format1"],
  "assurance": ["…"],
  "weaveSize": "…",
  "weaveGrowth": "…",
  "accountedFor": "…",
  "merkleChecked": 99999,
  "merkleSkipped": 1,
  "accountingChecked": 0,
  "accountingSkipped": 99999,
  "txRootChecked": 99899,
  "foldBound": 0,
  "checks": [{ "name": "contiguous", "ok": true, "detail": "…" }, "…"],
  "seconds": 1234.5
}
```

- `ok` is every check passing, with nothing left unaccepted: an unanchored
  run, and each `unbound` class, fail it unless their flag was given. An
  accepted gap is echoed in `accepted`, so a pass that rests on one says
  so. The checks it ran are in `checks`; those it did not, in `skipped`;
  what binds what, in words, in `assurance`.
- `anchored` is true only when the anchor bound (recomputed, agreed, equal
  to the index). `anchor` is present when a source was given and the range
  reaches the 2.0 fork (else the `anchor` check says why); its
  `sources` name each source, the address it was counted as, and the hash
  it served or why it gave none; `mismatches` are the fields of the index
  that differ from the chain's header; `problems` say why it did not bind.
- `unbound` holds a class only when it has blocks: `blocks`, the first 20
  `heights`, and the `reason`.
- `foldBound` is the number of pre-2.0 blocks a witnessed 2.0 seed fold
  binds (`l1-4` bands; always 0 with `--core-db`, which holds no
  witnesses).
- `weaveSize` is the weave size at the top of the range and `weaveGrowth`
  its growth over the range (from the block below the range when the index
  holds it). `accountedFor` is the transactions' sizes over the blocks
  whose accounting was checked (at or below the padding threshold, and not
  incomplete); it equals `weaveGrowth` only when every block was. All three
  are strings.
- A failing check carries `failures` (at most 20, each naming a height,
  what was found and what was expected) and `more` for the rest.

With `--bands-dir` the result has `mode: "bands-dir"`, `bandsDir`, the
number of `bands` and their `bandIds`, `partial`, `duplicates`, `ignored`
(each with its reason), `vanished`, `publisherBound`, `publication`
(with `--publication`: publisher, key, `keyFrom`, sequence, issue and
expiry, the index, the bands it lists that are `absent`, and the
`source`), and `lookupsChecked` and `lookupsSkipped`.

**When `ok` is false the command fails**: the same JSON goes to stderr
and the exit code is 1, so a script cannot read a broken or unbound index
as a good one. A request it cannot act on (a range the index does not
hold, a `--bands-dir` it cannot read, a set of bands that overlaps, a
publication that does not verify) is refused with an error instead.

## `index-l1-audit`

Checks the blocks [`index-l1-verify`](#index-l1-verify) reports as
`unbound.txRootFormat1`.

[`tx_root`](glossary.md#tx-root) does not prove transaction ids, and a
format-1 transaction's leaf is the root of **its data**, which an index
does not store. So a post-fork block holding a v1 transaction with data
cannot be checked from the index alone: 208,812 of the 1,604,083 post-fork
blocks in the published bands, the last at height 1,999,999. Ids are
bound by the block's header, which no index stores (`index-l1-verify`'s
sample fetches some), so this command checks each v1 id against the signature it must
be the SHA-256 of. That makes it a real transaction's id, without proving
the transaction was in this block.

This closes the gap by fetching that data, deriving each `data_root`, and
recomputing `tx_root`.

```bash
./tools/ar-io-node index-l1-audit --core-db data/sqlite/core.db \
  --data-from https://arweave.net --sample 200
```

| Option | |
|---|---|
| `--core-db` | The gateway's `core.db`. Opened read-only |
| `--data-from` | An Arweave node or gateway to fetch transaction data from. Required |
| `--sample` | How many blocks to audit (default 100) |
| `--from`, `--to` | Bound the height range |

**It samples rather than sweeps.** The full set is about 912,729
transactions and 111 GB; a few hundred blocks costs a few hundred requests
and bounds the error rate. Blocks are chosen at random, so a publisher
cannot know in advance which will be looked at.

**The data source does not have to be trusted**, and what makes that true
is that both halves are required. The data has to reproduce a `tx_root`
the block's identity hash commits to, **and** the signature has to hash
to the id the index holds. Forging either means a preimage, so a bad
source can cry wolf but cannot hide a fault.

Neither half is enough alone. `tx_root` does not bind ids, so in a block
holding one transaction — where the sort order cannot betray a changed
id — a source serving the original data under a tampered id would
reproduce `tx_root` exactly. That is why a missing signature is
`unavailable` and not a skip: a source must not be able to pass by
declining to answer.

It must still be the transaction's **own** data, which is why this reads
the `data` field of `/tx/{id}` and not the data route. `/raw/{id}` and
`/{id}` resolve *content*: a 1,614-byte transaction came back as an
8,847-byte SVG, with a 200. The fetched length is checked against
`data_size` and a disagreement is reported as `unavailable`, so a bad
source is never recorded as a bad index.

A sample of 1,000 blocks fetches about 550 MB and takes about 25 minutes.
With no mismatch it bounds the error rate at 0.3% (95% upper bound); the
cost of a tighter bound is roughly linear in the sample.

### `index-l1-audit` result

```json
{
  "coreDb": "data/sqlite/core.db",
  "heightRange": [422250, 2014815],
  "population": 208812,
  "sampled": 150,
  "matched": 150,
  "mismatched": 0,
  "unavailable": 0,
  "bytesFetched": 94600000,
  "errorRateUpperBound95": 0.02,
  "ok": true,
  "blocks": [
    { "height": 453548, "result": "match", "transactions": 1, "derived": 1, "bytesFetched": 1 }
  ]
}
```

`population` is how many blocks in range the index cannot check alone, and
`sampled` how many of them were. `blocks` lists **every** block that did
not match, and at most 20 that did (`matchesListed`), because the counts
carry the result and a thousand matches is tens of kilobytes nobody
reads. A block's `result` is `match`, `mismatch`
or `unavailable` (with a `reason`). **Any unavailable block fails the
run** and suppresses the rate: a source that withheld exactly the blocks
it had corrupted would otherwise hand back a clean-looking audit of
whatever it chose to serve. `errorRateUpperBound95` appears when nothing mismatched — it is the
rule of three, `3/n`, and says how little a clean sample rules out.
`mismatchRate` replaces it once something does. The command exits 1 on any
mismatch, and also when nothing could be audited, because a run that
checked nothing proves no more than not running it.

## `index-l2-verify`

Checks a directory of `parquet-l2` bands, one L2 index such as `ardrive-l2`,
as anyone holding them can: no gateway and no database, and, with the
on-chain sample, nothing trusted but the chain. Read-only. What each check
proves, and how to reproduce or repair a band that fails, is in
[index-verification.md](index-verification.md).

```bash
# a subscriber's installed copy, every check, bound to the publisher's signed
# publication (its key from the registry), 20 items per band from Arweave nodes
./tools/ar-io-node index-l2-verify --bands-dir data/indexes/installed/ardrive-l2 \
  --publication https://turbo-gateway.com/ar-io/indexes \
  --registry-url http://core:4000

# a publisher's settled bands, bound to its own publication, read through its
# own gateway for speed (trusted)
./tools/ar-io-node index-l2-verify --bands-dir data/indexes/published/ardrive-l2 \
  --publication data/indexes/published/publication.json \
  --publisher-key <observer address> --to 2014999 --gateway-url http://core:4000
```

| Option | Meaning |
| --- | --- |
| `--bands-dir <path>` | The index's bands: `data/indexes/installed/<index>` or `data/indexes/published/<index>`, as the node sees them (through `tools/ar-io-node`, under the node's own `data/indexes`, wherever that lives on the host). Required |
| `--publisher <wallet>` | The publisher's wallet: ids are then checked whole, its tag included |
| `--publication <path\|url>` | The publisher's signed publication: every band must be listed in it, with every file's size and SHA-256 as signed (`publication` check, `publisherBound: true`). Without it the bands are checked only for internal consistency |
| `--publisher-key <address>` | The key `--publication` must be signed with: the publisher's registered observer address (base58) |
| `--registry-url <url>` | Instead of `--publisher-key`, the gateway whose view of the registry (`/ar-io/peers`) gives the key, e.g. `http://core:4000`; that gateway is trusted for it. A registry that can't be read is refused as such ("could not read the registry"), apart from one that has no such publisher |
| `--index <name>` | The index to bind to, when the publication lists more than one `parquet-l2` index |
| `--l1-bands-dir <path>` | A `parquet-l1` index to find every root in (`mined`); every band must be covered. Without it, the node's own `installed/parquet-l1`, then `published/parquet-l1`, where they exist; `none` for none |
| `--onchain <n>` | Items per band read at their recorded locations and checked against their ids: drawn uniformly over every located item, then nested items added until half the draw is nested (20 when not given; `0` leaves the check out). The stated bound uses only the uniform draw |
| `--seed <n>` | Seeds that sample and the order it is read in, to repeat a run; the result reports the seed drawn when none is given |
| `--arweave-nodes <urls>` | The Arweave nodes those reads go to (comma-separated, or `default`, the default: the `tip` and `data` nodes) |
| `--allow-agreement` | Accept a root whose signature arweave-js won't verify when two other machines serve the same signed header (default: an error) |
| `--allow-unlocated` | Pass a band whose items all have no locations, as its `band.json` declares, so nothing of it can be read on chain (default: it fails `located` and `onchain`) |
| `--max-unlocated-share <fraction>` | The largest share of a band's items that may be unlocated (default `0.001`); its unlocated items must also be exactly what its `band.json` declares |
| `--allow-expired` | Bind to a `--publication` past its `expiresAt` (default: refused) |
| `--max-unchecked <n>` | Drawn items per band, nested additions included, that may stay unchecked (nodes busy, chunks unseeded, a root no node places) and the band still pass (default 0); past it, with none wrong, the band is inconclusive. When `--onchain` is above 0 it must be below `--onchain`; a band never passes with nothing verified, and `assurance` treats the allowed unchecked as possibly fabricated: with k allowed, the stated bound is the share p at which P(at most k of the N uniformly drawn items are fabricated) is 5% (N = 20: 14% for k = 0, 41% for k = 4). No drawn item is ever replaced by another draw |
| `--band-deadline <seconds>` | How long one band's on-chain reads may take (default 1200); items not read by then are unchecked |
| `--gateway-url <url>` | Read through this gateway instead: faster, but trusted, and nobody then says the roots are mined. Exclusive with `--arweave-nodes` |
| `--read-timeout <ms>` | How long each node, gateway or publication request may take (default 30000) |
| `--from <height>`, `--to <height>` | Check only the bands inside these heights; a band only partly inside is listed under `partial` |
| `--skip-lookups` | Leave out the lookup check, the slowest on large bands |
| `--spill-max <size>` | The most the lookup and consistency checks may spill (default `128GB`; never more than 80% of the space free under the temp directory, nor into its last 100 GB) |
| `--duckdb-threads <n>` | DuckDB's threads per database, 1 to 64 (default 1). More can be faster, but DuckDB 1.4, the newest the Node binding has, can crash (SIGSEGV) merging a large aggregate that spilled on more than one ([duckdb#23757](https://github.com/duckdb/duckdb/pull/23757)). The result is the same at any value |
| `--concurrency <n>` | How many DuckDB databases (`--duckdb-threads` threads, one unless asked, and 2 GB of memory each) check side by side: bands, and a band's tables and lookups, are read on them at once (default: a quarter of the CPUs, at most 4, at least 1; at most 16, and never more than `UV_THREADPOOL_SIZE` less 2, since each database holds a libuv thread while it reads and the on-chain reads' DNS lookups need threads too: an explicit value above that is refused. `tools/ar-io-node` sets `UV_THREADPOOL_SIZE=16` unless the shell sets it). Bands are started largest first. The databases share the spill cap: a read that derives a lookup reserves 20 bytes per byte of the tables it reads, the SQL checks 3 per byte of `data_items` and `tags`, before they start, and wait while that much isn't free; a read that runs out of its share runs again with all of it. The result is the same at any value, 1 included; at 1 the checks still run through the same pool and DuckDB digests, one database at a time, not the reader before `--concurrency` existed |

It reads every row of every table in file order, so memory stays flat (DuckDB
encodes and joins each range of rows as the row digest takes them, and the
ranges are hashed in order, so no row becomes a JavaScript object); the
large lookups spill to a folder of their own under the system temp directory
(`TMPDIR`; through `tools/ar-io-node`, `data/tmp/index-verify` beside the
node's `data/indexes`), capped at `--spill-max`, at 80% of the space free
there and at that space less 100 GB, and removed when the run ends or is
interrupted. A run whose largest band is expected to spill more than the cap
is refused before it starts, `--skip-lookups` or not (the table checks spill
too), so with less than about 100 GB free every run is refused; point
`TMPDIR` at a disk with room. A run killed outright (SIGKILL) leaves its
`ar-io-node-l2-verify-*` folder behind; the next run removes it once its
`.heartbeat` file is a day old, and leaves alone a folder another run is still
beating.

### `index-l2-verify` result

```json
{
  "bandsDir": "data/indexes/installed/ardrive-l2",
  "selection": "{\"kind\":\"ans104-data-items\",\"tag\":{\"name\":\"App-Name\",\"valuePrefix\":\"ArDrive\",\"excludeValuePrefix\":\"ArDriver\"}}",
  "bands": 23,
  "heightRange": [0, 2014999],
  "items": 127729745,
  "ok": false,
  "publisherBound": true,
  "skipped": [],
  "assurance": [
    "bound to publication https://turbo-gateway.com/ar-io/indexes (sequence 157), signed by <observer address>",
    "roots found in the L1 index at data/indexes/installed/parquet-l1, which index-l1-verify must have checked for this to trust nothing",
    "sampled roots placed in a block at their items' height by two or more machines (by address); their position in the block is not checked",
    "on chain, 20 located items drawn uniformly per band, none replaced: a band in which 14% or more of the located items are fabricated would have been caught with 95% probability; smaller fractions may not be (unlocated items are not checked on chain at all)"
  ],
  "checks": [
    { "name": "identity", "ok": true, "detail": "each band's id names its heights, its publisher's tag and the digest of its heights, selection and rows: internal consistency, not a signature" },
    { "name": "parents", "ok": false, "detail": "items directly in a root sit at offset 0; items in a nested bundle name one described in parents, whose payload starts where the item says",
      "failures": [{ "height": 1300000, "found": "l2-h1300000-1399999-3078e8b8-3f379144c94a: 28 items in a nested bundle that parents does not describe there", "expected": "0" }] }
  ],
  "publication": { "publisher": "<wallet>", "keyId": "<observer address>", "keyFrom": "the registry at http://core:4000", "sequence": 157, "issuedAt": "2026-10-20T00:00:00.000Z", "expiresAt": "2026-10-21T00:00:00.000Z", "expired": false, "index": "ardrive-l2", "bound": true, "absent": [], "source": "https://turbo-gateway.com/ar-io/indexes" },
  "located": [{ "id": "l2-h1300000-1399999-3078e8b8-3f379144c94a", "items": 6760000, "unlocated": 2396, "declared": 2396, "share": 0.00035 }],
  "mined": { "l1BandsDir": "data/indexes/installed/parquet-l1", "checks": { "height": true, "position": true }, "checked": 23, "uncovered": [] },
  "superseded": [],
  "partial": [],
  "vanished": [],
  "onchain": {
    "perBand": 20, "drawn": 460, "ok": 460, "wrong": 0, "missing": 0, "unchecked": 0,
    "failedBands": [], "inconclusiveBands": [], "unlocatedBands": [], "seed": 408427327,
    "bands": [{ "id": "l2-h0-99999-3078e8b8-2af284ed33de", "located": 1200, "locatedShare": 0.98, "drawn": 20, "ok": 20, "wrong": 0, "missing": 0, "unchecked": 0, "uncheckedReasons": {}, "errorSample": [], "inconclusive": false, "passed": true, "reasons": [] }],
    "roots": { "from": "arweave-nodes", "proven": true, "allowAgreement": false, "roots": 420, "bySignature": 420, "byAgreement": 0, "minedByNodes": 420, "minedVia": "node-status", "checks": { "height": true, "position": false }, "chunksProven": 461, "reachableNodes": 21 }
  },
  "spill": { "capBytes": 128000000000, "freeBytes": 900000000000 },
  "seconds": 6670
}
```

Checks are `identity`, `publication` (with `--publication`), `coverage`,
`selection`, `files`, `schema`, `tables`, `required`, `locations`,
`parents`, `consistency`, `selected`, `located`, `lookups` (unless skipped), `mined` (with an L1
index), `onchain` (unless `--onchain 0`) and `complete`. Each failure names
the band it was found in and the height that band starts at; at most 20 are
listed per check, the rest counted in `more`. `ok` is true when every check
that ran passed; `skipped` names those that did not run (`lookups`,
`onchain`, `publication`, `mined`), so a script must read both:
`ok: true` with `publisherBound: false` says the bands agree with themselves,
not who published them. When an L1 index covers only some bands, `skipped` still
lists `mined` and `minedPartial` names the bands it left out
(`{ "bands": [...], "count": n }`, at most 50 listed). A band with none wrong
but more unchecked items than `--max-unchecked` is listed in
`onchain.inconclusiveBands` and fails `onchain` with its own reason, as is
one with nothing verified at all. `onchain.bands` gives each band's located
share, how many items were drawn (`drawn`, of them `drawnUniform` over
every located item, the rest nested items on top), and how each ended.

## `index-l2-import`

Loads verified `parquet-l2` bands, one L2 index such as `ardrive-l2`, into
this gateway's index, so its GraphQL answers for their data items without
unbundling them. `--target clickhouse` is the only target so far: it queues
the rows this gateway's ClickHouse lacks for `clickhouse-auto-import` to
load. The gateway runs it itself when `L2_BAND_IMPORT_ENABLED=true` (see
[envs.md](envs.md)); run it by hand to import now, or to undo an import.

```bash
# queue the newest bands ClickHouse lacks, each verified first
./tools/ar-io-node index-l2-import --target clickhouse \
  --bands-dir data/indexes/installed/ardrive-l2 \
  --publication https://turbo-gateway.com/ar-io/indexes \
  --registry-url http://core:4000

# undo one band's import
./tools/ar-io-node index-l2-import --target clickhouse \
  --bands-dir data/indexes/installed/ardrive-l2 \
  --forget l2-h1900000-1999999-3078e8b8-10ec39700bc0
```

What a run does, band by band, newest first:

1. **Verifies the band**, as `index-l2-verify` does with the same options,
   lookups aside: bound to `--publication` (required), every root found in
   the L1 index (`--l1-bands-dir`, or the node's own `installed/parquet-l1`
   or `published/parquet-l1`; required), and `--onchain` items read from
   Arweave nodes (`0` is refused; `--gateway-url` is not offered, since a
   gateway would be trusted). A band that fails any check, or that this
   gateway's own wallet (`AR_IO_WALLET`) published, is refused and nothing
   of it is written. The other bands are still tried; the run then exits 1
   with what it queued, `refused` naming each band refused and why,
   `refusals` giving each one's failed checks, and `refusal` saying whether
   every refusal was only an on-chain sample that could not be read
   (`unreadable`: an outage, tried again later) or something failed
   (`refused`).
2. **Keeps one placement per item.** A band holds a row per place an item
   sits; the gateway's index holds one. A located place is kept before an
   unlocated one, then the first in chain order (height, block index,
   `root_parent_offset`, `offset`). An item no band row locates is kept with
   zeros for its location, which ClickHouse reads as unknown; it is found by
   GraphQL and never used to fetch data.
3. **Leaves alone what ClickHouse holds** (first writer wins).
   `transactions` keeps the newest row of a key, so a band row at a key the
   gateway already holds would replace the gateway's row. That is prevented
   where it cannot race: when auto-import loads a job, it inserts only rows
   whose key `transactions` lacks then, and whose item it does not hold
   within 1,000 heights at any key (`CLICKHOUSE_IMPORT_KEEP_EXISTING=true`),
   so an item the gateway exported after the job was written keeps the
   gateway's row, and gets no second placement. Before writing, the job is also trimmed, which is what the counts
   report: each 10,000-height window's
   ids are sent to ClickHouse (as external data) and the rows it holds for
   them, 1,000 heights either side, come back: an item held at the same key
   is left out (`present`), and counted `conflicting` when its root, parent,
   owner, size or location differ, with up to five example ids in a warning;
   an item held at another height nearby is left out too (`elsewhere`), the
   same item in another bundle. An item the gateway holds further away is
   written again, at its first placement: a second true row for it.
4. **Writes nothing above ClickHouse's top height**, where the gateway's
   own export has not yet been. The rest of a band waits for a later run
   (`aboveCeiling`); the ledger records how far each band went.
5. **Queues a job** in the Parquet exporter's layout under
   `--jobs-dir/queue/<band>.<time>`, assembled in `--jobs-dir/.partial` and
   renamed in whole. Every row carries the band's `createdAt` as `indexed_at`,
   so the same band always writes the same rows. `clickhouse-auto-import`
   loads queued jobs one at a time with `clickhouse-import`, between its own
   batches, then moves each to `done/` or, after
   `CLICKHOUSE_AUTO_IMPORT_L2_MAX_ATTEMPTS` failures, to `failed/`, keeping
   only `job.json` and `written.parquet` (the ids written). The next run
   reads that back into the ledger (`loaded`, `failed`). A run that finds a
   job failed writes nothing and exits 1, so the gateway's worker waits,
   twice as long each time, before writing the band again.

The ledger is `parquet_l2_imports` in `bundles.db`, one row per band and
target: what was written and left out, the allow flags the band was
accepted with, and when it was queued and loaded. A band whose id and
digest the ledger holds as loaded up to the ceiling is not read again, so a
run with nothing to do reads the bands directory, the ledger and
ClickHouse's top height, and writes nothing. A republished band has a new
id, and is checked and imported again; only its new items are written.

No job is written over the heights of a job still in the queue (a band and
its republished replacement, say): it would be built before the other
loads, could list the same items, and `--forget` on it would then take the
other's rows. Such a band is listed in `behindQueued` and written once the
queued job has loaded.

Runs take a lock (`--jobs-dir/.l2-import.lock`, held by the kernel, so
across containers and released however a run ends): a second run is
refused while one is going. Holding it, a run first removes what an
interrupted run left (`.partial/` and its scratch folders).

`--forget <band>` removes what imports of a band wrote: the ids in the
`written.parquet` of every job written for it, loaded (`done/`) or failed
after some partitions loaded (`failed/`), within their heights and with the
band's `indexed_at`. Rows the gateway wrote itself carry its own
`indexed_at`, and loading never replaced one (step 3), so they are not
touched. `transactions` has a projection, so this is a ClickHouse mutation
(`ALTER TABLE ... DELETE`, waited for) that rewrites the parts holding the
band's rows: heavy, meant for undoing an import. It is refused while a job
of the band waits in the queue. The ledger row goes, and the jobs move to
`forgotten/`; a later run imports the band again unless it is removed from
the bands directory.

| Option | Meaning |
| --- | --- |
| `--target clickhouse` | Where to import. Required; `sqlite` is not built yet |
| `--bands-dir <path>` | The index's installed bands, `data/indexes/installed/<index>`. Its name is the index's name in the ledger. Required |
| `--bundles-db <path>` | The `bundles.db` holding the ledger, written beside the running gateway (default `data/sqlite/bundles.db`) |
| `--core-db <path>` | The gateway's `core.db`, read-only: the block of every height an item is written at comes from `stable_blocks` (default `data/sqlite/core.db`). A height it lacks is refused, since `clickhouse-import` would drop its items silently |
| `--jobs-dir <path>` | Where jobs are queued, mounted in core and `clickhouse-auto-import` alike (default `data/etl/staging/l2-import`, under `ETL_STAGING_PATH`) |
| `--tmp-dir <path>` | Where DuckDB spills and scratch files go (default `data/tmp`, the gateway's temp volume rather than the container's own disk) |
| `--max-bands <n>` | Write jobs for at most this many bands (default: as many as the queue has room for) |
| `--max-queued <n>` | Write no job while this many wait in the queue (default 2) |
| `--forget <band>` | Remove an import's rows, as above |
| `--publication`, `--publisher-key`, `--registry-url`, `--index`, `--l1-bands-dir`, `--onchain`, `--seed`, `--arweave-nodes`, `--read-timeout`, `--allow-agreement`, `--allow-unlocated`, `--max-unlocated-share`, `--max-unchecked`, `--allow-expired`, `--band-deadline`, `--spill-max`, `--duckdb-threads` | As for `index-l2-verify`. The allow flags a band was accepted with are recorded in the ledger |

ClickHouse is reached as the gateway reaches it, through `CLICKHOUSE_URL`,
`CLICKHOUSE_USER` and `CLICKHOUSE_PASSWORD`; every read runs with
`readonly = 2` and the bounds the census uses.

### `index-l2-import` result

```json
{
  "bandsDir": "data/indexes/installed/ardrive-l2",
  "index": "ardrive-l2",
  "target": "clickhouse",
  "ceiling": 2029000,
  "bands": 45,
  "done": 43,
  "waiting": 0,
  "pending": 2,
  "aboveCeiling": [],
  "loaded": [],
  "failed": [],
  "imported": 1,
  "jobs": [
    {
      "band": "l2-h1900000-1999999-3078e8b8-10ec39700bc0",
      "job": "l2-h1900000-1999999-3078e8b8-10ec39700bc0.20261027T180754Z",
      "heightRange": [1900000, 1999999],
      "partitions": ["height=1900000-1909999", "height=1910000-1919999"],
      "counts": {
        "bandRows": 3183150, "otherPlacements": 6069, "aboveCeiling": 0,
        "present": 0, "conflicting": 0, "elsewhere": 0,
        "written": 3177081, "unlocated": 0, "tags": 23245827, "blocks": 15397
      },
      "conflictExamples": []
    }
  ],
  "seconds": 127.8
}
```

A job also carries `version`, `kind`, `bandId`, `bandDigest`, `index`,
`publisher`, `indexedAt` and `createdAt`, as its `job.json` does. A band
with nothing left to write has `"job": null` and its counts. `pending`
counts the bands still to import, this run's included; `waiting` the bands
whose jobs are queued; `behindQueued` the bands waiting for a queued job
over their heights. A run with a refusal prints its result on stderr
with `refused`, `refusal` and `refusals` (each band's failed `checks` and
on-chain sample). `--forget`
prints `{ "forgotten", "jobs", "indexedAt", "ids", "matched",
"heightRange" }`: `matched` is the rows ClickHouse held for those ids before
the delete.

## `index-census`

Checks that this gateway's ClickHouse holds every data item its bundle
indexer says it indexed. Read-only on `bundles.db` and ClickHouse, so the
gateway can stay up.

The indexer unbundles into SQLite, and the ClickHouse import exports the
stable rows and then prunes them from SQLite. Nothing afterwards checks
that the rows arrived. A row pruned without being exported is gone from
both, the bundle stays fully indexed so nothing retries it, and every index
built from ClickHouse, along with every gateway subscribed to one, silently
lacks the item. The first gateway this ran on was missing 1.4 million items
from bundles unbundled over two months, none of which any other check had
noticed.

```bash
# the whole index above a height, short roots written for re-queuing
./tools/ar-io-node index-census --from 1778191 \
  --output data/indexes/census/short-roots.tsv

# re-check roots after re-queuing them
./tools/ar-io-node index-census --roots data/indexes/census/requeued.txt
```

| Option | Meaning |
| --- | --- |
| `--bundles-db <path>` | The indexer's `bundles.db`, opened read-only (default `data/sqlite/bundles.db`) |
| `--from <height>`, `--to <height>` | Check only roots in these heights (default: everything up to the top ClickHouse holds). Short roots with no L1 row in ClickHouse are reported only without a range |
| `--roots <path>` | Check only these root transactions, one id per line or the first column of a TSV (`-` reads stdin). Each is checked item by item, complete or not |
| `--output <path>` | Write each short root as a TSV line; with `--force`, replace an existing file |
| `--bucket <blocks>` | Height bucket for `missingByHeight` (default 100000) |

It needs ClickHouse's `transaction_ids` table backfilled (see
`src/database/clickhouse/schema.sql`), which the census uses to look items
up by id.

**How it decides.** Stage 1 compares, per root transaction, the indexer's
matched item count (summed over the root's bundles, nested ones included)
with the distinct ids ClickHouse holds under that root, a window of heights
at a time. Roots with a bundle still being unbundled are left out. Stage 2
takes only the roots that came up short and looks up every item id
`bundle_data_items` lists for them, which the indexer keeps when it prunes the
item rows. Each item is then one of:

| State | Meaning | What to do |
| --- | --- | --- |
| `here` | In `transactions` under this root | Nothing |
| `elsewhere` | In `transactions` under another root only. An item in two bundles is stored once, under the first flushed, so the second bundle only *looks* short | Nothing |
| `expired` | In `transaction_ids` but not `transactions`: imported, then removed (by the TTL rules, unless you removed it yourself). `transaction_ids` has no TTL | Nothing, if your TTL rules meant it |
| `missing` | In neither: never imported | Re-queue the bundle: `POST /ar-io/admin/queue-bundle` |

A root's `class` is its worst item: `missing`, else `expired`, else
`duplicate`, else `complete` (the indexer's count was high), or `unlisted`
when `bundles.db` lists no items for it. Re-queuing is safe to repeat: the
SQLite flush ignores rows it already has and ClickHouse keeps one row per
key. Re-queue just after an import cycle finishes, then run the census again
with `--roots` after the next cycle to confirm.

It reads `transactions` in windows of 10,000 heights and ids in chunks of
1,000, with the same low priority and memory caps as `index-band-export`.
On a gateway with 240 million ClickHouse rows, the 250,000 heights above
1,778,191 took nine minutes.

### `index-census` result

```json
{
  "bundlesDb": "data/sqlite/bundles.db",
  "output": "data/indexes/census/short-roots.tsv",
  "heightRange": [1778191, 2025573],
  "roots": {
    "indexed": 820805, "checked": 119618, "notIndexed": 0, "inProgress": 24147,
    "outOfRange": 701187, "complete": 104761, "short": 14857,
    "byClass": { "missing": 7713, "expired": 0, "duplicate": 7144, "complete": 1, "unlisted": 0 },
    "withoutL1Row": 0
  },
  "items": { "expected": 48742937, "here": 47315652, "elsewhere": 14392, "expired": 0, "missing": 1412891 },
  "missingByHeight": { "1800000": 96581, "1900000": 1316308, "2000000": 2 },
  "stalledBundles": { "topLevel": 16896, "nested": 28611 },
  "seconds": 525.7
}
```

`roots.complete` counts the short roots stage 2 found complete as well as the
roots stage 1 never flagged, so `complete + short = checked`. `roots.inProgress`
counts roots with a bundle not fully indexed across the whole `bundles.db` (or
the `--roots` list), not just the height range; bundles that will never
unbundle keep their root there permanently. `stalledBundles`
counts bundles that were queued but never unbundled and haven't been queued
again for a day: most are not bundles at all (data tagged `Bundle-Format`,
ANS-102 JSON bundles) or their data is unavailable. It counts them; it does
not judge them. The TSV has the columns `root`, `height`, `expected`,
`held_under_root`, `listed`, `here`, `elsewhere`, `expired`, `missing` and
`class`. The roots to re-queue are those of class `missing`:

```bash
awk -F'\t' '$10 == "missing" { print $1 }' short-roots.tsv
```

## For scripts and agents

Every `ar-io-node` command is non-interactive and answers in one shape, so a
script or an agent can drive it without parsing prose.

### The contract

| | Success | Failure |
| --- | --- | --- |
| Exit code | `0` | `1` (`130` when interrupted with Ctrl-C) |
| stdout | Exactly one JSON value, the command's result, written in full before the process exits | Empty |
| stderr | Log lines (`info:`, `warn:`) only | Log lines, then either one line of error text, or the result as JSON: for a band refused by the header check, a band or range `index-l1-import` refused, a failed `index-l1-verify`, `index-l2-verify` or `index-l1-audit` |

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
  `--gateway-url` during the header check, `index-band-verify
  --arweave-nodes` and `index-l2-verify`'s reads of root transactions from
  Arweave nodes (`/tx`, `/tx/<id>/status`, `/tx/<id>/offset`,
  `/chunk/<offset>`; through a gateway's `/raw` with `--gateway-url`
  instead; none with `--onchain 0`), `index-l2-verify --publication <url>`'s
  fetch of the publication and `--registry-url`'s read of `/ar-io/peers`,
  `index-band-export`'s reads from the ClickHouse it is given,
  `index-l1-verify --anchor-from`'s header and signature fetches
  (`/block/height/<n>`, `/block/hash/<h>`, `/tx/<id>`), `index-l1-verify
  --publication <url>`'s fetch of the publication, `index-l1-import
  --anchor-from`'s header fetches, and `index-l1-audit --data-from`'s transaction data
  fetches. Band commands make no Solana RPC calls.

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
    "errors": [{ "id": "…", "error": "timeout of 30000ms exceeded" }],
    "poolSize": 1500,
    "unreadable": 0,
    "unreadableShare": 0
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

`{ "bandDir", "passed", "reasons", "totalRecords", "checked", "ok", "wrong", "errors", "poolSize", "unreadable", "unreadableShare" }`.
`checked` counts the entries read. `wrong` lists entries whose header
doesn't match (`id`, `reason`); `errors` lists entries the gateway couldn't
serve (`id`, `error`), which count against the 80% pass ratio but are not
evidence the band is wrong. `unreadable` counts the entries passed over
because the gateway doesn't have their root (404), out of `poolSize`
candidates, and `unreadableShare` is their share of those tried; with some,
`unreadableSample` lists up to 20 (`id`, `rootTxId`). Exit `1`, with the
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
fetch them from the network itself can time out on many of them. The band is
then refused for being under 80% checked, not for being wrong; the reason
says how many couldn't be read, and why. Use a gateway that already
holds the roots, typically the one whose index produced the records, or
`https://turbo-gateway.com`; or raise `--read-timeout`. With 4,000 recent
records on a gateway without those roots cached:

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
