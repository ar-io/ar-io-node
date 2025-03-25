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
import { describe, it, beforeEach, mock } from 'node:test';
import winston from 'winston';
import { CompositeArNSResolver } from './composite-arns-resolver.js';
import { NameResolution, NameResolver } from '../types.js';
import { KvArNSResolutionStore } from '../store/kv-arns-name-resolution-store.js';
import { KvArNSRegistryStore } from '../store/kv-arns-base-name-store.js';

const log = winston.createLogger({ silent: true });
const mockResolution: NameResolution = {
  name: 'test.ar',
  resolvedId: 'tx1',
  resolvedAt: Date.now(),
  ttl: 300,
  processId: 'process1',
  limit: 1,
  index: 1,
};

describe('CompositeArNSResolver', () => {
  const mockResolutionCache = {
    get: mock.fn(),
    set: mock.fn(),
  } as unknown as KvArNSResolutionStore;

  const mockRegistryCache = {
    get: mock.fn(),
    set: mock.fn(),
  } as unknown as KvArNSRegistryStore;

  beforeEach(() => {
    mock.reset();
  });

  it('should return early when first resolver succeeds', async () => {
    const resolver1: NameResolver = {
      resolve: mock.fn(async () => mockResolution),
    };

    const resolver2: NameResolver = {
      resolve: mock.fn(async () => {
        throw new Error('Should not be called');
      }),
    };

    const compositeResolver = new CompositeArNSResolver({
      log,
      resolvers: [resolver1, resolver2],
      resolutionCache: mockResolutionCache,
      registryCache: mockRegistryCache,
      maxConcurrentResolutions: 2,
    });

    const result = await compositeResolver.resolve({ name: 'test.ar' });

    assert.strictEqual((resolver1.resolve as any).mock.calls.length, 1);
    assert.strictEqual((resolver2.resolve as any).mock.calls.length, 1);
    assert.deepEqual(result, mockResolution);
  });

  it('should try all resolvers when earlier ones fail', async () => {
    const resolver1: NameResolver = {
      resolve: mock.fn(async () => {
        throw new Error('Failed');
      }),
    };

    const resolver2: NameResolver = {
      resolve: mock.fn(async () => mockResolution),
    };

    const compositeResolver = new CompositeArNSResolver({
      log,
      resolvers: [resolver1, resolver2],
      resolutionCache: mockResolutionCache,
      registryCache: mockRegistryCache,
      maxConcurrentResolutions: 2,
    });

    const result = await compositeResolver.resolve({ name: 'test.ar' });

    assert.strictEqual((resolver1.resolve as any).mock.calls.length, 1);
    assert.strictEqual((resolver2.resolve as any).mock.calls.length, 1);
    assert.deepEqual(result, mockResolution);
  });

  it('should use cached resolution when available and not expired', async () => {
    const now = Date.now();
    const mockResolution: NameResolution = {
      name: 'test.ar',
      resolvedId: 'tx1',
      resolvedAt: now - 100000,
      ttl: 300,
      processId: 'process1',
      limit: 1,
      index: 1,
    };

    mock.method(mockResolutionCache, 'get', async () =>
      Buffer.from(JSON.stringify(mockResolution)),
    );

    const resolver1: NameResolver = {
      resolve: mock.fn(),
    };

    const compositeResolver = new CompositeArNSResolver({
      log,
      resolvers: [resolver1],
      resolutionCache: mockResolutionCache,
      registryCache: mockRegistryCache,
      maxConcurrentResolutions: 2,
    });

    const result = await compositeResolver.resolve({ name: 'test.ar' });

    assert.strictEqual((resolver1.resolve as any).mock.calls.length, 0);
    assert.deepEqual(result, mockResolution);
  });

  it('should handle resolver timeouts correctly', async () => {
    const resolver1: NameResolver = {
      resolve: mock.fn(
        async () => new Promise((resolve) => setTimeout(resolve, 1000)),
      ),
    };

    const resolver2: NameResolver = {
      resolve: mock.fn(async () => mockResolution),
    };

    const compositeResolver = new CompositeArNSResolver({
      log,
      resolvers: [resolver1, resolver2],
      resolutionCache: mockResolutionCache,
      registryCache: mockRegistryCache,
      maxConcurrentResolutions: 2,
    });

    const result = await compositeResolver.resolve({ name: 'test.ar' });

    assert.strictEqual((resolver1.resolve as any).mock.calls.length, 1);
    assert.strictEqual((resolver2.resolve as any).mock.calls.length, 1);
    assert.deepEqual(result, mockResolution);
  });

  it('should return undefined resolution when all resolvers fail', async () => {
    const resolver1: NameResolver = {
      resolve: mock.fn(async () => {
        throw new Error('Failed 1');
      }),
    };

    const resolver2: NameResolver = {
      resolve: mock.fn(async () => {
        throw new Error('Failed 2');
      }),
    };

    const compositeResolver = new CompositeArNSResolver({
      log,
      resolvers: [resolver1, resolver2],
      resolutionCache: mockResolutionCache,
      registryCache: mockRegistryCache,
      maxConcurrentResolutions: 2,
    });

    const result = await compositeResolver.resolve({ name: 'test.ar' });

    assert.deepEqual(result, {
      name: 'test.ar',
      resolvedId: undefined,
      resolvedAt: undefined,
      ttl: undefined,
      processId: undefined,
      limit: undefined,
      index: undefined,
    });
  });

  it('should respect maxConcurrentResolutions limit', async () => {
    let activeResolutions = 0;
    let maxActiveResolutions = 0;
    let resolversCalled = 0;
    const totalResolvers = 4;

    const createResolver = (): NameResolver => ({
      resolve: mock.fn(async () => {
        resolversCalled++;
        activeResolutions++;
        maxActiveResolutions = Math.max(
          maxActiveResolutions,
          activeResolutions,
        );

        await Promise.resolve();

        activeResolutions--;
        return {
          name: 'test.ar',
          resolvedId: undefined,
          resolvedAt: undefined,
          ttl: undefined,
          processId: undefined,
          limit: undefined,
          index: undefined,
        };
      }),
    });

    const resolvers = Array(totalResolvers)
      .fill(null)
      .map(() => createResolver());

    const compositeResolver = new CompositeArNSResolver({
      log,
      resolvers,
      resolutionCache: mockResolutionCache,
      registryCache: mockRegistryCache,
      maxConcurrentResolutions: 2,
    });

    await compositeResolver.resolve({ name: 'test.ar' });

    assert.equal(
      maxActiveResolutions,
      2,
      'Max concurrent resolutions exceeded limit',
    );
    assert.equal(
      resolversCalled,
      totalResolvers,
      'Not all resolvers were called',
    );
  });
});
