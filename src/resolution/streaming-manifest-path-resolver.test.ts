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
import { exampleManifestStreamV010 } from '../../test/stubs.js';
import { ContiguousData } from '../types.js';
import { StreamingManifestPathResolver } from './streaming-manifest-path-resolver.js';

const log = createTestLogger({ suite: 'StreamingManifestPathResolver' });

const INDEX_ID = 'cG7Hdi_iTQPoEYgQJFqJ8NMpN4KoZ-vH_j7pG4iP7NI';
const MOBILE_CSS_ID = 'fZ4d7bkCAUiXSfo3zFsPiQvpLVKVtXUKB6kiLNt2XVQ';

const makeData = (stream: Readable): ContiguousData => ({
  stream,
  size: 0,
  verified: false,
  trusted: false,
  cached: false,
});

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
});
