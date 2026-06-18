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

  it('deletes a placement', () => {
    const placement = basePlacement();
    worker.saveChunkPlacement(placement);
    worker.deleteChunkPlacement(placement.dataRoot, 0);

    assert.equal(worker.getChunkPlacement(placement.dataRoot, 0), undefined);
  });
});
