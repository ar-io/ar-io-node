/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import Arweave from 'arweave';

import { createTestLogger } from '../../test/test-logger.js';
import * as config from '../config.js';
import * as metrics from '../metrics.js';
import {
  CHUNK_INGEST_ORIGIN_OPEN,
  ingestCacheOrigin,
  resyncPendingBytesEstimate,
  validateAndCacheIngestedChunk,
} from './ingest-chunk-cache.js';
import { toB64Url } from '../lib/encoding.js';

async function skippedDiskFullCount(): Promise<number> {
  const m = await metrics.chunkIngestCacheCounter.get();
  return (
    m.values.find((v) => v.labels.result === 'skipped_disk_full')?.value ?? 0
  );
}
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

  it('skips caching (no write) when the pending-bytes disk cap is exceeded', async () => {
    const { calls, ...deps } = makeStores();
    // Push the in-process pending estimate over the cap; the chunk must be
    // rejected at the disk guard (before validation or any storage write).
    resyncPendingBytesEstimate(config.CHUNK_INGEST_MAX_PENDING_BYTES + 1);
    const before = await skippedDiskFullCount();
    try {
      const body: JsonChunkPost = {
        data_root: toB64Url(Buffer.alloc(32)),
        chunk: toB64Url(Buffer.from('x'.repeat(256))),
        data_size: '256',
        data_path: toB64Url(Buffer.alloc(96)),
        offset: '255', // END offset of a 256-byte chunk -> START 0 (valid)
      };
      await validateAndCacheIngestedChunk({ ...deps, body, origin: 1, log });

      assert.equal((await skippedDiskFullCount()) - before, 1);
      assert.equal(calls.saved, 0);
      assert.equal(calls.setData, 0);
    } finally {
      resyncPendingBytesEstimate(0);
    }
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

  it('keys storage by the chunk START offset so the read path can find it', async () => {
    // Round-trip regression: a real (valid-proof) single-chunk tx starts at
    // byte 0, so every read path queries offset 0 — NOT the Arweave END offset
    // (data_size - 1) the chunk is POSTed with. The stores must be keyed by 0.
    const arweave = Arweave.init({
      host: 'localhost',
      port: 1984,
      protocol: 'http',
    });
    const wallet = await arweave.wallets.generate();
    const data = Buffer.from(
      'chunk-ingest start-offset regression ' + 'x'.repeat(64),
    );
    // Supply last_tx/reward so createTransaction does not fetch from a node.
    const tx = await arweave.createTransaction(
      { data, last_tx: '', reward: '0' },
      wallet,
    );
    await arweave.transactions.sign(tx, wallet);
    const chunk = tx.getChunk(0, data) as unknown as JsonChunkPost;

    let dataOffset: number | undefined;
    let metaOffset: number | undefined;
    let placementOffset: number | undefined;
    const chunkDataStore = {
      async set(_dr: string, ro: number) {
        dataOffset = ro;
      },
    } as unknown as ChunkDataStore;
    const chunkMetadataStore = {
      async set(m: { offset: number }) {
        metaOffset = m.offset;
      },
    } as unknown as ChunkMetadataStore;
    const chunkPlacementIndex = {
      async saveChunkPlacement(p: { relativeOffset: number }) {
        placementOffset = p.relativeOffset;
      },
    } as unknown as ChunkPlacementIndex;

    await validateAndCacheIngestedChunk({
      chunkDataStore,
      chunkMetadataStore,
      chunkPlacementIndex,
      body: chunk,
      origin: 1,
      log,
    });

    assert.equal(dataOffset, 0);
    assert.equal(metaOffset, 0);
    assert.equal(placementOffset, 0);
    assert.notEqual(Number(chunk.offset), 0); // sanity: END offset is non-zero
  });
});

describe('ingestCacheOrigin', () => {
  it('returns OPEN when the allowlist is empty (open ingest)', () => {
    const req = { headers: {}, socket: {} } as any;
    assert.equal(ingestCacheOrigin(req), CHUNK_INGEST_ORIGIN_OPEN);
  });
});
