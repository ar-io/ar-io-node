/**
 * AR.IO Gateway
 * Copyright (C) 2022-2023 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
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
    debounceFn: async () => {
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
    assert.equal(toB64Url(result!), 'test'); // eslint-disable-line @typescript-eslint/no-non-null-assertion
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
        debounceFn: async () => {
          callCount++;
          kvBufferStore.set(key, Buffer.from('test'));
        },
      });
      await kvDebounceStore.get(key);
      const result = await kvBufferStore.get(key);
      assert.equal(result!.toString('utf-8'), 'test'); // eslint-disable-line @typescript-eslint/no-non-null-assertion
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
        debounceFn: async () => {
          lastCallTimestamp = Date.now();
          callCount++;
          kvBufferStore.set(key, Buffer.from('test'));
        },
      });
      const result = await kvBufferStore.get(key);
      assert.equal(result, undefined); // eslint-disable-line @typescript-eslint/no-non-null-assertion
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
        debounceFn: async () => {
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

      // request a missing key, should call debounceFn and await the debounceFn to complete
      const result = await kvDebounceStore.get(key);
      assert.equal(callCount, 2);
      assert.ok(lastCallTimestamp >= Date.now() - 10);
      assert.equal(result!.toString('utf-8'), '1'); // eslint-disable-line @typescript-eslint/no-non-null-assertion
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
        debounceFn: async () => {
          lastCallTimestamp = Date.now();
          kvBufferStore.set(key, Buffer.from(`test${callCount}`));
          callCount++;
        },
      });

      // should hydrate immediately
      const result = await kvDebounceStore.get(key);
      assert.equal(result!.toString('utf-8'), 'test0'); // eslint-disable-line @typescript-eslint/no-non-null-assertion
      assert.ok(lastCallTimestamp <= Date.now());
      assert.equal(callCount, 1);

      // it should debounce after the cache hit debounce ttl expires
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(callCount, 2);
      assert.ok(lastCallTimestamp >= Date.now() - 100);
      const result2 = await kvDebounceStore.get(key);
      assert.equal(result2!.toString('utf-8'), 'test1'); // eslint-disable-line @typescript-eslint/no-non-null-assertion
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
          debounceFn: () => {
            throw new Error('Test error');
          },
        });
      }, /Test error/);
    });
  });
});
