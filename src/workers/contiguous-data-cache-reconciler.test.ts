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
import { after, before, describe, it } from 'node:test';

import { createTestLogger } from '../../test/test-logger.js';
import { ContiguousDataCacheIndex } from '../types.js';
import { ContiguousDataCacheReconciler } from './contiguous-data-cache-reconciler.js';

const log = createTestLogger();

const HASH_A = 'A'.repeat(43);
const HASH_B = 'B'.repeat(43);
const HASH_C = 'C'.repeat(43);

describe('ContiguousDataCacheReconciler', () => {
  let baseDir: string;

  after(async () => {
    await fs.promises.rm(baseDir, { recursive: true, force: true });
    await fs.promises.rm(`${baseDir}.ckpt`, { force: true });
  });

  before(async () => {
    baseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fscw-recon-'));
    // Sharded blob tree: baseDir/<hh>/<hh>/<hash>
    await fs.promises.mkdir(path.join(baseDir, 'AA', 'AA'), {
      recursive: true,
    });
    await fs.promises.mkdir(path.join(baseDir, 'BB', 'BB'), {
      recursive: true,
    });
    await fs.promises.writeFile(path.join(baseDir, 'AA', 'AA', HASH_A), 'aaaa');
    await fs.promises.writeFile(path.join(baseDir, 'AA', 'AA', HASH_B), 'bb');
    await fs.promises.writeFile(
      path.join(baseDir, 'BB', 'BB', HASH_C),
      'cccccc',
    );
    // Non-hash files must be ignored.
    await fs.promises.writeFile(
      path.join(baseDir, 'AA', 'AA', 'notahash'),
      'x',
    );
    await fs.promises.writeFile(path.join(baseDir, '.gitkeep'), '');
  });

  function makeIndex() {
    const inserted: {
      hash: string;
      size: number;
      cachedAt: number;
      tier: number;
    }[] = [];
    const batches: number[] = [];
    const cacheIndex = {
      insertContiguousDataCacheEntriesIfAbsent: async (entries: any[]) => {
        batches.push(entries.length);
        inserted.push(...entries);
      },
    } as unknown as ContiguousDataCacheIndex;
    return { cacheIndex, inserted, batches };
  }

  const checkpointPath = () => `${baseDir}.ckpt`;

  it('backfills every on-disk blob, ignores non-hash files, and clears the checkpoint on completion', async () => {
    const { cacheIndex, inserted, batches } = makeIndex();
    const reconciler = new ContiguousDataCacheReconciler({
      log,
      cacheIndex,
      baseDir,
      batchSize: 2, // force multiple flushes
      walkConcurrency: 4,
      checkpointPath: checkpointPath(),
    });
    await reconciler.run();

    const hashes = inserted.map((e) => e.hash).sort();
    assert.deepEqual(hashes, [HASH_A, HASH_B, HASH_C].sort());
    // Sizes come from the files; tier is general (0); cached_at is set.
    const byHash = new Map(inserted.map((e) => [e.hash, e]));
    assert.equal(byHash.get(HASH_A)!.size, 4);
    assert.equal(byHash.get(HASH_C)!.size, 6);
    for (const e of inserted) {
      assert.equal(e.tier, 0);
      assert.ok(e.cachedAt > 0);
    }
    // batchSize=2 with 3 blobs -> flushed in more than one batch.
    assert.ok(batches.length >= 2, `batches=${JSON.stringify(batches)}`);
    // A fully-completed pass clears its checkpoint.
    assert.equal(fs.existsSync(checkpointPath()), false);
  });

  it('resumes from a checkpoint, skipping already-completed shards', async () => {
    // Pretend shard "AA" completed in a prior run.
    await fs.promises.writeFile(checkpointPath(), 'AA');
    const { cacheIndex, inserted } = makeIndex();
    const reconciler = new ContiguousDataCacheReconciler({
      log,
      cacheIndex,
      baseDir,
      batchSize: 2,
      walkConcurrency: 4,
      checkpointPath: checkpointPath(),
    });
    await reconciler.run();

    // AA/* (HASH_A, HASH_B) skipped; only BB/* (HASH_C) is backfilled.
    assert.deepEqual(
      inserted.map((e) => e.hash),
      [HASH_C],
    );
  });
});
