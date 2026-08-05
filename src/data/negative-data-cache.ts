/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { LRUCache } from 'lru-cache';
import { Logger } from 'winston';

import * as metrics from '../metrics.js';

interface MissTrackerEntry {
  firstSeenAt: number;
  count: number;
}

export class NegativeDataCache {
  private log: Logger;
  private enabled: boolean;
  private missTracker: LRUCache<string, MissTrackerEntry>;
  private negativeCache: LRUCache<string, true>;
  private promotionHistory: LRUCache<string, number>;
  private missCountThreshold: number;
  private missDurationMs: number;
  private baseTtlMs: number;
  private maxTtlMs: number;
  private softMissTtlMs: number;
  private now: () => number;
  private recentSuccesses: number = 0;
  private recentFailures: number = 0;
  private windowStartedAt: number;
  private healthWindowMs: number;
  private unhealthyThreshold: number;
  private minSampleSize: number;
  // Distinguishes this instance's gauge series from any sibling instance (e.g.
  // the separate Arweave vs IPFS caches) so their updateGauges() calls don't
  // clobber the same unlabelled metric.
  private metricsSource: string;

  constructor({
    log,
    enabled,
    maxSize,
    ttlMs,
    missCountThreshold,
    missDurationMs,
    missTrackerTtlMs,
    maxTtlMs,
    softMissTtlMs,
    promotionHistoryTtlMs,
    healthWindowMs = 60_000,
    unhealthyThreshold = 0.8,
    minSampleSize = 10,
    metricsSource = 'arweave',
    now = Date.now,
  }: {
    log: Logger;
    enabled: boolean;
    maxSize: number;
    ttlMs: number;
    missCountThreshold: number;
    missDurationMs: number;
    missTrackerTtlMs?: number;
    maxTtlMs?: number;
    softMissTtlMs?: number;
    promotionHistoryTtlMs?: number;
    healthWindowMs?: number;
    unhealthyThreshold?: number;
    minSampleSize?: number;
    metricsSource?: string;
    now?: () => number;
  }) {
    this.log = log;
    this.metricsSource = metricsSource;
    this.enabled = enabled;
    this.missCountThreshold = missCountThreshold;
    this.missDurationMs = missDurationMs;
    this.baseTtlMs = ttlMs;
    this.maxTtlMs = maxTtlMs ?? ttlMs;
    // Soft (timeout-origin) blackholes use a short, non-escalating TTL so a
    // recovering-but-slow id self-heals quickly instead of being blackholed for
    // hours. Defaults to ttlMs so callers that never pass softMiss are unaffected.
    this.softMissTtlMs = softMissTtlMs ?? ttlMs;
    this.now = now;
    this.healthWindowMs = healthWindowMs;
    this.unhealthyThreshold = unhealthyThreshold;
    this.minSampleSize = minSampleSize;
    this.windowStartedAt = this.now();

    this.missTracker = new LRUCache<string, MissTrackerEntry>({
      max: maxSize,
      ttl: missTrackerTtlMs ?? missDurationMs,
      ttlResolution: 0,
      perf: { now: this.now },
    });

    this.negativeCache = new LRUCache<string, true>({
      max: maxSize,
      ttl: ttlMs,
      ttlResolution: 0,
      perf: { now: this.now },
    });

    this.promotionHistory = new LRUCache<string, number>({
      max: maxSize,
      ttl: promotionHistoryTtlMs ?? 604_800_000, // 7 days default
      ttlResolution: 0,
      perf: { now: this.now },
    });
  }

  isNegativelyCached(id: string): boolean {
    if (!this.enabled) {
      return false;
    }

    const sizeBefore = this.negativeCache.size;
    const cached = this.negativeCache.get(id);
    if (this.negativeCache.size !== sizeBefore) {
      this.updateGauges();
    }

    if (cached) {
      metrics.negativeCacheHitsTotal.inc();
      return true;
    }

    metrics.negativeCacheMissesTotal.inc();
    return false;
  }

  recordSuccess(): void {
    if (!this.enabled) {
      return;
    }
    this.maybeResetWindow();
    this.recentSuccesses++;
  }

  /**
   * @param opts.softMiss a soft miss is a transient availability failure (e.g.
   *   an IPFS retrieval timeout — no live provider) rather than a definitive
   *   "absent" (a 404). Soft misses NEVER use the single-miss re-promotion fast
   *   path, so one transient timeout can't instantly re-blackhole a recovering id;
   *   they always require the full miss count/duration threshold.
   */
  recordMiss(id: string, opts?: { softMiss?: boolean }): void {
    if (!this.enabled) {
      return;
    }

    this.maybeResetWindow();
    this.recentFailures++;

    const now = this.now();
    const existing = this.missTracker.get(id);

    let entry: MissTrackerEntry;
    if (existing) {
      existing.count++;
      entry = existing;
      this.missTracker.set(id, existing);
    } else {
      entry = { firstSeenAt: now, count: 1 };
      this.missTracker.set(id, entry);
    }

    const priorPromotions = this.promotionHistory.get(id) ?? 0;
    const usePromotionFastPath = priorPromotions > 0 && opts?.softMiss !== true;
    const effectiveCount = usePromotionFastPath ? 1 : this.missCountThreshold;
    const effectiveDuration = usePromotionFastPath ? 0 : this.missDurationMs;

    if (
      entry.count >= effectiveCount &&
      now - entry.firstSeenAt >= effectiveDuration
    ) {
      if (this.isUnhealthy()) {
        metrics.negativeCachePromotionsSuppressedTotal.inc();
        this.updateGauges();
        return;
      }

      // A soft (timeout) promotion gets a short, fixed TTL and does NOT build the
      // escalation/re-promotion history — so a transient-but-recovering id can't
      // be blackholed for hours (or escalate toward maxTtlMs). A hard (definitive
      // 404) promotion keeps the exponential-backoff TTL and history.
      const soft = opts?.softMiss === true;
      const ttl = soft
        ? this.softMissTtlMs
        : Math.min(
            this.baseTtlMs * 2 ** Math.min(priorPromotions, 30),
            this.maxTtlMs,
          );
      this.negativeCache.set(id, true, { ttl });
      if (!soft) {
        this.promotionHistory.set(id, priorPromotions + 1);
      }
      this.missTracker.delete(id);
      metrics.negativeCachePromotionsTotal.inc();
      if (!soft && priorPromotions > 0) {
        metrics.negativeCacheRePromotionsTotal.inc();
      }
      this.log.info('ID promoted to negative cache', {
        id,
        ttl,
        promotionCount: priorPromotions + 1,
      });
    }

    this.updateGauges();
  }

  evict(id: string): void {
    if (!this.enabled) {
      return;
    }

    if (this.negativeCache.delete(id)) {
      metrics.negativeCacheEvictionsTotal.inc();
      this.log.info('ID evicted from negative cache', { id });
    }
    this.missTracker.delete(id);
    this.promotionHistory.delete(id);
    this.updateGauges();
  }

  private maybeResetWindow(): void {
    if (this.now() - this.windowStartedAt >= this.healthWindowMs) {
      this.recentSuccesses = 0;
      this.recentFailures = 0;
      this.windowStartedAt = this.now();
    }
  }

  private isUnhealthy(): boolean {
    const total = this.recentSuccesses + this.recentFailures;
    return (
      total >= this.minSampleSize &&
      this.recentFailures / total > this.unhealthyThreshold
    );
  }

  private updateGauges(): void {
    const source = this.metricsSource;
    metrics.negativeCacheSize.set({ source }, this.negativeCache.size);
    metrics.missTrackerSize.set({ source }, this.missTracker.size);
    metrics.promotionHistorySize.set({ source }, this.promotionHistory.size);
  }
}
