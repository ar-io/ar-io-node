/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { after, beforeEach, describe, it } from 'node:test';
import winston from 'winston';
import { ArNSNamesCache } from './arns-names-cache.js';
import { AoARIORead, Logger as ARIOLogger } from '@ar.io/sdk';
import { NodeKvStore } from '../store/node-kv-store.js';

// disable sdk logging to reduce noise
ARIOLogger.default.setLogLevel('none');

describe('ArNSNamesCache', () => {
  const log = winston.createLogger({
    // when debugging, set silent to false
    transports: [new winston.transports.Console({ silent: true })],
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json(),
    ),
  });

  let registryCache: NodeKvStore;

  beforeEach(async () => {
    // new cache for each test
    registryCache = new NodeKvStore({
      ttlSeconds: 1,
      maxKeys: 100,
    });
  });

  after(async () => {
    // exit forcefully due to intentional non-awaited promises in ArNSNamesCache
    process.exit(0);
  });

  it('should fetch and cache names on initialization', async () => {
    let callCount = 0;
    const debounceCache = new ArNSNamesCache({
      log,
      registryCache,
      networkProcess: {
        getArNSRecords: async () => {
          callCount++;
          return {
            items: [
              {
                name: `name-${callCount}-1`,
                processId: `process-${callCount}`,
              },
            ],
            nextCursor: undefined,
          };
        },
      } as unknown as AoARIORead,
    });

    // let the cache hydrate
    await new Promise((resolve) => setTimeout(resolve, 10));

    // assert names were loaded right away
    assert.equal(callCount, 1);

    // assert the name was cached
    const name = await debounceCache.getCachedArNSBaseName('name-1-1');
    assert.deepEqual(name, { name: 'name-1-1', processId: 'process-1' });
  });

  it('should use cached names within TTL period', async () => {
    let callCount = 0;
    const debounceCache = new ArNSNamesCache({
      log,
      registryCache,
      networkProcess: {
        getArNSRecords: async () => {
          callCount++;
          return {
            items: [
              {
                name: `name-${callCount}-1`,
                processId: `process-${callCount}`,
              },
            ],
            nextCursor: undefined,
          };
        },
      } as unknown as AoARIORead,
    });

    // let the cache hydrate
    await new Promise((resolve) => setTimeout(resolve, 10));

    // assert the name was cached
    const name = await debounceCache.getCachedArNSBaseName('name-1-1');
    assert.deepEqual(name, { name: 'name-1-1', processId: 'process-1' });

    // call it again and assert it's still cached and call count is still 1
    const name2 = await debounceCache.getCachedArNSBaseName('name-1-1');
    assert.deepEqual(name2, { name: 'name-1-1', processId: 'process-1' });
    assert.equal(callCount, 1);
  });

  it('should refresh cache when forced', async () => {
    let callCount = 0;
    const debounceCache = new ArNSNamesCache({
      log,
      registryCache,
      networkProcess: {
        getArNSRecords: async () => {
          callCount++;
          return {
            items: [
              {
                name: `name-${callCount}-1`,
                processId: `process-${callCount}`,
              },
            ],
            nextCursor: undefined,
          };
        },
      } as unknown as AoARIORead,
    });

    // let the cache hydrate
    await new Promise((resolve) => setTimeout(resolve, 10));

    // assert the name was cached
    const name = await debounceCache.getCachedArNSBaseName('name-1-1');
    assert.deepEqual(name, { name: 'name-1-1', processId: 'process-1' });

    // force refresh the cache
    await debounceCache.forceRefresh();

    // let the cache hydrate finish
    await new Promise((resolve) => setTimeout(resolve, 10));

    // assert call count is 2
    assert.equal(callCount, 2);

    // assert the cache was refreshed, but bc of the underlying buffer cache the previous name should is still returned
    const previousCachedName =
      await debounceCache.getCachedArNSBaseName('name-1-1');
    assert.deepEqual(previousCachedName, {
      name: 'name-1-1',
      processId: 'process-1',
    });

    // assert the cache size is updated with the new name
    const newCachedName = await debounceCache.getCachedArNSBaseName('name-2-1');
    assert.deepEqual(newCachedName, {
      name: 'name-2-1',
      processId: 'process-2',
    });
  });

  it('should return undefined if the name expires from the underlying kv cache and hydrating fails', async () => {
    let callCount = 0;
    const debounceCache = new ArNSNamesCache({
      log,
      registryCache,
      networkProcess: {
        getArNSRecords: async () => {
          callCount++;
          if (callCount === 1) {
            return {
              items: [
                {
                  name: `name-${callCount}`,
                  processId: `process-${callCount}`,
                },
              ],
              nextCursor: undefined,
            };
          }
          throw new Error('Network error');
        },
      } as unknown as AoARIORead,
    });

    // let the cache hydrate
    await new Promise((resolve) => setTimeout(resolve, 10));

    // on first call, the name is returned from the kv cache but the underlying kv cache expires it
    const name = await debounceCache.getCachedArNSBaseName('name-1');
    assert.deepEqual(name, {
      name: 'name-1',
      processId: 'process-1',
    });

    // let the underlying kv cache expire
    await new Promise((resolve) => setTimeout(resolve, 1000)); // wait the 1 second ttl for the name to expire from the kv cache

    // on second call, the name is not in the kv cache and hydrating fails
    const name2 = await debounceCache.getCachedArNSBaseName('name-1');
    assert.equal(name2, undefined);
  });

  it('should return last successful cached name from kv cache if hydrating fails and within the underlying kv cache ttl', async () => {
    let callCount = 0;
    const debounceCache = new ArNSNamesCache({
      log,
      registryCache,
      networkProcess: {
        getArNSRecords: async () => {
          callCount++;
          if (callCount === 1) {
            return {
              items: [
                {
                  name: `name-${callCount}`,
                  processId: `process-${callCount}`,
                },
              ],
              nextCursor: undefined,
            };
          }
          throw new Error('Network error');
        },
      } as unknown as AoARIORead,
    });

    // let the cache hydrate
    await new Promise((resolve) => setTimeout(resolve, 10));

    const name = await debounceCache.getCachedArNSBaseName('name-1');
    assert.deepEqual(name, { name: 'name-1', processId: 'process-1' });

    // force refresh the cache
    await debounceCache.forceRefresh();

    // let the cache hydrate finish
    await new Promise((resolve) => setTimeout(resolve, 10));

    // assert the name was refreshed
    const previousCachedName =
      await debounceCache.getCachedArNSBaseName('name-1');
    // should be undefined, but process-2 is cached
    assert.deepEqual(previousCachedName, {
      name: 'name-1',
      processId: 'process-1',
    });
  });

  it('should debounce on a cache miss', async () => {
    let callCount = 0;
    let lastCallTimestamp = 0;
    const debounceCache = new ArNSNamesCache({
      log,
      cacheHitDebounceTtl: 10000, // don't refresh the cache on a hit
      cacheMissDebounceTtl: 10, // cache miss should trigger a refresh within 10ms
      registryCache,
      networkProcess: {
        // on first call, return empty, then return success
        async getArNSRecords() {
          callCount++;
          lastCallTimestamp = Date.now();
          // on first two calls, return empty, then return success
          if (callCount === 1) {
            return {
              items: [],
              nextCursor: undefined,
            };
          }
          return {
            items: [
              { name: `name-${callCount}`, processId: `process-${callCount}` },
            ],
            nextCursor: undefined,
          };
        },
      } as unknown as AoARIORead,
    });

    // let the cache hydrate
    assert.equal(callCount, 1);

    // check a missing name, this should return not-found instantly since debounce is pending
    const missingNameAttempt1 =
      await debounceCache.getCachedArNSBaseName('name-2');
    assert.deepEqual(missingNameAttempt1, undefined);
    assert.equal(callCount, 1);

    // part way the through the debounce it should still be missing
    await new Promise((resolve) => setTimeout(resolve, 1));
    const missingNameAttempt2 =
      await debounceCache.getCachedArNSBaseName('name-2');
    assert.deepEqual(missingNameAttempt2, undefined);
    assert.equal(callCount, 1);

    // calling again after debounce is finished should hydrate the cache
    await new Promise((resolve) => setTimeout(resolve, 10));
    await debounceCache.getCachedArNSBaseName('name-2');
    // a subsequent call should return the name
    const missingNameAttempt3 =
      await debounceCache.getCachedArNSBaseName('name-2');
    assert.equal(callCount, 2);
    assert.deepEqual(missingNameAttempt3, {
      name: 'name-2',
      processId: 'process-2',
    });
    await new Promise((resolve) => setTimeout(resolve, 1));
  });

  it('should debounce on a cache hit', async () => {
    let callCount = 0;
    const debounceCache = new ArNSNamesCache({
      log,
      cacheHitDebounceTtl: 100, // don't refresh the cache on a hit
      cacheMissDebounceTtl: 1000, // longer cache miss to avoid refreshing on misses and validate cache hit refreshes
      registryCache,
      networkProcess: {
        async getArNSRecords() {
          callCount++;
          return {
            items: [
              { name: `name-${callCount}`, processId: `process-${callCount}` },
            ],
            nextCursor: undefined,
          };
        },
      } as unknown as AoARIORead,
    });

    // call count will get incremented on instantiation of the cache
    assert.equal(callCount, 1);

    await new Promise((resolve) => setTimeout(resolve, 5));

    // request a hit
    const cachedName = await debounceCache.getCachedArNSBaseName('name-1');
    assert.deepEqual(cachedName, { name: 'name-1', processId: 'process-1' });
    assert.equal(callCount, 1);

    // assert that cached name is returned if requested again within ttl
    const cachedName2 = await debounceCache.getCachedArNSBaseName('name-1');
    assert.deepEqual(cachedName2, cachedName);
    assert.equal(callCount, 1);
  });
});
