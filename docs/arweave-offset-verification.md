# Verifying data with absolute Arweave offsets

An AR.IO gateway can tell a client where an item's bytes sit in the Arweave
weave. With that, the client does not have to trust the gateway for the bytes:
it fetches chunks by absolute offset from any gateway or Arweave node, checks
each against the block's `tx_root`, and checks the reassembled item against
its ID. The gateway's role is reduced to an offset resolver; a wrong offset
fails verification instead of being served as data.

This document is the contract for clients, including agents implementing one
from this description alone.

## What the gateway publishes

### On data responses (`GET`/`HEAD /raw/{id}` and `/{id}`)

| Header | Meaning |
|---|---|
| `X-AR-IO-Root-Transaction-Id` | The root L1 transaction containing the item (absent for an L1 transaction served directly). |
| `X-AR-IO-Root-Item-Offset` (= `X-AR-IO-Root-Data-Item-Offset`) | Start of the data item (its ANS-104 header) within the root transaction's data, 0-based. |
| `X-AR-IO-Root-Data-Offset` | Start of the item's payload within the root transaction's data, 0-based. |
| `X-AR-IO-Root-Item-Size` | Size of the whole data item (header + payload). |
| `X-AR-IO-Root-Arweave-Start-Offset` | **Absolute** weave offset of the first byte of the root transaction's data, in Arweave's offset numbering (see below). |
| `X-AR-IO-Root-Arweave-Data-Size` | Size of the root transaction's data. |

For an L1 transaction served directly, the root is the transaction itself:
the two `Root-Arweave` headers describe the transaction's own data, and there
are no item offsets.

### From `GET /ar-io/offsets/{id}` (JSON)

| Field | Meaning |
|---|---|
| `rootTxId` | Root L1 transaction; equal to `id` for an L1 transaction. |
| `rootOffset`, `rootDataOffset`, `size`, `dataSize` | As the headers above (`size` = whole item, `dataSize` = payload). An L1 answer has only `dataSize`. |
| `rootArweaveStartOffset`, `rootArweaveDataSize` | As the `Root-Arweave` headers. |
| `itemArweaveStartOffset` | Absolute weave offset of the item's first byte: `rootArweaveStartOffset + rootOffset`. |
| `dataArweaveStartOffset` | Absolute weave offset of the payload's first byte: `rootArweaveStartOffset + rootDataOffset`. |

For an L1 transaction, `itemArweaveStartOffset` and `dataArweaveStartOffset`
both equal `rootArweaveStartOffset`.

### When the absolute offsets are present

Only when the root is a **stable** transaction (past the fork depth, so its
position can no longer change) whose offset the gateway has recorded. They are
omitted, never guessed, otherwise, and for data items nested more than one
level deep in the gateway's own bundle index. Use the root-relative offsets with
`GET /tx/{rootTxId}/offset` from an Arweave node in those cases.

### Signatures

Every value above is signed with HTTP Message Signatures (RFC 9421, Ed25519)
when the gateway signs responses (the default): the headers are covered
components of the data response's signature, and the `/ar-io/offsets` body is
bound by `Content-Digest`, which the signature covers. The signing key is
published in `/ar-io/info` (`httpsig`). A signature makes the values this
gateway's attributable claim; it does not make them true. The steps below are
what make them true.

## Offset conventions

- **Relative offsets** (`rootOffset`, `rootDataOffset`, the `Root-Item-Offset` /
  `Root-Data-Offset` headers) are 0-based byte positions within the root
  transaction's data: 0 is its first byte.
- **Absolute offsets** (everything with `Arweave` in its name) use Arweave's
  own weave offset numbering, the one `GET /chunk/{offset}` and
  `GET /tx/{id}/offset` use. In it, the root's data occupies offsets
  `rootArweaveStartOffset` through
  `rootArweaveStartOffset + rootArweaveDataSize - 1`, inclusive, and the byte
  at relative offset `r` is at absolute offset `rootArweaveStartOffset + r`.
- Arweave's `GET /tx/{id}/offset` returns the transaction's **END** offset (its
  last byte, inclusive) and its `size`: `start = offset - size + 1`. The
  gateway publishes the start, as `X-Arweave-Chunk-Tx-Start-Offset` does.
  Cross-check: `rootArweaveStartOffset + rootArweaveDataSize - 1` must equal
  the `offset` any Arweave node returns for `GET /tx/{rootTxId}/offset`.
- **For Merkle proofs only:** this numbering is one ahead of a 0-based byte
  index. Absolute offset `o` is the weave's 0-based byte `o - 1`; block
  `weave_size` values and `tx_path` bounds are 0-based. The formulas in steps
  3–5 account for this; get it wrong and a valid proof fails.

## Recipe: verify a data item from its ID

Inputs: the item ID, and a trusted view of the chain (see "What you still
trust").

1. **Locate.** From any gateway, `GET /ar-io/offsets/{id}` (or `HEAD /raw/{id}`)
   and read `itemArweaveStartOffset` (`S`) and `size` (`N`, the whole item).
   Nothing here is trusted yet.
2. **Fetch chunks.** The item is absolute offsets `S` through `S + N - 1`. Request the chunk
   containing a byte with `GET /chunk/{absoluteOffset}` (JSON:
   `chunk`, `data_path`, `tx_path`, base64url) or
   `GET /chunk/{absoluteOffset}/data` (raw bytes, proofs in
   `X-Arweave-Chunk-*` headers) from any gateway or Arweave node. Start at `S`;
   each chunk's `data_path` tells you where it ends, so request the next one at
   the following byte until `S + N - 1` is covered. (Arweave nodes also serve a
   binary variant, `/chunk2/{offset}`; it is not needed here.)
3. **Find the block.** For a chunk requested at absolute offset `o`, the
   block is the one with `previous weave_size <= o - 1 < weave_size`. Let
   `blockStart` be the previous block's `weave_size` and
   `blockSize = weave_size - blockStart`. Its `tx_root` is what you trust.
4. **Verify `tx_path`.**
   `t = validatePath(tx_root, o - 1 - blockStart, 0, blockSize, tx_path)` must
   succeed. It proves the transaction's place in the block:
   `txStart = blockStart + t.leftBound + 1` (absolute, in the numbering above)
   and `txSize = t.rightBound - t.leftBound`. The proven `data_root` is the
   first 32 of the last 64 bytes of `tx_path`. Take `data_root` from here, not
   from any gateway. For a root, `txStart` must equal `rootArweaveStartOffset`
   and `txSize` must equal `rootArweaveDataSize`.
5. **Verify `data_path`.**
   `d = validatePath(data_root, o - txStart, 0, txSize, data_path)` must
   succeed, `sha256(chunk)` must equal the first 32 of the last 64 bytes of
   `data_path`, and the chunk's length must be `d.rightBound - d.leftBound`.
   The chunk covers absolute offsets `txStart + d.leftBound` up to
   `txStart + d.rightBound - 1`; request the next one at
   `txStart + d.rightBound`. (`ar-io-node`: `validateChunk()` in
   `src/lib/validation.ts`; arweave-js: `validatePath` in `lib/merkle`.)
6. **Reassemble.** Concatenate the verified chunks and take `N` bytes starting
   `S - firstChunkStart` in, where `firstChunkStart` is the first chunk's
   `txStart + d.leftBound`: the item's bytes.
7. **Check the ID.** Parse the ANS-104 header: the ID is
   `base64url(sha256(signature))`; verify the signature over the item with its
   owner key (any ANS-104 library). A match proves both the bytes and the
   offset. A mismatch means the offset was wrong; discard it.

The payload alone is absolute offsets `dataArweaveStartOffset` through
`S + N - 1`. If the gateway gave no item `size`, read the item header (its
length follows from the signature type, owner, target, anchor and tags) and add
the payload size.

### For an L1 transaction

Use `rootArweaveStartOffset` and `rootArweaveDataSize` as `S` and `N`. Steps
2–5 are the same. Instead of step 7, fetch the transaction header from anywhere
and check that its signature verifies, that `base64url(sha256(signature))` is
the ID, and that its `data_root` equals the one proven in step 4.

## What you still trust

The chain: block headers, and in them `weave_size` and `tx_root`, obtained from
a source you trust (your own node, several independent nodes, or block headers
checked back to a checkpoint you trust). Everything else in the recipe is
verified. A gateway that lies about offsets, chunks or proofs is detected, not
believed.
