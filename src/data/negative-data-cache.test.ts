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
    currentTime = 1000;
  });

  it('returns false for unknown ID', () => {
    const cache = createCache();
    assert.equal(cache.isNegativelyCached('unknown-id'), false);
  });

  it('does not promote below count threshold', () => {
    const cache = createCache();
    cache.recordMiss('id1');
    currentTime = 16_000;
    cache.recordMiss('id1');
    // 2 misses < threshold of 3, even though duration is met
    assert.equal(cache.isNegativelyCached('id1'), false);
  });

  it('does not promote below duration threshold even with enough count', () => {
    const cache = createCache();
    // All misses happen at same time — duration threshold not met
    cache.recordMiss('id1');
    cache.recordMiss('id1');
    cache.recordMiss('id1');
    assert.equal(cache.isNegativelyCached('id1'), false);
  });

  it('promotes when both thresholds met', () => {
    const cache = createCache();
    cache.recordMiss('id1');
    currentTime = 6_000;
    cache.recordMiss('id1');
    currentTime = 11_000;
    cache.recordMiss('id1'); // count=3, duration=10000ms — both met
    assert.equal(cache.isNegativelyCached('id1'), true);
  });

  it('evict removes from negative cache', () => {
    const cache = createCache();
    cache.recordMiss('id1');
    currentTime = 6_000;
    cache.recordMiss('id1');
    currentTime = 11_000;
    cache.recordMiss('id1');
    assert.equal(cache.isNegativelyCached('id1'), true);

    cache.evict('id1');
    assert.equal(cache.isNegativelyCached('id1'), false);
  });

  it('evict removes from miss tracker allowing fresh start', () => {
    const cache = createCache();
    cache.recordMiss('id1');
    currentTime = 6_000;
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
    cache.recordMiss('id1');
    currentTime = 6_000;
    cache.recordMiss('id1');
    currentTime = 11_000;
    cache.recordMiss('id1');
    assert.equal(cache.isNegativelyCached('id1'), true);

    // Advance past TTL — the injected perf.now controls lru-cache's clock
    currentTime = 11_200;
    assert.equal(cache.isNegativelyCached('id1'), false);
  });

  it('disabled mode always returns false', () => {
    const cache = createCache({ enabled: false });
    cache.recordMiss('id1');
    currentTime = 6_000;
    cache.recordMiss('id1');
    currentTime = 11_000;
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

  it('metrics increment correctly', async () => {
    const getValue = async (counter: { get(): Promise<any> }) => {
      const result = await counter.get();
      return result.values[0]?.value ?? 0;
    };

    const hitsBefore = await getValue(metrics.negativeCacheHitsTotal);
    const missesBefore = await getValue(metrics.negativeCacheMissesTotal);
    const promotionsBefore = await getValue(
      metrics.negativeCachePromotionsTotal,
    );
    const evictionsBefore = await getValue(metrics.negativeCacheEvictionsTotal);

    const cache = createCache({ missDurationMs: 0 });

    // Miss check (not cached)
    cache.isNegativelyCached('id1');
    assert.equal(
      (await getValue(metrics.negativeCacheMissesTotal)) - missesBefore,
      1,
    );

    // Promote
    cache.recordMiss('id1');
    cache.recordMiss('id1');
    cache.recordMiss('id1');
    assert.equal(
      (await getValue(metrics.negativeCachePromotionsTotal)) - promotionsBefore,
      1,
    );

    // Hit check
    cache.isNegativelyCached('id1');
    assert.equal(
      (await getValue(metrics.negativeCacheHitsTotal)) - hitsBefore,
      1,
    );

    // Eviction
    cache.evict('id1');
    assert.equal(
      (await getValue(metrics.negativeCacheEvictionsTotal)) - evictionsBefore,
      1,
    );
  });
});
