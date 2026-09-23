# Index Swarm Sidecar

The index-swarm sidecar publishes the index artifacts this gateway offers and
subscribes to those published by other gateways, so index bands can be
installed and retired under a running node without a restart.

It is **off by default**. A gateway that never enables the `index-swarm`
compose profile behaves exactly as it did.

## Status

The scaffold: the sidecar starts, serves health and metrics, checks that the
gateway beside it is new enough to load what it installs, and idles. The
publish and subscribe loops land in later changes, so configuring
`INDEX_SWARM_PUBLISH` or `INDEX_SWARM_SUBSCRIBE` today records the intent and
reports it, but moves no data yet.

## What it is, and what it is not

| | |
|---|---|
| Shares with the gateway | One directory, `data/indexes`. The sidecar writes; the gateway reads through its [collection source](cdb64-guide.md#collection-directory). |
| Talks to | Other gateways' `/ar-io/indexes` over HTTP, and (later) a torrent engine on the compose network. |
| Never touches | The gateway's databases, its process, or the chain. It signs with the observer key, read only, and never writes key material. |
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

### What the gateway serves

The gateway's side is four read-only routes under `/ar-io/indexes`: the signed
publication document, each published file by name, each by its SHA-256, and a
band's torrent once one exists. They serve **only what the publication lists**.
A request is looked up in a map built from the signed document rather than
joined onto a path, so anything else in the directory, such as a band still
being written or the sidecar's own state, is unreachable however it is asked
for. See [openapi.yaml](openapi.yaml) for the headers each returns.

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
  published/          # bands this node offers; the gateway serves these
  incoming/           # downloads in progress; never read by the gateway
  installed/          # bands in use; the gateway loads these
  state.json          # sequences seen and bands installed
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
| `index_swarm_core_compatible{result}` | Exactly one of `compatible`, `too_old`, `unknown` is 1. `too_old` means bands would be installed into a gateway that cannot load them; `unknown` means the gateway could not be reached, which is not the same thing |
| `index_swarm_build_info{version,node_version}` | Which build is deployed |

## Operational notes

- **Logs are capped** at `INDEX_SWARM_LOG_MAX_SIZE` × `INDEX_SWARM_LOG_MAX_FILE`
  (50 MB × 3 by default). Docker's json-file driver is unbounded by default,
  which on a long-lived gateway quietly fills the disk holding
  `/var/lib/docker`.
- **`init: true`** is set, so signals reach the process and exited children are
  reaped. Without it a wedged process needs a kill, which is how a band install
  gets left half-written.
- **`stop_grace_period` is 30s**, giving an install in progress time to finish
  before the container is killed.
- **Disk.** A full root-tx index is roughly 20 GB today. `incoming/` holds one
  band in addition while it downloads.
- **Anonymous volume.** Running the core image inherits its `VOLUME /app/data`
  declaration, so each container creates an anonymous volume holding nothing
  but the mount point for `data/indexes`. Harmless, but it accumulates across
  recreates; `docker compose down -v` clears them.

## Troubleshooting

**`index-swarm idle: nothing configured`** — neither `INDEX_SWARM_PUBLISH` nor
`INDEX_SWARM_SUBSCRIBE` is set. This is the default and is not an error.

**`Gateway is too old to load installed index bands`** — the gateway release
predates the collection source, so anything installed would sit on disk unread.
Upgrade the gateway, or unset the subscription until you do.

**`Could not determine the gateway release`** — the gateway was unreachable at
`INDEX_SWARM_CORE_URL` or reported a release the sidecar could not parse. The
sidecar continues without the check, since a sidecar restarting in a loop
beside a struggling gateway helps nobody.

**`index-swarm publisher requires a registry-bound observer key`** — publishing
is configured but no observer key is set, so nothing it signed could be
verified by anyone.
