/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';

import { createTestLogger } from '../../test/test-logger.js';
import {
  exampleManifestStreamV010,
  exampleManifestStreamV020IndexId,
} from '../../test/stubs.js';
import { ContiguousData, ManifestResolutionStore } from '../types.js';
import { StreamingManifestPathResolver } from './streaming-manifest-path-resolver.js';

const log = createTestLogger({ suite: 'StreamingManifestPathResolver' });

const INDEX_ID = 'cG7Hdi_iTQPoEYgQJFqJ8NMpN4KoZ-vH_j7pG4iP7NI';
const MOBILE_CSS_ID = 'fZ4d7bkCAUiXSfo3zFsPiQvpLVKVtXUKB6kiLNt2XVQ';
// v0.2.0 index id fixture resolves its root to this id.
const V020_INDEX_ID = 'QYWh-QsozsYu2wor0ZygI5Zoa_fRYFc8_X1RkYmw_fU';

const makeData = (stream: Readable): ContiguousData => ({
  stream,
  size: 0,
  verified: false,
  trusted: false,
  cached: false,
});

class FakeStore implements ManifestResolutionStore {
  rows = new Map<string, { indexId?: string; fallbackId?: string }>();
  saved: Array<{
    id: string;
    indexId?: string;
    fallbackId?: string;
    resolvedAt: number;
  }> = [];
  getCalls = 0;

  async getManifestResolution(id: string) {
    this.getCalls += 1;
    return this.rows.get(id);
  }

  async saveManifestResolution(args: {
    id: string;
    indexId?: string;
    fallbackId?: string;
    resolvedAt: number;
  }) {
    this.saved.push(args);
    this.rows.set(args.id, {
      indexId: args.indexId,
      fallbackId: args.fallbackId,
    });
  }
}

describe('StreamingManifestPathResolver', () => {
  describe('resolveFromIndex caching', () => {
    it('returns a cache miss (complete: false) before anything is resolved', async () => {
      const resolver = new StreamingManifestPathResolver({ log });
      const miss = await resolver.resolveFromIndex('unknown-id', 'some/path');
      assert.equal(miss.complete, false);
      assert.equal(miss.resolvedId, undefined);
    });

    it('serves a prior resolveFromData result from cache without a stream', async () => {
      const resolver = new StreamingManifestPathResolver({ log });

      const fromData = await resolver.resolveFromData(
        makeData(exampleManifestStreamV010()),
        'manifest-id',
        undefined,
      );
      assert.equal(fromData.resolvedId, INDEX_ID);
      assert.equal(fromData.resolutionType, 'index');
      assert.equal(fromData.complete, true);

      // resolveFromIndex takes no stream — a correct result here can only come
      // from the cache, proving the body fetch + parse is skipped on repeat.
      const cached = await resolver.resolveFromIndex('manifest-id', undefined);
      assert.equal(cached.complete, true);
      assert.equal(cached.resolvedId, INDEX_ID);
      assert.equal(cached.resolutionType, 'index');
    });

    it('caches negative resolutions so repeat 404s skip the body fetch', async () => {
      const resolver = new StreamingManifestPathResolver({ log });

      const fromData = await resolver.resolveFromData(
        makeData(exampleManifestStreamV010()),
        'manifest-id',
        'does/not/exist',
      );
      assert.equal(fromData.resolvedId, undefined);
      assert.equal(fromData.complete, true);

      const cached = await resolver.resolveFromIndex(
        'manifest-id',
        'does/not/exist',
      );
      // complete: true short-circuits the caller to a 404 without re-fetching.
      assert.equal(cached.complete, true);
      assert.equal(cached.resolvedId, undefined);
    });

    it('normalizes trailing slashes in the cache key', async () => {
      const resolver = new StreamingManifestPathResolver({ log });

      await resolver.resolveFromData(
        makeData(exampleManifestStreamV010()),
        'manifest-id',
        'css/mobile.css',
      );

      const cached = await resolver.resolveFromIndex(
        'manifest-id',
        'css/mobile.css/',
      );
      assert.equal(cached.complete, true);
      assert.equal(cached.resolvedId, MOBILE_CSS_ID);
      assert.equal(cached.resolutionType, 'path');
    });

    it('keys the cache by manifest id so unrelated manifests do not collide', async () => {
      const resolver = new StreamingManifestPathResolver({ log });

      await resolver.resolveFromData(
        makeData(exampleManifestStreamV010()),
        'manifest-a',
        undefined,
      );

      const other = await resolver.resolveFromIndex('manifest-b', undefined);
      assert.equal(other.complete, false);
      assert.equal(other.resolvedId, undefined);
    });
  });

  describe('persistent resolution store', () => {
    it('serves the root index from the store on a cold cache', async () => {
      const store = new FakeStore();
      store.rows.set('m1', { indexId: INDEX_ID });
      const resolver = new StreamingManifestPathResolver({ log, store });

      const result = await resolver.resolveFromIndex('m1', undefined);
      assert.equal(result.complete, true);
      assert.equal(result.resolvedId, INDEX_ID);
      assert.equal(result.resolutionType, 'index');
    });

    it('serves the root fallback from the store when no index is stored', async () => {
      const store = new FakeStore();
      store.rows.set('m1', { fallbackId: INDEX_ID });
      const resolver = new StreamingManifestPathResolver({ log, store });

      const result = await resolver.resolveFromIndex('m1', undefined);
      assert.equal(result.complete, true);
      assert.equal(result.resolvedId, INDEX_ID);
      assert.equal(result.resolutionType, 'fallback');
    });

    it('does not consult the store for sub-paths', async () => {
      const store = new FakeStore();
      store.rows.set('m1', { indexId: INDEX_ID });
      const resolver = new StreamingManifestPathResolver({ log, store });

      const result = await resolver.resolveFromIndex('m1', 'some/asset.js');
      assert.equal(result.complete, false);
      assert.equal(result.resolvedId, undefined);
      assert.equal(store.getCalls, 0);
    });

    it('persists the root index id after resolving from data', async () => {
      const store = new FakeStore();
      const resolver = new StreamingManifestPathResolver({ log, store });

      // v0.2.0 index-id fixture resolves its root to V020_INDEX_ID.
      const fromData = await resolver.resolveFromData(
        makeData(exampleManifestStreamV020IndexId()),
        'm2',
        undefined,
      );
      assert.equal(fromData.resolvedId, V020_INDEX_ID);
      assert.equal(fromData.resolutionType, 'index');

      // Persist is fire-and-forget but runs synchronously in the fake store.
      assert.equal(store.saved.length, 1);
      assert.equal(store.saved[0].id, 'm2');
      assert.equal(store.saved[0].indexId, V020_INDEX_ID);
      assert.equal(store.saved[0].fallbackId, undefined);
    });

    it('does not persist sub-path resolutions', async () => {
      const store = new FakeStore();
      const resolver = new StreamingManifestPathResolver({ log, store });

      // A missing sub-path resolves via the manifest fallback, but only the
      // root is ever persisted — sub-paths are never stored.
      await resolver.resolveFromData(
        makeData(exampleManifestStreamV020IndexId()),
        'm3',
        'missing',
      );
      assert.equal(store.saved.length, 0);
    });

    it('does not throw if the store lookup fails', async () => {
      const store = new FakeStore();
      store.getManifestResolution = async () => {
        throw new Error('boom');
      };
      const resolver = new StreamingManifestPathResolver({ log, store });

      const result = await resolver.resolveFromIndex('m4', undefined);
      assert.equal(result.complete, false);
      assert.equal(result.resolvedId, undefined);
    });

    it('works without a store (store is optional)', async () => {
      const resolver = new StreamingManifestPathResolver({ log });
      const result = await resolver.resolveFromIndex('m5', undefined);
      assert.equal(result.complete, false);
    });
  });
});
