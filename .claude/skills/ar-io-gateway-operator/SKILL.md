---
name: ar-io-gateway-operator
description: Operate any AR.IO node deployment — architecture, daily ops, diagnostics, and recurring pitfalls that apply to every operator. Use whenever the user asks about gateway health, indexing lag, ClickHouse pipeline, GraphQL routing, ArNS resolution, data retrieval and caching, bundle unbundling, webhook fan-out, container restarts, image rebuilds, disk pressure, HTTPSig overhead, or anything operationally generic to running an AR.IO node — even when they don't name a specific service ("is it healthy?", "why is it slow?", "did the build pick up?", "how full is the disk?"). For deployment-specific knowledge (domains, repo paths, sidecar config, this-machine numbers), pair this with the deployment-overlay skill (e.g. `vilenarios-gateway`) if one exists.
---

# AR.IO Gateway Operator (generic)

You are operating an AR.IO node — an Arweave gateway that indexes, caches, serves, and signs blockchain data. Deployments share the same architecture but differ in domains, paths, and which sidecars are present. **Run `scripts/health-check` first** every session: it prints a one-screen snapshot you can compare against the prior state before deciding to act.

If a deployment-specific overlay skill is loaded (e.g. `vilenarios-gateway`), it provides the local repo paths, domains, and which sidecars exist. Treat the overlay as authoritative for those facts.

## Run first: `scripts/health-check`

```bash
# from the ar-io-node repo root
.claude/skills/ar-io-gateway-operator/scripts/health-check
```

What it checks and why:

| Section | What "good" looks like | If wrong, jump to |
|---|---|---|
| containers | All gateway containers `Up`; sidecars (if any) `(healthy)` | "Bring everything up" |
| disk | `/` < 80%, `/data` (if separate) has headroom | "Disk pressure" |
| gateway healthcheck | `{"status":"ok",...}` | "When something breaks" |
| indexer height vs chain head | lag ≤ 5 blocks | "Indexing falling behind" |
| ClickHouse rows | If streaming enabled: `new_blocks > 0` and growing | "Streaming tables empty" |
| core errors last 5 min | < ~10 (operational noise: peer fetches, aborts) | grep deeper |
| image SHAs | If on a dev branch, must differ from `:latest` digest | "Building from source" |

The script auto-skips sidecar checks when their containers aren't present, so it works in any deployment.

## How the gateway works (the model an operator needs)

Knowing the data flows tells you where to look when symptoms appear. Source of truth is `src/system.ts` (DI wiring) and `docs/`; this section captures the operationally-load-bearing facts.

### Request flow

```text
client → (optional edge: nginx/CDN) → envoy :3000 → core :4000 → response with X-AR-IO-* trust headers
                                                              ↘ webhook fan-out → optional sidecars
```

Every served data response carries trust headers (`X-AR-IO-Verified`, `X-AR-IO-Trusted`, `X-AR-IO-Stable`, `X-AR-IO-Hops`, plus `X-Arweave-*` tag passthrough). Those headers are what HTTPSig signs — see `src/middleware/httpsig.ts` `TRIGGER_HEADERS`. Endpoints with no trust trigger (`/ar-io/info`, `/ar-io/healthcheck`, `/graphql` errors) are deliberately not signed.

### Data retrieval — composite source with fallback chain

Configurable via `.env`. Defaults:
- `ON_DEMAND_RETRIEVAL_ORDER=trusted-gateways,ar-io-network,chunks-offset-aware,tx-data` — what `/raw/<id>` and `/<id>` walk through on a cache miss
- `BACKGROUND_RETRIEVAL_ORDER=chunks` — used by the unbundler when fetching bundle bodies

Each source's failures are logged with `class` so you can grep (`GatewaysDataSource`, `TxChunksDataSource`, `ChunksDataSource`, etc.). Persistent failures from one tier are normal — the chain is designed to fall through. Look for `Failed to fetch chunk data from any source` / `all sources failed` as the *real* failure signal, not individual tier warnings.

Three response headers worth knowing: `X-Cache: HIT|MISS` (gateway-side contiguous cache), `X-AR-IO-Hops` (how many AR.IO peers were traversed before this gateway served), `X-AR-IO-Trusted` / `X-AR-IO-Verified` (whether the data has been hash-verified against the chain).

### Indexing pipeline

Two write paths run side-by-side:

**1. SQLite primary indexer (always on)** — `BlockImporter` worker imports blocks one at a time into `new_blocks`/`new_transactions` (the unstable head, ~last 18 blocks), and a separate process promotes them to `stable_blocks`/`stable_transactions` once they're past the reorg horizon. ANS-104 bundle unbundling is gated by `ANS104_UNBUNDLE_FILTER` (often narrow). Database access is in a worker thread (`StandaloneSqlite`) — never call SQLite synchronously from the main thread.

**2. ClickHouse pipeline (optional, `--profile clickhouse`)** — Stable rows are exported to parquet then imported by `clickhouse-auto-import` (hourly cycles) into `staging_*` and finally `transactions`. **Streaming pipeline** (PR #699 / `clickhouse-streaming-unstable-head` branch) mirrors the unstable-head SQLite writes directly into ClickHouse `new_blocks` / `new_transactions` so GraphQL can query the head without waiting for the parquet round-trip. Activated by `CLICKHOUSE_STREAMING_ENABLED=true`. Reorgs trigger bounded `ALTER TABLE ... DELETE WHERE` on the `new_*` tables.

### GraphQL routing

`/graphql` reads from up to three legs that get merged: stable `transactions` table in CH, streaming `new_transactions` in CH, and the SQLite `new_*` fallback. With `CLICKHOUSE_GQL_SKIP_SQLITE_READS=true`, the SQLite leg is dropped to a tight-timeout fallback only. With `GRAPHQL_ON_DEMAND_RESOLUTION_ENABLED=true` (default), `transaction(id)` queries that miss the local DB will fall back to extracting from ANS-104 bundle binaries on demand — single-ID only, capped by `GRAPHQL_ON_DEMAND_RESOLUTION_MAX_CONCURRENT`.

### ANS-104 unbundling pipeline

Whenever a bundle TX matches `ANS104_UNBUNDLE_FILTER`, it walks a four-queue chain. Knowing the chain is essential for diagnosing throughput regressions — a single queue at cap can mask everything downstream of it.

```text
bundleDataImporter ─→ ans104Unbundler ─→ ans104DataIndexer ─→ dataItemIndexer ─→ SQLite writer
   download workers      parser workers     post-parse buffer     pre-write buffer    single-writer
   (ANS104_DOWNLOAD_…)   (ANS104_UNBUNDLE_)  (ANS104_DATA_…_SIZE)  (DATA_ITEM_…_SIZE)
```

Tune knobs (all env-overridable):

| Knob | Default | What it controls |
|---|---:|---|
| `ANS104_DOWNLOAD_WORKERS` | 5 | Parallel bundle downloads. Network-bound; overprovisioning is cheap |
| `ANS104_UNBUNDLE_WORKERS` | 1 | Parallel parser worker_threads. CPU + network bound |
| `DATA_ITEM_INDEXER_WORKER_COUNT` | 1 | Fastq concurrency for `indexDataItem`; SQLite is single-writer so gains are bounded |
| `MAX_DATA_ITEM_QUEUE_SIZE` | 100000 | **Soft gate**: `shouldUnbundle()` returns false above this on either indexer queue |
| `DATA_ITEM_INDEXER_QUEUE_SIZE` | 500000 | Hard cap on `dataItemIndexer`; items past this get dropped silently |
| `ANS104_DATA_INDEXER_QUEUE_SIZE` | 500000 | Hard cap on `ans104DataIndexer` |

**The buffer between soft gate and hard cap is where data loss happens.** With defaults the gate engages at 100 K but the hard cap is 500 K — a 5× buffer. Under heavy load, in-flight parser workers can flood items into the queue *after* the gate engages but *before* the indexer drains, exceeding the hard cap and silently dropping items. Symptom: `data_items_dropped_total{queue_name="dataItemIndexer"}` climbs while `bundles_unbundled_total` keeps increasing — bundles look "indexed" but their items aren't searchable.

Mitigations:
- Tighten `MAX_DATA_ITEM_QUEUE_SIZE` so the gate engages well before the hard cap (e.g., 25 000 with 500 000 hard caps, giving a 20× buffer).
- Raise the hard cap if memory permits (each item slot ≈ 1–2 KB).
- Don't add parser workers when `data_items_dropped_total` is non-zero — more workers = bigger floods past the gate.

Pipeline diagnostic: a single `curl -sf .../ar-io/__gateway_metrics | grep -E 'queue_length|data_items_dropped|bundles_unbundle_in_flight'` tells you which queue is the bottleneck.

### Caching layers (in order, fastest first)

| Layer | Where | TTL | Notes |
|---|---|---|---|
| In-process kv | core memory | varies per resolver | ArNS names cache, etc. |
| Redis | `redis:7` container | varies | Some ArNS / network state |
| Contiguous data store | `${CONTIGUOUS_DATA_PATH}/` | unbounded | Files keyed by content hash; cleanup workers prune |
| Response cache hints | `Cache-Control` headers in response | per-route | e.g., `/raw/:id` HIT serves with `max-age=43200` |
| Edge cache (optional) | nginx/Varnish/CDN in front | per-zone | Only present if the operator deployed one — gateway doesn't run one itself |

`X-Cache: HIT` on a `/raw/<id>` response means the gateway's contiguous data store served bytes without going to peers/Arweave. The edge layer is *separate* — nginx's `X-Cache-Status: HIT` is a different layer.

### ArNS resolution

`CompositeArNSResolver` walks resolvers in order: `TrustedGatewayArNSResolver` (asks `TRUSTED_ARNS_GATEWAY_URL`, default `https://__NAME__.turbo-gateway.com`), then `OnDemandArNSResolver` (queries the AR.IO network ANT contract directly via `cu.ardrive.io`). Hits go into the in-memory `ArNSNamesCache`. Resolved IDs may be Arweave TXs (route to data path) or, on the streaming-head branch, IPFS CIDs (route to `/ipfs/<cid>` via the Kubo sidecar). Unknown names log `Unable to resolve name against all resolvers` — that's normal user-error traffic, not a service failure.

`/<name>` and `/<name>/<path>` requests carry `X-ArNS-*` trust headers in the response. Manifest path resolution still uses `StreamingManifestPathResolver`; the "from index" path is not implemented yet (logs warn `not implemented` then falls back to data-side resolution, which works).

### Network identity, observer, and incentives

A gateway is a registered participant in the AR.IO network, not just a piece of software. Two distinct wallets matter:

- `AR_IO_WALLET` — the **gateway** wallet. Stakes ARIO tokens (10,000 ARIO minimum = 10000000000 mARIO), receives rewards. Same address used for on-chain registration.
- `OBSERVER_WALLET` — the **observer** wallet. Signs network compliance reports and the HTTPSig attestation. Key file must exist at `${WALLETS_PATH}/<OBSERVER_WALLET>.json`. The two wallets are deliberately separable so the observer key can sit on the gateway box while the staking key stays in cold storage.

When `OBSERVER_WALLET` is set, the gateway also creates an RSA attestation linking the per-response Ed25519 signing key (the one HTTPSig uses) to the observer wallet's on-chain identity, and uploads it to Arweave at startup (`HTTPSIG_UPLOAD_ATTESTATION=true`). That's the cryptographic chain that lets a client verify a response trace back to a staked, registered gateway.

Observer service knobs:
- `RUN_OBSERVER=true` (default) — runs the observer alongside the gateway
- `SUBMIT_CONTRACT_INTERACTIONS=true` (default) — submits generated reports on-chain
- `OBSERVATIONS_PER_GATEWAY` (default 3) — how many times each gateway is observed per epoch (majority vote)
- `OBSERVATION_WINDOW_FRACTION` (default 0.5) — what fraction of the daily epoch window observations are spread across
- `REFERENCE_GATEWAY_MIN_CONSECUTIVE_PASSES` / `REFERENCE_GATEWAY_MIN_EPOCH_COUNT` — eligibility thresholds for using a network gateway as a reference

**Epoch cadence is daily.** Observation reports drive reward eligibility. Operators may themselves be selected as observers for other gateways.

Network onboarding (operator side, only needed once):
- `npm install -g @ar.io/sdk` — provides the `ar.io` CLI for `get-gateway`, registration, etc.
- Register via the CLI or the gateways.ar.io portal: gateway wallet, observer wallet, FQDN, Properties Tx ID, label, stake amount
- Gateway must be reachable at the registered FQDN with valid TLS
- Optional delegated staking — operators can accept delegations with a configurable reward share

### Serving content at the root path

Two mutually-relevant env vars decide what `/` serves:
- `APEX_TX_ID` — pin a specific Arweave TX as the apex. Cache-Control bounded by `CACHE_APEX_MAX_AGE` with `must-revalidate` so apex rotations propagate.
- `APEX_ARNS_NAME` — resolve an ArNS name as the apex. Comma-separated values position-map to `ARNS_ROOT_HOST` entries when there's more than one host.
- `ARNS_ROOT_HOST` — the gateway's primary domain(s) for ArNS subdomain resolution.

### Filters and webhooks (the gateway's contract with sidecars)

Three filters compose JSON expressions (`tags`, `attributes`, `or`/`and`/`always`/`never`) — see `docs/filters.md`:
- `ANS104_UNBUNDLE_FILTER` — which bundles get unbundled
- `ANS104_INDEX_FILTER` — which data items inside matched bundles get persisted
- `WEBHOOK_INDEX_FILTER` — which indexed items trigger webhook emission

Webhook events fired: `data-cached`, `tx-indexed`, `ans104-data-item-indexed`. `WEBHOOK_TARGET_SERVERS` is a comma-separated list of URLs that receive POSTs. If you change a filter to broaden indexing, expect proportionally higher webhook volume.

## Common operations

### Bring up

```bash
# from the ar-io-node repo root
docker compose --profile clickhouse up -d
```

The `--profile clickhouse` flag matters: without it, ClickHouse and the auto-import container stay down and the streaming pipeline goes silent. Other profiles (`grafana`, `bundler`, `litestream`, `ao`, `hb`) gate their own services.

Wait for ready:
```bash
until curl -sf http://localhost:4000/ar-io/healthcheck >/dev/null; do sleep 2; done
```

### Rebuild from local source (after dev-branch code changes)

```bash
docker compose --profile clickhouse build core clickhouse-auto-import
docker compose --profile clickhouse up -d --force-recreate core clickhouse-auto-import
```

`--force-recreate` is required — without it, compose sees the same image *name* (`:latest`) and skips recreation even though the image *digest* changed. Confirm with `docker inspect <container> --format '{{.Image}}'` — the SHA must differ from before.

### Disk pressure recovery (in order of safety)

```bash
docker system df                        # see what's hogging
docker builder prune -af                # build cache (almost always biggest)
docker container prune -f               # stopped containers
docker image prune -af                  # untagged images
sudo journalctl --vacuum-size=500M      # if /var/log/journal is large
```

Avoid `docker volume prune -af` without listing first (`docker volume ls -f dangling=true`) — there can be old SQLite/CH data in dangling volumes worth keeping.

### Block / unblock content (gateway admin API)

```bash
ADMIN=$(grep '^ADMIN_API_KEY=' .env | cut -d= -f2-)
TX=<arweave-tx-or-ipfs-cid>

# Block (the gateway has PUT only — there is no DELETE handler today)
curl -sf -X PUT "http://localhost:4000/ar-io/admin/block-data" \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d "{\"id\":\"$TX\",\"hash\":\"$TX\",\"source\":\"manual\",\"notes\":\"...\"}"
```

If a content-scanner sidecar is present, prefer routing the block through it — depending on its config, it may also bust an edge cache after blocking.

### HTTPSig overhead (for self-measurement)

Read the in-process histogram for the truest per-request signing cost — no benchmarking needed:
```bash
curl -sf http://localhost:4000/ar-io/__gateway_metrics | grep '^httpsig_signing_duration'
# mean per sign = sum / count  (typically 70-120 µs; under 500 µs at p100)
```

Don't draw conclusions from `/ar-io/info` or `/ar-io/healthcheck` benchmarks — those carry no trust-trigger headers and are never signed.

## Pitfalls (apply to any deployment)

1. **`clickhouse-auto-import` logs `Failed to connect to core port 4000 after 0 ms`** — the script's connection state goes stale when core is recreated mid-cycle, and auto-import sleeps 1 h between cycles, so the bad state lingers. Recreating just the auto-import container clears it; manual `curl http://core:4000/...` from inside the container will succeed even while the script is failing.
2. **Streaming tables empty (`new_blocks` / `new_transactions = 0`) despite `CLICKHOUSE_STREAMING_ENABLED=true`** — running the published `:latest` core image instead of a local build. The streaming columns/tables are populated only by the dev-branch code. Rebuild + force-recreate.
3. **Webhook error flood (`getaddrinfo ENOTFOUND <sidecar-host>`)** — a configured sidecar isn't running. Bring it up. Don't strip the target unless intentionally retiring the sidecar — those targets are how moderation and provenance subsystems work.
4. **Bundle unbundling looks idle (low matched count)** — `ANS104_UNBUNDLE_FILTER` is intentionally narrow on most operator configs (e.g., one App-Name + one owner). Confirm via `/ar-io/info`. Not a bug.
5. **Gateway has no `DELETE /ar-io/admin/block-data` handler** — only PUT. Sidecars that send DELETE (e.g. content-scanner unblock) will see failures. Document but don't try to "fix" by changing the sidecar — the gateway is the side that needs the route.
6. **`/ar-io/info` and `/ar-io/healthcheck` are unsigned** — they carry no trust-trigger headers, so HTTPSig signing skips them. Use `/raw/<id>` against a cached tx for HTTPSig benchmarks.
7. **`docker logs <core> | tail` can dump megabytes of binary** — the streaming pipeline sometimes logs cert chains as raw byte arrays. Filter with `grep -viE '"buffer":|raw bytes|^[\[0-9, ]+$'`.
8. **Five-edit dance for adding a database method** — SQL statement, worker impl in `StandaloneSqlite`, queue wrapper in main DB class, case in worker message handler, interface in `types.d.ts`. Skip any one and you get silent failures.

## When something breaks: where to look

| Symptom | First check |
|---|---|
| 5xx from gateway | `docker logs --tail 50 <core-container>` (filtered), then envoy logs |
| Indexer falling behind | SQLite `MAX(height)` per `block_importer` log, peer health, `/data` free space |
| ClickHouse stale | `docker compose --profile clickhouse logs --tail 50 clickhouse-auto-import`; verify curl-to-core works from inside the container |
| Streaming table stuck at 0 | image SHA — almost always the published `:latest` rather than local build |
| Admin API 401/404 | `ADMIN_API_KEY` mismatch with `.env` |
| Webhook silent | `WEBHOOK_TARGET_SERVERS` in gateway `.env`; sidecars must be on the same docker network and reachable by service name |
| `/data` filling | `du -h -d 1 /data \| sort -hr` — usually the `contiguous` cache |

## Metrics worth watching

Quick-scan list of the prometheus metrics that surface most operator-grade issues. All exposed at `/ar-io/__gateway_metrics` on core's HTTP port.

### Pipeline throughput + saturation

| Metric | Surfaces |
|---|---|
| `bundles_unbundled_total` (rate) | bundle-level throughput |
| `data_items_indexed_total{parent_type="transaction"}` (rate) | data-item write rate (SQLite writer capacity) |
| `bundles_unbundle_in_flight` | parser workers currently active — if pinned at worker count for minutes, suspect cascade hangs |
| `queue_length{queue_name="…"}` | the 4-queue chain — see "ANS-104 unbundling pipeline" |
| `data_items_dropped_total{queue_name="…"}` | **silent data loss** at indexer hard cap. Any nonzero rate is a config issue, not a transient |
| `bundles_unbundle_skipped_total{reason="…"}` | `high_queue_depth` (soft gate engaged), `queue_full` (BRW pushing past cap), `no_workers` (config error) |

### Per-source health

| Metric | Surfaces |
|---|---|
| `get_data_stream_successes_total{class,source}` | which cascade tier / which peer actually serves bytes |
| `get_data_stream_errors_total{class,source}` | tier/peer failure rates. Persistent 100 % errors on a peer mean it's dead but the network process still advertises it |
| `get_data_errors_total{…}` | pre-stream errors (connection refused, 4xx, 5xx) |

### Sign of saturation, not failure

| Metric | What it means |
|---|---|
| `nodejs_event_loop_utilization` | 0–1, sampled at scrape. Near 1.0 = main thread pegged |
| `nodejs_eventloop_lag_p99_seconds` | tail latency on the event loop. > 0.1 s under load = something blocking on the main thread |
| `process_resident_memory_bytes` | overall memory growth; sudden steps usually map to a queue filling |
| `httpsig_signing_duration_seconds_*` | per-response signing cost (the histogram is more honest than benchmarking) |

### Performance-interpretation guidance

- **Sample windows lie.** A 60–90 s rate can show 0/hr or 60K/hr depending on whether you caught the soft-gate cycle in its open or closed half. Trust averages over many minutes, not single snapshots.
- **Saturated workers ≠ broken workers.** `in_flight = N` for the configured worker count with throughput still climbing is the healthy steady state; only worry if the corresponding `_total` counter is *also* flat for many minutes.
- **The cascade goes through phases.** When trusted-gateway A goes hot-cache for an hour, throughput spikes; when it rotates out, throughput dips. Aggregate over a day, not a window.

## Adjacent skills (use these, don't reinvent)

- **`release`** — handles version bumps, image SHA pinning, tags, GitHub releases.
- **`testing`** — picks the right test layer (unit / property / e2e / auto-verify / parquet integration / load test) for a given change.
- Deployment-overlay skill (e.g. `vilenarios-gateway`) — adds the local-machine specifics (domains, paths, sidecar config) on top of this generic skill.

This skill covers the **operations** layer: what's running, where, and how to keep it that way. For code-level guidance see `CLAUDE.md` in the relevant repo.
