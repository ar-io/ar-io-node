/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { parsePruneStableDataItemsParams } from './prune-stable-data-items-params.js';

const range = { startHeight: 1500000, endHeight: 1509999 };

describe('parsePruneStableDataItemsParams', () => {
  it('passes stableAtThreshold through as stableAtThreshold only', () => {
    assert.deepEqual(
      parsePruneStableDataItemsParams({
        stableAtThreshold: 1700000000,
        ...range,
      }),
      { ok: true, params: { stableAtThreshold: 1700000000, ...range } },
    );
  });

  it('passes indexedAtThreshold through as indexedAtThreshold only', () => {
    assert.deepEqual(
      parsePruneStableDataItemsParams({
        indexedAtThreshold: 1700000000,
        ...range,
      }),
      { ok: true, params: { indexedAtThreshold: 1700000000, ...range } },
    );
  });

  it('accepts 0 as a threshold and a single-height range', () => {
    const result = parsePruneStableDataItemsParams({
      stableAtThreshold: 0,
      startHeight: 7,
      endHeight: 7,
    });
    assert.equal(result.ok, true);
  });

  it('refuses both thresholds, and neither', () => {
    for (const body of [
      { stableAtThreshold: 1, indexedAtThreshold: 1, ...range },
      { ...range },
      undefined,
    ]) {
      assert.deepEqual(parsePruneStableDataItemsParams(body), {
        ok: false,
        message: 'Give exactly one of stableAtThreshold or indexedAtThreshold',
      });
    }
  });

  it('names the threshold that is invalid', () => {
    for (const bad of [-1, 1.5, '1700000000', null]) {
      assert.deepEqual(
        parsePruneStableDataItemsParams({ stableAtThreshold: bad, ...range }),
        {
          ok: false,
          message: 'Invalid stableAtThreshold - must be a positive integer',
        },
      );
      assert.deepEqual(
        parsePruneStableDataItemsParams({ indexedAtThreshold: bad, ...range }),
        {
          ok: false,
          message: 'Invalid indexedAtThreshold - must be a positive integer',
        },
      );
    }
  });

  it('refuses a bad height range', () => {
    const t = { stableAtThreshold: 1 };
    assert.match(
      (
        parsePruneStableDataItemsParams({
          ...t,
          startHeight: -1,
          endHeight: 5,
        }) as { message: string }
      ).message,
      /Invalid startHeight/,
    );
    assert.match(
      (
        parsePruneStableDataItemsParams({
          ...t,
          startHeight: 10,
          endHeight: 9,
        }) as { message: string }
      ).message,
      /Invalid endHeight/,
    );
    assert.match(
      (
        parsePruneStableDataItemsParams({
          ...t,
          startHeight: 1,
          endHeight: 2.5,
        }) as { message: string }
      ).message,
      /Invalid endHeight/,
    );
  });
});
