/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Keyed uniform draws, shared by every index verifier that samples: the
 * L2 on-chain check (`index-l2-verify --onchain`) and the L1 header and
 * signature samples (`index-l1-verify`).
 *
 * A draw is ordered by SHA-256 of a key the publisher cannot know, so
 * every row is equally likely and the draws are independent of anything
 * about the rows. (DuckDB's `hash(row, seed)` is `g(row) XOR k(seed)`,
 * which a publisher can steer, and its `reservoir(n) REPEATABLE` drew only
 * from about the first 82,000 rows of a band.)
 */
import crypto from 'node:crypto';

/**
 * The key of one band's draw (a stratum of it: 0 for the uniform draw, 1 for
 * the nested top-up): sha256(`<run seed>|<band id>|<stratum>`) as 64
 * lowercase hex digits, so every band's draw is its own and no band's can be
 * steered by choosing its place or its neighbours.
 */
export function drawSeed(
  seed: number,
  bandId: string,
  stratum: number,
): string {
  return crypto
    .createHash('sha256')
    .update(`${seed}|${bandId}|${stratum}`)
    .digest('hex');
}

/**
 * The smallest share p of fabricated located items at which a band of `n`
 * drawn entries, up to `k` of them allowed unchecked, passes at most
 * `1 - confidence` of the time. A fabricated item behind data nobody can
 * read comes back unchecked, not wrong, so the band passes when at most k
 * drawn items are fabricated: P(Bin(n, p) <= k) = sum over i <= k of
 * C(n, i) p^i (1 - p)^(n - i). For k = 0 that is (1 - p)^n, so
 * p = 1 - (1 - confidence)^(1/n): 20 drawn, 14%. Otherwise found by
 * bisection (the probability falls as p rises). 1 when nothing is bounded
 * (k >= n).
 */
export function detectableFraction(
  n: number,
  confidence = 0.95,
  k = 0,
): number {
  if (n <= 0 || k >= n) return 1;
  if (k <= 0) return 1 - (1 - confidence) ** (1 / n);
  const passes = (p: number) => {
    let term = (1 - p) ** n; // i = 0
    let sum = term;
    for (let i = 1; i <= k; i += 1) {
      term *= ((n - i + 1) / i) * (p / (1 - p));
      sum += term;
    }
    return sum;
  };
  let lo = 0;
  let hi = 1;
  for (let step = 0; step < 60; step += 1) {
    const mid = (lo + hi) / 2;
    if (passes(mid) <= 1 - confidence) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** A seeded PRNG (mulberry32) giving numbers in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The `n` items of `items` with the smallest SHA-256 of `<key>:<label>`
 * (lowercase hex key, the item's label in decimal or as given), ties by
 * position: a keyed uniform draw over a list held in memory, repeatable
 * from the key.
 */
export function drawByKey<T>(
  items: Iterable<T>,
  n: number,
  key: string,
  label: (item: T) => string,
): T[] {
  if (n <= 0) return [];
  const ranked: Array<{ rank: Buffer; i: number; item: T }> = [];
  let i = 0;
  for (const item of items) {
    const rank = crypto
      .createHash('sha256')
      .update(`${key}:${label(item)}`)
      .digest();
    ranked.push({ rank, i, item });
    i += 1;
    // Keep the list short: once it is well past n, drop the largest.
    if (ranked.length >= n * 4 + 1024) {
      ranked.sort((a, b) => Buffer.compare(a.rank, b.rank) || a.i - b.i);
      ranked.length = n;
    }
  }
  ranked.sort((a, b) => Buffer.compare(a.rank, b.rank) || a.i - b.i);
  return ranked.slice(0, n).map((r) => r.item);
}
