/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { KVBufferStore } from '../types.js';
import { tracer } from '../tracing.js';
import * as metrics from '../metrics.js';
import { Span } from '@opentelemetry/api';

/**
 * A wrapper around a KVBufferStore that debounces the hydrate function
 * on cache miss and cache hit using timestamp-based tracking.
 */
export class KvDebounceStore implements KVBufferStore {
  private kvBufferStore: KVBufferStore;
  private cacheMissDebounceTtl: number;
  private cacheHitDebounceTtl: number;
  private hydrateFn: (parentSpan?: Span) => Promise<void>;
  private pendingHydrate: Promise<void> | undefined;
  private lastRefreshTimestamp: number = 0;

  constructor({
    kvBufferStore,
    cacheMissDebounceTtl,
    cacheHitDebounceTtl,
    debounceImmediately = true,
    hydrateFn: hydrateFn,
  }: {
    kvBufferStore: KVBufferStore;
    cacheMissDebounceTtl: number;
    cacheHitDebounceTtl: number;
    debounceImmediately?: boolean;
    hydrateFn: (parentSpan?: Span) => Promise<void>;
  }) {
    this.kvBufferStore = kvBufferStore;
    this.cacheMissDebounceTtl = cacheMissDebounceTtl;
    this.cacheHitDebounceTtl = cacheHitDebounceTtl;
    this.hydrateFn = hydrateFn;

    // debounce the cache immediately when the cache is created
    if (debounceImmediately) {
      this.triggerHydrate();
      this.lastRefreshTimestamp = Date.now();
    }
  }

  private triggerHydrate(parentSpan?: Span): Promise<void> {
    if (this.pendingHydrate !== undefined) {
      parentSpan?.addEvent('Reusing pending hydrate');
      return this.pendingHydrate;
    }

    parentSpan?.addEvent('Starting new hydrate');
    const span = tracer.startSpan('KvDebounceStore.triggerHydrate');

    this.pendingHydrate = this.hydrateFn().finally(() => {
      this.pendingHydrate = undefined;
      span.end();
    });

    return this.pendingHydrate;
  }

  private shouldRefresh(debounceTtl: number): boolean {
    const now = Date.now();
    return now - this.lastRefreshTimestamp >= debounceTtl;
  }

  async get(key: string): Promise<Buffer | undefined> {
    const span = tracer.startSpan('KvDebounceStore.get', {
      attributes: {
        'kv.key': key,
      },
    });

    try {
      let value = await this.kvBufferStore.get(key);

      // If a hydrate is already in progress, wait for it to finish and retry
      if (value === undefined && this.pendingHydrate !== undefined) {
        span.addEvent('Awaiting pending hydrate');
        await this.pendingHydrate;
        value = await this.kvBufferStore.get(key);
      }

      if (value === undefined) {
        span.setAttributes({ 'kv.cache.hit': false });

        // Check if we should refresh based on miss debounce TTL
        if (this.shouldRefresh(this.cacheMissDebounceTtl)) {
          this.lastRefreshTimestamp = Date.now();

          // await any actively running hydrates but don't wait for new ones
          if (this.pendingHydrate) {
            await this.triggerHydrate(span);
          } else {
            this.triggerHydrate(span);
          }

          metrics.arnsNameCacheDebounceTriggeredCounter.inc({ type: 'miss' });
          span.addEvent('Debounce triggered on miss');

          // Try to get the value again after hydration
          value = await this.kvBufferStore.get(key);
        }
      } else {
        span.setAttributes({ 'kv.cache.hit': true });

        // Check if we should refresh based on hit debounce TTL
        if (this.shouldRefresh(this.cacheHitDebounceTtl)) {
          this.lastRefreshTimestamp = Date.now();

          // don't await on a hit, fire and forget
          this.triggerHydrate(span);

          metrics.arnsNameCacheDebounceTriggeredCounter.inc({ type: 'hit' });
          span.addEvent('Debounce triggered on hit');
        }
      }
      return value;
    } finally {
      span.end();
    }
  }

  async set(key: string, value: Buffer): Promise<void> {
    await this.kvBufferStore.set(key, value);
  }

  async del(key: string): Promise<void> {
    await this.kvBufferStore.del(key);
  }

  async has(key: string): Promise<boolean> {
    return this.kvBufferStore.has(key);
  }

  async close(): Promise<void> {
    await this.kvBufferStore.close();
  }
}
