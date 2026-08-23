/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { before, beforeEach, describe, it } from 'node:test';

import { StandaloneSqliteDatabaseWorker } from './standalone-sqlite.js';
import { fromB64Url, toB64Url } from '../lib/encoding.js';
import { createTestLogger } from '../../test/test-logger.js';
import {
  bundlesDbPath,
  chunksDb,
  chunksDbPath,
  coreDbPath,
  dataDbPath,
  moderationDbPath,
} from '../../test/sqlite-helpers.js';

const log = createTestLogger();

const dataRoot = (fill: number) => toB64Url(Buffer.alloc(32, fill));

const ROOT_A = dataRoot(1);
const ROOT_B = dataRoot(2);
const ROOT_C = dataRoot(3);

interface CacheRow {
  data_root: Buffer;
  size: number;
  chunk_count: number;
  last_write: number;
  last_access: number | null;
  tier: number;
}

// data_root is stored as a BLOB (matching chunk_placements so the two can be
// joined), while the worker API speaks base64url. Convert on the way in.
const readRow = (root: string): CacheRow =>
  chunksDb
    .prepare('SELECT * FROM chunk_data_cache WHERE data_root = ?')
    .get(fromB64Url(root)) as CacheRow;

describe('chunk_data_cache (chunks.db) worker methods', () => {
  let worker: StandaloneSqliteDatabaseWorker;

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

  // chunks.db is shared with every other suite in the run, and these tests
  // assert on exact row counts and orderings. Start each from an empty table
  // so results cannot depend on execution order.
  beforeEach(() => {
    chunksDb.prepare('DELETE FROM chunk_data_cache').run();
  });

  it('accumulates size and chunk_count across writes to the same data root', () => {
    worker.saveChunkDataCacheEntry({
      dataRoot: ROOT_A,
      size: 100,
      lastWrite: 1000,
      tier: 0,
    });
    worker.saveChunkDataCacheEntry({
      dataRoot: ROOT_A,
      size: 200,
      lastWrite: 1001,
      tier: 0,
    });

    const row = readRow(ROOT_A);
    assert.equal(row.size, 300);
    assert.equal(row.chunk_count, 2);
    assert.equal(worker.countChunkDataCacheEntries(), 1);
    assert.equal(worker.sumChunkDataCacheBytes(), 300);
  });

  // Regression test for the ADR's `cached_at` (immutable-on-upsert) semantics.
  // Eviction is all-or-nothing per data root, so the age floor must reflect the
  // NEWEST chunk write, not the first one -- otherwise a long-lived data root
  // that just received a fresh chunk stays evictable and the fresh chunk goes
  // with it.
  it('advances last_write on a later write (age floor is max, not first)', () => {
    worker.saveChunkDataCacheEntry({
      dataRoot: ROOT_A,
      size: 100,
      lastWrite: 1000,
      tier: 0,
    });
    assert.equal(readRow(ROOT_A).last_write, 1000);

    worker.saveChunkDataCacheEntry({
      dataRoot: ROOT_A,
      size: 100,
      lastWrite: 5000,
      tier: 0,
    });

    const row = readRow(ROOT_A);
    assert.equal(row.last_write, 5000);
    assert.equal(row.last_access, 5000);

    // ...and never moves backwards for an out-of-order (older) write.
    worker.saveChunkDataCacheEntry({
      dataRoot: ROOT_A,
      size: 100,
      lastWrite: 2000,
      tier: 0,
    });
    assert.equal(readRow(ROOT_A).last_write, 5000);
  });

  it('touch moves last_access but never last_write', () => {
    worker.saveChunkDataCacheEntry({
      dataRoot: ROOT_A,
      size: 100,
      lastWrite: 1000,
      tier: 0,
    });

    worker.touchChunkDataCacheEntry(ROOT_A, 9000, 1);

    const row = readRow(ROOT_A);
    assert.equal(row.last_access, 9000);
    assert.equal(row.last_write, 1000);
    assert.equal(row.tier, 1);
  });

  it('seeds backfill rows only when absent', () => {
    worker.saveChunkDataCacheEntry({
      dataRoot: ROOT_A,
      size: 100,
      lastWrite: 1000,
      tier: 0,
    });

    worker.insertChunkDataCacheEntriesIfAbsent([
      {
        dataRoot: ROOT_A,
        size: 999,
        chunkCount: 99,
        lastWrite: 1,
        lastAccess: 1,
        tier: 0,
      },
      {
        dataRoot: ROOT_B,
        size: 500,
        chunkCount: 5,
        lastWrite: 2000,
        lastAccess: 2500,
        tier: 0,
      },
    ]);

    // The live write entry is untouched...
    const a = readRow(ROOT_A);
    assert.equal(a.size, 100);
    assert.equal(a.chunk_count, 1);
    // ...and the absent one is seeded verbatim.
    const b = readRow(ROOT_B);
    assert.equal(b.size, 500);
    assert.equal(b.chunk_count, 5);
    assert.equal(b.last_write, 2000);
    assert.equal(b.last_access, 2500);
  });

  // The age floor: a data root whose newest chunk write is more recent than
  // @max_last_write must never be handed to the evictor.
  it('excludes candidates whose last_write is newer than the age floor', () => {
    worker.insertChunkDataCacheEntriesIfAbsent([
      {
        dataRoot: ROOT_A,
        size: 100,
        chunkCount: 1,
        lastWrite: 1000,
        lastAccess: 1000,
        tier: 0,
      },
      {
        dataRoot: ROOT_B,
        size: 200,
        chunkCount: 2,
        lastWrite: 5000,
        // Deliberately the least-recently-accessed row, so a query that ignored
        // the floor would return it FIRST.
        lastAccess: 1,
        tier: 0,
      },
    ]);

    const candidates = worker.selectChunkDataCacheEvictionCandidates(2000, 10);

    // lastWrite is part of the returned shape: ChunkDataCacheEvictor
    // re-asserts the age floor against it rather than trusting this query,
    // because the floor is the one control whose failure is silent.
    assert.deepEqual(candidates, [
      { dataRoot: ROOT_A, size: 100, chunkCount: 1, lastWrite: 1000 },
    ]);
  });

  it('orders candidates by tier ASC then last_access ASC', () => {
    worker.insertChunkDataCacheEntriesIfAbsent([
      {
        dataRoot: ROOT_A,
        size: 1,
        chunkCount: 1,
        lastWrite: 100,
        lastAccess: 100,
        tier: 1,
      },
      {
        dataRoot: ROOT_B,
        size: 2,
        chunkCount: 1,
        lastWrite: 100,
        lastAccess: 300,
        tier: 0,
      },
      {
        dataRoot: ROOT_C,
        size: 3,
        chunkCount: 1,
        lastWrite: 100,
        lastAccess: 200,
        tier: 0,
      },
    ]);

    const candidates = worker.selectChunkDataCacheEvictionCandidates(1000, 10);

    assert.deepEqual(
      candidates.map((c) => c.dataRoot),
      [ROOT_C, ROOT_B, ROOT_A],
    );
  });

  it('returns only the data roots a batch delete actually removed', () => {
    worker.saveChunkDataCacheEntry({
      dataRoot: ROOT_A,
      size: 100,
      lastWrite: 1000,
      tier: 0,
    });

    const deleted = worker.deleteChunkDataCacheEntries([ROOT_A, ROOT_B], 2000);

    assert.deepEqual(deleted, [ROOT_A]);
    assert.equal(worker.countChunkDataCacheEntries(), 0);
  });

  // The TOCTOU that the age floor alone does not close. The evictor selects a
  // data root while it is old enough to evict, but a chunk can land before the
  // delete runs. Because eviction unlinks the WHOLE data root directory, an
  // unguarded delete would report success and the evictor would destroy the
  // chunk that was just written -- silently, with the writer believing it was
  // cached. Mirrors deleteChunkPlacement's `confirmed_at IS NULL` guard.
  it('refuses to delete a data root written to after it was selected', () => {
    // Selected while old.
    worker.saveChunkDataCacheEntry({
      dataRoot: ROOT_A,
      size: 100,
      lastWrite: 1000,
      tier: 0,
    });
    const floor = 2000;
    const candidates = worker.selectChunkDataCacheEvictionCandidates(floor, 10);
    assert.deepEqual(
      candidates.map((c) => c.dataRoot),
      [ROOT_A],
    );

    // A chunk lands in the gap; the write hook advances last_write past floor.
    worker.saveChunkDataCacheEntry({
      dataRoot: ROOT_A,
      size: 50,
      lastWrite: 9000,
      tier: 0,
    });

    const deleted = worker.deleteChunkDataCacheEntries([ROOT_A], floor);

    // Nothing deleted => the evictor unlinks nothing => the fresh chunk lives.
    assert.deepEqual(deleted, []);
    assert.equal(worker.countChunkDataCacheEntries(), 1);
    assert.equal(readRow(ROOT_A).last_write, 9000);
  });
});
