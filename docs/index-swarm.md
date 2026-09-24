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
publisher's metered HTTP routes. (The document has a reserved `torrent`
field for a peer-to-peer transport; nothing in this build sets or reads it.)

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
   (not both). Set `AR_IO_WALLET` to the gateway's wallet.
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
yourself after the next scan. Subscribers install the new band, then retire
the old after `INDEX_SWARM_SUPERSEDE_GRACE_SECONDS`.
Swapping under the same id also works, but a directory cannot be renamed over
a non-empty one, so there is a moment when the band is absent; a scan that
lands in it withdraws the band until the next scan, and subscribers retire it
in the meantime.

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

The gateway's side is three read-only routes under `/ar-io/indexes`: the signed
publication document, each published file by name, and each by its SHA-256.
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
document goes bad.

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
| A blob (by digest), `200`/`206`/`304` | `public, max-age=31536000, immutable` | The address is the digest, so the bytes can never change |
| A file by name, `200`/`206`/`304` | `public, no-cache` | A name is not an address; a rebuild under the same name must be revalidated (the `ETag` is the digest, so an unchanged file costs a `304`) |
| **Every error** (400, 402, 404, 416, 429, 503) | `no-store` | So a cache never keeps a refusal or a gap and replays it. nginx honours an upstream `Cache-Control` ahead of its own `proxy_cache_valid` rules |

Things to decide or check:

- **Forward the client IP.** The meter keys on `X-Forwarded-For`; the stock
  config in [linux-setup.md](linux-setup.md) already sets it. Without it,
  every subscriber shares the proxy's allowance.
- **Caching blobs bypasses the meter.** A cached blob is served by nginx
  without reaching the gateway, so no tokens are spent and no `402` is
  issued. For a publisher that meters (the default), leave
  `/ar-io/indexes` uncached. For one that wants to spread egress, caching
  blobs is safe: they are content-addressed.
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

## Volume layout

```text
data/indexes/
  published/
    publication.json  # the signed document; the gateway serves it
    <index>/<band>/   # bands this node offers
    blobs/            # the same files by SHA-256, as hard links
  incoming/           # downloads in progress; never read by the gateway
  installed/
    <index>/<band>/   # bands in use; the gateway loads these
  state.json          # hashes, sequences seen and bands installed
```

`state.json` is re-derivable. If it is unreadable the sidecar renames it to
`state.json.corrupt`, starts empty and carries on, because a sidecar that
refuses to start fixes nothing.

## Health and metrics

Served on `INDEX_SWARM_METRICS_PORT` (default 9101), bound inside the
container. Nothing reaches the host unless the operator maps the port.

| Path | Meaning |
|---|---|
| `/healthz` | 200 while running, 503 during shutdown. The container healthcheck acts on this, and so does autoheal when `RUN_AUTOHEAL=true`. |
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
| `index_subscription_manifest_age_seconds{publisher}` | Age of the newest document from each publisher. **The alarm that matters**: climbing past the publisher's TTL means it has gone quiet |
| `index_subscription_sequence{publisher}` | The latest sequence seen, whether or not its bands have installed |
| `index_swarm_installed_bands{index}` | What is installed |
| `index_subscription_bytes_total{transport}` | Bytes actually fetched (only `http` in this build). Files already on disk are not fetched again and not counted |

On the gateway, at `/ar-io/__gateway_metrics`:

| Metric | Read it as |
|---|---|
| `indexes_requests_total{route,status}` | Requests to the index routes (`publication`, `file`, `blob`) by status. On a publisher, `402` and `429` are the meter at work |
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
| `unknown_kind` | A band of a kind this build does not implement | Upgrade the sidecar, or ignore |
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
- **`stop_grace_period` is 30s**, giving an install in progress time to finish
  before the container is killed.
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
   `docker compose --profile index-swarm rm -f index-swarm`.
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
