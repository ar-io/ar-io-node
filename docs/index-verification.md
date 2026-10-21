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
   block must name the same one (`minedByNodes`). A 404 for the status is a
   denial only from a machine that serves the root's header (a machine
   without the transaction at all just doesn't have it). Two such machines
   saying it is in no block, with every node heard, **refute** the root;
   fewer leave it unchecked; nodes naming different blocks is an error.
   A root is `missing` only when no node binds its header (below).
   `index-l2-verify` can instead find **every** root of a
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

**One node can neither pass nor fail a root.** An answer from one node that
doesn't hold up (another transaction's header, a format-1 copy, a signature
that won't verify where another node's does, a size other than the signed
one, a block other nodes don't agree on, a chunk whose proof fails) is that
node's fault: it is passed over, other nodes are asked, and it is listed in
`roots.nodeFaults` (and logged). A root is refuted only on evidence about the
root itself from at least two machines: no node binds it and either two
machines answer 404 for its header with every node heard (`missing`, below),
or two machines serve this id's own header (its signature hashes to the id)
in a form that can't bind it (format 1, no `data_root`, a signature that
doesn't verify without `--allow-agreement`) with every node heard; a 404
never counts toward that second refutation, and a node that stayed unheard
may be the one honest holder, so either way the root is then unchecked;
two machines agree on its block, hash and height,
at a height other than the band gives; two machines that serve its header
say it is in no block.
A block is its hash and its height together: a node naming the agreed hash
at another height is that node's fault. Fewer than two machines saying
anything definite leaves the item unchecked: never a refutation, and never
a pass (see below). Before any verdict of absence, busy, unreachable and
resting nodes are asked
once more.

**A bound root is never missing.** Once a root is bound (a format-2 header
whose signature hashes to its id and verifies) and two machines place it in
a block, nothing about its data can make it `missing`: a node answering 404
to `/tx/{id}/offset` or to a chunk holds no data for it, which says nothing
against it. In the default pool the `tip` nodes and some `data` nodes answer
404 to `/offset` for mined transactions while serving their headers.
`missing` is only for a root no node binds, two machines answering 404 for
its header, and every node heard: a node that stayed busy may be the one
holder, so then the root is unchecked.

### `index-l2-verify`: one denominator, no substitution

These rules are normative: any implementation of the L2 verifier MUST give
the verdicts they give, and the cases in
[`test/conformance/index-verification/`](../test/conformance/index-verification/README.md)
are their executable form. A verdict is `verified`, `refuted`, or `unknown`
(inconclusive); only `verified` is `ok: true`.

**The draw.** For each band, a verifier MUST draw `--onchain N` items up
front, **uniformly over every located item of the band** (the sample the
stated bound is about: a publisher chooses whether an item sits directly in
its root or in a nested bundle, so a stratified draw would let it put
fabricated items where fewer draws fall). It then draws nested items on top
until `ceil(N/2)` drawn items are nested, where the band has them, so the
nested path is always read; those count like the rest, but the bound below
uses only the uniform N.

The draw MUST be ordered by a keyed cryptographic hash. The key is
`sha256("<run seed>|<band id>|<stratum>")` as 64 lowercase hex digits
(stratum 0 for the uniform draw, 1 for the nested top-up); the drawn rows
are the n located rows of `data_items` (row positions in the file from 0)
whose `sha256("<key>:<position in decimal>")`, as lowercase hex, is
smallest, ties by position. It MUST be salted by the band's id, so two bands
of the same layout never draw the same positions. A non-cryptographic hash
is not enough: DuckDB's `hash(row, seed)` is `g(row) XOR k(seed)`, so
ordering by it picks rows by their XOR distance from one random value to a
public function of the row, and a publisher that fabricated the rows whose
`g` starts with three zero bits (12.5%) was caught in about 11% of runs,
not the 93% the bound claims (against SHA-256: 93.7% of 300 runs). On the
69-million-row h1.8M band of `ardrive-l2` the SHA-256 order takes about 25
seconds on two threads. The seed is random per run and reported; `--seed`
is for reproducing a run only (a publisher that knew the seed before
publishing could grind its band against it).

Every drawn item ends in exactly one of:

| Outcome     | Means |
| ----------- | ----- |
| `ok`        | its header, read at its recorded location from a root bound and found in a block, every chunk proven, hashes to its id |
| `wrong`     | proven contrary: another item, or no item, is there; the range runs past the root; the chain refutes the root on two machines' word (no `data_root`, format 1, a signature that doesn't verify without `--allow-agreement`, in no block, in a block at another height than the band says, another size than its header signs); or the root is `missing` (no node binds it, two machines answer 404 for its header, and every node in the pool was heard) |
| `unchecked` | anything else: nodes busy, failing or unreachable; a root bound but placed by no node; a chunk no node holds (unseeded, purged); a holder never heard; nodes naming different blocks; the band's deadline (`--band-deadline`) |

**No drawn item is ever replaced** by another draw because of how it ended:
redrawing is what would let fabricated items hide behind roots or chunks
nobody can read. After the first pass, every `unchecked` item MUST be read
once more, after the others. Then, per band:

- any `wrong` item: the band **is refuted**;
- else more `unchecked` items than `--max-unchecked` (0 unless set), or no
  `ok` item at all (whatever is allowed): the band **is unknown**
  (inconclusive): `ok: false`, its own reason ("inconclusive: N of M
  sampled entries could not be checked — rerun, or allow with
  --max-unchecked"), and listed in `onchain.inconclusiveBands`;
- else it **is verified**.

There is no pass ratio, no floor and no allowance for unreadable data, and
none MAY be added: each tolerance tried so far let fabricated items through
when stacked with another. `--max-unchecked` MUST be below `--onchain`. Each
band reports `drawn`, `drawnUniform`, `drawnNested`, `ok`, `wrong`, `missing`, `unchecked`,
`uncheckedReasons` (`error`, `unreadable`, `deadline`) and an `errorSample`.

**What a pass means.** With N items drawn uniformly and none wrong, a band
in which a fraction p of the located items are fabricated passes with
probability (1 − p)^N. With N = 20, a band with 14% or more fabricated
located items would have been caught with 95% probability; smaller fractions
may not be. Items allowed unchecked are treated as possibly fabricated: a
fabricated item behind data nobody can read (an unseeded chunk, a root no
node places) comes back unchecked, not wrong, so with k allowed a band
passes when at most k of its N drawn items are fabricated, with probability
P(Bin(N, p) ≤ k) = Σ_{i≤k} C(N, i) p^i (1 − p)^(N−i). The stated bound is
the smallest p at which that is at most 5%: with N = 20, 14% for k = 0, 22%
for k = 1, 41% for k = 4, 46% for k = 5. N is the fewest items drawn
uniformly in any band (min(N, located)). `assurance` says this for the run.
Raise
`--onchain` to catch smaller fractions. Unlocated items are not checked on
chain at all (see the `located` check).

`index-band-verify` keeps its own rule (a pool walked until each stratum's
target is read, roots gone passed over, 80% of the items read must pass):
it checks a publisher's band before publishing, not a holder's.

What one read comes to, as `index-band-verify` sorts it:

| Outcome      | Means | Counts |
| ------------ | ----- | ------ |
| `ok`         | the bytes at the recorded location are a data item header whose signature hashes to the item's id | for the band |
| `wrong`      | something else is there, the range runs past the root, or the chain refutes the root | **against** the band: one fails it |
| `unreadable` | every node or the gateway said 404 for the root or the chunk: data gone network-wide | neither way; another sample is taken in its place |
| `errors`     | nothing usable came back | against the pass ratio; rerun |

A machine is the set of addresses a node's name resolves to (A and AAAA);
two nodes whose sets meet are one machine, every loopback address and
`localhost` are one, and IPv6 literals (`http://[::1]:1984`) work. A name
that doesn't resolve counts as a machine of its own and is listed in
`roots.unresolvedNodes`.

The default pool is the `tip` and `data` nodes ar-io-node reads chunks from
(`PREFERRED_CHUNK_GET_NODE_URLS`'s default). `data` nodes each hold a partition
of the weave, so most answer 404 for most offsets; that is normal. The node
that proved a root's last chunk is asked first for its next; otherwise each
request starts at the next node in turn. A node that times out or refuses a
connection rests for five minutes and is not asked at first. Before any
verdict of absence about a root (missing, or in no block), every node not
yet heard (busy, its connection failed, or resting) MUST be asked once more;
any still silent is `unheard`, and with any node unheard the root is
unchecked, never missing: that node may be the one holder. Each band's reads have a deadline (`--band-deadline`, 20
minutes): items not read by then are unchecked. Name your own
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
| `coverage`    | some height in the `--from`/`--to` range is in no checked band (a band only partly inside the range is not checked) |
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
| `lookups`     | a lookup file, read in the order it holds its rows, is out of its key's order (a reader's search over its row groups would miss keys), or doesn't digest to what `band.json` says, or doesn't hold exactly the rows its tables give (`--skip-lookups` leaves this out). Under `l2-2` this includes `lookup_key.parquet` and `stats.parquet`: both are recomputed from the band's `tags` and `data_items` for the `keyTags` and `statTags` its `band.json` names, never taken from `band.json`, so with `--skip-lookups` the stats are unverified too                                                                                                            |
| `mined`       | with an L1 index: a root isn't in the index's `block_transactions` at the height its items give, or is there at another `block_transaction_index`. Every root of every band, not a sample. A root at another index is listed in `mined.moved` with both positions: two indexes disagreeing on a block's order may be the L1 index's fault (`tx_root` doesn't bind the order), so check it with `index-l1-verify` and compare with the publisher's own L1 index. It fails all the same |
| `onchain`     | a drawn item is `wrong`, or more than `--max-unchecked` (0) drawn items are `unchecked`, or no drawn item is `ok` (the band is then inconclusive), or the band has items but none located, so nothing of it can be read on chain (`--allow-unlocated` passes such a band). See [one denominator, no substitution](#index-l2-verify-one-denominator-no-substitution). `--onchain <n>` items per band, default 20; `0` leaves it out. The seed is random per run and reported; `--seed` repeats a run's draw exactly, for reproducing a run only |
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
does not cover is listed in `mined.uncovered` and in `minedPartial` as
`{ bands: [...], count: n }`, and `skipped` then includes `mined`;
`--l1-bands-dir none` uses none. This trusts the L1 index, so check it first with `index-l1-verify`.
`mined` is in `skipped` whenever an L1 index does not cover every band: Arweave
nodes placing the sampled roots in blocks is reported in `assurance` and
`onchain.roots.checks`, not as `mined`, which finds every root. Through
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
are sorted. Rows are digested in DuckDB: each range of rows is encoded as the
row digest takes it and handed over as one buffer, hashed in order, with each
row checked against the one before (a type it can't encode exactly, or any
error, and the rows are read one at a time instead, with the same result).
`--concurrency` databases (two threads and 2 GB each; by default a quarter
of the CPUs, at most 4) read side by side: bands, and a band's tables and
lookups, a table's ranges spread over them, results reported in band order
as if read one after another. They share the spill cap: a read that sorts or
groups a band reserves 10 bytes per byte of its Parquet before it starts. The consistency check groups `tags` and `data_items` by item. Both
spill to a folder of their own under the system temp directory, capped at
`--spill-max` (128 GB unless set) and at 80% of the space free there when the
run starts; and never into the last 100 GB free there. A run whose largest
band is expected to need more than that cap is refused before it starts,
with or without `--skip-lookups`: the consistency and selection checks spill
too (sized at twice the band's `data_items` and `tags` files), so with less
than about 100 GB free every run is refused. The refusal names the folder and
suggests `TMPDIR`, and suggests `--skip-lookups` only when the run would fit
without the lookups. Each run touches a `.heartbeat` file in its spill folder every
minute; a folder of the same kind whose heartbeat stopped a day or more ago
(a run killed outright) is removed when a run starts, and logged, and a
folder still beating is left alone. Through `tools/ar-io-node` that folder is
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
| `mined` failure                                                  | the L2 band and the L1 index disagree on where a root is. For `moved` roots (same block, another position), the L1 index may be the one wrong: two publishers' L1 indexes have been seen to order a few blocks differently, which `tx_root` doesn't catch. Check the L1 index (`index-l1-verify`) and compare `mined.moved` with the publisher's own L1 index; if yours holds, the L2 band's positions are wrong, so report it upstream |
| `locations`, `parents` or `onchain` `wrong` or `missing`         | the builder placed items wrongly, or its source holds a wrong row: report it upstream with the band id and the failures; the publisher repairs the source, then rebuilds and re-settles the band |
| an inconclusive band (`onchain.inconclusiveBands`)               | rerun first: most `unchecked` items are busy nodes. If `uncheckedReasons` shows `unreadable` (chunks no node holds), the data is gone network-wide or unseeded, which the index can't prove either way; seeding it again makes it readable. Allowing some with `--max-unchecked` weakens what a pass means: those items are not checked at all |
| `lookups`                                                        | the lookups are derived: rebuilding the band rewrites them                                                                                             |

For `root-tx-index` bands, `index-export --once --resettle[=full]` re-checks and
replaces frozen bands whose sources changed (see
[index-export.md](index-export.md)). For `parquet-l1`, see
[`index-l1-verify`](cli.md#index-l1-verify) and
[`index-l1-import`](cli.md#index-l1-import).

## For agents

Run the command, read stdout (or stderr on exit 1) as JSON, and act on `ok` and
each check's `failures`. Each failure names the band (`found` starts with its
id) and the height it starts at. `onchain` adds counts (`drawn`, `ok`,
`wrong`, `missing`, `unchecked`) and, under `roots`, how the roots were read and
bound. `wrong` and `missing` fail the band. A band in
`onchain.inconclusiveBands` is neither verified nor refuted: rerun before
acting on it, and read `uncheckedReasons` for why. Read `ok` together with
`skipped`, `publisherBound` and `assurance`, which say what was not checked
and what a pass of the sample means. Never treat a passing sample as proof of
every row: the row-by-row checks are what cover every row.
