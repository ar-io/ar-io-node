# Verifying index bands

Index bands are signed and content-addressed. Anyone holding a set of them (a
subscriber that installed them, a publisher before it publishes, an operator or
an agent asked whether an index is sound) can check them without trusting
whoever produced them. This page says which command checks which kind of index,
what each check proves and what it does not, and how to reproduce or repair a
band that fails.

Every command here is read-only and runs through the `ar-io-node` wrapper (see
[cli.md](cli.md#running-it)). Output follows the
[CLI contract](cli.md#the-contract): the result as JSON on stdout and exit 0; on
failure, the full result on stderr and exit 1.

## Which tool, for which index

| Index                            | Holds                                                                       | Check it with                                                                               | Proves                                                                                                                                                                                                        | Does not prove                                                                                                                                                               |
| -------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `root-tx-index` (CDB64)          | each data item's root transaction and offsets                               | [`index-band-verify`](cli.md#index-band-verify)                                             | sampled entries' headers sit at their recorded offsets, in their root transactions                                                                                                                            | entries not sampled; root-only entries' roots                                                                                                                                |
| `parquet-l1`                     | blocks, L1 transactions, their tags and owners                              | [`index-l1-verify`](cli.md#index-l1-verify), then [`index-l1-audit`](cli.md#index-l1-audit) | every block's place in the chain, against the weave size the chain commits to; every block's `tx_root` rebuilt from its transactions; lookups. `index-l1-audit` closes the v1-transaction gap `tx_root` can't | that a transaction id is in the block (`tx_root` doesn't bind ids; the audit checks each v1 id against its signature)                                                        |
| `parquet-l2` (e.g. `ardrive-l2`) | the ANS-104 data items one selection takes, with tags, owners and locations | [`index-l2-verify`](cli.md#index-l2-verify)                                                 | every band's id against its contents; the set has no overlaps or holes; every table row by row; every location's layout and parent link; the lookups; a sample of locations against the chain                 | that every item the selection should take is there (completeness is the publisher's to show, by comparing against its source; see [Reproducing a band](#reproducing-a-band)) |

## Reading from the chain: `--arweave-nodes`

`index-band-verify --arweave-nodes` and `index-l2-verify` (by default) read root
transactions **from Arweave nodes, proving every byte**, so the check trusts no
gateway, this one included:

1. **The root's id is bound to its data.** Its header's signature must hash to
   its id, and the signature must verify, since a transaction signs its
   `data_root` and `data_size`. arweave-js fails to verify a few valid
   transactions; for those, at least two nodes must serve the same `data_root`
   and `data_size` instead. The result says which (`bySignature`,
   `byAgreement`). Agreement is weaker: the default pool's nodes are all run
   by one operator, so a root bound by agreement trusts that operator.
2. **Its place in the weave** comes from `/tx/{id}/offset`, whose size must be
   the signed `data_size`.
3. **Every chunk is proven.** Its `data_path` must validate against the signed
   `data_root` under the consensus rules for its weave offset (strict data split
   above 30.6T bytes, rebasing above 151T). The chunk must hash to the path's
   leaf, and it is placed by the bounds the proof gives, never by assuming 256
   KiB chunks. A node whose chunk fails is passed over for the next. A wrong
   `/tx/{id}/offset` can't pass wrong bytes: the chunks it leads to would not
   prove against the root's `data_root`.

What a header read comes to, as every header check sorts it:

| Outcome      | Means                                                                                             | Counts                                            |
| ------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `ok`         | the bytes at the recorded location are a data item header whose signature hashes to the item's id | for the band                                      |
| `wrong`      | something else is there, or the range runs past the root                                          | **against** the band: its offsets are wrong       |
| `unreadable` | every node that answered said 404 for the root, or for the chunk holding the header: data gone network-wide (unseeded or purged) | neither way; another sample is taken in its place |
| `errors`     | nothing usable came back: nodes busy or failing (429, 5xx), a chunk no node could prove, no node reachable, a root that can't be bound | against the pass ratio; rerun                     |

A 404 counts only when **every** node that answered said 404 (a node that has a
chunk only packed counts as not having it). One busy node (429, 5xx) among
them, or one whose chunk failed its proof, makes it an error instead: that node
may hold the data, and an unprovable chunk is the node's fault, not an absence.
A missing chunk is that item's alone; a missing root (header or offset) is
every item's under it.

The default pool is the `tip` and `data` nodes ar-io-node reads chunks from
(`PREFERRED_CHUNK_GET_NODE_URLS`'s default). `data` nodes each hold a partition
of the weave, so most answer 404 for most offsets; that is normal. The node
that proved a root's last chunk is asked first for its next. Name your own
with `--arweave-nodes http://a:1984,http://b:1984`. With `--gateway-url`
instead, roots are read through that gateway's `/raw`: faster, but that gateway
is trusted.

An L2 item's `offset` is relative to its parent bundle's payload: the header
starts at `root_parent_offset + offset` in the root. For an item directly in its
root, `root_parent_offset` is 0.

## `parquet-l2`: what `index-l2-verify` checks

```bash
./tools/ar-io-node index-l2-verify --bands-dir data/indexes/installed/ardrive-l2 \
  --publisher 34LYvMptiDvBP5sqfh1oAd6Q4qFsy4PWaZ1HTFmML7h5
```

| Check       | Fails when                                                                                                                                                                                                                                                                                                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity`  | a band's id doesn't name its heights, or its digest isn't that of its heights, selection and rows (`bandTablesDigest`), or, with `--publisher`, the tag isn't the publisher's. The id is what a publication signs, so this ties the signature to the bytes                                                                                                                          |
| `selection` | the bands hold different selections                                                                                                                                                                                                                                                                                                                                                 |
| `files`     | a band lacks a file its layout requires, or holds one it doesn't                                                                                                                                                                                                                                                                                                                    |
| `tables`    | a table's rows, read in file order, are out of their table's order, or don't digest to what `band.json` says, or an owner key doesn't hash to its address                                                                                                                                                                                                                           |
| `locations` | a location is partly set; or isn't laid out as ANS-104 requires (signature right after the 2-byte type, owner right after the signature, payload after the owner and inside the item); or `data_size` isn't the payload the location gives; or the signature or owner length isn't its type's; or an id, address or root isn't 32 bytes; or an item lies outside its band's heights |
| `parents`   | an item directly in its root isn't at offset 0 of it, or an item in a nested bundle names one `parents` doesn't describe where the item says its payload starts, or a `parents` row's payload doesn't start inside it (offsets taken from another copy of the bundle)                                                                                                         |
| `lookups`   | a lookup file doesn't hold exactly the rows its tables give (`--skip-lookups` leaves this out)                                                                                                                                                                                                                                                                                      |
| `onchain`   | a sampled item's header, read at its recorded location, is not that item, or too few could be verified (`--onchain <n>` items per band, default 20; `0` leaves it out). Items directly in their roots and items in nested bundles are sampled apart, half each, so rare nested items are always read. `--seed` repeats a run; the result reports the seed it drew. A band whose items have no locations has nothing to read and is listed under `unlocatedBands` |

The set is refused outright (exit 1, no checks run) if its bands overlap or
leave a hole: that is not one index. `--from` and `--to` check only the bands
inside those heights. A publisher's published directory may hold a replaced tip
band beside its replacement until it is pruned: a band its own publisher's
newer band supersedes (`.publisher.json`) is left out, as a subscriber leaves
it out, and listed under `superseded`.

**Cost.** Every row is read, in file order, so memory stays flat; the large
lookups spill to the system temp directory (at most 16 GB). On one host, a
6.8-million-item band (h1.3M of `ardrive-l2`, 49.7M tags) took about 6 minutes,
and the whole 128-million-item `ardrive-l2` index about 2½ hours, most of it the
69-million-item h1.8M band. The on-chain sample adds seconds per band.

## Reproducing a band

A band's id is a digest of its heights, selection and rows. A publisher (or
anyone with the same source data) can rebuild a band and compare ids; equal ids
are equal rows:

```bash
# Rebuild one band into a staging directory, publishing nothing:
docker compose run --rm --no-deps index-export --once --keep data/indexes/export/staging \
  --range 1300000-1399999
# Compare: the staging band's id against the published one.
ls data/indexes/export/staging/ardrive-l2/ data/indexes/published/ardrive-l2/ | grep h1300000
```

`--range` builds exactly one band of the grid. The rebuild reads the source the
publisher's `index-export` reads (`INDEX_EXPORT_L2_SOURCE`), so a source that
has changed since (new items backfilled, offsets repaired) gives a new id, which
is what re-settling publishes. Compare against the source as of the same time,
or diff the two bands' rows, not just their ids.

## Repairing a band

| Found                                                            | Do                                                                                                                                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `identity`, `files` or `tables` failure in an **installed** band | the copy is damaged or not what was signed: remove it and let the sidecar fetch it again; if it recurs, tell the publisher                             |
| the same in a **published** band                                 | rebuild it (`--range`, above), check the rebuild, and publish it in its place (`index-export --once --resettle --range <from>-<to>` for a frozen band) |
| `locations`, `parents` or `onchain` `wrong`                      | the builder placed items wrongly, or its source holds a wrong row: report it upstream with the band id and the failures; the publisher repairs the source, then rebuilds and re-settles the band |
| many `unreadable`                                                | not a fault of the index: every node said 404, so the data is gone network-wide. Seeding the missing chunks again (where the data still exists) makes them readable |
| many `errors`                                                    | rerun (nodes were busy); if a chunk keeps failing its proof, the nodes serving it are at fault, not the index                                       |
| `lookups`                                                        | the lookups are derived: rebuilding the band rewrites them                                                                                             |

For `root-tx-index` bands, `index-export --once --resettle[=full]` re-checks and
replaces frozen bands whose sources changed (see
[index-export.md](index-export.md)). For `parquet-l1`, see
[`index-l1-verify`](cli.md#index-l1-verify) and
[`index-l1-import`](cli.md#index-l1-import).

## For agents

Run the command, read stdout (or stderr on exit 1) as JSON, and act on `ok` and
each check's `failures`. Each failure names the band (`found` starts with its
id) and the height it starts at. `onchain` adds counts (`checked`, `ok`,
`wrong`, `unreadable`, `errors`) and, under `roots`, how the roots were read and
bound. `unreadable` is never a fault of the index; `errors` are never a verdict
on it either way, so rerun before acting on them. Never treat a passing sample
as proof of every row: the row-by-row checks are what cover every row.
