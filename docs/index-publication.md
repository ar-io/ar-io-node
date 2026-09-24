# Index Publication Protocol

How to find, verify and use the index artifacts an AR.IO gateway publishes.
This page is the contract for **consumers**: another gateway, an indexer, a
wallet or an agent that wants a publisher's indexes without trusting whatever
server, cache or peer handed them over. Operators running the sidecar that
publishes and subscribes should read [index-swarm.md](index-swarm.md) instead.

Everything here can be done with `curl` and a short script. A complete Python
client, stdlib plus one Ed25519 library, is at the end of the page.

## Table of Contents

- [The model in one paragraph](#the-model-in-one-paragraph)
- [Discovery](#discovery)
- [The publication document](#the-publication-document)
- [Verifying a publication](#verifying-a-publication)
- [Fetching band files](#fetching-band-files)
- [Metering](#metering)
- [Looking up one ID](#looking-up-one-id)
- [Reference client](#reference-client)
- [Compatibility rules](#compatibility-rules)

## The model in one paragraph

A publisher serves one signed JSON document, the **publication**, at
`/ar-io/indexes`. It lists the publisher's indexes; each index is a list of
**bands**, immutable sets of files; each file is named with its size and
SHA-256. The signature is made with the Ed25519 key registered as the
gateway's observer address, so the registry, not the server you asked, says
whose document it is. The digests then make every file checkable on its own,
so the bytes may come from the publisher, a mirror or a CDN (or, in future,
a peer-to-peer transport) without anyone in between being trusted. Nothing in this chain vouches for
what an index *says*: a root-tx index entry is a claim about where an item
lives, and a gateway checks that claim when it serves the item.

## Discovery

A gateway that publishes says so in `/ar-io/info`:

```console
$ curl -s https://gateway.example/ar-io/info | jq .indexes
{
  "manifestUrl": "/ar-io/indexes",
  "names": ["root-tx-index"]
}
```

The block is absent when the gateway publishes nothing or its publication is
currently invalid, so its presence is a reasonable signal that the document is
fetchable. `manifestUrl` is relative to the gateway's own origin. `names` is
for choosing which publishers to fetch at all; the document itself is the
authority on what each index contains.

To find publishers, walk the gateway registry, fetch `/ar-io/info` from each
gateway's registered FQDN, and keep those with an `indexes` block. For the
root-tx index the canonical publisher is `turbo-gateway.com`.

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
| `sequence` | integer ≥ 1 | Monotonic per publisher. |
| `previousManifestSha256` | hex string or `null` | SHA-256 of the previous document, chaining publications into a history. |
| `issuedAt`, `expiresAt` | ISO 8601 | When it was signed, and when to consider it stale. |
| `indexes` | array | The indexes offered, each with a unique `name`. |
| `signature` | object | Detached signature; see below. |

### Index entries

| Field | Type | Meaning |
|---|---|---|
| `name` | `[a-z0-9-]{1,64}` | Unique within the document. |
| `kind` | `[a-z0-9-]{1,64}` | What the bands are and how to read them. Version 1 defines `cdb64-root-tx`. |
| `filter` | any JSON | Optional. For `cdb64-root-tx`, the `ANS104_UNBUNDLE_FILTER` the index was built under, which says which bundles it covers. |
| `bands` | array | The bands currently offered. |

### Bands

| Field | Type | Meaning |
|---|---|---|
| `id` | `[A-Za-z0-9._-]{1,128}` | Unique within its index. Never `.` or `..`. |
| `files` | array of `{name, size, sha256}` | Every file in the band. `name` has the same pattern as `id`; `sha256` is lowercase hex. |
| `heightRange` | `[start, end]` or `[start, null]` | Optional. Block heights covered; a `null` end is still open. |
| `records` | integer | Optional, informational. |
| `http.baseUrl` | string | Optional. File names resolve against it. |
| `torrent` | object | Optional, reserved for a torrent transport; publishers in this release never set it. `infohashV1` (40 hex), `infohashV2` (64 hex, hybrid torrents), `magnet`, `torrentUrl`. |
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
   `publisher` in the registry (`getGateway` in the AR.IO SDK, or, if you
   trust that gateway, the entry for that wallet in a gateway's
   `/ar-io/peers`, which is what the index-swarm sidecar reads). Its
   `observerAddress` must equal `signature.keyId` exactly. Both are base58;
   compare the strings. A document naming a gateway that is not registered is
   untrusted.
3. **The signature is valid.** `alg` is `ed25519`. The public key is the
   32 bytes `keyId` base58-decodes to. The signed message is the UTF-8 of the
   fixed prefix `ar-io-index-publication/v1` and a newline (`\n`), followed
   by the [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) canonical JSON
   of the document **with the `signature` member removed**, including every
   other member, even ones you do not recognise. `sig` is the 64-byte
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
serialization is not a substitute: it disagrees with RFC 8785 on numbers such
as `1e-7` and `1.0`, and on the sort order of keys outside the Basic
Multilingual Plane, and unknown fields a publisher adds later can carry
either.

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

| Route | Addresses | Cache-Control on success |
|---|---|---|
| `GET /ar-io/indexes` | The publication document itself | `public, max-age=60` |
| `GET /ar-io/indexes/<name>/<band>/<file>` | A file by name, within the current publication | `public, no-cache` |
| `GET /ar-io/indexes/blob/<sha256>` | A file by content | `public, max-age=31536000, immutable` |

Every error response from these routes (400, 402, 404, 416, 429, 503) carries
`Cache-Control: no-store`, so a cache in front of the publisher never keeps a
refusal or a gap and replays it. Only `200`, `206` and `304` carry the values
above.

Prefer the blob route. A name is reused whenever a band is rebuilt, which the
rolling tip band is on every cadence, so named files must be revalidated and
a cache in front of the publisher cannot keep them; a digest can never change
meaning, so an edge cache or CDN may hold a blob indefinitely. The sidecar
fetches by digest for exactly this reason.

Only files the current publication lists are served. A name the document does
not list is a 404 even if a file of that name exists on the server, and a
blob is served only while some listed file has that digest.

Both byte routes support single `Range` requests (`206` with
`Content-Range`), which is how a download resumes. Responses carry
`ETag: "<sha256>"` and `Repr-Digest: sha-256=:<base64>:`, the digest of the
whole file, even on a partial response; full responses also carry
`Content-Digest`. A response that serves a file also carries
`X-AR-IO-Index-File: <sha256>`, and is signed with HTTPSIG like the document
(below), the signature covering `Content-Digest` or, on a range,
`Repr-Digest`. A `503` with `Retry-After` means
the publisher is part way through replacing a band: the file on disk no longer
has the size the document names, or, on the blob route, the digest has no
link yet. The blob route never falls back to reading the file by name, since
only the link is known to hold that digest's bytes. Fetch the document again
after the delay. The named route checks size only, so a rebuild at the same
size is served under its name until the next document, and fails your digest
check: another reason to fetch by digest. A listed file missing from disk is
a `404`.

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

## Metering

The byte routes are metered like data egress. When the gateway enables its
rate limiter, each response spends tokens in proportion to the size of its
body (the range, for a `Range` request; a `HEAD` costs only the minimum, and
a `304` nothing), and a client that runs out gets `429 Too Many Requests`.
When x402 is enabled as well, it gets `402 Payment Required` with payment
requirements instead, and can pay to continue. The publication document
itself is never metered, so a client that has run out of tokens can still see
what it could fetch.

The limits and prices in force are advertised in `/ar-io/info`, in the
`rateLimiter` and `x402` blocks (present only when enabled). See
[x402-and-rate-limiting.md](x402-and-rate-limiting.md) for how to pay and how
the buckets work.

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

The value is one of four shapes. `r` is the root transaction ID; `p` is the
bundle path from the root to the item's parent, whose first element is the
root; `i` and `d` are the byte offsets of the item's header and payload
within the root transaction's data; `s` is the item's total size.

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
searches bands in name order and takes the first match.

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
  alphabet and can never be `.` or `..`.
