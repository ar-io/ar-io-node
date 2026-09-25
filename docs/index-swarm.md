# Index Swarm Sidecar

The index-swarm sidecar publishes the index artifacts this gateway offers and
subscribes to those published by other gateways, so index bands can be
installed and retired under a running node without a restart.

It is **off by default**. A gateway that never enables the `index-swarm`
compose profile behaves exactly as it did.

## Status

Publishing and subscribing work over HTTP: a publisher signs and serves its
bands, a subscriber verifies, downloads and installs them, and the gateway
beside it loads them without a restart. Every subscriber fetches from the
publisher's metered HTTP routes, unless a torrent engine is configured: then
bands also move peer to peer. A publisher seeds a torrent of every band, a
subscriber fetches from peers first and falls back to HTTP, and every
subscriber seeds what it installed. See [Torrent engine](#torrent-engine).

## Quick start

### Subscribe to another gateway's index

1. Run a gateway on release 84 or later. Both the gateway and the sidecar run
   the same image (`CORE_IMAGE_TAG`).
2. In `.env`:
   ```bash
   INDEX_SWARM_SUBSCRIBE='[{"publisher":"<publisher gateway wallet>","name":"root-tx-index"}]'
   INDEX_SWARM_MAX_DISK_BYTES=26843545600   # 25 GiB; size it to what the publisher offers
   CDB64_ROOT_TX_INDEX_SOURCES=data/indexes/installed/root-tx-index,<previous sources>
   ROOT_TX_LOOKUP_ORDER=db,cdb,gateways,graphql
   ```
   See [pointing the gateway at installed bands](#pointing-the-gateway-at-installed-bands)
   for `<previous sources>`, and [lookup order](#lookup-order) for why `cdb`
   goes right after `db`.
3. Restart the gateway so it reads the new sources:
   `docker compose up -d --no-deps core`.
4. Start the sidecar: `docker compose --profile index-swarm up -d index-swarm`.
5. Watch it install: the sidecar log says `Installed a band` for each band,
   and `index_swarm_installed_bands{index}` climbs. Bands arrive newest
   heights first. A publisher's meter can make a first pull take hours; see
   [download_failed](#health-and-metrics).

### Publish this gateway's index

1. The gateway must be **registered**, reachable at its registry URL, and
   serving from release 84 or later: the routes that serve bands live in the
   gateway, not the sidecar.
2. Its observer key must be the registered one. Set `OBSERVER_PRIVATE_KEY`,
   or `INDEX_SWARM_OBSERVER_KEYPAIR_FILE` to the keypair file's host path
   (not both). Set `AR_IO_WALLET` to the gateway's wallet. Publications are
   signed over a fixed `ar-io-index-publication/v1` prefix, so no Solana
   transaction or HTTPSIG signature can pass for one; but a wallet asked to
   sign an arbitrary message starting with that prefix would produce one, so
   don't use the observer key in a wallet that signs messages for dApps.
3. Put finished bands under `data/indexes/published/<index>/<band>/`, with a
   `heightRange` in each manifest (see [producing bands](#producing-bands)).
4. In `.env`: `INDEX_SWARM_PUBLISH='[{"name":"root-tx-index","kind":"cdb64-root-tx"}]'`.
5. Start the sidecar: `docker compose --profile index-swarm up -d index-swarm`.
   The first scan hashes every file once (minutes for tens of GB; disk-bound).
6. Check it from outside: `curl -s https://<your gateway>/ar-io/indexes | jq '{sequence, publisher, bands: [.indexes[].bands[].id]}'`,
   and `curl -s https://<your gateway>/ar-io/info | jq .indexes`.
7. Behind nginx, read [running behind nginx](#running-behind-nginx) before
   anyone subscribes, especially with a cache or more than one node.

## What it is, and what it is not

| | |
|---|---|
| Shares with the gateway | One directory, `data/indexes`. The sidecar writes; the gateway reads through its [collection source](cdb64-guide.md#collection-directory). |
| Talks to | Its own gateway (`/ar-io/peers` for registry records, `/ar-io/info`) and other gateways' `/ar-io/indexes`, over HTTP. |
| Never touches | The gateway's databases, its process, or the chain: it makes no RPC calls. It signs with the observer key, read only, and never writes key material. |
| If it dies | Nothing degrades. Bands already installed keep serving; the gateway does not depend on the sidecar being up. |

## Running it

```bash
docker compose --profile index-swarm up -d index-swarm
```

Name the service explicitly. The sidecar deliberately declares no
`depends_on`, so this cannot start or recreate the core, observer or any other
service, and it works whether or not the gateway is running.

To stop it:

```bash
docker compose --profile index-swarm stop index-swarm
```

### It runs the core image

The sidecar is compiled into the same `dist/` tree as the gateway and needs no
dependency the gateway does not already have, so it runs
`ghcr.io/ar-io/ar-io-core` with a different entrypoint rather than an image of
its own. Pulling a second image would cost roughly a gigabyte of duplicate
layers per operator for code already present. `CORE_IMAGE_TAG` therefore pins
both, which also keeps them from drifting apart.

## Configuration

Every setting is read once at startup, so a malformed value fails immediately
with a message naming the offending entry rather than hours later on the first
poll. See [envs.md](envs.md) for the full table.

```bash
# Publish the indexes this gateway builds.
INDEX_SWARM_PUBLISH='[{"name":"root-tx-index","kind":"cdb64-root-tx"}]'

# Subscribe to a publisher, by its registered gateway wallet.
INDEX_SWARM_SUBSCRIBE='[{"publisher":"<gateway wallet>","name":"root-tx-index"}]'
```

The signing identity is the gateway's registered observer key
(`OBSERVER_PRIVATE_KEY`, or the keypair file named by
`INDEX_SWARM_OBSERVER_KEYPAIR_FILE`, which is mounted into the sidecar on its
own, never the whole wallets directory), whose address is the
`observerAddress` on the gateway's registry record. A subscriber verifies a
publication against that record, so a publisher running on the auto-generated
fallback key has nothing anyone can verify against and will refuse to publish.

### Producing bands

The publisher offers whatever band directories are under
`data/indexes/published/<index>/`; it does not build indexes itself. A band is
a [partitioned CDB64 index](cdb64-format.md#partitioned-cdb64-index-format),
for example from the local database:

```bash
./tools/export-sqlite-to-cdb64 --partitioned \
  --output-dir data/indexes/published/root-tx-index/band-tip.tmp
mv data/indexes/published/root-tx-index/band-tip.tmp \
  data/indexes/published/root-tx-index/band-tip
```

Build under a `.tmp` name and rename into place: directories ending in
`.tmp`, or in `.tmp.<pid>` as the partitioned writers name their own build
directories, are skipped, so a band is never described half-written.

#### Band metadata

Two optional fields in a band's `manifest.json` `metadata` change how
subscribers treat it. Add them before renaming the band into place, since a
manifest edit is a new band as far as digests go:

```bash
m=data/indexes/published/root-tx-index/band-tip.tmp/manifest.json
jq '.metadata = ((.metadata // {}) + {heightRange: [1950000, null]})' "$m" > "$m.new" && mv "$m.new" "$m"
```

| Field | Effect |
|---|---|
| `heightRange: [from, to]` | The block heights the band covers; `to` is `null` for a band that follows the tip. Subscribers install bands **newest heights first** by this range, which under a publisher's meter decides how soon a subscription starts answering lookups (most lookups are for recent data). A band without it installs last. `export-sqlite-to-cdb64` does not write it |
| `supersedes: "<band id>"` (or a list of ids) | This band replaces the named ones. The publisher stops offering them in the same scan that describes this band, and deletes their directories after `INDEX_SWARM_SUPERSEDE_GRACE_SECONDS`; subscribers retire them the same way |

A band must carry all of its partitions as local files. A `manifest.json`
naming any partition by URL or Arweave ID (as the shipped remote indexes in
`resources/` do) is refused by the publisher, and by every subscriber: its
gateway would otherwise fetch a location the publisher chose, unchecked by
any digest.

To replace a band, prefer a fresh id per build (`band-tip-20260923T1200`,
say) with `supersedes` naming the previous one, so the publisher withdraws
and removes it for you; without `supersedes`, delete the previous one
yourself after the next scan. When the new band names the old one in
`supersedes`, subscribers keep serving the old band until the new one has
installed, however long its download takes, then retire the old after
`INDEX_SWARM_SUPERSEDE_GRACE_SECONDS`. Without `supersedes`, a subscriber
retires a band as soon as the publisher stops offering it. So set `supersedes` when you
first publish the new band: publishing it without and adding `supersedes`
later edits its manifest, which changes the band (subscribers then fetch only
the changed file, but it is still a new version of the band).
Swapping under the same id also works, but a directory cannot be renamed over
a non-empty one, so there is a moment when the band is absent; a scan that
lands in it withdraws the band until the next scan, and subscribers retire it
in the meantime.

### Publishing torrents

With `INDEX_SWARM_ENGINE_URL` set, the publisher also offers every band as
a torrent: it builds one when the band is first described or changes,
writes it to `published/<index>/<band>.torrent`, adds a `torrent` entry
(both infohashes, a magnet link, the `.torrent` URL) to the band in the
publication, and has the engine seed it. Without an engine there are no
torrent entries, since a torrent nobody seeds only makes subscribers wait
before falling back to HTTP.

The engine seeds from `published/.seed/<v1 infohash>/`, a hard link per file
to its blob, not from the band directory. A band rebuilt in place under the
same id changes the bytes behind its names; seeding the directory would hand
peers pieces that fail their hashes until the next scan. The links pin the
bytes that were hashed, as they do for the blob route.

Torrents are deterministic. The name is derived from the band's file names,
sizes and digests, not its id, and nothing publisher-specific goes in: no creation
date and no WebSeed. So two publishers holding the same bytes with the same
`INDEX_SWARM_TRACKERS` write byte-identical `.torrent` files, and any two
share one infohash and one swarm. Subscribers add the publisher's WebSeed
(`/ar-io/indexes/webseed/`) themselves, and only when peers are not
delivering, because engines otherwise pull about half of a band from it even
with a seeder available, and it is the metered tier.

`INDEX_SWARM_TRACKERS` sets the announce list; point it at this node's own
tracker (below) by the address peers reach it on. Subscribers pass on to
their engine only trackers on public hosts, so a name such as `core` or a
private address is dropped there. The engine also runs DHT and peer exchange,
so peers can find one another without the tracker.
`INDEX_SWARM_PRIVATE_SWARM=true` sets the BEP 27 private flag, which turns
DHT and peer exchange off for those torrents. It is inside the infohash, so
publishers who want one swarm must agree on it.

### The tracker

A publisher runs a closed tracker in its sidecar, on
`INDEX_SWARM_TRACKER_PORT` (default 6969), and its torrents announce to it.
It answers only for the bands the publisher offers at that moment, under
both of each hybrid torrent's infohashes, and refuses every other torrent
with `unregistered torrent`. Its port is public, so it is bounded: at most
2,000 peers per torrent and 4 ports per address, a random sample in each
response, 10 announces a minute per address for each torrent (an IPv6 /64
counts as one address), and a connection cap. That is why it is not qBittorrent's embedded
tracker: that one tracks any infohash anyone announces, which on a published
port would make the gateway a free tracker for any swarm on the internet,
with its address in them. The engine's init pins the embedded tracker off.

The tracker keeps its peers in memory. After a restart they are back within
one announce interval (300 s); meanwhile peers still find one another through
DHT, and a subscriber whose download stalls turns on the WebSeed. It is served
straight from the sidecar and sees each peer's real address, so put nothing
that rewrites source addresses in front of it.

Every scan reconciles the engine with the publication: bands offered are
seeded (a status check when they already are), bands no longer offered are
removed from the engine, and their `.torrent` files and seed directories are
deleted. An engine that is down delays seeding to the next scan and stops
nothing else.

### Publishing torrents from a fleet behind a load balancer

A large gateway is often several nodes behind an HTTP load balancer with a
caching proxy, and only one of them holds the observer key and signs. The
swarm needs a few things that an HTTP proxy does not give by itself:

1. **One node publishes and seeds.** The signing node, the one
   `/ar-io/indexes*` is pinned to, runs the engine and the tracker. The other
   nodes need neither.
2. **The engine's peer port reaches that node directly.** BitTorrent is not
   HTTP, so the load balancer cannot carry it: publish
   `INDEX_SWARM_ENGINE_PORT` (TCP and UDP) on the node's own public address,
   open it in the firewall, and set `INDEX_SWARM_ENGINE_PUBLIC_HOST` to that
   address. Without it the tracker lists this node's engine under the host of
   its tracker URL, which for a fleet is the load balancer.
3. **The tracker, one of two ways.**
   - Directly: publish `INDEX_SWARM_TRACKER_PORT` on the same public address
     and announce to `http://<that address>:6969/announce`.
   - Through the load balancer: route `/announce` to the signing node's
     tracker port, uncached, with `proxy_set_header X-Forwarded-For
     $proxy_add_x_forwarded_for;`, and list the proxies' addresses in
     `INDEX_SWARM_TRACKER_TRUSTED_PROXIES`. Otherwise every peer appears at
     the proxy's address, the per-address caps throttle them together, and
     the tracker hands out an address nobody can connect to.
4. **The `.torrent` and WebSeed routes** sit under `/ar-io/indexes`, so a pin
   and cache rule for that prefix covers them. The WebSeed is metered like
   the blob route and marked `private` when metered, so a shared cache does
   not replay paid bytes.
5. **Bound what seeding costs.** `INDEX_SWARM_UPLOAD_LIMIT_BYTES_PER_SEC`
   caps upload to peers, and the engine's memory grows with the bytes it
   seeds (see [Running the engine](#running-the-engine)).

Subscribers behind NAT still work: they reach the publisher's engine, and a
reachable subscriber can be reached back. Only two peers that are both
unreachable cannot exchange pieces with each other, and they still have the
publisher and the WebSeed.

### Publishing cadence

The publisher rescans every `INDEX_SWARM_PUBLISH_SCAN_INTERVAL_SECONDS`
(default 60) but writes a new document only when the band set or a file
digest has changed, or when the current document is halfway through its TTL.
That second condition matters: subscribers alarm once `expiresAt` passes, so
a publisher whose bands are simply quiet would otherwise go stale and read as
dead. Set `INDEX_SWARM_PUBLISH_TTL_SECONDS` to roughly twice the interval at
which bands are expected to change.

Only bands whose files changed are re-hashed. The description is keyed on
each file's name, size and mtime and persisted, so a restart does not re-read
tens of gigabytes on its next scan.

### Subscribing

A subscriber is configured with a publisher's **wallet**, never a hostname.
The gateway registry turns that into the two facts it needs: where to fetch
from, and which key a signature must carry. That is what makes the trust model
work, because an operator never types a URL that could later point somewhere
else. `url` on a subscription overrides only where the bytes come from; the
key that must have signed still comes from the registry, so pointing a
subscription at a mirror cannot change whose documents are accepted.

The sidecar reads the registry through its own gateway rather than the
chain. The gateway already refreshes the whole registry hourly for its peer
selection and serves each peer's wallet, observer key, stake and status at
`/ar-io/peers`; the sidecar reuses that read
(`INDEX_SWARM_REGISTRY_CACHE_TTL_SECONDS`, default 300), so it adds no load on
the Solana RPC provider and needs no RPC settings. The view is at most an hour
old, and it lists the gateways the gateway itself would use: not its own
wallet, and by default not gateways that are leaving.

Each publisher is polled independently: a slow one, or one pulled at a
meter's pace for hours, holds up only itself.

Every poll re-reconciles, whether or not the publisher's document has changed.
The sequence guards against rollback and nothing else: it records what has been
*seen*, not what has been successfully installed, so a band that failed to
download or was skipped by the disk budget is retried on the next poll rather
than waiting for the publisher to publish again. Reconciling costs a state
comparison when everything is already in place.

What a subscriber refuses, and why:

| Refused | Because |
|---|---|
| A document signed by a key the registry does not name for that wallet | A signature that verifies against some other key proves only that somebody signed something |
| A document naming a different publisher than the wallet it came from | Otherwise a relayed document could be attributed to the wrong gateway |
| A sequence lower than one already seen, even if that newer document failed to install | A cache or mirror replaying an older document must not roll the node back to a stale band set |
| Bytes that do not match the digests the document names | The signature covers the digests; the digests cover the bytes |
| A band that passes its digests but is not a readable index | Digests prove the bytes are the ones named, not that they are servable |
| A band that would exceed `INDEX_SWARM_MAX_DISK_BYTES` | The volume the gateway serves from is not worth filling for an index |
| A publisher not in `INDEX_SWARM_TRUSTED_PUBLISHERS`, when that list is set | Counted as `unreachable`, with a warning naming the publisher |
| A band with no HTTP location | Counted as `unreachable`; nothing in this build can fetch it |

An expired document is installed anyway, with a warning: expiry is a signal
that the publisher has gone quiet, not that its bands have gone bad.

`INDEX_SWARM_TRUSTED_PUBLISHERS`, a comma-separated list of wallets, narrows
the registry check and never replaces it: a publisher on the list still has
to sign with its registered key.

A band's files are fetched from the publication's own origin, or from an
origin listed in `INDEX_SWARM_ALLOWED_FILE_ORIGINS` (for a publisher that
serves bands from a mirror or CDN). A band naming any other server is skipped.
The document is signed, but a URL in it is still a request to wherever it
points, and the sidecar runs on the gateway's network beside ClickHouse,
redis and the observer. For the same reason, neither the document fetch nor
any file download follows a redirect. Every request carries
`User-Agent: ar-io-index-swarm/<release> (<gateway wallet>)`, so a publisher
can tell subscribers apart even when several share one IP.

Two limits to know. The publication's own origin is the URL in the
publisher's registry record, and it is fetched as given, so subscribe only to
publishers whose registered URL you would let your gateway call. And removing
a publisher from `INDEX_SWARM_SUBSCRIBE` retires the bands it installed: no
longer subscribing means no longer trusting it for what the gateway serves.

#### Over the swarm

With `INDEX_SWARM_ENGINE_URL` set, a band the publication offers as a torrent
is fetched through the engine:

1. The `.torrent` is fetched from the publisher under the same rules as a
   band file (the publication's origin or `INDEX_SWARM_ALLOWED_FILE_ORIGINS`,
   no redirects, a bounded size) and checked against the infohashes the
   publication signed. A mismatch is refused before the engine ever sees it
   (`verify_failed`, transport `torrent`), and the band is fetched over HTTP.
2. Only the signed part reaches the engine. The infohash covers the info
   dictionary and nothing else, so the trackers and WebSeeds around it are
   the publisher's to choose, and the engine would request them from inside
   this node's network. The sidecar keeps the info dictionary and piece
   layers byte for byte and only trackers on public hosts, drops every
   WebSeed, and checks the infohashes again. The checked torrent is kept in
   `torrents/<infohash>.torrent`.
3. The engine downloads into `swarm/<infohash>/`, handed to its user
   (`INDEX_SWARM_ENGINE_UID`) since the sidecar runs as root, with peers only.
4. If nothing has moved for `INDEX_SWARM_WEBSEED_AFTER_SECONDS`, the
   publisher's WebSeed is turned on. Peers come first because the WebSeed is
   the publisher's metered tier.
5. Before the engine sees the torrent, its file list is checked against the
   band's signed files: exactly those names and sizes, plus the pad files
   BEP 47 allows, and nothing else, no symlinks and no subdirectories. The
   infohash pins the info dictionary, not that it describes the band.
6. On completion the engine lets go of the torrent, and each signed file is
   copied out of `swarm/` into the band's incoming directory, hashed as it
   is copied, then validated and installed exactly as over HTTP. Only a
   regular file of the signed size is read, and never through a link, and
   the engine's own directory is never installed: a file it still held open
   or linked could otherwise change after it was checked.
7. The installed band is seeded from its generation directory, so every
   subscriber is also a seeder.

If the engine already holds the torrent, because this node publishes the
same bytes or seeds them from another installed copy, the band is installed
from that copy without the engine being touched.

Peers are not metered, so a band the swarm can bring still starts after the
publisher's HTTP meter has answered `402` or `429`; if it then falls back to
HTTP, it waits for the next poll like any other band.

A download in progress is kept in `state.json`: a restart picks it up where
the engine left it. An engine error, the engine losing the torrent, or
`INDEX_SWARM_TORRENT_TIMEOUT_SECONDS` without progress abandons the torrent
and its partial files and fetches the band over HTTP in the same poll
(`transport_fallback`). A poll watches its unfinished torrents for up to a
minute in all, not per band, and then moves on; the next poll picks them up
where they left off. A band rebuilt under the same id drops the download of
its old version.

A band that came over HTTP instead (the engine was down or still starting,
or the torrent was abandoned) is seeded too: once the engine answers, its
`.torrent` is fetched and checked the same way. Housekeeping seeds exactly
the live copies that have a kept torrent, re-adds any a restarted engine
lost, and lets go of a retired copy before its files are deleted. At startup
the sidecar waits up to two minutes for the engine, so a fresh start does
not send the first poll to HTTP just because the engine was a few seconds
behind. Download directories and kept torrents that nothing uses any more are
deleted.

### Pointing the gateway at installed bands

The subscriber installs into `data/indexes/installed/<index>/`. The gateway
loads a band only if that directory is one of its CDB64 sources, so add it,
**first**, to `CDB64_ROOT_TX_INDEX_SOURCES` on the gateway, keeping whatever
was there after it:

```bash
CDB64_ROOT_TX_INDEX_SOURCES=data/indexes/installed/root-tx-index,<previous sources>
```

First, because sources are searched in the order given and a fresh band from
a publisher should answer before an older shipped snapshot. If this variable
was unset, `<previous sources>` is the shipped default, three Arweave-hosted
indexes that stop at height 1,820,000 and carry no offsets:

```text
resources/cdb64-root-tx-index-non-ao-non-redstone-with-content-type-to-height-1820000,resources/cdb64-root-tx-index-non-ao-non-redstone-without-content-type-to-height-1820000,resources/cdb64-root-tx-index-ao-to-height-1820000
```

Write it out to keep searching them, or leave it off: each lookup against
them fetches from Arweave, which is slow, and a subscribed set that covers
the whole chain makes them redundant.

### Lookup order

`ROOT_TX_LOOKUP_ORDER` decides which root-TX sources are asked, and in what
order, until one gives a usable answer. Its default,
`db,gateways,graphql,hyperbeam,cdb`, asks every network source before the
installed bands, so a subscriber gets little from them. Put `cdb` right after
`db`:

```bash
ROOT_TX_LOOKUP_ORDER=db,cdb,gateways,graphql
```

An installed band answers from local disk: about 2 ms on SSD, tens of ms on
a busy spinning disk, against hundreds of ms for peers or GraphQL, and with
offsets the answer is verifiable. The same applies to a remote source that
answers well, such as `turbo`: once the bands are installed, `cdb` ahead of
it is local and verifiable, and `turbo` then only sees what the bands lack.
Drop `hyperbeam` unless the `hb` profile is running, or every lookup that
reaches it waits on a dead endpoint. Changing the order needs a gateway
restart.

The directory need not exist when the gateway starts. A local source that is
missing and not named like a `.cdb` file is treated as a directory nobody has
created yet and checked for every 30 seconds, so the order in which the
gateway and the sidecar first start does not matter. This needs
`CDB64_ROOT_TX_INDEX_WATCH` left at its default of `true`, which is also what
lets bands come and go without a restart. Changing the sources variable does
need a gateway restart.

### What the gateway serves

The gateway's side is five read-only routes under `/ar-io/indexes`: the
signed publication document, each published file by name, each by its
SHA-256, a band's `.torrent`, and the WebSeed route torrent clients fetch
`<torrent name>/<file>` from. The WebSeed is metered and cached like the blob
route: its address is derived from each file's name, size and digest (see
[Torrent Name](glossary.md#torrent-name)), so it cannot change
meaning.
They serve **only what the publication lists**.
A request is looked up in a map built from the signed document rather than
joined onto a path, so anything else in the directory, such as a band still
being written or the sidecar's own state, is unreachable however it is asked
for. See [openapi.yaml](openapi.yaml) for the headers each returns, and
[index-publication.md](index-publication.md) for the protocol from a
consumer's side: the document schema, how to verify it, and how to read one
entry without the sidecar.

While a valid publication exists, `/ar-io/info` carries an `indexes` block
naming what is published and where the document lives, which is how another
gateway discovers publishers without fetching every gateway's document. The
routes and that block read one shared view of the publication, so an index is
advertised exactly when it is servable, and both drop it together if the
document goes bad. Once it has a view, the gateway rechecks the document file every five seconds off the request path, so later requests are not held up by a slow disk; only the first request after a start waits for the file. A new document is served once a recheck has read it, normally within a few seconds, longer if the disk is slow.

The byte routes are rate limited and priced like data egress (see
[x402-and-rate-limiting.md](x402-and-rate-limiting.md)); the publication
document is not, so a client that has run out of tokens can still learn what
it could fetch. The gateway mounts `data/indexes` read only: it serves
`published/`, loads `installed/`, and never writes to either.

## Running behind nginx

Most gateways sit behind nginx, and many cache. The routes are built to be
correct through a cache without special configuration, but a publisher should
know what its proxy does to them.

What the gateway sends:

| Response | `Cache-Control` | Why |
|---|---|---|
| The document, `200`/`304` | `public, max-age=60` | A subscriber tolerates a document a minute old: the sequence cannot go backwards and `expiresAt` bounds it |
| A blob (by digest), `200`/`206`/`304` | `private, max-age=31536000, immutable` when metered, else `public, ...` | The address is the digest, so the bytes can never change |
| A file by name, `200`/`206`/`304` | `private, no-cache` when metered, else `public, no-cache` | A name is not an address; a rebuild under the same name must be revalidated (the `ETag` is the digest, so an unchanged file costs a `304`) |
| **Every error** (400, 402, 404, 416, 429, 503) | `no-store` | So a cache never keeps a refusal or a gap and replays it. nginx honours an upstream `Cache-Control` ahead of its own `proxy_cache_valid` rules |

Things to decide or check:

- **Forward the client IP.** The meter keys on `X-Forwarded-For`; the stock
  config in [linux-setup.md](linux-setup.md) already sets it. Without it,
  every subscriber shares the proxy's allowance.
- **Metered bytes are private.** "Metered" means `ENABLE_RATE_LIMITER=true`
  or x402 is enabled (`ENABLE_X_402_USDC_DATA_EGRESS`). A shared cache serves what it holds without
  reaching the gateway, and a `304` is free, so a cached copy of a paid file
  would reach anyone who asked the cache: no tokens spent, no `402` issued.
  A metering gateway therefore marks its byte responses `private`, which a
  shared cache such as nginx does not store; still leave `/ar-io/indexes`
  uncached, so a proxy configured to ignore `Cache-Control` cannot bypass the
  meter either. An operator who deliberately wants a CDN or edge cache to
  spread egress runs the byte routes without metering, and gets `public`
  responses that are safe to cache: blobs are content-addressed.
- **Stale-on-error serving.** A `proxy_cache_use_stale` rule can serve an
  expired document when the gateway errors. Subscribers cope: an older
  sequence is refused as a replay, and the next poll gets the current one.
  But it hides a publisher outage from outside, so prefer no cache for the
  document.
- **Large files.** Band files are 7–30 MB. Set `proxy_buffering off` (or large
  enough temp limits) for `/ar-io/indexes`. With `proxy_cache` on and no
  `slice` module, nginx fetches a whole file on a cache miss even for a range
  request, so a resuming client waits for the full file.
- **More than one node.** Only the node holding the observer key signs. If
  a load balancer spreads `/ar-io/indexes*` across nodes that don't publish,
  subscribers get `404`s from those nodes; if two nodes publish with the
  same key, their sequences diverge and subscribers refuse the lower one.
  Send the whole prefix to the signing node.

A worked example, from turbo-gateway (a two-node fleet with caching nginx on
each node; gw1 publishes):

```nginx
# Longer prefix than any /ar-io/ block, so it wins. Uncached, so the meter
# sees every request; unbuffered, for 7-30 MB files.
location ^~ /ar-io/indexes {
    proxy_pass http://<signing node's gateway>;   # e.g. :3000 (envoy) or :4000 (core)
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_http_version 1.1;
    proxy_cache off;
    proxy_buffering off;
}
```

## Torrent engine

The swarm runs through a torrent engine in a separate container, in its own
compose profile, `index-swarm-torrent`, which the sidecar drives over its
Web API. Without it, and without `INDEX_SWARM_ENGINE_URL`, everything moves
over HTTP as before.

### Running the engine

```bash
# .env
INDEX_SWARM_ENGINE_AUTH=swarm:<a long random password>
INDEX_SWARM_ENGINE_URL=http://index-swarm-engine:8080
```

```bash
docker compose --profile index-swarm --profile index-swarm-torrent \
  up -d index-swarm index-swarm-engine
```

Name the services, as for the sidecar alone: a bare
`docker compose --profile index-swarm up` also starts every default service.
Recreate `index-swarm` too when turning the engine on, so it reads
`INDEX_SWARM_ENGINE_URL` and joins the engine's network.
Starting the engine runs `index-swarm-engine-init` first, a one-shot
container that writes the settings below into the engine's configuration and
exits. The engine waits for it, so without `INDEX_SWARM_ENGINE_AUTH` the init
fails with a message saying so and the engine never starts; qBittorrent would
otherwise invent a password on every start that the sidecar could not know.

What the init manages, on every engine start (everything else in the file,
including an operator's own tuning, is left alone):

| Setting | Value | Why |
|---|---|---|
| DHT, peer exchange | on | Peers find one another even while a publisher's tracker is restarting |
| Local service discovery, UPnP | off | Local broadcasts and router port mapping help nobody on a hosted server |
| Embedded tracker | off | It is an open tracker; the sidecar runs a closed one |
| Torrent queueing | off | qBittorrent keeps only a few torrents active by default; a gateway seeds every band it holds |
| Save path | `swarm/`, no temp path | The only directory the engine can write data to |
| Automatic torrent management | off | It would move a seeded band out of `published/` |
| Upload limit | `INDEX_SWARM_UPLOAD_LIMIT_BYTES_PER_SEC` | Peer upload is otherwise unbounded |
| Web UI user and password | from `INDEX_SWARM_ENGINE_AUTH` | Stored as qBittorrent's own PBKDF2 hash; kept when unchanged |
| Subnet allowlist | off | It would exempt a whole Docker network from the password |
| IP filter, peers and trackers | private ranges, unless `INDEX_SWARM_ENGINE_BLOCK_PRIVATE=false` | See above |
| Loopback without a password | off | A request that reached the engine's loopback from a host another gateway chose must not be let in. The healthcheck needs only an answer |

The engine sees the index directories at the same paths the sidecar does,
because the sidecar hands it paths. It can write only `swarm/` and its own
configuration; `published/` and `installed/` are mounted read only.

It runs on its own Docker network (`INDEX_SWARM_ENGINE_NETWORK_NAME`),
shared only with the sidecar. The trackers, peers and WebSeeds it talks to
are chosen by other gateways, so it must not be able to reach the gateway,
the observer, ClickHouse or anything else on `ar-io-network`. Two more
layers keep it off this node's network:

- The sidecar hands the engine only trackers on public hosts, in canonical
  form, and no WebSeed but the publisher's own.
- The engine's IP filter refuses private, loopback, link-local and
  carrier-grade NAT addresses for peers, trackers and WebSeeds, which also
  covers a public name that resolves to a private address, a tracker that
  redirects, and peers learned from DHT or peer exchange (DHT's own traffic
  is left to libtorrent, which ignores private nodes already). The init
  writes the filter on every engine start. Set
  `INDEX_SWARM_ENGINE_BLOCK_PRIVATE=false` only when the swarm runs on a
  private network, between gateways on one LAN, and list that network's
  tracker in `INDEX_SWARM_ALLOWED_TRACKERS`.

Only the peer port, `INDEX_SWARM_ENGINE_PORT` (default 51900, TCP and UDP), is
published; open it in the host firewall for peers to connect in. The Web API
is not published at all. It stays on the engine's network, and must be
reached there at `index-swarm-engine:8080`: qBittorrent answers 401 to every request
whose Host header names another port.

`index_swarm_engine_available` can read 0 for a moment after both start
together, because the sidecar's first check may land before the engine is
listening; the next check flips it.

Notes from running it:

- **Memory.** libtorrent 2 maps the files it seeds, and mapped pages count as
  resident memory: an engine seeding 22 GiB showed about 100 MiB of its own
  memory and up to 830 MiB of mapped file pages. They are shared and
  reclaimable, but they count against a container memory limit, so size any
  limit for them, or alert on anonymous memory rather than RSS.
- **Reach it at its own port.** qBittorrent answers 401 to every request,
  the login included, when the `Host` header names a different port or host
  than it listens on, which is what publishing its API port under another
  number does. The sidecar reports that case by name.
- **Failed logins are not retried**, because qBittorrent bans an address
  after five. Check `INDEX_SWARM_ENGINE_AUTH` if the engine refuses the
  sidecar.

### Why qBittorrent

The engine is **qBittorrent-nox 5.2.3 on libtorrent 2.0.13**
(`qbittorrentofficial/qbittorrent-nox:5.2.3-lt2-1`), driven through its
**Web API 2.15.1**. It was chosen over Transmission and rqbit by running all
three through the same test on 2026-09-23: seed a 256-file band from a
read-only mount, then fetch it on a second instance from the WebSeed alone,
from a peer alone, and from both, using the deterministic hybrid v1 + v2
torrents the sidecar builds.

| | qBittorrent 5.2.3 | Transmission 4.1.3 | rqbit 9.0.1 |
|---|---|---|---|
| Hybrid v1 + v2 | Yes, verifies both | v1 half only; pad files treated as real files | v1 half only |
| Seeds from a read-only mount | Yes, writes nothing | v1 torrents only | **No**: opens files read-write, add fails |
| Verifies on add, 20 GiB, cold, SSD | 59 s | Not at all (trusts sizes); forced verify 50 s | n/a |
| WebSeed only, 2.2 GB | 9.5 s | 20 s | **No WebSeed support** |
| Peer only, 2.2 GB | 64 s | 49 s | not run |
| Both, 21.6 GB | 181 s, 48% from the WebSeed | 276 s, 54% from the WebSeed | |
| WebSeeds changed at runtime | Yes (`addWebSeeds`, `removeWebSeeds`) | No, read only | |
| Files in a directory not named after the torrent | `contentLayout=NoSubfolder` | `torrent-rename-path` | `output_folder` |
| Memory, seeding 22 GiB, idle | 98 MiB anonymous, plus up to 833 MiB of mapped file pages | 2 MiB anonymous, 6 MiB resident | |
| Time from add to first WebSeed request | 0.5 to 1.2 s | 2.9 to 3.8 s | |
| API | REST, cookie login or subnet allowlist | JSON-RPC with a session-id header | REST, no auth |
| Image | 182 MB | 84 MB | 29 MB, and must run as root |

**Why not Transmission.** It reads only the v1 half of a hybrid torrent and
treats its BEP 47 pad files as real files, so a hybrid band never completes:
it requests `.pad/<n>` from the WebSeed and tries to rename the finished
files to `.part` on the read-only mount. Using it would mean giving up v2 and
cross-publisher deduplication, and it cannot change a torrent's WebSeeds
while running.

**Why not rqbit.** It cannot seed from a read-only mount, and the engine must
never be able to modify what the gateway serves. It also has no WebSeed
support, which removes the fallback the design depends on.

Two findings from that test shaped the rest of the design. Engines treat a
WebSeed as one more peer, and both drew about half of a band from it while a
full-speed seeder was available; so torrents carry no WebSeed, and a
subscriber adds the publisher's only when peers stall. And every file, the
last included, is padded to a piece boundary, which is what libtorrent
itself does: a band built by the sidecar and one built by libtorrent from
the same files share both infohashes and join one swarm.

## Volume layout

```text
data/indexes/
  published/
    publication.json  # the signed document; the gateway serves it
    <index>/<band>/   # bands this node offers
    blobs/            # the same files by SHA-256, as hard links
    <index>/<band>.torrent       # with an engine: each band's torrent
    .seed/<v1 infohash>/         # with an engine: what it seeds, links to blobs/
  incoming/
    <publisher>/<index>/<band>/  # downloads in progress, per publisher; never read by the gateway
  installed/
    <index>/<band>~<generation>/ # bands in use; the gateway loads these
  swarm/<infohash>/   # with an engine: torrent downloads; the engine's only writable directory
  torrents/<infohash>.torrent    # with an engine: checked torrents kept for seeding
  state.json          # hashes, sequences seen and bands installed
```

Each copy of a band installs into its own directory, named by the band id
and a short digest of its files. A replacement is loaded by the gateway
before the copy it replaces is retired: the old copy is recorded, in the same
state write as the install, as due for retirement no sooner than a minute
later, and the next housekeeping retires it. So lookups to a band never miss
while it is rebuilt, and a crash in between can't orphan the old copy. A
directory under `installed/` that no record points at (after lost state, say)
is retired once it has sat untouched for ten minutes. A copy already on disk whose files verify (after lost state,
for example) is adopted rather than downloaded again. A band id belongs to
the publisher whose copy is live: another publisher offering different bytes
under the same id is skipped and counted as `band_conflict`, rather than the
two replacing each other on every poll.

`state.json` is re-derivable. If it is unreadable the sidecar renames it to
`state.json.corrupt`, starts empty and carries on, because a sidecar that
refuses to start fixes nothing.

## Health and metrics

Served on `INDEX_SWARM_METRICS_PORT` (default 9101), bound inside the
container. Nothing reaches the host unless the operator maps the port.

| Path | Meaning |
|---|---|
| `/healthz` | 200 while running, 503 during shutdown. The container healthcheck acts on this, and so does autoheal when `RUN_AUTOHEAL=true`. It deliberately does not track poll progress: a legitimate multi-gigabyte first pull keeps one publisher's poll running longer than any threshold would allow, and autoheal restarting it would lose nothing but waste the transfer. Alarm on `index_subscription_manifest_age_seconds` instead. |
| `/metrics` | Prometheus exposition. Sidecar and process series only. The shipped `prometheus.yml` has no job for it; add one for `index-swarm:9101` to scrape it. |

Metrics worth a dashboard:

| Metric | Read it as |
|---|---|
| `index_swarm_up` | 1 while running; 0 during shutdown |
| `index_swarm_configured_total{role}` | Zero on both roles means idle by configuration, not broken |
| `index_swarm_core_compatible{result}` | Exactly one of `compatible`, `too_old`, `unknown` is 1. `too_old` means the gateway cannot load bands, so the subscriber is waiting for an upgrade; `unknown` means the gateway could not be reached, which is not the same thing |
| `index_swarm_build_info{version,node_version}` | Which build is deployed |
| `index_publish_total{index,result}` | `published` when a new document was written, `unchanged` when none was needed, `failed` on error |
| `index_publish_manifest_age_seconds` | Age of this node's document. Past the TTL, subscribers see this publisher as stale |
| `index_publish_sequence`, `index_publish_bands{index}` | What is currently offered |
| `index_publish_describe_duration_seconds{index}` | Time spent hashing a band. A steady stream means bands are churning |
| `index_subscription_total{publisher,index,transport,result}` | Outcomes: one per poll for the document (`index` empty), plus one per band that was fetched. `installed` is healthy. `unchanged` means nothing was installed that poll, which is healthy on its own but also appears beside `download_failed` or `verify_failed`; see below for the rest |
| `index_subscription_manifest_age_seconds{publisher}` | Age of the newest document from each publisher, computed at scrape time. **The alarm that matters**: climbing past the publisher's TTL means it has gone quiet, whether it still answers with an old document or does not answer at all |
| `index_subscription_sequence{publisher}` | The latest sequence seen, whether or not its bands have installed |
| `index_swarm_installed_bands{index}` | What is installed |
| `index_subscription_bytes_total{transport}` | Bytes actually fetched, by `http` or `torrent`. Files already on disk are not fetched again and not counted. The share by `torrent` is how much the swarm is carrying |
| `index_swarm_engine_available` | 1 while the torrent engine answers. Absent when none is configured, which is HTTP only by choice |
| `index_publish_seeding_bands{index}` | Bands handed to the engine on the last scan. Below `index_publish_bands` means some are offered over HTTP only |
| `index_swarm_tracker_announces_total{result}`, `index_swarm_tracker_peers` | The closed tracker: `ok`, `unregistered` (an infohash this node does not publish; refused), `malformed`, `rate_limited` (an address announcing one torrent too often) |

On the gateway, at `/ar-io/__gateway_metrics`:

| Metric | Read it as |
|---|---|
| `indexes_requests_total{route,status}` | Requests to the index routes (`publication`, `file`, `blob`, `torrent`, `webseed`) by status. On a publisher, `402` and `429` are the meter at work |
| `indexes_bytes_served_total{route}` | Bytes served by the index routes |
| `root_tx_lookup_total{source="cdb64",status}` | How often installed bands answered a lookup, on a subscriber |

The subscription results that need attention:

| `result` | Meaning | Action |
|---|---|---|
| `signature_failed` | A document did not verify against the registered key | Security-relevant; should be zero. Check the publisher's registry record and who answers at its URL |
| `replayed` | A document older than one already seen | Security-relevant if sustained; a cache in front of the publisher can cause one-offs |
| `verify_failed` | Downloaded bytes did not match their signed digests; or the document itself was malformed; or a band matched its digests but was not a readable index (its downloaded files are then deleted, not resumed) | Retried every poll. Sustained means a bad mirror, disk or publisher |
| `download_failed` | A fetch failed: a stall (no bytes for `INDEX_SWARM_DOWNLOAD_STALL_TIMEOUT_SECONDS`; pacing for `INDEX_SWARM_DOWNLOAD_RATE_LIMIT_BYTES_PER_SEC` is not counted), a connection error, or a status such as `402`/`429` from the publisher's meter. The log line carries the status | Retried every poll. Files that completed are kept and not fetched again, and a partial file resumes, so each poll only fetches what is still missing. After a `402` or `429`, no new file of any band from that publisher starts until the next poll (`INDEX_SWARM_POLL_INTERVAL_SECONDS`), and bands are fetched newest heights first, so a meter's allowance goes to the most useful band. The log line carries `completeFiles` / `totalFiles`. Sustained `402`/`429` means the subscriber should be allowlisted or pay |
| `skipped_disk_budget` | The band would exceed `INDEX_SWARM_MAX_DISK_BYTES` | Raise the budget or subscribe to less |
| `band_conflict` | Another subscribed publisher's copy of this band id is live, with different bytes | Subscribe to one of them for that index (use `name`), or ask the publishers to use distinct band ids |
| `sequence_jump` | A document more than 1,000,000 sequences ahead of the last one seen | Security-relevant: should be zero. Nothing is installed from it |
| `unknown_kind` | A band of a kind this build does not implement | Upgrade the sidecar, or ignore |
| `transport_fallback` (transport `torrent`) | A torrent was not used: the engine was down, errored or lost it, or it timed out | The band is fetched over HTTP in the same poll. Sustained means an engine problem or no peers |
| `unreachable`, `error` | The publisher or the registry could not be read; or the publisher is not in `INDEX_SWARM_TRUSTED_PUBLISHERS`; or a band offers no HTTP location | Bands already installed keep serving |

## Operational notes

- **Logs are capped** at `INDEX_SWARM_LOG_MAX_SIZE` × `INDEX_SWARM_LOG_MAX_FILE`
  (50 MB × 3 by default). Docker's json-file driver is unbounded by default,
  which on a long-lived gateway quietly fills the disk holding
  `/var/lib/docker`.
- **Outside compose**, override the healthcheck. The image's own
  `HEALTHCHECK` probes the gateway's port, so a sidecar started with plain
  `docker run` reports unhealthy while working; pass
  `--health-cmd` with the `/healthz` check from `docker-compose.yaml`.
- **`init: true`** is set, so signals reach the process and exited children are
  reaped. Without it a wedged process needs a kill, which is how a band install
  gets left half-written.
- **`stop_grace_period` is 30s.** On a stop signal the sidecar aborts
  downloads in progress (they resume on the next start), starts nothing new,
  and waits for an install or a publish already under way to finish.
- **Disk.** It depends entirely on what is published. The root-tx set
  Turbo's fleet builds is about 20 GB; the three older snapshots shipped as
  the gateway's defaults are 122, 150 and 245 GB. `incoming/` keeps the files
  of every band still downloading, on the same filesystem so the install is a
  rename, and a band that failed keeps its files there so the next poll
  resumes rather than starts over. `INDEX_SWARM_MAX_DISK_BYTES` counts
  installed bands, including retired ones not yet swept, but **not**
  `incoming/`; and replacing a band under the same id needs room for both
  copies at once. Set the budget before subscribing to anything that carries
  historical bands, with headroom for `incoming/`.
- **Validating a band reads it once.** Before a band installs, every
  partition is walked end to end and every record and table pointer checked,
  so a crafted file can't reach the gateway's reader. It is sequential and
  bounded to one 1 MiB buffer per file, about 750 MiB/s from cache, so
  roughly a minute for a 7 GB band on a spinning disk.
- **Disk reads on every poll.** A file already in `incoming/` is re-hashed
  from local disk to confirm it before being skipped. That is far cheaper
  than fetching it, but on a spinning disk holding multi-gigabyte bands it is
  real I/O while a large first pull is in progress.
- **Anonymous volume.** Running the core image inherits its `VOLUME /app/data`
  declaration, so each container creates an anonymous volume holding nothing
  but the mount point for `data/indexes`. Harmless, but it accumulates across
  recreates; `docker compose down -v` clears them.

## Turning it off

Stopping the sidecar changes nothing the gateway serves: installed bands stay
loaded and published bands stay served, from the last document written.
Subscribers see that document age and, once it expires, alarm. To remove the
feature entirely:

1. `docker compose --profile index-swarm stop index-swarm`, then
   `docker compose --profile index-swarm rm -f index-swarm`. With the engine,
   also `docker compose --profile index-swarm-torrent stop index-swarm-engine`
   and remove it and `index-swarm-engine-init` the same way; then
   `data/indexes/swarm/`, `data/indexes/torrents/` and
   `data/index-swarm-engine/` can be deleted.
2. On a subscriber, restore the previous `CDB64_ROOT_TX_INDEX_SOURCES` and
   restart the gateway, then delete `data/indexes/installed/`. In that order,
   so the gateway is no longer holding the files open when they go.
3. On a publisher, delete `data/indexes/published/publication.json`. The
   gateway stops serving the routes and drops the `indexes` block from
   `/ar-io/info` on its next request, without a restart. The band
   directories can then go too.

`state.json` can be deleted with everything else. Kept, it holds the
sequences already seen, which is what stops a re-enabled subscriber from
accepting a replayed older document.

## Troubleshooting

**`index-swarm idle: nothing configured`** — neither `INDEX_SWARM_PUBLISH` nor
`INDEX_SWARM_SUBSCRIBE` is set. This is the default and is not an error.

**`Gateway is too old to load installed index bands; not installing until it
is upgraded`** — the gateway predates the collection source, so anything
installed would sit on disk unread. The subscriber skips its polls until the
gateway reports `INDEX_SWARM_MIN_CORE_RELEASE` or later, and notices an
upgrade by itself. Publishing is not gated, but a publisher's gateway needs
the same release too: the routes that serve bands are in the gateway, so on an
older one the sidecar reports `published` while every request gets a `404`.

**`Could not determine the gateway release`** — the gateway was unreachable at
`INDEX_SWARM_CORE_URL` or reported a release the sidecar could not parse. Seen
once at startup this is normal, since the gateway usually takes longer to
start; the check repeats before each poll until the gateway answers. The
subscriber installs meanwhile, because the cost of being wrong is disk.

**`Set OBSERVER_KEYPAIR_PATH or OBSERVER_PRIVATE_KEY, not both`** — the
sidecar was given both an observer private key and a keypair file. Compose
passes the gateway's `OBSERVER_PRIVATE_KEY` through, and derives the
sidecar's `OBSERVER_KEYPAIR_PATH` from `INDEX_SWARM_OBSERVER_KEYPAIR_FILE`, so
this means both of those are set in `.env`. Keep one.

**`index-swarm publisher requires a registry-bound observer key`** — publishing
is configured but no observer key is set, so nothing it signed could be
verified by anyone. Set `OBSERVER_PRIVATE_KEY`, or
`INDEX_SWARM_OBSERVER_KEYPAIR_FILE` to the keypair file's host path; the
gateway's `OBSERVER_KEYPAIR_PATH` alone does not reach the sidecar.

**`The gateway's /ar-io/peers carries no registry fields`** — the gateway
predates the registry fields on its peer list, so the sidecar cannot resolve
publishers. Upgrade the gateway.

**Publisher not resolvable** (`unreachable`) — the sidecar resolves
publishers from its gateway's peer list, which excludes the gateway's own
wallet and, unless `SKIP_LEAVING_GATEWAYS=false`, gateways that are leaving.
A newly registered publisher appears after the gateway's next hourly
refresh.
