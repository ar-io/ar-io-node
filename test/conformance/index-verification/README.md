# Index verification conformance suite

The executable form of the rules in
[docs/index-verification.md](../../../docs/index-verification.md): a set of
cases, each a set of `parquet-l2` bands (with, as the case says, a signed
publication or an L1 index) or a script of Arweave node answers, with the
verdict a verifier MUST give. Every attack and probe found against
`index-l2-verify` is a case here, beside honest cases that MUST verify,
including honest data seen through faulty nodes.

| Verdict    | Means |
| ---------- | ----- |
| `verified` | every check that ran passed (`ok: true`) |
| `refuted`  | something was proven wrong: a check failed, or the set or publication was refused outright (`refused`) |
| `unknown`  | nothing was proven wrong, but not enough could be checked: an on-chain check that did not pass with no entry wrong (too many unchecked, nothing verified, or nothing drawn) |

`expect.failing` is the exact set of checks that fail: no more, no fewer.
On-chain cases may pin what a pass is stated to mean:
`expect.assurancePercent`, the fabricated share (whole percent, rounded up)
caught with 95% probability by the draw, with `maxUnchecked` items treated
as possibly fabricated. For on-chain cases `expect.reason` says exactly why: for `refuted`, the kinds
of wrong entries (`not-the-item`: another item or no item at the location;
`past-end`: the range runs past the root's end; `refuted`: the chain refutes
the root; `missing`: no node has the root, as two machines say with every
node heard); for `unknown`, one of `unchecked` (more unchecked entries than
allowed), `nothing-verified` (no entry ok), `nothing-drawn`.

## Running it here

```bash
yarn test:file src/lib/index-verification-conformance.test.ts
```

It runs with `yarn test`, so CI runs it on every push. `harness.ts` is this
implementation's builder and runner. Nothing large is committed: bands,
Arweave transactions and ANS-104 bundles are made at test time. Structure is
deterministic; ids that come from signatures differ each run (signatures are
salted), and cases name them by symbol.

## Running it against another implementation

Read every `cases/<id>/case.json`, build what it describes as specified
below, run your verifier, and compare your verdict, failing checks and
reason with `expect`. A conforming implementation gives the same for every
case. Common fields: `id`, `description`, `tampered` (what was changed from
an honest set), `kind` (`bands` or `onchain`), `expect`.

### `kind: "bands"`: building the bands

Each entry of `bands` is one band of heights `{ from, to }` (both included),
with the `l2-1` layout of `src/lib/parquet-l2/layout.ts`. Writing `F` for
`from` and `H(x)` for SHA-256 of the UTF-8 text `x`, its base rows are:

- `root = H("band-F-root")`, `nested = H("band-F-nested")`,
  `a = H("band-F-a")`, `b = H("band-F-b")`,
  `key = H("band-F-key")` followed by 480 bytes of `0x07`,
  `owner = SHA-256(key)`.
- `data_items`, in the layout's column order (`id, height,
  block_transaction_index, root_transaction_id, parent_id, owner_address,
  target, anchor, signature_type, data_size, content_type,
  content_encoding, tag_count, root_parent_offset, offset, size,
  data_offset, owner_offset, owner_size, signature_offset,
  signature_size`):
  - `a, F+1, 0, root, root, owner, null, null, 1, 100, null, null, 1, 0, 0, 1200, 1100, 514, 512, 2, 512`
  - `b, F+1, 0, root, nested, owner, null, null, 1, 200, null, null, 1, 3500, 0, 1300, 1100, 514, 512, 2, 512`
- `tags` (`height, id, tag_index, tag_name, tag_value`):
  `F+1, a, 0, "App-Name", "ArDrive-App"` and
  `F+1, b, 0, "App-Name", "ArDrive-Web"` (names and values as UTF-8 bytes).
- `wallets` (`address, public_modulus`): `owner, key`.
- `parents` (`id, root_transaction_id, root_parent_offset, offset, size,
  data_offset`): `nested, root, 0, 2400, 4000, 3500`.

A band with `real: { direct, nested }` holds real items instead: `direct`
signed ANS-104 items (Arweave signature type 1, one RSA key per run) each
tagged `App-Name: ArDrive-App` with payload `direct-F-i`, directly in a root
whose data is their bundle, plus, when `nested > 0`, one more item in that
bundle, last in it, whose payload is a bundle of `nested` such items
(payload `nested-F-i`) and whose tags are `Bundle-Format: binary`,
`Bundle-Version: 2.0.0`. The root's id is `H("band-F-real-root")`; its bytes
are what the `honest` source serves. Rows: one `data_items` row per leaf
item, with `height F+1`, `block_transaction_index 0`, `parent_id` the root or
the nested bundle, `owner_address` SHA-256 of the key's modulus,
`target`, `anchor`, `content_type` and `content_encoding` null,
`signature_type 1`, `data_size` its payload size, `tag_count 1`, and its
location: for an item at byte `s` of the root with payload at `d` and size
`z`, inside a parent whose payload starts at `P` (0 for the root),
`P, s−P, z, d−P, s−P+514, 512, s−P+2, 512`. One `tags` row each, one
`wallets` row (the key), one `parents` row for the nested bundle
(`id, root, 0, its start, its size, its payload start`). `rows` ops apply to
these rows in that order (direct items first, as the bundle holds them).

**Writing a band.** Each file is Parquet with exactly these columns, in
this order, of these types (DuckDB's names: `BLOB` bytes, `VARCHAR` UTF-8
text, `UBIGINT`/`USMALLINT`/`UTINYINT` unsigned 64/16/8-bit, `INTEGER`
signed 32-bit), rows sorted ascending by the order columns, nulls last
(`l2-1` layout):

| File | Columns | Order |
| --- | --- | --- |
| `data_items.parquet` | `id BLOB, height UBIGINT, block_transaction_index USMALLINT, root_transaction_id BLOB, parent_id BLOB, owner_address BLOB, target BLOB, anchor BLOB, signature_type UTINYINT, data_size UBIGINT, content_type VARCHAR, content_encoding VARCHAR, tag_count INTEGER, root_parent_offset UBIGINT, offset UBIGINT, size UBIGINT, data_offset UBIGINT, owner_offset UBIGINT, owner_size UBIGINT, signature_offset UBIGINT, signature_size UBIGINT` | `height, block_transaction_index, id, root_parent_offset, offset` |
| `tags.parquet` | `height UBIGINT, id BLOB, tag_index USMALLINT, tag_name BLOB, tag_value BLOB` | `height, id, tag_index` |
| `wallets.parquet` | `address BLOB, public_modulus BLOB` | `address` |
| `parents.parquet` | `id BLOB, root_transaction_id BLOB, root_parent_offset UBIGINT, offset UBIGINT, size UBIGINT, data_offset UBIGINT` | `id, root_transaction_id, root_parent_offset, offset` |
| `lookup_id.parquet` | `id8 UBIGINT, height UBIGINT` | `id8, height` |
| `lookup_wallet.parquet` | `addr8 UBIGINT, role UTINYINT, height UBIGINT, data_size UBIGINT` | `addr8, height, role, data_size` |
| `lookup_tag.parquet` | `name8 UBIGINT, val8 UBIGINT, name BLOB, value BLOB, txs UBIGINT, first_height UBIGINT, last_height UBIGINT` | `name8, val8, name, value` |
| `lookup_key.parquet` (`l2-2` only) | `name8 UBIGINT, val8 UBIGINT, height UBIGINT, items UBIGINT` | `name8, val8, height` |
| `stats.parquet` (`l2-2` only) | `bucket UBIGINT, name BLOB, value BLOB, items UBIGINT, bytes UBIGINT` | `bucket, name, value` |

BLOBs compare byte by byte (unsigned, a prefix first). Its `band.json` entry is `{rows, rowDigest}`, `rowDigest` being the
lowercase hex SHA-256 of every row in that order, each value encoded by its
column's type: `0x00` for NULL; else `0x01`, a 4-byte big-endian length and
the bytes (a BLOB as is, a VARCHAR as UTF-8, an integer as its decimal
digits). The lookups (`lookup_id`, `lookup_wallet`, `lookup_tag`) are
derived from the tables:

- `lookup_id`: for each distinct `(id, height)` of `data_items`,
  `(prefix64(id), height)`;
- `lookup_wallet`: for each distinct `(id, height, owner_address, target,
  data_size)`, `(prefix64(owner_address), 0, height, data_size)`, and, where
  `target` is set and not empty, `(prefix64(target), 1, height,
  data_size)`;
- `lookup_tag`: for each distinct `(tag_name, tag_value)` of `tags`,
  `(sha256_64(name), sha256_64(value), name, value, txs, first_height,
  last_height)`, `txs` the number of distinct ids carrying it and the
  heights its least and greatest;

- `lookup_key` (`l2-2`): for each distinct `(name, value, height, id)` of
  `tags` whose name is one of the band's `keyTags`,
  `(sha256_64(name), sha256_64(value), height, items)`, `items` the number
  of distinct ids at that height;
- `stats` (`l2-2`): with `bucket = floor(height / 1000) · 1000`, over the
  distinct `(id, height, data_size)` of `data_items`: one row per bucket
  with empty `name` and `value`, `items` the count and `bytes` the sum of
  `data_size` (0 for none); and, for each of the band's `statTags`, one row
  per bucket and value, counting the items carrying that tag name (each
  item under the value of its lowest `tag_index` for that name);

where `prefix64(b)` is the first 8 bytes of `b` (zero-padded on the right)
as a big-endian unsigned integer and `sha256_64(b)` is `prefix64` of its
SHA-256. Each is written sorted by its key columns (`id8, height`;
`addr8, height, role, data_size`; `name8, val8, name, value`) and described
`{rows, rowDigest}` the same way, digested in that order.

A band spec with `layout: {schema: "l2-2", keyTags, statTags}` is written
under `l2-2`: the two more files above, derived for those tag names, and
`keyTags`, `statTags` (each once, in UTF-8 byte order) in `band.json`
after `selection`. Otherwise it is `l2-1`.

`band.json` is `{"version":1,"schema":"l2-1","heightRange":[F,T],
"selection":{"kind":"ans104-data-items","tag":{"name":"App-Name",
"valuePrefix":"ArDrive"}},"tables":{…},"lookups":{…},"createdAt":
"2026-10-20T00:00:00.000Z"}` (plus `checks` when an op sets them), tables and
lookups in the layout's order, written as two-space-indented JSON. The
band's id, and its directory's name, is
`l2-h<F>-<T>-<tag>-<digest>`: `tag` the first 8 hex digits of SHA-256 of the
publisher's wallet (`conformance-publisher-wallet-0000000000000`, or the
publication's publisher with `publisher: "wallet"`), and `digest` the first
12 hex digits of SHA-256 over `JSON("[F,T]") + "\n" +` the selection's
one-line JSON (keys `kind`, `tag`; `name`, `valuePrefix`[,
`excludeValuePrefix`]) `+ "\n" +` the lines `<table>:<rows>:<rowDigest>`
for every table, sorted by table name, joined with `"\n"`.

`rows` changes the rows before they are written, in order:

| Op | Does |
| --- | --- |
| `set {table, row, column, value}` | sets one cell (rows numbered from 0 as listed above) |
| `push {table, values}` | appends a row, values in column order |
| `pushNull {table}` | appends a row of NULLs |
| `clear {table}` | removes every row of the table |
| `unlocate {row}` | sets the row's eight location columns to NULL; `"all"`: every row's, and empties `parents` |
| `moreDirect {count}` | for i in 0…count−1, appends a copy of row `a` with `id = H("more-F-i")` and location `0, o, 1200, o+1100, o+514, 512, o+2, 512` where `o = 10000·(i+1)`, and its tag row (`ArDrive-App`) |
| `moreNested {count}` | the same from row `b`, `id = H("nested-F-i")`, location `3500, o, 1300, o+1100, o+514, 512, o+2, 512`, tag `ArDrive-Web` |

Values: `null`, numbers, `"hash:<x>"` (`H(x)`), `"utf8:<x>"` (its bytes),
`"hex:<x>"`.

`band` changes `band.json` after the id is taken: `addRows {table, delta}`
(adds to the table's declared row count), `setChecks {value}` (sets
`checks`).

`publication` (when present), in the format and signing scheme of
[docs/index-publication.md](../../../docs/index-publication.md) (RFC 8785
canonical JSON, the `ar-io-index-publication/v1\n` prefix, Ed25519): a
publication signed with a fresh Ed25519 key, the signature's `keyId` its
base58 address: `version 1`, `publisher` a fresh base58 wallet,
`sequence 3`, `previousManifestSha256 null`, `issuedAt` (default
`2026-10-20T00:00:00Z`), `expiresAt` (default `2099-01-01T00:00:00Z`), one
`parquet-l2` index `ardrive-l2` whose `bands` are `{id, files}`, one per
band in listing order, `files` every non-dot file's `{name, size, sha256}`
(SHA-256 in lowercase hex) sorted by name, as written before `files` runs. It is checked against
that key, or, with `key: "other"`, against another fresh key.

`files` runs after writing and signing, in order:

| Op | Does |
| --- | --- |
| `removeFile {band, file}` | deletes the file |
| `writeFile {band, file, text}` | writes the file |
| `appendByte {band, file}` | appends one `0x00` byte |
| `reverseFile {band, file}` | rewrites the Parquet file with its rows sorted descending on every column |
| `recast {band, table, columns, add}` | rewrites the table's Parquet file with each column named in `columns` cast to the given type (e.g. `tag_count` as VARCHAR text, `block_transaction_index` as BIGINT), and, with `add`, one more column at the end of type `add.type` holding `add.value` in every row |
| `supersedes {band, target}` | writes `.publisher.json` `{"supersedes":["<target's id>"]}` |
| `renameId {band, from, to}` | renames the band's directory, replacing `from` with `to` in its name |
| `renameGeneration {band, generation}` | renames it `<id>~<generation>` |
| `symlinkElsewhere {band}` | moves the directory out of the set and leaves a symlink in its place |
| `removeDir {band}` | deletes the band |
| `rebuild {band, spec}` | deletes the band and writes `spec` (a band spec) in its place |
| `editBandJson {band, checks}` | rewrites `band.json` with `checks` set |
| `emptyFile {band, file}` | rewrites the Parquet file with the same columns and no rows |
| `editParquet {band, file, row, column, value}` | rewrites the Parquet file with one cell changed (the row by its position in the file, from 0), rows in their order |
| `redescribeLookup {band, lookup}` | rewrites the lookup's `{rows, rowDigest}` in `band.json` to describe the file as it now is, digested in the lookup's order (a lying publisher) |
| `deleteDuringRun {band}` | deletes the band once the verifier has finished the band before it |
| `deleteFileDuringRun {band, file}` | deletes the file as the verifier starts reading it |

`options`: `from`, `to`; `publisher: true` (check ids against the default
publisher's tag); `lookups: false`; `maxUnlocatedShare`; `allowUnlocated`;
`allowExpired`; `l1` (an L1 index of the given bands, each holding the given
band's `root` at `height` and `block_transaction_index` `bti`; `required`);
`onchain` (`perBand`, `seed`, `maxUnchecked`, and `source`); `seed` is the
run seed, written in decimal in the draw key string
(`sha256("<seed>|<band id>|<stratum>")`, docs/index-verification.md):

- `source: "stranger"`: every read of `size` bytes at `offset` of any root
  returns `0x01 0x00`, 512 random bytes, then zeros to `size`: an
  Arweave-signed header whose id is no item's, so every drawn item is
  `not-the-item` (wrong).
- `source: "busy"`: every read fails as a transport error (HTTP 503).
- `source: "honest"`: every read of a real band's root returns its bytes
  at that range (a range past the end is a short read). It stands for a
  root already bound and mined: no header, status, offset or chunk proof is
  checked, only that the bytes at each drawn location are the item.

`expect.repeatable`: the same seed reads the same offsets twice.
`expect.draw`: `drawnUniform` of the (first) band; `nestedAtLeast`, the
fewest drawn items that must be in nested bundles; `readsInclude` offsets
that must be read; `bandsDiffer`: two bands of one layout (same number of
rows) draw different positions for their direct items in their
`data_items` files under one seed.

### `kind: "onchain"`: replaying nodes

`roots` names the roots. `{}` is an honest root: a signed format-2
transaction whose data is a signed ANS-104 bundle of two items. `transfer`
is a signed transaction with no data. `format1Injected` is a signed
format-1 transaction whose header is given another transaction's
`data_root` and `data_size` after signing. The first root's data starts at
weave offset 40,000,000,000,000 and each next one 10,000,000 bytes further,
in listing order; `/tx/{id}/offset` answers the root's last byte (its start
plus its size minus 1), and its size. They sit in
block `"B" × 64` at height 1000 unless `height` is given.

`nodes` maps each node (host:port) to a script of what it answers, per
request (`header` = `GET /tx/{id}`, `status` = `GET /tx/{id}/status`,
`offset` = `GET /tx/{id}/offset`, `chunk` = `GET /chunk/{offset}`), per root
symbol (or `*`), with `default` for the rest. Every node holds every root
honestly unless its script says otherwise; any id that isn't a root's is
404.

| Answer | Means |
| --- | --- |
| `honest` | the truth |
| `404`, `503` | that status |
| `503Twice` | 503 for its first two requests of that kind, then honest |
| `timeout` | the request times out |
| `hang` | no answer until the request's timeout |
| `reset`, `resetOnce` | the connection fails (always, or the first time) |
| `otherHeader` | the header with a random signature (another transaction's) |
| `format1` | the header with `format: 1` |
| `status:height=N` | the right block hash at height N |
| `malformed` | `/offset` answers `{"error":"x"}` |
| `wrongSize` | `/offset` answers one byte more than the root's size |
| `badproof` | the chunk with the first byte of its `data_path` flipped |

`entries` are the drawn items, in order, each `repeat` times: a real item of
`root` (cycling over its two items); `fabricated: true`, a random id at the
item's real offsets; `madeUp: true`, a random root id with offsets 0 and
1100; `headerExtra: x`, the item's offsets with its payload start x bytes
later; `pastEnd: true`, offsets `size − 100` and `size + 1000` of the root;
`height`, the height the band gives (default the root's). `addresses` (when
present) maps host names to the addresses they resolve to (a name not listed
doesn't resolve; IP literals are themselves) and turns on machine dedupe.
`options`: `maxUnchecked`, `deadlineMs`, `timeoutMs` (per request, default
20 s), `allowAgreement`.

The verifier is the drawn check of docs/index-verification.md over these
nodes, with these pool semantics:

- Machines: a node's machine is its set of resolved addresses (A and
  AAAA); nodes whose sets meet, directly or through others, are one
  machine; every loopback address and `localhost` are one machine; a name
  that doesn't resolve is a machine of its own. Without `addresses`, a
  node's host name is its machine.
- Order: each request starts at the next node in turn; a chunk request
  starts at the node that proved the root's last chunk.
- Rest: a node that times out or whose connection fails is not asked for
  5 minutes, except as below.
- Ask twice: before any verdict of absence (a root missing, in no block, a
  chunk no node holds) every node not yet heard — busy (timeout, 429, 5xx),
  unreachable, or resting — is asked once more; any still silent is
  unheard, and with any node unheard there is no verdict of absence.
- Retry pass: after every drawn entry has been read once, every unchecked
  entry is read once more. No retries within a pass (`retries: 0`).
- Concurrency 1, entries in listed order.

The verdict is `verified` when the check passes; `refuted` when any entry is
wrong; `unknown` otherwise (none wrong, and too many unchecked, or none ok,
or nothing drawn).

## Changing verification code

Every change to verification code (`src/lib/parquet-l2/verify-bands.ts`,
`src/lib/onchain/*`, `src/lib/index-band/verify.ts`, the `parquet-l1`
verifiers) adds or updates a case here: a new attack is a new `refuted` or
`unknown` case, a new false failure a new `verified` one.

The uniform draw over a large band (rows far into the file being drawn) is
gated by a unit test (`src/lib/parquet-l2/verify-bands.test.ts`, "draws
uniformly over the whole file"): a case would need a band of hundreds of
thousands of rows.
