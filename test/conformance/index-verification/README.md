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
For on-chain cases `expect.reason` says exactly why: for `refuted`, the kinds
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

Each table is written in its layout order, digested into `band.json` as the
layout says, with the lookups derived from the tables. `band.json`:
`version 1`, `schema "l2-1"`, the heights, selection
`{"kind":"ans104-data-items","tag":{"name":"App-Name","valuePrefix":"ArDrive"}}`,
`createdAt "2026-10-20T00:00:00.000Z"`, no `checks` unless an op sets them.
The band's directory is its id (`l2BandId`) for the publisher
`conformance-publisher-wallet-0000000000000`, or, with
`publisher: "wallet"`, for the publication's publisher.

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

`publication` (when present): a publication signed with a fresh Ed25519 key,
publisher a fresh base58 wallet, sequence 3, `issuedAt` (default
`2026-10-20T00:00:00Z`), `expiresAt` (default `2099-01-01T00:00:00Z`), one
`parquet-l2` index `ardrive-l2` listing every band with every non-dot file's
name, size and SHA-256, as written before `files` runs. It is checked against
that key, or, with `key: "other"`, against another fresh key.

`files` runs after writing and signing, in order:

| Op | Does |
| --- | --- |
| `removeFile {band, file}` | deletes the file |
| `writeFile {band, file, text}` | writes the file |
| `appendByte {band, file}` | appends one `0x00` byte |
| `reverseFile {band, file}` | rewrites the Parquet file with its rows sorted descending on every column |
| `sql {band, file, select}` | rewrites the Parquet file as DuckDB `SELECT <select> FROM read_parquet(file)` |
| `supersedes {band, target}` | writes `.publisher.json` `{"supersedes":["<target's id>"]}` |
| `renameId {band, from, to}` | renames the band's directory, replacing `from` with `to` in its name |
| `renameGeneration {band, generation}` | renames it `<id>~<generation>` |
| `symlinkElsewhere {band}` | moves the directory out of the set and leaves a symlink in its place |
| `removeDir {band}` | deletes the band |
| `rebuild {band, spec}` | deletes the band and writes `spec` (a band spec) in its place |
| `editBandJson {band, checks}` | rewrites `band.json` with `checks` set |
| `deleteDuringRun {band}` | deletes the band once the verifier has finished the band before it |
| `deleteFileDuringRun {band, file}` | deletes the file as the verifier starts reading it |

`options`: `from`, `to`; `publisher: true` (check ids against the default
publisher's tag); `lookups: false`; `maxUnlocatedShare`; `allowUnlocated`;
`allowExpired`; `l1` (an L1 index of the given bands, each holding the given
band's `root` at `height` and `block_transaction_index` `bti`; `required`);
`onchain` (`perBand`, `seed`, `maxUnchecked`, and `source`):

- `source: "stranger"`: every read of `size` bytes at `offset` of any root
  returns `0x01 0x00`, 512 random bytes, then zeros to `size`: an
  Arweave-signed header whose id is no item's, so every drawn item is
  `not-the-item` (wrong).
- `source: "busy"`: every read fails as a transport error (HTTP 503).

`expect.repeatable`: the same seed reads the same offsets twice.
`expect.draw`: `drawnUniform` of the (first) band; `readsInclude` offsets
that must be read; `bandsDiffer`: two bands of one layout read different
offsets under one seed.

### `kind: "onchain"`: replaying nodes

`roots` names the roots. `{}` is an honest root: a signed format-2
transaction whose data is a signed ANS-104 bundle of two items. `transfer`
is a signed transaction with no data. `format1Injected` is a signed
format-1 transaction whose header is given another transaction's
`data_root` and `data_size` after signing. The roots sit in the weave from
offset 40,000,000,000,000, 10,000,000 bytes apart in listing order, in
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
1100; `pastEnd: true`, offsets `size − 100` and `size + 1000` of the root;
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
