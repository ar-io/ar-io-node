# Index export: building bands

The `index-export` service builds the bands a gateway publishes through
[Index Sharing](index-swarm.md). It runs the core image in the compose
profile `index-export`, reads this gateway's own index, and writes finished
bands under `data/indexes/published/<index>/`. The `index-swarm` sidecar
then signs and offers whatever it finds there. It builds three kinds of
band:

- **root-TX bands** (`cdb64-root-tx`), from ClickHouse or `bundles.db`;
- **L1 bands** (`parquet-l1`), from `core.db`;
- **L2 bands** (`parquet-l2`), the data items one selection takes, from
  ClickHouse, placed on the chain by the L1 bands.

`INDEX_EXPORT_KINDS` chooses which (default `root-tx-index`; add
`parquet-l1` for L1 bands, `parquet-l2` for L2 bands). For the format of
each band and how a reader uses it, see
[index-publication.md](index-publication.md).

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
- [L2 bands](#l2-bands)
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
whose `root_parent_offset` is ambiguous keeps its root without them, and so
does a row whose own numbers can't frame an item (no size, a payload that
doesn't start after the item, a header longer than the item, or an end the
payload doesn't share), counted as `unrepaired` reason `layout`.
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

Each sample is drawn from a pool ten times its size, walked in random order
until the sample's size has been read. An entry whose root the gateway
answers 404 for (history whose roots are gone network-wide) is
`unreadable`: passed over, neither passed nor wrong, and left out of the
pass ratio; that root is not asked for again. A band passes when no entry
read is wrong, at least 80% of those read passed (a timeout, 429 or 5xx
counts against it), and at least 40 passed (80% of 50, or of a smaller
sample), which fails a band only when roots that are gone use the pool up.
The report's `sampled` counts the entries read, `poolSize` the candidates.
Each
step's log gives `unreadable`, the pool and the unreadable share, an
estimate of how much of the band's history is gone, and
`index_export_gate_unreadable_total` counts them.

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
# --resettle=full rebuilds every one; --range 1100000-1199999 only the
# bands inside those heights).
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
`--range <from>-<to>` with `--resettle` re-settles only the frozen bands
inside those heights and builds nothing else (no freeze, roll or tip), to
re-check one band: `--once --resettle=full --range 1100000-1199999`.

`--range` means one thing per run, for every index the run builds:

| Given | Root-TX (grid) | Root-TX (legacy) | `parquet-l2` (each index) | `parquet-l1` |
|---|---|---|---|---|
| `--range` with `--resettle[=full]` | Re-settles only its frozen bands inside the heights | Nothing built: it has no frozen bands to pick | The same as the grid | Nothing built |
| `--range` alone (with `--dry-run` or `--keep`) | Nothing built | Nothing built | Builds exactly that band (a range on the grid), never published | Nothing built |

An index that builds nothing keeps its state (last run, retry) as it was.

`--range` alone without `parquet-l2` among the kinds, or without
`--dry-run` or `--keep`, is refused.
A ClickHouse merge, `OPTIMIZE` or TTL expiry changes the rows, and so the
fingerprint, though the rebuild then finds nothing to add: such a band is
rebuilt once, and is unchanged; that is the safe direction, never a change
missed. Each step's `gate` in the report says what
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
  - a sample of 150 of the added entries, stratum `resettle-added`, read
    from a pool of 1,500 past roots that are gone;
  - the build's usual `repaired` and `overlay-changed` sample entries that
    are themselves added or relocated.
- **Every relocated entry must read and verify.** One that cannot be read,
  its root gone (404) included, makes the band "couldn't check", whatever
  share of the rest passed.
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

Every band built has lookup files (and, from `l1-4`, its witnesses when
they can be had): the service writes the tables, derives the lookup files
from them, and writes `band.json` last. A published band whose
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
image, so upgrade it with the subscriber. The same holds for `l1-4`.

### Layout `l1-4` and witness files

Layout `l1-4` keeps `l1-3` and adds [witness
files](index-publication.md#witness-files): the v1 data root of every
format-1 transaction with data, and, in a band holding heights below the
2.0 fork, each block's transition `tx_root` and the 2.0 seed fold. With
them `index-l1-verify` and the importer bind every block of the chain, so a
gateway fills its whole history with no `--allow-*` flag. A reader accepts
`l1-1` to `l1-4`.

The service builds a band's witnesses from what it is given, and publishes
nothing the chain does not confirm:

- **v1 data roots** from `roots-*.jsonl` files in
  `INDEX_EXPORT_L1_WITNESS_DIR` (lines `{"h": <height>, "id": "<base64url>",
  "root": "<base64url>"}`; other keys ignored; a file named
  `roots-<band id>.jsonl` is read only for bands overlapping its heights),
  then, for a transaction none has, its last chunk from the nodes in
  `INDEX_EXPORT_L1_WITNESS_NODES` (`GET /chunk/{offset}`, the offset its
  data ends at in the weave; the root its `data_path` proves, the path
  checked to end at the transaction's size). Where a block's roots do not
  reproduce its `tx_root`, its transactions are fetched whole
  (`GET /tx/{id}`, up to 16 MiB each) and their roots computed from the
  data: the genesis block's transactions, whose data the weave never held,
  have no chunk at all. A root is kept only when its block's `tx_root`
  recomputes with it (below the 2.0 fork, when the fold reaches the
  pinned value); a block whose roots do not is left without them.
- **Transition `tx_root`s** below the 2.0 fork are recomputed from each
  block's transactions and their v1 roots. Where a root is missing they
  come from Arweave's 2.0 checkpoint (`fork_2_0_checkpoint` in the witness
  directory: `git -C repos/arweave show
  d43ba2b9^:apps/arweave/priv/fork_2_0_checkpoint`, refused unless its
  SHA-256 is Arweave's) for heights to 399,999, and from the nodes'
  `GET /block_index/{from}/{to}` (`X-Block-Format: 3`) above. Given both,
  they must agree, and the entry's hash and weave size must be the band's.
- The **fold** runs from empty at height 0 or from the pinned fold below
  the band, and must equal every pinned fold it reaches and, in a band
  holding it, block 422,250's `hash_list_merkle`.

Then the band with its witnesses is judged whole by the code every
consumer runs (`index-l1-verify --bands-dir`), and must pass with no block
left unbound beyond the roots `INDEX_EXPORT_L1_WITNESS_MAX_MISSING` allows
(default 0). Only then are the files moved in and `band.json` replaced,
under the band's id, by a rename. A published `l1-3` band gains its
witnesses this way each run, with no `core.db`, before the builds and after
them, reported under `l1Witnessed` and counted as
`index_export_runs_total{kind="witness"}`: `published` when added,
`skipped` (`witnesses_unavailable`) when the inputs lack what the band
needs, and `couldnt_check` when an input contradicts the chain. A new band
is built with its witnesses when they can be had, and as `l1-3`
otherwise, saying why in its outcome's `details`; the witness step adds
them later. A band above the 2.9.6 fork needs no input: its
`witness_v1_data_roots` is empty.

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

## L2 bands

An L2 band (`parquet-l2`, layout `l2-2` in
[index-publication.md](index-publication.md#l2-bands)) holds the ANS-104
data items of one height range that a **selection** takes: those with a tag
named exactly `name` whose value starts with `valuePrefix` and not with
`excludeValuePrefix`, compared as bytes. Each selection is its own index,
published under `published/<name>/`:

```bash
INDEX_EXPORT_KINDS=root-tx-index,parquet-l1,parquet-l2
INDEX_EXPORT_L2_INDEXES='[{"name":"ardrive-l2","selection":{"kind":"ans104-data-items","tag":{"name":"App-Name","valuePrefix":"ArDrive","excludeValuePrefix":"ArDriver"}},"keyTags":["Drive-Id","Parent-Folder-Id","Folder-Id","File-Id"],"statTags":["App-Name","Content-Type","Entity-Type"]}]'
# and in INDEX_SWARM_PUBLISH: {"name":"ardrive-l2","kind":"parquet-l2"}
```

A band's selection is bound into its id, so an index's selection never
changes: bands of another selection in its directory stop the run
(`grid_layout`). A new selection is a new index, under a new name.
`keyTags` and `statTags` (optional, none unless given) name the tags each
band's key lookup and stats are derived for; they are not part of a band's
id, and a change to them is applied to every published band in place
([below](#layout-l2-2-key-lookup-and-stats)).

### Where L2 rows come from

- **Items** from ClickHouse: this gateway's (`CLICKHOUSE_*`), or a peer's
  (`INDEX_EXPORT_L2_SOURCE`). Each window of up to 250 heights is read
  `FINAL`, the selection pushed down (`arrayExists` over
  `tag_names`/`tag_values`, on the raw bytes) and checked again on every
  row returned: a row the selection doesn't take refuses the band
  (`selection_mismatch`). A window that holds more than
  `INDEX_EXPORT_L2_WINDOW_ITEMS` (50,000) items is cancelled and read in
  halves, down to a single height. The nested bundles above each item are
  read by id, level by level up to the root.
- **Positions on the chain.** An item's `height` and
  `block_transaction_index` are its root transaction's, never its own
  row's: from this publisher's `parquet-l1` bands when they cover the
  band's heights (their `block_transactions`), else ClickHouse's L1 rows
  (`is_data_item = false`), else no band (`no_l1`, retried). A root found
  in neither, or at two positions, refuses the band (`roots`, with the
  count and a sample). An item the index files under a lower height of the
  band than its root's moves up to its root's, held until that window
  (`movedHeight` in the report; at most 100,000 a band). One filed above
  its root's height, whose window is written by then, refuses the band
  (`roots`, `below`): a fork moves a root up the chain, never down.
  `createdAt` is the time of the band's top block, from the same data.
  Where this publisher has L1 bands, L2 bands reach no higher than they
  do, so every band's roots are placed by them.
- **Owners' keys**, one `wallets` row per owner, from the first that has a
  key whose SHA-256 is the address: the item's own row (ClickHouse keeps
  `owner` only for keys of at most 64 bytes, so not an RSA modulus); the
  gateway's `bundles.db` `wallets` table, read-only
  (`INDEX_EXPORT_L2_WALLETS_DB`); the `wallets` tables of the bands this
  one replaces (a key verifies itself, so a re-settle keeps every key they
  had whatever the gateway serves that day; `stats.owners.fromReplaced`);
  the root, read through the header-check gateway at a located item's
  owner offset (`owner_size` bytes, 512 for an Arweave key), up to three
  places an owner. An owner with none is left
  out of `wallets` and counted (`ownersWithoutKey`, and by why in
  `stats.owners.withoutKeyBy`: `unreadable`, `wrong`, `nowhere`); the
  band still builds.
- **`content_type` and `content_encoding`**: the first `Content-Type` /
  `Content-Encoding` tag by position, names compared without case, as an L1
  band takes them; null without one, an empty value kept empty.

### Locations

An item's eight location columns are offsets into its parent bundle's
payload plus `root_parent_offset`, where that payload starts in the root:
all set, or all null. The rules, in order:

1. Every offset and size known (else `no_offsets`).
2. **Item-relative header offsets** moved into the payload: a
   `signature_offset` of 2 with an `offset` other than 0 gets `offset` added
   to it and to `owner_offset` (`normalised`).
3. **The arithmetic of one item**: `size > 0`, `data_offset + data_size =
   offset + size`, `signature_offset = offset + 2`, `owner_offset =
   signature_offset + signature_size`, `data_offset ≥ owner_offset +
   owner_size` (else `layout`).
4. **Placement**, by the same function as root-TX bands (`placePayload`):
   an item in the root at base 0; one level down under its bundle's
   payload, `root_parent_offset` as held, or 0 with relative offsets
   (`repaired`) or absolute ones; deeper only on an unbroken chain (else
   `deep`). `inconsistent` and `no_parent` as for root-TX bands. An item
   whose bundle the index holds at two places in the root is left
   unlocated (`parent_two_places`); one whose bundle it holds at none
   (every row of the bundle inconsistent) is left unlocated (`no_parent`)
   even where the item's own row, an absolute offset, would place it: a
   band never locates an item under a parent `parents` does not describe.
5. **Ambiguous items** (one level down, `root_parent_offset` 0, both
   readings possible) are settled by their bytes: the header is read from
   the root at both candidate starts and decoded, and the reading whose
   header is the item's (its id, its length) is kept. Neither or both:
   unlocated (`ambiguous`); a root the gateway has no copy of: unlocated
   (`unproven`). Each item is read on its own (two items of one bundle can
   have been indexed by different code): `data_offset - offset` bytes, its
   header, at each candidate start, at most 8 reads at a time and
   `INDEX_EXPORT_L2_MAX_READS` (200,000) reads, proofs and keys together,
   a band (past it the band waits, `couldnt_check`, `read_budget`). A
   header is read as the header check reads it: one whose tag count field
   is malformed still proves its reading (`stats.malformedTags`).

Offsets are written parent-relative whichever way the index holds them, so
an item held with absolute offsets and the same item held with relative
ones give the same row and the same digest. `parents` lists every located
nested bundle between a held item and its root (placed by `placePayload`
alone, never by reading its header).

What the gateway answers decides a read:

- **404, no such root**: the root is unreadable for the rest of the build,
  asked about once (its other reads wait for that answer, then are
  answered without a request). An ambiguous item there is `unproven`, an
  owner whose key could only be read there is without a key (`unreadable`
  in `stats.owners.withoutKeyBy`), and the band builds. About half the
  roots of 2023 heights are served by no node any more.
- **416, or a range cut short**: those offsets run past the root, a
  definite no.
- **A timeout, a 5xx, a 429, a connection that failed**: tried twice more,
  then the band stops (`couldnt_check`, `gateway`) and waits for the next
  run, so a slow gateway never unlocates an item or drops a key.

Each band's report gives the requests it made (`stats.reads`, against
`INDEX_EXPORT_L2_MAX_READS`), how many were answered 404
(`readsNotFound`), how many reads of such roots were answered without a
request (`readsNotFoundRemembered`), and how many ran past their root
(`readsOutOfRange`). Bytes are not cached: every proof and key reads its
own offsets. `stats.placedBy` gives the located rows by how they were
placed; a row any copy of which `placePayload` repaired counts as
`repaired`.

The header check of a band's sample passes over roots that are gone (see
*Checks before publishing* below), so a band whose roots are mostly gone
builds as long as enough of those that answer verify.

### Distinct rows

Rows are kept distinct window by window: an item's height is its root's,
so every row of a height is in one window. An item the index holds twice
at one height (two block positions of its own) is one row once both carry
their root's. An unlocated row of an (id, root) that also has a located one
is dropped. What is left must be one row per key of each table's order, or
the band is refused rather than tie-broken: two unlocated rows of one item
in one root that still differ (`unlocated_conflict`), two rows at one place
(`conflict`), two tags at one position (`tag_conflict`), two places of a
bundle at one offset (`parent_conflict`).

### Memory and disk

A band is built in memory that follows a window, never the band (the
largest, `h1800000`, holds 69M items and 518M tag rows):

- a window's rows are sorted in its table's order and appended, with their
  digest, to the build's own DuckDB database, a file in the staging
  directory; `data_items` and `tags` are then written to Parquet in that
  order, with no sort of the whole band, and read back in it to check
  their digests and order;
- `parents` and `wallets` are gathered in the database, kept distinct and
  sorted there; owners' keys are resolved streaming from it;
- the three [lookup files](index-publication.md#l2-lookup-files) are
  derived by DuckDB from the tables' Parquet once it is written, each
  sorted by its key, in the same database;
- DuckDB runs within `INDEX_EXPORT_L2_DUCKDB_MEMORY` (2 GB) and
  `INDEX_EXPORT_L2_DUCKDB_THREADS` (2), spilling into the staging
  directory, at most `INDEX_EXPORT_L2_DUCKDB_SPILL_MAX_GB` (256 GB).

A synthetic band of 3,000,000 items and 21,000,000 tag rows (seven
ArDrive-like tags each) builds in 8 minutes with DuckDB held to 512 MB, the
process at 1.3 GB at most (`export-large.test.ts`, run with
`INDEX_EXPORT_TEST_L2_LARGE=3000000`): about 50,000 rows a second. Its band
is 330 MB, 110 bytes an item, and the staging directory, the database and
the band together, 2.5 times the band. Scaled to `h1800000` (69M items,
518M tag rows): about 3½ hours, a band of 8 GB or more (real tags run
longer than the synthetic ones; allow 15 GB), and 20 to 40 GB of staging,
on the publish directory's filesystem, plus DuckDB's spill for the final
joins over distinct roots and owners, a few GB.

### Checks before publishing

Besides the rules above, before a band publishes:

- every location all set or all null, and the arithmetic of every located
  row;
- `tag_count` equal to the item's tag rows, and no tag without an item;
- every root at its L1 position, joined against the L1 bands themselves
  when they gave the positions;
- every key's SHA-256 its address (read back from the written file);
- each table's row digest taken by reading the written file back, every
  row after the one before it in the table's order, as an importer digests
  it;
- each lookup file read back for its row digest (in `band.json` under
  `lookups`), and derived again from the written tables to hold exactly
  the rows they give; a mismatch is the build's fault, so the band is left
  for the retry rather than rejected;
- a header check through `INDEX_EXPORT_HEADER_CHECK_URL`, as for root-TX
  bands: 150 located rows read, 50 more of each of `repaired`, `proven`,
  `absolute`, `deep` and `normalised`, and 150 of a replacement's
  `newly-located`, each from a pool ten times as large, walked until that
  many are read, passing over rows whose root the gateway no longer has
  (404, `unreadable`, out of the pass ratio). Every relocated row is read,
  and one whose root is gone leaves the band for the retry. A wrong header
  rejects the band; under 80% of those read passing, or too few verified,
  leaves it for the retry. What the sample read depends on the sample and
  the gateway, so it is the publisher's own: in `.publisher.json`
  (`headerCheck`: `sampled`, `ok`, `poolSize`, `unreadable`,
  `unreadableShare`, an estimate of the band's gone roots) and the step's
  report, never in `band.json`. A band with no located row has nothing to
  check.

`band.json` holds only what the rows and the selection determine, so the
same rows give the same file, the same torrent and the same swarm, and a
rebuild of unchanged rows publishes nothing. Its `checks` are `located`,
`unlocated` by reason, `normalised`, `repaired`, `ambiguousProven`,
`ambiguousUnlocated` and `ownersWithoutKey` (owners of the rows without a
`wallets` row). An ambiguous item left unlocated because its root answered
404 counts there as `ambiguous`, the row it is; the 404s are counted in
`.publisher.json` (`unreadable`: `proofs`, `keys`).

### Layout `l2-2`: key lookup and stats

Every band built is `l2-2`
([index-publication.md](index-publication.md#l2-key-lookup-and-stats)):
beside `l2-1`'s three lookups it carries `lookup_key.parquet`, the heights
at which each value of the index's `keyTags` occurs, and `stats.parquet`,
items and bytes per 1,000 heights by each value of its `statTags`. Both
are derived from the band's own tables after they are written, checked
against them, and recorded in `band.json` with the tag names
(`keyTags`, `statTags`). A reader accepts `l2-1` and `l2-2`.

A published band that is not `l2-2`, or whose `band.json` names other tag
names than the index is configured with, is upgraded in place: each run,
before any build and outside the time budget, derives the two files from
the band's tables into the work directory, checks them, moves them into
the band, and replaces `band.json` by a rename. The band keeps its id and
its rows, its tables and other lookups are not touched (a tag change
replaces only the two files), and nothing is read from the source or
header-checked, so a subscriber that holds the band fetches only the two
files and `band.json`. Each band is reported under the index's
`derived` (`reason`: `layout`, or `tags_changed` where the files were
replaced) and counted as `index_export_runs_total{kind="derive"}`; a
failure is logged and the builds go on. With `--range`, only the bands
inside it are upgraded; with `--dry-run`, each is derived and reported and
nothing changes.

The derive sorts the band's `tags` once per file, under
`INDEX_EXPORT_L2_DUCKDB_MEMORY` and spilling into the work directory as a
build does: minutes for a 5,000-height band, an hour or so for the
69-million-item h1.8M band of `ardrive-l2`.

**Upgrade order.** A sidecar that does not know `l2-2` cannot read an
`l2-2` band: as a subscriber it refuses the band, naming the layout, and
keeps its copy; as a publisher it cannot describe the band, so the band goes
unpublished. Upgrade subscribers first, then the publisher's `index-swarm`
with or before its `index-export`, as for `l1-3`.

### Lifecycle

L2 bands follow the [grid layout](#grid-layout) on the L1 heights, with one
difference the layout forces: an L2 band covers a whole 100,000-height
range, a whole 5,000-height sub-range, or a sub-range cut short at the top,
so the heights above the frozen bands are covered by a tip band per
sub-range rather than one tip. Every id reads `l2-h<from>-<to>-…`; which
bands are frozen is the publisher's own fact, `settledAt` in each band's
`.publisher.json`.

| Role | Range | Built | Rebuilt |
|---|---|---|---|
| `h` | A whole 100,000-height range | From the source, when the whole range has settled at once (a bootstrap, a catch-up), or as a roll once its twenty `d` bands are frozen | Only by a re-settle |
| `d` | A whole 5,000-height range | Once its top is `INDEX_EXPORT_L2_SETTLE_BLOCKS` (the root-TX settle lag, 5,040, unless set) below the source's stable top | Only by a re-settle |
| tip | Each sub-range above the frozen bands, the top one cut short at the stable top | Each daily run, superseding the band of the same start | Daily |

A run, per index: **freeze** the settled ranges, lowest first, each
replacing the tip bands of its heights (a tip band whose rows haven't
changed is kept under its id and only marked frozen); **roll** each range
of twenty frozen `d` bands into its `h`; rebuild the **tip** bands; then
**re-settle** the frozen bands due by
`INDEX_EXPORT_ROOT_TX_RESETTLE_INTERVAL_HOURS` (or all, with `--once
--resettle`).

A re-settle is gated on a fingerprint, the root-TX grid's design: per
5,000-height sub-range, one ClickHouse aggregate over every row the band's
windows read (the selected items with every column the item query reads,
the nested bundle rows, the L1 rows of their roots), and the `wallets`
rows `bundles.db` holds for the band's owners (count and XOR of hashes);
with the source's place, the selection, what places the roots and a
version as its identity. It is recorded when a band is built from the
source (a freeze, a roll, a re-settle), taken before the build. A due band
whose fingerprint is unchanged is not rebuilt (`same_sources`); one that
changed is (`changed`), and one with none recorded is rebuilt once
(`unrecorded`). `--resettle` gates, `--resettle=full` rebuilds every one.
The gateway is not in the fingerprint: a band built while it answered 404
for some reads is rebuilt on every
`INDEX_EXPORT_L2_RECHECK_UNREADABLE_EVERY` (4) re-settles the gate would
skip (`recheck_unreadable`), so roots served again get in.

Every band is rebuilt from the source, not from the bands it replaces: the
same rows give the same band, so a roll is an `h` built again and checked
against its `d` bands, and a tip whose rows haven't changed keeps its id.
Whatever a band replaces (a roll's `d` bands, a freeze's tip band, a
re-settled band), it must:

- **lose nothing**: every id of the bands it replaces is in it
  (`dropped_items`, with a sample);
- **unlocate nothing**: every (id, root) they located it locates
  (`unlocated_rows`), except one they located only under a parent their
  `parents` doesn't describe at that place (a location no reader can
  check: the parent's own row was inconsistent, #937), which it may leave
  unlocated as `no_parent`; such pairs are reported as `corrected`;
- **drop no key**: every owner they hold a key for it holds one for
  (`dropped_wallets`);
- an item located now and not before (say, a root that answered 404 then
  and serves its bytes now), or an owner keyed now, is an improvement: a
  sample of 150 such items is header-checked (`newly-located`);
- **relocate under a check**: every row they located elsewhere is
  header-checked, at most `INDEX_EXPORT_ROOT_TX_RESETTLE_MAX_CHANGED`
  (`too_many_changed`).

Rows a source loses (ClickHouse TTL) therefore stop a band's replacement
rather than leave it: the old band stays, and the run is rejected.

A run stops starting freezes and re-settles after
`INDEX_EXPORT_L2_RUN_BUDGET_MINUTES` (4 hours); the rest wait for the next
run, 15 minutes later, and so does the tip, which would otherwise span
every height the freezes left. A failed freeze stops the freezes; the tip
then still covers the heights they left, as long as those fit in the tip's
limit of sub-ranges (the settle window plus two: one failed `d` band does).
A bootstrap that fails before much is frozen leaves more, and the tip waits
for the freezes as it does after the time budget.

### Running L2 exports

```bash
# One band of each L2 index, for a look or a comparison: built and checked,
# nothing published, no state saved. --range takes a band on the grid
# (see "--range means one thing per run").
# Re-check frozen L2 bands only: --once --resettle[=full] --range <from>-<to>.
docker compose --profile index-export run --rm -T index-export \
  --once --dry-run --range 1300000-1399999 > l2-h1300000.json
# The same, keeping the band (under data/indexes) to compare its files.
docker compose --profile index-export run --rm -T index-export \
  --once --keep data/indexes/export/compare --range 1300000-1399999
```

The report lists each index under `l2`: its `plan` and, per band, the
`id`, rows per table, the band's `checks`, where the positions came from
(`stats.roots`), the proofs' outcomes, the owners' keys by source, the
comparison with the bands it replaces, and the header check.

| Metric | Read it as |
|---|---|
| `index_export_runs_total{index="<name>",kind,result,reason}` | Outcomes per role (`h`, `d`, `tip`) |
| `index_export_l2_rows{index,kind,table}` | Rows of the latest band of a role |
| `index_export_l2_unlocated_rows{index,kind,reason}` | Its unlocated items, by reason |
| `index_export_l2_owners_without_key{index,kind}` | Its owners without a key |
| `index_export_l2_proofs_total{index,outcome}` | Ambiguous items by how their headers settled them: `relative`, `absolute`, `none`, `both` |

Alert on the tip:
`index_export_last_success_timestamp_seconds{index="ardrive-l2",kind="tip"}`.

### L2 limits

- Only ClickHouse is read. A `bundles.db` source (`stable_data_items`, its
  tags and `wallets`) would fit the same source interface
  (`kinds/parquet-l2/source.ts`); it is not built yet.
- ClickHouse keeps an item's tags without empty names and without their
  positions; a band numbers them in order. An item with an empty-named tag
  is written with the tags ClickHouse holds.
- An ambiguous nested bundle is not proven, so it gets no `parents` row
  (its items are unlocated by the chain rule anyway).
- The top tip band changes range, so id, every run the source's top moves.
- An item ClickHouse files above its root's height refuses the band
  (`roots`, `below`), since its root's window is written by the time it is
  read.

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
| `index_export_l2_*` | L2 bands: see [Running L2 exports](#running-l2-exports) |

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
