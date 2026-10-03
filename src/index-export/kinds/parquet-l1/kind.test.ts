/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createTestLogger } from '../../../../test/test-logger.js';

import {
  isL1BandRange,
  L1_SPAN,
  L1_SUB_SPAN,
  l1RangeOf,
  l1SubRangeOf,
  type ParquetL1Band,
} from '../../../lib/parquet-l1/layout.js';
import { isTransientSqliteError, L1CheckError } from './export.js';
import { L1PublishedBand, planL1, withReadRetry } from './kind.js';

const band = (id: string, from: number, to: number): L1PublishedBand => ({
  id,
  dir: `/x/${id}`,
  from,
  to,
  band: { heightRange: [from, to] } as ParquetL1Band,
});

describe('the fixed grids', () => {
  it('puts a height in its history range and its sub-range', () => {
    assert.deepEqual(l1RangeOf(0), [0, 99_999]);
    assert.deepEqual(l1RangeOf(99_999), [0, 99_999]);
    assert.deepEqual(l1RangeOf(100_000), [100_000, 199_999]);
    assert.deepEqual(l1RangeOf(2_012_630), [2_000_000, 2_099_999]);
    assert.deepEqual(l1SubRangeOf(0), [0, 4_999]);
    assert.deepEqual(l1SubRangeOf(4_999), [0, 4_999]);
    assert.deepEqual(l1SubRangeOf(2_012_630), [2_010_000, 2_014_999]);
  });

  it('nests the sub-range grid inside the history grid', () => {
    assert.equal(L1_SPAN % L1_SUB_SPAN, 0);
    for (const h of [0, 4_999, 99_999, 100_000, 1_234_567]) {
      const [rf, rt] = l1RangeOf(h);
      const [sf, st] = l1SubRangeOf(h);
      assert.ok(sf >= rf && st <= rt, `sub-range of ${h} inside its range`);
    }
  });

  it('accepts only a whole range, a whole sub-range, or a tip', () => {
    assert.equal(isL1BandRange(0, 99_999), true, 'whole range');
    assert.equal(isL1BandRange(100_000, 104_999), true, 'whole sub-range');
    assert.equal(isL1BandRange(100_000, 100_003), true, 'tip');
    assert.equal(isL1BandRange(100_000, 199_999), true);
    assert.equal(isL1BandRange(1, 99_999), false, 'not on a boundary');
    assert.equal(isL1BandRange(100_000, 105_000), false, 'past its sub-range');
    assert.equal(isL1BandRange(100_000, 149_999), false, 'neither grid');
    assert.equal(isL1BandRange(5, 10), false);
    assert.equal(isL1BandRange(-1, 10), false);
    assert.equal(isL1BandRange(10, 5), false);
  });
});

describe('planL1', () => {
  const roles = (steps: ReturnType<typeof planL1>) =>
    steps.map((s) => [s.role, s.heightRange] as const);

  it('bootstraps whole history ranges, then sub-ranges, then the tip', () => {
    assert.deepEqual(roles(planL1([], 212_345)), [
      ['h', [0, 99_999]],
      ['h', [100_000, 199_999]],
      ['d', [200_000, 204_999]],
      ['d', [205_000, 209_999]],
      ['d', [210_000, 212_345]],
    ]);
  });

  it('builds nothing while the tip is current', () => {
    const bands = [
      band('l1-h0-99999-p-a', 0, 99_999),
      band('l1-h100000-104999-p-b', 100_000, 104_999),
      band('l1-h105000-106000-p-tip', 105_000, 106_000),
    ];
    assert.deepEqual(planL1(bands, 106_000), []);
  });

  it('rebuilds only the tip as the top moves, superseding the tip before it', () => {
    const bands = [
      band('l1-h0-99999-p-a', 0, 99_999),
      band('l1-h100000-104999-p-b', 100_000, 104_999),
      band('l1-h105000-106000-p-tip', 105_000, 106_000),
    ];
    assert.deepEqual(planL1(bands, 106_500), [
      {
        role: 'd',
        heightRange: [105_000, 106_500],
        supersedes: ['l1-h105000-106000-p-tip'],
      },
    ]);
  });

  it('graduates the tip into a whole sub-range, then starts the next tip', () => {
    const bands = [
      band('l1-h0-99999-p-a', 0, 99_999),
      band('l1-h100000-101000-p-tip', 100_000, 101_000),
    ];
    // The top reaches the sub-range's end: one whole sub-range, no tip.
    assert.deepEqual(planL1(bands, 104_999), [
      {
        role: 'd',
        heightRange: [100_000, 104_999],
        supersedes: ['l1-h100000-101000-p-tip'],
      },
    ]);
    // Past it: the whole sub-range, then a tip in the next one.
    assert.deepEqual(roles(planL1(bands, 105_020)), [
      ['d', [100_000, 104_999]],
      ['d', [105_000, 105_020]],
    ]);
  });

  it('folds a completed history range, superseding every band inside it', () => {
    const bands = [
      band('l1-h0-4999-p-a', 0, 4_999),
      band('l1-h5000-9999-p-b', 5_000, 9_999),
      band('l1-h95000-99999-p-c', 95_000, 99_999),
      band('l1-h100000-100500-p-tip', 100_000, 100_500),
    ];
    const [fold] = planL1(bands, 100_500);
    assert.equal(fold.role, 'h');
    assert.deepEqual(fold.heightRange, [0, 99_999]);
    assert.deepEqual(fold.supersedes, [
      'l1-h0-4999-p-a',
      'l1-h5000-9999-p-b',
      'l1-h95000-99999-p-c',
    ]);
    // The tip of the next range is left alone.
    assert.equal(fold.supersedes.includes('l1-h100000-100500-p-tip'), false);
  });

  it('names the superseded ids it remembers that its own range covers', () => {
    const bands = [band('l1-h0-99999-p-a', 0, 99_999)];
    const step = planL1(bands, 104_999, [
      'l1-h100000-100200-p-t1',
      'l1-h100000-100900-p-t2',
      'l1-h200000-200100-p-elsewhere',
    ])[0];
    assert.deepEqual(step.heightRange, [100_000, 104_999]);
    assert.deepEqual(step.supersedes, [
      'l1-h100000-100200-p-t1',
      'l1-h100000-100900-p-t2',
    ]);
  });

  it('plans nothing with no stable top', () => {
    assert.deepEqual(planL1([], -1), []);
  });

  it('leaves no gap: every height up to the top is covered once it is built', () => {
    let bands: L1PublishedBand[] = [];
    let n = 0;
    for (const top of [3_000, 4_999, 12_345, 99_999, 100_000, 234_567]) {
      for (const step of planL1(bands, top)) {
        n += 1;
        const [from, to] = step.heightRange;
        assert.ok(isL1BandRange(from, to), `step ${from}-${to} is on the grid`);
        const supersedes = new Set(step.supersedes);
        bands = bands
          .filter((b) => !supersedes.has(b.id))
          .concat(band(`l1-h${from}-${to}-p-${n}`, from, to));
      }
      const live = [...bands].sort((a, b) => a.from - b.from);
      let next = 0;
      for (const b of live) {
        assert.equal(b.from, next, `no gap or overlap before ${b.from}`);
        next = b.to + 1;
      }
      assert.equal(next - 1, top, `covered up to ${top}`);
    }
  });
});

describe('withReadRetry', () => {
  const log = createTestLogger({ suite: 'parquet-l1 read retry' });
  const opts = (slept: number[]) => ({
    log,
    heightRange: [0, 99] as [number, number],
    delayMs: 10,
    sleep: async (ms: number) => {
      slept.push(ms);
    },
  });
  const readonly = () =>
    Object.assign(new Error('attempt to write a readonly database'), {
      code: 'SQLITE_READONLY',
    });

  it('classifies only the errors that pass as transient', () => {
    for (const e of [
      readonly(),
      Object.assign(new Error('x'), { code: 'SQLITE_BUSY' }),
      Object.assign(new Error('x'), { code: 'SQLITE_IOERR_SHORT_READ' }),
      new Error('database is locked'),
    ]) {
      assert.equal(isTransientSqliteError(e), true, String(e));
    }
    for (const e of [
      new L1CheckError('Heights 0-9 fail the chain checks at 3 (tx_root)'),
      new Error('no such table: stable_blocks'),
      Object.assign(new Error('x'), { code: 'SQLITE_CORRUPT' }),
      undefined,
    ]) {
      assert.equal(isTransientSqliteError(e), false, String(e));
    }
  });

  it('builds the band again after a refused read, backing off', async () => {
    const slept: number[] = [];
    let calls = 0;
    const got = await withReadRetry(async () => {
      calls += 1;
      if (calls < 3) throw readonly();
      return 'band';
    }, opts(slept));
    assert.equal(got, 'band');
    assert.equal(calls, 3);
    assert.deepEqual(slept, [10, 20], 'backs off further each time');
  });

  it('gives up after its retries, throwing the last refusal', async () => {
    const slept: number[] = [];
    let calls = 0;
    await assert.rejects(
      withReadRetry(async () => {
        calls += 1;
        throw readonly();
      }, opts(slept)),
      /attempt to write a readonly database/,
    );
    assert.equal(calls, 3, 'the first try and two retries');
  });

  it('never rebuilds for a chain check: it would fail the same way', async () => {
    const slept: number[] = [];
    let calls = 0;
    await assert.rejects(
      withReadRetry(async () => {
        calls += 1;
        throw new L1CheckError(
          'Heights 0-99 fail the chain checks at 7 (anchor)',
        );
      }, opts(slept)),
      /fail the chain checks/,
    );
    assert.equal(calls, 1);
    assert.deepEqual(slept, []);
  });
});
