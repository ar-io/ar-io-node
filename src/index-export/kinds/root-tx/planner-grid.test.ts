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
  classifyGridBands,
  describeGridStep,
  frozenTop,
  GridLayoutError,
  planFreezes,
  planResettle,
  planRolls,
  planTip,
  resettleDue,
  tipStart,
} from './planner-grid.js';

const DAY = 24 * 3600_000;
const CREATED = Date.parse('2026-10-01T00:00:00Z');

const band = (
  role: BandRole,
  from: number,
  to: number | null,
  { records = 1, createdAt = CREATED, top = to ?? from } = {},
): OwnBand => {
  const id = `${role}-h${from}-${to ?? 'tip'}-abcdef12-000000000000`;
  return {
    id,
    dir: `/x/${id}`,
    role,
    from,
    to,
    top,
    adopted: false,
    manifest: {
      version: 1,
      createdAt: new Date(createdAt).toISOString(),
      totalRecords: records,
      partitions: [],
    },
  };
};

/** The live bands turbo-gateway.com built by script on 2026-10-12. */
const turbo = () => [
  band('h', 1_800_000, 1_899_999),
  band('h', 1_900_000, 1_999_999),
  band('d', 2_000_000, 2_004_999),
  band('d', 2_005_000, 2_009_999),
  band('tip', 2_010_000, null),
];

const ranges = (steps: Array<{ role: string; heightRange: unknown }>) =>
  steps.map((step) => [step.role, step.heightRange]);

describe('classifyGridBands', () => {
  it('adopts grid bands as they are: h and d frozen, the tip a seed', () => {
    const { frozen, seeds } = classifyGridBands(turbo());
    assert.deepEqual(
      frozen.map((b) => b.id),
      turbo()
        .slice(0, 4)
        .map((b) => b.id),
    );
    assert.deepEqual(
      seeds.map((b) => b.role),
      ['tip'],
    );
    assert.equal(frozenTop(frozen), 2_009_999);
  });

  it("takes a legacy layout's bands: a whole r frozen, a short r and an open d as seeds", () => {
    const { frozen, seeds } = classifyGridBands([
      band('h', 1_800_000, 1_899_999),
      band('r', 1_900_000, 1_999_999),
      band('r', 2_000_000, 2_007_270),
      band('d', 2_006_759, null, { top: 2_009_000 }),
    ]);
    assert.deepEqual(
      frozen.map((b) => [b.role, b.from]),
      [
        ['h', 1_800_000],
        ['r', 1_900_000],
      ],
    );
    assert.deepEqual(
      seeds.map((b) => [b.role, b.from]),
      [
        ['r', 2_000_000],
        ['d', 2_006_759],
      ],
    );
  });

  it('refuses bands off the grid, naming each', () => {
    for (const [bad, pattern] of [
      [band('h', 1_950_000, 1_999_999), /off the grid/],
      [band('h', 1_900_000, 1_949_999), /off the grid/],
      [band('d', 2_000_000, 2_009_999), /off the grid/],
      [band('d', 2_001_000, 2_005_999), /off the grid/],
      [band('r', 1_950_000, 1_999_999), /off the grid/],
      [band('tip', 2_010_000, 2_011_000), /tip band with an end/],
      [band('h', 2_010_000, null), /open at the tip/],
    ] as const) {
      assert.throws(
        () => classifyGridBands([...turbo(), bad]),
        (error: Error) =>
          error instanceof GridLayoutError &&
          pattern.test(error.message) &&
          error.message.includes(bad.id),
        bad.id,
      );
    }
  });

  it('refuses frozen bands that overlap, as nothing supersedes either', () => {
    assert.throws(
      () =>
        classifyGridBands([
          band('h', 2_000_000, 2_099_999),
          band('d', 2_000_000, 2_004_999),
        ]),
      /h-h2000000-2099999-\S+ and d-h2000000-2004999-\S+ overlap/,
    );
    assert.throws(
      () =>
        classifyGridBands([
          band('h', 1_900_000, 1_999_999),
          band('r', 1_900_000, 1_999_999),
        ]),
      /overlap/,
    );
    // A d beyond the next one still overlaps the h it sits in.
    assert.throws(
      () =>
        classifyGridBands([
          band('h', 2_000_000, 2_099_999),
          band('d', 2_050_000, 2_054_999),
          band('d', 2_090_000, 2_094_999),
        ]),
      /overlap/,
    );
  });

  it('lets seeds overlap anything: a tip lags the frozen bands for a day', () => {
    const { frozen, seeds } = classifyGridBands([
      band('d', 2_000_000, 2_004_999),
      band('d', 2_005_000, 2_009_999),
      band('tip', 2_005_000, null),
    ]);
    assert.equal(frozen.length, 2);
    assert.equal(seeds.length, 1);
  });
});

describe('planFreezes', () => {
  const input = (
    bands: OwnBand[],
    stableTop: number,
    startHeight?: number,
  ) => ({
    bands,
    stableTop,
    settleBlocks: 5040,
    ...(startHeight !== undefined ? { startHeight } : {}),
  });

  it('freezes each d whose top is the settle lag below the stable top, with the seeds', () => {
    // The limit is 2,014,999: the d up to it freezes, the next waits.
    const steps = planFreezes(input(turbo(), 2_020_039));
    assert.deepEqual(ranges(steps), [['d', [2_010_000, 2_014_999]]]);
    assert.equal(steps[0].grid, 'freeze');
    assert.deepEqual(steps[0].read, [2_010_000, 2_014_999]);
    assert.equal(steps[0].freezes, true);
    assert.deepEqual(steps[0].supersedes, []);
    assert.deepEqual(
      steps[0].seeds?.map((b) => b.role),
      ['tip'],
    );
    assert.deepEqual(planFreezes(input(turbo(), 2_020_038)), [], 'one short');
  });

  it('freezes several in order when the limit has moved several ranges', () => {
    assert.deepEqual(ranges(planFreezes(input(turbo(), 2_030_039))), [
      ['d', [2_010_000, 2_014_999]],
      ['d', [2_015_000, 2_019_999]],
      ['d', [2_020_000, 2_024_999]],
    ]);
  });

  it('builds a whole h straight from the sources where a whole range has settled at once', () => {
    const bands = [band('h', 1_800_000, 1_899_999)];
    assert.deepEqual(ranges(planFreezes(input(bands, 2_015_040))), [
      ['h', [1_900_000, 1_999_999]],
      ['d', [2_000_000, 2_004_999]],
      ['d', [2_005_000, 2_009_999]],
    ]);
    // From the middle of a range: d bands to its end, then whole ranges.
    const partway = [...bands.slice(0, 1), band('d', 1_900_000, 1_904_999)];
    const steps = planFreezes(input(partway, 2_110_039));
    assert.deepEqual(ranges(steps).slice(0, 2), [
      ['d', [1_905_000, 1_909_999]],
      ['d', [1_910_000, 1_914_999]],
    ]);
    assert.deepEqual(ranges(steps).slice(-3), [
      ['d', [1_995_000, 1_999_999]],
      ['h', [2_000_000, 2_099_999]],
      ['d', [2_100_000, 2_104_999]],
    ]);
  });

  it('bootstraps from nothing: whole h ranges from the start height’s range, then d bands', () => {
    assert.deepEqual(ranges(planFreezes(input([], 2_015_040, 1_950_000))), [
      ['h', [1_900_000, 1_999_999]],
      ['d', [2_000_000, 2_004_999]],
      ['d', [2_005_000, 2_009_999]],
    ]);
    const all = planFreezes(input([], 305_040));
    assert.deepEqual(ranges(all), [
      ['h', [0, 99_999]],
      ['h', [100_000, 199_999]],
      ['h', [200_000, 299_999]],
    ]);
    assert.equal(all[0].seeds, undefined, 'no seeds, none to place');
  });

  it('refuses to plan over bands it cannot build on', () => {
    assert.throws(
      () => planFreezes(input([band('h', 1_950_000, 1_999_999)], 2_100_000)),
      GridLayoutError,
    );
  });
});

describe('planRolls', () => {
  const twenty = (from: number) =>
    Array.from({ length: 20 }, (_, i) =>
      band('d', from + i * 5000, from + i * 5000 + 4999),
    );

  it('rolls a range once all twenty d bands exist, from them alone', () => {
    const ds = twenty(2_000_000);
    const [roll, ...more] = planRolls([band('h', 1_900_000, 1_999_999), ...ds]);
    assert.equal(more.length, 0);
    assert.deepEqual(roll.awaits, []);
    assert.equal(roll.step.grid, 'roll');
    assert.equal(roll.step.role, 'h');
    assert.deepEqual(roll.step.heightRange, [2_000_000, 2_099_999]);
    assert.equal(roll.step.read, undefined, 'no source is read');
    assert.deepEqual(
      roll.step.folds?.map((b) => b.id),
      ds.map((b) => b.id),
    );
    assert.deepEqual(
      roll.step.supersedes,
      ds.map((b) => b.id),
    );
  });

  it('waits while one is missing', () => {
    assert.deepEqual(planRolls(twenty(2_000_000).slice(0, 19)), []);
    const gap = twenty(2_000_000);
    gap.splice(7, 1);
    assert.deepEqual(planRolls(gap), []);
  });

  it('reports a roll that d bands a dry run built would complete', () => {
    const ds = twenty(2_000_000);
    const [roll] = planRolls(ds.slice(0, 18), [
      [2_090_000, 2_094_999],
      [2_095_000, 2_099_999],
    ]);
    assert.deepEqual(roll.awaits, [
      [2_090_000, 2_094_999],
      [2_095_000, 2_099_999],
    ]);
    assert.equal(roll.step.folds?.length, 18);
  });
});

describe('tipStart and planTip', () => {
  it('keeps the tip above the bands frozen at the start of the run', () => {
    assert.equal(tipStart(2_009_999, 2_014_999), 2_010_000, 'a freeze day');
    assert.equal(tipStart(2_014_999, 2_014_999), 2_015_000);
    assert.equal(tipStart(undefined, 2_014_999), 2_015_000, 'a bootstrap');
    assert.equal(tipStart(undefined, undefined, 1_950_000), 1_900_000);
    assert.equal(tipStart(undefined, undefined), 0);
  });

  it('supersedes the previous tip, and replaces it when it starts at the same height', () => {
    const bands = turbo();
    const step = planTip({ bands, stableTop: 2_016_000, from: 2_010_000 });
    assert.ok(step !== undefined);
    assert.equal(step.grid, 'tip');
    assert.equal(step.role, 'tip');
    assert.deepEqual(step.heightRange, [2_010_000, null]);
    assert.deepEqual(step.read, [2_010_000, 2_016_000]);
    assert.equal(step.keepFrom, 2_010_000);
    assert.deepEqual(step.supersedes, [bands[4].id]);
    assert.deepEqual(
      step.seeds?.map((b) => b.id),
      [bands[4].id],
    );
    assert.equal(step.replaces?.id, bands[4].id);
  });

  it('moves up over new d bands, reading from the old tip to place its entries', () => {
    const bands = [...turbo(), band('d', 2_010_000, 2_014_999)];
    const step = planTip({ bands, stableTop: 2_021_000, from: 2_015_000 });
    assert.deepEqual(step?.heightRange, [2_015_000, null]);
    assert.deepEqual(step?.read, [2_010_000, 2_021_000]);
    assert.equal(step?.keepFrom, 2_015_000);
    assert.equal(step?.replaces, undefined, 'a new start: always published');
  });

  it("supersedes a legacy layout's recent and delta bands, and replaces neither", () => {
    const legacy = [
      band('h', 1_900_000, 1_999_999),
      band('r', 2_000_000, 2_007_270),
      band('d', 2_006_759, null, { top: 2_009_000 }),
    ];
    const step = planTip({
      bands: legacy,
      stableTop: 2_010_000,
      from: 2_000_000,
    });
    assert.deepEqual(step?.supersedes, [legacy[1].id, legacy[2].id]);
    assert.equal(step?.replaces, undefined);
    assert.deepEqual(step?.read, [2_000_000, 2_010_000]);
  });

  it('plans nothing when the sources do not reach the start', () => {
    assert.equal(
      planTip({ bands: turbo(), stableTop: 2_009_999, from: 2_010_000 }),
      undefined,
    );
  });
});

describe('resettleDue and planResettle', () => {
  const week = 7 * DAY;

  it('is due an interval after the band was built or last re-settled', () => {
    const b = band('d', 2_000_000, 2_004_999);
    assert.equal(resettleDue(b, undefined, CREATED + week - 1, week), false);
    assert.equal(resettleDue(b, undefined, CREATED + week, week), true);
    const settled = new Date(CREATED + 5 * DAY).toISOString();
    assert.equal(resettleDue(b, settled, CREATED + week, week), false);
    assert.equal(resettleDue(b, settled, CREATED + 12 * DAY, week), true);
    assert.equal(
      resettleDue(b, undefined, CREATED + 99 * week, 0),
      false,
      'never',
    );
  });

  it('plans the due bands, the one with the most entries first, each replacing itself', () => {
    const bands = [
      band('h', 1_800_000, 1_899_999, { records: 4_000_000 }),
      band('h', 1_900_000, 1_999_999, { records: 9_000_000 }),
      band('d', 2_000_000, 2_004_999, { records: 300_000 }),
      band('d', 2_005_000, 2_009_999, {
        records: 400_000,
        createdAt: CREATED + 6 * DAY,
      }),
      band('tip', 2_010_000, null, { records: 1_000_000 }),
    ];
    const steps = planResettle(bands, {
      now: CREATED + week,
      intervalMs: week,
      force: false,
      settledAt: {},
    });
    assert.deepEqual(ranges(steps), [
      ['h', [1_900_000, 1_999_999]],
      ['h', [1_800_000, 1_899_999]],
      ['d', [2_000_000, 2_004_999]],
    ]);
    const [first] = steps;
    assert.equal(first.grid, 'resettle');
    assert.equal(first.fold?.id, bands[1].id);
    assert.equal(first.replaces?.id, bands[1].id);
    assert.deepEqual(first.supersedes, [bands[1].id]);
    assert.deepEqual(first.read, [1_900_000, 1_999_999]);
  });

  it('skips a band re-settled within the interval, unless forced', () => {
    const bands = [band('d', 2_000_000, 2_004_999)];
    const settledAt = {
      [bands[0].id]: new Date(CREATED + 8 * DAY).toISOString(),
    };
    const options = { now: CREATED + 9 * DAY, intervalMs: week, settledAt };
    assert.deepEqual(planResettle(bands, { ...options, force: false }), []);
    assert.equal(planResettle(bands, { ...options, force: true }).length, 1);
    assert.equal(
      planResettle(bands, { ...options, intervalMs: 0, force: true }).length,
      1,
      'forced even with automatic re-settles off',
    );
  });

  it("rebuilds a legacy layout's frozen r as an h", () => {
    const [step] = planResettle([band('r', 1_900_000, 1_999_999)], {
      now: CREATED,
      intervalMs: week,
      force: true,
      settledAt: {},
    });
    assert.equal(step.role, 'h');
    assert.equal(step.fold?.role, 'r');
  });
});

describe('describeGridStep', () => {
  it('names the bands a step reads, folds, places and supersedes', () => {
    const bands = turbo();
    const tip = planTip({ bands, stableTop: 2_016_000, from: 2_010_000 });
    assert.deepEqual(describeGridStep(tip!), {
      step: 'tip',
      role: 'tip',
      heightRange: [2_010_000, null],
      supersedes: [bands[4].id],
      read: [2_010_000, 2_016_000],
      seeds: [bands[4].id],
      replaces: bands[4].id,
    });
  });
});
