# Chunk Fan-out Seeding (fault-domain aware)

Operator guide for the fault-domain-aware chunk fan-out: what it does, how to
enable and manage it safely, what to watch, and — most importantly — **why it
cannot lose data**.

> **TL;DR for operators:** Both flags default OFF, and with them off this release
> is byte-identical to the previous one (regression-tested + live-soaked). The
> flags only change *when a chunk POST is reported successful* and *how widely it
> fans out* — they never store or delete data. Turning them on is safe when your
> uploader re-verifies permanence (Turbo does). To roll back: set the flags to
> their defaults and recreate `core`.

## 1. What this is

When an uploader (the Turbo bundler) posts a chunk to this gateway
(`POST /chunk`), the gateway **fans it out** to multiple Arweave peers so the
chunk spreads through the network toward miners. This feature makes that fan-out
**fault-domain aware**:

- Peers are bucketed by **fault domain** — IP `/24` (IPv4) / `/48` (IPv6), a
  proxy for "independent operator / network block".
- The gateway can require/measure landings across **distinct** fault domains,
  not just a raw count of `200`s.
- It fixes a **single-point-of-failure**: the five preferred "tip" nodes
  (`tip-1..5.arweave.xyz`) all live in one `/24` (`38.29.227.0/24`), and the
  default quorum hard-required 2 tip successes — so a tip outage would fail every
  chunk POST even when many independent peers accepted the chunk.

The gateway is a **seeding *target/relay***, not the durability owner. Durability
(the guarantee that data permanently lands on-chain) is owned by the **uploader**,
which re-verifies permanence across multiple gateways and re-seeds anything that
doesn't confirm. Keep that layering in mind — it is why this change is safe.

## 2. Data safety — why this cannot lose data

This is the important part. There are three independent reasons a chunk cannot be
lost by this change:

1. **Default-off is a no-op.** With `CHUNK_POST_MIN_DISTINCT_DOMAINS=0` and
   `CHUNK_POST_PREFERRED_SOFT_FALLBACK=false` (the defaults), the quorum and
   fan-out are **byte-identical** to the previous release. A regression test pins
   this, and it was verified in a live production soak. Doing nothing changes
   nothing.

2. **The gateway never holds the only copy.** `broadcastChunk` *relays* a chunk
   to Arweave peers. It does not store the sole copy, and these flags do not touch
   the gateway's local chunk cache (the separate, unchanged optimistic ingest
   cache). Nothing here deletes or drops data.

3. **The uploader owns durability and re-verifies.** A chunk-POST result is
   *advisory to the uploader*, not the final word on durability. Turbo
   independently checks permanence across multiple gateways and **re-seeds
   (redrive → repack → re-post)** anything that doesn't reach permanence. So even
   if a gateway *reported* success on peers that turned out not to propagate, the
   uploader re-checks and re-seeds — no data is lost.

### Per-flag safety

- **`CHUNK_POST_MIN_DISTINCT_DOMAINS`** — cannot lose data in either direction.
  It is **best-effort**: it never fails a POST (so no false-failures) and never
  gates success (so no false-successes). It only drives fan-out breadth and emits
  a metric. Worst case: extra outbound bandwidth. It also cannot cause
  under-seeding — early termination only fires once the base quorum is already
  met.

- **`CHUNK_POST_PREFERRED_SOFT_FALLBACK`** — the only flag that changes *when a
  POST is reported successful*. It lets a POST succeed on a strong distinct-domain
  quorum of discovered peers when the tips fall short. This is safe **for a
  re-verifying uploader** (Turbo): the gateway's `200` is advisory, and Turbo
  confirms permanence independently and re-seeds if needed. Note the strict 2-tip
  quorum was *also* never a durability guarantee (tips can fail to propagate too);
  this flag only changes the *composition* of the reported quorum, not whether the
  uploader re-verifies.

  > **Operational precondition (read this):** the fallback trades a stricter
  > success signal for availability. It is safe when the uploader re-verifies
  > permanence and re-seeds — which **Turbo does**. If this gateway fronts a
  > *naive* uploader that treats a `200` as final and never re-checks, then in a
  > pathological case (tips down **and** every discovered peer accepts-but-doesn't-
  > propagate) a chunk could be reported seeded but not reach miners. For gateways
  > serving arbitrary/naive uploaders, **leave this OFF**. For a Turbo-fronting
  > gateway, it is safe to enable.

## 3. The flags

| Env var | Default | Effect |
|---|---|---|
| `CHUNK_POST_MIN_DISTINCT_DOMAINS` | `0` (off) | Best-effort diversity target (distinct `/24`·`/48` domains). Drives fan-out breadth + a `below_target` metric; **never fails a POST**. Rejects non-integer / negative values at startup. |
| `CHUNK_POST_PREFERRED_SOFT_FALLBACK` | `false` | When on, a POST meets quorum via a strong distinct-domain discovered quorum whenever the preferred (tip) quorum falls short — removing the tip-`/24` SPOF. **Softens the tip requirement in steady state too** (see §5). |

Related existing knobs (unchanged): `CHUNK_POST_MIN_SUCCESS_COUNT` (3),
`CHUNK_POST_MIN_PREFERRED_SUCCESS_COUNT` (2), `CHUNK_POST_PEER_CONCURRENCY`,
`CHUNK_POST_ABORT_TIMEOUT_MS` (per-peer, default 2 s),
`CHUNK_POST_RESPONSE_TIMEOUT_MS` (per-peer, default 5 s). See `docs/envs.md`.

> Config is read at startup from `.env`. Changing a flag requires recreating the
> `core` container for it to take effect.

## 4. Recommended rollout (staged, safe)

1. **Deploy with flags OFF.** Zero behavior change — but the metrics, the
   `X-AR-IO-Chunk-Placement-Domains` response header, and the Grafana "Chunk
   Fan-out Seeding" dashboard row **populate immediately**. Use this to learn your
   baseline placement diversity (watch the `distinct_domains` p10 — a low p10
   means chunks are landing on few independent operators today). This step is
   pure observability and carries no risk.
2. **Enable `CHUNK_POST_PREFERRED_SOFT_FALLBACK=true`** (recreate `core`). This
   removes the tip-`/24` SPOF: a tip outage no longer fails chunk POSTs. Confirm
   the precondition in §2 first (your uploader re-verifies — Turbo does).
3. **(Optional) Raise `CHUNK_POST_MIN_DISTINCT_DOMAINS`** (e.g. to `2` or `3`) to
   push the fan-out toward more independent operators. This is best-effort (never
   fails a POST) but **costs outbound bandwidth** — the fan-out keeps contacting
   peers to chase the target. On *fresh* chunks it is largely bounded by the
   preferred set anyway (discovered peers reject an unknown `data_root` until the
   tx propagates); broader diversity accrues over the seeding **lifecycle**
   (re-posts as the tx propagates), not on a single POST.

## 5. Behavior change to understand (steady state)

With `CHUNK_POST_PREFERRED_SOFT_FALLBACK=true`, the effective success quorum
becomes:

> **`MIN_PREFERRED_SUCCESS_COUNT` tip successes  OR  `MIN_SUCCESS_COUNT` total
> successes across ≥ `max(MIN_PREFERRED_SUCCESS_COUNT, MIN_DISTINCT_DOMAINS)`
> distinct fault domains.**

This applies **in steady state, not only during a full outage** — a normal POST
where only one tip acks but several independent discovered peers land will now
pass, where the strict path would have failed. This is the intended availability
win, but it means **the unconditional "2 tip successes" guarantee no longer holds
when the flag is on.** `chunk_post_preferred_shortfall_total` stays emitted so tip
shortfalls remain visible even when the fallback carries the POST.

## 6. What to monitor

Grafana ships a **"Chunk Fan-out Seeding"** row (auto-provisioned). Key signals:

| Metric | What it tells you |
|---|---|
| `chunk_post_distinct_domains` (avg / p50 / **p10**) | How many independent operators each chunk reaches. p10 is the exposure tail. |
| `chunk_post_preferred_shortfall_total{reason}` | Tip health / when the fallback engages. `tips_unavailable` = tips ineligible; `tips_failed` = tips reachable but didn't ack. Emitted even when the fallback carries the POST — a rising rate is a tip-health signal, not a failure. |
| `chunk_post_domain_shortfall_total{reason=below_target}` | Advisory: POSTs landing on fewer domains than `MIN_DISTINCT_DOMAINS`. Never a failure. |
| `arweave_chunk_broadcast_total{status}` | Overall POST success/fail rate. This should **not drop** after enabling either flag (see §7). |

## 7. Troubleshooting / unintended-behavior checks

- **Chunk POST success rate drops after enabling a flag** → unexpected, investigate.
  Neither flag should *reduce* success: `SOFT_FALLBACK` only relaxes the quorum
  (never tightens), and `MIN_DISTINCT_DOMAINS` is best-effort (never fails a POST).
  A drop means something else is wrong — check upstream peer health and the
  `arweave_chunk_broadcast_total{status="fail"}` breakdown.
- **`chunk_post_domain_shortfall_total{below_target}` floods after raising
  `MIN_DISTINCT_DOMAINS`** → your reachable peer set can't supply that many
  distinct domains on fresh chunks (the propagation race). It's advisory, not a
  failure; lower the target if the extra fan-out isn't worth it.
- **Egress / event-loop latency rises after raising `MIN_DISTINCT_DOMAINS`** →
  expected: the breadth-seeking contacts more peers. Tune the target down.
- **A tip outage no longer shows as POST failures** (with `SOFT_FALLBACK=true`) →
  intended. Confirm the fallback is carrying it via
  `chunk_post_preferred_shortfall_total{reason=tips_unavailable|tips_failed}`
  rising while success rate holds.

## 8. Rollback

Set both flags to their defaults and recreate `core`:

```
CHUNK_POST_MIN_DISTINCT_DOMAINS=0
CHUNK_POST_PREFERRED_SOFT_FALLBACK=false
```

This reverts to the exact legacy fan-out behavior immediately on the next config
load. There is no persistent state to unwind and no data implication — the flags
only affect in-flight fan-out decisions, not stored data.

## 9. What this change does NOT touch

For reassurance, the following are unaffected:

- The **optimistic ingest cache** (the gateway's local chunk storage) — unchanged.
- **Data retrieval / serving** — unchanged.
- **Default behavior** — with flags off, identical to the previous release.

## See also

- `docs/envs.md` — full env-var reference (the `CHUNK_POST_*` block).
- `docs/chunk-ingest-cache.md` — the separate local chunk cache.
- `docs/glossary.md` — *fault domain*, *tip node*, *chunk fan-out*.
