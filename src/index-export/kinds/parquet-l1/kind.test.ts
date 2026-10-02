/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  l1RangeOf,
  type ParquetL1Band,
} from '../../../lib/parquet-l1/layout.js';
import { L1PublishedBand, planL1 } from './kind.js';

const band = (id: string, from: number, to: number): L1PublishedBand => ({
  id,
  dir: `/x/${id}`,
  from,
  to,
  band: { heightRange: [from, to] } as ParquetL1Band,
});

describe('l1RangeOf', () => {
  it('puts the sparse early chain in one range, then a range every 25,000', () => {
    assert.deepEqual(l1RangeOf(0), [0, 499_999]);
    assert.deepEqual(l1RangeOf(499_999), [0, 499_999]);
    assert.deepEqual(l1RangeOf(500_000), [500_000, 524_999]);
    assert.deepEqual(l1RangeOf(524_999), [500_000, 524_999]);
    assert.deepEqual(l1RangeOf(525_000), [525_000, 549_999]);
    assert.deepEqual(l1RangeOf(2_012_630), [2_000_000, 2_024_999]);
  });
});

describe('planL1', () => {
  it('bootstraps every whole range in order, then the tip band', () => {
    const steps = planL1([], 590_000);
    assert.deepEqual(
      steps.map((s) => [s.role, s.heightRange]),
      [
        ['h', [0, 499_999]],
        ['h', [500_000, 524_999]],
        ['h', [525_000, 549_999]],
        ['h', [550_000, 574_999]],
        ['d', [575_000, 590_000]],
      ],
    );
  });

  it('builds only what is missing, and nothing while the tip band is current', () => {
    const bands = [
      band('a', 0, 499_999),
      band('b', 500_000, 524_999),
      band('tip', 525_000, 530_000),
    ];
    assert.deepEqual(planL1(bands, 530_000), []);
    assert.deepEqual(
      planL1(
        bands.filter((b) => b.id !== 'b'),
        530_000,
      ).map((s) => s.heightRange),
      [[500_000, 524_999]],
    );
  });

  it('rebuilds a moved tip band, superseding the old one, and closes a range at its edge', () => {
    const bands = [
      band('a', 0, 499_999),
      band('b', 500_000, 524_999),
      band('tip', 525_000, 530_000),
    ];
    assert.deepEqual(planL1(bands, 531_000), [
      { role: 'd', heightRange: [525_000, 531_000], supersedes: ['tip'] },
    ]);
    // The top reaches the range's end: a whole band, superseding the tip.
    assert.deepEqual(planL1(bands, 549_999), [
      { role: 'h', heightRange: [525_000, 549_999], supersedes: ['tip'] },
    ]);
    // Past it: the whole band, then a new tip band in the next range.
    assert.deepEqual(
      planL1(bands, 550_005).map((s) => [s.role, s.heightRange, s.supersedes]),
      [
        ['h', [525_000, 549_999], ['tip']],
        ['d', [550_000, 550_005], []],
      ],
    );
  });

  it('names the earlier tip bands it remembers, from the same start only', () => {
    const bands = [
      band('a', 0, 499_999),
      band('l1-h500000-510000-p-c', 500_000, 510_000),
    ];
    assert.deepEqual(
      planL1(bands, 524_999, [
        'l1-h500000-505000-p-a',
        'l1-h500000-508000-p-b',
        'l1-h475000-480000-p-x',
        'l1-h5000000-5000001-p-y',
      ])[0].supersedes,
      [
        'l1-h500000-505000-p-a',
        'l1-h500000-508000-p-b',
        'l1-h500000-510000-p-c',
      ],
    );
  });

  it('plans nothing with no stable top', () => {
    assert.deepEqual(planL1([], -1), []);
  });
});
