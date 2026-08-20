/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { createTestLogger } from '../../test/test-logger.js';
import { ChunkDataCacheIndex } from '../types.js';
import { ChunkDataCacheReconciler } from './chunk-data-cache-reconciler.js';

const log = createTestLogger();

const HOUR = 3600;

// Realistic 43-char base64url data roots whose first four characters match the
// two-level shard directories they live under (FsChunkDataStore layout).
const DATA_ROOT_A = `aaaa${'A'.repeat(39)}`;
const DATA_ROOT_EMPTY = `aaaa${'B'.repeat(39)}`;
const DATA_ROOT_B = `bbbb${'C'.repeat(39)}`;

type Row = {
  dataRoot: string;
  size: number;
  chunkCount: number;
  lastWrite: number;
  lastAccess: number;
  tier: number;
};

const tempDirs: string[] = [];

/**
 * Build a real on-disk chunk cache tree:
 *
 *   <baseDir>/aa/aa/<DATA_ROOT_A>/{0,262144,524288}  (3 chunks, distinct sizes
 *                                                     and explicit mtimes)
 *   <baseDir>/aa/aa/<DATA_ROOT_EMPTY>/               (empty -- must yield no row)
 *   <baseDir>/bb/bb/<DATA_ROOT_B>/{0, 262144 -> symlink into DATA_ROOT_A}
 *   <baseDir>/by-absolute-offset/1/2/{symlink,stray} (must never be indexed)
 */
async function buildTree(nowSec: number): Promise<string> {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'chunk-recon-'),
  );
  tempDirs.push(root);
  const baseDir = path.join(root, 'data', 'by-dataroot');

  const dirA = path.join(baseDir, 'aa', 'aa', DATA_ROOT_A);
  const dirB = path.join(baseDir, 'bb', 'bb', DATA_ROOT_B);
  await fs.promises.mkdir(dirA, { recursive: true });
  await fs.promises.mkdir(path.join(baseDir, 'aa', 'aa', DATA_ROOT_EMPTY), {
    recursive: true,
  });
  await fs.promises.mkdir(dirB, { recursive: true });

  await fs.promises.writeFile(path.join(dirA, '0'), 'a'.repeat(4));
  await fs.promises.writeFile(path.join(dirA, '262144'), 'b'.repeat(2));
  await fs.promises.writeFile(path.join(dirA, '524288'), 'c'.repeat(6));
  await fs.promises.writeFile(path.join(dirB, '0'), 'd'.repeat(5));

  // Deliberately-differing timestamps, all far in the past, so a row seeded
  // from the walk clock is unmistakably distinguishable from one derived from
  // the files. Note 524288 is the newest write and 262144 the newest access,
  // and 0's atime is OLDER than its mtime (the max(atime, mtime) fallback).
  fs.utimesSync(path.join(dirA, '0'), nowSec - 20 * HOUR, nowSec - 14 * HOUR);
  fs.utimesSync(
    path.join(dirA, '262144'),
    nowSec - 3 * HOUR,
    nowSec - 12 * HOUR,
  );
  fs.utimesSync(
    path.join(dirA, '524288'),
    nowSec - 10 * HOUR,
    nowSec - 10 * HOUR,
  );
  fs.utimesSync(path.join(dirB, '0'), nowSec - HOUR, nowSec - HOUR);

  // The absolute-offset index: symlinks back into the primary tree. Indexing it
  // would double-count every chunk. The stray regular file stands in for
  // anything non-symlink that lands there.
  const offsetDir = path.join(baseDir, 'by-absolute-offset', '1', '2');
  await fs.promises.mkdir(offsetDir, { recursive: true });
  await fs.promises.symlink(
    path.relative(offsetDir, path.join(dirA, '0')),
    path.join(offsetDir, '1000000000'),
  );
  await fs.promises.writeFile(path.join(offsetDir, '2000000000'), 'zzzz');

  // A symlink that has landed inside the primary tree (a relocated or
  // hand-made absolute-offset entry). Only regular files are chunk data;
  // following this one would count DATA_ROOT_A's bytes a second time.
  await fs.promises.symlink(
    path.relative(dirB, path.join(dirA, '0')),
    path.join(dirB, '262144'),
  );

  return baseDir;
}

function makeIndex() {
  const inserted: Row[] = [];
  const batches: number[] = [];
  const cacheIndex = {
    insertChunkDataCacheEntriesIfAbsent: async (entries: Row[]) => {
      batches.push(entries.length);
      inserted.push(...entries);
    },
  } as unknown as ChunkDataCacheIndex;
  return { cacheIndex, inserted, batches };
}

describe('ChunkDataCacheReconciler', () => {
  after(async () => {
    for (const dir of tempDirs) {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it('emits one aggregated row per populated data root', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const baseDir = await buildTree(nowSec);
    const { cacheIndex, inserted } = makeIndex();
    await new ChunkDataCacheReconciler({
      log,
      cacheIndex,
      baseDir,
      batchSize: 1, // force multiple flushes
      walkConcurrency: 4,
      checkpointPath: path.join(baseDir, '..', 'ckpt'),
    }).run();

    assert.deepEqual(
      inserted.map((e) => e.dataRoot).sort(),
      [DATA_ROOT_A, DATA_ROOT_B].sort(),
    );
    const byRoot = new Map(inserted.map((e) => [e.dataRoot, e]));
    // size is the SUM over the data root's chunk files, chunkCount their count.
    assert.equal(byRoot.get(DATA_ROOT_A)!.size, 4 + 2 + 6);
    assert.equal(byRoot.get(DATA_ROOT_A)!.chunkCount, 3);
    assert.equal(byRoot.get(DATA_ROOT_B)!.size, 5);
    assert.equal(byRoot.get(DATA_ROOT_B)!.chunkCount, 1);
    for (const e of inserted) {
      assert.equal(e.tier, 0);
    }
  });

  it('derives lastWrite from MAX(mtime) of the chunk files, not the walk time', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const baseDir = await buildTree(nowSec);
    const { cacheIndex, inserted } = makeIndex();
    await new ChunkDataCacheReconciler({
      log,
      cacheIndex,
      baseDir,
      batchSize: 10,
      walkConcurrency: 4,
      checkpointPath: path.join(baseDir, '..', 'ckpt'),
    }).run();

    const rowA = inserted.find((e) => e.dataRoot === DATA_ROOT_A)!;
    // Newest mtime under DATA_ROOT_A is 10h old (files are 14h/12h/10h old).
    assert.ok(
      Math.abs(rowA.lastWrite - (nowSec - 10 * HOUR)) <= 2,
      `lastWrite=${rowA.lastWrite} expected~${nowSec - 10 * HOUR} (now=${nowSec})`,
    );
    // Seeding lastWrite with the walk clock would park every row inside the
    // evictor's age floor (WHERE last_write <= now - minAgeSeconds) and stall
    // eviction entirely, so assert it is emphatically not "now".
    assert.ok(
      nowSec - rowA.lastWrite > 9 * HOUR,
      `lastWrite=${rowA.lastWrite} looks like the walk time (now=${nowSec})`,
    );
  });

  it('derives lastAccess from MAX(max(atime, mtime)), not the walk time', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const baseDir = await buildTree(nowSec);
    const { cacheIndex, inserted } = makeIndex();
    await new ChunkDataCacheReconciler({
      log,
      cacheIndex,
      baseDir,
      batchSize: 10,
      walkConcurrency: 4,
      checkpointPath: path.join(baseDir, '..', 'ckpt'),
    }).run();

    const rowA = inserted.find((e) => e.dataRoot === DATA_ROOT_A)!;
    // Newest max(atime, mtime) under DATA_ROOT_A is the 3h-old atime of 262144.
    // (File 0 has an atime OLDER than its mtime, so it contributes its mtime.)
    assert.ok(
      Math.abs(rowA.lastAccess - (nowSec - 3 * HOUR)) <= 2,
      `lastAccess=${rowA.lastAccess} expected~${nowSec - 3 * HOUR} (now=${nowSec})`,
    );
    // Seeding lastAccess from the walk clock would make the whole cache look
    // uniformly hot and destroy LRU ordering.
    assert.ok(
      nowSec - rowA.lastAccess > 2 * HOUR,
      `lastAccess=${rowA.lastAccess} looks like the walk time (now=${nowSec})`,
    );
  });

  it('emits no row for an empty data root directory', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const baseDir = await buildTree(nowSec);
    const { cacheIndex, inserted } = makeIndex();
    await new ChunkDataCacheReconciler({
      log,
      cacheIndex,
      baseDir,
      batchSize: 10,
      walkConcurrency: 4,
      checkpointPath: path.join(baseDir, '..', 'ckpt'),
    }).run();

    assert.equal(
      inserted.some((e) => e.dataRoot === DATA_ROOT_EMPTY),
      false,
      `empty data root was indexed: ${JSON.stringify(inserted)}`,
    );
    // No zero-size / zero-chunk placeholder rows at all.
    for (const e of inserted) {
      assert.ok(e.chunkCount > 0);
      assert.ok(e.size > 0);
    }
  });

  it('does not index the by-absolute-offset subtree', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const baseDir = await buildTree(nowSec);
    const { cacheIndex, inserted } = makeIndex();
    await new ChunkDataCacheReconciler({
      log,
      cacheIndex,
      baseDir,
      batchSize: 10,
      walkConcurrency: 4,
      checkpointPath: path.join(baseDir, '..', 'ckpt'),
    }).run();

    assert.deepEqual(
      inserted.map((e) => e.dataRoot).sort(),
      [DATA_ROOT_A, DATA_ROOT_B].sort(),
    );
    // The symlinked chunk must not be counted a second time anywhere.
    const totalSize = inserted.reduce((sum, e) => sum + e.size, 0);
    const totalChunks = inserted.reduce((sum, e) => sum + e.chunkCount, 0);
    assert.equal(totalSize, 4 + 2 + 6 + 5);
    assert.equal(totalChunks, 4);
  });

  it('resumes from a checkpoint, skipping already-completed shards', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const baseDir = await buildTree(nowSec);
    const checkpointPath = path.join(baseDir, '..', 'ckpt');
    // Pretend shard "aa" completed in a prior run.
    await fs.promises.writeFile(checkpointPath, 'aa');
    const { cacheIndex, inserted } = makeIndex();
    await new ChunkDataCacheReconciler({
      log,
      cacheIndex,
      baseDir,
      batchSize: 10,
      walkConcurrency: 4,
      checkpointPath,
    }).run();

    assert.deepEqual(
      inserted.map((e) => e.dataRoot),
      [DATA_ROOT_B],
    );
  });

  it('clears the checkpoint after a fully-completed pass', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const baseDir = await buildTree(nowSec);
    const checkpointPath = path.join(baseDir, '..', 'ckpt');
    const { cacheIndex } = makeIndex();
    const reconciler = new ChunkDataCacheReconciler({
      log,
      cacheIndex,
      baseDir,
      batchSize: 10,
      walkConcurrency: 4,
      checkpointPath,
    });
    await reconciler.run();
    assert.equal(fs.existsSync(checkpointPath), false);
  });

  it('does not advance the checkpoint past a shard aborted by stop()', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const baseDir = await buildTree(nowSec);
    const checkpointPath = path.join(baseDir, '..', 'ckpt');
    const inserted: Row[] = [];
    // Indirection so the index can abort the reconciler that owns it.
    const stopper = { stop: async () => {} };
    const cacheIndex = {
      // Abort from inside the first flush, i.e. mid-walk of shard "aa".
      insertChunkDataCacheEntriesIfAbsent: async (entries: Row[]) => {
        inserted.push(...entries);
        await stopper.stop();
      },
    } as unknown as ChunkDataCacheIndex;
    const reconciler = new ChunkDataCacheReconciler({
      log,
      cacheIndex,
      baseDir,
      batchSize: 1, // flush (and therefore abort) on the first data root
      walkConcurrency: 4,
      checkpointPath,
    });
    stopper.stop = () => reconciler.stop();
    await reconciler.run();

    // Shard "aa" never finished, so nothing may be recorded as completed --
    // otherwise a restart would skip data roots that were never indexed.
    assert.equal(
      fs.existsSync(checkpointPath),
      false,
      `checkpoint advanced to "${fs.existsSync(checkpointPath) ? fs.readFileSync(checkpointPath, 'utf8') : ''}" after an aborted shard`,
    );
    // The abort really did cut the pass short.
    assert.ok(inserted.length < 2, `inserted=${JSON.stringify(inserted)}`);
  });

  // A stop() landing part-way through a data-root directory must emit NOTHING
  // for it. The aggregate built so far understates size/chunk_count and -- the
  // dangerous part -- can understate lastWrite, which is the age floor the
  // evictor filters on. A too-old lastWrite makes the row evictable sooner
  // than it should be, and eviction removes the entire data-root directory, so
  // a fresh chunk the walk never reached is destroyed. Backfill inserts with
  // ON CONFLICT DO NOTHING, so such a row is never repaired by a re-run.
  it('emits no row for a data root whose walk was aborted part-way', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const baseDir = await buildTree(nowSec);
    const { cacheIndex, inserted } = makeIndex();

    const reconciler = new ChunkDataCacheReconciler({
      log,
      cacheIndex,
      baseDir,
      checkpointPath: path.join(baseDir, '..', '.abort-ckpt'),
      batchSize: 100,
      walkConcurrency: 1,
    } as any);

    // Abort as soon as the first chunk file of DATA_ROOT_A has been stat'd, so
    // the directory is left half-aggregated: its newest file (524288) has not
    // been seen yet, making the partial lastWrite older than the truth.
    const realStat = fs.promises.stat;
    let stats = 0;
    (fs.promises as any).stat = async (p: any) => {
      const result = await realStat(p);
      stats++;
      if (stats === 1) {
        reconciler.stop();
      }
      return result;
    };
    try {
      await reconciler.run();
    } finally {
      (fs.promises as any).stat = realStat;
    }

    const partial = inserted.find((e) => e.dataRoot === DATA_ROOT_A);
    assert.equal(
      partial,
      undefined,
      `a partially-walked data root must not be indexed, got ${JSON.stringify(partial)}`,
    );
  });
});
