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
      missTrackerTtlMs: 60_000,
      maxTtlMs: 120_000,
      promotionHistoryTtlMs: 300_000,
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

  it('disabled mode skips evict without errors', () => {
    const cache = createCache({ enabled: false });
    // Should be a no-op, not throw
    cache.evict('nonexistent-id');
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

  it('stale miss tracker entries expire and do not cause incorrect promotion', () => {
    const cache = createCache({ missTrackerTtlMs: 10_000 });

    // Record 2 misses (below count threshold of 3)
    cache.recordMiss('id1');
    currentTime = 5_000;
    cache.recordMiss('id1');

    // Advance well past the miss tracker TTL (10_000ms)
    currentTime = 50_000;

    // The old entry should have expired; this starts a fresh tracker entry
    cache.recordMiss('id1');
    currentTime = 55_000;
    cache.recordMiss('id1');
    currentTime = 61_000;
    cache.recordMiss('id1');

    // count=3 and duration=11_000ms from fresh start at 50_000 — should promote
    assert.equal(cache.isNegativelyCached('id1'), true);
  });

  it('single miss after stale expiry does not promote', () => {
    const cache = createCache({ missTrackerTtlMs: 10_000 });

    // Accumulate 2 misses (just below threshold)
    cache.recordMiss('id1');
    currentTime = 5_000;
    cache.recordMiss('id1');

    // Advance past TTL so old entry expires
    currentTime = 50_000;

    // A single new miss should NOT promote (count=1, not >= 3)
    cache.recordMiss('id1');
    assert.equal(cache.isNegativelyCached('id1'), false);
  });

  it('re-promotes with single miss after TTL expiry', () => {
    const cache = createCache({ ttlMs: 100, missDurationMs: 0 });

    // Initial promotion (requires 3 misses)
    cache.recordMiss('id1');
    cache.recordMiss('id1');
    cache.recordMiss('id1');
    assert.equal(cache.isNegativelyCached('id1'), true);

    // Advance past TTL
    currentTime = 1_200;
    assert.equal(cache.isNegativelyCached('id1'), false);

    // Single miss should re-promote
    cache.recordMiss('id1');
    assert.equal(cache.isNegativelyCached('id1'), true);
  });

  it('exponential backoff increases TTL', () => {
    const cache = createCache({
      ttlMs: 100,
      maxTtlMs: 10_000,
      missDurationMs: 0,
    });

    // First promotion: TTL = 100
    cache.recordMiss('id1');
    cache.recordMiss('id1');
    cache.recordMiss('id1');
    assert.equal(cache.isNegativelyCached('id1'), true);

    // Expire first TTL (100ms)
    currentTime = 1_200;
    assert.equal(cache.isNegativelyCached('id1'), false);

    // Second promotion: TTL = 200
    cache.recordMiss('id1');
    assert.equal(cache.isNegativelyCached('id1'), true);

    // Still cached at 199ms after promotion
    currentTime = 1_399;
    assert.equal(cache.isNegativelyCached('id1'), true);

    // Expired past 200ms after promotion
    currentTime = 1_401;
    assert.equal(cache.isNegativelyCached('id1'), false);

    // Third promotion: TTL = 400
    cache.recordMiss('id1');
    assert.equal(cache.isNegativelyCached('id1'), true);

    // Still cached at 400ms after promotion
    currentTime = 1_801;
    assert.equal(cache.isNegativelyCached('id1'), true);

    // Expired past 400ms after promotion
    currentTime = 1_802;
    assert.equal(cache.isNegativelyCached('id1'), false);
  });

  it('backoff capped at maxTtlMs', () => {
    const cache = createCache({
      ttlMs: 100,
      maxTtlMs: 300,
      missDurationMs: 0,
    });

    // First promotion: TTL = 100
    cache.recordMiss('id1');
    cache.recordMiss('id1');
    cache.recordMiss('id1');
    currentTime = 1_200;
    assert.equal(cache.isNegativelyCached('id1'), false);

    // Second promotion: TTL = 200
    cache.recordMiss('id1');
    currentTime = 1_501;
    assert.equal(cache.isNegativelyCached('id1'), false);

    // Third promotion: TTL = min(400, 300) = 300
    cache.recordMiss('id1');
    assert.equal(cache.isNegativelyCached('id1'), true);

    // Still cached at 300ms
    currentTime = 1_801;
    assert.equal(cache.isNegativelyCached('id1'), true);

    // Expired past 300ms
    currentTime = 1_802;
    assert.equal(cache.isNegativelyCached('id1'), false);

    // Fourth promotion: TTL still capped at 300
    cache.recordMiss('id1');
    assert.equal(cache.isNegativelyCached('id1'), true);
    currentTime = 2_102;
    assert.equal(cache.isNegativelyCached('id1'), true);
    currentTime = 2_103;
    assert.equal(cache.isNegativelyCached('id1'), false);
  });

  it('evict clears promotion history', () => {
    const cache = createCache({ ttlMs: 100, missDurationMs: 0 });

    // Promote and build history
    cache.recordMiss('id1');
    cache.recordMiss('id1');
    cache.recordMiss('id1');
    assert.equal(cache.isNegativelyCached('id1'), true);

    // Evict clears everything including promotion history
    cache.evict('id1');
    assert.equal(cache.isNegativelyCached('id1'), false);

    // Should require full threshold again (no fast re-promotion)
    cache.recordMiss('id1');
    assert.equal(cache.isNegativelyCached('id1'), false);
    cache.recordMiss('id1');
    assert.equal(cache.isNegativelyCached('id1'), false);
    cache.recordMiss('id1');
    assert.equal(cache.isNegativelyCached('id1'), true);
  });

  it('promotion history survives negative cache TTL expiry', () => {
    const cache = createCache({
      ttlMs: 100,
      missDurationMs: 0,
      promotionHistoryTtlMs: 300_000,
    });

    // Promote
    cache.recordMiss('id1');
    cache.recordMiss('id1');
    cache.recordMiss('id1');
    assert.equal(cache.isNegativelyCached('id1'), true);

    // Expire TTL but not promotion history
    currentTime = 1_200;
    assert.equal(cache.isNegativelyCached('id1'), false);

    // Fast re-promotion works (history survived)
    cache.recordMiss('id1');
    assert.equal(cache.isNegativelyCached('id1'), true);
  });

  it('promotion history expires after its own TTL', () => {
    const cache = createCache({
      ttlMs: 100,
      missDurationMs: 0,
      promotionHistoryTtlMs: 500,
    });

    // Promote
    cache.recordMiss('id1');
    cache.recordMiss('id1');
    cache.recordMiss('id1');
    assert.equal(cache.isNegativelyCached('id1'), true);

    // Advance past both negative cache TTL and promotion history TTL
    currentTime = 1_600;
    assert.equal(cache.isNegativelyCached('id1'), false);

    // History has expired — needs full threshold again
    cache.recordMiss('id1');
    assert.equal(cache.isNegativelyCached('id1'), false);
    cache.recordMiss('id1');
    assert.equal(cache.isNegativelyCached('id1'), false);
    cache.recordMiss('id1');
    assert.equal(cache.isNegativelyCached('id1'), true);
  });

  it('miss tracker TTL independent of duration threshold', () => {
    const cache = createCache({
      missDurationMs: 0,
      missTrackerTtlMs: 500,
    });

    // Record 2 misses (below count threshold)
    cache.recordMiss('id1');
    currentTime = 1_100;
    cache.recordMiss('id1');

    // Advance past missTrackerTtlMs — entry should expire
    currentTime = 1_601;

    // This is a fresh start; single miss won't promote
    cache.recordMiss('id1');
    assert.equal(cache.isNegativelyCached('id1'), false);

    // Need full 3 misses from fresh start
    cache.recordMiss('id1');
    cache.recordMiss('id1');
    assert.equal(cache.isNegativelyCached('id1'), true);
  });

  it('promotions proceed when healthy', () => {
    const cache = createCache({
      missDurationMs: 0,
      healthWindowMs: 60_000,
      unhealthyThreshold: 0.8,
      minSampleSize: 4,
    });

    // Record enough successes to keep failure rate at 75% (below 80%)
    cache.recordSuccess();

    cache.recordMiss('id1');
    cache.recordMiss('id1');
    cache.recordMiss('id1');
    // Failure rate: 3/4 = 0.75 — not > 0.8 threshold, so promotion proceeds
    assert.equal(cache.isNegativelyCached('id1'), true);
  });

  it('promotions suppressed when unhealthy', () => {
    const cache = createCache({
      missDurationMs: 0,
      healthWindowMs: 60_000,
      unhealthyThreshold: 0.8,
      minSampleSize: 4,
    });

    // Record many failures — system is unhealthy
    cache.recordMiss('other1');
    cache.recordMiss('other2');

    cache.recordMiss('id1');
    cache.recordMiss('id1');
    cache.recordMiss('id1');
    // Failure rate: 5/5 = 1.0 > 0.8 — promotion suppressed
    assert.equal(cache.isNegativelyCached('id1'), false);
  });

  it('window resets after healthWindowMs', () => {
    const cache = createCache({
      missDurationMs: 0,
      healthWindowMs: 1_000,
      unhealthyThreshold: 0.8,
      minSampleSize: 4,
    });

    // Drive system unhealthy (100% failure rate)
    cache.recordMiss('other1');
    cache.recordMiss('other2');
    cache.recordMiss('other3');
    cache.recordMiss('other4');

    // Advance past health window
    currentTime = 2_001;

    // Now record a success so failure rate is 75% in new window
    cache.recordSuccess();

    cache.recordMiss('id1');
    cache.recordMiss('id1');
    cache.recordMiss('id1');
    // New window: 3 failures, 1 success = 0.75 — not > 0.8 threshold
    assert.equal(cache.isNegativelyCached('id1'), true);
  });

  it('below minSampleSize always healthy', () => {
    const cache = createCache({
      missDurationMs: 0,
      healthWindowMs: 60_000,
      unhealthyThreshold: 0.8,
      minSampleSize: 100, // Very high min sample
    });

    // All failures but below min sample size
    cache.recordMiss('id1');
    cache.recordMiss('id1');
    cache.recordMiss('id1');
    // Only 3 samples < 100 min — treated as healthy
    assert.equal(cache.isNegativelyCached('id1'), true);
  });

  it('miss tracking continues during unhealthy, promotes after recovery', () => {
    const cache = createCache({
      missDurationMs: 0,
      healthWindowMs: 1_000,
      unhealthyThreshold: 0.8,
      minSampleSize: 4,
    });

    // Drive system unhealthy (100% failure rate)
    cache.recordMiss('other1');
    cache.recordMiss('other2');
    cache.recordMiss('other3');
    cache.recordMiss('other4');

    // Try to promote — suppressed due to unhealthy
    cache.recordMiss('id1');
    cache.recordMiss('id1');
    cache.recordMiss('id1');
    assert.equal(cache.isNegativelyCached('id1'), false);

    // Advance past health window — recovery
    currentTime = 2_001;

    // Record successes so new window is healthy
    cache.recordSuccess();
    cache.recordSuccess();
    cache.recordSuccess();

    // One more miss triggers promotion (accumulated misses still in tracker)
    cache.recordMiss('id1');
    // 1 failure, 3 successes in new window = 0.25 — healthy
    assert.equal(cache.isNegativelyCached('id1'), true);
  });

  it('recordSuccess is no-op when disabled', () => {
    const cache = createCache({ enabled: false });
    // Should not throw
    cache.recordSuccess();
  });

  it('metrics: re-promotion counter increments', async () => {
    const getValue = async (counter: { get(): Promise<any> }) => {
      const result = await counter.get();
      return result.values[0]?.value ?? 0;
    };

    const rePromotionsBefore = await getValue(
      metrics.negativeCacheRePromotionsTotal,
    );

    const cache = createCache({ ttlMs: 100, missDurationMs: 0 });

    // Initial promotion — should NOT increment re-promotion counter
    cache.recordMiss('id1');
    cache.recordMiss('id1');
    cache.recordMiss('id1');
    assert.equal(
      (await getValue(metrics.negativeCacheRePromotionsTotal)) -
        rePromotionsBefore,
      0,
    );

    // Expire and re-promote — should increment re-promotion counter
    currentTime = 1_200;
    cache.recordMiss('id1');
    assert.equal(
      (await getValue(metrics.negativeCacheRePromotionsTotal)) -
        rePromotionsBefore,
      1,
    );
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
