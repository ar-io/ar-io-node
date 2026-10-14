/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { parseSelection } from '../../../lib/parquet-l2/layout.js';
import { GridLayoutError } from '../root-tx/planner-grid.js';
import type { L2LiveBand } from './bands.js';
import {
  classifyL2Bands,
  l2ResettleDue,
  l2Role,
  planL2Freezes,
  planL2Pin,
  planL2Resettle,
  planL2Rolls,
  planL2Tip,
} from './planner.js';

const SELECTION = parseSelection({
  kind: 'ans104-data-items',
  tag: { name: 'App-Name', valuePrefix: 'ArDrive' },
});
const DAY = 24 * 3600_000;
const NOW = Date.parse('2026-10-14T04:00:00Z');

let next = 0;
/** A live band; settled when `settledAt` is given. */
function band(
  from: number,
  to: number,
  { settledAt, rows = 10 }: { settledAt?: string; rows?: number } = {},
): L2LiveBand {
  next += 1;
  const id = `l2-h${from}-${to}-0123abcd-${next.toString(16).padStart(12, '0')}`;
  return {
    id,
    dir: `/bands/${id}`,
    from,
    to,
    band: {
      version: 1,
      schema: 'l2-1',
      heightRange: [from, to],
      selection: SELECTION,
      tables: {
        data_items: { rows, rowDigest: '0'.repeat(64) },
        tags: { rows: 0, rowDigest: '0'.repeat(64) },
        wallets: { rows: 0, rowDigest: '0'.repeat(64) },
        parents: { rows: 0, rowDigest: '0'.repeat(64) },
      },
      createdAt: '2026-10-01T00:00:00.000Z',
    },
    facts: {
      builtAt: '2026-10-01T00:00:00.000Z',
      ...(settledAt !== undefined ? { settledAt } : {}),
    },
  };
}
const settled = (
  from: number,
  to: number,
  more: { rows?: number; settledAt?: string } = {},
) => band(from, to, { settledAt: '2026-10-01T00:00:00.000Z', ...more });
const ranges = (steps: Array<{ heightRange: [number, number] }>) =>
  steps.map((step) => step.heightRange);

describe('l2Role and classifyL2Bands', () => {
  it('reads a band role from its heights and whether it settled', () => {
    assert.equal(l2Role(band(100_000, 199_999)), 'h');
    assert.equal(l2Role(settled(100_000, 104_999)), 'd');
    assert.equal(l2Role(band(100_000, 104_999)), 'tip');
    assert.equal(l2Role(band(100_000, 100_200)), 'tip');
    assert.equal(l2Role(band(100_001, 100_200)), undefined);
    assert.equal(l2Role(band(100_000, 105_000)), undefined);
  });

  it('refuses bands nothing reconciles', () => {
    assert.throws(
      () => classifyL2Bands([band(100_001, 100_200)]),
      GridLayoutError,
    );
    assert.throws(
      () =>
        classifyL2Bands([band(100_000, 199_999), settled(100_000, 104_999)]),
      /overlap/,
    );
    assert.throws(
      () =>
        classifyL2Bands([settled(100_000, 104_999), band(100_000, 100_200)]),
      /inside the frozen heights/,
    );
    assert.throws(
      () => classifyL2Bands([band(105_000, 105_100), band(105_000, 105_200)]),
      /tips of one sub-range/,
    );
    const { frozen, tips } = classifyL2Bands([
      band(105_000, 105_100),
      settled(100_000, 104_999),
      band(0, 99_999),
    ]);
    assert.deepEqual(
      ranges(frozen.map((b) => ({ heightRange: [b.from, b.to] }))),
      [
        [0, 99_999],
        [100_000, 104_999],
      ],
    );
    assert.equal(tips.length, 1);
  });
});

describe('planL2Freezes', () => {
  it('bootstraps from the start height range: whole ranges, then sub-ranges, while settled', () => {
    const steps = planL2Freezes({
      bands: [],
      stableTop: 215_100,
      settleBlocks: 5040,
      startHeight: 150_000,
    });
    assert.deepEqual(ranges(steps), [
      [100_000, 199_999],
      [200_000, 204_999],
      [205_000, 209_999],
    ]);
    assert.deepEqual(
      steps.map((s) => [s.step, s.role, s.settles]),
      [
        ['freeze', 'h', true],
        ['freeze', 'd', true],
        ['freeze', 'd', true],
      ],
    );
  });

  it('freezes above the frozen top, replacing the tips of its heights', () => {
    const tip = band(210_000, 214_999);
    const steps = planL2Freezes({
      bands: [
        band(100_000, 199_999),
        settled(200_000, 204_999),
        settled(205_000, 209_999),
        tip,
        band(215_000, 215_400),
      ],
      stableTop: 220_100,
      settleBlocks: 5040,
    });
    assert.deepEqual(ranges(steps), [[210_000, 214_999]]);
    assert.deepEqual(steps[0].replaces, [tip]);
  });
});

describe('planL2Rolls', () => {
  it('rolls a range once all twenty of its d bands are frozen', () => {
    const deltas = Array.from({ length: 20 }, (_, i) =>
      settled(200_000 + i * 5000, 204_999 + i * 5000),
    );
    const steps = planL2Rolls([band(100_000, 199_999), ...deltas]);
    assert.deepEqual(ranges(steps), [[200_000, 299_999]]);
    assert.equal(steps[0].role, 'h');
    assert.equal(steps[0].replaces.length, 20);
    assert.deepEqual(planL2Rolls(deltas.slice(1)), []);
  });
});

describe('planL2Tip', () => {
  it('covers every sub-range above the frozen bands to the stable top, each replacing its tip', () => {
    const old = band(210_000, 214_999);
    const top = band(215_000, 215_100);
    const steps = planL2Tip({
      bands: [
        band(100_000, 199_999),
        settled(200_000, 209_999 - 5000),
        settled(205_000, 209_999),
        old,
        top,
      ],
      stableTop: 215_300,
    });
    assert.deepEqual(ranges(steps), [
      [210_000, 214_999],
      [215_000, 215_300],
    ]);
    assert.deepEqual(steps[0].replaces, [old]);
    assert.deepEqual(steps[1].replaces, [top]);
    assert.ok(steps.every((s) => s.role === 'tip' && !s.settles));
    // Above what a dry run built.
    assert.deepEqual(
      ranges(
        planL2Tip({
          bands: [],
          stableTop: 112_000,
          startHeight: 100_000,
          above: 109_999,
        }),
      ),
      [[110_000, 112_000]],
    );
    assert.deepEqual(
      planL2Tip({ bands: [band(0, 99_999)], stableTop: 99_999 }),
      [],
    );
  });
});

describe('planL2Resettle', () => {
  it('re-settles frozen bands an interval after they settled or were last re-settled, the largest first', () => {
    const old = settled(100_000, 104_999, {
      rows: 5,
      settledAt: new Date(NOW - 8 * DAY).toISOString(),
    });
    const recent = settled(105_000, 109_999, {
      rows: 50,
      settledAt: new Date(NOW - DAY).toISOString(),
    });
    const big = band(0, 99_999, { rows: 500 });
    const tip = band(110_000, 110_100);
    const bands = [big, old, recent, tip];
    const due = planL2Resettle(bands, {
      now: NOW,
      intervalMs: 7 * DAY,
      force: false,
      resettledAt: {},
    });
    // The h has only its build time, 2026-10-01: due too.
    assert.deepEqual(ranges(due), [
      [0, 99_999],
      [100_000, 104_999],
    ]);
    assert.ok(due.every((s) => s.step === 'resettle' && s.settles));
    assert.deepEqual(due[1].replaces, [old]);
    // Re-settled since: not due.
    assert.equal(
      l2ResettleDue(old, new Date(NOW - DAY).toISOString(), NOW, 7 * DAY),
      false,
    );
    assert.equal(l2ResettleDue(old, undefined, NOW, 0), false);
    const all = planL2Resettle(bands, {
      now: NOW,
      intervalMs: 0,
      force: true,
      resettledAt: {},
    });
    assert.deepEqual(ranges(all), [
      [0, 99_999],
      [105_000, 109_999],
      [100_000, 104_999],
    ]);
  });
});

describe('planL2Pin', () => {
  it('builds one band on the grid, compared with the band of its range', () => {
    const same = band(100_000, 199_999);
    const pin = planL2Pin({
      bands: [same],
      range: [100_000, 199_999],
      stableTop: 300_000,
      settleBlocks: 5040,
    });
    assert.deepEqual([pin.step, pin.role, pin.settles], ['pin', 'h', true]);
    assert.deepEqual(pin.replaces, [same]);
    assert.equal(
      planL2Pin({
        bands: [],
        range: [295_000, 299_999],
        stableTop: 300_000,
        settleBlocks: 5040,
      }).role,
      'tip',
    );
    assert.throws(
      () =>
        planL2Pin({
          bands: [],
          range: [100_000, 150_000],
          stableTop: 300_000,
          settleBlocks: 0,
        }),
      /not on the grid/,
    );
    assert.throws(
      () =>
        planL2Pin({
          bands: [],
          range: [300_000, 304_999],
          stableTop: 300_000,
          settleBlocks: 0,
        }),
      /past the source's stable top/,
    );
  });
});
