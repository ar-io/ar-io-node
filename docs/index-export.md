# Index export: building bands

The `index-export` service builds the bands a gateway publishes through
[Index Sharing](index-swarm.md). It runs the core image in the compose
profile `index-export`, reads this gateway's own index, and writes finished
bands under `data/indexes/published/<index>/`. The `index-swarm` sidecar
then signs and offers whatever it finds there. It builds two kinds of band:

- **root-TX bands** (`cdb64-root-tx`), from ClickHouse or `bundles.db`;
- **L1 bands** (`parquet-l1`), from `core.db`.

`INDEX_EXPORT_KINDS` chooses which (default `root-tx-index`; add
`parquet-l1` for L1 bands). For the format of each band and how a reader
uses it, see [index-publication.md](index-publication.md).

```mermaid
flowchart LR
  core[("core.db")]
  ch[("ClickHouse or<br/>bundles.db")]
  overlay[("overlay CSV")]
  export["index-export"]
  pub[("published/&lt;index&gt;/")]
  sidecar["index-swarm sidecar"]
  subs(("subscribers"))
  readers(("Parquet readers"))

  core -->|"L1 rows"| export
  ch -->|"root-TX records"| export
  overlay -.->|"a bundler's offsets"| export
  export -->|"checked bands"| pub
  pub -->|"band files"| sidecar
  sidecar -->|"signed publication,<br/>bands over HTTP and BitTorrent"| subs
  pub -.->|"range reads via the gateway"| readers
```

## Contents

- [What it builds](#what-it-builds)
- [Where records come from](#where-records-come-from)
- [Checks before publishing](#checks-before-publishing)
- [Running it](#running-it)
- [Grid layout](#grid-layout)
- [L1 bands](#l1-bands-2)
- [Adopting existing bands](#adopting-existing-bands)
- [Building a band by hand](#building-a-band-by-hand)
- [Known limits](#known-limits)
- [Metrics and alerting](#metrics-and-alerting)
- [Troubleshooting](#troubleshooting)

## What it builds

### Root-TX bands

Two layouts, chosen by `INDEX_EXPORT_ROOT_TX_LAYOUT`: `legacy` (the
default, below) and `grid` (the L1 grid with a settle lag, see
[Grid layout](#grid-layout)). In the legacy layout there are three roles,
named `<role>-h<from>-<to|tip>-<publisher>-<digest>`:

| Role | Range | When |
|---|---|---|
| `h` (history) | Fixed and closed | Cut at the first run, at multiples of `INDEX_EXPORT_RECENT_MAX_BLOCKS` from `INDEX_EXPORT_START_HEIGHT`. Never rebuilt |
| `r` (recent) | `[R_lo, R_hi]` | Folded weekly: its own entries plus the sources' rows above it, so rows the index has since expired (ClickHouse TTL) are kept. At `INDEX_EXPORT_RECENT_MAX_BLOCKS` it is frozen and a new `r` starts above it |
| `d` (delta) | From 512 blocks below the top of the highest `h` or `r` to the tip | Rebuilt daily at `INDEX_EXPORT_RUN_AT_UTC`. Published only when its content changed |

A fold publishes the new `r` (superseding only `r` bands) before the new
`d` (superseding only `d` bands). On a fold day the `d` keeps its old start
and moves up over the new `r` the next day. A subscriber keeps a superseded
band until its successor installs, so every height stays covered whichever
band installs first. Each new band also names the ids its predecessors
replaced, so a subscriber that missed one still keeps its old band.

### L1 bands

L1 bands cover two nested fixed grids, the same for every publisher, so two
publishers of the same chain cut it at the same heights. A finalised
height's rows never change, so a band over a completed range is written
once.

| Role | Covers | Built | Size |
|---|---|---|---|
| `h` | A whole 100,000-height range | Once the range is below the top. Supersedes the `d` bands inside it | About 700 MB |
| `d` | A whole 5,000-height sub-range | Once the sub-range is below the top. Never rebuilt | About 35 MB |
| tip | The one incomplete sub-range | Each run the top has moved. Supersedes the tips before it | Up to 35 MB |

Only the tip is rebuilt, so on most days a subscriber downloads at most
about 35 MB. The exception is the day a 100,000-height range completes: its
`h` band replaces the twenty `d` bands beneath it, and is several hundred MB.
The top is one below the stable top, so the block above every band's last
block is there to anchor it. The whole chain was 24 bands in October 2026.

## Where records come from

**Root-TX bands** read `INDEX_EXPORT_SOURCES` (see [envs.md](envs.md)): by
default this gateway's ClickHouse, or its SQLite `bundles.db` without one.
Several sources merge under one rule:

- the later root wins;
- an overlay (a bundler's own offsets, as coverage-named CSV files) wins
  within its coverage;
- two sources that disagree on an item's offsets are left out, or fall back
  to the earlier entry, rather than signed.

The overlay's precedence is its rank: a `csv` source is rank 1 (an overlay)
unless it sets `"rank": 0`, and a rank-1 record beats every rank-0 record
for its item (ClickHouse, SQLite, a peer's files) and every entry folded in
from an earlier band, whatever the order the sources are listed in. The one
exception is a rank-0 row above the overlay file's coverage, a re-bundle the
overlay could not know of. Among rank-0 sources, order doesn't matter
either: the later height wins, then an entry folded from an earlier band.
So a bundler's validated offsets, as an overlay, win over ClickHouse when
the two disagree.

Where a peer indexer's database is not reachable, the peer can run
`ar-io-node index-band-export` into coverage-named files that this service
reads as a peer (`"rank": 0`). Offsets are placed only where proven: an item
whose `root_parent_offset` is ambiguous keeps its root without them.
[`index-band-export`](cli.md#index-band-export) shows what one source gives.

**L1 bands** read `core.db` (`INDEX_EXPORT_CORE_DB`, read-only). It must hold
every block from height 0. A gateway that started above it (`START_HEIGHT`)
cannot build L1 bands, and its runs say so (`incomplete`, not retried).
Only transactions a block lists are written, with their own tags. A row a
fork left in `core.db` is counted (`strayTransactions`) and never published.

### Overlay files

A `csv` source (`{"type":"csv","name":"bundler","path":"/overlay"}`) reads
every file in its directory named `<from>-<to>.csv`, where `from` and `to`
are block heights (`from` ≤ `to`, both included), for example
`2010000-2014999.csv`:

- **Coverage.** A file vouches for exactly its heights. Rows outside them
  are left out (counted as `outside_coverage`), and files may not overlap:
  a run reading two that do fails naming both.
- **Writing.** Write a file under another name (`*.tmp`, `*.partial` or a
  dot-file, which are ignored) and rename it into place; replace one the
  same way.
- **Plain text only.** A gzipped file (`*.csv.gz`) does not match the name
  and is ignored.
- **Columns**, comma-separated, unquoted, one row per line:

  ```text
  data_item_id,root_tx_id,path,root_data_item_offset,root_data_offset,data_item_size,height
  ```

  | Column | Value |
  |---|---|
  | `data_item_id`, `root_tx_id` | 43-character base64url ids; required |
  | `path` | Empty: nested paths are not supported, and a row with one fails the read |
  | `root_data_item_offset` | Where the item (its header) starts in the root transaction's data, in bytes |
  | `root_data_offset` | Where the item's payload starts in the root transaction's data, in bytes |
  | `data_item_size` | The whole item, header and payload, in bytes |
  | `height` | The root transaction's block height; required in an overlay (a row without one is left out, `no_height`) |

  The offsets and size are non-negative integers, or empty for a row with
  its root only. Give both offsets or neither; the header between them
  must be 1 byte to 1 MiB, or the build drops the row.
- **Header line** optional: a file whose first line starts with
  `data_item_id` (after a byte-order mark, if any) skips it.
- A malformed row (an id that isn't 43 base64url characters, a number that
  isn't a whole number, fewer than two columns) fails the source's read,
  naming the file and line, and so the run unless the source is
  `"optional": true`. Give each id once per file.

`ar-io-node index-band-export --output <from>-<to>.csv` writes this format,
with a header line. A peer's files (`"rank": 0`) take the same names and
columns.

## Checks before publishing

### Root-TX bands

Each band is read back, and a sample of its entries is header-checked
against `INDEX_EXPORT_HEADER_CHECK_URL`: 150 entries, plus up to 50 whose
offsets were repaired and 200 the overlay changed. The check reads root
transactions over the network, so point it at a gateway that holds them,
not one that would have to fetch them.

An entry passes when the bytes at its offset decode as a header of exactly
the length its offsets give, ending where the header's tag bytes say, whose
signature hashes to its id. A header whose tag count field disagrees with
its tag bytes (some early bundlers wrote the byte length into both) is a
malformed item at the right place: it passes, and is counted as
`malformedTags` (`index_export_gate_malformed_tags_total`), never as
wrong.

| Outcome | What happens |
|---|---|
| Published | Renamed into place. The sidecar offers it at its next scan |
| Unchanged | Nothing written |
| Skipped | A `d` under 1,000 entries (normal for a small publisher just after a fold), or nothing new. Not an error. An `h` or `r` publishes whatever its size, or its heights would stay uncovered |
| Couldn't check | A source down; the check gateway unable to serve (under 80% read, none wrong, after retrying each read twice); too little disk; or an optional source down during a fold that freezes its band. Retried after 15 minutes, doubling to 2 hours, until the next daily run |
| Rejected | A wrong header, conflicts over 1% of the band, a band with no offsets to check, a failed read-back, or bands in `published/` it did not build (bootstrap). Not retried. `tools/index-swarm-status` shows it as a FAIL |

A failed run never withdraws a band already published. A rejected fold is
not rebuilt every day: it waits until an operator runs `--once`.

### L1 bands

- Every block links to the one before it and is linked to by the one above.
- Each `hash_list_merkle` follows from the previous block.
- Each block's `tx_root` is recomputed from its transactions where the
  index holds them all (see [`tx_root`](glossary.md#tx-root) for what that
  proves).
- Each transaction is at the height and position its block lists it at.
- Each owner's address is the SHA-256 of its key.
- Where the index keeps signatures (`WRITE_TRANSACTION_DB_SIGNATURES`, off
  by default), each transaction's id is the SHA-256 of its signature.

A range that fails is rejected, naming the heights, and nothing is written.
These checks do not cover the order of transactions within a block.
Comparing two publishers' `block_transactions` digests does; when they
disagree for a range, a raw node's `/block/height/<h>` settles one block.

## Running it

It needs a core image that includes it (Release 85 or later). Set
`INDEX_EXPORT_IMAGE_TAG` if core runs an older one. Use the gateway's own
compose `-f` files with every command below.

The service refuses to start without `AR_IO_WALLET` (band ids are made
unique to the publishing gateway) and, when it builds root-TX bands,
without `INDEX_EXPORT_HEADER_CHECK_URL` (it has no default).
`tools/index-swarm-setup --publish` sets the second.

```bash
# Once, without publishing: the plan, rows, time and peak disk per band and
# in total, and the header check's result. -T keeps the logs on stderr, out
# of the JSON report.
docker compose --profile index-export run --rm -T index-export --once --dry-run > plan.json
# The same at a fixed height, keeping the bands to compare (under
# data/indexes, so on the bands' filesystem).
docker compose --profile index-export run --rm -T index-export \
  --once --to 2010000 --keep data/indexes/export/compare > compare.json
# Grid layout: re-settle every frozen band now, due or not, rebuilding those
# whose sources changed (add --dry-run to see what it would change;
# --resettle=full rebuilds every one).
docker compose --profile index-export run --rm -T index-export --once --resettle > resettle.json
# The service. Its first run is about 5 minutes after it starts, then daily.
docker compose --profile index-export up -d --no-deps index-export
```

A dry run of a bootstrap plans every band; cap it with `--to`. Run a long
`--once` (a bootstrap can take hours) in `tmux` or `screen`. A `--once` run
counts as an operator's, so it retries a rejected fold.

- **One run at a time.** A run holds `data/indexes/export/lock`, touched
  every 30 s and broken when 5 minutes stale (a killed run). A `--once`
  beside the running service exits with `locked`.
- **Working directory.** It works under `data/indexes/export/` (scratch,
  `state.json`, the lock; dry runs under `export/dry-run/`), on the same
  filesystem as `published/`.
- **Disk.** It never eats into a margin of 5% of the filesystem, at least
  10 GiB, since the gateway's own data may share that disk. Before a
  root-TX band it also needs three times the band it folds (the old band
  stays through the grace beside the scratch and the new one). Before an
  L1 band it needs eight times the largest band published, at least
  10 GiB. DuckDB's spill is capped at 16 GB and kept in the band's staging.
- **Memory and I/O.** 6 GB of memory and a 4 GB heap; read-only,
  low-priority ClickHouse queries of 2 threads; and an I/O weight where the
  kernel's I/O scheduler honours one (check `BlkioWeight` in
  `docker inspect`).
- **`state.json`** holds adoptions, the last fold, a pending retry and the
  last run, per index. The bands themselves are read from `published/`, so
  losing it costs the adoptions and the status history.
- **Ownership.** The container runs as root, so the band directories it
  writes are root's. Removing one by hand takes `sudo`.
- **Logs.** It logs by `LOG_LEVEL` and `LOG_FORMAT`, capped like the
  sidecar's by `INDEX_SWARM_LOG_MAX_SIZE` and `INDEX_SWARM_LOG_MAX_FILE`.

## Grid layout

`INDEX_EXPORT_ROOT_TX_LAYOUT=grid` cuts root-TX bands on the same fixed grid
as [L1 bands](#l1-bands): 100,000-height ranges over 5,000-height
sub-ranges, from height 0, so every publisher's bands start and end at the
same heights whatever its start height. Unlike L1 rows, root-TX entries keep
arriving after their block (late unbundling, retries, re-bundles), so a
range is frozen only after a settle lag, and frozen bands are re-settled on
an interval.

| Role | Range | Built | Rebuilt |
|---|---|---|---|
| `h` | A whole 100,000-height range | Once its twenty `d` bands exist, from their entries alone (a roll), superseding them. A run that finds a whole range settled at once (a bootstrap, or catching up after an outage) builds it from the sources instead | Only by a re-settle |
| `d` | A whole 5,000-height range | Once its top is `INDEX_EXPORT_ROOT_TX_SETTLE_BLOCKS` (5,040, about 7 days) below the stable top: the sources' rows for its heights, plus the tip's entries that belong there | Only by a re-settle |
| `tip` | From above the frozen bands to the tip | Each daily run: the sources' rows above the frozen bands plus the previous tip's entries, superseding it. Published only when its content changed | Daily |

A subscriber downloads the tip each day, a `d` about once a week, and an `h`
about every 4½ months, rather than a multi-GB `r` every week.

A run, in order:

1. **Freeze** each range above the frozen top whose top is at or below the
   freeze limit (the stable top less the settle lag), lowest first. One
   that fails stops the freezes for the run; an empty range is skipped.
2. **Roll** each 100,000-height range whose twenty `d` bands all exist.
3. **The tip.** On a day bands freeze, the tip keeps its start and still
   covers their heights, so no order of installing the new bands leaves a
   subscriber a gap; it moves up over them the next run.
4. **Re-settle** the frozen bands that are due, one at a time.

**Where the tip's entries go.** Bands store no heights, so an entry of the
tip is placed by its root's height, which the sources' rows give: every row
under a root has its height. A freeze takes in the tip's entries whose root
falls in its range. When the tip moves up, it leaves out an entry whose
root is below its new start only when the frozen band of that height holds
it. Anything else stays in the tip: an entry whose root no source gives any
more (`unresolved`), or one the frozen band lacks because its root was
indexed after the freeze (`carried`, until a re-settle of that band takes
it in). No entry is dropped. `index_export_tip_unplaced_entries` counts
both; each step's `seeds` in the report gives the numbers.

### Re-settle

Each frozen band is due `INDEX_EXPORT_ROOT_TX_RESETTLE_INTERVAL_HOURS`
(168) after it was built or last re-settled, and is re-settled by the daily
run after the tip, the band with the most entries first.
`--once --resettle` re-settles every frozen band now, due or not, also with
the interval at 0 (never automatically). A band whose sources have changed
is rebuilt from its own entries plus the sources' rows for its range. A
band's own entries are folded in at its top height, so a source's row never
displaces one; only an overlay can relocate an entry. Rows the sources have
dropped since (ClickHouse TTL) stay.

**The fingerprint gate.** Rebuilding a 100,000-height band takes hours, so a
due band is rebuilt only when its sources give something else than when it
settled. When a band settles (frozen, rolled, or re-settled; an adopted one
after its first full re-settle), each source's fingerprint of its heights
is recorded in `state.json` (`fingerprints`, by band id), per 5,000-height
sub-range, so an `h` rolled from twenty `d` bands takes theirs. A source is
fingerprinted before the build reads it, so a row that lands meanwhile is a
change next time, never one missed.

| Source | Fingerprint |
|---|---|
| ClickHouse | One aggregate query: the count, XOR and sum of a hash of every row the record query reads (data items in the range; every column it reads or orders by, `inserted_at` included) |
| CSV (overlay or a peer's files) | The files covering the range, by name, size and SHA-256 |
| SQLite | A digest of the records it gives, read in full but not built |

Each also carries the source's name, rank and where it reads (URL and user,
or path), and a version that a release bumps when the same rows would give
other records.

| Gate | When | What happens |
|---|---|---|
| `same_sources` | Every source as recorded | Not rebuilt: unchanged, reason `same_sources`; settled for an interval |
| `changed` | A source's rows, files or settings changed, one was added or removed, or one could not be fingerprinted | Rebuilt and compared, as below; the new fingerprint recorded |
| `unrecorded` | No fingerprint: adopted, built before this release, or under an older version | Rebuilt once, then recorded |
| `source_down` | Only recorded sources that are down this run differ | Not rebuilt; due again next run |

`--once --resettle=full` rebuilds every frozen band whatever the gate says.
A ClickHouse merge, `OPTIMIZE` or TTL expiry changes the rows, and so the
fingerprint, though the rebuild then finds nothing to add: such a band is
rebuilt once, and is unchanged. Each step's `gate` in the report says what
the gate found.

| Outcome | When | What happens |
|---|---|---|
| Unchanged | The same sources (`same_sources`), the same content, or the same entries | Nothing published; the band keeps its id. Not due again for an interval |
| Published | Entries were added or relocated, and the checks passed | The same range under a new id, superseding the old band |
| Rejected | A wrong header; an entry would be lost; more relocated entries than `INDEX_EXPORT_ROOT_TX_RESETTLE_MAX_CHANGED` (20,000); an entry relocated to a root without offsets; conflicts over 1% | The old band stays. Not tried again for an interval, or until `--once --resettle` |
| Couldn't check | A relocated entry could not be read, or under 80% of the checked entries passed | The old band stays, and the next run tries again |

The safety rules:

- **Nothing is lost.** The rebuilt band is compared with the published one,
  entry by entry: an id the old band holds and the new one doesn't fails
  the band.
- **Only the delta is header-checked.** The entries the band already held
  were checked when it was first published, and their roots may since be
  unseeded, so they are not read again. The checked set is:
  - every relocated entry (one whose root, offsets or size changed), each
    one, stratum `resettle-changed`;
  - a sample of 150 of the added entries, stratum `resettle-added`;
  - the build's usual `repaired` and `overlay-changed` sample entries that
    are themselves added or relocated.
- **Every relocated entry must read and verify.** One that cannot be read
  makes the band "couldn't check", whatever share of the rest passed.
- **The 80% pass ratio applies to the checked set only**, and a read that
  fails in transport counts against it, as for any band.
- **Any wrong header fails the band.**
- An entry added without offsets cannot be checked, as in any build; a
  re-settle that adds only such entries publishes without a check.
- With nothing added or relocated, the re-settle is a no-op (unchanged).
- The usual conflict cap and merge rules apply. Freezes, rolls and the tip
  are checked as any band: the general sample of 150 and the usual strata.

The report gives each re-settle's `resettle`: the old and new entry
counts, how many were added, changed and unchanged, and the header check's
counts per stratum. A run that could not check a build skips the
re-settles (listed in `plan` as `deferred`); the retry runs them.

### Running the grid layout

A `--once --dry-run` lists every step in `plan` (what it reads, folds,
places and supersedes), builds and checks each it can, and publishes
nothing. A roll that waits on `d` bands the dry run built but did not
publish is listed with `awaits` and reported as `after_planned`. It writes
only under `data/indexes/export/dry-run/`, removed when it ends, and takes
no lock, so it can run beside the service and as often as needed. It needs
the work directory on the publish directory's filesystem, as any run does.

Metrics, besides the usual ones (`kind` is the role):

| Metric | Read it as |
|---|---|
| `index_export_resettles_total{index,kind,result}` | Re-settles: `unchanged`, `rebuilt` or `failed` |
| `index_export_resettle_gate_total{index,kind,verdict}` | Due bands by the fingerprint gate: `same_sources`, `changed`, `unrecorded`, `source_down` |
| `index_export_resettle_entries{index,kind,change}` | The latest re-settle of a role: entries `added`, `changed` and `unchanged` |
| `index_export_tip_unplaced_entries{index}` | Entries the tip keeps without a frozen band to hand them to. Steady near 0; a growing number means rows left the sources before their range froze |

The daily band is the tip: alert on
`index_export_last_success_timestamp_seconds{index="root-tx-index",kind="tip"}`
rather than `kind="d"`, which succeeds about once a week.
`tools/index-swarm-status` checks the tip once there is one.

Overlay files are never pruned in this layout: a re-settle reads them.

### Adopting bands into the grid layout

**Grid bands built by hand** (`index-band-build --kind h|d|tip` with this
gateway's wallet as `--publisher`, as turbo-gateway.com did from October
2026): they are this publisher's own already, by their ids
(`h-h<lo>-<lo+99999>-…`, `d-h<lo>-<lo+4999>-…`, `tip-h<lo>-tip-…`), and the
service takes them as they are. Stop the script, then start the service.
The first run rebuilds the tip from the same start, and publishes nothing
if its content is the same. Bands of another wallet are adopted with
`--adopt <id> --as h|d|tip` (`--top` for the tip).

**A legacy layout** (`h`, `r`, `d`): switch the variable and run `--once`.
`h` bands on the grid stay as they are, as does an `r` over a whole
100,000-height range (a frozen one; a re-settle rebuilds it as an `h`). The
current `r` and the daily `d` become seeds: their entries go into the new
`d` bands at their roots' heights, and the first tip, which starts where
the `r` did, supersedes both. Entries whose rows the sources no longer hold
(older than ClickHouse's TTL) can't be placed, and stay in the tip.

**Refused.** A band off the grid (a legacy `h` cut from an
`INDEX_EXPORT_START_HEIGHT` that isn't a multiple of 100,000), a closed
`tip`, or frozen bands that overlap stop the run before anything is built
(`grid_layout`, shown as a rejection). Rebuild such a range on the grid
with `index-band-build`, naming the old band in `--supersedes`, or move the
band out of `published/`, then run `--once`.

### Grid layout limits

- An entry indexed after its range froze joins the band at the next
  re-settle, up to a week later, not at once.
- **Known limitation: an empty 5,000-height range never rolls.** A range
  with no entries gets no `d` band, and a roll needs all twenty, so its
  100,000-height range never becomes an `h`: its other `d` bands stay as
  they are. This does not happen on mainnet above the earliest bundles.
- `INDEX_EXPORT_RECENT_MAX_BLOCKS` and the weekly fold are not used.

## L1 bands

Turn them on with `INDEX_EXPORT_KINDS=root-tx-index,parquet-l1`, and list
`{"name":"parquet-l1","kind":"parquet-l1"}` in `INDEX_SWARM_PUBLISH` too.
The sidecar is what retires a superseded tip band; without it
`published/parquet-l1/` keeps every one. They are built in the same run as
root-TX bands, under the same lock.

### Normalised columns

Two honest publishers of the same chain write identical rows, so comparing
their digests per range checks each other's index. Three columns are ones
a gateway fills in for itself, so a band writes one canonical value for
each, whatever `core.db` holds:

| Column | Written as | Why |
|---|---|---|
| `blocks.tx_root` below the 2.0 fork (422,250) | null | A pre-fork block hash does not commit it, and it cannot be recomputed |
| `transactions.data_root` on format 1 | null | A format-1 header carries none; some gateways hold one computed from the data. Format 2 signs its `data_root`, so it is kept |
| `transactions.content_type`, `content_encoding` | The first `Content-Type` / `Content-Encoding` tag by position, names compared without case; null if none | Older releases stored the last matching tag, so the stored value depends on the release that indexed the row |

No check reads a pre-fork `tx_root`, and `tx_root` recomputation derives a
format-1 transaction's root from its data, never from the stored column.
An import never erases a pre-fork `tx_root` or a format-1 `data_root` the
gateway already holds.

### Layout `l1-3` and lookup files

These are layout `l1-2`'s rules (`schema` in `band.json`). Layout `l1-3`
keeps them and adds three [lookup files](index-publication.md#lookup-files)
to every band. Lookup files add 10 to 20% to a band. A reader accepts
`l1-1`, `l1-2` and `l1-3`.

Every band built is `l1-3`: the service writes the tables, derives the
lookup files from them, and writes `band.json` last. A published band whose
tables are current but which has no lookup files (`l1-2`, or `l1-1`
confirmed identical under `l1-2`) is not rebuilt. Each run derives its
lookup files from its own tables, adds them in place, and keeps its id,
then replaces `band.json` with one naming them. No file already in the band
changes, and a subscriber that already holds the band fetches only the new
files. This needs no `core.db`, so it runs first, before any build, and
again after them. It reports each band under `l1Derived` and counts it as
`index_export_runs_total{kind="derive"}`.

`band.json` holds only what the band's rows determine, dated by its top
block, so every publisher of the same rows writes the same file and the
same torrent. The bands a build replaces, and when it was built, are this
publisher's own: the service keeps them beside the band in
`.publisher.json`, which the sidecar reads for the publication and no
subscriber ever sees. A band published before this carried both in its
`band.json`. Each run settles any such band of this publisher's in place,
before any build: it moves them into `.publisher.json`, dates `band.json`
by the top block (one column of `blocks.parquet` read, no `core.db`), and
replaces it by a rename. The band keeps its id and its rows, so a
subscriber fetches only the new `band.json`. It reports each band under
`l1Normalized` and counts it as `index_export_runs_total{kind="normalize"}`.

**Upgrading a publisher from `l1-1` rebuilds every band once.** A rebuilt
band whose rows did not change keeps its id, since the id comes from the
rows. Its files are left alone, so subscribers download nothing. Only
ranges whose rows changed get new ids.

**Upgrade order.** A sidecar that does not know `l1-3` cannot read an
`l1-3` band. As a subscriber it refuses the band, naming the layout, and
keeps its copy. As a publisher it cannot describe the band, so the band
goes unpublished. Upgrade subscribers first, then a publisher's
`index-swarm` with or before its `index-export`. A gateway filling its
history from L1 bands (`L1_BAND_IMPORT_ENABLED`) reads them with the core
image, so upgrade it with the subscriber.

### Time budget

A bootstrap of the whole chain takes hours. A run starts no new whole band
after `INDEX_EXPORT_L1_RUN_BUDGET_MINUTES` (4 hours by default). The rest are
listed as `l1Deferred`, and the next run starts 15 minutes later. For a
bootstrap or a one-time rebuild, raise it so one run does the lot.

### Load on the gateway

Reads are short, by key or index, in windows of 200 heights, so the
gateway's WAL checkpoints are not held back. A bootstrap still reads all of
`core.db` once, so schedule it off-peak.

Each index keeps its own outcome, retry and last run, in `state.json` and in
the metrics (`index` label). A failing L1 band neither retries nor marks
root-TX bands, or the reverse.

## Adopting existing bands

The service refuses to bootstrap while `published/` holds bands it did not
build and has not adopted, since new bands would overlap them. A publisher
with bands built another way hands them over first, with the service
stopped (adopting takes the lock):

```bash
docker compose --profile index-export run --rm -T index-export \
  --adopt <band-id> --as h|r|d [--top <highest height it covers>]
```

In the grid layout, `--as tip` too; see
[Adopting bands into the grid layout](#adopting-bands-into-the-grid-layout).

Adopt every band: the recent one as `r` (folded like the service's own;
under `INDEX_EXPORT_RECENT_MAX_BLOCKS` in span), older ones as `h`, and a
daily delta as `d`, so the service's first `d` supersedes it. `--top` is
required for a band open at the tip, since bands store no heights. Err low,
since the fold reads the sources from just below it. Stop whatever else
built the bands before adopting, or it will replace them under new ids.

## Building a band by hand

[`ar-io-node index-band-build`](cli.md#index-band-build) builds a root-TX
band from CSV records in one step. It deduplicates, names the band so its id
is unique to the publisher and changes with its content, header-checks a
sample, and only then renames it into place, never over an existing band.
[`index-band-verify`](cli.md#index-band-verify) runs the same check on any
band.

Without the CLI, a band is a
[partitioned CDB64 index](cdb64-format.md#partitioned-cdb64-index-format),
for example from the local database:

```bash
./tools/export-sqlite-to-cdb64 --partitioned \
  --output-dir data/indexes/published/root-tx-index/band-tip.tmp
mv data/indexes/published/root-tx-index/band-tip.tmp \
  data/indexes/published/root-tx-index/band-tip
```

Build under a `.tmp` name and rename into place. Directories ending in
`.tmp`, or in `.tmp.<pid>` (the partitioned writers' own build
directories), are skipped, so a band is never described half-written.

A band must carry all of its partitions as local files. The publisher and
every subscriber refuse a `manifest.json` that names a partition by URL or
Arweave ID, as the shipped remote indexes in `resources/` do.

### Band metadata

Two optional fields in a band's `manifest.json` `metadata` change how
subscribers treat it. Add them before renaming the band into place: a
manifest edit changes the band's digests.

```bash
m=data/indexes/published/root-tx-index/band-tip.tmp/manifest.json
jq '.metadata = ((.metadata // {}) + {heightRange: [1950000, null]})' "$m" > "$m.new" && mv "$m.new" "$m"
```

| Field | Effect |
|---|---|
| `heightRange: [from, to]` | The heights the band covers; `to` is `null` for a band that follows the tip. Subscribers install bands newest heights first by this range. A band without it installs last. `export-sqlite-to-cdb64` does not write it |
| `supersedes: "<band id>"` (or a list) | This band replaces the named ones. The publisher stops offering them in the same scan that describes this band, and deletes them after `INDEX_SWARM_SUPERSEDE_GRACE_SECONDS`. Subscribers retire them the same way |

To replace a band, give each build a fresh id with `supersedes` naming the
previous one. Subscribers then keep serving the old band until the new one
has installed. Without `supersedes`, a subscriber retires a band as soon as
the publisher stops offering it, and the operator deletes the old directory
after the next scan. Set `supersedes` when the band is first published:
adding it later edits the manifest, which makes a new version of the band.
A `supersedes` naming an id the publisher does not hold retires nothing; the
publisher warns once. Swapping a band under the same id also works, but
there is a moment when the band is absent and subscribers retire it.

## Known limits

- Rows indexed late at heights already frozen into a root-TX band
  (backfills) are not exported, except by a grid layout's re-settle.
- An item under two roots at one height keeps whichever sorts first.
- A whole L1 band is never rebuilt, so it waits (`incomplete`) while the
  index lacks a transaction a block lists, or an owner's key. A tip band
  publishes anyway and counts them (`missingTransactions`,
  `missingWallets`); it is rebuilt each run.
- A band published wrongly cannot be replaced under its range by the
  service. Remove it from `published/<index>/` (`sudo`) and run `--once`.

## Metrics and alerting

`/healthz` and `/metrics` are on `INDEX_EXPORT_METRICS_PORT` (9102), in
`--once` runs too. `/healthz` reports only that the loop is alive, never
whether runs succeed, so autoheal cannot restart-loop a failing export. The
shipped `prometheus.yml` scrapes it as the `index-export` job.

| Metric | Read it as |
|---|---|
| `index_export_runs_total{index,kind,result,reason}` | Outcomes per band role. `kind="derive"` counts lookup files added in place; `kind="normalize"` counts `band.json` files settled in place |
| `index_export_last_success_timestamp_seconds{index,kind}` | The last success per role. Set again from `state.json` after a restart |
| `index_export_run_in_progress`, `index_export_run_started_timestamp_seconds` | A run that is taking long |
| `index_export_heartbeat_timestamp_seconds` | The loop is alive |

Alert when the daily band is late:

```promql
time() - index_export_last_success_timestamp_seconds{index="root-tx-index",kind="d"} > 2 * 86400
  or absent(index_export_last_success_timestamp_seconds{index="root-tx-index",kind="d"})
```

Add the same rule with `index="parquet-l1"` where L1 bands are built. It
fires through a bootstrap, until the first tip band. In the root-TX grid
layout, the daily band is `kind="tip"`.

`tools/index-swarm-status` also reports the export: the last daily band and
fold, the last run, a pending retry, a recent rejection and a stale lock,
for root-TX and L1 bands separately.

## Troubleshooting

**`incomplete`.** `core.db` does not hold everything a range needs: blocks
below `START_HEIGHT`, a transaction a block lists, or an owner's key. Not
retried for a whole band until the gateway has backfilled it.

**`held`.** An L1 band failed its chain checks. It stops the L1 part, since
bands are imported in height order, and scheduled runs do not rebuild it.
Repair the named blocks in `core.db`, then run `--once`.

**Refused reads.** The gateway writes to `core.db` while the export reads
it. During a WAL checkpoint SQLite can refuse a read, reporting it as a
write to a read-only database. The band is built again, twice (15 s, then
30 s later), before the run gives up on it. A chain check is never retried:
it would fail the same way.

**`Couldn't check`.** The check gateway could not serve enough roots, or a
source was down. Point `INDEX_EXPORT_HEADER_CHECK_URL` at a gateway that
holds the roots (see [choosing `--gateway-url`](cli.md#choosing---gateway-url)).

**`locked`.** Another run holds the lock. A lock untouched for 5 minutes
belongs to a run that died; the next run clears it.
