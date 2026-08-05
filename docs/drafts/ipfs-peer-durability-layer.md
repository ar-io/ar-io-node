# AR.IO as a Verifiable Durability Layer for Named IPFS — Peer-Fetch Design Sketch

> Design sketch (not a spec). Turns the AR.IO gateway fleet from a *read-only
> proxy to public IPFS* into a **durable, verifiable, decentralized serving layer**
> for named IPFS content — without uploading to Arweave. This is the "phase 1.5"
> between today's read-only proxy and David's CAR-to-Arweave permanence.

## TL;DR

An AR.IO gateway that needs an IPFS CID fetches it **from a peer AR.IO gateway that
already holds it**, over HTTP, and **verifies the bytes against the CID** — instead
of (or before) reaching out to the public IPFS network. Because the fetch is
content-addressed, the peer is never trusted: a wrong-bytes peer is caught by the
hash. So *any* gateway can safely serve *any* other.

The result: **named IPFS content stays available as long as one AR.IO gateway holds
it**, independent of whether the origin public-IPFS providers are still online — and
it flows fast, over HTTP, cryptographically verified.

## Why it matters (the value prop)

Today read-only IPFS has an honest weakness (David and the OIP analysis both flag
it): public-IPFS content can be GC'd, so an ArNS name → IPFS CID can 404 tomorrow.
That dilutes the ArNS permanence promise.

Peer-fetch + fleet pinning changes the durability story:

- **Durable** — content persists as long as *any* participating gateway holds it;
  the fleet is a resilient pinning cluster, not a passthrough.
- **Fast** — a peer with the content hot serves it over HTTP in ms, versus a cold
  public-IPFS DHT walk (seconds, or a timeout).
- **Trustless** — served bytes are verified against the CID; no trust federation,
  no allow-list. An untrusted or even malicious gateway can serve content safely.
- **Decentralized** — the value AR.IO provides (durable named content) stops
  depending on the health of public IPFS.
- **Incentivizable** — and this is the key unlock below: it gives the OIP a
  *trustless way to measure pinning*, which read-only IPFS was missing.

This is a materially stronger value prop than "proxy to public IPFS": it's
durability approaching Arweave's promise, delivered by fleet replication rather than
Arweave storage.

## Mechanism

Everything needed already exists in the gateway; this composes it.

1. Gateway **B** needs CID `X` (miss in its local cache; its own Kubo can't find it
   or public IPFS timed out).
2. B asks one or more **peer AR.IO gateways** for the content as a CAR:
   `GET https://{peer}/ipfs/{X}?format=car` with a **local-only** hint (below).
3. A peer **A** that *holds* `X` returns the CAR (the full DAG). We already serve
   `?format=car` (`routes/ipfs.ts` → `KuboDataSource` `format: 'car'`).
4. B imports the CAR into its own Kubo via the RPC we already use
   (`{IPFS_KUBO_API_URL}/api/v0/dag/import`, same path pattern as `pin/add`).
   **Kubo verifies every block against its CID on import** — so a lying peer's CAR
   fails to import and B moves to the next peer. No bespoke DAG-verify code needed;
   Kubo is the verifier.
5. B now holds `X` (verified, in Kubo), serves the user, and — if
   `IPFS_PIN_ARNS_CONTENT` — pins it. The content has replicated one more time.

For a raw single-block CID this is trivially one block; for a UnixFS/dag-pb DAG the
CAR carries the whole graph, and Kubo's import verifies the block links. That also
sidesteps the multi-block trust gap (the reassembled UnixFS bytes don't hash to the
CID, but the CAR's blocks do).

### The local-only serve mode (the load-bearing primitive)

A peer request must **not** recurse — if B asks A and A doesn't have it, A must NOT
turn around and hit public IPFS or its own peers (latency + loops + amplification).
So peer requests carry a header, e.g. `X-Ar-Io-Local-Only: true` (or a dedicated
peer endpoint), and A serves **only from its local cache / Kubo pin**, returning
404 fast if it doesn't hold the content. This bounds the work and prevents fetch
loops across the fleet.

### Where it slots architecturally

IPFS currently has a single source (`KuboDataSource` → local Kubo → public IPFS).
Introduce a small **IPFS composite** mirroring the Arweave `SequentialDataSource`
pattern:

```
local cache  →  peer AR.IO gateways (verified CAR import)  →  local Kubo → public IPFS
```

Ordering is a tuning choice. A defensible v1: try a **bounded, short peer attempt**
(2–3 peers, short deadline) before the public-IPFS fallback, so hot content comes
from the fleet fast and cold/dropped content still falls through to public IPFS.

## The killer tie-in: trustless pinning measurement → the persistence incentive

The earlier OIP analysis had a hard blocker: *"`X-Cache` is gateway-asserted; the
observer can't distinguish a gateway serving from its own pin vs. fronting someone
else's."* The **local-only serve mode fixes exactly that**:

> The observer requests `?format=raw|car` with `X-Ar-Io-Local-Only: true` and
> verifies the bytes against the CID. A 200 + verifying bytes **proves the gateway
> holds the content locally** — it served without reaching public IPFS. A gateway
> that only proxies returns 404 in local-only mode.

So the same primitive that powers peer-fetch also gives the observer a **trustless,
un-gameable signal for pinning/holding** — which is precisely what a
persistence/pinning reward category needs. That closes the loop the earlier analysis
left open:

- Observer already verifies a gateway **serves** a CID correctly (shipped).
- Local-only + CID verification lets it verify a gateway **holds** a CID.
- The OIP can then reward **holding named IPFS content** (a new reward category),
  measured trustlessly. Combined with Phase-3 leaf sampling (verify random leaf
  blocks, not just the root), a gateway can't game it by pinning only the tiny root.

Peer-fetch + local-only + pinning incentive = a **decentralized, incentivized,
verifiable durability layer for named IPFS**, with zero Arweave storage.

## Peer discovery

Who does B ask, and how does it find who *holds* `X`?

- **v1 (simple):** the on-chain **GAR** (gateway address registry — the gateway
  already reads it; `config.ts` "in the GAR … a simple lookup") gives the peer set.
  B tries a bounded random/weighted subset. Cheap, no new infra; wasteful only in
  that it may ask peers that don't hold `X` (bounded by the local-only 404 fast
  path).
- **v2 (routed):** a who-holds-what hint so B asks the *right* peers. Options:
  reuse IPFS DHT provider records filtered to AR.IO gateways; or a lightweight
  AR.IO content-routing index (gateways announce the named CIDs they pin). This is
  the main scaling question and can come later.

## Alignment with David's vision

- **Durability without Arweave storage.** David's durability comes from CAR→Arweave
  (phase 2). This delivers durability from *fleet replication + pinning* now — a
  different substrate, same goal (named content persists). The two **compose**: a
  gateway can fleet-pin today and permapin to Arweave in phase 2.
- **Verify, don't trust (§5).** Peer content is CID-verified (Kubo import). The
  gateway remains "cache + protocol translator," never a trust root — now also a
  *verifiable peer content router*.
- It's a genuine stepping stone toward his Stage 1 (CAR ingest): the CAR-transfer +
  import machinery here is the same shape as CAR-to-Arweave, minus the Arweave sink.

## Risks / open questions

- **Recursion / amplification** — mitigated by the local-only hint (no fan-out).
- **DoS on peer-serving** — rate-limit local-only peer requests; they're cheap
  (no public-IPFS recursion) but still need bounding.
- **CAR size** — a large file's CAR is large; cap the peer-import size and fall
  back to public IPFS above the cap (or stream+verify in bounded chunks).
- **Binding vs. content trust** — peer-fetch is for *content* (CID→bytes,
  trustless). The name→CID *binding* still comes from chain (on-demand resolution).
  The two are independent and compose.
- **Cold-start / who-holds-what** — v1's blind-subset ask is fine at small fleet
  size; routing (v2) matters as it grows.
- **Incentive gaming** — pinning only the root block; addressed by Phase-3 leaf
  sampling on the measurement side.

## Phasing

- **1.5a — peer-fetch fallback source** (gateway): IPFS composite + local-only serve
  mode + CAR-import-verify from a GAR-subset of peers, as a fallback when public
  IPFS misses. Durability with minimal new infra. No contract change.
- **1.5b — content routing** (gateway/network): efficient who-holds-what so peers
  are asked precisely rather than blindly.
- **1.5c — pinning incentive** (observer + contract): observer measures holding via
  local-only + CID verification (+ leaf sampling); OIP adds a reward category for
  holding named IPFS. This is the contract-level piece.
- **2 — CAR → Arweave** (David): true permanence, composed on top of the above.
