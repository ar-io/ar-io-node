/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { ARIORead } from '@ar.io/sdk';
import { describe, it, beforeEach, mock } from 'node:test';
import { CompositeArNSResolver } from './composite-arns-resolver.js';
import { NameResolution, NameResolver } from '../types.js';
import { KvArNSResolutionStore } from '../store/kv-arns-name-resolution-store.js';
import { KvArNSRegistryStore } from '../store/kv-arns-base-name-store.js';
import { ArNSNamesCache } from './arns-names-cache.js';
import { createTestLogger } from '../../test/test-logger.js';

const log = createTestLogger({ suite: 'CompositeArNSResolver' });
const mockResolution: NameResolution = {
  name: 'test.ar',
  resolvedId: 'tx1',
  resolvedAt: Date.now(),
  ttl: 300,
  antId: 'process1',
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

  // Only used to build a default ArNSNamesCache; every test passes its own
  // arnsNamesCache, so the network process is never called.
  const unusedNetworkProcess = {} as ARIORead;

  beforeEach(() => {
    mock.reset();
  });

  it('should return early when first resolver succeeds', async () => {
    const resolver1: NameResolver = {
      resolve: mock.fn(async () => mockResolution),
    };

    const resolver2: NameResolver = {
      resolve: mock.fn(async () => {
        throw new Error();
      }),
    };

    const compositeResolver = new CompositeArNSResolver({
      log,
      resolvers: [resolver1, resolver2],
      resolutionCache: mockResolutionCache,
      registryCache: mockRegistryCache,
      networkProcess: unusedNetworkProcess,
      arnsNamesCache: {} as ArNSNamesCache, // unused, avoids unawaited promises
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
      networkProcess: unusedNetworkProcess,
      arnsNamesCache: {} as ArNSNamesCache, // unused, avoids unawaited promises
      maxConcurrentResolutions: 2,
      resolverTimeoutMs: 50,
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
      antId: 'process1',
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
      networkProcess: unusedNetworkProcess,
      arnsNamesCache: {} as ArNSNamesCache, // unused, avoids unawaited promises
      maxConcurrentResolutions: 2,
      resolverTimeoutMs: 50,
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
      networkProcess: unusedNetworkProcess,
      arnsNamesCache: {} as ArNSNamesCache, // unused, avoids unawaited promises
      maxConcurrentResolutions: 2,
      resolverTimeoutMs: 50,
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
      networkProcess: unusedNetworkProcess,
      arnsNamesCache: {} as ArNSNamesCache, // unused, avoids unawaited promises
      maxConcurrentResolutions: 2,
      resolverTimeoutMs: 50,
    });

    const result = await compositeResolver.resolve({ name: 'test.ar' });

    assert.deepEqual(result, {
      name: 'test.ar',
      resolvedId: undefined,
      resolvedAt: undefined,
      ttl: undefined,
      antId: undefined,
      limit: undefined,
      index: undefined,
    });
  });

  describe('logging when no resolver resolves the name', () => {
    // Records every call by level; child() returns the same recorder so the
    // resolver's own child logger is captured too.
    const recordingLog = () => {
      const calls: { level: string; message: string }[] = [];
      const logger: any = {};
      for (const level of ['error', 'warn', 'info', 'verbose', 'debug']) {
        logger[level] = (message: string) => calls.push({ level, message });
      }
      logger.child = () => logger;
      return { logger, calls };
    };
    const miss = async (): Promise<NameResolution> => ({
      name: 'unregistered',
      resolvedId: undefined,
      resolvedAt: undefined,
      ttl: undefined,
      antId: undefined,
      limit: undefined,
      index: undefined,
    });

    it('logs no error or warning for an unregistered name', async () => {
      const { logger, calls } = recordingLog();
      const compositeResolver = new CompositeArNSResolver({
        log: logger,
        resolvers: [{ resolve: miss }, { resolve: miss }],
        resolutionCache: mockResolutionCache,
        registryCache: mockRegistryCache,
        networkProcess: unusedNetworkProcess,
        arnsNamesCache: {} as ArNSNamesCache, // unused, avoids unawaited promises
        maxConcurrentResolutions: 2,
        resolverTimeoutMs: 50,
      });

      const result = await compositeResolver.resolve({ name: 'unregistered' });

      assert.equal(result.resolvedId, undefined);
      assert.deepEqual(
        calls.filter((c) => c.level === 'error' || c.level === 'warn'),
        [],
      );
    });

    it('still logs an error when a resolver times out', async () => {
      const { logger, calls } = recordingLog();
      const compositeResolver = new CompositeArNSResolver({
        log: logger,
        resolvers: [
          { resolve: miss },
          {
            resolve: async () =>
              new Promise<NameResolution>((resolve) =>
                setTimeout(() => resolve(mockResolution), 1000),
              ),
          },
        ],
        resolutionCache: mockResolutionCache,
        registryCache: mockRegistryCache,
        networkProcess: unusedNetworkProcess,
        arnsNamesCache: {} as ArNSNamesCache, // unused, avoids unawaited promises
        maxConcurrentResolutions: 2,
        resolverTimeoutMs: 50,
        lastResolverTimeoutMs: 50,
      });

      await compositeResolver.resolve({ name: 'slow' });

      assert.ok(
        calls.some(
          (c) =>
            c.level === 'error' &&
            c.message.startsWith('Error during parallel resolution'),
        ),
      );
    });
  });

  it('falls back to cached resolution when fresh resolver returns undefined fast (PE-9075)', async () => {
    const now = Date.now();
    const expiredCachedResolution: NameResolution = {
      name: 'test.ar',
      resolvedId: 'cached-tx',
      resolvedAt: now - 1_000_000, // expired (resolvedAt + ttl*1000 < now)
      ttl: 300,
      antId: 'process1',
      limit: 1,
      index: 1,
    };

    mock.method(mockResolutionCache, 'get', async () =>
      Buffer.from(JSON.stringify(expiredCachedResolution)),
    );

    const resolver1: NameResolver = {
      resolve: mock.fn(async () => {
        // Fast-fail: throws synchronously, resolveParallel returns undefined
        // well within arnsCachedResolutionFallbackTimeoutMs.
        throw new Error('RPC dry-run failed');
      }),
    };

    const compositeResolver = new CompositeArNSResolver({
      log,
      resolvers: [resolver1],
      resolutionCache: mockResolutionCache,
      registryCache: mockRegistryCache,
      networkProcess: unusedNetworkProcess,
      arnsNamesCache: {} as ArNSNamesCache, // unused, avoids unawaited promises
      maxConcurrentResolutions: 1,
      resolverTimeoutMs: 1000,
      arnsCachedResolutionFallbackTimeoutMs: 1000,
    });

    const result = await compositeResolver.resolve({ name: 'test.ar' });

    assert.strictEqual((resolver1.resolve as any).mock.calls.length, 1);
    assert.deepEqual(result, expiredCachedResolution);
  });

  it('falls back to cached resolution when fresh resolver exceeds the cached-resolution fallback timeout', async () => {
    const now = Date.now();
    const expiredCachedResolution: NameResolution = {
      name: 'test.ar',
      resolvedId: 'cached-tx',
      resolvedAt: now - 1_000_000,
      ttl: 300,
      antId: 'process1',
      limit: 1,
      index: 1,
    };

    mock.method(mockResolutionCache, 'get', async () =>
      Buffer.from(JSON.stringify(expiredCachedResolution)),
    );

    const resolver1: NameResolver = {
      resolve: mock.fn(
        async () =>
          new Promise<NameResolution>((resolve) =>
            setTimeout(
              () =>
                resolve({
                  name: 'test.ar',
                  resolvedId: 'fresh-tx',
                  resolvedAt: Date.now(),
                  ttl: 300,
                  antId: 'process1',
                  limit: 1,
                  index: 1,
                }),
              500,
            ),
          ),
      ),
    };

    const compositeResolver = new CompositeArNSResolver({
      log,
      resolvers: [resolver1],
      resolutionCache: mockResolutionCache,
      registryCache: mockRegistryCache,
      networkProcess: unusedNetworkProcess,
      arnsNamesCache: {} as ArNSNamesCache, // unused, avoids unawaited promises
      maxConcurrentResolutions: 1,
      resolverTimeoutMs: 1000,
      lastResolverTimeoutMs: 1000,
      arnsCachedResolutionFallbackTimeoutMs: 50,
    });

    const result = await compositeResolver.resolve({ name: 'test.ar' });

    assert.deepEqual(result, expiredCachedResolution);
  });

  it('returns undefined resolution when fresh resolver fast-fails AND no cached resolution exists (PE-9075)', async () => {
    mock.method(mockResolutionCache, 'get', async () => undefined);

    const resolver1: NameResolver = {
      resolve: mock.fn(async () => {
        throw new Error('RPC dry-run failed');
      }),
    };

    const compositeResolver = new CompositeArNSResolver({
      log,
      resolvers: [resolver1],
      resolutionCache: mockResolutionCache,
      registryCache: mockRegistryCache,
      networkProcess: unusedNetworkProcess,
      arnsNamesCache: {} as ArNSNamesCache, // unused, avoids unawaited promises
      maxConcurrentResolutions: 1,
      resolverTimeoutMs: 1000,
      arnsCachedResolutionFallbackTimeoutMs: 1000,
    });

    const result = await compositeResolver.resolve({ name: 'test.ar' });

    assert.deepEqual(result, {
      name: 'test.ar',
      resolvedId: undefined,
      resolvedAt: undefined,
      ttl: undefined,
      antId: undefined,
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
          antId: undefined,
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
      networkProcess: unusedNetworkProcess,
      arnsNamesCache: {} as ArNSNamesCache, // unused, avoids unawaited promises
      maxConcurrentResolutions: 2,
      resolverTimeoutMs: 50,
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
