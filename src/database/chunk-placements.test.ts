/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { before, describe, it } from 'node:test';

import { StandaloneSqliteDatabaseWorker } from './standalone-sqlite.js';
import { toB64Url } from '../lib/encoding.js';
import { createTestLogger } from '../../test/test-logger.js';
import {
  bundlesDbPath,
  chunksDbPath,
  coreDbPath,
  dataDbPath,
  moderationDbPath,
} from '../../test/sqlite-helpers.js';
import { ChunkPlacement } from '../types.js';

const log = createTestLogger();

const basePlacement = (
  overrides: Partial<ChunkPlacement> = {},
): ChunkPlacement => ({
  dataRoot: toB64Url(Buffer.alloc(32, 1)),
  relativeOffset: 0,
  dataSize: 1000,
  chunkSize: 256,
  hash: toB64Url(Buffer.alloc(32, 2)),
  dataPath: toB64Url(Buffer.alloc(96, 3)),
  txPath: undefined,
  origin: 1,
  cachedAt: 1000,
  confirmedAt: undefined,
  ...overrides,
});

describe('chunk_placements (chunks.db) worker methods', () => {
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

  it('round-trips a placement through save and get', () => {
    const placement = basePlacement();
    worker.saveChunkPlacement(placement);

    const got = worker.getChunkPlacement(placement.dataRoot, 0);
    assert.ok(got);
    assert.equal(got.dataRoot, placement.dataRoot);
    assert.equal(got.relativeOffset, 0);
    assert.equal(got.dataSize, 1000);
    assert.equal(got.chunkSize, 256);
    assert.equal(got.hash, placement.hash);
    assert.equal(got.dataPath, placement.dataPath);
    assert.equal(got.txPath, undefined);
    assert.equal(got.origin, 1);
    assert.equal(got.cachedAt, 1000);
    assert.equal(got.confirmedAt, undefined);
  });

  it('confirms placements by data_root and returns their cached_at', () => {
    worker.saveChunkPlacement(
      basePlacement({ relativeOffset: 0, cachedAt: 1000 }),
    );
    worker.saveChunkPlacement(
      basePlacement({ relativeOffset: 256, cachedAt: 1001 }),
    );

    const cachedAts = worker.confirmChunkPlacements(
      basePlacement().dataRoot,
      5000,
    );

    assert.deepEqual(
      cachedAts.sort((a, b) => a - b),
      [1000, 1001],
    );
    assert.equal(
      worker.getChunkPlacement(basePlacement().dataRoot, 0)?.confirmedAt,
      5000,
    );
    // A second confirm finds nothing already-pending.
    assert.deepEqual(
      worker.confirmChunkPlacements(basePlacement().dataRoot, 6000),
      [],
    );
  });

  it('selects only expired unconfirmed placements (tiered by origin)', () => {
    // pending + old (open origin) -> expired
    worker.saveChunkPlacement(
      basePlacement({ relativeOffset: 0, origin: 1, cachedAt: 100 }),
    );
    // pending but recent -> not expired under the cutoff
    worker.saveChunkPlacement(
      basePlacement({ relativeOffset: 256, origin: 1, cachedAt: 100000 }),
    );
    // already confirmed -> never expired
    worker.saveChunkPlacement(
      basePlacement({
        relativeOffset: 512,
        origin: 1,
        cachedAt: 100,
        confirmedAt: 200,
      }),
    );

    const expired = worker.selectExpiredUnconfirmedChunkPlacements({
      originIngest: 1,
      originIngestAllowlisted: 2,
      openCutoff: 1000,
      allowCutoff: 1000,
      limit: 10,
    });

    assert.equal(expired.length, 1);
    assert.equal(expired[0].relativeOffset, 0);
    assert.equal(expired[0].chunkSize, 256);
  });

  it('sums only pending (unconfirmed) chunk bytes', () => {
    worker.saveChunkPlacement(
      basePlacement({
        relativeOffset: 0,
        chunkSize: 256,
        confirmedAt: undefined,
      }),
    );
    worker.saveChunkPlacement(
      basePlacement({ relativeOffset: 256, chunkSize: 100, confirmedAt: 200 }),
    );

    assert.equal(worker.sumPendingChunkBytes(), 256);
  });

  it('deletes a pending placement and returns the deleted row count', () => {
    const placement = basePlacement();
    worker.saveChunkPlacement(placement);

    assert.equal(worker.deleteChunkPlacement(placement.dataRoot, 0), 1);
    assert.equal(worker.getChunkPlacement(placement.dataRoot, 0), undefined);
  });

  it('does not delete a confirmed placement and returns 0 (GC TOCTOU guard)', () => {
    const placement = basePlacement();
    worker.saveChunkPlacement(placement);
    worker.confirmChunkPlacements(placement.dataRoot, 5000);

    // A confirmation that lands between the GC sweep's SELECT and this DELETE
    // must NOT evict the now-confirmed placement.
    assert.equal(worker.deleteChunkPlacement(placement.dataRoot, 0), 0);
    const got = worker.getChunkPlacement(placement.dataRoot, 0);
    assert.ok(got);
    assert.equal(got.confirmedAt, 5000);
  });

  // Sticky confirmation: confirmation is triggered once per data_root by the
  // one-shot TX_INDEXED UPDATE, but a large bundle streams its chunks in over a
  // long window. A chunk ingested AFTER that event must inherit the data_root's
  // confirmation so it is retained instead of being TTL-evicted.
  describe('sticky confirmation (sibling inheritance)', () => {
    it('inherits confirmed_at from an already-confirmed sibling at ingest', () => {
      const dataRoot = toB64Url(Buffer.alloc(32, 40));
      worker.saveChunkPlacement(
        basePlacement({ dataRoot, relativeOffset: 0, confirmedAt: 5000 }),
      );

      // A later chunk of the same bundle arrives unconfirmed…
      worker.saveChunkPlacement(
        basePlacement({
          dataRoot,
          relativeOffset: 256,
          confirmedAt: undefined,
        }),
      );

      // …and comes back confirmed via the sibling.
      assert.equal(worker.getChunkPlacement(dataRoot, 256)?.confirmedAt, 5000);
    });

    it('leaves a chunk unconfirmed when no sibling is confirmed', () => {
      const dataRoot = toB64Url(Buffer.alloc(32, 41));
      worker.saveChunkPlacement(
        basePlacement({ dataRoot, relativeOffset: 0, confirmedAt: undefined }),
      );
      worker.saveChunkPlacement(
        basePlacement({
          dataRoot,
          relativeOffset: 256,
          confirmedAt: undefined,
        }),
      );

      assert.equal(
        worker.getChunkPlacement(dataRoot, 256)?.confirmedAt,
        undefined,
      );
    });

    it('auto-confirms and retains chunks ingested after the one-shot confirm (regression)', () => {
      const dataRoot = toB64Url(Buffer.alloc(32, 42));

      // First chunks of the bundle arrive and are confirmed once by TX_INDEXED.
      worker.saveChunkPlacement(
        basePlacement({ dataRoot, relativeOffset: 0, cachedAt: 100 }),
      );
      worker.saveChunkPlacement(
        basePlacement({ dataRoot, relativeOffset: 256, cachedAt: 100 }),
      );
      worker.confirmChunkPlacements(dataRoot, 7000);

      // The remaining chunks stream in long after (these are the ones that used
      // to stay pending and get TTL-evicted).
      worker.saveChunkPlacement(
        basePlacement({ dataRoot, relativeOffset: 512, cachedAt: 200 }),
      );
      worker.saveChunkPlacement(
        basePlacement({ dataRoot, relativeOffset: 768, cachedAt: 300 }),
      );

      assert.equal(worker.getChunkPlacement(dataRoot, 512)?.confirmedAt, 7000);
      assert.equal(worker.getChunkPlacement(dataRoot, 768)?.confirmedAt, 7000);

      // Now well past the TTL cutoff, none of this bundle's chunks are evictable.
      const expired = worker.selectExpiredUnconfirmedChunkPlacements({
        originIngest: 1,
        originIngestAllowlisted: 2,
        openCutoff: 100000,
        allowCutoff: 100000,
        limit: 100,
      });
      assert.ok(!expired.some((e) => e.dataRoot === dataRoot));
    });

    it('lets an explicit confirmed_at win over a sibling value', () => {
      const dataRoot = toB64Url(Buffer.alloc(32, 43));
      worker.saveChunkPlacement(
        basePlacement({ dataRoot, relativeOffset: 0, confirmedAt: 5000 }),
      );
      worker.saveChunkPlacement(
        basePlacement({ dataRoot, relativeOffset: 256, confirmedAt: 8000 }),
      );

      assert.equal(worker.getChunkPlacement(dataRoot, 256)?.confirmedAt, 8000);
    });
  });

  // The confirmed_data_roots marker generalizes sticky confirmation beyond a live
  // confirmed sibling: it is set once at confirm time and then (a) confirms
  // later-ingested chunks and (b) shields the whole data_root from TTL eviction.
  describe('confirmed_data_roots marker', () => {
    it('shields a data_root from TTL eviction once confirmed, even if a row is pending', () => {
      const dataRoot = toB64Url(Buffer.alloc(32, 44));
      worker.saveChunkPlacement(
        basePlacement({
          dataRoot,
          relativeOffset: 0,
          origin: 1,
          cachedAt: 100,
        }),
      );
      // Confirmation records the marker (a chunk exists for this data_root).
      worker.confirmChunkPlacements(dataRoot, 7000);
      // Force the row back to pending (mirrors a straggler that never picked up
      // confirmation) — the marker remains.
      worker.unconfirmChunkPlacements(dataRoot);

      const expired = worker.selectExpiredUnconfirmedChunkPlacements({
        originIngest: 1,
        originIngestAllowlisted: 2,
        openCutoff: 100000,
        allowCutoff: 100000,
        limit: 100,
      });
      // Pending + old, but its data_root is confirmed -> not evictable.
      assert.ok(!expired.some((e) => e.dataRoot === dataRoot));
    });

    // The confirm event (TX_INDEXED) commonly fires BEFORE any of a bundle's
    // chunks are seeded — with the bundler's TX-confirmation broadcast gate,
    // seeding waits for network confirmation and the gateway imports that block
    // first. The marker must therefore be recorded even when no chunk exists yet,
    // so the later-seeded chunks inherit it. (End-to-end, the earlier EXISTS-gated
    // version let confirm fire ~2s before the first chunk, set no marker, and all
    // 1025 chunks TTL-evicted with offset 0 lost.)
    it('marks a confirmed data_root even with no chunks yet, so later chunks inherit it', () => {
      const dataRoot = toB64Url(Buffer.alloc(32, 45));
      // Confirm fires first, before any chunk of this bundle is ingested.
      worker.confirmChunkPlacements(dataRoot, 7000);

      // Chunks stream in afterwards, unconfirmed…
      worker.saveChunkPlacement(
        basePlacement({ dataRoot, relativeOffset: 0, confirmedAt: undefined }),
      );
      worker.saveChunkPlacement(
        basePlacement({
          dataRoot,
          relativeOffset: 256,
          confirmedAt: undefined,
        }),
      );

      // …and inherit the marker's confirmation at ingest.
      assert.equal(worker.getChunkPlacement(dataRoot, 0)?.confirmedAt, 7000);
      assert.equal(worker.getChunkPlacement(dataRoot, 256)?.confirmedAt, 7000);

      // And are shielded from TTL eviction.
      const expired = worker.selectExpiredUnconfirmedChunkPlacements({
        originIngest: 1,
        originIngestAllowlisted: 2,
        openCutoff: 100000,
        allowCutoff: 100000,
        limit: 100,
      });
      assert.ok(!expired.some((e) => e.dataRoot === dataRoot));
    });

    it('prunes markers older than the cutoff (keeps the table bounded)', () => {
      const oldRoot = toB64Url(Buffer.alloc(32, 46));
      const freshRoot = toB64Url(Buffer.alloc(32, 47));
      worker.confirmChunkPlacements(oldRoot, 1000);
      worker.confirmChunkPlacements(freshRoot, 9000);

      const deleted = worker.pruneConfirmedDataRoots(5000);
      assert.ok(deleted >= 1);

      // The old marker is gone: a later chunk under it does NOT inherit.
      worker.saveChunkPlacement(
        basePlacement({ dataRoot: oldRoot, relativeOffset: 0 }),
      );
      assert.equal(
        worker.getChunkPlacement(oldRoot, 0)?.confirmedAt,
        undefined,
      );

      // The fresh marker survives: a later chunk under it DOES inherit.
      worker.saveChunkPlacement(
        basePlacement({ dataRoot: freshRoot, relativeOffset: 0 }),
      );
      assert.equal(worker.getChunkPlacement(freshRoot, 0)?.confirmedAt, 9000);
    });

    it('counts marker rows (observability gauge source)', () => {
      const before = worker.countConfirmedDataRoots();
      worker.confirmChunkPlacements(toB64Url(Buffer.alloc(32, 48)), 1000);
      worker.confirmChunkPlacements(toB64Url(Buffer.alloc(32, 49)), 1000);
      assert.equal(worker.countConfirmedDataRoots(), before + 2);
    });
  });
});
