/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import {
  existsSync,
  mkdtempSync,
  promises as fsPromises,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, before, beforeEach, describe, it } from 'node:test';

import { fromB64Url, toMsgpack } from '../lib/encoding.js';
import { FsChunkMetadataStore } from './fs-chunk-metadata-store.js';
import { ChunkMetadata } from '../types.js';
import { createTestLogger } from '../../test/test-logger.js';

// Two distinct data roots sharing the same 4-character prefix ('wRq6') —
// under prefix-only bucketing these collide onto the same metadata slot.
const DATA_ROOT_A = 'wRq6f05oRupfTW_M5dcYBtwK5P8rSNYu20vC6D_o-M4';
const DATA_ROOT_B = 'wRq63Q4N4df6jD6pPsS8PBmeGRbQUVwKVS91BB8rR90';

function makeChunkMetadata({
  dataRoot,
  offset = 0,
  dataPathFill = 1,
}: {
  dataRoot: string;
  offset?: number;
  dataPathFill?: number;
}): ChunkMetadata {
  return {
    data_root: fromB64Url(dataRoot),
    data_size: 30474,
    data_path: Buffer.alloc(64, dataPathFill),
    offset,
    hash: Buffer.alloc(32, dataPathFill),
    chunk_size: 30474,
  };
}

describe('FsChunkMetadataStore', () => {
  let log: ReturnType<typeof createTestLogger>;
  let tempDir: string;
  let store: FsChunkMetadataStore;

  before(() => {
    log = createTestLogger({ suite: 'FsChunkMetadataStore' });
  });

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'fs-chunk-metadata-store-test-'));
    store = new FsChunkMetadataStore({ log, baseDir: tempDir });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('set and get', () => {
    it('should round-trip chunk metadata keyed by the full data root', async () => {
      const metadata = makeChunkMetadata({ dataRoot: DATA_ROOT_A });

      await store.set(metadata);

      const expectedPath = join(
        tempDir,
        'wR',
        'q6',
        DATA_ROOT_A,
        'metadata',
        '0',
      );
      assert.ok(existsSync(expectedPath));

      const retrieved = await store.get(DATA_ROOT_A, 0);
      assert.ok(retrieved !== undefined);
      assert.ok(retrieved.data_root.equals(metadata.data_root));
      assert.ok(retrieved.data_path.equals(metadata.data_path));
      assert.equal(retrieved.data_size, metadata.data_size);
    });

    it('should not collide for data roots sharing a 4-character prefix', async () => {
      const metadataA = makeChunkMetadata({
        dataRoot: DATA_ROOT_A,
        dataPathFill: 1,
      });
      const metadataB = makeChunkMetadata({
        dataRoot: DATA_ROOT_B,
        dataPathFill: 2,
      });

      await store.set(metadataA);
      await store.set(metadataB);

      const retrievedA = await store.get(DATA_ROOT_A, 0);
      const retrievedB = await store.get(DATA_ROOT_B, 0);

      assert.ok(retrievedA !== undefined);
      assert.ok(retrievedB !== undefined);
      assert.ok(retrievedA.data_root.equals(fromB64Url(DATA_ROOT_A)));
      assert.ok(retrievedB.data_root.equals(fromB64Url(DATA_ROOT_B)));
      assert.ok(retrievedA.data_path.equals(Buffer.alloc(64, 1)));
      assert.ok(retrievedB.data_path.equals(Buffer.alloc(64, 2)));
    });

    it('should return undefined for a missing entry', async () => {
      assert.equal(await store.get(DATA_ROOT_A, 0), undefined);
    });
  });

  describe('get with mismatched cached data root', () => {
    it('should treat a foreign entry as a miss and remove it', async () => {
      // Simulate a poisoned cache entry: metadata for data root B stored
      // under data root A's path (as prefix-only bucketing used to allow).
      const foreign = makeChunkMetadata({ dataRoot: DATA_ROOT_B });
      const poisonedDir = join(tempDir, 'wR', 'q6', DATA_ROOT_A, 'metadata');
      await fsPromises.mkdir(poisonedDir, { recursive: true });
      const poisonedPath = join(poisonedDir, '0');
      await fsPromises.writeFile(poisonedPath, toMsgpack(foreign));

      const retrieved = await store.get(DATA_ROOT_A, 0);

      assert.equal(retrieved, undefined);
      assert.ok(!existsSync(poisonedPath));
    });
  });

  describe('getByAbsoluteOffset', () => {
    it('should resolve metadata through the absolute offset symlink', async () => {
      const absoluteOffset = 388149830525175;
      const metadata = makeChunkMetadata({ dataRoot: DATA_ROOT_A });

      await store.set(metadata, absoluteOffset);

      const retrieved = await store.getByAbsoluteOffset(absoluteOffset);
      assert.ok(retrieved !== undefined);
      assert.ok(retrieved.data_root.equals(metadata.data_root));
    });

    it('should return undefined when no symlink exists', async () => {
      assert.equal(await store.getByAbsoluteOffset(12345), undefined);
    });
  });

  describe('has and del', () => {
    it('should report presence and support deletion', async () => {
      const metadata = makeChunkMetadata({ dataRoot: DATA_ROOT_A });
      await store.set(metadata);

      assert.equal(await store.has(DATA_ROOT_A, 0), true);
      await store.del(DATA_ROOT_A, 0);
      assert.equal(await store.has(DATA_ROOT_A, 0), false);
    });

    it('should not throw when deleting a missing entry', async () => {
      await assert.doesNotReject(store.del(DATA_ROOT_A, 0));
    });
  });
});
