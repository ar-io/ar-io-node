# PE-9120 — Address-keyed owner-key cache (+ in-flight coalescer)

**Branch:** `PE-9120-owner-key-address-cache` (off `PE-9118`)
**Status:** spec / scoping — no implementation yet
**Goal:** make bulk `owner.key` GraphQL resolution serve from one fetch **per unique owner** instead of one fetch **per data item**.

---

## Problem

GraphQL `owner.key` on a data item is resolved by fetching the owner public-key
bytes from the parent bundle (`OwnerFetcher.getDataItemOwner` →
`fetchDataFromParent` → data-source cascade). The cache in front of it
(`ownerStore`, a `KvB64UrlStore` over Redis, 4h TTL) is **keyed by data-item
`id`**:

```ts
// src/data/attribute-fetchers.ts  (getDataItemOwner)
const owner = await this.ownerStore.get(id);   // ~619
...
await this.ownerStore.set(id, owner);          // ~682
```

So every data item is a unique key → **zero cross-item reuse**. A `transactions`
page selecting `owner { key }` for 100 items by a handful of owners still does
~100 fetches. Observed: ~8.4s/page on the gateway vs Goldsky's ~0.6s (Goldsky
stores the key inline). The indexers themselves are fast (~46ms); the cost is
entirely the gateway's per-item owner-key resolution.

## Key insight (why address-keying is valid)

For Arweave, `owner_address = sha256(owner_public_key)`. The hash is
deterministic and collision-resistant, so:

- **All data items with the same `owner_address` have the same `owner.key`.**
- `owner_address` is **already inline** (stored column; `resolveTxOwnerAddress`
  returns `tx.ownerAddress` with no fetch).

Therefore the owner-key value can be cached **by address**: given an address,
the key is well-defined, and the address is free to obtain. This collapses N
per-item fetches to **U unique owners** for any query spanning many items by few
owners (e.g. the AR-IO-Solana-Registration attestation scan).

> Applies to **owner only**. Signatures are genuinely per-item (each data item
> has a distinct signature), so `signatureStore` must stay id-keyed — this trick
> does not transfer to `signature`.

---

## Design

### 1. Cache key: address, not id

`getDataItemOwner` should look up / store the owner key by `ownerAddress`. The
caller already has it:

```ts
// src/routes/graphql/resolvers.ts  (fetchTxOwnerKey)
//   tx.ownerAddress is inline/cheap — thread it down
return ownerFetcher.getDataItemOwner({
  id: tx.id,
  parentId: tx.parentId,
  ownerSize, ownerOffset,
  ownerAddress: tx.ownerAddress,   // NEW
  signal,
}) ?? NOT_FOUND;                    // (PE-9118 sentinel already in place)
```

`getDataItemOwner`:
1. If `ownerAddress` present → `ownerStore.get(ownerAddress)`; hit → return.
2. (fallback) legacy `ownerStore.get(id)` for warm id-keyed entries — optional,
   see Migration.
3. Miss → existing fetch from parent bundle.
4. On success → `ownerStore.set(ownerAddress, owner)` (and optionally also `id`
   during transition).

### 2. In-flight coalescer (address-keyed)

The cache alone fixes reuse **across pages** but not **within** a page: a single
page resolves all 100 `owner.key` fields concurrently, so the first page fires
~U–100 concurrent misses before anything is cached (the existing
`parent.keyPromise` memoization in `resolveTxOwnerKey` is **per data-item
node**, not per address).

Add an **address-keyed pending-promise map** in `OwnerFetcher`:

```ts
private inFlight = new Map<string, Promise<string | undefined>>();
// in getDataItemOwner, after cache miss:
const existing = this.inFlight.get(ownerAddress);
if (existing) return existing;
const p = this.fetchAndCache(...).finally(() => this.inFlight.delete(ownerAddress));
this.inFlight.set(ownerAddress, p);
return p;
```

So 100 concurrent items by one owner → **1** in-flight fetch, the other 99 await
it. This is the piece that makes the *first* page fast, not just subsequent ones.

---

## Implementation plan (files)

| file | change |
|---|---|
| `src/data/attribute-fetchers.ts` | `getDataItemOwner`: accept `ownerAddress`; address-keyed get/set; address-keyed in-flight coalescer (`Map`). Keep the incomplete-root-atom guard and PE-9098 span. |
| `src/routes/graphql/resolvers.ts` | `fetchTxOwnerKey`: pass `tx.ownerAddress` to `getDataItemOwner`. (Sentinel coercion already landed in PE-9118.) |
| `src/types.d.ts` / interfaces | extend `OwnerSource.getDataItemOwner` arg with optional `ownerAddress`. |
| `src/system.ts` | no wiring change (same `ownerStore`). |
| `src/routes/ar-io.ts` (admin `queue-data-item`) | Migration consideration — see below. |
| tests | `attribute-fetchers` unit tests: address hit, address miss→fetch→cache-by-address, coalescer (N concurrent → 1 fetch), id-fallback (if kept). |

`getTransactionOwner` (L1 owners) is also per-owner-address and could adopt the
same address-keying later — out of scope for the first cut, but the coalescer
infra is reusable.

---

## Caveats / decisions to make

1. **Admin path consistency.** Turbo's `queue-data-item` route does
   `ownerStore.set(dataItemHeader.id, owner)` (id-keyed). Options:
   - (a) also `set(ownerAddress, owner)` there (dual-write) — keeps Turbo's warm
     cache useful to the new read path; **recommended**.
   - (b) leave it; the new read path just misses on Turbo-posted items and
     re-fetches once per address.
2. **Backward compatibility.** Existing id-keyed Redis entries become dead
   weight (4h TTL clears them). Optional id-fallback read (step 2 above) avoids a
   cold start; can be dropped after one TTL window.
3. **TTL.** Still 4h Redis (`CHAIN_CACHE_TYPE=redis`). Address-keying multiplies
   the *value* of each entry (shared across items), so a longer TTL or a
   persistent backend (`lmdb`) becomes more attractive — separate decision, not
   required for this change.
4. **Memory.** The in-flight `Map` is bounded by concurrent unique owners in
   flight; entries delete on settle. No unbounded growth.
5. **Correctness of `ownerAddress` provenance.** It must be the address derived
   from *this item's* owner. It comes from the same GQL row as the offsets, so
   it's consistent. (We are not trusting a client-supplied address.)
6. **Negative results.** Keep returning `undefined` on genuine miss/abort (→
   PE-9118 `NOT_FOUND` sentinel at the resolver). Do **not** cache `undefined`
   under the address (would poison all of that owner's items) — only cache
   successful key bytes. (We deprioritized negative caching generally; this is
   consistent with that.)

---

## Expected impact

For a query over M items spanning U unique owners: fetches drop from ~M to ~U.
Attestation scan (finite registrant set) → likely 10–100× fewer owner fetches →
turbo page latency from ~8.4s toward Goldsky's ~0.6s. No effect on queries that
don't select `owner { key }` (those are already inline/fast).

## Testing

- Unit (no `system.js` boot — inject a mock `ownerStore` + `dataSource` into
  `OwnerFetcher` directly): address hit returns without fetch; concurrent N-by-1
  owner → exactly 1 `dataSource.getData`; distinct owners → N fetches; miss
  returns `undefined`; (optional) id-fallback hit.
- Manual: re-run the attestation script against a canary and compare page times
  to Goldsky.

## Open questions

1. Dual-write the admin path (1a) now, or accept one-fetch-per-address warmup?
2. Keep the id-fallback read for one TTL window, or hard-cut to address-only?
3. Bump owner TTL / move owners to `lmdb` for persistence (separate PE)?
4. Apply the same to `getTransactionOwner` (L1) in this PR or a follow-up?
