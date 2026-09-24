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
publisher's metered HTTP routes.

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
(`OBSERVER_KEYPAIR_PATH` or `OBSERVER_PRIVATE_KEY`), whose address is the
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

Build under a `.tmp` name and rename into place: directories ending in `.tmp`
are skipped, so a band is never described half-written.

A band must carry all of its partitions as local files. A `manifest.json`
naming any partition by URL or Arweave ID (as the shipped remote indexes in
`resources/` do) is refused by the publisher, and by every subscriber: its
gateway would otherwise fetch a location the publisher chose, unchecked by
any digest.

To replace a band, prefer a fresh id per build (`band-tip-20260923T1200`,
say) and delete the previous one after the next scan: subscribers install
the new band, then retire the old after `INDEX_SWARM_SUPERSEDE_GRACE_SECONDS`.
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
| A sequence lower than one already installed | A cache or mirror replaying an older document must not roll the node back to a stale band set |
| Bytes that do not match the digests the document names | The signature covers the digests; the digests cover the bytes |
| A band that passes its digests but is not a readable index | Digests prove the bytes are the ones named, not that they are servable |
| A band that would exceed `INDEX_SWARM_MAX_DISK_BYTES` | The volume the gateway serves from is not worth filling for an index |

An expired document is installed anyway, with a warning: expiry is a signal
that the publisher has gone quiet, not that its bands have gone bad.

`INDEX_SWARM_TRUSTED_PUBLISHERS`, a comma-separated list of wallets, narrows
the registry check and never replaces it: a publisher on the list still has
to sign with its registered key.

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
was unset, `<previous sources>` is the shipped default listed in
[envs.md](envs.md); write it out, or those indexes stop being searched.

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
| `/healthz` | 200 while running, 503 during shutdown. The container healthcheck and autoheal act on this. |
| `/metrics` | Prometheus exposition. Sidecar and process series only. |

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
| `index_subscription_total{publisher,index,transport,result}` | Outcomes: one per poll for the document (`index` empty), plus one per band that was fetched. `installed` and `unchanged` are healthy; see below for the rest |
| `index_subscription_manifest_age_seconds{publisher}` | Age of the newest document from each publisher. **The alarm that matters**: climbing past the publisher's TTL means it has gone quiet |
| `index_subscription_sequence{publisher}`, `index_swarm_installed_bands{index}` | What is installed |
| `index_subscription_bytes_total{transport}` | Which transport is doing the work |

The subscription results that need attention:

| `result` | Meaning | Action |
|---|---|---|
| `signature_failed` | A document did not verify against the registered key | Security-relevant; should be zero. Check the publisher's registry record and who answers at its URL |
| `replayed` | A document older than one already installed | Security-relevant if sustained; a cache in front of the publisher can cause one-offs |
| `verify_failed` | Downloaded bytes did not match their signed digests | Retried every poll. Sustained means a bad mirror or disk |
| `download_failed` | A fetch failed: a stall (no bytes for `INDEX_SWARM_DOWNLOAD_STALL_TIMEOUT_SECONDS`), a connection error, or a status such as `402`/`429` from the publisher's meter. The log line carries the status | Retried every poll, resuming from the partial file. Sustained `402`/`429` means the subscriber should be allowlisted or pay |
| `skipped_disk_budget` | The band would exceed `INDEX_SWARM_MAX_DISK_BYTES` | Raise the budget or subscribe to less |
| `unknown_kind` | A band of a kind this build does not implement | Upgrade the sidecar, or ignore |
| `unreachable`, `error` | The publisher or the registry could not be read | Bands already installed keep serving |

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
  the gateway's defaults are 122, 150 and 245 GB. `incoming/` holds one band in addition while it
  downloads, on the same filesystem so the install is a rename. Set
  `INDEX_SWARM_MAX_DISK_BYTES` before subscribing to anything that carries
  historical bands.
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
upgrade by itself. Publishing is unaffected.

**`Could not determine the gateway release`** — the gateway was unreachable at
`INDEX_SWARM_CORE_URL` or reported a release the sidecar could not parse. Seen
once at startup this is normal, since the gateway usually takes longer to
start; the check repeats before each poll until the gateway answers. The
subscriber installs meanwhile, because the cost of being wrong is disk.

**`index-swarm publisher requires a registry-bound observer key`** — publishing
is configured but no observer key is set, so nothing it signed could be
verified by anyone.

**`The gateway's /ar-io/peers carries no registry fields`** — the gateway
predates the registry fields on its peer list, so the sidecar cannot resolve
publishers. Upgrade the gateway.

**Publisher not resolvable** (`unreachable`) — the sidecar resolves
publishers from its gateway's peer list, which excludes the gateway's own
wallet and, unless `SKIP_LEAVING_GATEWAYS=false`, gateways that are leaving.
A newly registered publisher appears after the gateway's next hourly
refresh.
