# CDB64 root-TX index

A CDB64 index maps a data item ID to where the item lives in its root
transaction: the root transaction ID, the item's offsets in it, and the
bundle path for nested items. The gateway reads these indexes to find a
nested data item without asking another service. Lookups are constant time,
by hash, and a reader keeps only each file's 4 KiB header in memory.

Related pages:

| Document | For |
| --- | --- |
| [CDB64 tools](cdb64-tools.md) | Building indexes from CSV, SQLite or bundle scans |
| [CDB64 format](cdb64-format.md) | The file, value and partitioned-index formats |
| [Index Sharing](index-swarm.md) | Receiving bands from other gateways, and publishing them |

## Contents

- [How the gateway uses it](#how-the-gateway-uses-it)
- [Configuration](#configuration)
- [Source types](#source-types)
- [Watching for changes](#watching-for-changes)
- [Remote sources](#remote-sources)
- [Publishable bands](#publishable-bands)
- [Troubleshooting](#troubleshooting)

## How the gateway uses it

A request for a data item needs the item's root transaction and its offsets.
`ROOT_TX_LOOKUP_ORDER` lists the sources asked for them, in order: `db` (the
local index), `cdb` (CDB64 indexes), `gateways`, `graphql`, `hyperbeam` and
others. The default is `db,gateways,graphql,hyperbeam,cdb`, so CDB64 is
enabled but asked last. A gateway with local indexes, such as installed
bands, gains most with `cdb` right after `db` (see
[lookup order](index-swarm.md#lookup-order)):

```bash
ROOT_TX_LOOKUP_ORDER=db,cdb,gateways,graphql
```

Drop `hyperbeam` unless the `hb` profile runs. Removing `cdb` turns CDB64
lookups off. Changing the order needs a gateway restart.

Each entry can carry:

| Field | Description |
| --- | --- |
| `rootTxId` | The L1 transaction that holds the item |
| `rootOffset` | Offset of the item's header within the root transaction's data |
| `rootDataOffset` | Offset of the item's payload within the root transaction's data |
| `size` | Total item size, header and payload (optional) |
| `path` | Bundle path from the root to the item's parent, for nested bundles |

Several CDB64 sources are searched in the order configured, and the first
match wins.

### Lookup short-circuiting

The composite root TX index (`ROOT_TX_LOOKUP_ORDER`) stops probing sources as
soon as one returns an **actionable** result, so a CDB64 hit early in the order
avoids the remaining (often remote and expensive) sources such as GraphQL. A
result is actionable when the caller can proceed without further lookups:

| Exit reason        | Condition                                             | Notes                                             |
| ------------------ | ----------------------------------------------------- | ------------------------------------------------- |
| `complete_offsets` | `rootOffset` + `rootDataOffset` + `size` + `dataSize` | One header check; bundle search only if it fails  |
| `l1_root`          | `rootTxId === id`                                     | Definitive L1 root; passthrough                   |
| `offsets`          | `rootOffset` + `rootDataOffset` present               | The CDB64 case; see [Item size](#item-size)       |
| `path`             | non-empty `path`                                      | Enables path-guided bundle navigation             |
| `caller_accept`    | `opts.accept(result) === true`                        | Caller-provided predicate accepted the result     |

A caller may override this decision by passing an `accept` predicate to
`getRootTx` (short-circuiting on whatever it deems sufficient — e.g. any
`rootTxId` it will resolve offsets from locally); such short-circuits are
recorded with the `caller_accept` exit reason.

A bare `rootTxId` with no path or offsets is **not** actionable — it is saved as
a fallback and the search continues, so a later source (e.g. CDB64) can supply a
path or offsets. If no source is actionable, the saved fallback is returned
(`fallback`), or `undefined` if nothing resolved (`not_found`).

CDB64 values never carry `dataSize` or the item's content type, so CDB64 hits
terminate with the `offsets` (or `path`) reason rather than `complete_offsets`.

### Item size

An offset tells the gateway where a data item starts, but not where it ends.
CDB64 values can optionally record the total item size (`s`, header + payload;
the `data_item_size` CSV column), and whether they do decides how an `offsets`
hit is served:

| Value carries          | How the item is located                                                                                   | Reads before the payload |
| ---------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------ |
| offsets + item size    | Reads the item header at `rootOffset`, checks that its signature hashes to the requested ID and that the header ends at `rootDataOffset`, takes the payload size and content type from it, then serves the payload only if the item's signature verifies over it | 1 (bounded item header)  |
| offsets only           | Searches the root bundle header for the item (item count, ID index, item header), as for a bare `rootTxId` | 3 or more                |

If the header check fails (wrong ID, or a header that does not end at
`rootDataOffset`), the gateway falls back to the bundle search. The recorded
size itself can only be checked against the payload, so the payload streams
through signature verification: its final bytes are released only once the
item's signature verifies, and the offsets are saved only then. A wrong size
therefore ends the response short instead of completing it, and later requests
for that entry use the bundle search. Range requests always use the bundle
search, because a range cannot be verified end to end. Outcomes are counted in
`data_item_signature_verification_total{source="root_tx_index"}`. Each resolution is counted in
`root_tx_local_resolve_total{outcome}`; `index_offsets` counts items located from
the recorded size. The size is optional and ignored by readers that predate it,
so indexes that include it remain readable by older gateways.

A complete location (item offset, payload offset and payload size), whether
from an index or from stored data attributes, gets the same header check before
any bytes are read from it. The same item can exist under one ID in several
bundles. Chunk verification only proves that bytes belong to the root, not
that they are this item. Without the check, a root paired with another
copy's offset would serve the wrong bytes marked verified
([#937](https://github.com/ar-io/ar-io-node/issues/937)). A header read cannot
confirm the payload size, since the header does not record it. A location that
is not confirmed is not served, and one from an index is not stored; resolution
continues with the bundle search (for stored attributes, only when
`ENABLE_DATA_ITEM_ROOT_TX_SEARCH` is on). A rejected stored location is not
removed, so it is checked again on each uncached request.

A location can also fail because its root is not an L1 transaction but a
bundle that is itself a data item: the item was recorded relative to the
bundle it sits in, one level too shallow
([#959](https://github.com/ar-io/ar-io-node/issues/959)). Its bytes are
correct, but the header cannot be read from a data item as if it were an L1
transaction. When a header cannot be read at all, the gateway looks the
recorded root up as a bundle (its stored attributes, then the root TX index)
and adds the bundle's payload offset. It then checks the header again at the
resulting location in the enclosing root, walking up to 10 enclosing
bundles. The root
TX index lookup follows `ROOT_TX_LOOKUP_ORDER`: with `cdb` early in the order,
CDB64 answers it locally; with the default order it reaches remote sources
first. The recovery runs at most once per location per request. It also runs
when a correctly rooted item's header read fails (an upstream outage), where
it costs one root TX lookup for the root; roots that were read but hold the
wrong header never take it.

A recovered location's header is confirmed, but its payload size is not. A
full read is therefore served through signature verification, and the
location is stored only once the payload verifies. A location whose payload
fails is not offered again for an hour. A range request is served from the confirmed location but
not stored, since it cannot be verified end to end. Outcomes are counted in
`data_item_signature_verification_total{source="rebased_location"}`.

Header checks are counted in
`data_item_location_check_total{source,result,reason}`, where `source` is
`stored_attributes`, `attributes_traversal`, `root_tx_index` or
`root_tx_index_fallback`, or one of the first three with a `_rebased` suffix
for recovered locations, and `result` is `confirmed` or `rejected`. A
rejection's `reason` is one of three. `header_unreadable` means no header
could be parsed there: the read failed, for example because the root is a
bundled data item, or the bytes are not a header. `id_mismatch` means the
header belongs to another item. `offset_mismatch` means the header is the
item's but does not end at the recorded payload offset. Both `id_mismatch` and `offset_mismatch` are locations that
would have served wrong bytes; `header_unreadable` is usually a read failure
or a mis-rooted nested item.

Observability (per-node Prometheus metrics):

- `composite_root_tx_exit_reason_total{reason,winning_source}` — one increment
  per lookup, labelled with the exit reason above. A healthy CDB64 deployment
  shows most CDB64-won lookups exiting on `offsets`/`path`.
- `composite_root_tx_sources_probed` — summary of how many sources were queried
  before returning. Effective short-circuiting keeps this low.
- `root_tx_lookup_total{source="graphql"}` — total GraphQL probes; falls sharply
  once early local sources (db/cdb) short-circuit.
- `root_tx_lookup_total{source="cdb64",status="found",has_offsets,has_size}` —
  what each index hit returned. `has_offsets="true"` means both root offsets
  came back; `has_size="true"` means the item size did too, which lets the
  item be served with one ID-verified header read. An index built without
  offsets shows up as `has_offsets="false"`. The labels apply to every
  source, not only `cdb64`; for an L1 root (for example from `turbo`),
  `has_size` reflects the transaction's data size rather than an item's. (Before this label was fixed it
  also required `dataSize`, which a CDB64 index never returns, so every index
  hit read `"false"`.)

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `CDB64_ROOT_TX_INDEX_SOURCES` | The three shipped indexes in `resources/` (below) | Comma-separated sources, searched in order |
| `CDB64_ROOT_TX_INDEX_WATCH` | `true` | Load and unload local indexes as they change, without a restart |
| `ROOT_TX_LOOKUP_ORDER` | `db,gateways,graphql,hyperbeam,cdb` | Order of root-TX sources; `cdb` is CDB64 |
| `CDB64_REMOTE_RETRIEVAL_ORDER` | `chunks` | How Arweave-hosted index files are fetched: `gateways`, `chunks`, `tx-data` |
| `CDB64_REMOTE_CACHE_MAX_REGIONS` | `100` | Cached byte ranges per remote source |
| `CDB64_REMOTE_CACHE_TTL_MS` | `300000` | How long a cached byte range is kept (5 minutes) |
| `CDB64_REMOTE_REQUEST_TIMEOUT_MS` | `30000` | Timeout for one remote read (30 seconds) |
| `CDB64_REMOTE_MAX_CONCURRENT_REQUESTS` | `4` | Concurrent remote reads: one limit shared by every remote source |
| `CDB64_REMOTE_SEMAPHORE_TIMEOUT_MS` | `5000` | How long a remote read waits for a free slot |

The shipped default is three indexes up to height 1,820,000. Their manifests
are in `resources/`, and their partitions are read from Arweave on demand.
They cover non-AO, non-Redstone data items with a content type, the same
without one, and AO data items. They carry no offsets.

```text
resources/cdb64-root-tx-index-non-ao-non-redstone-with-content-type-to-height-1820000,resources/cdb64-root-tx-index-non-ao-non-redstone-without-content-type-to-height-1820000,resources/cdb64-root-tx-index-ao-to-height-1820000
```

Setting `CDB64_ROOT_TX_INDEX_SOURCES` replaces this list. To add a source and
keep the shipped indexes, write them out after it. Compose mounts
`./data/cdb64-root-tx-index` (`CDB64_ROOT_TX_INDEX_DATA_PATH`) into the
container at `data/cdb64-root-tx-index`; it is searched only when listed.

## Source types

| Source | Example |
| --- | --- |
| Local file | `/path/to/index.cdb` |
| Local directory of `.cdb` files | `/path/to/indexes/` |
| Local partitioned index (`manifest.json` and its partitions) | `/path/to/partitioned-index/` |
| Local collection (a directory of partitioned indexes) | `data/indexes/installed/root-tx-index` |
| HTTP file | `https://example.com/indexes/root-tx.cdb` |
| HTTP partitioned index | `https://example.com/indexes/manifest.json` |
| Arweave transaction | `<43-character transaction ID>` |
| Arweave byte range (a file inside a bundle) | `<root TX ID>:<offset>:<size>` |
| Arweave partitioned index | `<manifest TX ID>:manifest`, or `<root TX ID>:<offset>:<size>:manifest` |

A local directory loads every `.cdb` and `.cdb64` file in it. A directory
holding `manifest.json` is loaded as one partitioned index. HTTP sources must
support `Range` requests.

### Collection directory

A collection is a directory whose subdirectories are each a partitioned
index:

```text
indexes/
  band-0-1349999/
    manifest.json
    00.cdb ... ff.cdb
  band-1350000-1849999/
    manifest.json
    00.cdb ... ff.cdb
```

Each subdirectory holding a `manifest.json` is loaded as its own index, so a
collection suits indexes that arrive and retire over time. The `index-swarm`
sidecar installs bands this way. Subdirectories whose names end in `.tmp`
are skipped, so a writer can build an index and rename it into place. A
collection is detected at runtime, and the same directory may also hold
loose `.cdb` files.

A local source that is missing and not named like a `.cdb` file is checked
for every 30 seconds and loaded once it appears, so a gateway can start
before the sidecar has created its install directory.

## Watching for changes

With `CDB64_ROOT_TX_INDEX_WATCH=true` (the default), every configured local
directory is watched:

- a `.cdb` file added to a directory is loaded, and one removed is unloaded;
- a partitioned index is reloaded when its `manifest.json` is replaced (by
  an atomic rename);
- in a collection, a band renamed into place loads within a second or so,
  and one removed has its reader dropped. A reader being retired leaves the
  lookup order first and closes only once the lookups inside it finish, so
  a request in flight never misses.

`cdb64_root_tx_index_readers` reports open readers per configured source; for
a collection, that is the number of bands loaded. Set
`CDB64_ROOT_TX_INDEX_WATCH=false` only for indexes that never change.

## Remote sources

HTTP and Arweave sources are read by byte range, with a cache of recent
ranges (`CDB64_REMOTE_CACHE_*`). Arweave-hosted files are fetched through
`CDB64_REMOTE_RETRIEVAL_ORDER`: by default `chunks`, which rebuilds the file
from L1 chunks. Add `gateways` to try trusted gateways first, or `tx-data`
for an Arweave node's transaction data endpoint, which is slower:

```bash
CDB64_REMOTE_RETRIEVAL_ORDER=gateways,chunks
```

All remote sources share `CDB64_REMOTE_MAX_CONCURRENT_REQUESTS`. Raise it for
a fast CDN; lower it for a rate-limited endpoint. Raise
`CDB64_REMOTE_REQUEST_TIMEOUT_MS` on a high-latency link.

## Publishable bands

A band published through [Index Sharing](index-swarm.md) is a partitioned
index whose partitions are all local files. The `index-export` service builds
them on a schedule (see [index-export.md](index-export.md)). To build one by
hand, use [`ar-io-node index-band-build`](cli.md#index-band-build), which
header-checks a sample before publishing, and
[`index-band-verify`](cli.md#index-band-verify) to check any band. Without the
CLI, `export-sqlite-to-cdb64 --partitioned` ([CDB64 tools](cdb64-tools.md))
writes the same format from the local database (see
[building a band by hand](index-export.md#building-a-band-by-hand)).

## Troubleshooting

**`Failed to initialize CDB64 source`.** Check that the file exists and the
gateway can read it, that it ends in `.cdb` or `.cdb64`, and that it is a
valid CDB64 file.

**New files are not picked up.** Check that `CDB64_ROOT_TX_INDEX_WATCH` is
not `false`, and the file extension. The logs show
`CDB64 file watcher started`, `CDB64 file added` and `CDB64 source removed`.

**Installed bands are loaded but lookups still go to the network.** `cdb`
comes after the network sources in `ROOT_TX_LOOKUP_ORDER`; put it right after
`db`. `composite_root_tx_exit_reason_total{winning_source}` shows which
source answers.

**Timeouts or connection errors on remote sources.** Check the network path
and that HTTP sources answer `Range` requests. Raise
`CDB64_REMOTE_REQUEST_TIMEOUT_MS`, or add `gateways` to
`CDB64_REMOTE_RETRIEVAL_ORDER`.

**`Manifest contains file locations` for an Arweave source.** A manifest
fetched from Arweave cannot name local files. Use `arweave-id`,
`arweave-byte-range` or `http` locations for every partition.

**High memory use.** A reader keeps only the 4 KiB header in memory. Check
the number of open index files and the remote cache settings.
