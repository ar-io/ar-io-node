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
  private now: () => number;

  constructor({
    log,
    enabled,
    maxSize,
    ttlMs,
    missCountThreshold,
    missDurationMs,
    missTrackerTtlMs,
    maxTtlMs,
    promotionHistoryTtlMs,
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
    promotionHistoryTtlMs?: number;
    now?: () => number;
  }) {
    this.log = log;
    this.enabled = enabled;
    this.missCountThreshold = missCountThreshold;
    this.missDurationMs = missDurationMs;
    this.baseTtlMs = ttlMs;
    this.maxTtlMs = maxTtlMs ?? ttlMs;
    this.now = now;

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

  recordMiss(id: string): void {
    if (!this.enabled) {
      return;
    }

    const now = this.now();
    const existing = this.missTracker.get(id);

    if (existing) {
      existing.count++;
      this.missTracker.set(id, existing);
    } else {
      this.missTracker.set(id, {
        firstSeenAt: now,
        count: 1,
      });
    }

    const entry = this.missTracker.get(id)!;
    const priorPromotions = this.promotionHistory.get(id) ?? 0;
    const effectiveCount = priorPromotions > 0 ? 1 : this.missCountThreshold;
    const effectiveDuration = priorPromotions > 0 ? 0 : this.missDurationMs;

    if (
      entry.count >= effectiveCount &&
      now - entry.firstSeenAt >= effectiveDuration
    ) {
      const ttl = Math.min(
        this.baseTtlMs * 2 ** Math.min(priorPromotions, 30),
        this.maxTtlMs,
      );
      this.negativeCache.set(id, true, { ttl });
      this.promotionHistory.set(id, priorPromotions + 1);
      this.missTracker.delete(id);
      metrics.negativeCachePromotionsTotal.inc();
      if (priorPromotions > 0) {
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
    if (this.negativeCache.delete(id)) {
      metrics.negativeCacheEvictionsTotal.inc();
      this.log.info('ID evicted from negative cache', { id });
    }
    this.missTracker.delete(id);
    this.promotionHistory.delete(id);
    this.updateGauges();
  }

  private updateGauges(): void {
    metrics.negativeCacheSize.set(this.negativeCache.size);
    metrics.missTrackerSize.set(this.missTracker.size);
    metrics.promotionHistorySize.set(this.promotionHistory.size);
  }
}
