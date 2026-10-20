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
| `parquet-l2` (e.g. `ardrive-l2`) | the ANS-104 data items one selection takes, with tags, owners and locations | [`index-l2-verify`](cli.md#index-l2-verify) | that the bands agree with themselves: every id against its contents, the set has no overlaps or holes, every file's shape, every table row by row, every required value, every location's layout and parent link, tags and keys against items, every item against the selection, the lookups; with `--publication`, that every file is the one its publisher signed; with an L1 index, that every root is mined where its items say; a sample of locations against the chain | without `--publication`, who published the bands (the id is a 48-bit digest, a name, not a signature); that every item the selection should take is there (completeness is the publisher's to show, by comparing against its source; see [Reproducing a band](#reproducing-a-band)) |

## Reading from the chain: `--arweave-nodes`

`index-band-verify --arweave-nodes` and `index-l2-verify` (by default) read root
transactions **from Arweave nodes, proving every byte**, so the check trusts no
gateway, this one included:

1. **The root's id is bound to its data.** Its header's signature must hash to
   its id, the header must be **format 2** (only a format-2 signature covers
   `data_root` and `data_size`; a format-1 header that carries a `data_root`
   carries it unsigned, so it is refused), and the signature must verify.
   arweave-js fails to verify a few valid transactions; such a root is an
   error unless `--allow-agreement` is given, and then at least two other
   machines (not the one that served the header, and not each other, by
   resolved address) must serve a header for the same id, itself format 2
   and hashing to the id, with the same `data_root` and `data_size`. The
   result says which (`bySignature`, `byAgreement`). Agreement is weaker:
   the default pool's nodes are all run by one operator, so a root bound by
   agreement trusts that operator.
2. **The root is mined.** A signature proves who signed a transaction, not
   that the chain took it: anyone can sign a transaction, serve it from one
   node of their own, and never post it. At least two nodes on distinct
   machines (a machine is a resolved address; two ports of one address are
   one machine) must place the root in one block with a confirmation
   (`/tx/{id}/status`), and `index-l2-verify` requires that block to be at
   the height the band gives its items. The status says nothing of where in
   the block the root is: that position is not checked this way, and the
   result says so (`roots.checks`, `assurance`). Every node that names a
   block must name the same one (`minedByNodes`). Too few machines placing
   it while others say it is in no block **refutes** the root; nodes naming
   different blocks is an error; every node saying it is in no block makes
   it `missing`. `index-l2-verify` can instead find **every** root of a
   band in an L1 index, height and position both (`--l1-bands-dir`, below).
3. **Its place in the weave** comes from `/tx/{id}/offset`, whose size must be
   the signed `data_size`.
4. **Every chunk is proven.** Its `data_path` must validate against the signed
   `data_root` under the consensus rules Arweave applies to the root's block
   (`ar_poa`: never laxer than strict borders; strict data split from 30.6T
   bytes, rebasing from 151T), taken from the root's own start, so every
   chunk of a root is checked under one ruleset. (A root in one of the two
   blocks that straddle a threshold may be held to the later rules: a valid
   proof refused there is an error, never a pass.) The chunk must hash to
   the path's leaf, and it is placed by the bounds the proof gives, never by
   assuming 256 KiB chunks. A node whose chunk fails is passed over for the
   next. A wrong `/tx/{id}/offset` can't pass wrong bytes: the chunks it
   leads to would not prove against the root's `data_root`.

What a header read comes to, as every header check sorts it:

| Outcome      | Means                                                                                             | Counts                                            |
| ------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `ok`         | the bytes at the recorded location are a data item header whose signature hashes to the item's id | for the band                                      |
| `wrong`      | something else is there, or the range runs past the root; or the chain **refutes** the root: no `data_root`, format 1, another transaction's header, a signature that doesn't verify (without `--allow-agreement`), not mined, or in a block at another height than the band says | **against** the band: one fails it |
| `missing`    | `index-l2-verify` only: every node that answered said 404 for the root itself (its header, its place, its block): a root id made up, or never mined. A node that timed out or was busy is asked once more; still busy, it is left out, so a slow node never turns a missing root into a tolerated error | **against** the band: one fails it |
| `unreadable` | every node that answered said 404 for the chunk holding the header: data gone network-wide (unseeded or purged). For `index-band-verify`, a root gone this way too | neither way, and another sample is taken in its place; `index-l2-verify` fails a band where more than `--max-unreadable-share` (20%) of the items tried are unreadable |
| `errors`     | a failure to check, never a refutation: nodes busy or failing (429, 5xx) and nothing else said, a chunk no node could prove, no node reachable, nodes naming different blocks, a read still pending at the band's deadline | against the pass ratio; rerun. `onchain.bands[].errorSample` shows a few per band |

A 404 counts only when **every** node that answered said 404 (a node that has a
chunk only packed counts as not having it). One busy node (429, 5xx) among
them, or one whose chunk failed its proof, makes it an error instead: that node
may hold the data, and an unprovable chunk is the node's fault, not an absence.
A missing chunk is that item's alone; a missing root (header or offset) is
every item's under it.

The default pool is the `tip` and `data` nodes ar-io-node reads chunks from
(`PREFERRED_CHUNK_GET_NODE_URLS`'s default). `data` nodes each hold a partition
of the weave, so most answer 404 for most offsets; that is normal. The node
that proved a root's last chunk is asked first for its next; otherwise each
request starts at the next node in turn. A node that times out or refuses a
connection rests for five minutes and is not asked; while it rests, one that
timed out counts as busy (it may hold the data), so its silence is never read
as missing data. Each band's reads have a deadline (`--band-deadline`, 20
minutes): reads still pending then are errors, and the band fails. Name your own
with `--arweave-nodes http://a:1984,http://b:1984`. With `--gateway-url`
instead, roots are read through that gateway's `/raw`: faster, but that gateway
is trusted.

An L2 item's `offset` is relative to its parent bundle's payload: the header
starts at `root_parent_offset + offset` in the root. For an item directly in its
root, `root_parent_offset` is 0.

## `parquet-l2`: what `index-l2-verify` checks

```bash
./tools/ar-io-node index-l2-verify --bands-dir data/indexes/installed/ardrive-l2 \
  --publication https://turbo-gateway.com/ar-io/indexes/publication.json \
  --registry-url http://core:4000
```

The verifier fails closed. A check it ran passes only on everything it was
meant to read; anything it could not check whole is a failure, and anything
it did not check at all is named in `skipped`. **`ok` means every check that
ran passed; read it with `skipped`, `publisherBound` and `assurance`**
(sentences saying what the run did and did not bind the bands to).

| Check         | Fails when                                                                                                                                                                                                                                                                                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `coverage`    | a height `--from`/`--to` asks for lies in no band checked (a band only partly inside the range is not checked) |
| `identity`    | a band's id doesn't name its heights (canonical decimals, no leading zeros), or its digest isn't that of its heights, selection and rows (`bandTablesDigest`), or, with `--publisher` (or `--publication`), its tag isn't the publisher's, compared exactly. **Internal consistency only**: the digest in an id is 48 bits, a name and not a security binding, and anyone can recompute it for rows of their own. Nothing but `--publication` ties bands to a publisher |
| `publication` | with `--publication`: a band isn't listed in the publisher's signed publication, or holds other files than the ones listed, or a file's size or SHA-256 (hashed whole, streamed) isn't the signed one. The publication must be signed by the key `--publisher-key` names, or the key the registry gives for its publisher (`--registry-url`, as the index-swarm sidecar resolves it); one that isn't refuses the run |
| `selection`   | the bands hold different selections                                                                                                                                                                                                                                                                                                                                                 |
| `files`       | a band lacks a file its layout requires, or holds one it doesn't; or an entry of the directory (any name not starting with `.`, symlinks followed) is not a band that reads whole: not a directory, no `band.json`, one that doesn't parse, an unreadable `.publisher.json`, an I/O error                                                                                           |
| `schema`      | a Parquet file has other columns, in another order or of other types, than its layout's, or a footer a reader won't parse (`checkParquetFile`, as the sidecar checks an installed band). The band's other checks are not run: rows of the wrong shape would only mislead                                                                                                            |
| `tables`      | a table's rows, read in file order, are out of their table's order, or don't digest to what `band.json` says, or an owner key doesn't hash to its address                                                                                                                                                                                                                           |
| `required`    | a value the layout always sets is NULL: an item's id, height, block index, root, parent, owner, `data_size` or `tag_count`; any column of `tags`, `wallets` or `parents`                                                                                                                                                                                                             |
| `locations`   | a location is partly set; or isn't laid out as ANS-104 requires (signature right after the 2-byte type, owner right after the signature, payload after the owner and inside the item); or `data_size` isn't the payload the location gives; or the signature or owner length isn't its type's; or an id, owner, root or parent isn't 32 bytes; or an item is its own root; or an item lies outside its band's heights. A NULL never passes a predicate |
| `parents`     | an item directly in its root isn't at offset 0 of it, or an item in a nested bundle names one `parents` doesn't describe where the item says its payload starts, or a `parents` row's payload doesn't start inside it (offsets taken from another copy of the bundle), or its id or root isn't 32 bytes                                                                         |
| `consistency` | a tag row belongs to no item of the band at its height, or lies outside the band's heights; an item's `tag_count` isn't its number of tag rows; a key in `wallets` is no item owner's; or more owners have no key than the band's `checks.ownersWithoutKey` says (a builder leaves out a key it could not find, and says so)                                                       |
| `located`     | a band's unlocated items (no location, so nothing to read on chain) are not exactly the number its `band.json` declares (`checks.unlocated`, summed over its reasons), or are more than `--max-unlocated-share` of its items (0.001; the most measured in a real `ardrive-l2` band is 0.00035). `--allow-unlocated` passes a band whose items are all unlocated, as declared. Each band's counts are under `located` |
| `selected`    | an item has no tag the band's selection takes (the name byte for byte, the value starting with `valuePrefix` and not `excludeValuePrefix`, as the exporter selects)                                                                                                                                                                                                                  |
| `lookups`     | a lookup file, read in the order it holds its rows, is out of its key's order (a reader's search over its row groups would miss keys), or doesn't digest to what `band.json` says, or doesn't hold exactly the rows its tables give (`--skip-lookups` leaves this out)                                                                                                            |
| `mined`       | with an L1 index: a root isn't in the index's `block_transactions` at the height its items give, or is there at another `block_transaction_index`. Every root of every band, not a sample                                                                                                                                                                                          |
| `onchain`     | a sampled item's header, read at its recorded location, is not that item; a sampled root is `missing`; more than `--max-unreadable-share` of the items tried are unreadable; too few could be verified; the band's deadline passed; or the band has items but none located, so nothing of it can be read on chain (`--allow-unlocated` passes such a band). `--onchain <n>` items per band, default 20; `0` leaves it out. Items directly in their roots and items in nested bundles are sampled apart, half each, so rare nested items are always read. `--seed` repeats a run exactly (the sample, and the order it is read in, both seeded per band by its id); the result reports the seed it drew |
| `complete`    | a band could not be read to the end of its checks: a file vanished mid-run, an I/O or DuckDB error. That band fails and the run goes on to the next; the full result is always written                                                                                                                                                                                             |

**Bound to a publisher: `--publication`.** Without it, `publisherBound` is
`false` and `publication` is in `skipped`: the bands are shown to agree with
themselves, and nothing more. Someone who rewrote a band's rows and
recomputed its `band.json` and id passes every other check. With it, the
bands are the ones a key signed: the publication's signature over every
file's SHA-256 is what binds them. Give the key the publisher's gateway
record names, `--publisher-key <observer address>`, or let the registry give
it, `--registry-url http://core:4000` (that gateway's view of the registry is
then trusted for the key, as the index-swarm sidecar trusts it, and
`publication.keyFrom` and `assurance` say so). A publication past its
`expiresAt` is refused unless `--allow-expired`; its `sequence`, `issuedAt`
and `expiresAt` are reported. A band the publication lists in the range
checked that the directory lacks fails `publication` (`publication.absent`):
a set missing a band is not the publication's index. A publisher
checking its own bands can pass `data/indexes/published/publication.json`.

**Mined: an L1 index.** `--l1-bands-dir <dir>` finds every root of every band
in that `parquet-l1` index (`mined`); every band must be covered. Without it,
the node's own `data/indexes/installed/parquet-l1`, else
`data/indexes/published/parquet-l1`, is used where it exists, and a band it
does not cover is listed in `mined.uncovered`; `--l1-bands-dir none` uses
none. This trusts the L1 index, so check it first with `index-l1-verify`.
With neither an L1 index nor Arweave nodes, `mined` is in `skipped`: through
`--gateway-url`, the gateway is trusted for the bytes and nobody says the
roots are mined.

The set is refused outright (exit 1, no checks run) if its bands overlap or
leave a hole: that is not one index (the message names any entry that could
not be read). `--from` and `--to` check only the bands inside those heights;
a band only partly inside is listed under `partial`, not checked. A band its
own publisher's newer band supersedes (`.publisher.json`) is left out, as a
subscriber leaves it out, and listed under `superseded`, but only when the
newer band carries the same publisher tag and covers the older one's heights
whole; any other claim is ignored. An entry that disappears while the run
reads it is listed under `vanished` and, if it could lie in the range, fails
`complete`.

**Cost.** Every row is read, in file order, so memory stays flat; lookup files
are read in their own order too, and only the rows derived from the tables
are sorted. The consistency check groups `tags` and `data_items` by item. Both
spill to a folder of their own under the system temp directory, capped at
`--spill-max` (128 GB unless set) and at 80% of the space free there when the
run starts; and never into the last 100 GB free there; a run whose largest band is
expected to need more than that cap is refused before it starts. Spill
folders of the same kind a killed run left a day or more ago are removed when
a run starts, and logged. Through `tools/ar-io-node` that folder is
`data/tmp/index-verify` beside the node's `data/indexes`, never the container
layer on `/`. Measured on one host (2 cores, 10 GB, publication seq
157, before the checks above were added): the whole `ardrive-l2` index, 23
settled bands and 127.7 million items, with 50 items per band read from
Arweave nodes, took 1 hour 51 minutes; the 69-million-item h1.8M band alone
takes 66 minutes and its lookup check peaked at about 65 GB of spill. The
on-chain sample is seconds per band: 800 headers over 699 roots, 801 chunks
proven.

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
| `schema`, `required`, `consistency` or `selected` failure        | the builder wrote rows its layout doesn't allow, or the band was altered: as `identity` above for an installed band; rebuild a published one |
| `publication` failure                                            | the bytes are not the ones the publisher signed: remove an installed copy and let the sidecar fetch it again; for a published band, republish |
| `mined` failure                                                  | the L2 band and the L1 index disagree on where a root is: check the L1 index (`index-l1-verify`); if it holds, the L2 band's positions are wrong, so report it upstream |
| `locations`, `parents` or `onchain` `wrong` or `missing`         | the builder placed items wrongly, or its source holds a wrong row: report it upstream with the band id and the failures; the publisher repairs the source, then rebuilds and re-settles the band |
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
