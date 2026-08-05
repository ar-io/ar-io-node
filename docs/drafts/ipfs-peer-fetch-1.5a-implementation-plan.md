# Peer-Fetch Durability Layer — Implementation Plan (Phase 1.5a + 1.5b)

> **Status:** implementation-ready plan. Companion to the design sketch
> `ipfs-peer-durability-layer.md` (read that first for the *why*). This doc is the
> *how*: concrete files, signatures, config, and a multi-node integration-test
> harness. Written to be handed to a fresh context that will implement it.
>
> **Scope decision (this plan):** implement **1.5a** (gateway peer-fetch + local-only
> serve mode) and **1.5b** (content routing). **1.5c is dropped as a phase** — see
> "Why 1.5c collapses" below. **No smart-contract change anywhere in this plan.**
>
> **Repo:** `ar-io-node`, branch `feat/arns-ipfs-protocol` (worktree
> `wt/ipfs-sync-793`). All file paths below are real and current as of this writing.

---

## 0. Why 1.5c collapses (and this plan is a and b only)

The original phasing had `1.5c — pinning incentive (observer + contract)`. It's not
needed as a distinct phase:

- **Measuring holding needs no contract and no new phase.** The load-bearing
  primitive in 1.5a — the **local-only serve mode** — *is* the trustless
  holding-measurement. The observer already fetches `?format=raw` and verifies bytes
  against the CID (shipped, PR #112). Adding `X-Ar-Io-Local-Only: true` to that
  existing probe means a 200+verifying response *proves the gateway holds the content
  locally* (a proxy 404s in local-only mode). That is a ~5-line observer change that
  **rides on 1.5a**, not a separate contract phase.
- **Rewarding holding needs no contract.** It folds into the *existing*
  content-agnostic name assessment: if the observer probes IPFS names local-only, a
  gateway passes the name only if it actually holds the content — and passing names is
  already rewarded through the existing distribution. Serving→holding is a **policy
  ramp**, not a contract change.
- **The only contract-touching option** (a dedicated per-gateway "holding weight"
  beyond the sampled names) is explicitly **optional/future/governance** — not in this
  plan.

So: build 1.5a (gateway) and 1.5b (routing). The observer holding-probe is a small
no-contract rider documented in §7, to be done alongside/after 1.5a on the observer
repo. Nothing here changes `ario-gar` or any Solana program.

---

## 1. Objective

Turn the gateway from a read-only proxy to public IPFS into a **verifiable fleet
serving layer**: when a gateway needs a CID it doesn't hold, it fetches it from a peer
AR.IO gateway that *does* hold it (as a CAR, over HTTP), and Kubo verifies every block
against the CID on import. Named IPFS content then stays available as long as **any**
participating gateway holds it — independent of public-IPFS provider health — and is
served fast and trustlessly.

**Serving order** the composite realizes (IpfsService already handles the on-disk
cache tier above these):

```
1. local Kubo (offline)   — do I already hold it?          fast, no network
2. peer AR.IO gateways    — does a fleet peer hold it?      bounded, CAR+verify import
3. Kubo (public IPFS)      — public DHT fallback             existing behavior
```

Local-only requests (`X-Ar-Io-Local-Only: true`) run **tier 1 only** — never peer,
never public. This is what prevents peer-fetch recursion/amplification and what makes
holding trustlessly measurable.

---

## 2. Architecture & the shape we mirror

The IPFS stack does **not** use the Arweave `ContiguousDataSource`/`getData` interface.
It has its own source shape on `KuboDataSource`:

```ts
// src/ipfs/kubo-data-source.ts
getContent(opts: {
  cidString: string; path?: string; signal?: AbortSignal; parentSpan?: Span;
  range?: string; format?: 'raw' | 'car';
}): Promise<IpfsContentResult>            // { stream, size, contentType, statusCode, contentRange? }
```

We mirror the **fall-through structure** of `src/data/sequential-data-source.ts`
(iterate ordered sources, return on first success, continue on recoverable error,
short-circuit on client-abort) but against the `getContent` shape, not `getData`.

New abstraction:

```ts
// src/ipfs/ipfs-content-source.ts  (new)
export interface IpfsContentSource {
  getContent(opts: {
    cidString: string; path?: string; signal?: AbortSignal; parentSpan?: Span;
    range?: string; format?: 'raw' | 'car'; localOnly?: boolean;   // ← new field
  }): Promise<IpfsContentResult>;
}
```

`KuboDataSource` and the new `IpfsPeerDataSource` both implement `IpfsContentSource`.
`SequentialIpfsSource` composes them. `IpfsService.dataSource` is widened from the
concrete `KuboDataSource` type to `IpfsContentSource` (see §3.6).

---

## 3. Phase 1.5a — gateway work breakdown

Ordered so each step is independently testable. Every step lists the exact file and
insertion point.

### 3.1 Add `localOnly` to Kubo fetching (the tier-1 / local-only primitive)

**File:** `src/ipfs/kubo-data-source.ts`

- Extend `getContent`'s options with `localOnly?: boolean`.
- When `localOnly === true`, the fetch must be answered **only from Kubo's local
  blockstore/pinset** — it must NOT trigger a public-IPFS/DHT walk.
  - **Recommended mechanism (verify in a short spike — see §3.1a):** issue the fetch
    against the **Kubo RPC API** (`IPFS_KUBO_API_URL`, `http://kubo:5001`) with
    `offline=true`, rather than the read-only gateway (`IPFS_KUBO_URL`, :8080) which
    has no per-request offline flag. Concretely:
    - `format: 'car'`  → `POST {api}/api/v0/dag/export?arg={cid}` (offline daemon
      semantics) or `block`/`dag` reads with `&offline=true`.
    - `format: 'raw'`  → `POST {api}/api/v0/block/get?arg={cid}&offline=true`.
    - no format (UnixFS bytes) → `POST {api}/api/v0/cat?arg={cid}&offline=true`
      (+ path). Kubo returns an error fast if the blocks aren't held locally → map to
      `IpfsNotFoundError`.
- Non-local-only path is unchanged (keeps hitting the :8080 gateway, which may reach
  public IPFS).

> **3.1a — REQUIRED SPIKE (do this first, ~half day):** confirm the exact Kubo
> v0.32.1 mechanism for a *per-request, provably-offline* read that returns fast on a
> local miss. Candidates in priority order: (1) RPC `offline=true` query param on
> `block/get`,`dag/export`,`cat`; (2) daemon-global `--offline` on a *second* Kubo, if
> per-request proves unreliable; (3) a pre-check via `POST /api/v0/block/stat?arg={cid}
> &offline=true` (or `pin/ls?arg={cid}&type=recursive`) before serving. The correctness
> of the whole feature (recursion prevention + holding measurement) rests on
> local-only being genuinely offline, so nail this before building on it. Kubo v0.32.1
> is pinned in `docker-compose.yaml` (`ipfs/kubo:v0.32.1`, profile `ipfs`).

### 3.2 Honor `X-Ar-Io-Local-Only` on the IPFS route

**File:** `src/routes/ipfs.ts` — `handleIpfsRequest` (~L190), just before the
`ipfsService.getContent(...)` call (~L234).

- Parse the request header: `const localOnly = req.headers['x-ar-io-local-only'] ===
  'true';` (also accept `?local=1` for convenience/testing).
- Thread it into the call: `ipfsService.getContent({ cidString, path, signal:
  req.signal, range: format ? undefined : rangeForKubo, format, localOnly })`.
- On a local miss the existing `IpfsNotFoundError → 404` branch (L449–463) applies —
  fast 404, no fallback. No new response-status code needed.
- Optionally set a response marker on local-only hits (`X-Ar-Io-Local-Only: true`) so
  the observer can assert the server honored the mode. Add the constant to
  `src/constants.ts` `headerNames` if you want it symmetric with `arIoSource`.

**File:** `src/ipfs/ipfs-service.ts` — `getContent` (L84). Add `localOnly?: boolean` to
its options and pass through to `this.dataSource.getContent({...})` (L226). Keep the
existing cache tier: when `localOnly` and the on-disk `IpfsFsCache` already has it
(the `range===undefined && format===undefined` case, L177), that's a legitimate local
hit — serve it. Otherwise delegate to the composite (which, for local-only, runs tier
1 only; see §3.5).

### 3.3 `IpfsPeerDataSource` (tier 2 — the new source)

**File:** `src/ipfs/ipfs-peer-data-source.ts` (new). Implements `IpfsContentSource`.

**Constructor:**
```ts
new IpfsPeerDataSource({
  log,
  peerManager: ArIOPeerManager,     // the arIOPeerManager singleton (system.ts L795)
  kuboApiUrl: string,               // config.IPFS_KUBO_API_URL — for dag/import + re-read
  kuboDataSource: KuboDataSource,   // to re-serve offline after import
  peerCount: number,                // IPFS_PEER_FETCH_COUNT
  requestTimeoutMs: number,         // IPFS_PEER_FETCH_TIMEOUT_MS
  maxCarBytes: number,              // IPFS_PEER_FETCH_MAX_CAR_BYTES
  pinner?: IpfsPinner,              // pin after import if IPFS_PIN_ARNS_CONTENT
})
```

**`getContent({ cidString, path, signal, format, range, localOnly })`:**
1. **If `localOnly === true`, immediately throw `IpfsNotFoundError`.** A peer source
   must never run under local-only (that's tier-1-only). This is the recursion guard
   at the source level (belt-and-suspenders with §3.5's composite gating).
2. Select peers: `peerManager.selectPeersForKey('ipfs', cidString, this.peerCount)`
   (hash-ring gives cache locality — the same CID tends to hit the same peers, which
   also warms them). Register `'ipfs'` as a `WeightCategory`. Fall back to
   `selectPeers('ipfs', count)` if key-selection returns empty.
3. For each peer (bounded by `peerCount`, overall deadline `requestTimeoutMs`):
   a. `GET {peer}/ipfs/{cidString}?format=car` with header
      `X-Ar-Io-Local-Only: true`, a per-peer timeout, and a **byte cap**
      (`maxCarBytes`; abort + skip if exceeded — a large file falls through to public
      IPFS at tier 3).
   b. On non-200 / timeout / cap-exceeded: `peerManager.reportFailure('ipfs', peerId)`,
      next peer.
   c. On 200: stream the CAR body directly into
      `POST {kuboApiUrl}/api/v0/dag/import?pin-roots={IPFS_PIN_ARNS_CONTENT}` as
      multipart/form-data (`file` field). **Kubo verifies every block against its CID
      on import** — a tampered/lying CAR fails to import. On import error:
      `reportFailure`, next peer.
   d. On import success: `peerManager.reportSuccess('ipfs', peerId)`. The content is
      now in local Kubo. Serve it by delegating to
      `this.kuboDataSource.getContent({ cidString, path, format, range, localOnly:true })`
      (now a local hit) and return that `IpfsContentResult`. Pin via `this.pinner?.pin`
      if not covered by `pin-roots`.
4. All peers exhausted → throw `IpfsNotFoundError` (composite falls through to tier 3).

**Notes:**
- Use `got`/`axios` streaming (mirror `KuboDataSource`'s HTTP client + the multipart
  pattern is new — `dag/import` does not exist yet; `IpfsPinner.rpc` L93 is the closest
  existing RPC call and shows the `{apiUrl}/api/v0/...` convention). A multipart CAR
  upload is required (`form-data` or `got`'s form support).
- Always fetch `?format=car` from peers regardless of the client's requested format:
  the CAR carries the whole DAG so Kubo can verify block links, and it sidesteps the
  multi-block UnixFS trust gap. After import we re-derive the client's requested
  format locally in step 3d.
- Respect `signal` (client disconnect) — abort in-flight peer fetches.

### 3.4 `SequentialIpfsSource` (tier composition)

**File:** `src/ipfs/sequential-ipfs-source.ts` (new). Implements `IpfsContentSource`.
Mirror `src/data/sequential-data-source.ts` fall-through logic:

- Constructor: `{ log, sources: IpfsContentSource[] }`.
- `getContent(opts)`: iterate `sources` in order; return the first success.
- **Fall-through policy** (differs from Arweave's — IPFS has moderation semantics):
  - `IpfsNotFoundError`, `IpfsTimeoutError`, `IpfsUnavailableError` → log warn, try
    next source.
  - `AbortError` with `signal.aborted` (genuine client disconnect) → **re-throw**
    (short-circuit), same as `SequentialDataSource` L149.
  - `IpfsBlockedError` (451, moderation) → **re-throw immediately** (do NOT fall
    through — a blocked CID must stay blocked across all tiers).
  - `IpfsSizeLimitError` / `IpfsRangeNotSatisfiableError` → re-throw (not a
    availability miss).
- After all sources exhausted → throw `IpfsNotFoundError` (route maps to 404).

### 3.5 Local-only gating in the composite

`SequentialIpfsSource.getContent` must run **only tier 1** when `opts.localOnly`:

- Simplest: gate at composition — when `localOnly`, only call the first source
  (`KuboDataSource` in offline mode) and skip the rest. Two clean options:
  1. `SequentialIpfsSource` checks `opts.localOnly` and iterates only `sources[0]`; or
  2. each source self-guards (peer source already throws under local-only per §3.3.1;
     the tier-3 public Kubo source would need the same guard).
- Recommended: **both** — composite iterates tier 1 only under local-only, *and* the
  peer source self-guards. Defense in depth; the self-guard also protects any future
  caller that bypasses the composite.

### 3.6 Wire the composite in `system.ts`

**File:** `src/system.ts`, IPFS block L1880–1961 (guarded by `config.IPFS_ENABLED`).

- `kuboDataSource` already built at L1894. `arIOPeerManager` already in scope
  (constructed L795).
- Build (only when `config.IPFS_PEER_FETCH_ENABLED`):
  ```ts
  const ipfsPeerDataSource = new IpfsPeerDataSource({
    log, peerManager: arIOPeerManager, kuboApiUrl: config.IPFS_KUBO_API_URL,
    kuboDataSource, peerCount: config.IPFS_PEER_FETCH_COUNT,
    requestTimeoutMs: config.IPFS_PEER_FETCH_TIMEOUT_MS,
    maxCarBytes: config.IPFS_PEER_FETCH_MAX_CAR_BYTES, pinner: ipfsPinner,
  });
  const ipfsCompositeSource = new SequentialIpfsSource({
    log,
    sources: config.IPFS_PEER_FETCH_ENABLED
      ? [kuboDataSource /*tier1 offline via localOnly*/, ipfsPeerDataSource, kuboDataSource /*tier3 public*/]
      : [kuboDataSource],
  });
  ```
  > Tier 1 and tier 3 are the *same* `KuboDataSource` instance; tier 1 is reached with
  > `localOnly:true` and tier 3 without. Because `SequentialIpfsSource` under
  > `localOnly` runs only `sources[0]`, and under normal mode runs all three, the
  > cleanest encoding is a small wrapper that fixes `localOnly` per tier — e.g.
  > `new LocalOnlyKubo(kuboDataSource)` for tier 1 (forces `localOnly:true`) and the
  > raw `kuboDataSource` for tier 3. Add that 10-line wrapper in
  > `sequential-ipfs-source.ts` or inline. This avoids the composite having to know
  > which index is "the offline one."
- Change `IpfsService` construction (L1937): `dataSource: ipfsCompositeSource` and
  widen `IpfsService`'s `dataSource` field type (ipfs-service.ts L46) from
  `KuboDataSource` to `IpfsContentSource`.
- When `IPFS_PEER_FETCH_ENABLED` is false, the composite is a 1-element passthrough →
  **zero behavior change** (safe default; this is how it ships dark).

### 3.7 Config

**File:** `src/config.ts`, IPFS block L3205–3321. Add (use `env.varOrDefault` /
`env.positiveIntOrDefault` like the neighbors):

| Var | Default | Purpose |
|---|---|---|
| `IPFS_PEER_FETCH_ENABLED` | `false` | Master switch (ship dark, enable after the multi-node test passes). |
| `IPFS_PEER_FETCH_COUNT` | `3` | Peers to try per CID. |
| `IPFS_PEER_FETCH_TIMEOUT_MS` | `5000` | Overall peer-attempt deadline (short — public IPFS is the patient fallback). |
| `IPFS_PEER_FETCH_MAX_CAR_BYTES` | `104857600` (100 MB) | Cap; above this skip peers → public IPFS. |
| `IPFS_PEER_SERVE_LOCAL_ONLY_RATE_*` | reuse ipfs limiter | Bound inbound local-only peer-serve load (see §3.8). |

**File:** `docker-compose.yaml` — plumb all new vars to the `core` service (the block
at L160–178 where the other 18 `IPFS_*` vars are passed), same `${VAR:-}` pattern.

### 3.8 Serve-side hardening (inbound local-only peer requests)

A gateway now receives `X-Ar-Io-Local-Only: true` requests from peers. These are cheap
(no public recursion) but must be bounded:
- Reuse the existing `ipfsRateLimiter` (system.ts L1946). Consider a distinct bucket
  or a lighter limit for local-only requests since they're strictly cheaper than full
  fetches but higher-frequency (fleet chatter).
- Local-only requests must **bypass payment/402** if any (they're intra-fleet); check
  `paymentProcessor` wiring in `createIpfsRouter` (L56) — likely gate payment on
  `!localOnly`.
- Moderation (`blockListValidator` / `IpfsBlockedError`) applies identically to
  local-only and imported content. A blocked CID is blocked whether served, imported,
  or probed.

### 3.9 Metrics / observability

Add Prometheus counters (mirror existing IPFS metrics): peer-fetch attempts, successes,
failures-by-reason (timeout / non-200 / import-verify-fail / cap-exceeded), CAR bytes
imported, local-only serve hits/misses. These are the signals that tell operators the
fleet layer is working and feed 1.5b routing decisions.

---

## 4. Phase 1.5b — content routing (who-holds-what)

Blind-asking a GAR subset is fine at small fleet size (bounded by the local-only
fast-404) but doesn't scale. Build on 1.5a's primitive:

- **(1) DHT-filtered discovery.** Resolve IPFS providers for `X`, prefer peer-ids that
  map to GAR-registered AR.IO gateways, fetch from them via the trustless HTTP CAR
  endpoint (faster + verified) instead of Bitswap. Zero new infra.
- **(2) Announced holdings.** Because holdings are *named* (ArNS), the set is small and
  enumerable. Expose a well-known endpoint `GET /ar-io/ipfs/held` listing the
  named CIDs a gateway holds (locally verified). Peers/observers scrape it; the
  peer-selection in §3.3.2 consults this hint instead of blind selection. The observer
  already visits every gateway (see §7) so it can build a fleet-wide holdings map as a
  byproduct and serve it as a routing hint.
- **(3) Deterministic assignment (later).** Rendezvous-hash named CIDs to a gateway
  subset for planned N-replica durability. Strongest guarantee, most work; composes
  with the incentive. Out of scope for the first cut.

**First 1.5b cut = (1) + (2):** add `/ar-io/ipfs/held` + have `IpfsPeerDataSource`
prefer hint-matched peers, falling back to `selectPeersForKey`. This is additive to
1.5a and needs no interface changes.

---

## 5. File-change checklist (implementer TL;DR)

**New files:**
- `src/ipfs/ipfs-content-source.ts` — `IpfsContentSource` interface.
- `src/ipfs/ipfs-peer-data-source.ts` — tier-2 source (+ its `.test.ts`).
- `src/ipfs/sequential-ipfs-source.ts` — composite + local-only gating + `LocalOnlyKubo` wrapper (+ `.test.ts`).
- `test/end-to-end/ipfs-peer-fetch.test.ts` — the multi-node harness (§6).
- (1.5b) `src/routes/ar-io.ts` addition or new handler for `GET /ar-io/ipfs/held`.

**Changed files:**
- `src/ipfs/kubo-data-source.ts` — `localOnly` option + offline RPC path (§3.1); implement `IpfsContentSource`.
- `src/ipfs/ipfs-service.ts` — `localOnly` passthrough; widen `dataSource` type to `IpfsContentSource` (L46).
- `src/routes/ipfs.ts` — parse `X-Ar-Io-Local-Only` (~L234); gate payment on `!localOnly`.
- `src/system.ts` — build peer source + composite; inject into `IpfsService` (L1937).
- `src/config.ts` — new `IPFS_PEER_FETCH_*` vars (L3205 block).
- `src/constants.ts` — optional `X-Ar-Io-Local-Only` in `headerNames`.
- `docker-compose.yaml` — plumb new vars to `core` (L160 block).
- Metrics module — peer-fetch counters (§3.9).

**No changes to:** any Solana program, `ario-gar`, observer contract logic. (Observer
holding-probe rider is a *separate repo* change — §7.)

---

## 6. Testing (the priority) — including the multi-node harness

### 6.1 Unit tests (`node --test`, `npm run test:file <path>`)

- `kubo-data-source.test.ts` — extend: `localOnly:true` issues the offline RPC call and
  maps a local miss to `IpfsNotFoundError` (mock the Kubo RPC with `nock`/a stub).
- `ipfs-peer-data-source.test.ts` (new):
  - happy path: peer returns a valid CAR → `dag/import` called → re-serve returns the
    content; `reportSuccess` called.
  - **tamper:** peer returns a CAR whose bytes don't hash to the CID → `dag/import`
    rejects → source tries next peer → `reportFailure` on the bad peer. (Use a real
    small CAR + a corrupted copy; assert import fails. If mocking Kubo, simulate the
    import 500.)
  - `localOnly:true` → throws `IpfsNotFoundError` immediately, no peer calls.
  - cap exceeded → aborts, next peer.
  - all peers fail → `IpfsNotFoundError`.
- `sequential-ipfs-source.test.ts` (new): tier fall-through on NotFound; short-circuit
  on `AbortError`; **no fall-through on `IpfsBlockedError`**; local-only runs tier 1
  only (assert tiers 2/3 are never called).
- `routes/ipfs.test.ts` — extend: `X-Ar-Io-Local-Only: true` threads `localOnly:true`
  into `getContent`; local miss → 404; payment bypassed under local-only.

### 6.2 Multi-node integration test (the key ask)

**Goal:** prove two/three real gateways pull verified content from each other, that
durability holds with public IPFS out of the picture, and that a lying peer is
rejected.

**Harness:** `test/end-to-end/ipfs-peer-fetch.test.ts`, using the **existing
`testcontainers` + `Network` pattern** from `test/end-to-end/data-sources.test.ts`
(which co-starts sidecars on `new Network()` with network aliases). Precedent, helpers,
and the `getCoreContainer()` build (`test/end-to-end/utils.ts` L21) already exist.

**Topology (2 nodes to start, extend to 3):**
```
        Network "ipfs-fleet"
   ┌──────────────────────────────────┐
   │  core-a ── kubo-a  (holds CID X)  │
   │  core-b ── kubo-b  (cold)         │
   └──────────────────────────────────┘
```
- Start `new Network()`.
- Start `kubo-a`, `kubo-b` from `ipfs/kubo:v0.32.1` (the pinned image; profile `ipfs`
  in compose) with `.withNetwork(network).withNetworkAliases('kubo-a'|'kubo-b')`.
  **Isolate from public IPFS** so the test proves fleet-durability, not a public
  fetch: run each Kubo with an empty bootstrap list / `Swarm` disabled (e.g.
  `ipfs bootstrap rm --all` before `daemon`, or `--offline` for the cold node), so
  `core-b` *cannot* get X from public IPFS — only from `core-a`.
- Start `core-a`, `core-b` from `getCoreContainer()` (`GenericContainer.fromDockerfile`)
  with:
  - `IPFS_ENABLED=true`, `IPFS_PEER_FETCH_ENABLED=true`.
  - `IPFS_KUBO_URL=http://kubo-a:8080` / `http://kubo-b:8080`,
    `IPFS_KUBO_API_URL=http://kubo-a:5001` / `http://kubo-b:5001`.
  - Peer discovery: point `core-b` at `core-a` as a peer. Two options — (a) stub the
    GAR/`arIOPeerManager` peer list via env or a test seam so `core-b`'s `'ipfs'` peer
    set = `['http://core-a:<port>']`; or (b) set `TRUSTED_GATEWAYS_URLS` and have the
    peer source read from it in tests. Prefer a **test seam**: allow
    `IpfsPeerDataSource` peers to be injected/overridden by an env var
    (`IPFS_PEER_FETCH_STATIC_PEERS`) for deterministic testing — this is also useful in
    production for private fleets. Add that env override as part of 3.3.
  - `.withNetwork(network).withNetworkAliases('core-a'|'core-b')`,
    `Wait.forHttp('/ar-io/info', <port>)`.
- **Seed:** `ipfs add` a known file into `kubo-a` (via `kubo-a` RPC), capture CID `X`;
  pin it on `core-a` (or ensure held). Assert `core-a` serves it and `core-b` does not
  (local-only probe on `core-b` → 404).

**Assertions:**
1. **Peer-fetch works:** `GET http://core-b:<port>/ipfs/{X}?format=car` (or via the
   `{cidv1}.` subdomain / path handler) → 200, bytes verify against `X`. Under the
   hood `core-b` fetched the CAR from `core-a`, imported+verified into `kubo-b`.
2. **Durability independent of public IPFS:** because `kubo-b` has no bootstrap/swarm
   to public IPFS, a 200 proves it came from `core-a` (the fleet), not the public
   network. (Belt: assert peer-fetch metric incremented on `core-b`.)
3. **Now holds it:** after the fetch, a **local-only** probe on `core-b`
   (`GET http://core-b:<port>/ipfs/{X}?format=raw` + `X-Ar-Io-Local-Only: true`) → 200
   + verifying bytes. Before the fetch the same probe → 404. This is the exact holding
   signal the observer will use (§7).
4. **Tamper rejection:** stand up a **malicious peer** — a tiny HTTP stub container (or
   a mocked `core-c`) that answers `/ipfs/{X}?format=car` with a CAR whose bytes don't
   hash to `X`. Put it ahead of `core-a` in `core-b`'s peer list. Assert `dag/import`
   on `kubo-b` rejects it, `core-b` reports the peer failed, falls through to `core-a`,
   and still serves correct bytes. (Proves the "untrusted peer is safe" claim.)
5. **Recursion guard:** a `X-Ar-Io-Local-Only: true` request to `core-b` for a CID it
   doesn't hold → fast 404 and (assert) no outbound peer/public fetch (metric = 0).
6. **(3-node extension):** add `core-c` holding a *different* CID `Y`; assert `core-b`
   fetches `X` from `core-a` and `Y` from `core-c`, and that hash-ring
   `selectPeersForKey` routes each CID to the holder.

**Runtime notes:** these are heavy (real containers + Kubo). Gate behind
`test:e2e` (already separate from unit `test`), respect `USE_PREBUILT_IMAGE`
(`utils.ts` L149) for CI. Reuse `waitFor`/`waitForLogMessage` (`utils.ts`) for
readiness. Keep the seed file small (KB) so CAR import is instant.

### 6.3 Manual smoke (local, before CI)

`docker compose --profile ipfs up` two stacks on one host (or the two-node compose in
§6.2), enable peer-fetch, `ipfs add` on one, curl the other. Confirm the local-only
probe flips 404→200 after the first fetch.

---

## 7. Observer holding-probe rider (separate repo, no contract, do after 1.5a)

Not part of the gateway PR; documented here so it's not lost. In **`ar-io-observer`**:
- The live path already fetches `?format=raw` and verifies via
  `assessIpfsNameTrustless` / `getIpfsRawBlock` (observer.ts). Add
  `X-Ar-Io-Local-Only: true` to that request so a PASS additionally proves the gateway
  *holds* (not just proxies) the content.
- Make it a **ramped policy** (like the IPFS-capability ramp): during rollout, a
  not-yet-holding gateway is NEUTRAL, not FAIL, so honest operators aren't abruptly
  penalized while the fleet warms. Flip to holding-required once adoption is high.
- (Phase 3, later) sample K random **leaf** CIDs from the DAG and local-only-verify
  each — stops "pin only the tiny root." IPFS analog of the Arweave chunk/offset proof.
- **Zero contract change:** holding is rewarded through the existing content-agnostic
  name assessment. The optional dedicated holding-weight (contract) is explicitly out
  of scope.

---

## 8. Rollout & sequencing

1. **Spike §3.1a** (Kubo per-request offline) — gates everything.
2. `localOnly` in `KuboDataSource` + route header + `IpfsService` passthrough + unit
   tests. Ship-able alone (enables the observer holding-probe even before peer-fetch).
3. `IpfsPeerDataSource` + `SequentialIpfsSource` + composite wiring, behind
   `IPFS_PEER_FETCH_ENABLED=false`. Unit tests.
4. **Multi-node integration test (§6.2)** — the acceptance gate. Do not enable in prod
   until assertions 1–5 pass.
5. Metrics + serve-side rate limiting.
6. Enable `IPFS_PEER_FETCH_ENABLED=true` on a canary node, watch metrics, then default.
7. 1.5b routing (`/ar-io/ipfs/held` + DHT-filtered discovery) as a follow-up PR.
8. Observer holding-probe rider (separate repo) once §3.2 shipped.

Each of 2–7 is an independently reviewable PR. 1.5a's value (fleet durability + faster
serving) lands at step 6 with no contract change.

---

## 9. Risks & mitigations (carried from the design sketch)

| Risk | Mitigation |
|---|---|
| Recursion / amplification across the fleet | `localOnly` runs tier 1 only; peer source self-guards; composite gates. |
| DoS on inbound local-only serve | Rate-limit (§3.8); local-only is cheap (no public recursion) but bounded. |
| Large CAR transfer | `IPFS_PEER_FETCH_MAX_CAR_BYTES` cap → fall through to public IPFS. |
| Lying / malicious peer | Kubo verifies blocks on `dag/import`; bad CAR fails → next peer. Proven by test §6.2#4. |
| Binding vs content trust | Peer-fetch is content only (CID→bytes). Name→CID binding stays chain-authoritative (on-demand resolution). Independent, composable. |
| Cold-start / who-holds-what | v1 blind GAR-subset (bounded by local-only 404); 1.5b routing as it grows. |
| Kubo offline semantics unreliable | Spike §3.1a; fallback options listed there. |

---

*Read alongside `ipfs-peer-durability-layer.md` (design rationale, incentive analysis,
lifecycle diagram). This plan deliberately excludes the announcement/social strategy,
which is kept private outside the repo.*
