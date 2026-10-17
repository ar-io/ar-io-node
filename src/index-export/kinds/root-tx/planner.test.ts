/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { BandRole, OwnBand } from '../../state.js';
import {
  bootstrapFrom,
  currentRecent,
  FOLD_INTERVAL_MS,
  foldDue,
  OVERLAP_BLOCKS,
  planBootstrap,
  planDelta,
  planFold,
} from './planner.js';

const MAX = 100_000;

const band = (
  id: string,
  role: BandRole,
  from: number,
  to: number | null,
  top = to ?? from,
): OwnBand => ({
  id,
  dir: `/x/${id}`,
  role,
  from,
  to,
  top,
  adopted: false,
  manifest: {
    version: 1,
    createdAt: '2026-10-01T00:00:00Z',
    totalRecords: 1,
    partitions: [],
  },
});

describe('planBootstrap', () => {
  const input = (stableTop: number, startHeight?: number) => ({
    bands: [] as OwnBand[],
    stableTop,
    ...(startHeight !== undefined ? { startHeight } : {}),
    recentMaxBlocks: MAX,
  });

  it('cuts history at fixed edges and makes the last partial span the first r', () => {
    const plan = input(2_007_270, 1_950_000);
    assert.deepEqual(
      planBootstrap(plan, bootstrapFrom(plan) as number).map((step) => [
        step.role,
        step.heightRange,
        step.read,
      ]),
      [
        ['h', [1_950_000, 1_999_999], [1_950_000, 1_999_999]],
        ['r', [2_000_000, 2_007_270], [2_000_000, 2_007_270]],
      ],
    );
  });

  it('cuts several full spans, and ends on an h when the top meets an edge', () => {
    assert.deepEqual(
      planBootstrap(input(1_999_999), 1_800_000).map((step) => [
        step.role,
        step.heightRange,
      ]),
      [
        ['h', [1_800_000, 1_899_999]],
        ['h', [1_900_000, 1_999_999]],
      ],
    );
  });

  it('builds nothing above the stable top', () => {
    assert.deepEqual(planBootstrap(input(1_949_999), 1_950_000), []);
  });

  it('refuses to start without a start height', () => {
    assert.throws(() => bootstrapFrom(input(10)), /INDEX_EXPORT_START_HEIGHT/);
  });

  it('resumes an interrupted bootstrap above its last h, and is done once an r exists', () => {
    const h = band('h1', 'h', 1_000_000, 1_099_999);
    assert.equal(
      bootstrapFrom({ ...input(1_990_000, 1_000_000), bands: [h] }),
      1_100_000,
    );
    // Within one span of the top: the fold starts the r instead.
    assert.equal(
      bootstrapFrom({ ...input(1_150_000, 1_000_000), bands: [h] }),
      undefined,
    );
    assert.equal(
      bootstrapFrom({
        ...input(1_990_000, 1_000_000),
        bands: [h, band('r1', 'r', 1_100_000, 1_150_000)],
      }),
      undefined,
    );
    // A delta alone doesn't count as history.
    assert.equal(
      bootstrapFrom({
        ...input(1_990_000, 1_000_000),
        bands: [band('d1', 'd', 1_500_000, null)],
      }),
      1_000_000,
    );
  });
});

describe('planFold', () => {
  it('folds the current r up to the stable top, reading from just below its top', () => {
    const r = band('r1', 'r', 2_000_000, 2_007_270);
    const step = planFold({
      bands: [band('h1', 'h', 1_950_000, 1_999_999), r],
      stableTop: 2_012_000,
      recentMaxBlocks: MAX,
    });
    assert.deepEqual(step?.heightRange, [2_000_000, 2_012_000]);
    assert.deepEqual(step?.read, [2_007_271 - OVERLAP_BLOCKS, 2_012_000]);
    assert.equal(step?.fold, r);
    assert.deepEqual(step?.supersedes, ['r1']);
    assert.equal(step?.freezes, false);
  });

  it('supersedes a stray unfrozen r a lost lock left inside the range', () => {
    const step = planFold({
      bands: [
        band('r1', 'r', 2_000_000, 2_007_270),
        band('r-stray', 'r', 2_000_000, 2_006_000),
        band('r-old', 'r', 1_900_000, 1_999_999),
      ],
      stableTop: 2_012_000,
      recentMaxBlocks: MAX,
    });
    assert.deepEqual(step?.supersedes.sort(), ['r-stray', 'r1']);
  });

  it('caps the fold at the maximum span (the r then freezes)', () => {
    const step = planFold({
      bands: [band('r1', 'r', 2_000_000, 2_095_000)],
      stableTop: 2_120_000,
      recentMaxBlocks: MAX,
    });
    assert.deepEqual(step?.heightRange, [2_000_000, 2_099_999]);
    assert.equal(step?.freezes, true);
  });

  it('starts a new r above a frozen one, folding nothing and superseding nothing', () => {
    const frozen = band('r1', 'r', 2_000_000, 2_099_999);
    assert.equal(currentRecent([frozen], MAX), undefined);
    const step = planFold({
      bands: [frozen, band('d1', 'd', 2_099_488, null)],
      stableTop: 2_120_000,
      recentMaxBlocks: MAX,
    });
    assert.deepEqual(step?.heightRange, [2_100_000, 2_120_000]);
    assert.deepEqual(step?.read, [2_100_000, 2_120_000]);
    assert.equal(step?.fold, undefined);
    assert.deepEqual(step?.supersedes, []);
  });

  it('plans nothing when the sources reach no higher than the r', () => {
    assert.equal(
      planFold({
        bands: [band('r1', 'r', 2_000_000, 2_010_000)],
        stableTop: 2_010_000,
        recentMaxBlocks: MAX,
      }),
      undefined,
    );
  });

  it('folds an adopted r open at the tip at its recorded top', () => {
    const adopted: OwnBand = {
      ...band('b1-h1950000-tip-x', 'r', 1_950_000, null, 2_005_000),
      adopted: true,
    };
    const step = planFold({
      bands: [adopted],
      stableTop: 2_010_000,
      recentMaxBlocks: MAX,
    });
    assert.deepEqual(step?.heightRange, [1_950_000, 2_010_000]);
    assert.deepEqual(step?.read, [2_005_001 - OVERLAP_BLOCKS, 2_010_000]);
    assert.deepEqual(step?.supersedes, ['b1-h1950000-tip-x']);
  });
});

describe('planDelta', () => {
  it('reads from just below the covered top and replaces every current delta', () => {
    const step = planDelta({
      bands: [
        band('r1', 'r', 2_000_000, 2_010_000),
        band('d1', 'd', 2_005_000, null),
        band('d2', 'd', 2_009_489, null),
      ],
      stableTop: 2_012_000,
      recentMaxBlocks: MAX,
    });
    assert.deepEqual(step?.heightRange, [2_010_001 - OVERLAP_BLOCKS, null]);
    assert.deepEqual(step?.read, [2_010_001 - OVERLAP_BLOCKS, 2_012_000]);
    assert.deepEqual(step?.supersedes, ['d1', 'd2']);
    assert.equal(step?.replaces?.id, 'd2', 'the delta over the same range');
  });

  it('starts above a fold that just published', () => {
    const step = planDelta({
      bands: [
        band('r2', 'r', 2_000_000, 2_012_000),
        band('d1', 'd', 2_009_489, null),
      ],
      stableTop: 2_012_000,
      recentMaxBlocks: MAX,
    });
    assert.equal(step, undefined, 'nothing above the new r yet');
  });

  it('plans nothing with nothing covered', () => {
    assert.equal(
      planDelta({ bands: [], stableTop: 10, recentMaxBlocks: MAX }),
      undefined,
    );
  });
});

describe('foldDue', () => {
  it('is due with no fold yet, or a week after the last', () => {
    const now = Date.parse('2026-10-08T04:00:00Z');
    assert.equal(foldDue(undefined, now), true);
    assert.equal(
      foldDue(new Date(now - FOLD_INTERVAL_MS).toISOString(), now),
      true,
    );
    assert.equal(
      foldDue(new Date(now - FOLD_INTERVAL_MS + 60_000).toISOString(), now),
      false,
    );
    assert.equal(foldDue('garbage', now), true);
  });
});
