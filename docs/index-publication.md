# Index Sharing: the publication protocol

How to find, verify and use the bands a gateway publishes through Index
Sharing. This page is the contract for **consumers**: another gateway, an
indexer, a wallet or an agent that wants a publisher's indexes without
trusting whatever server, cache or peer handed them over. Operators running
the `index-swarm` sidecar should read [index-swarm.md](index-swarm.md);
[index-export.md](index-export.md) covers how bands are built.

Everything here can be done with `curl` and a short script. A complete Python
client, stdlib plus one Ed25519 library, is at the end of the page.

## Table of Contents

- [The model in one paragraph](#the-model-in-one-paragraph)
- [Discovery](#discovery)
- [The publication document](#the-publication-document)
- [Verifying a publication](#verifying-a-publication)
- [Fetching band files](#fetching-band-files)
- [Following an index in a BitTorrent client](#following-an-index-in-a-bittorrent-client)
- [Metering](#metering)
- [Looking up one ID](#looking-up-one-id)
- [L1 bands](#l1-bands)
- [Lookup files](#lookup-files)
- [L2 bands](#l2-bands)
- [Querying a dataset over HTTP](#querying-a-dataset-over-http)
- [Reference client](#reference-client)
- [Compatibility rules](#compatibility-rules)

## The model in one paragraph

A publisher serves one signed JSON document, the **publication**, at
`/ar-io/indexes`. It lists the publisher's indexes; each index is a list of
**bands**, immutable sets of files; each file is named with its size and
SHA-256. The signature is made with the Ed25519 key registered as the
gateway's observer address, so the registry, not the server you asked, says
whose document it is. The digests then make every file checkable on its own,
so the bytes may come from the publisher, a mirror, a CDN or other gateways
over BitTorrent without anyone in between being trusted. Nothing in this
chain vouches for what an index *says*: a root-TX band entry is a claim about
where an item lives, and a gateway checks that claim when it serves the item.

## Discovery

A gateway that publishes says so in `/ar-io/info`:

```console
$ curl -s https://gateway.example/ar-io/info | jq .indexes
{
  "manifestUrl": "/ar-io/indexes",
  "names": ["parquet-l1", "root-tx-index"],
  "feeds": {
    "parquet-l1": "/ar-io/indexes/feed/parquet-l1.xml",
    "root-tx-index": "/ar-io/indexes/feed/root-tx-index.xml"
  }
}
```

The block is absent when the gateway publishes nothing or its publication is
currently invalid, so its presence is a reasonable signal that the document is
fetchable. `manifestUrl` and the feed URLs are relative to the gateway's own
origin. `names` is for choosing which publishers to fetch at all; the
document itself is the authority on what each index contains. `feeds` names
the [RSS feed](#following-an-index-in-a-bittorrent-client) of each index
that has a band offered as a torrent, when the gateway serves feeds at all
(it needs a public origin). A list of every gateway's feeds is therefore one
`/ar-io/info` request per registered gateway.

To find publishers, walk the gateway registry, fetch `/ar-io/info` from each
gateway's registered FQDN, and keep those with an `indexes` block.
turbo-gateway.com publishes both root-TX and L1 bands.

## The publication document

`GET /ar-io/indexes` returns the document with `Content-Type:
application/json`, an `ETag` of its SHA-256 and a `Content-Digest`. A
shortened real example, with 254 of the 257 file entries removed:

```json
{
  "expiresAt": "2026-09-24T13:21:52.121Z",
  "indexes": [
    {
      "bands": [
        {
          "files": [
            { "name": "00.cdb", "sha256": "80c34b0b…", "size": 5694 },
            { "name": "01.cdb", "sha256": "f00c7ba3…", "size": 4462 },
            { "name": "manifest.json", "sha256": "984eca29…", "size": 41134 }
          ],
          "http": { "baseUrl": "/ar-io/indexes/root-tx-index/band-tip/" },
          "id": "band-tip",
          "records": 2000
        }
      ],
      "kind": "cdb64-root-tx",
      "name": "root-tx-index"
    }
  ],
  "issuedAt": "2026-09-23T13:21:52.121Z",
  "previousManifestSha256": null,
  "publisher": "8co3hTMQPkJjUufomAsSJmVprkdVzwH6RkWXLRKpn5wJ",
  "sequence": 1,
  "signature": {
    "alg": "ed25519",
    "keyId": "8co3hTMQPkJjUufomAsSJmVprkdVzwH6RkWXLRKpn5wJ",
    "sig": "qk1AzO…"
  },
  "version": 1
}
```

### Top-level fields

| Field | Type | Meaning |
|---|---|---|
| `version` | `1` | Schema version. A reader rejects a version it does not know. |
| `publisher` | string | The publishing gateway's **wallet** address, as registered. |
| `sequence` | integer ≥ 0 | Monotonic per publisher. |
| `previousManifestSha256` | hex string or `null` | SHA-256 of the previous document, chaining publications into a history. |
| `issuedAt`, `expiresAt` | ISO 8601 | When it was signed, and when to consider it stale. |
| `indexes` | array | The indexes offered, each with a unique `name`. |
| `signature` | object | Detached signature; see below. |

### Index entries

| Field | Type | Meaning |
|---|---|---|
| `name` | `[a-z0-9-]{1,64}` | Unique within the document. |
| `kind` | `[a-z0-9-]{1,64}` | What the bands are and how to read them. Version 1 defines three kinds: `cdb64-root-tx` (root-TX bands), `parquet-l1` (L1 bands) and `parquet-l2` (L2 bands). |
| `filter` | any JSON | Optional. For `cdb64-root-tx`, the `ANS104_UNBUNDLE_FILTER` the index was built under, which says which bundles it covers. For `parquet-l2`, the [selection](#l2-bands) its bands declare. |
| `bands` | array | The bands currently offered. |

### Bands

| Field | Type | Meaning |
|---|---|---|
| `id` | `[A-Za-z0-9._-]{1,128}` | Unique within its index. Never `.`, never contains `..`, never a reserved name. A band lists at least one file. |
| `files` | array of `{name, size, sha256}` | Every file in the band. `name` has the same pattern as `id`; `sha256` is lowercase hex. |
| `heightRange` | `[start, end]` or `[start, null]` | Optional. Block heights covered; a `null` end is still open. |
| `records` | integer | Optional, informational. |
| `http.baseUrl` | string | Optional. File names resolve against it. |
| `torrent` | object | Optional. `infohashV1` (40 hex), `infohashV2` (64 hex, hybrid torrents), `magnet`, `torrentUrl` (`/ar-io/indexes/torrents/<infohashV1>.torrent` on an AR.IO gateway, so a band rebuilt under its id gets a new one). Present only when the publisher runs a torrent engine. The torrent's name is the first 16 hex characters of SHA-256 over one line per file, `<name>\0<size>\0<sha256 hex>\n`, with files in bytewise name order: publishers of the same bytes share one infohash, and it is the `<torrent name>` of the WebSeed route. Only the info dictionary is covered by these infohashes: trackers and WebSeeds in the `.torrent` are unsigned. |
| `arweave.manifestTxId` | 43-char ID | Optional. Where the band is archived on Arweave. |
| `metadata` | object | Optional, kind-specific. |

A band is immutable in the sense that matters: a consumer holding a file with
the listed digest has that file, whatever it is called and wherever it came
from. A publisher adds bands and retires old ones; the rolling band near the
chain tip (`band-tip` above) is replaced under the same `id` with new digests.

Documents larger than 4 MiB are rejected by the reference implementation
before parsing. A band of 256 partitions costs about 30 KB, so this is not a
practical limit.

## Verifying a publication

A document is trustworthy when all of these hold. Checking them in this
order means the one network call, the registry lookup, is spent only on a
document that is at least well formed.

1. **It parses and validates.** `version` is `1` and the fields have the types
   and patterns above.
2. **The key belongs to the publisher.** Look up the gateway whose wallet is
   `publisher` in the registry: `getGateway` in the AR.IO SDK, or, if you
   trust that gateway, the entry for that wallet in a gateway's
   `/ar-io/peers`, which is what the `index-swarm` sidecar reads. Its
   `observerAddress` must equal `signature.keyId` exactly. Both are base58;
   compare the strings. A document naming a gateway that is not registered is
   untrusted.
3. **The signature is valid.** `alg` is `ed25519`. The public key is the
   32 bytes `keyId` base58-decodes to. The signed message is the UTF-8 of
   the fixed prefix `ar-io-index-publication/v1` and a newline (`\n`),
   followed by the [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)
   canonical JSON of the document **with the `signature` member
   removed**. Every other member is included, even ones you do not
   recognise. `sig` is the 64-byte
   signature in standard base64. The prefix is domain separation: the
   observer key signs other things too (Solana transactions, HTTPSIG
   responses, and in a wallet, arbitrary messages), so a signature over bare
   JSON must never count as a publication.
4. **It is not a rollback.** Remember the highest `sequence` you have accepted
   from this publisher and refuse a document with a lower one. An equal one is
   fine, and is what you get when you poll an unchanged publisher.
5. **It is current.** If `expiresAt` has passed, the publisher has stopped
   signing. Keep using the bands you already hold, and alarm. Whether to
   install anything new from an expired document is your policy: expiry means
   the publisher has gone quiet, not that its bands have gone bad, so the
   reference subscriber installs anyway with a warning. A stricter consumer
   may refuse.

Which server returned the document does not appear anywhere in this list, and
that is the point. The signature is over content, not transport: a copy served
by a mirror verifies exactly as well as the original.

**Canonical JSON.** Use a JCS library (`rfc8785` in Python,
`json-canonicalize` in JavaScript). A key-sorted, whitespace-free
serialization is not a substitute. It disagrees with RFC 8785 on numbers
such as `1e-7` and `1.0`, and on the sort order of keys outside the Basic
Multilingual Plane. Unknown fields a publisher adds later can carry either.

**The response signature.** The gateway also signs the HTTP response
(RFC 9421, configured by the `HTTPSIG_*` settings in
[envs.md](envs.md)), covering the status,
`Content-Type`, `Content-Digest` and the request path. It signs every
response that serves a band file the same way. That proves which
gateway answered, which is useful for accountability, but it is not a
substitute for step 3: it disappears when the document is copied elsewhere,
and the document's own signature does not.

**Chaining.** `previousManifestSha256` is the SHA-256 of the previous
document exactly as served. Publishers write the canonical form of the whole
signed document, so hashing the body you received reproduces it; a consumer
keeping history can check that each document names the one before it.

## Fetching band files

A band's files are addressed two ways. Use whichever is convenient; the
digest is the same whichever you use, so check it every time.

| Route | Addresses |
|---|---|
| `GET /ar-io/indexes` | The publication document itself |
| `GET /ar-io/indexes/<name>/<band>/<file>` | A file by name, within the current publication |
| `GET /ar-io/indexes/blob/<sha256>` | A file by content |
| `GET /ar-io/indexes/webseed/<torrent name>/<file>` | A file as a BEP 19 WebSeed, for bands offered as torrents |
| `GET /ar-io/indexes/torrents/<v1 infohash>.torrent` | A band as a torrent, at its `torrentUrl` |
| `GET /ar-io/indexes/feed/<index>.xml` | An RSS feed of an index's torrents (see [below](#following-an-index-in-a-bittorrent-client)) |

The three routes that serve file bytes (by name, blob and WebSeed) are the
**byte routes**. Only a publisher serves them: they resolve against the
gateway's own publication, so a subscriber that has installed the same bands
answers `404`. A subscriber shares its bands over BitTorrent, not HTTP.

When a publisher meters the byte routes (see [Metering](#metering)), their
successful responses are `private`, and every error is `no-store`. The
`Cache-Control` of each route is listed in
[running behind nginx](index-swarm.md#running-behind-nginx).

Prefer the blob route. A name is reused whenever a band is rebuilt, which the
rolling tip band is on every cadence, so named files must be revalidated and
a cache in front of the publisher cannot keep them. A digest can never change
meaning, so a cache may hold a blob indefinitely (a shared one, such as a
CDN, only when the publisher does not meter). The sidecar fetches by digest.

Only files the current publication lists are served. A name the document does
not list is a 404 even if a file of that name exists on the server, and a
blob is served only while some listed file has that digest.

The byte routes support a single `Range` (`206` with `Content-Range`), which
is how a download resumes and how a WebSeed client reads pieces. A request
for several ranges gets the whole file. Responses carry
`ETag: "<sha256>"` and `Repr-Digest: sha-256=:<base64>:`, the digest of the
whole file, even on a partial response; full responses also carry
`Content-Digest`. A response that serves a file also carries
`X-AR-IO-Index-File: <sha256>`, and is signed with HTTPSIG like the document
(below), the signature covering `Content-Digest` or, on a range,
`Repr-Digest`. Both routes read the same bytes: the publisher's hard link
for the listed digest, which pins the bytes that were hashed. On the named
route the name is only a lookup key for that digest, so a band rebuilt under
the same name before the next document is not served in its place. A `503`
with `Retry-After` means the publisher is part way through replacing a band:
the digest has no link yet, or the linked file no longer has the size the
document names. Neither route falls back to reading the file by name, since
only the link is known to hold that digest's bytes. Fetch the document again
after the delay.

```console
# The band's own manifest, by name
$ curl -s https://gateway.example/ar-io/indexes/root-tx-index/band-tip/manifest.json

# One partition, resuming after the first 4096 bytes
$ curl -s -H 'Range: bytes=4096-' -o 00.cdb.part \
    https://gateway.example/ar-io/indexes/root-tx-index/band-tip/00.cdb

# The same partition by digest, from anywhere that has it
$ curl -s -o 00.cdb https://gateway.example/ar-io/indexes/blob/80c34b0b…
$ sha256sum 00.cdb
```

## Following an index in a BitTorrent client

A publisher that offers torrents also serves an RSS 2.0 feed of each index,
at `/ar-io/indexes/feed/<index>.xml`, and lists it in `/ar-io/info` (see
[Discovery](#discovery)). It has one item per band offered as a torrent,
newest heights first. An item's enclosure is the band's `.torrent` and its
link is the magnet. Subscribe to the feed in a BitTorrent client with an
auto-download rule, and the client takes every band now and each new band
as it is published.

The `.torrent` a gateway serves names that gateway as a WebSeed (BEP 19), so
a client can finish a band with no seeders at all, as long as the gateway
still offers the band (see [Keeping up](#keeping-up-with-the-l1-index)), the
WebSeed is on and the client is within the gateway's allowance. A client
uses the WebSeed alongside its peers from the start, not only when they
stall: expect a good share of each band to come over HTTPS from the gateway,
through its meter when it meters (see [Metering](#metering)). Past its
allowance the gateway answers the client's WebSeed requests with `429` or
`402`, and the client still has its peers. An operator who wants strangers on peers alone sets
`INDEXES_TORRENT_WEBSEED=false`. Either way the client checks every piece
against the torrent's hashes, so the WebSeed cannot slip in different bytes.

### Downloading the whole L1 index

The `parquet-l1` index is every Arweave block and transaction as Parquet, in
bands of heights: about 15 GB in 24 bands in October 2026. In qBittorrent:

1. **Options → RSS:** turn on fetching RSS feeds and the RSS torrent auto
   downloader.
2. **View → RSS Reader** (the RSS tab is hidden until you do), then **RSS
   tab → New subscription:**
   `https://gateway.example/ar-io/indexes/feed/parquet-l1.xml`.
3. **RSS Downloader:** add a rule with nothing in "Must contain", apply it to
   the feed, and set the save path to an empty folder, such as
   `~/arweave-l1`.

Every band is added at once. qBittorrent downloads them all together unless
torrent queueing is on (**Options → BitTorrent → Torrent Queueing**), which
lets only a few be active at a time. Each band lands
in its own folder, named after its torrent (`ario:torrentName`, 16 hex
characters), not its band id: the name comes from the files, so publishers
of the same files agree on it. The folder's `band.json` says which heights
it holds.

To check what arrived against the chain, first rename each folder to its
band id (the item's `ario:band`): a band's name is its identity, and
[`index-l1-verify`](cli.md#index-l1-verify) and the importer refuse a folder
not named for what it holds. Then run `index-l1-verify` over the folder.
It needs no gateway, only a core image with this release's verifier.
`--anchor-from` binds the bands to the chain (without it the run says it is
not anchored, and fails unless `--allow-unanchored`), and `--publication`
binds them to what their publisher signed:

```bash
IMAGE=ghcr.io/ar-io/ar-io-core:latest
docker run --rm -u "$(id -u):$(id -g)" -v "$HOME/arweave-l1:/bands:ro" \
  -w /app --entrypoint /nodejs/bin/node "$IMAGE" \
  /app/dist/cli/cli.js index-l1-verify --bands-dir /bands \
  --anchor-from https://<gateway one>,https://<gateway two> \
  --publication https://<publisher gateway>/ar-io/indexes/publication.json \
  --publisher-key <the publisher's observer address>
```

`l1-4` bands carry [witnesses](#witness-files) that bind every block, so a
whole set verifies with no `--allow-*` flag beyond the anchor. `l1-3`
bands report every block below the 2.0 fork, and the post-2.0 blocks
holding a format-1 transaction with data (none from height 2,000,000), as
`unbound`: read the result's `unbound` and `assurance`, and pass
`--allow-unbound --allow-unverified-format1` only if that is enough for
your use.

Then query it where it lies, for example with DuckDB:

```sql
SELECT count(*) AS blocks, max(height) AS tip
FROM read_parquet('~/arweave-l1/*/blocks.parquet');
```

To load it into a gateway's `core.db` with
[`index-l1-import`](cli.md#index-l1-import), rename each folder to its band
id (the item's `ario:band`) first: the importer keys its ledger on band ids
and refuses a folder that is not named for what it holds. A folder with no
`band.json` (a retired copy, or one not finished arriving) is ignored and
listed, never read. A gateway is better served by the
index-swarm sidecar, which installs bands under their ids itself.

### Keeping up with the L1 index

Bands are replaced. The band at the tip is rebuilt each day from the same
starting height with more blocks; once a whole range of 100,000 heights is
done, one band for it replaces the smaller bands beneath it; and a band given
a new layout is published again under new files. A replacing band names
what it replaces in `ario:supersedes`, as far as the publisher honours the
claim. A client following the feed keeps the old folders beside the new, and
`index-l1-verify` refuses a set whose bands overlap. To prune, compare the
folders' `band.json` files:

- delete a folder whose `heightRange` lies inside another folder's;
- of two with the same `heightRange`, keep the later layout (`schema`). Two
  of the same layout hold the same rows, so keep either.

A band that leaves the feed before the client has it is gone for good: the
gateway stops seeding it, its WebSeed answers `404` and the tracker refuses
it. Remove such a torrent from the client; its replacement is in the feed.

Bands of `root-tx-index` overlap by design (a recent band beside the history
beneath it), so none of this applies to them.

A band appears once the publisher has built its `.torrent`. Bands offered
only over HTTP are not in the feed. The feed is not metered and asks to be
polled at most every 30 minutes (`<ttl>`).

| Element | Value |
|---|---|
| `guid` | `urn:btih:<v1 infohash>`. A band rebuilt under the same id has a new infohash, so it is a new item, and an unchanged band is never fetched twice |
| `title` | The band id and its heights, such as `l1-h1900000-1999999-f5b1208c-c2113d5c78aa (heights 1900000 to 1999999)` |
| `description` | Its file count, size and layout (a layout that is not a plain name is left out: readers render descriptions as HTML), and the folder it is saved in |
| `enclosure` | The `.torrent`, `type="application/x-bittorrent"`, as the gateway serves it: `length` counts its WebSeed |
| `link` | The magnet link, as the publication signs it |
| `pubDate` | When the publication was issued (the publication does not record when each band first appeared) |
| `ario:band`, `ario:infohashV2`, `ario:heightFrom`, `ario:heightTo` | The band's id, v2 infohash and heights; `heightTo` is absent for a band open at the tip |
| `ario:torrentName` | The torrent's name, which is the folder a client saves the band in |
| `ario:supersedes` | One per band id this band replaces: its metadata's claims as the publisher honours them (none naming the band itself, and none at all from a band on a cycle) |

The channel carries `ario:publisher`, `ario:sequence`, `ario:index`,
`ario:kind` and `ario:publication`, the SHA-256 of the publication document
the feed was built from. The `ario` prefix is bound to
`urn:ar-io:index-feed:1`.

**What to trust.** The feed is a view of the publication, not a second
authority. A torrent pins its bytes to its infohash, but only the signed
publication says that an infohash is this publisher's band. A client that
trusts the gateway it subscribes to can stop here. To check:

1. Fetch `/ar-io/indexes` and [verify it](#verifying-a-publication).
2. Check that its SHA-256 (also its `ETag`) equals the feed's
   `ario:publication`, and the `X-AR-IO-Index-Feed` response header. If the
   publication has moved on, fetch both again.
3. Check that each item's v1 infohash is a `torrent.infohashV1` the
   publication lists for that band, and that the `.torrent`'s info
   dictionary hashes to it.

What the infohash leaves out is the rest of the `.torrent`: its trackers and
the WebSeed. The gateway that served it chose those, and they decide only
where pieces come from, never what they are. With `HTTPSIG_ENABLED`, both
responses are signed with HTTPSIG. The feed's signature covers
`X-AR-IO-Index-Feed` and `Content-Digest`, binding its bytes to the
publication it names; the `.torrent`'s covers `X-AR-IO-Index-Torrent` (its
v1 infohash) and `Content-Digest`, binding the trackers and WebSeed to that
gateway. The index-swarm sidecar reads the publication directly, does not
use the feed, and drops every WebSeed from a torrent it is given.

## Metering

The byte routes are metered like data egress. When the gateway enables its
rate limiter, each response spends tokens in proportion to the size of its
body: the range, for a `Range` request; the minimum, for a `HEAD`; nothing,
for a `304`. A client that runs out gets `429 Too Many Requests`.
When x402 is enabled as well, it gets `402 Payment Required` with payment
requirements instead, and can pay to continue. The publication document
itself is never metered, so a client that has run out of tokens can still see
what it could fetch.

The limits and prices in force are advertised in `/ar-io/info`, in the
`rateLimiter` and `x402` blocks (present only when enabled). See
[x402-and-rate-limiting.md](x402-and-rate-limiting.md) for how to pay and how
the buckets work. The torrent swarm is the free path: peers seeding a band are
not metered by anyone.

The torrent route answers 404 until the publisher has built a torrent for the
band, which is normal; the HTTP routes always work.

## Looking up one ID

A `cdb64-root-tx` band maps a data item ID to where the item lives in its root
transaction. It is a [partitioned CDB64 index](cdb64-format.md#partitioned-cdb64-index-format):
records are split into up to 256 files by the first byte of the key, and
`manifest.json` says which file holds which prefix. You never need the whole
band to answer one lookup.

Every partition in a published band's manifest is a local `file` location,
listed with its digest in the band's `files`. Refuse a band whose manifest
names a partition by URL or Arweave ID: nothing in the publication checks
bytes fetched from there, and following it lets a publisher choose what your
client requests.

1. Base64url-decode the 43-character data item ID to its 32-byte key.
2. Fetch and verify `manifest.json`, and find the partition whose `prefix` is
   the key's first byte as two lowercase hex digits. No such partition means
   the band holds no key with that prefix.
3. Fetch and verify that partition's file, `location.filename`.
4. Look the key up with the [CDB64 lookup algorithm](cdb64-format.md#lookup-algorithm):
   hash the key with DJB64, `h = 5381`, then `h = ((h << 5) + h) ^ byte` for
   each byte, modulo 2^64. The table is `h % 256`; the header entry for it is
   at `table * 16` (position and slot count, each uint64 little endian).
   Probe from slot `(h >> 8) % slots`, each slot 16 bytes (hash, record
   position), stopping at an empty slot (position 0). A slot whose hash
   matches points to a record: key length and value length (uint64 LE), then
   the key, then the value. Compare the key, since hashes collide.
5. Decode the value as MessagePack. It is a map with short keys; see
   [the value format](cdb64-format.md#root-tx-index-value-format).

The value is one of four shapes. `r` is the root transaction ID. `p` is the
bundle path from the root to the item's parent, whose first element is the
root. `i` and `d` are the byte offsets of the item's header and payload
within the root transaction's data, and `s` is the item's total size.

| Shape | Keys |
|---|---|
| Simple | `r` |
| Complete | `r`, `i`, `d`, optionally `s` |
| Path | `p` |
| Path complete | `p`, `i`, `d`, optionally `s` |

A decoder only needs a handful of MessagePack types: fixmap (`0x80`–`0x8f`),
fixstr (`0xa0`–`0xbf`) for the keys, bin 8 (`0xc4`) for the 32-byte IDs,
fixarray (`0x90`–`0x9f`) for the path, and the integer forms listed under
[integer encoding](cdb64-format.md#integer-encoding). **Offsets of 2^32 and
above are encoded as float 64 (`0xcb`)**, not as a 64-bit integer, so a
decoder that handles only integer types will fail on any item more than
4.29 GB into its root. The values are exact.

Bands may overlap, but they should not disagree: an item has one location,
so any band that holds its key gives the same answer. The gateway itself
searches bands newest first, by the end of each band's `heightRange` (an
open-ended tip band first, then the start as a tie-break), and takes the
first match.

## L1 bands

A `parquet-l1` band carries the Arweave base layer (L1: blocks,
transactions, tags, owners) for one height range, in Parquet. A new gateway
can import it instead of indexing the chain block by block, and a client can
query it where it sits. The whole chain was 24 bands, about 15 GB, in
October 2026, and grows with the chain.

A band is a directory of `band.json` and these files:

| File | Holds |
|---|---|
| `blocks.parquet` | One row per block |
| `block_transactions.parquet` | Each block's transactions, in the block's order |
| `transactions.parquet` | One row per transaction. `signature` is null unless the publisher keeps signatures |
| `tags.parquet` | Transaction tags, names and values in plaintext |
| `wallets.parquet` | Owners' addresses and keys |
| `lookup_tx_id.parquet`, `lookup_wallet.parquet`, `lookup_tag.parquet` | From layout `l1-3`: the [lookup files](#lookup-files) |
| `witness_v1_data_roots.parquet`, `witness_fork_2_0.parquet` | From layout `l1-4`: the [witness files](#witness-files) (`witness_fork_2_0` only in a band holding heights below 422,250) |

`band.json` names the band's layout (`schema`: `l1-1`, `l1-2`, `l1-3` or
`l1-4`), its heights, and for each table, lookup and witness file its row
count and a digest of its rows, independent of the Parquet bytes (under
`tables`, `lookups` and `witnesses`). A band's id is
`l1-h<from>-<to>-<publisher tag>-<digest>`: its heights, a tag of its
publisher, and the first 12 hex digits of a digest of its tables' rows (the
lookup and witness files are not part of it). Two publishers of the same chain therefore
write bands whose ids differ only in the publisher tag, with the same
digest, and can compare them without exchanging files.

`band.json` holds only what the rows determine, written one way: its
`createdAt` is the time of the band's top block, not when it was built. Two
publishers of the same rows write the same `band.json` byte for byte, so the
same band files, the same torrent and one swarm. What is a publisher's own,
the bands a band replaces and when it was built, is kept beside the band in
`.publisher.json`, which is not one of the band's files; the bands it
replaces reach readers through the signed publication (`metadata.supersedes`).
A band written before this (2026-10) also carries `supersedes`, and its build
time as `createdAt`; readers accept both, and a publisher settles its own in
place.

A reader checks each file against the signed digests, then its footer and
schema against the layout and the row counts in `band.json`. It refuses a
footer longer than 8 MiB before parsing it, since decoding a footer takes
about 20 times its size in memory. That allows about 1.8 billion rows in a
table at DuckDB's default row-group size, and far fewer in a lookup file,
whose row groups are smaller (`lookup_tag` reaches it at about 210 million
rows). A publisher runs the same check before it writes `band.json`, so it
never publishes a band its readers would refuse. The file set it expects is
the one the layout declares. A reader that does not know a layout refuses
the band and names the layout.

## Witness files

Two things the chain committed to cannot be read from a band's tables: the
data root of a format-1 transaction (its header carries none: the root is
of its data), and a pre-2.0 block's place in the 2.0 seed of
`hash_list_merkle` (a pre-2.0 block hash commits to the full wallet list,
which no header carries). Without them a verifier cannot bind a block
holding a format-1 transaction with data, nor any block below the 2.0 fork,
and reports them `unbound`. From layout `l1-4` a band carries both, as
witness files: untrusted values a verifier recomputes and checks against
hashes the chain fixes, so it needs no trust in whoever wrote them.

| File | One row per | Columns | Sorted by |
|---|---|---|---|
| `witness_v1_data_roots.parquet` | Format-1 transaction with `data_size > 0` (none from the 2.9.6 fork) | `height` UBIGINT, `id` BLOB (32), `data_root` BLOB (32) | `height, id` |
| `witness_fork_2_0.parquet` | Height below 422,250 (only in a band holding one) | `height` UBIGINT, `tx_root` BLOB (empty, or 32), `fold` BLOB (48), `h2` BLOB (48) | `height` |

- **`data_root`** is the v1 data root as Arweave computes it
  (`ar_tx:chunk_binary`: 256 KiB chunks, the remainder last, no
  rebalancing; not `arweave-js`'s `computeRootHash`). A verifier recomputes
  the block's `tx_root` with it in the transaction's leaf: from the 2.0 fork
  against the header's `tx_root`; below it, against the row's `tx_root`.
- **`tx_root`** is the block's transition `tx_root`: Arweave's `tx_root`
  rule (`generate_size_tagged_list_from_txs`: transactions sorted by format
  then id, each leaf its data root and the running end offset, no padding
  below 2.5) over its transactions, as Arweave's 2.0 fork computed it; empty
  for a block without transactions.
- **`fold`** is the 2.0 seed fold through the height:
  `SHA-384(fold below ‖ deepHash([indep_hash, decimal weave_size, tx_root]))`,
  from empty below height 0 (`ar_unbalanced_merkle:block_index_to_merkle_root`).
  The fold through 422,249 is block 422,250's `hash_list_merkle`. A
  verifier recomputes each fold from the one below and requires it equal,
  and binds a run of pre-2.0 blocks once its fold reaches a value the chain
  fixes: block 422,250's `hash_list_merkle`, or a fold pinned in the
  verifier. ar-io-node pins the folds through 99,999, 199,999, 299,999,
  399,999 and 422,249:

  | Height | Fold (base64url) |
  |---|---|
  | 99,999 | `3uxEfY2W3pKx5lqRvvksHCVczmZy0mtU6vY-aDELGlzgP6JAdLeztd3ib6bk-ddq` |
  | 199,999 | `MTYJHNVyj5NO5Vgwm7kPrmE1hMD4lQge_LE9WG3nUmlPRStx39oF5uibHBD4mF3d` |
  | 299,999 | `5fyunSDM_5oMnjyt9M0ZB5XKpW5ZjmrvJu7rrC5Yn1nUzfJ1xeN8x8-Y_I_mVB-i` |
  | 399,999 | `1s-ckibn5_evNgrs82K8d_J4byo8xc3GKV0rQK4uw_Iwp0Oia-Xstp5yAfXYH7Nk` |
  | 422,249 | `akSjDrBKPuepJMOhO_S9C-iFp5zn9Glv57HGdN_WPqEToWC0Ukb37Gzs4PDA7oLU` (block 422,250's `hash_list_merkle`) |

  The first four fold out of Arweave's own 2.0 checkpoint
  (`apps/arweave/priv/fork_2_0_checkpoint` at the parent of Arweave commit
  d43ba2b9, SHA-256 `714be0bc…44d4`); anyone can recompute them.
- **`h2`** is the block's "2.0 hash": Arweave's 2.0–2.4 `indep_hash` rule
  applied to its 1.0 header, with `tx_root` set to the transition root,
  its transaction ids sorted, block tags empty and the default proof of
  access (`ar_header_sync:download_block`). It covers every header field
  the fold does not (timestamp, `last_retarget`, both difficulties, nonce,
  `hash`, reward address, reward pool, `wallet_list`, `hash_list_merkle`)
  and the transaction ids. Arweave ships every one in
  `genesis_data/hash_list_1_0` (SHA-256 `d161502a…ca6f`) and checks each
  pre-2.0 header a node syncs against it. A verifier recomputes it from the
  band's own fields (an empty `reward_addr` read as `unclaimed`) and
  requires it equal, and folds them, `SHA-384(fold ‖ h2)` from empty, to
  the fold of `hash_list_1_0` pinned at the same heights:

  | Height | Fold of the 2.0 hashes (base64url) |
  |---|---|
  | 99,999 | `tP4Ss_y8j-c6EPNQDFd-STooBLOy4B-dxTmWwdK-wzgQ04RhmVbVWw7fu_Bk2ip-` |
  | 199,999 | `iNz57dW3y_JZUB3kvSFLCfLUunVnLM76LJixac82_83jD2kBWQTS7DbljA59ebQU` |
  | 299,999 | `4HRV8yVq8rxRfqaS6g6ml6TZFxCBu0Y77V-pLGEqTlJ8WaJ4ZNP3p-wzJUeukUvi` |
  | 399,999 | `GuZEzEU_BOTJa44c88OMw8lJvDoFELyzxLY4ljverSJBZVprRd06lDdd8K8UOJDM` |
  | 422,249 | `Fznt4jqwgcOvFiFxtt05_vT7p9A3aE9FJPalyfkIfjBjOv3vC9Ay8AdbQZuJAH2r` |

  Those fields are bound to Arweave's checkpoint, not to a hash the chain's
  own blocks reach.

A run of pre-2.0 blocks is bound once both folds reach their pins, so a
history band below the fork is bound alone, its folds running from the
pins below it to the pins at its top.

A row for anything else (a transaction that is not format 1 with data at
its height, a height outside the band or at or above the fork), a repeated
row, a row out of order or malformed, a file that does not digest to
`band.json`, or a format-1 transaction whose `data_root` column is not
NULL, fails the band. A missing row is allowed, and honest: the
block (and, below the fork, the run of blocks whose fold passes through it)
stays `unbound`. A band whose witnesses its publisher could not confirm is
published as `l1-3` instead.

Like lookups, witnesses are not part of a band's id: a publisher adds them
to a published band in place, and only `band.json` and the new files
change.

## Lookup files

Parquet has no index, so finding one transaction by id means scanning every
band's `id` column. A lookup file is a small Parquet file sorted by a key, in
row groups of 16,384 rows. Parquet keeps each row group's minimum and
maximum, and in a sorted file those ranges do not overlap. A reader holding
a key reads the footer and then every row group whose range includes the
key: one or two for a transaction id, more for a wallet or tag with many
rows.

| File | One row per | Columns | Sorted by |
|---|---|---|---|
| `lookup_tx_id.parquet` | Transaction | `id8`, `height` | `id8, height` |
| `lookup_wallet.parquet` | Transaction an address signed (`role` 0), and one it received (`role` 1, non-empty `target`) | `addr8`, `role`, `height`, `data_size` | `addr8, height, role, data_size` |
| `lookup_tag.parquet` | Distinct (name, value) tag pair | `name8`, `val8`, `name`, `value`, `txs` (distinct transactions), `first_height`, `last_height` | `name8, val8, name, value` |

### Keys

The keys are unsigned 64-bit integers, because readers prune on integer
statistics and not on binary ones. Two encodings, which any client
reproduces:

- `prefix64(bytes)`: the first 8 bytes, big-endian, zero-padded on the right
  when shorter. Used for ids and addresses, which are already uniform
  hashes. In DuckDB: `('0x' || rpad(left(hex(x), 16), 16, '0'))::UBIGINT`.
- `sha256_64(bytes)`: `prefix64` of the SHA-256. Used for tag names and
  values. In DuckDB: `('0x' || left(sha256(x), 16))::UBIGINT`.

| Encoding | Input | Output |
|---|---|---|
| `prefix64` | id `O048e9pT5nX1CPrMjGC1y1dWdtd3AChFX27hoRsVIdA` (its 32 bytes) | `0x3b4e3c7bda53e675` = 4273419599062754933 |
| `prefix64` | the single byte `0xab` | `0xab00000000000000` |
| `sha256_64` | `App-Name` (UTF-8) | `0xbf6cc2a967f23a82` = 13793613791578176130 |
| `sha256_64` | `ArDrive-App` | `0xa2c30101e8045f65` = 11728218962302099301 |

### Reading through a lookup file

A key is a pointer, not an answer: two values may share one. So a read takes
two steps: the lookup file for the heights, then the table at those heights
for the row. The height filter confines the second read to the row groups
that hold them.

```sql
-- a transaction by id (:id is its 32 bytes)
SELECT t.* FROM read_parquet('…/*/transactions.parquet') t
WHERE t.height IN (
    SELECT height FROM read_parquet('…/*/lookup_tx_id.parquet')
    WHERE id8 = ('0x' || rpad(left(hex(:id), 16), 16, '0'))::UBIGINT)
  AND t.id = :id;

-- a wallet's transactions sent, bytes stored, first and last block: no table read
SELECT count(*) AS sent, sum(data_size) AS bytes_stored,
       min(height) AS first_height, max(height) AS last_height
FROM read_parquet('…/*/lookup_wallet.parquet')
WHERE addr8 = ('0x' || rpad(left(hex(:address), 16), 16, '0'))::UBIGINT AND role = 0;

-- the most used App-Name values, exact
SELECT CAST(value AS VARCHAR) AS app, sum(txs) AS txs
FROM read_parquet('…/*/lookup_tag.parquet')
WHERE name8 = ('0x' || left(sha256('App-Name'::BLOB), 16))::UBIGINT
  AND name = 'App-Name'::BLOB
GROUP BY app ORDER BY txs DESC LIMIT 15;
```

Finding one transaction across the whole chain over HTTP fetches about
12.9 MB in 0.7 s through the lookup files, against 2.6 GB in 26 s scanning
every band's `id` column. A band of a layout before `l1-3` has no lookup
files, so a transaction in it is found only by a scan.

`lookup_wallet.data_size` and `lookup_tag.txs` are answers rather than
pointers, so a wallet's bytes stored and a tag's count need no table read.
They carry the same trust as the tables: each file's digest is signed in
the publication, and anyone can recompute them from the tables
(`ar-io-node index-l1-verify --bands-dir` does, and checks each file is in
its key order, which the `l1-3` digests alone do not show).

A lookup file's `rowDigest` is taken as a table's, over its rows in the
order of its "Sorted by" columns. In an `l1-3` band that order compares
the 64-bit columns among them (`id8`, `addr8`, `name8`, `val8`, `height`,
`data_size`) as their decimal text, so
`10` sorts before `100` before `9`, though the file itself is sorted by
value: to reproduce an `l1-3` lookup's digest, sort its rows that way
first. An L2 band's lookups (below) are digested by value, in the file's
own order, as a future L1 layout's will be.

## L2 bands

A `parquet-l2` band carries the ANS-104 data items (L2) of one height range
that a declared **selection** takes, in Parquet: one app's items, say, so a
gateway can import them instead of unbundling the chain to find them. A data
item's height is its root transaction's, and bands cover the same fixed
heights as [L1 bands](#l1-bands), so an L2 band lies over the L1 band of the
same heights. The `index-export` service builds them from a gateway's
ClickHouse (see [index-export.md](index-export.md#l2-bands)); a gateway
also takes bands other publishers built.

A band is a directory of `band.json` and these files:

| File | Holds | Sorted by |
|---|---|---|
| `data_items.parquet` | One row per place an item sits in its root transaction: `id`, the root's `height`, `block_transaction_index` and `root_transaction_id`, `parent_id`, `owner_address`, `target`, `anchor`, `signature_type`, `data_size`, `content_type`, `content_encoding`, `tag_count`, and its location | `height, block_transaction_index, id, root_parent_offset, offset` |
| `tags.parquet` | Each item's tags once per height, names and values in plaintext | `height, id, tag_index` |
| `wallets.parquet` | Owners' `address` and key (`public_modulus`); the address is the key's SHA-256 | `address` |
| `parents.parquet` | Every nested bundle between a held item and its root, located as an item is | `id, root_transaction_id, root_parent_offset, offset` |
| `lookup_id.parquet`, `lookup_wallet.parquet`, `lookup_tag.parquet` | The band's [lookup files](#l2-lookup-files) | by key |
| `lookup_key.parquet`, `stats.parquet` | Layout `l2-2`: the [key lookup and stats](#l2-key-lookup-and-stats), derived for the tag names `band.json` gives | by key |

Every order is ascending with nulls last. An item's location is eight
columns, `root_parent_offset`, `offset`, `size`, `data_offset`,
`owner_offset`, `owner_size`, `signature_offset` and `signature_size`, the
way a gateway's bundle index keeps them: offsets are bytes into the payload
of the item's parent bundle, and `root_parent_offset` is where that payload
starts in the root transaction's data. They are all set, or all null for an
item known to be in its root but not where.

`band.json` names the layout (`schema`: `l2-1` or `l2-2`), the heights,
the selection, under `l2-2` the tag names its key lookup and stats are
derived for (`keyTags`, `statTags`: each name once, in UTF-8 byte order, at
most 16, or an empty list), each table's row count and row digest (computed
as an L1 band's), the same for each lookup file (`lookups`), and
`createdAt`; optionally `checks`, a small free-form object of what the
builder checked. A reader refuses any field it does not declare, and
accepts both layouts. The selection is:

```json
{
  "kind": "ans104-data-items",
  "tag": {
    "name": "App-Name",
    "valuePrefix": "ArDrive",
    "excludeValuePrefix": "ArDrive-Test"
  }
}
```

An item is in it when one of its tags is named `name` exactly and its value
starts with `valuePrefix` and not with `excludeValuePrefix` (optional; it
must extend `valuePrefix`), compared as UTF-8 bytes. Each string is at most
256 bytes, and no other field is allowed.

A band's id is `l2-h<from>-<to>-<publisher tag>-<digest>`, the shape of an L1
band's. The digest is the first 12 hex digits of SHA-256 over the heights as
JSON (`[from,to]`), a newline, the selection as one line of JSON with its
keys in the order above, a newline, and one `<table>:<rows>:<rowDigest>`
line per table in name order, joined by newlines. The selection is part of
the band's identity: the same rows under two selections are two bands.
`lookups`, `keyTags`, `statTags`, `checks` and `createdAt` are not part of
it: the lookup files are derived from the tables, so the same rows give the
same id whatever their lookups, and an `l2-1` band becomes an `l2-2` band
under the same id.

A reader checks each file against the signed digests, then the file set,
each footer's columns and row count against the layout and `band.json`,
that the heights are on the L1 grid, and that the id names the band's
heights and digest. Every band of an index declares the same selection: the
publication carries it as each band's `metadata.selection`, and in the
index's `filter` when the publisher sets one. A reader refuses a band whose
`band.json` disagrees with the publication, and every band of an index
whose bands or filter disagree.

### L2 lookup files

An L2 band carries [lookup files](#lookup-files) as an `l1-3` band does,
with the same keys, row groups and two-step reads, so finding one data item,
a wallet's items or the items carrying a tag pair, such as an ArDrive
`Drive-Id`, reads a footer and a row group or two per band instead of
scanning its tables. `data_items` holds a row per place an item sits; the
lookups hold one per item and height, however many places it sits at there.

| File | One row per | Columns | Sorted by |
|---|---|---|---|
| `lookup_id.parquet` | Distinct item and height | `id8`, `height` | `id8, height` |
| `lookup_wallet.parquet` | Distinct item and height, for its owner (`role` 0), and for its `target` (`role` 1) when it has one | `addr8`, `role`, `height`, `data_size` | `addr8, height, role, data_size` |
| `lookup_tag.parquet` | Distinct (name, value) tag pair, as in an L1 band | `name8`, `val8`, `name`, `value`, `txs` (distinct items), `first_height`, `last_height` | `name8, val8, name, value` |

```sql
-- the items of one drive (:drive is its Drive-Id value)
SELECT name, value, txs, first_height, last_height
FROM read_parquet('…/*/lookup_tag.parquet')
WHERE name8 = ('0x' || left(sha256('Drive-Id'::BLOB), 16))::UBIGINT
  AND val8 = ('0x' || left(sha256(:drive::BLOB), 16))::UBIGINT
  AND name = 'Drive-Id'::BLOB AND value = :drive::BLOB;

-- then its tag rows, at those heights only
SELECT id FROM read_parquet('…/*/tags.parquet')
WHERE height BETWEEN :first_height AND :last_height
  AND tag_name = 'Drive-Id'::BLOB AND tag_value = :drive::BLOB;
```

Their row digests are taken by value, in the order each file is written
in, so a reader can digest a lookup as it reads it (unlike an `l1-3`
band's, above). A reader checks each lookup file's footer and row count as
it does a table's. The publisher derives them from the band's own tables and checks
them against those tables before it publishes.

### L2 key lookup and stats

`lookup_tag` says how many items carry a tag pair and the first and last
height among them, so a value spread over a band, an ArDrive drive active
for a year, costs the whole band's `tags` between those heights to find.
Layout `l2-2` adds two files derived for tag names the publisher chooses
and `band.json` records, so a reader uses them when the band lists the
name it needs and falls back to `lookup_tag` otherwise:

| File | One row per | Columns | Sorted by |
|---|---|---|---|
| `lookup_key.parquet` | (name, value) pair of a **key tag** (`keyTags`) and height at which an item carries it | `name8`, `val8`, `height`, `items` (distinct items carrying it at that height) | `name8, val8, height` |
| `stats.parquet` | bucket of 1,000 heights (`bucket`, the first height of it), in all (empty `name` and `value`) and per value of each **stat tag** (`statTags`) | `bucket`, `name`, `value`, `items` (distinct items and heights), `bytes` (their `data_size`) | `bucket, name, value` |

The keys are those of `lookup_tag` (`name8`, `val8`: the first 8 bytes of
the SHA-256 of the name and of the value), which maps them back to the
bytes. An item carrying a stat tag twice counts under its first value; an
item at two places in one height counts once. For turbo-gateway.com's
`ardrive-l2`, the key tags are `Drive-Id`, `Parent-Folder-Id`, `Folder-Id`
and `File-Id`, and the stat tags `App-Name`, `Content-Type` and
`Entity-Type`.

```sql
-- the heights holding one drive's records, however spread: a row group or
-- two of lookup_key, then only tags' row groups at those heights
SELECT height, items
FROM read_parquet('…/*/lookup_key.parquet')
WHERE name8 = ('0x' || left(sha256('Drive-Id'::BLOB), 16))::UBIGINT
  AND val8 = ('0x' || left(sha256(:drive::BLOB), 16))::UBIGINT;

-- bytes uploaded by app over the whole index, from the stats files alone
SELECT CAST(value AS VARCHAR) AS app, sum(items) AS items, sum(bytes) AS bytes
FROM read_parquet('…/*/stats.parquet')
WHERE name = 'App-Name'::BLOB
GROUP BY 1 ORDER BY bytes DESC;
```

A publisher that upgrades adds the two files to each published `l2-1`
band in place, under the same id, and replaces its `band.json`; a
subscriber fetches only those. A subscriber that does not know `l2-2`
refuses the band and keeps its copy, so upgrade subscribers first (see
[index-export.md](index-export.md#layout-l2-2-key-lookup-and-stats)).

## Querying a dataset over HTTP

An L1 band is Parquet, and the byte routes serve ranges, so a client can
query a published dataset where it sits: no download, no import, and no
gateway of its own. Any engine that reads Parquet over HTTP range requests
works. The examples use DuckDB, which installs its `httpfs` and `json`
extensions on first use.

Query a publisher: a subscriber answers `404` on the byte routes (see
[fetching band files](#fetching-band-files)). The byte routes are metered, so
an analytical client is a paying or allowlisted client.

**The signed document is the catalog.** There is no directory listing, so a
client cannot glob over HTTP. It reads `/ar-io/indexes`, picks the dataset by
`name`, and builds the file URLs from the band ids:

```bash
# the band file URLs for a dataset, from the signed document
curl -s https://<gateway>/ar-io/indexes \
  | jq -r '.indexes[] | select(.name=="parquet-l1") | .bands[].id' \
  | sed 's|^|https://<gateway>/ar-io/indexes/parquet-l1/|; s|$|/transactions.parquet|'
```

```sql
INSTALL httpfs; LOAD httpfs;
SELECT count(*)
FROM read_parquet([
  'https://<gateway>/ar-io/indexes/parquet-l1/<band-id>/transactions.parquet',
  ...
])
WHERE height BETWEEN 1500000 AND 1500099;
```

Only the Parquet footer and the row groups a predicate selects cross the
network.

**A range read names its file.** Every `206` carries `Repr-Digest`, the
digest of the whole file rather than of the returned range. Compare it with
the file's digest in a verified publication: that is what ties the bytes to
the publisher. When the gateway signs responses (HTTPSIG enabled, the
default, with a signing key), `Repr-Digest` is also covered by the
`signature` and `signature-input` headers; without a signer they are absent,
and the comparison with the publication is still the check.

**A cache in front breaks it.** Range reads must work end to end, and a
proxy cache zone takes them away; see
[running behind nginx](index-swarm.md#running-behind-nginx).

### Reading installed bands

A subscriber that installed the bands reads them from disk with no HTTP at
all. That is the better choice for repeated heavy queries:

```sql
SELECT * FROM read_parquet('data/indexes/installed/parquet-l1/*/transactions.parquet')
WHERE height BETWEEN 1000000 AND 1000100;
```

The sidecar installs each band as `<band id>~<generation>`, and while a band
is being replaced the old generation stays on disk beside the new one for
the grace period (`INDEX_SWARM_SUPERSEDE_GRACE_SECONDS`, 300), so a glob over the
directory can read some rows twice. So can a band and the bands it
superseded, which have ids of their own and stay installed through the same
grace period: a new tip beside the old one, or a finished `h` band beside
the twenty `d` bands it replaces. For exact counts, read only the bands the
publisher's current signed document lists (over HTTP, as above). Failing
that, before querying, drop every band whose heights lie inside a wider
band's, and keep only one of any bands with the same heights: two
generations of a band, a band and the rebuild that superseded it, or two
publishers' copies of it.

Tags are plaintext in a band, so `tag_name = 'App-Name'` is a string
comparison, where `core.db` needs two joins through its hash dictionaries.
Querying in place suits scans, aggregates over a height range, and point
lookups through the lookup files. It serves no gateway route, no GraphQL
and no trust headers. To load the dataset into a gateway's own SQLite
instead, use [`index-l1-import`](cli.md#index-l1-import): with `--fill`
(or `L1_BAND_IMPORT_ENABLED=true`, which runs it for you) while the gateway
runs, or faster with it stopped. The whole chain leaves a `core.db` of
about 120 GB.

## Reference client

A complete consumer: fetch a publisher's document, verify it against a
registered observer address, fetch the one partition that could hold an ID,
verify it, and decode the entry. It uses the Python standard library,
[`cryptography`](https://cryptography.io) for Ed25519 and
[`rfc8785`](https://pypi.org/project/rfc8785/) for the signing base
(`pip install cryptography rfc8785`); the base58 decoder,
MessagePack decoder and CDB64 reader are written out so that nothing is
hidden.

It takes the observer address on the command line rather than reading the
registry, so it stays short: get it from the publisher's gateway record
(`observerAddress`), for example with the AR.IO SDK's `getGateway`.

```python
#!/usr/bin/env python3
"""Look up a data item in a publisher's root-tx index, verifying everything.

usage: lookup.py <gateway-url> <observer-address> <data-item-id> [index-name]
"""
import base64, hashlib, json, struct, sys, urllib.request
import rfc8785
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

PUBLICATION_MAX_BYTES = 4 * 1024 * 1024  # the protocol's document limit

B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58decode(s):
    n = 0
    for c in s:
        n = n * 58 + B58.index(c)
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return b"\0" * (len(s) - len(s.lstrip("1"))) + raw


def get(url, limit):
    """Fetch at most `limit` bytes; a server can't make us buffer more."""
    with urllib.request.urlopen(url, timeout=30) as r:
        body = r.read(limit + 1)
    assert len(body) <= limit, url + ": response over %d bytes" % limit
    return body


def verify_publication(body, observer_address):
    doc = json.loads(body)
    assert doc["version"] == 1, "unknown version"
    sig = doc.pop("signature")
    assert sig["alg"] == "ed25519", "unknown algorithm"
    assert sig["keyId"] == observer_address, "not the registered key"
    # The signing base is the RFC 8785 (JCS) form of everything but the
    # signature, unknown fields included. json.dumps is not a substitute: it
    # writes 1.0 where JCS writes 1, and sorts keys differently.
    # The prefix is domain separation: see step 3 above.
    base = b"ar-io-index-publication/v1\n" + rfc8785.dumps(doc)
    key = Ed25519PublicKey.from_public_bytes(b58decode(sig["keyId"]))
    key.verify(base64.b64decode(sig["sig"]), base)  # raises if invalid
    return doc


def fetch_file(gateway, band, name):
    entry = next(f for f in band["files"] if f["name"] == name)
    data = get(gateway + "/ar-io/indexes/blob/" + entry["sha256"], entry["size"])
    assert len(data) == entry["size"], name + ": wrong size"
    assert hashlib.sha256(data).hexdigest() == entry["sha256"], name + ": bad digest"
    return data


def cdb64_get(data, key):
    h = 5381
    for b in key:
        h = (((h << 5) + h) ^ b) & 0xFFFFFFFFFFFFFFFF
    pos, slots = struct.unpack_from("<QQ", data, (h % 256) * 16)
    for i in range(slots):
        slot_hash, rec = struct.unpack_from("<QQ", data, pos + ((h >> 8) + i) % slots * 16)
        if rec == 0:
            return None
        if slot_hash == h:
            klen, vlen = struct.unpack_from("<QQ", data, rec)
            if data[rec + 16:rec + 16 + klen] == key:
                return data[rec + 16 + klen:rec + 16 + klen + vlen]
    return None


def unpack(b, i=0):
    """Decode the MessagePack subset the root-tx index uses."""
    t = b[i]
    if t <= 0x7F:
        return t, i + 1
    if 0x80 <= t <= 0x8F or 0x90 <= t <= 0x9F:
        n, i, out = t & 0x0F, i + 1, [] if t >= 0x90 else {}
        for _ in range(n):
            if isinstance(out, list):
                v, i = unpack(b, i)
                out.append(v)
            else:
                k, i = unpack(b, i)
                out[k], i = unpack(b, i)
        return out, i
    if 0xA0 <= t <= 0xBF:
        n = t & 0x1F
        return b[i + 1:i + 1 + n].decode(), i + 1 + n
    if t == 0xC4:
        n = b[i + 1]
        return b[i + 2:i + 2 + n], i + 2 + n
    sizes = {0xCC: ">B", 0xCD: ">H", 0xCE: ">I", 0xCF: ">Q", 0xCB: ">d"}
    if t in sizes:
        (v,) = struct.unpack_from(sizes[t], b, i + 1)
        return int(v), i + 1 + struct.calcsize(sizes[t])
    raise ValueError("unsupported MessagePack type 0x%02x" % t)


def b64url(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def main(gateway, observer_address, item_id, index_name="root-tx-index"):
    gateway = gateway.rstrip("/")
    doc = verify_publication(get(gateway + "/ar-io/indexes", PUBLICATION_MAX_BYTES),
                             observer_address)
    index = next(x for x in doc["indexes"] if x["name"] == index_name)
    assert index["kind"] == "cdb64-root-tx", "not a root-tx index"
    key = base64.urlsafe_b64decode(item_id + "=")
    for band in sorted(index["bands"], key=lambda b: b["id"]):
        manifest = json.loads(fetch_file(gateway, band, "manifest.json"))
        part = next((p for p in manifest["partitions"]
                     if p["prefix"] == "%02x" % key[0]), None)
        if part is None:
            continue
        value = cdb64_get(fetch_file(gateway, band, part["location"]["filename"]), key)
        if value is not None:
            v, _ = unpack(value)
            path = v.get("p") or [v["r"]]
            print(json.dumps({"band": band["id"], "rootTxId": b64url(path[0]),
                              "path": [b64url(p) for p in path] if "p" in v else None,
                              "rootDataItemOffset": v.get("i"),
                              "rootDataOffset": v.get("d"),
                              "dataItemSize": v.get("s")}))
            return 0
    print("not found", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:]))
```

It fetches by digest rather than by name, so the same code works against any
server holding the files. It does not keep a sequence high-water mark, which a
long-running consumer must (step 4 above), and it assumes each partition's
`location.type` is `file`, the only type a published band uses.

## Compatibility rules

These are what let a version 1 reader keep working as the protocol grows.

- **Unknown fields are ignored, and signed.** A reader must not reject a
  document for carrying fields it does not know, and must include them when
  canonicalizing. Rebuilding the document from known fields only produces a
  different signing base and a failed signature.
- **Unknown kinds are skipped.** An index whose `kind` a reader does not
  implement is ignored; the rest of the document is still usable.
- **A new version number is a breaking change.** Anything a version 1 reader
  would misinterpret, rather than merely not understand, gets a new
  `version`.
- **Documents have bounded shape.** At most 64 indexes, 1024 bands per
  index and 1024 files per band; names that are `Object.prototype` members
  (`__proto__`, `constructor`, `toString`, …) are refused as index names,
  band ids and file names. A reader rejects a document outside these bounds.
- **Names are stable identifiers.** Index and band names become directory
  names on consumers, which is why they are restricted to a filesystem-safe
  alphabet, can never be `.` and can never contain `..`.
