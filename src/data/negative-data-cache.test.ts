/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import { NegativeDataCache } from './negative-data-cache.js';
import { createTestLogger } from '../../test/test-logger.js';
import * as metrics from '../metrics.js';

const log = createTestLogger({ suite: 'NegativeDataCache' });

describe('NegativeDataCache', () => {
  let currentTime: number;
  const now = () => currentTime;

  const createCache = (overrides: Record<string, any> = {}) =>
    new NegativeDataCache({
      log,
      enabled: true,
      maxSize: 1000,
      ttlMs: 60_000,
      missCountThreshold: 3,
      missDurationMs: 10_000,
      now,
      ...overrides,
    });

  beforeEach(() => {
    currentTime = 0;
  });

  it('returns false for unknown ID', () => {
    const cache = createCache();
    assert.equal(cache.isNegativelyCached('unknown-id'), false);
  });

  it('does not promote below count threshold', () => {
    const cache = createCache();
    currentTime = 0;
    cache.recordMiss('id1');
    currentTime = 15_000;
    cache.recordMiss('id1');
    // 2 misses < threshold of 3, even though duration is met
    assert.equal(cache.isNegativelyCached('id1'), false);
  });

  it('does not promote below duration threshold even with enough count', () => {
    const cache = createCache();
    // All misses happen at time 0 — duration threshold not met
    cache.recordMiss('id1');
    cache.recordMiss('id1');
    cache.recordMiss('id1');
    assert.equal(cache.isNegativelyCached('id1'), false);
  });

  it('promotes when both thresholds met', () => {
    const cache = createCache();
    currentTime = 0;
    cache.recordMiss('id1');
    currentTime = 5_000;
    cache.recordMiss('id1');
    currentTime = 10_000;
    cache.recordMiss('id1'); // count=3, duration=10000ms — both met
    assert.equal(cache.isNegativelyCached('id1'), true);
  });

  it('evict removes from negative cache', () => {
    const cache = createCache();
    currentTime = 0;
    cache.recordMiss('id1');
    currentTime = 5_000;
    cache.recordMiss('id1');
    currentTime = 10_000;
    cache.recordMiss('id1');
    assert.equal(cache.isNegativelyCached('id1'), true);

    cache.evict('id1');
    assert.equal(cache.isNegativelyCached('id1'), false);
  });

  it('evict removes from miss tracker allowing fresh start', () => {
    const cache = createCache();
    currentTime = 0;
    cache.recordMiss('id1');
    currentTime = 5_000;
    cache.recordMiss('id1');
    // 2 misses recorded, evict resets
    cache.evict('id1');

    // Now re-record — should need full threshold again
    currentTime = 20_000;
    cache.recordMiss('id1');
    currentTime = 25_000;
    cache.recordMiss('id1');
    assert.equal(cache.isNegativelyCached('id1'), false);
  });

  it('TTL expiry removes entries', () => {
    const cache = createCache({ ttlMs: 100 });
    currentTime = 0;
    cache.recordMiss('id1');
    currentTime = 5_000;
    cache.recordMiss('id1');
    currentTime = 10_000;
    cache.recordMiss('id1');
    assert.equal(cache.isNegativelyCached('id1'), true);

    // Advance past TTL — lru-cache checks Date.now() internally so we
    // can't fully control this, but with a 100ms TTL it should expire quickly.
    // We verify by checking that a very short TTL eventually expires.
    // Since lru-cache uses real time for TTL, we sleep briefly.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        assert.equal(cache.isNegativelyCached('id1'), false);
        resolve();
      }, 200);
    });
  });

  it('disabled mode always returns false', () => {
    const cache = createCache({ enabled: false });
    currentTime = 0;
    cache.recordMiss('id1');
    currentTime = 5_000;
    cache.recordMiss('id1');
    currentTime = 10_000;
    cache.recordMiss('id1');
    assert.equal(cache.isNegativelyCached('id1'), false);
  });

  it('LRU eviction when max size exceeded', () => {
    const cache = createCache({ maxSize: 2, missDurationMs: 0 });

    // Promote id1 and id2
    cache.recordMiss('id1');
    cache.recordMiss('id1');
    cache.recordMiss('id1');
    cache.recordMiss('id2');
    cache.recordMiss('id2');
    cache.recordMiss('id2');
    assert.equal(cache.isNegativelyCached('id1'), true);
    assert.equal(cache.isNegativelyCached('id2'), true);

    // Promote id3 — should evict id1 (LRU, since id2 was accessed more recently)
    cache.recordMiss('id3');
    cache.recordMiss('id3');
    cache.recordMiss('id3');
    assert.equal(cache.isNegativelyCached('id3'), true);
    assert.equal(cache.isNegativelyCached('id1'), false);
  });

  it('metrics increment correctly', () => {
    const hitsBefore =
      (metrics.negativeCacheHitsTotal as any).hashMap[''].value ?? 0;
    const missesBefore =
      (metrics.negativeCacheMissesTotal as any).hashMap[''].value ?? 0;
    const promotionsBefore =
      (metrics.negativeCachePromotionsTotal as any).hashMap[''].value ?? 0;
    const evictionsBefore =
      (metrics.negativeCacheEvictionsTotal as any).hashMap[''].value ?? 0;

    const cache = createCache({ missDurationMs: 0 });

    // Miss check (not cached)
    cache.isNegativelyCached('id1');
    const missesAfterCheck =
      (metrics.negativeCacheMissesTotal as any).hashMap[''].value ?? 0;
    assert.equal(missesAfterCheck - missesBefore, 1);

    // Promote
    cache.recordMiss('id1');
    cache.recordMiss('id1');
    cache.recordMiss('id1');
    const promotionsAfter =
      (metrics.negativeCachePromotionsTotal as any).hashMap[''].value ?? 0;
    assert.equal(promotionsAfter - promotionsBefore, 1);

    // Hit check
    cache.isNegativelyCached('id1');
    const hitsAfter =
      (metrics.negativeCacheHitsTotal as any).hashMap[''].value ?? 0;
    assert.equal(hitsAfter - hitsBefore, 1);

    // Eviction
    cache.evict('id1');
    const evictionsAfter =
      (metrics.negativeCacheEvictionsTotal as any).hashMap[''].value ?? 0;
    assert.equal(evictionsAfter - evictionsBefore, 1);
  });
});
