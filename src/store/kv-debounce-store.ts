/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { KVBufferStore } from '../types';
import pDebounce from 'p-debounce';
import { tracer } from '../tracing.js';
import * as metrics from '../metrics.js';
import { Span } from '@opentelemetry/api';

/**
 * A wrapper around a KVBufferStore that debounces the hydrate function
 * on cache miss and cache hit.
 */
export class KvDebounceStore implements KVBufferStore {
  private kvBufferStore: KVBufferStore;
  private debounceHydrateOnMiss: (...args: any[]) => Promise<void>;
  private debounceHydrateOnHit: (...args: any[]) => Promise<void>;
  private pendingHydrate: Promise<void> | undefined;

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
    hydrateFn: (parentSpan?: Span) => Promise<void>; // caller is responsible for handling errors from debounceFn, this class will bubble up errors on instantiation if debounceFn throws
  }) {
    this.kvBufferStore = kvBufferStore;
    const syncedHydrateFn = (parentSpan?: Span) => {
      if (this.pendingHydrate !== undefined) {
        return this.pendingHydrate;
      }

      this.pendingHydrate = hydrateFn(parentSpan).finally(() => {
        this.pendingHydrate = undefined;
      });

      return this.pendingHydrate;
    };
    this.debounceHydrateOnMiss = pDebounce(
      syncedHydrateFn,
      cacheMissDebounceTtl,
      {
        before: true,
      },
    );
    this.debounceHydrateOnHit = pDebounce(syncedHydrateFn, cacheHitDebounceTtl);

    // debounce the cache immediately when the cache is created
    if (debounceImmediately) {
      syncedHydrateFn();
    }
  }

  async get(key: string): Promise<Buffer | undefined> {
    const span = tracer.startSpan('KvDebounceStore.get', {
      attributes: {
        'kv.key': key,
      },
    });

    try {
      let value = await this.kvBufferStore.get(key);
      if (value === undefined) {
        span.setAttributes({ 'kv.cache.hit': false });
        // await any actively running hydrates but don't wait for debounces. This
        // ensures that we don't unnecessarily return a 404 during startup while
        // avoiding excessive delays waiting for long debounces.
        if (this.pendingHydrate) {
          await this.debounceHydrateOnMiss(span);
        }
        this.debounceHydrateOnMiss(span);
        metrics.arnsNameCacheDebounceTriggeredCounter.inc({ type: 'miss' });
        span.addEvent('Debounce triggered on miss');
        value = await this.kvBufferStore.get(key);
      } else {
        span.setAttributes({ 'kv.cache.hit': true });
        // don't await on a hit, fire and forget
        this.debounceHydrateOnHit(span);
        metrics.arnsNameCacheDebounceTriggeredCounter.inc({ type: 'hit' });
        span.addEvent('Debounce triggered on hit');
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
