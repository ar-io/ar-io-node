# Index verification conformance suite

The executable form of the rules in
[docs/index-verification.md](../../../docs/index-verification.md): a set of
cases, each a set of `parquet-l2` bands (and a publication, an L1 index) or
a script of Arweave node answers, with the verdict a verifier MUST give.
Every attack and probe found against `index-l2-verify` is a case here, beside
honest cases that MUST verify, including honest data seen through faulty
nodes.

A verdict is one of:

| Verdict    | Means |
| ---------- | ----- |
| `verified` | every check that ran passed (`ok: true`) |
| `refuted`  | something was proven wrong: a check failed, or the set or publication was refused outright (`check: "refused"`) |
| `unknown`  | nothing was proven wrong, but not enough could be checked: an inconclusive band (`onchain.inconclusiveBands`) |

A `refuted` or `unknown` case also names the check that MUST fire (`expect.check`).

## Running it here

```bash
yarn test:file src/lib/index-verification-conformance.test.ts
```

It runs with `yarn test`, so CI runs it on every push. `harness.ts` builds
each case into a temporary directory and runs it through `verifyL2Bands`
(`kind: "bands"`) or `checkDrawnHeaders` over an `onChainRootSource`
(`kind: "onchain"`). Nothing large is committed: bands, Arweave transactions
and ANS-104 bundles are made at test time. Structure is deterministic (rows,
heights, offsets, node answers); ids that come from signatures differ each
run, since signatures are salted, and cases name them by symbol.

## Running it against another implementation

Read every `cases/<id>/case.json`, build what it describes, run your
verifier, and compare your verdict (and failing check) with `expect`. A
conforming implementation gives the same verdict for every case. The fields:

```json
{
  "id": "e1-unlocatable-root",
  "description": "what the case is",
  "tampered": "what was changed from an honest set",
  "kind": "bands | onchain",
  "expect": { "verdict": "verified | refuted | unknown", "check": "the check that fires" }
}
```

### `kind: "bands"`

`bands` lists the bands, each `{ from, to }` heights, built from a base of
two items (one directly in its root, one in a nested bundle `parents`
describes), their tags, the owner's key and the nested bundle, exactly as
`harness.ts` `baseRows` writes them. Then:

- `rows`: changes to the rows before they are written: `set` a cell
  (`{ table, row, column, value }`), `push` a row, `pushNull` (an all-NULL
  row), `clear` a table, `unlocate` an item (or `all`), `moreDirect` (more
  items directly in the root, each at its own offset, with their tags).
  Values: `null`, numbers, `"hash:<label>"` (SHA-256 of the label),
  `"utf8:<text>"`, `"hex:<bytes>"`.
- `band`: changes to `band.json` after the id is taken (`addRows`,
  `setChecks`).
- `publisher: "wallet"`: the band is tagged for the publication's publisher.
- `publication`: a publication signed over the bands as written
  (`expiresAt`, `issuedAt`; `key: "other"` checks it against a key that
  didn't sign it).
- `files`: changes once written (and signed): remove, write or append to a
  file; rewrite a lookup file in reverse; rewrite a table through SQL;
  `supersedes` (a `.publisher.json` claim); rename the id or add an
  installed generation; move a band elsewhere and symlink it; remove a band;
  `rebuild` a band with other rows; `editBandJson`; `deleteDuringRun` and
  `deleteFileDuringRun` (deleted while the verifier reads the set).
- `options`: `from`, `to`, `publisher`, `lookups`, `maxUnlocatedShare`,
  `allowUnlocated`, `allowExpired`, `l1` (an L1 index holding the band's
  root at the given height and position), and `onchain` with a `source`:
  `stranger` (every header read is another item's, so any drawn item is
  wrong) or `busy` (every read fails in transport).
- `expect.repeatable`: the same seed draws the same items twice;
  `expect.draw`: how the band's sample was drawn (`drawnUniform`, offsets
  that must be read).

### `kind: "onchain"`

A replay of Arweave nodes. `roots` names the roots (`{}` an honest signed
format-2 bundle of two items; `transfer`: a signed transaction with no data;
`format1Injected`: a format-1 transaction whose header is given another
transaction's `data_root`), placed in the weave 10,000,000 bytes apart from
offset 40,000,000,000,000, in block `"B" × 64` at height 1000.

`nodes` maps each node (host:port) to a script of what it answers, per
request (`header` = `/tx/{id}`, `status` = `/tx/{id}/status`, `offset` =
`/tx/{id}/offset`, `chunk` = `/chunk/{offset}`), per root symbol (or `*`),
with `default` for anything else (`honest` when not given):

| Answer | Means |
| --- | --- |
| `honest` | the truth (404 for a root it doesn't hold) |
| `404`, `503` | that status |
| `503Twice` | 503 for its first two requests of that kind, then honest |
| `timeout` | times out |
| `hang` | never answers until the request's timeout |
| `reset`, `resetOnce` | the connection fails (always, or the first time) |
| `otherHeader` | another transaction's header (its signature hashes elsewhere) |
| `format1` | the header with `format: 1` |
| `status:height=N` | the right block hash at height N |
| `malformed` | `/offset` answers `{"error":"x"}` |
| `wrongSize` | `/offset` answers another size |
| `badproof` | a chunk whose `data_path` is corrupted |

`entries` are the drawn items, in order: `{ root, repeat }` real items of
the root (cycling over its two items); `fabricated: true` a made-up item id
at the root's real offsets; `madeUp: true` a made-up root id; `height` the
height the band gives (default the root's). `addresses` (when given) maps
host names to the addresses they resolve to, for machine dedupe; a name not
listed doesn't resolve. `options`: `maxUnchecked`, `deadlineMs`,
`timeoutMs`, `allowAgreement`.

The verdict is `verified` when the drawn check passes, `refuted` when any
entry is wrong, `unknown` when it is inconclusive.

## Changing verification code

Every change to verification code (`src/lib/parquet-l2/verify-bands.ts`,
`src/lib/onchain/*`, `src/lib/index-band/verify.ts`, the `parquet-l1`
verifiers) adds or updates a case here: a new attack is a new `refuted` or
`unknown` case, a new false failure a new `verified` one.
