# Observer Adjustments for Named IPFS Data — Change Spec

> Companion to `ipfs-observation-incentive-analysis.md` (the Fable gap analysis)
> and `davids-brain-alignment.md`. This is a **design spec for protocol-team
> review**, not merged code. Every current-state claim below was verified against
> the live source, cited inline.
>
> **Goal: make named IPFS data a first-class citizen** — served, resolved, and
> trustlessly verified — **with zero smart-contract changes.** Scope is
> **observer-only**; the Solana programs (`ario-gar`/`ario-arns`/`ario-ant`) are
> untouched, which is possible because prescription and reward accounting are
> already content-agnostic (§2). Contract-level work (stratified prescription,
> pinning incentives) is explicitly out of scope and called out in §7.

Verified sources:
- Observer: `/programs/ar-io-observer` @ `chore/remove-aws-observer-deploy`
  (running as `ar-io-node-observer-1`), `REPORT_FORMAT_VERSION = 2`.
- Gateway: `/programs/ar-io-node/wt/ipfs-sync-793` (PR #793, this IPFS branch).

---

## 0. As shipped — final design (supersedes the phased proposal below)

The plan below was implemented in `ar-io-observer` PR #112 and then hardened
through **five multi-agent adversarial-review passes**. The shipped design differs
from the original proposal in a few important ways; this section is the source of
truth, and the phased sections that follow are kept for the rationale.

**Where it runs.** The logic lives in a shared `assessIpfsNameTrustless()` in
`observer.ts`, called by BOTH the one-shot `Observer` and the **live**
`ContinuousObserver → GatewayAssessor` path (the original proposal targeted only
`Observer`, which the running service does not use). Both paths route through the
same function so scoring cannot diverge. `REPORT_FORMAT_VERSION` is bumped 2 → 3
(adds `protocol` + a tri-state `outcome`); on-chain submission is unchanged.

**Routing (which names get the IPFS path).** A name is assessed via the trustless
IPFS path iff its (reference-resolved) `resolvedId` is a **valid CID** —
`isIpfsAssessable()`. We do **not** route on the `x-arns-protocol` header: it is
not part of reference consensus and older gateways may omit it. The CID form is the
ground truth (Arweave names resolve to a 43-char tx id, not a CID), and it also
blocks a poisoned reference from flipping an Arweave name onto the IPFS path.

**Scoring (per IPFS name).** The observer fetches the target gateway's
`?format=raw` block and verifies it against the reference-bound CID:
- **PASS** — served 200 `application/vnd.ipld.raw` bytes that hash to the CID.
- **FAIL** — served 200 bytes that do NOT hash to the CID (a *proven-wrong*
  answer). The fail/neutral decision never trusts the gateway's own
  `x-arns-resolved-id` — a gateway controls both the bytes and that header, so a
  self-minted CID proves nothing. (Consistent with the Arweave path, which also
  fails on a reference `resolvedId` mismatch.)
- **NEUTRAL** (excluded from the pass/fail denominator) — anything that is not a
  clean pass or a proven-wrong answer: not served / non-200 / timeout / non-raw
  `Content-Type` / empty body / a multihash we can't verify (non-sha2-256). So a
  gateway is **never failed for availability**, and participating in IPFS is never
  riskier than abstaining. **Capability is judged behaviorally** — a non-IPFS
  gateway 404s its Arweave path → neutral. (This replaces the original
  self-reported `/ar-io/info` `ipfs.enabled` capability gate, which a malicious
  operator could flip to exempt itself.)

**Neutral is excluded everywhere** — `namesPass`, the ArNS metrics, the
report-selection failure rate, and the `GatewayAssessor` pass rate — via a shared
`arnsNameOutcome()`, so a neutral name can never move a gateway's on-chain result.

**Timeouts.** The raw-block fetch has an explicit `IPFS_ASSESSMENT_TIMEOUT_MS`
(default 35s, ≥ the gateway's 30s IPFS budget) with the socket-idle timeout
overridden, and never hangs (all errors resolve as not-served → neutral).

**Recommended reference topology (see the on-demand default, ar-io-node PR #836).**
Point the observer's reference at **its own co-located gateway** (`ARNS_ROOT_HOST`)
with that gateway resolving ArNS **on-demand** (from chain). Then the name→CID
binding is authoritative (chain-derived via your own gateway's resolver — no
re-implementation, no external-gateway or header trust) and more decentralized;
the network still aggregates observers by majority.

**Still deferred (Phase 3).** A dag-pb/UnixFS `PASS` proves possession of the DAG
**root block** only; leaf/assembled-path verification is the IPFS block-sampling
analog of the Arweave chunk/offset proof and is not built. Contract-level items
(stratified prescription, pinning incentives) remain out of scope (§7).

---

## 1. Why any change is needed (the safety problem)

IPFS-target ArNS names (`AntRecord.target_protocol = 1`) are **already eligible**
for prescription and chosen-name sampling — the observer is entirely
protocol-blind. Verified:

- No `x-arns-protocol` / CID / multihash handling exists anywhere in the observer
  (repo-wide grep: zero hits).
- Header validation only checks **presence** of `x-arns-resolved-id` /
  `x-arns-ttl-seconds` — a CID passes untouched (`src/lib/arns-validation.ts`).
- Content assessment is **reference-trust-based**: exact-match of four properties
  (`resolvedId`, `ttlSeconds`, `contentType`, `dataHashDigest`) against a
  reference/consensus gateway; any mismatch fails the name
  (`src/observer.ts:1907-1920`).
- `dataHashDigest` = sha256 of the first 1 MiB, or 5×200-byte random ranges for
  content > 1 MiB (`getArnsResolution`, `src/observer.ts:116`).
- Names dimension passes at ≥ 80% (`NAME_PASS_THRESHOLD`, `src/observer.ts:2225`);
  composite gateway pass = `ownership AND names AND offsets`
  (`src/observer.ts:2233`); a gateway is failed on-chain if **> ½** of submitting
  observers fail it.

**Consequence:** a gateway with IPFS disabled routes an IPFS-target name down the
Arweave data path (`ar-io-node middleware/arns.ts`), can't retrieve it, and fails
the name. With the ≤ 2-name prescription cap and the 80% threshold, **one
prescribed IPFS name can fail every non-IPFS gateway in an epoch** and — via the
> ½ tally — zero out their rewards. This must be fixed before any IPFS-target
name lands on the production registry.

---

## 2. Two enabling facts (that shrink the work)

**2.1 Capability is already self-advertised, and the observer already reads it.**
The gateway returns `"ipfs": { enabled: true }` in `/ar-io/info` when
`IPFS_ENABLED` (verified live; `ar-io-node src/routes/ar-io.ts:225`). The observer
**already** GETs `https://{host}/ar-io/info` and parses that JSON in
`assessOwnership` (`src/observer.ts:262`, `client.get(url).json()`). So
capability-gating needs **no new request and no contract bit** — just read
`resp.ipfs?.enabled` from the response the observer already has.

**2.2 The gateway now exposes trustless retrieval (PR #793).** `?format=raw`
returns the raw block and `?format=car` returns a CAR, both with the client
expected to verify against the CID (`X-Ar-Io-Trustless: true`). The gateway also
emits `X-ArNS-Protocol: ipfs|arweave` on resolutions (verified live). These are
the primitives that let the observer verify IPFS bytes **trustlessly** (§4.3).

---

## 3. Design decisions

**D1 — IPFS is first-class; capability-gating is the rollout ramp.** IPFS-target
names are assessed as a normal, expected dimension — verified trustlessly (D2) and
counted toward rewards like any name (rewards are already content-agnostic, §2).
Capability-gating is the **adoption ramp**, not a permanent opt-out: while gateways
are still enabling IPFS, an IPFS name on a gateway that does not advertise
`ipfs.enabled` scores **neutral** (excluded from the names denominator) rather than
failing; the intended end-state is **IPFS expected of every gateway**. Flipping
"not-yet-enabled" from neutral to failing is a single policy flag — no contract
change, identical mechanism. *When the ramp ends is the one governance call (§8 Q1);
the code defaults safe during rollout so no gateway is wrongly failed mid-adoption.*

> **Enforcement caveat (important).** Neutral scoring is enforced at the
> **observer level**, not in the contract — the chain only receives a per-gateway
> pass/fail bitmap and tallies a **> ½-of-observers majority**; it has no concept
> of names, protocols, or "neutral" (this is *why* it needs no contract change,
> §2/D4). Consequently, neutral only actually protects a non-IPFS gateway once a
> **majority of the observer fleet runs this updated observer**. The > ½ majority
> rule is the backstop that makes the rollout safe even when uneven: a lagging
> minority still running the old protocol-blind code cannot fail a non-IPFS
> gateway on an IPFS name, because it is outvoted. The rollout task is therefore
> "ship the observer update and get it adopted by the observer majority" — a
> software release, **not** a contract deploy, and **no action is required from
> gateway operators** (not-running-IPFS is self-evident via `/ar-io/info`).

**D2 — Trustless verification for IPFS, replacing reference-digest trust.** For an
IPFS name the `resolvedId` **is** a content hash, so served bytes are verified
against the CID's multihash directly. The reference gateway is still used to
establish the **name→CID binding** (which CID the name should resolve to), but the
**bytes are self-verified**, not compared to reference bytes. This is strictly
stronger than today's Arweave ArNS check and removes, for IPFS names: the
colluding/buggy-reference risk, the mid-epoch reference-cache race, and the
observation-as-cache-warmer distortion.

**D3 — No range-sampling for IPFS.** The 5×200-byte range digest is meaningless
against a CID (a UnixFS root CID is the hash of the *root block*, not of the
reassembled file bytes). IPFS assessment uses block/CID verification (§4.3)
instead. (Range stays for the Arweave/proxy/media path.)

**D4 — Report stays content-agnostic on-chain.** `save_observations` submits only
a pass/fail bitmap + report tx-id, so enriching the JSON report with a `protocol`
field and IPFS verification detail requires **no contract change** — only a
`REPORT_FORMAT_VERSION` bump and tolerant report consumers.

---

## 4. The changes (sequenced)

### Phase 1 — Protocol awareness + capability ramp (the safety fix)

**Goal:** IPFS names can never wrongly fail a gateway; the report distinguishes
protocol. No verification-model change yet.

1. **Detect protocol.** In `getArnsResolution` capture `x-arns-protocol` (falls
   back to `arweave` when absent) onto `ArnsResolution`. Decode the CID from
   `x-arns-resolved-id` when protocol is `ipfs` (format-validate; a malformed CID
   is a *gateway* fault only if it diverges from the reference binding).
2. **Read gateway capability.** In `assessOwnership`, also read `resp.ipfs?.enabled`
   and thread a `supportsIpfs: boolean` into the gateway assessment context.
3. **Gate + neutral scoring.** In `assessArnsNames`, introduce a third outcome
   `neutral` alongside pass/fail. A name is neutral when: (a) its protocol is
   `ipfs` and the gateway doesn't advertise `ipfs.enabled` (D1), or (b) it is
   **unretrievable network-wide** — the reference/consensus resolution itself
   failed to retrieve (distinguish "gateway mis-serves" from "nobody has it").
   Compute `namesPass` as `passCount / (passCount + failCount)` — **neutral names
   leave the denominator** (`src/observer.ts:2225`).
4. **Report.** Add `protocol` to `ArnsNameAssessment` (`src/types.ts:148`) and a
   per-name `outcome: 'pass'|'fail'|'neutral'`; bump `REPORT_FORMAT_VERSION` 2 → 3.
5. **Timeouts.** Give IPFS names a longer per-request timeout (cold DHT retrieval);
   config `IPFS_ASSESSMENT_TIMEOUT_MS`.

*Contract impact: none. Ships independently and is the minimum safe change.*

### Phase 2 — Trustless CID verification (replaces reference-digest for IPFS)

**Goal:** verify served IPFS bytes against the CID, no reference bytes.

For an IPFS name whose binding (resolvedId) matches reference consensus:
- **Raw / single-block CID** (codec `raw` 0x55): fetch the content (or
  `?format=raw`), compute the CID's multihash function over the bytes, compare the
  digest to the multihash embedded in the CID. Pass iff equal.
- **UnixFS / dag-pb CID** (codec `dag-pb` 0x70): fetch the **root block** via
  `?format=raw`, hash it, compare to the CID's multihash — this proves the gateway
  serves the authentic root block. (Full-file assurance is Phase 3.)
- Use a `multiformats`-style CID decoder for codec + hash-fn + digest; support at
  least sha2-256. Unknown codec/hash → neutral (can't verify), logged.

The four-property comparison becomes protocol-branched: for IPFS, keep
`resolvedId` (binding, vs reference consensus) and `ttlSeconds`; **replace
`dataHashDigest`-vs-reference with CID self-verification**; `contentType` becomes
advisory (a trustless raw/CAR fetch has a fixed IPLD content type).

*Contract impact: none. Depends on PR #793's `?format=raw|car`.*

### Phase 3 — IPFS block sampling (the offset-check analog) — optional, staged

Mirror the Arweave offset check (`OFFSET_OBSERVATION_*`): for a UnixFS DAG, fetch
`?format=car` (or walk N random child blocks), verify each block's bytes against
its CID and the link structure back to the root. Staged behind
`IPFS_BLOCK_SAMPLING_*` config, enforcement off by default. Bounds cost while
raising assurance from "authentic root" to "authentic sampled sub-DAG."

*Contract impact: none.*

### Phase 4 — 451/blocklist policy — small

The observer special-cases 404 only. Divergent blocklists (target returns 451,
reference 200, or vice-versa) currently mismatch → fail. Treat a **matching** 451
as neutral, and a target-only 451 as a policy divergence (log, don't hard-fail on
content) — same spirit as the network-wide-unavailable neutrality.

---

## 5. Report compatibility

- `REPORT_FORMAT_VERSION` 2 → 3; new fields are **additive** (`protocol`,
  `outcome`, IPFS verification detail). Existing consumers that read the bitmap are
  unaffected (`save_observations` is content-agnostic — D4).
- Report-parsing consumers (dashboards, `pipeline-report-sink`, tests asserting
  `formatVersion: 2`) must be updated to tolerate v3. Enumerate and bump.
- Continuous observer (`src/continuous/continuous-observer.ts:824`) emits the same
  `REPORT_FORMAT_VERSION` — single constant, one bump.

---

## 6. Test plan

- **Unit:** protocol detection from `x-arns-protocol`; CID decode + raw-block and
  UnixFS-root verification (fixtures with known-good and tampered bytes); neutral
  scoring math (denominator excludes neutral); capability gate (IPFS name +
  non-IPFS gateway → neutral, not fail).
- **Integration:** against this branch's live gateway (`localhost:4000`) using the
  `atomic-uat-bf09a4b3` IPFS name and a direct `bafkrei…`/`bafybei…` CID — assert
  a correct gateway passes trustlessly and a byte-tampered proxy fails.
- **Regression:** Arweave-name assessment path unchanged (protocol `arweave`
  falls through to today's four-property comparison).

---

## 7. Contract boundary (out of scope — governance track)

These require Solana-program changes and are **not** part of the read-only phase:
- **Stratified prescription** (`ario-gar prescribe_epoch` reading
  `AntRecord.target_protocol`; enlarging the ≤ 2-name cap) — changes the zero-copy
  `Epoch` account layout; needs a migration.
- **Pinning / persistence incentive** — a genuinely new reward category (attested
  pinning, retrievability bonds, or ArNS-revenue-funded pinning subsidies). Current
  OIP can reward *serving* named IPFS data with zero contract change, but **cannot
  reward persistence** — no parameter tweak fixes that.

Everything in §4 (Phases 1–4) ships without touching these.

---

## 8. Open questions for the protocol team

1. **Adoption curve (when does the ramp end?).** Code treats IPFS as first-class
   with a neutral ramp for not-yet-enabled gateways (D1). The governance call is
   *when* the observer flips "not-yet-enabled" from neutral to failing — i.e. when
   IPFS support is expected of every gateway. One flag, no contract change.
2. **Persistence semantics.** ArNS historically implies Arweave permanence. Does a
   name → unpinned IPFS dilute the guarantee? Should `targetProtocol = 1`
   registration require a pinning commitment? (Drives whether Phase-3+ incentives
   are ever needed.)
3. **"Who holds the data?"** Is serving via Kubo's DHT fetch from a third party a
   pass, or must the gateway pin? The observer can't distinguish (`X-Cache` is
   self-asserted); trustless verification proves *correctness*, not *who persists*.
4. **Prescription capacity.** The ≤ 2-name cap makes per-protocol stratification
   statistically thin; enlarging it is the `Epoch`-layout migration in §7.

---

## 9. Provisioning & operating cost

**Verdict:** the observer changes are near-zero; the only real new cost is running
an IPFS node. First-class means that is **on by default** — but each gateway can
either run a bundled Kubo sidecar **or** point at a shared/third-party node, so
per-gateway cost is a deployment choice, not a fixed floor.

**Today vs. first-class default.** Currently `IPFS_ENABLED=false` and the `kubo`
service sits behind an opt-in compose profile. First-class = flip the shipped
default to IPFS-on. Both Kubo endpoints are plain env vars
(`IPFS_KUBO_URL` → gateway :8080, `IPFS_KUBO_API_URL` → RPC :5001), so the default
can be satisfied three ways:

| Mode | What runs | Per-gateway cost | Notes |
|---|---|---|---|
| **A — Bundled Kubo sidecar** (compose default) | Each gateway runs its own Kubo | +1 container (~0.5–2 GB RAM), ~10 GB cache disk, swarm port 4001, DHT bandwidth | Self-sufficient; no external dependency; can pin |
| **B1 — Shared self-hosted Kubo** | Many gateways → one Kubo you run | ≈ 0 per gateway; cost centralizes on one node | A node to scale/secure; pinning available (you control the RPC) |
| **B2 — Third-party IPFS gateway (reads)** | `IPFS_KUBO_URL` → a provider / public trustless gateway | ≈ 0 infra | Provider dependency; no pinning (RPC :5001 is privileged, not exposed) |

Trustless verification is client-side (the client checks bytes against the CID via
`?format=raw`), so it is unaffected by *where* Kubo runs — mode B doesn't weaken
the trust story.

**Component cost (mode A, the heaviest):**
- **Container** `ipfs/kubo v0.32.1`, co-located — no new host. RAM ~0.5–2 GB, modest
  CPU (spikes on GC / DHT provides).
- **Disk** is bounded: 10 GB read cache (`IPFS_CACHE_MAX_SIZE_BYTES`, LRU) + Kubo
  datastore; `--enable-gc` prevents unpinned growth. Pinning is **off by default**;
  if enabled it's capped at 10,000 CIDs (`IPFS_PIN_MAX`) × content size.
- **Bandwidth** is the only always-on new cost, in two parts: (a) serving content
  (demand-driven, cache-absorbed) and (b) DHT participation. The compose default
  `IPFS_PROFILE=server` makes Kubo a DHT server (background traffic even at idle);
  `dhtclient` / `lowpower` cuts it to near-nothing. The idle floor is a dial.
- **No SaaS / per-GB fees** — self-hosted.

**Observer side:** no new infrastructure; request *count* is unchanged (IPFS names
are already sampled today). Trustless verification fetches the raw **root block**
(often *fewer* bytes than today's 1 MiB digest sample); block sampling is off by
default. Net: a rounding error per gateway per epoch.

**The real future cost lever — persistence.** Pinning named content fleet-wide so
it can't vanish is where recurring storage cost would live. That is deferred
(pinning off by default, capped) and is a separate governance/incentive decision —
not part of first-class *serving* and *verification*.
