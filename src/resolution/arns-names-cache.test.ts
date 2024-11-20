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
import winston from 'winston';
import { ArNSNamesCache } from './arns-names-cache.js';
import { AoIORead } from '@ar.io/sdk';

const createMockNetworkProcess = () => {
  let callCount = 0;
  return {
    async getArNSRecords() {
      callCount++;
      return {
        items: [
          {
            name: `name-${callCount}-1`,
          },
          {
            name: `name-${callCount}-2`,
          },
          {
            name: `name-${callCount}-3`,
          },
        ],
        nextCursor: undefined,
      };
    },
  } as unknown as AoIORead;
};

describe('ArNSNamesCache', () => {
  const log = winston.createLogger({
    transports: [new winston.transports.Console({ silent: true })],
  });

  it('should fetch and cache names on initialization', async () => {
    const cache = new ArNSNamesCache({
      log,
      networkProcess: createMockNetworkProcess(),
    });

    const names = await cache.getNames();
    assert.deepEqual(names, new Set(['name-1-1', 'name-1-2', 'name-1-3']));
    assert.equal(await cache.getCacheSize(), 3);
  });

  it('should use cached names within TTL period', async () => {
    const cacheTtl = 1000;
    const cache = new ArNSNamesCache({
      log,
      networkProcess: createMockNetworkProcess(),
      cacheTtl,
    });

    const names1 = await cache.getNames();
    assert.deepEqual(names1, new Set(['name-1-1', 'name-1-2', 'name-1-3']));
    assert.equal(await cache.getCacheSize(), 3);

    const names2 = await cache.getNames();
    assert.deepEqual(names2, new Set(['name-1-1', 'name-1-2', 'name-1-3']));
    assert.equal(await cache.getCacheSize(), 3);
  });

  it('should refresh cache when forced', async () => {
    const cache = new ArNSNamesCache({
      log,
      networkProcess: createMockNetworkProcess(),
    });

    const names1 = await cache.getNames();
    assert.deepEqual(names1, new Set(['name-1-1', 'name-1-2', 'name-1-3']));
    assert.equal(await cache.getCacheSize(), 3);

    const names2 = await cache.getNames({ forceCacheUpdate: true });
    assert.deepEqual(names2, new Set(['name-2-1', 'name-2-2', 'name-2-3']));
    assert.equal(await cache.getCacheSize(), 3);
  });

  it('should refresh cache after TTL expires', async () => {
    const cacheTtl = 100;
    const cache = new ArNSNamesCache({
      log,
      networkProcess: createMockNetworkProcess(),
      cacheTtl,
    });

    const names1 = await cache.getNames();
    assert.deepEqual(names1, new Set(['name-1-1', 'name-1-2', 'name-1-3']));
    assert.equal(await cache.getCacheSize(), 3);

    // Wait for cache to expire
    await new Promise((resolve) => setTimeout(resolve, cacheTtl + 10));

    const names2 = await cache.getNames();
    assert.deepEqual(names2, new Set(['name-2-1', 'name-2-2', 'name-2-3']));
    assert.equal(await cache.getCacheSize(), 3);
  });

  it('should retry on failure and succeed within max retries', async () => {
    let callCount = 0;
    const mockNetworkProcess = {
      async getArNSRecords() {
        callCount++;
        if (callCount <= 2) {
          throw new Error('Temporary failure');
        }
        return {
          items: [{ name: 'success-after-retry' }],
          nextCursor: undefined,
        };
      },
    } as unknown as AoIORead;

    const cache = new ArNSNamesCache({
      log,
      networkProcess: mockNetworkProcess,
      maxRetries: 3,
      retryDelay: 0,
    });

    const names = await cache.getNames();
    assert.deepEqual(names, new Set(['success-after-retry']));
    assert.equal(callCount, 3);
  });

  it('should fail after exhausting all retry attempts', async () => {
    let callCount = 0;
    const mockNetworkProcess = {
      async getArNSRecords() {
        callCount++;
        throw new Error(`Attempt ${callCount} failed`);
      },
    } as unknown as AoIORead;

    const cache = new ArNSNamesCache({
      log,
      networkProcess: mockNetworkProcess,
      maxRetries: 3,
      retryDelay: 0,
    });

    await assert.rejects(
      () => cache.getNames(),
      /Failed to fetch ArNS records after 3 attempts/,
    );
    assert.equal(callCount, 3);
  });

  it('should respect the retry delay between attempts', async () => {
    let callCount = 0;
    const timestamps: number[] = [];

    const mockNetworkProcess = {
      async getArNSRecords() {
        callCount++;
        timestamps.push(Date.now());
        if (callCount < 3) {
          throw new Error('Temporary failure');
        }
        return {
          items: [{ name: 'success' }],
          nextCursor: undefined,
        };
      },
    } as unknown as AoIORead;

    const retryDelay = 100;
    const cache = new ArNSNamesCache({
      log,
      networkProcess: mockNetworkProcess,
      maxRetries: 3,
      retryDelay,
    });

    await cache.getNames();

    assert.ok(timestamps[1] - timestamps[0] >= retryDelay);
    assert.ok(timestamps[2] - timestamps[1] >= retryDelay);
  });

  it('should handle empty results as failures and retry', async () => {
    let callCount = 0;
    const mockNetworkProcess = {
      async getArNSRecords() {
        callCount++;
        if (callCount < 2) {
          return { items: [], nextCursor: undefined };
        }
        return {
          items: [{ name: 'success' }],
          nextCursor: undefined,
        };
      },
    } as unknown as AoIORead;

    const cache = new ArNSNamesCache({
      log,
      networkProcess: mockNetworkProcess,
      maxRetries: 3,
      retryDelay: 0,
    });

    const names = await cache.getNames();
    assert.deepEqual(names, new Set(['success']));
    assert.equal(callCount, 2);
  });

  it('should return last successful names if all retry attempts fail', async () => {
    let callCount = 0;
    const mockNetworkProcess = {
      async getArNSRecords() {
        callCount++;
        if (callCount === 1) {
          return {
            items: [{ name: 'initial-success' }],
            nextCursor: undefined,
          };
        }
        throw new Error('Network error');
      },
    } as unknown as AoIORead;

    const cache = new ArNSNamesCache({
      log,
      networkProcess: mockNetworkProcess,
      maxRetries: 3,
      retryDelay: 0,
    });

    const initialNames = await cache.getNames();
    assert.deepEqual(initialNames, new Set(['initial-success']));

    const updatedNames = await cache.getNames({ forceCacheUpdate: true });
    assert.deepEqual(updatedNames, new Set(['initial-success']));
    assert.equal(callCount, 4); // 1 initial + 3 retry attempts
  });

  it('should throw error if all retries fail and no previous successful cache exists', async () => {
    let callCount = 0;
    const mockNetworkProcess = {
      async getArNSRecords() {
        callCount++;
        throw new Error(`Attempt ${callCount} failed`);
      },
    } as unknown as AoIORead;

    const cache = new ArNSNamesCache({
      log,
      networkProcess: mockNetworkProcess,
      maxRetries: 3,
      retryDelay: 0,
    });

    await assert.rejects(
      () => cache.getNames(),
      /Failed to fetch ArNS records after 3 attempts/,
    );
    assert.equal(callCount, 3);
  });
});
