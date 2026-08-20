/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import { StandaloneSqliteDatabaseWorker } from '../database/standalone-sqlite.js';
import { FsChunkDataStore } from '../store/fs-chunk-data-store.js';
import { ChunkDataCacheEvictor } from './chunk-data-cache-evictor.js';
import { ChunkDataCacheReconciler } from './chunk-data-cache-reconciler.js';
import { createTestLogger } from '../../test/test-logger.js';
import { toB64Url } from '../lib/encoding.js';
import {
  bundlesDbPath,
  chunksDb,
  chunksDbPath,
  coreDbPath,
  dataDbPath,
  moderationDbPath,
} from '../../test/sqlite-helpers.js';

const log = createTestLogger({ suite: 'chunk-data-cache-integration' });

/**
 * End-to-end wiring test for ADR 005: the REAL SQL statements, the REAL
 * filesystem store (including its write/read hooks and delDataRoot), the REAL
 * evictor and the REAL backfill reconciler, driven together.
 *
 * The unit tests around each layer use in-memory fakes, so a mismatch between
 * a fake and the statement it stands in for is invisible to them. This does
 * not: every assertion below goes through the actual chunks.db statements.
 *
 * Only `statfs` is faked -- there is no portable way to fill a real disk.
 */
function fakeStatfs(usedPercent: number) {
  const blocks = 100;
  const bavail = Math.max(0, blocks - usedPercent);
  return { blocks, bavail, bsize: 1_000_000_000 } as unknown as fs.StatsFs;
}

const dataRootFor = (fill: number) => toB64Url(Buffer.alloc(32, fill));

/**
 * Adapts the synchronous worker to the async ChunkDataCacheIndex the store and
 * evictor consume, and tracks in-flight hook writes so a test can await the
 * fire-and-forget write/read hooks deterministically.
 */
function makeIndex(worker: StandaloneSqliteDatabaseWorker) {
  const pending: Promise<unknown>[] = [];
  const track = <T>(fn: () => T): Promise<T> => {
    const p = Promise.resolve().then(fn);
    pending.push(p);
    return p;
  };
  return {
    index: {
      saveChunkDataCacheEntry: (entry: any) =>
        track(() => worker.saveChunkDataCacheEntry(entry)),
      touchChunkDataCacheEntry: (
        dataRoot: string,
        lastAccess: number,
        tier: number,
      ) =>
        track(() =>
          worker.touchChunkDataCacheEntry(dataRoot, lastAccess, tier),
        ),
      insertChunkDataCacheEntriesIfAbsent: (entries: any[]) =>
        track(() => worker.insertChunkDataCacheEntriesIfAbsent(entries)),
      selectChunkDataCacheEvictionCandidates: (
        maxLastWrite: number,
        limit: number,
      ) =>
        track(() =>
          worker.selectChunkDataCacheEvictionCandidates(maxLastWrite, limit),
        ),
      deleteChunkDataCacheEntries: (
        dataRoots: string[],
        maxLastWrite: number,
      ) =>
        track(() =>
          worker.deleteChunkDataCacheEntries(dataRoots, maxLastWrite),
        ),
      sumChunkDataCacheBytes: () =>
        track(() => worker.sumChunkDataCacheBytes()),
      countChunkDataCacheEntries: () =>
        track(() => worker.countChunkDataCacheEntries()),
    } as any,
    flush: async () => {
      while (pending.length > 0) {
        await Promise.all(pending.splice(0));
      }
    },
  };
}

const row = (dataRoot: string): any =>
  chunksDb
    .prepare('SELECT * FROM chunk_data_cache WHERE data_root = ?')
    .get(dataRoot);

const chunkOf = (text: string) => ({
  chunk: Buffer.from(text),
  hash: crypto.createHash('sha256').update(text).digest(),
});

const dirOf = (base: string, dataRoot: string) =>
  join(
    base,
    'data',
    'by-dataroot',
    dataRoot.substring(0, 2),
    dataRoot.substring(2, 4),
    dataRoot,
  );

describe('chunk data cache index (end-to-end)', () => {
  let worker: StandaloneSqliteDatabaseWorker;
  let tempDir: string;
  let store: FsChunkDataStore;
  let index: any;
  let flush: () => Promise<void>;

  before(() => {
    worker = new StandaloneSqliteDatabaseWorker({
      log,
      coreDbPath,
      dataDbPath,
      moderationDbPath,
      bundlesDbPath,
      chunksDbPath,
      tagSelectivity: {},
    });
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'chunk-cache-e2e-'));
    const made = makeIndex(worker);
    index = made.index;
    flush = made.flush;
    store = new FsChunkDataStore({
      log,
      baseDir: tempDir,
      chunkDataCacheIndex: index,
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    mock.restoreAll();
  });

  const makeEvictor = (overrides: Record<string, unknown> = {}) =>
    new ChunkDataCacheEvictor({
      log,
      chunkDataStore: store,
      cacheIndex: index,
      usagePath: tempDir,
      lowWatermarkPercent: 60,
      highWatermarkPercent: 80,
      minFreeBytes: 0,
      intervalMs: 999_999,
      batchSize: 100,
      minAgeSeconds: 0,
      targetBytes: 0,
      ...overrides,
    } as any);

  it('write hook records real rows through the real statements', async () => {
    const dr = dataRootFor(1);
    await store.set(dr, 0, chunkOf('aaaa'));
    await store.set(dr, 262144, chunkOf('bbbbbb'));
    await flush();

    const r = row(dr);
    assert.equal(r.chunk_count, 2, 'both writes counted');
    assert.equal(r.size, 10, 'sizes accumulated (4 + 6)');
    assert.equal(r.tier, 0);
    assert.ok(r.last_write > 0);
  });

  it('a read advances last_access but never last_write', async () => {
    const dr = dataRootFor(2);
    await store.set(dr, 0, chunkOf('cccc'));
    await flush();
    const before = row(dr);

    // Age last_write and last_access into the past so a touch is observable.
    chunksDb
      .prepare(
        'UPDATE chunk_data_cache SET last_write = ?, last_access = ? WHERE data_root = ?',
      )
      .run(before.last_write - 500, before.last_access - 500, dr);

    const got = await store.get(dr, 0);
    await flush();

    assert.ok(got !== undefined, 'cache hit');
    const after = row(dr);
    assert.equal(
      after.last_write,
      before.last_write - 500,
      'a read must not move the age floor',
    );
    assert.ok(
      after.last_access > before.last_access - 500,
      'a read must refresh recency',
    );
  });

  it('evicts the coldest data root and really removes its files', async () => {
    const cold = dataRootFor(3);
    const warm = dataRootFor(4);
    await store.set(cold, 0, chunkOf('cold-chunk'));
    await store.set(warm, 0, chunkOf('warm-chunk'));
    await flush();
    chunksDb
      .prepare(
        'UPDATE chunk_data_cache SET last_access = ? WHERE data_root = ?',
      )
      .run(1, cold);

    assert.equal(fs.existsSync(dirOf(tempDir, cold)), true);
    let used = 95;
    mock.method(fs.promises, 'statfs', async () => fakeStatfs(used));
    const evictor = makeEvictor({ batchSize: 1 });
    // One batch frees enough to recover.
    const originalDel = store.delDataRoot.bind(store);
    (store as any).delDataRoot = async (dr: string) => {
      await originalDel(dr);
      used = 50;
    };

    await evictor.sweep();
    await flush();

    assert.equal(row(cold), undefined, 'cold row deleted');
    assert.equal(
      fs.existsSync(dirOf(tempDir, cold)),
      false,
      'cold data root directory removed from disk',
    );
    assert.ok(row(warm) !== undefined, 'warm row survives');
    assert.equal(
      fs.existsSync(dirOf(tempDir, warm)),
      true,
      'warm files survive',
    );
  });

  it('never evicts inside the age floor, even at a full disk', async () => {
    const fresh = dataRootFor(5);
    await store.set(fresh, 0, chunkOf('fresh-chunk'));
    await flush();

    mock.method(fs.promises, 'statfs', async () => fakeStatfs(100));
    // Floor of an hour: the row was written seconds ago, so it is protected.
    const evictor = makeEvictor({ minAgeSeconds: 3600 });

    await evictor.sweep();
    await flush();

    assert.ok(row(fresh) !== undefined, 'row must survive the age floor');
    assert.equal(
      fs.existsSync(dirOf(tempDir, fresh)),
      true,
      'a chunk inside the confirmation window must never be unlinked',
    );
  });

  it('backfill adopts pre-existing files, which then become evictable', async () => {
    // Write chunks with NO index wired, simulating a cache that predates it.
    const bare = new FsChunkDataStore({ log, baseDir: tempDir });
    const dr = dataRootFor(6);
    await bare.set(dr, 0, chunkOf('legacy-a'));
    await bare.set(dr, 262144, chunkOf('legacy-bb'));
    assert.equal(worker.countChunkDataCacheEntries(), 0, 'nothing indexed yet');

    // Age the files so the backfill seeds an old last_write from mtime.
    const tenHoursAgo = new Date(Date.now() - 10 * 3600 * 1000);
    const dir = dirOf(tempDir, dr);
    for (const f of fs.readdirSync(dir)) {
      fs.utimesSync(join(dir, f), tenHoursAgo, tenHoursAgo);
    }

    const reconciler = new ChunkDataCacheReconciler({
      log,
      cacheIndex: index,
      baseDir: join(tempDir, 'data', 'by-dataroot'),
      checkpointPath: join(tempDir, '.ckpt'),
      batchSize: 10,
      walkConcurrency: 2,
    } as any);
    await reconciler.run();
    await flush();

    const seeded = row(dr);
    assert.ok(seeded !== undefined, 'backfill seeded the row');
    assert.equal(seeded.chunk_count, 2);
    assert.equal(seeded.size, 17, 'sizes summed (8 + 9)');
    const nowSeconds = Math.floor(Date.now() / 1000);
    assert.ok(
      nowSeconds - seeded.last_write > 9 * 3600,
      `last_write must come from mtime, not walk time (got ${nowSeconds - seeded.last_write}s old)`,
    );

    // With a 1h floor the seeded row is already old enough to evict.
    let used = 95;
    mock.method(fs.promises, 'statfs', async () => fakeStatfs(used));
    const originalDel = store.delDataRoot.bind(store);
    (store as any).delDataRoot = async (d: string) => {
      await originalDel(d);
      used = 50;
    };
    await makeEvictor({ minAgeSeconds: 3600 }).sweep();
    await flush();

    assert.equal(row(dr), undefined, 'backfilled row evicted');
    assert.equal(fs.existsSync(dir), false, 'backfilled files removed');
  });

  it('a chunk written between select and delete survives eviction', async () => {
    const dr = dataRootFor(7);
    await store.set(dr, 0, chunkOf('original'));
    await flush();
    // Make it look old enough to select.
    chunksDb
      .prepare(
        'UPDATE chunk_data_cache SET last_write = ?, last_access = 1 WHERE data_root = ?',
      )
      .run(Math.floor(Date.now() / 1000) - 7200, dr);

    mock.method(fs.promises, 'statfs', async () => fakeStatfs(99));

    // Land a chunk in the gap: patch select so that immediately after the
    // evictor reads its candidates -- ONCE, on the first batch only -- a new
    // write hits the same data root. Re-firing on every batch would re-create
    // the file and the row after any eviction, making the assertions below
    // pass whether or not the delete guard exists.
    const realSelect = index.selectChunkDataCacheEvictionCandidates;
    let landed = false;
    index.selectChunkDataCacheEvictionCandidates = async (
      maxLastWrite: number,
      limit: number,
    ) => {
      const out = await realSelect(maxLastWrite, limit);
      if (!landed) {
        landed = true;
        await store.set(dr, 262144, chunkOf('arrived-late'));
        await flush();
      }
      return out;
    };

    await makeEvictor({ minAgeSeconds: 3600 }).sweep();
    await flush();

    assert.ok(
      row(dr) !== undefined,
      'the delete-time floor guard must keep the row',
    );
    assert.equal(
      fs.existsSync(join(dirOf(tempDir, dr), '262144')),
      true,
      'the chunk written during the sweep must still be on disk',
    );
  });
});
