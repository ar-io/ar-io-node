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

  it('should handle errors gracefully', async () => {
    let callCount = 0;

    const mockNetworkProcess = {
      async getArNSRecords() {
        callCount++;

        if (callCount === 1) {
          return {
            items: [
              {
                name: 'name-1',
              },
            ],
            nextCursor: undefined,
          };
        }

        throw new Error();
      },
    } as unknown as AoIORead;

    const cache = new ArNSNamesCache({
      log,
      networkProcess: mockNetworkProcess,
    });

    const initialNames = await cache.getNames();
    assert.deepEqual(initialNames, new Set(['name-1']));
    assert.equal(await cache.getCacheSize(), 1);

    // Now try to force update which should fail
    await assert.rejects(
      () => cache.getNames({ forceCacheUpdate: true }),
      /Failed to fetch ArNS records/,
    );
  });
});
