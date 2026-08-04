# AR.IO Observation & Incentive Protocol vs. Named IPFS Data — Gap Analysis

> Research deliverable (Fable agent), for protocol-design review. Not code docs.
> Sources accessed and verified (none guessed):
> - Observer: `/programs/ar-io-observer` (Solana-adapted fork, branch
>   `chore/remove-aws-observer-deploy`, running as `ar-io-node-observer-1`)
> - Contracts: `github.com/ar-io/ar-io-solana-contracts` @ `a8ef07e`
> - Gateway: `/programs/ar-io-node/wt/ipfs-sync-793` (this IPFS branch)
> - Docs: `/programs/ar-io-docs/content/learn/oip/*.mdx`
> - SDK: `/programs/ar-io-sdk/src`; live gateway at `localhost:4000`

> **Reconciliation update (2026-08-04).** This report's findings were verified
> line-by-line against live source and carried into the implementation plan in
> `observer-ipfs-adjustments-spec.md`. Two points evolved with the decision to make
> **IPFS a first-class citizen with zero smart-contract changes**:
> 1. **No on-chain capability bit is needed.** §3(d)/§4.1 float a `GatewaySettings`
>    "supports IPFS" bit. Superseded: the gateway already self-advertises
>    `ipfs.enabled` in `/ar-io/info`, and the observer already reads that exact
>    response in `assessOwnership` (`observer.ts:262`). Capability-gating is
>    therefore observer-only (~5 lines), no contract change.
> 2. **Framing is first-class, not "mandatory-vs-optional."** The §4 MUST #1
>    decision is reframed as an *adoption ramp*: IPFS names are verified as a
>    normal, expected dimension; names on a not-yet-enabled gateway score *neutral*
>    during rollout, converging to "IPFS expected of every gateway." Because
>    prescription and reward accounting are already content-agnostic (§1, §2c), this
>    needs no contract change.
>
> The report body below is preserved as the original research deliverable.

---

## 1. How observation works today

### Observer-side (per epoch, per registered gateway)

`ar-io-observer/src/observer.ts` runs three assessment dimensions; the composite
pass is `ownership AND names AND offsets` (`observer.ts:2233`):

**a) Ownership** — `assessOwnership` (`observer.ts:262`): GET
`https://{host}/ar-io/info`, compare reported `wallet` to the registered wallet.

**b) ArNS name resolution** — two name groups:
- **Prescribed names**: on-chain `Epoch.prescribed_names` via
  `SolanaARIOReadable.getPrescribedNames` (`src/names/solana-names-source.ts:53`).
  Contract prescribes **≤2 names/epoch** (hard cap `[[u8;32]; 2]`,
  `ario-gar/src/instructions/epoch.rs:831`), selected by hashchain entropy +
  linear probing over the ArNS `NameRegistry`.
- **Chosen names**: **8 per group** (`NUM_ARNS_NAMES_TO_OBSERVE_PER_GROUP`,
  `config.ts:110`), sampled from the full registry using epoch entropy
  (`src/names/random-arns-names-source.ts:40-67`).

For each name the observer:
1. Gets a **reference resolution** from trusted reference gateways (default
   `turbo-gateway.com`, `ar-io.net`; `config.ts:76`) or a **network consensus
   resolver** (`src/reference/arns-consensus-resolver.ts`: query N gateways,
   group by `resolvedId`, require `consensusThreshold`). Cached per epoch.
2. Fetches `https://{name}.{host}/` via `getArnsResolution` (`observer.ts:116`):
   HEAD first; then **sha256 of the first 1 MiB** for content ≤1 MiB (or unknown
   length), or **5 entropy-seeded 200-byte Range requests** for content >1 MiB.
3. Compares four properties vs. reference: `resolvedId` (`x-arns-resolved-id`),
   `ttlSeconds`, `contentType`, `dataHashDigest` (`observer.ts:1907-1920`).
   Header validation (`src/lib/arns-validation.ts`) does **not** enforce any ID
   format — a CID in `x-arns-resolved-id` passes through untouched.
4. Names dimension passes if **≥80%** of names pass (`NAME_PASS_THRESHOLD=0.8`,
   `observer.ts:63`). Continuous observer: 3 cycles/gateway, majority vote.

**c) Offset/chunk sampling** (Arweave-specific, enforced by default):
`validateChunkAtOffset` GETs `/chunk/{offset}` and **verifies the Merkle
`data_path` against the tx `data_root`** resolved from chain
(`observer.ts:951-985,1194-1390`). `OFFSET_OBSERVATION_ENABLED=true`, rate 0.20,
4 offsets, enforcement on.

**Is Arweave verification assumed?** Split:
- The **ArNS serving check is content-agnostic, trust-based** (sampled-digest vs.
  reference/consensus). No `data_root`/tx proof.
- The **chunk/offset check is trustlessly Arweave-anchored** (`data_root` Merkle
  proofs) and has **no IPFS analog**.

### Reporting & contract accounting

Full JSON report → Arweave via Turbo, then **`save_observations`** on-chain
(`ario-gar/src/instructions/observation.rs:8`): `gateway_results: [u8; 375]`
(1 bit/gateway pass/fail) + `report_tx_id: [u8; 32]`. Epoch pipeline
(permissionless crank): `create_epoch → tally_weights → prescribe_epoch →
save_observations → distribute_epoch → close_epoch`. Duration 24h; reward pool =
protocol balance ×0.1%; split **90% gateways / 10% observers**; a gateway is
**failed if >½ of submitting observers** mark it failed (`distribution.rs:184`).

**Critical structural fact**: the reward machinery is **entirely
content-agnostic** — nothing in `ario-gar`/`ario-arns` knows what a name points
to. The pointer lives in the ANT program: `AntRecord.target` +
**`target_protocol: u8` (0=Arweave, 1=IPFS)**, with `is_valid_ipfs_cid` already
on-chain (`ario-ant/src/state.rs:150-152,447,574-592`). Name prescription is
**protocol-blind** — IPFS-target names can already be prescribed/chosen today.

---

## 2. Where IPFS breaks or is unaddressed

1. **Accidental, un-adjudicated inclusion.** IPFS-target names already flow into
   sampling. A gateway *without* IPFS enabled sends the CID down the Arweave data
   path (`middleware/arns.ts:206`), which can't retrieve it → failure. With the
   2-name prescription cap and 80% pass threshold, **one prescribed IPFS name
   could fail every non-IPFS gateway in an epoch.** Nothing says IPFS serving is
   mandatory.
2. **Verification model mismatch.** The observer's ArNS check is
   reference-trust-based digest comparison; it ignores that **the CID is itself a
   verifiable content hash.** A colluding/buggy reference set could bless wrong
   bytes. The trustless dimension the protocol *does* have (chunk proofs) has no
   IPFS counterpart.
3. **Range-request degradation.** For >1 MiB the observer issues 5 ranged GETs;
   the IPFS route ignored Range and returned full bodies → 5× full downloads per
   name/gateway/cycle, and version skew produces digest mismatches → false fails.
   *(Fixed in this branch: Range/206 now supported.)*
4. **Availability/pinning risk.** No pinning anywhere; Kubo runs `--enable-gc`,
   so unpinned content vanishes. Failure modes the protocol can't express:
   content unpinned network-wide → reference 404s while gateways *holding* a
   pinned copy get *failed* on mismatch (perverse); cold-DHT retrieval exceeds
   observer timeouts non-deterministically; observation itself re-warms caches,
   masking gateways that never pin.
5. **Mutable name→CID binding.** Per-epoch reference-resolution cache races with
   mid-epoch record updates; IPFS update cadence is expected to be higher.
6. **No caching/pinning incentive anywhere.** `distribute_epoch` rewards
   pass/fail resolution only. No instruction/account/weight rewards pinning,
   persistence, or cache-hit serving. `X-Cache` is gateway-asserted, unusable as
   signal.
7. **451/blocklist interplay.** The observer only special-cases 404; divergent
   blocklists (451) between reference and target yield mismatch failures.

---

## 3. Contract / observer gaps by requirement

**(a) Observe IPFS-named resolution correctly** — observer-only:
capture `x-arns-protocol` on `ArnsNameAssessment`; branch `getArnsResolution` on
protocol (no Range sampling until byte-verify lands, longer timeouts, CID-format
validation); key consensus on `(resolvedId, protocol)`.

**(b) Verify served IPFS bytes** — observer-only, *stronger than today*: verify
the multihash — hash the body for single-block/raw CIDs; fetch a random block (or
`?format=car`) for UnixFS DAGs. Trustless, no reference gateway; the IPFS analog
of chunk `data_root` validation.

**(c) Reward resolving/caching/serving named IPFS data** — mostly **no contract
change**: the bitmap, >½ threshold, and `distribute_epoch` are content-agnostic;
if "IPFS names count like any name," rewards flow with zero contract changes. To
*deliberately* cover IPFS, `prescribe_epoch` would read `AntRecord.target_protocol`
and stratify; the 2-name cap likely enlarged. Rewarding *pinning/caching* is
genuinely new accounting.

**(d) Availability/pinning risk** — observer policy (+ optional contract flag):
"network-wide unavailable" → **neutral** (excluded from the 80% denominator), not
failure. A `GatewaySettings` "supports IPFS" bit would let observers skip IPFS
names for non-supporting gateways if IPFS stays optional.

---

## 4. Recommended adjustments, ranked

**MUST (before any IPFS-target name lands on this registry):**
1. **Decide mandatory-vs-optional.** Either IPFS serving is required (document it;
   observers fail non-supporters) or add an IPFS-capability bit to
   `GatewaySettings` and make the observer skip IPFS-protocol names for gateways
   without it. Otherwise one prescribed IPFS name can zero out gateway rewards
   network-wide via the >½ tally.
2. **Protocol-aware observer assessment**: read `x-arns-protocol`; for `ipfs`
   disable Range sampling (until (5)), extend timeout, add `protocol` to the
   report (bump `formatVersion`).
3. **Neutral scoring for network-wide unavailability**: exclude un-retrievable
   names from the denominator; fail only gateways that mis-serve vs. serving peers.

**SHOULD:**
4. **Trustless CID verification** (raw-block or CAR multihash) replacing
   reference-digest trust for IPFS names.
5. **IPFS block-sampling assessment** as the analog of chunk/offset validation,
   staged behind config like `OFFSET_OBSERVATION_*`.
6. **Range support in `routes/ipfs.ts`** — *done in this branch.*
7. **Stratified prescription**: teach `prescribe_epoch` to read
   `target_protocol`; enlarge the 2-name cap.
8. **451/blocklist policy** for the observer (treat matching 451s as neutral).

**NO CHANGE NEEDED:** `save_observations` bitmap + `report_tx_id`, failure
threshold, `distribute_epoch` formula, weight computation, delegate accumulator;
`ario-ant` (`target_protocol` + `is_valid_ipfs_cid` already model it); `ario-arns`
registry; observer header validation (already tolerates CIDs).

**Explicitly new design work (only if the network wants it):** a pinning/caching
incentive is *not a change to OIP* — it is a new reward category (attested
pinning, retrievability bonds, or protocol-funded pinning subsidies from ArNS
revenue). Current OIP can incentivize *serving* named IPFS data; it cannot
incentivize *persistence*, and no parameter tweak fixes that.

## 5. Open questions / risks for the protocol team

- **Persistence guarantee**: ArNS historically implies permanence (Arweave). Does
  a name → unpinned IPFS dilute the value proposition? Should `targetProtocol=1`
  registration/renewal require a pinning commitment?
- **Who must hold the data?** Is serving via Kubo's DHT fetch from a third party
  "passing," or must the gateway pin? The observer can't distinguish (X-Cache is
  self-asserted); rewarding "serving" may reward whoever fronts someone else's pin.
- **Observation as cache-warmer**: repeated observer fetches keep content hot;
  pass rates overstate real availability.
- **Determinism across observers**: cold-content latency makes pass/fail
  observer-order-dependent; borderline content could flap gateways across epochs.
- **Verification cost ceiling**: full DAG verification is expensive; block
  sampling bounds cost but weakens the guarantee.
- **Mid-epoch record churn**: per-epoch reference cache races with mutable
  name→CID updates; consider re-resolving on mismatch before failing.
- **Prescription capacity**: the on-chain 2-name cap makes per-protocol
  stratification statistically thin; enlarging it changes the `Epoch` account
  layout (zero-copy) — plan a migration.
