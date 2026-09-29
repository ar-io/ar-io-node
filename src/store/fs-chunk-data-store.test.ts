/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, before, beforeEach, describe, it } from 'node:test';
import crypto from 'node:crypto';

import { FsChunkDataStore } from './fs-chunk-data-store.js';
import { ChunkData, ChunkDataCacheIndex } from '../types.js';
import { createTestLogger } from '../../test/test-logger.js';

type SavedEntry = {
  dataRoot: string;
  size: number;
  lastWrite: number;
  tier: number;
};
type TouchedEntry = { dataRoot: string; lastAccess: number; tier: number };

/**
 * Recording stand-in for the SQLite-backed eviction index. Implements the full
 * ChunkDataCacheIndex surface so a signature drift in types.d.ts fails the
 * build here rather than silently skipping the hooks.
 */
class FakeChunkDataCacheIndex implements ChunkDataCacheIndex {
  saved: SavedEntry[] = [];
  touched: TouchedEntry[] = [];
  // Optional hook run inside saveChunkDataCacheEntry, so a test can observe
  // the world at the moment the write hook fires.
  onSave?: (entry: SavedEntry) => void;
  // When set, saveChunkDataCacheEntry rejects with it.
  saveError?: Error;
  // When true, saveChunkDataCacheEntry returns a promise that never settles.
  saveHangs = false;

  async saveChunkDataCacheEntry(entry: SavedEntry): Promise<void> {
    this.saved.push(entry);
    this.onSave?.(entry);
    if (this.saveHangs) {
      return new Promise<void>(() => undefined);
    }
    if (this.saveError !== undefined) {
      throw this.saveError;
    }
  }

  async touchChunkDataCacheEntry(
    dataRoot: string,
    lastAccess: number,
    tier: number,
  ): Promise<void> {
    this.touched.push({ dataRoot, lastAccess, tier });
  }

  async insertChunkDataCacheEntriesIfAbsent(): Promise<void> {
    throw new Error('not used by these tests');
  }

  async selectChunkDataCacheEvictionCandidates(): Promise<
    { dataRoot: string; size: number; chunkCount: number; lastWrite: number }[]
  > {
    throw new Error('not used by these tests');
  }

  async deleteChunkDataCacheEntries(): Promise<string[]> {
    throw new Error('not used by these tests');
  }

  async sumChunkDataCacheBytes(): Promise<number> {
    throw new Error('not used by these tests');
  }

  async countChunkDataCacheEntries(): Promise<number> {
    throw new Error('not used by these tests');
  }
}

// The hooks are fire-and-forget, so a synchronous assertion right after set()
// or get() can race the microtask that records them. Drain the microtask queue
// (plus a macrotask turn) before asserting.
const flush = async () => {
  await new Promise((resolve) => setImmediate(resolve));
};

describe('FsChunkDataStore', () => {
  let log: ReturnType<typeof createTestLogger>;
  let tempDir: string;
  let store: FsChunkDataStore;

  before(() => {
    log = createTestLogger({ suite: 'FsChunkDataStore' });
  });

  beforeEach(() => {
    // Create a temporary directory for each test
    tempDir = mkdtempSync(join(tmpdir(), 'fs-chunk-data-store-test-'));
    store = new FsChunkDataStore({ log, baseDir: tempDir });
  });

  afterEach(() => {
    // Clean up the temporary directory
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('write durability', () => {
    it('should retry the write when the data-root directory disappears mid-set', async () => {
      const dataRoot = 'wRq6f05oRupfTW_M5dcYBtwK5P8rSNYu20vC6D_o-M4';
      const relativeOffset = 0;
      const chunkData: ChunkData = {
        chunk: Buffer.from('survives a concurrent rmdir'),
        hash: crypto
          .createHash('sha256')
          .update('survives a concurrent rmdir')
          .digest(),
      };
      const fsp = (await import('node:fs')).promises;

      // Simulate the directory being reaped between mkdir and writeFile, which
      // is what data-root-granularity eviction will do. Without a retry the
      // ENOENT is swallowed and the chunk is silently lost.
      const realWriteFile = fsp.writeFile.bind(fsp);
      let firstAttempt = true;
      (fsp as any).writeFile = async (p: any, d: any) => {
        if (firstAttempt && String(p).includes('by-dataroot')) {
          firstAttempt = false;
          const err: any = new Error('ENOENT: no such file or directory');
          err.code = 'ENOENT';
          throw err;
        }
        return realWriteFile(p, d);
      };
      try {
        await store.set(dataRoot, relativeOffset, chunkData);
      } finally {
        (fsp as any).writeFile = realWriteFile;
      }

      assert.equal(await store.has(dataRoot, relativeOffset), true);
      const stream = await store.get(dataRoot, relativeOffset);
      assert.ok(stream !== undefined);
    });
  });

  describe('absolute offset symlink', () => {
    const dataRoot = 'wRq6f05oRupfTW_M5dcYBtwK5P8rSNYu20vC6D_o-M4';
    const relativeOffset = 0;
    const absoluteOffset = 388149830525175;
    const chunkData: ChunkData = {
      chunk: Buffer.from('test chunk data'),
      hash: crypto.createHash('sha256').update('test chunk data').digest(),
    };

    const symlinkPath = () =>
      join(
        tempDir,
        'data',
        'by-absolute-offset',
        '388',
        '149',
        absoluteOffset.toString(),
      );

    it('should not unlink when the existing link already points at the target', async () => {
      const fsp = (await import('node:fs')).promises;

      // First write establishes the link.
      await store.set(dataRoot, relativeOffset, chunkData, absoluteOffset);
      const before = await fsp.readlink(symlinkPath());

      // Unlinking before re-linking would leave a window where the index entry
      // does not exist; a concurrent read would see ENOENT and refetch data
      // that is already on disk. A rewrite of the same offset must therefore
      // leave the link untouched.
      let unlinked = false;
      const realUnlink = fsp.unlink.bind(fsp);
      (fsp as any).unlink = async (p: any) => {
        if (String(p).includes('by-absolute-offset')) unlinked = true;
        return realUnlink(p);
      };
      try {
        await store.set(dataRoot, relativeOffset, chunkData, absoluteOffset);
      } finally {
        (fsp as any).unlink = realUnlink;
      }

      assert.equal(unlinked, false, 'must not unlink an already-correct link');
      assert.equal(await fsp.readlink(symlinkPath()), before);
    });

    it('should replace the link when the target genuinely differs', async () => {
      const fsp = (await import('node:fs')).promises;
      const otherRoot = 'aBq6f05oRupfTW_M5dcYBtwK5P8rSNYu20vC6D_o-M4';

      await store.set(dataRoot, relativeOffset, chunkData, absoluteOffset);
      const first = await fsp.readlink(symlinkPath());

      // Replacement must be atomic too: unlinking the live path would
      // reintroduce the window this change closes, so the retarget has to go
      // through rename() and must never unlink the index path itself.
      let unlinkedIndexPath = false;
      const realUnlink = fsp.unlink.bind(fsp);
      (fsp as any).unlink = async (p: any) => {
        if (String(p) === symlinkPath()) unlinkedIndexPath = true;
        return realUnlink(p);
      };
      try {
        // Same absolute offset, different data root: the index must follow it.
        await store.set(otherRoot, relativeOffset, chunkData, absoluteOffset);
      } finally {
        (fsp as any).unlink = realUnlink;
      }
      const second = await fsp.readlink(symlinkPath());

      assert.equal(
        unlinkedIndexPath,
        false,
        'retarget must replace atomically, not unlink the live path',
      );
      assert.notEqual(second, first);
      assert.ok(second.includes(otherRoot));

      // No temporary links left behind.
      const dir = await fsp.readdir(
        join(tempDir, 'data', 'by-absolute-offset', '388', '149'),
      );
      assert.deepEqual(dir, [absoluteOffset.toString()]);
    });
  });

  describe('set', () => {
    it('should save chunk data to the correct path', async () => {
      const dataRoot = 'wRq6f05oRupfTW_M5dcYBtwK5P8rSNYu20vC6D_o-M4';
      const relativeOffset = 0;
      const chunkData: ChunkData = {
        chunk: Buffer.from('test chunk data'),
        hash: crypto.createHash('sha256').update('test chunk data').digest(),
      };

      await store.set(dataRoot, relativeOffset, chunkData);

      // Verify the file was created at the expected path
      const expectedPath = join(
        tempDir,
        'data',
        'by-dataroot',
        'wR',
        'q6',
        dataRoot,
        relativeOffset.toString(),
      );
      const fs = await import('node:fs');
      assert.ok(fs.existsSync(expectedPath));

      // Verify the content
      const savedContent = fs.readFileSync(expectedPath);
      assert.deepEqual(savedContent, chunkData.chunk);
    });

    it('should create nested directory structure', async () => {
      const dataRoot = '3nH8US975eWwHT-hG9HSdXFxH0FiMBBMHw6D_eBC7C0';
      const relativeOffset = 1048576;
      const chunkData: ChunkData = {
        chunk: Buffer.from('another chunk'),
        hash: crypto.createHash('sha256').update('another chunk').digest(),
      };

      await store.set(dataRoot, relativeOffset, chunkData);

      // Verify directory structure
      const fs = await import('node:fs');
      assert.ok(fs.existsSync(join(tempDir, 'data', 'by-dataroot')));
      assert.ok(fs.existsSync(join(tempDir, 'data', 'by-dataroot', '3n')));
      assert.ok(
        fs.existsSync(join(tempDir, 'data', 'by-dataroot', '3n', 'H8')),
      );
      assert.ok(
        fs.existsSync(
          join(tempDir, 'data', 'by-dataroot', '3n', 'H8', dataRoot),
        ),
      );
    });

    it('should handle multiple chunks for the same data root', async () => {
      const dataRoot = 'kB-rvhmqrG0CNSEY7KLuje2EdQgbsBMeL9Ck1-fC2es';
      const chunks = [
        { offset: 0, data: Buffer.from('chunk 0') },
        { offset: 262144, data: Buffer.from('chunk 1') },
        { offset: 524288, data: Buffer.from('chunk 2') },
      ];

      for (const { offset, data } of chunks) {
        const chunkData: ChunkData = {
          chunk: data,
          hash: crypto.createHash('sha256').update(data).digest(),
        };
        await store.set(dataRoot, offset, chunkData);
      }

      // Verify all chunks were saved
      const fs = await import('node:fs');
      for (const { offset } of chunks) {
        const path = join(
          tempDir,
          'data',
          'by-dataroot',
          'kB',
          '-r',
          dataRoot,
          offset.toString(),
        );
        assert.ok(fs.existsSync(path));
      }
    });

    it('should overwrite existing chunk data', async () => {
      const dataRoot = 'QUkmf47wCb77v7IG42spdNgJbmtPn_2DUfQtgpxRYvg';
      const relativeOffset = 0;

      const originalData: ChunkData = {
        chunk: Buffer.from('original data'),
        hash: crypto.createHash('sha256').update('original data').digest(),
      };

      const newData: ChunkData = {
        chunk: Buffer.from('new data'),
        hash: crypto.createHash('sha256').update('new data').digest(),
      };

      await store.set(dataRoot, relativeOffset, originalData);
      await store.set(dataRoot, relativeOffset, newData);

      // Verify the new data overwrote the original
      const fs = await import('node:fs');
      const path = join(
        tempDir,
        'data',
        'by-dataroot',
        'QU',
        'km',
        dataRoot,
        '0',
      );
      const savedContent = fs.readFileSync(path);
      assert.deepEqual(savedContent, newData.chunk);
    });
  });

  describe('get', () => {
    it('should retrieve previously saved chunk data', async () => {
      const dataRoot = 'jVn_rdsZx2nHYgKhhI25MzveuYvH7rCd8J0WIVp4EVs';
      const relativeOffset = 1024;
      const originalChunk = Buffer.from('test data for retrieval');
      const chunkData: ChunkData = {
        chunk: originalChunk,
        hash: crypto.createHash('sha256').update(originalChunk).digest(),
      };

      await store.set(dataRoot, relativeOffset, chunkData);
      const retrieved = await store.get(dataRoot, relativeOffset);

      assert.ok(retrieved);
      assert.deepEqual(retrieved.chunk, originalChunk);
      assert.deepEqual(retrieved.hash, chunkData.hash);
    });

    it('should return undefined for non-existent chunk', async () => {
      const result = await store.get('non-existent-root', 0);
      assert.strictEqual(result, undefined);
    });

    it('should calculate hash correctly when retrieving', async () => {
      const dataRoot = 'l14EgjvxeJeH6qJ4yqWQEQXy7UMPctMPAW26Ean-QEE';
      const relativeOffset = 0;
      const chunkContent = Buffer.from('content for hash verification');
      const expectedHash = crypto
        .createHash('sha256')
        .update(chunkContent)
        .digest();

      // Manually create the file to ensure we're testing hash calculation
      const fs = await import('node:fs');
      const dir = join(tempDir, 'data', 'by-dataroot', 'l1', '4E', dataRoot);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(join(dir, '0'), chunkContent);

      const retrieved = await store.get(dataRoot, relativeOffset);

      assert.ok(retrieved);
      assert.deepEqual(retrieved.hash, expectedHash);
    });

    it('should return undefined when file read fails', async () => {
      const dataRoot = 'SwiDNS9zjqMk0MZDAxW2yV_8gmdFmOmJpmq869u9STM';
      const relativeOffset = 0;

      // Create a directory instead of a file to cause read error
      const fs = await import('node:fs');
      const path = join(
        tempDir,
        'data',
        'by-dataroot',
        'Sw',
        'iD',
        dataRoot,
        '0',
      );
      fs.mkdirSync(path, { recursive: true });

      const result = await store.get(dataRoot, relativeOffset);
      assert.strictEqual(result, undefined);
    });
  });

  describe('has', () => {
    it('should return true for existing chunk', async () => {
      const dataRoot = 'YCBTU_-umYKVoBT_YtX0_rghFSl1bVROJydZQc_Dh4g';
      const relativeOffset = 2048;
      const chunkData: ChunkData = {
        chunk: Buffer.from('chunk for has test'),
        hash: crypto.createHash('sha256').update('chunk for has test').digest(),
      };

      await store.set(dataRoot, relativeOffset, chunkData);
      const exists = await store.has(dataRoot, relativeOffset);

      assert.strictEqual(exists, true);
    });

    it('should return false for non-existent chunk', async () => {
      const exists = await store.has('non-existent-root', 999);
      assert.strictEqual(exists, false);
    });

    it('should return false when directory exists but file does not', async () => {
      const dataRoot = 'aQHTabwvnlgqBDDgJmd_yhrp89gJCfbvwa8PgeOp4cI';

      // Create the directory structure without the file
      const fs = await import('node:fs');
      const dir = join(tempDir, 'data', 'by-dataroot', 'aQ', 'HT', dataRoot);
      fs.mkdirSync(dir, { recursive: true });

      const exists = await store.has(dataRoot, 0);
      assert.strictEqual(exists, false);
    });
  });

  describe('edge cases', () => {
    it('should handle very large relative offsets', async () => {
      const dataRoot = 'mLcNjqsYgNAeDWQCIhXATDkWtQ7739rJ2AbX3W6UTjo';
      const relativeOffset = 2147483647; // Max 32-bit integer
      const chunkData: ChunkData = {
        chunk: Buffer.from('large offset test'),
        hash: crypto.createHash('sha256').update('large offset test').digest(),
      };

      await store.set(dataRoot, relativeOffset, chunkData);
      const retrieved = await store.get(dataRoot, relativeOffset);

      assert.ok(retrieved);
      assert.deepEqual(retrieved.chunk, chunkData.chunk);
    });

    it('should refuse to cache zero-length chunk data', async () => {
      const dataRoot = 'tne4Fh9gC2AYX_ZUO5fV_ppKe0pwCwjOK4uTtg1OIjk';
      const relativeOffset = 0;
      const chunkData: ChunkData = {
        chunk: Buffer.alloc(0),
        hash: crypto.createHash('sha256').update(Buffer.alloc(0)).digest(),
      };

      // A zero-length chunk is invalid and would poison the cache, so set()
      // must drop it rather than persist it.
      await store.set(dataRoot, relativeOffset, chunkData);

      assert.strictEqual(await store.has(dataRoot, relativeOffset), false);
      assert.strictEqual(await store.get(dataRoot, relativeOffset), undefined);
    });

    it('should treat a pre-existing zero-length chunk file as a miss', async () => {
      // Simulates a cache entry poisoned before this guard existed: a 0-byte
      // file on disk must self-heal by reading as a miss (so the caller
      // refetches and overwrites it) rather than a valid empty chunk.
      const dataRoot = 'Pois0nedZZZ2nHYgKhhI25MzveuYvH7rCd8J0WIVp4EVs';
      const relativeOffset = 0;

      const fs = await import('node:fs');
      const dir = join(tempDir, 'data', 'by-dataroot', 'Po', 'is', dataRoot);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(join(dir, '0'), Buffer.alloc(0));

      // has() still reports the file exists...
      assert.strictEqual(await store.has(dataRoot, relativeOffset), true);
      // ...but get() must not serve the empty chunk.
      assert.strictEqual(await store.get(dataRoot, relativeOffset), undefined);
    });

    it('should treat a pre-existing zero-length absolute-offset entry as a miss', async () => {
      // A 0-byte file reachable via the by-absolute-offset index must also
      // self-heal as a miss rather than returning an empty chunk.
      const absoluteOffset = 51530681327863;
      // by-absolute-offset/{floor(abs/1e12)}/{floor(abs/1e9)%1000}/{abs}
      const fs = await import('node:fs');
      const dir = join(tempDir, 'data', 'by-absolute-offset', '51', '530');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(join(dir, String(absoluteOffset)), Buffer.alloc(0));

      assert.strictEqual(
        await store.getByAbsoluteOffset(absoluteOffset),
        undefined,
      );
    });

    it('should not create an absolute-offset index for a zero-length chunk', async () => {
      const dataRoot = 'zeroAbsIdxZZ2nHYgKhhI25MzveuYvH7rCd8J0WIVp4EVs';
      const relativeOffset = 0;
      const absoluteOffset = 51530681327863;
      const chunkData: ChunkData = {
        chunk: Buffer.alloc(0),
        hash: crypto.createHash('sha256').update(Buffer.alloc(0)).digest(),
      };

      // set() refuses the zero-length write before any index is created.
      await store.set(dataRoot, relativeOffset, chunkData, absoluteOffset);

      const fs = await import('node:fs');
      const indexPath = join(
        tempDir,
        'data',
        'by-absolute-offset',
        '51',
        '530',
        String(absoluteOffset),
      );
      assert.strictEqual(fs.existsSync(indexPath), false);
      assert.strictEqual(
        await store.getByAbsoluteOffset(absoluteOffset),
        undefined,
      );
    });
  });

  describe('error handling', () => {
    it('should handle write permission errors gracefully', async () => {
      const dataRoot = 'wD75deO8zEyEDs3iI2b_IPpw6kZ2hTfCEXGOrm0Xtpg';
      const relativeOffset = 0;
      const chunkData: ChunkData = {
        chunk: Buffer.from('permission test'),
        hash: crypto.createHash('sha256').update('permission test').digest(),
      };

      // Make the base directory read-only
      const fs = await import('node:fs');
      const baseDir = join(tempDir, 'data', 'by-dataroot');
      fs.mkdirSync(baseDir, { recursive: true });
      fs.chmodSync(baseDir, 0o444);

      try {
        // This should not throw, just log the error
        await store.set(dataRoot, relativeOffset, chunkData);
      } finally {
        // Restore permissions for cleanup
        fs.chmodSync(baseDir, 0o755);
      }

      // Verify nothing was written
      const exists = await store.has(dataRoot, relativeOffset);
      assert.strictEqual(exists, false);
    });
  });

  describe('chunk data cache index hooks', () => {
    const dataRoot = 'idxHookZZZ5oRupfTW_M5dcYBtwK5P8rSNYu20vC6D_o';
    const relativeOffset = 0;
    const payload = Buffer.from('indexed chunk payload');
    const chunkData: ChunkData = {
      chunk: payload,
      hash: crypto.createHash('sha256').update(payload).digest(),
    };
    const chunkPath = () =>
      join(
        tempDir,
        'data',
        'by-dataroot',
        'id',
        'xH',
        dataRoot,
        String(relativeOffset),
      );

    let index: FakeChunkDataCacheIndex;
    let indexedStore: FsChunkDataStore;

    beforeEach(() => {
      index = new FakeChunkDataCacheIndex();
      indexedStore = new FsChunkDataStore({
        log,
        baseDir: tempDir,
        chunkDataCacheIndex: index,
        updateOnRead: true,
      });
    });

    it('records an index entry with the written byte length and tier 0', async () => {
      await indexedStore.set(dataRoot, relativeOffset, chunkData);
      await flush();

      assert.equal(index.saved.length, 1);
      assert.equal(index.saved[0].dataRoot, dataRoot);
      // The evictor sizes batches from this, so it must be the bytes actually
      // written, not a nominal 256 KiB chunk size.
      assert.equal(index.saved[0].size, payload.length);
      assert.equal(index.saved[0].tier, 0);
      assert.equal(typeof index.saved[0].lastWrite, 'number');
      assert.ok(index.saved[0].lastWrite > 0);
    });

    it('records nothing for a zero-length chunk', async () => {
      // set() bails before touching the filesystem for a zero-length chunk, so
      // indexing it would create a row for bytes that are not on disk -- the
      // evictor would then account for phantom bytes it can never reclaim.
      const emptyChunk: ChunkData = {
        chunk: Buffer.alloc(0),
        hash: crypto.createHash('sha256').update(Buffer.alloc(0)).digest(),
      };

      await indexedStore.set(dataRoot, relativeOffset, emptyChunk);
      await flush();

      assert.equal(index.saved.length, 0);
      assert.equal(await indexedStore.has(dataRoot, relativeOffset), false);
    });

    it('does not fail the chunk write when the index rejects', async () => {
      index.saveError = new Error('index unavailable');

      await indexedStore.set(dataRoot, relativeOffset, chunkData);
      await flush();

      const fs = await import('node:fs');
      assert.ok(fs.existsSync(chunkPath()));
      assert.deepEqual(fs.readFileSync(chunkPath()), payload);
      assert.equal(await indexedStore.has(dataRoot, relativeOffset), true);
    });

    it('does not block the chunk write when the index never settles', async () => {
      // A stalled index worker must not stall chunk caching: the hook is
      // fire-and-forget, so set() has to resolve without awaiting it.
      index.saveHangs = true;

      await indexedStore.set(dataRoot, relativeOffset, chunkData);

      const fs = await import('node:fs');
      assert.ok(fs.existsSync(chunkPath()));
      assert.equal(await indexedStore.has(dataRoot, relativeOffset), true);
    });

    it('fires the write hook only after the bytes are on disk', async () => {
      // Ordering matters: an index row for a chunk that is not yet (or never)
      // written points the evictor at bytes that do not exist.
      const fs = await import('node:fs');
      let fileExistedAtHookTime: boolean | undefined;
      index.onSave = () => {
        fileExistedAtHookTime = fs.existsSync(chunkPath());
      };

      await indexedStore.set(dataRoot, relativeOffset, chunkData);
      await flush();

      assert.equal(fileExistedAtHookTime, true);
    });

    it('touches last_access on a cache hit when update-on-read is enabled', async () => {
      await indexedStore.set(dataRoot, relativeOffset, chunkData);
      await flush();
      index.touched = [];

      const retrieved = await indexedStore.get(dataRoot, relativeOffset);
      await flush();

      assert.ok(retrieved !== undefined);
      assert.equal(index.touched.length, 1);
      assert.equal(index.touched[0].dataRoot, dataRoot);
      assert.ok(index.touched[0].lastAccess > 0);
      assert.equal(index.touched[0].tier, 0);
      // A read must never advance last_write: that is the ingest-confirmation
      // age floor, and refreshing it on reads would let a hot chunk sit
      // permanently above the floor (or, worse, mask an unconfirmed one).
      assert.equal(index.saved.length, 1);
    });

    it('does not touch last_access on a cache hit when update-on-read is disabled', async () => {
      const fifoStore = new FsChunkDataStore({
        log,
        baseDir: tempDir,
        chunkDataCacheIndex: index,
        updateOnRead: false,
      });

      await fifoStore.set(dataRoot, relativeOffset, chunkData);
      await flush();

      const retrieved = await fifoStore.get(dataRoot, relativeOffset);
      await flush();

      assert.ok(retrieved !== undefined);
      assert.equal(index.touched.length, 0);
    });

    it('does not touch last_access on a cache miss', async () => {
      const retrieved = await indexedStore.get(dataRoot, relativeOffset);
      await flush();

      assert.equal(retrieved, undefined);
      assert.equal(index.touched.length, 0);
    });
  });

  describe('delDataRoot', () => {
    // The eviction unit is the whole data-root directory, so these guard the
    // primitive ChunkDataCacheEvictor unlinks with.
    const dataRoot = 'wRq6f05oRupfTW_M5dcYBtwK5P8rSNYu20vC6D_o-M4';
    const chunkData: ChunkData = {
      chunk: Buffer.from('del data root'),
      hash: crypto.createHash('sha256').update('del data root').digest(),
    };
    const rootDir = () =>
      join(tempDir, 'data', 'by-dataroot', 'wR', 'q6', dataRoot);

    it('removes every chunk under the data root', async () => {
      await store.set(dataRoot, 0, chunkData);
      await store.set(dataRoot, 262144, chunkData);
      assert.equal(await store.has(dataRoot, 0), true);
      assert.equal(await store.has(dataRoot, 262144), true);

      await store.delDataRoot(dataRoot);

      assert.equal(await store.has(dataRoot, 0), false);
      assert.equal(await store.has(dataRoot, 262144), false);
    });

    it('removes the data root directory itself, not just its files', async () => {
      const fs = await import('node:fs');
      await store.set(dataRoot, 0, chunkData);
      assert.equal(fs.existsSync(rootDir()), true);

      await store.delDataRoot(dataRoot);

      // Leaving the empty directory behind is the cost ADR 005 quantifies: 67%
      // of data-root dirs on the production volume are empty because nothing
      // ever rmdir'd them, and that is most of what makes the FS walk slow.
      assert.equal(fs.existsSync(rootDir()), false);
    });

    it('treats a missing data root as success', async () => {
      await store.delDataRoot(dataRoot);
    });

    // The evictor books reclaimed bytes on this return value. Index rows
    // routinely outlive their files -- the ingest GC, the filesystem-walk
    // worker and manual sweeps all unlink chunks without touching the index --
    // so reporting `true` for a directory that was already gone would credit
    // the evictor with bytes that `df` never shows.
    it('reports exactly what it reclaimed', async () => {
      // The evictor books reclaimed bytes on this, so it must describe the
      // filesystem rather than the index: rows routinely outlive their files.
      await store.set(dataRoot, 0, chunkData);
      const removed = await store.delDataRoot(dataRoot);
      assert.equal(removed.removedFiles, 1);
      assert.equal(removed.removedBytes, chunkData.chunk.length);
      assert.equal(removed.keptFiles, 0);

      const again = await store.delDataRoot(dataRoot);
      assert.deepEqual(again, {
        removedFiles: 0,
        removedBytes: 0,
        keptFiles: 0,
        failedFiles: 0,
      });
    });

    // The age floor, enforced per file against its own mtime. A directory-level
    // check is not enough: overwriting an existing offset updates the file's
    // mtime but never the parent directory's.
    it('keeps files newer than the age floor and removes the rest', async () => {
      const fs = await import('node:fs');
      await store.set(dataRoot, 0, chunkData);
      await store.set(dataRoot, 262144, chunkData);
      const dir = rootDir();
      const old = new Date(Date.now() - 10 * 3600 * 1000);
      fs.utimesSync(join(dir, '0'), old, old);

      const floor = Math.floor(Date.now() / 1000) - 3600;
      const result = await store.delDataRoot(dataRoot, floor);

      assert.equal(result.removedFiles, 1, 'the aged file is removed');
      assert.equal(result.keptFiles, 1, 'the fresh file is kept');
      assert.equal(fs.existsSync(join(dir, '0')), false);
      assert.equal(
        fs.existsSync(join(dir, '262144')),
        true,
        'a chunk inside the floor must survive eviction',
      );
      assert.equal(fs.existsSync(dir), true, 'directory kept while non-empty');
    });

    it('removes the directory once nothing is left in it', async () => {
      const fs = await import('node:fs');
      await store.set(dataRoot, 0, chunkData);
      const dir = rootDir();

      await store.delDataRoot(dataRoot);

      // ~93% of data-root directories on the production volume are empty
      // because nothing ever reaped them; that is most of the walk cost.
      assert.equal(fs.existsSync(dir), false);
    });

    // Root ignores mode bits (CAP_DAC_OVERRIDE), so the unlink would succeed
    // and the assertions invert. CLAUDE.md calls this out: run the suite as a
    // non-root user. Skip rather than fail misleadingly in a root container.
    it(
      'keeps a file it cannot remove rather than reporting it freed',
      {
        skip: process.getuid?.() === 0 ? 'requires a non-root uid' : false,
      },
      async () => {
        const fs = await import('node:fs');
        await store.set(dataRoot, 0, chunkData);
        // Unlinking a file needs write permission on the file's OWN directory,
        // so deny it there -- not on the grandparent, which only governs whether
        // the data-root directory itself can be removed.
        const dir = rootDir();
        fs.chmodSync(dir, 0o500);
        try {
          const result = await store.delDataRoot(dataRoot);
          // Must not claim bytes it did not free -- the evictor books on this.
          assert.equal(result.removedFiles, 0);
          assert.equal(result.removedBytes, 0);
          assert.equal(result.failedFiles, 1);
          assert.equal(result.keptFiles, 0);
        } finally {
          fs.chmodSync(dir, 0o755);
        }
      },
    );
  });
});
