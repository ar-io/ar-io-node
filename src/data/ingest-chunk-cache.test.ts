/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createTestLogger } from '../../test/test-logger.js';
import {
  ingestCacheOrigin,
  validateAndCacheIngestedChunk,
} from './ingest-chunk-cache.js';
import { toB64Url } from '../lib/encoding.js';
import {
  ChunkDataStore,
  ChunkMetadataStore,
  ChunkPlacementIndex,
  JsonChunkPost,
} from '../types.js';

const log = createTestLogger();

function makeStores() {
  const calls = { setData: 0, setMeta: 0, saved: 0 };
  const chunkDataStore = {
    async set() {
      calls.setData++;
    },
  } as unknown as ChunkDataStore;
  const chunkMetadataStore = {
    async set() {
      calls.setMeta++;
    },
  } as unknown as ChunkMetadataStore;
  const chunkPlacementIndex = {
    async saveChunkPlacement() {
      calls.saved++;
    },
  } as unknown as ChunkPlacementIndex;
  return { calls, chunkDataStore, chunkMetadataStore, chunkPlacementIndex };
}

describe('validateAndCacheIngestedChunk', () => {
  it('rejects a chunk whose proof does not match, writing nothing', async () => {
    const { calls, ...deps } = makeStores();
    // data_path's leaf (slice(-64,-32)) will not equal sha256(chunk).
    const body: JsonChunkPost = {
      data_root: toB64Url(Buffer.alloc(32, 1)),
      chunk: toB64Url(Buffer.from('hello world')),
      data_size: '11',
      data_path: toB64Url(Buffer.alloc(96, 9)),
      offset: '10',
    };

    await validateAndCacheIngestedChunk({ ...deps, body, origin: 1, log });

    assert.equal(calls.setData, 0);
    assert.equal(calls.setMeta, 0);
    assert.equal(calls.saved, 0);
  });

  it('rejects non-integer offset/size before validating', async () => {
    const { calls, ...deps } = makeStores();
    const body: JsonChunkPost = {
      data_root: toB64Url(Buffer.alloc(32)),
      chunk: toB64Url(Buffer.from('x')),
      data_size: 'not-a-number',
      data_path: toB64Url(Buffer.alloc(96)),
      offset: '0',
    };

    await validateAndCacheIngestedChunk({ ...deps, body, origin: 1, log });

    assert.equal(calls.saved, 0);
  });
});

describe('ingestCacheOrigin', () => {
  it('returns null when ingest caching is disabled (default config)', () => {
    const req = { headers: {}, socket: {} } as any;
    assert.equal(ingestCacheOrigin(req), null);
  });
});
