/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { fromB64Url, toB64Url } from '../lib/encoding.js';
import { KvDebounceStore } from './kv-debounce-store.js';
import { NodeKvStore } from './node-kv-store.js';

describe('KvDebounceCache', () => {
  const key = 'key';

  const kvDebounceCache = new KvDebounceStore({
    kvBufferStore: new NodeKvStore({
      ttlSeconds: 100,
      maxKeys: 100,
    }),
    cacheMissDebounceTtl: 100,
    cacheHitDebounceTtl: 100,
    hydrateFn: async () => {
      // noop
    },
  });

  it('should properly set and get a buffer', async () => {
    const value = fromB64Url('test');
    await kvDebounceCache.set(key, value);
  });

  it('should properly delete buffer', async () => {
    const value = fromB64Url('test');
    await kvDebounceCache.set(key, value);
    await kvDebounceCache.del(key);
    const result = await kvDebounceCache.get(key);
    assert.equal(result, undefined);
  });

  it('should not override existing buffer when key already exists in cache', async () => {
    const value = Buffer.from('test', 'base64url');
    await kvDebounceCache.set(key, value);
    await kvDebounceCache.set(key, Buffer.from('test2', 'base64url'));
    const result = await kvDebounceCache.get(key);
    assert.notEqual(result, undefined);
    assert.equal(toB64Url(result!), 'test');
  });

  describe('debounceFn', () => {
    it('should debounce the cache immediately by default', async () => {
      let callCount = 0;
      const kvBufferStore = new NodeKvStore({
        ttlSeconds: 10000, // long ttl so we don't collide with debounce ttl's
        maxKeys: 100,
      });
      const kvDebounceStore = new KvDebounceStore({
        kvBufferStore,
        cacheHitDebounceTtl: 100,
        cacheMissDebounceTtl: 10,
        debounceImmediately: true,
        hydrateFn: async () => {
          callCount++;
          kvBufferStore.set(key, Buffer.from('test'));
        },
      });
      await kvDebounceStore.get(key);
      const result = await kvBufferStore.get(key);
      assert.equal(result!.toString('utf-8'), 'test');
      assert.equal(callCount, 1);
    });

    it('should not debounce the cache if debounceImmediately is false', async () => {
      const kvBufferStore = new NodeKvStore({
        ttlSeconds: 10000, // long ttl so we don't collide with debounce ttl's
        maxKeys: 100,
      });
      let callCount = 0;
      let lastCallTimestamp = 0;
      const kvDebounceStore = new KvDebounceStore({
        kvBufferStore,
        cacheHitDebounceTtl: 100,
        cacheMissDebounceTtl: 10,
        debounceImmediately: false,
        hydrateFn: async () => {
          lastCallTimestamp = Date.now();
          callCount++;
          kvBufferStore.set(key, Buffer.from('test'));
        },
      });
      const result = await kvBufferStore.get(key);
      assert.equal(result, undefined);
      assert.equal(callCount, 0);
      assert.equal(lastCallTimestamp, 0);
    });

    it('should call debounceFn on cache miss after the cache miss debounce ttl expires', async () => {
      let callCount = 0;
      let lastCallTimestamp = 0;
      const kvBufferStore = new NodeKvStore({
        ttlSeconds: 10000, // long ttl so we don't collide with debounce ttl's
        maxKeys: 100,
      });
      const kvDebounceStore = new KvDebounceStore({
        kvBufferStore,
        cacheHitDebounceTtl: 100,
        cacheMissDebounceTtl: 10,
        debounceImmediately: true,
        hydrateFn: async () => {
          lastCallTimestamp = Date.now();
          // return undefined on first call
          if (callCount === 0) {
            callCount++;
            return;
          }
          // add it to the cache as we would in a real implementation (no await)
          kvBufferStore.set(key, Buffer.from(`${callCount}`));
          callCount++;
        },
      });
      // it should call hydrate right away by default
      assert.equal(callCount, 1);
      assert.ok(lastCallTimestamp <= Date.now());

      // wait for the debounce ttl to expire
      await new Promise((resolve) => setTimeout(resolve, 11));

      // request a missing key, should call debounceFn and await the debounceFn to complete
      const result = await kvDebounceStore.get(key);
      assert.equal(callCount, 2);
      assert.ok(lastCallTimestamp >= Date.now() - 10);
      assert.equal(result!.toString('utf-8'), '1');
    });

    it('should call debounceFn on cache hit after the cache hit debounce ttl expires', async () => {
      let callCount = 0;
      let lastCallTimestamp = 0;
      const kvBufferStore = new NodeKvStore({
        ttlSeconds: 10000, // long ttl so we don't collide with debounce ttls
        maxKeys: 100,
      });
      // add the key to the
      const kvDebounceStore = new KvDebounceStore({
        kvBufferStore,
        cacheHitDebounceTtl: 100,
        cacheMissDebounceTtl: 10,
        debounceImmediately: true,
        hydrateFn: async () => {
          lastCallTimestamp = Date.now();
          kvBufferStore.set(key, Buffer.from(`test${callCount}`));
          callCount++;
        },
      });

      // should hydrate immediately
      const result = await kvDebounceStore.get(key);
      assert.equal(result!.toString('utf-8'), 'test0');
      assert.ok(lastCallTimestamp <= Date.now());
      assert.equal(callCount, 1);

      // wait for the cache hit debounce ttl to expire
      await new Promise((resolve) => setTimeout(resolve, 100));

      // trigger another get to cause the refresh on hit
      const result2 = await kvDebounceStore.get(key);
      assert.equal(callCount, 2);
      assert.ok(lastCallTimestamp >= Date.now() - 100);

      // Since refresh on hit is fire-and-forget, wait a bit for the async update to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Now get the updated value
      const result3 = await kvDebounceStore.get(key);
      assert.equal(result3!.toString('utf-8'), 'test1');
    });

    // intentional design choice to bubble up errors from debounceFn and let the caller handle them appropriately
    it('should bubble up errors from debounceFn', async () => {
      // catch error instantiating the class
      await assert.rejects(async () => {
        new KvDebounceStore({
          kvBufferStore: new NodeKvStore({
            ttlSeconds: 100,
            maxKeys: 100,
          }),
          cacheMissDebounceTtl: 10,
          cacheHitDebounceTtl: 100,
          // synchronously throw for testing purposes
          hydrateFn: () => {
            throw new Error('Test error');
          },
        });
      }, /Test error/);
    });
  });
});
