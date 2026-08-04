# Alignment check: our ArNS/IPFS/OIP work vs. David's brain

Reading of `ar-io/davids-brain` (`big-picture.md` §1–§5; `docs/ar-io-node/ipfs-integration.md`)
against what shipped in this branch (#682 Kubo-sidecar IPFS + #793 ArNS→IPFS +
the parity/QA work here). Honest version: we align on **direction**, and diverge
from David on the **core trust/storage/serving axes**. Both are worth stating.

## What David wants (the yardstick)

- **§1/§2 — protocol-independent addressing.** A client asking for `bafy…`
  shouldn't care whether bytes are on Arweave/S3/Filecoin, *as long as the bytes
  hash back to the address and the signer checks out.* Storage contract is a
  pluggable back end under a thin verified addressing layer.
- **§3 — browsers are the wrong target.** A gateway that proxies content back
  over `https://` while implying it's verified "is strictly worse than a CDN."
- **§5 — verification on the client.** The gateway collapses from "trusted
  query/verification oracle" to "cache + offset resolver + protocol translator."
- **His IPFS design specifically:** lead with the **Trustless Gateway**
  (`GET /ipfs/:cid?format=raw` → one verifiable block, *client* checks CID),
  content **stored on Arweave** via CAR ingest + a `cid → (id, offset, len,
  codec)` index served through **the existing `src/data/` composite source**, and
  **Path Gateway / UnixFS reassembly explicitly pushed to a *separate paired IPFS
  node*, not built into ar-io-node.** "The gateway is not a trust root."

## Where we align ✅

- **Direction (§1/§2).** Making `protocol` first-class on `NameResolution`,
  propagating it across a trusted-gateway hop, and letting ArNS names point at
  CIDs is exactly the "protocol-independent addressing" move David calls the right
  instinct — "just push further."
- **We did not grow UnixFS/Path-Gateway logic into ar-io-node core.** We delegate
  reassembly/dir-resolution to a **paired Kubo node** — which is precisely where
  David says that responsibility belongs ("a separate paired IPFS node… rather
  than building UnixFS logic into ar-io-node"). Our service boundary is right.
- **Gateway hygiene / parity.** HEAD, Range/206, per-CID sandbox origin
  isolation, unified moderation, caching, rate limiting, HTTPSIG envelope — none
  of this conflicts with his design; it's the table stakes he assumes.

## Where David would call us out ⚠️

1. **We built a Path Gateway (trusted proxy), not a Trustless Gateway
   (client-verifiable).** We serve Kubo-reassembled bytes over TLS and *sign them
   with HTTPSIG* — i.e. "we won't lie to you." David's whole §3/§5 thesis is the
   opposite: return verifiable blocks and let the client check the hash ("you
   don't need to trust us"). **Signing IPFS responses as if attested is the exact
   anti-pattern he flags.** We never expose `?format=raw` blocks or let a client
   verify a CID. → *Call-out: offer a trustless `?format=raw` block path, and be
   explicit that the current UnixFS path is trusted-proxy, not verified.*

2. **Our content lives on the public IPFS network, not permapinned on Arweave.**
   David's entire integration is *IPFS-content-stored-on-Arweave* ("permapin this
   CID/CAR", CAR ingest → index → serve from Arweave storage). We proxy ephemeral
   public-IPFS content via Kubo (`--enable-gc`, unpinned content vanishes). This
   **misses §1's point** (contracts coexisting *under* Arweave's durability) and
   creates the availability problem the incentive analysis independently found.
   → *Call-out: the durable product is Turbo "permapin CID/CAR" + ar-io-node CAR
   indexing, not a Kubo proxy to public IPFS.*

3. **We bypassed the `src/data/` composite source.** David's serve path is "CID
   lookup → range-read via the existing data source composite (S3, peers, chain,
   …)". We added a **parallel Kubo stack** (`KuboDataSource`/`IpfsFsCache`) with
   its own return type and cache, converging only at routing. That is the
   opposite of "one thin verified addressing layer over pluggable back ends"
   (§2). → *Call-out: a `cid → offset` index feeding the composite source is the
   aligned shape; the Kubo sidecar is a shortcut that entrenches a second stack.*

4. **No client-side verification and no chain anchor (§5).** We emit no
   `?format=raw`, no per-block CID check, and none of the merkle-proof headers
   (`X-Arweave-Chunk-Data-Path`/`-Tx-Path`/…) on IPFS routes. The gateway is a
   trust root — the thing §5 exists to eliminate. His Stage 2 ("proof headers +
   portable validator") is the whole payoff, and we're not on that path.

5. **ArNS→IPFS resolving to ephemeral content dilutes the ArNS value prop.** A
   name pointing at unpinned public-IPFS content can 404 tomorrow; ArNS
   historically implies permanence. (Reinforced by the OIP analysis: names are
   observed/rewarded assuming retrievability.)

## OIP / observation (ties to §4/§5)

The separate incentive analysis found the observer verifies ArNS serving by
**trust-based digest comparison against reference gateways** — the exact
"gateway as trusted oracle" pattern David wants gone. His §5 posture says the
**observer should verify CID→bytes itself** (content-addressing makes this free),
not trust a reference set. And rewarding "serving" ephemeral, non-permapinned
content has no durability anchor. So the OIP gaps and David's critique point the
same way: **verify, don't trust; anchor to the chain; reward durability, not
proxying.**

## Honest bottom line

What we shipped is a **pragmatic, correct, well-hardened Path-Gateway-over-Kubo**
that realizes the *addressing* direction (§2) and is genuinely useful as a
browser/convenience fallback. But on **storage (public IPFS vs Arweave), trust
(gateway-signed vs client-verified), and architecture (parallel Kubo stack vs
composite source)**, it is close to the inverse of David's design. His critical
path — **Stage 0 SQLite chunk-metadata index → Stage 1 CAR ingest + trustless
`/ipfs/:cid?format=raw` → Stage 2 proof headers + portable validator** — is a
different, larger build that our work neither advances nor blocks.

Recommended framing for the team: **ship ours as the explicitly-trusted Path
fallback**, and **treat David's trustless/CAR/verification path as the real
roadmap** (his Stages 0–2). Two concrete, low-cost steps that move us toward him
without a rewrite:
- Add a trustless `GET /ipfs/:cid?format=raw` that serves a single block and does
  **not** HTTPSIG-attest it as verified (client verifies).
- Stop implying verification on the UnixFS path — document `X-Ar-Io-Source: ipfs`
  as *trusted-proxy*, and don't let the signed envelope read as a content proof.
