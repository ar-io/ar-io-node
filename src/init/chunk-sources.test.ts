/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createTestLogger } from '../../test/test-logger.js';
import { FsChunkDataStore } from '../store/fs-chunk-data-store.js';
import { ChunkData, ChunkDataCacheIndex } from '../types.js';
import { createChunkDataSource } from './chunk-sources.js';

const DATA_ROOT = 'wRq6f05oRupfTW_M5dcYBtwK5P8rSNYu20vC6D_o-M4';
const payload = Buffer.from('chunk served from the network');
const chunkData: ChunkData = {
  chunk: payload,
  hash: crypto.createHash('sha256').update(payload).digest(),
};

// Records the write hook; the rest of the index surface is unused here.
class RecordingIndex implements ChunkDataCacheIndex {
  saved: { dataRoot: string; size: number }[] = [];
  async saveChunkDataCacheEntry(entry: {
    dataRoot: string;
    size: number;
  }): Promise<void> {
    this.saved.push({ dataRoot: entry.dataRoot, size: entry.size });
  }
  async touchChunkDataCacheEntry(): Promise<void> {}
  async insertChunkDataCacheEntriesIfAbsent(): Promise<void> {}
  async selectChunkDataCacheEvictionCandidates() {
    return [];
  }
  async deleteChunkDataCacheEntries(): Promise<string[]> {
    return [];
  }
  async sumChunkDataCacheBytes(): Promise<number> {
    return 0;
  }
  async countChunkDataCacheEntries(): Promise<number> {
    return 0;
  }
}

// Stands in for the network: the only configured chunk data source.
const networkSource = {
  async getChunkDataByAny(): Promise<ChunkData> {
    return chunkData;
  },
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('createChunkDataSource', () => {
  const log = createTestLogger({ suite: 'createChunkDataSource' });
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'chunk-sources-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const params = {
    txSize: 256000,
    absoluteOffset: 51530681327863,
    dataRoot: DATA_ROOT,
    relativeOffset: 0,
  };

  // ar-io-node #944: the read-through cache built its own, unindexed store, so
  // chunks cached on the serving path never reached the eviction index.
  it('caches served chunks through the given store, so they reach the eviction index', async () => {
    const index = new RecordingIndex();
    const chunkDataStore = new FsChunkDataStore({
      log,
      baseDir: tempDir,
      chunkDataCacheIndex: index,
    });
    const source = createChunkDataSource({
      log,
      arweaveClient: networkSource as any,
      chunkDataRetrievalOrder: ['arweave-network'],
      chunkDataSourceParallelism: 1,
      chunkDataStore,
    });

    const served = await source.getChunkDataByAny(params);
    await flush();

    assert.deepEqual(served.chunk, payload);
    assert.equal(await chunkDataStore.has(DATA_ROOT, 0), true);
    assert.deepEqual(index.saved, [
      { dataRoot: DATA_ROOT, size: payload.length },
    ]);
  });
});
