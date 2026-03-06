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
  lastSeenAt: number;
  count: number;
}

export class NegativeDataCache {
  private log: Logger;
  private enabled: boolean;
  private missTracker: LRUCache<string, MissTrackerEntry>;
  private negativeCache: LRUCache<string, true>;
  private missCountThreshold: number;
  private missDurationMs: number;
  private now: () => number;

  constructor({
    log,
    enabled,
    maxSize,
    ttlMs,
    missCountThreshold,
    missDurationMs,
    now = Date.now,
  }: {
    log: Logger;
    enabled: boolean;
    maxSize: number;
    ttlMs: number;
    missCountThreshold: number;
    missDurationMs: number;
    now?: () => number;
  }) {
    this.log = log;
    this.enabled = enabled;
    this.missCountThreshold = missCountThreshold;
    this.missDurationMs = missDurationMs;
    this.now = now;

    this.missTracker = new LRUCache<string, MissTrackerEntry>({
      max: maxSize,
    });

    this.negativeCache = new LRUCache<string, true>({
      max: maxSize,
      ttl: ttlMs,
    });
  }

  isNegativelyCached(id: string): boolean {
    if (!this.enabled) {
      return false;
    }

    if (this.negativeCache.has(id)) {
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
      existing.lastSeenAt = now;
      existing.count++;
      this.missTracker.set(id, existing);
    } else {
      this.missTracker.set(id, {
        firstSeenAt: now,
        lastSeenAt: now,
        count: 1,
      });
    }

    const entry = this.missTracker.get(id)!;
    if (
      entry.count >= this.missCountThreshold &&
      now - entry.firstSeenAt >= this.missDurationMs
    ) {
      this.negativeCache.set(id, true);
      this.missTracker.delete(id);
      metrics.negativeCachePromotionsTotal.inc();
      this.log.info('ID promoted to negative cache', { id });
    }

    this.updateGauges();
  }

  evict(id: string): void {
    if (this.negativeCache.has(id)) {
      metrics.negativeCacheEvictionsTotal.inc();
      this.log.info('ID evicted from negative cache', { id });
    }
    this.negativeCache.delete(id);
    this.missTracker.delete(id);
    this.updateGauges();
  }

  private updateGauges(): void {
    metrics.negativeCacheSize.set(this.negativeCache.size);
    metrics.missTrackerSize.set(this.missTracker.size);
  }
}
