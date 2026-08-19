/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import { percentOrDefault } from './env.js';

const VAR = 'TEST_PERCENT_VAR';

describe('percentOrDefault', () => {
  afterEach(() => {
    delete process.env[VAR];
  });

  it('returns the default when unset', () => {
    assert.equal(percentOrDefault(VAR, 0), 0);
    assert.equal(percentOrDefault(VAR, 85), 85);
  });

  it('accepts the inclusive bounds', () => {
    for (const v of ['0', '1', '50', '99', '100']) {
      process.env[VAR] = v;
      assert.equal(percentOrDefault(VAR, 0), Number(v));
    }
  });

  it('rejects values above 100', () => {
    // A low watermark of 150 made `usedPercent < low` always true, so the
    // cleanup walk skipped every cycle and the cache grew unbounded -- the
    // exact failure the watermarks exist to prevent.
    process.env[VAR] = '150';
    assert.throws(
      () => percentOrDefault(VAR, 0),
      /must be an integer percentage/,
    );
  });

  it('rejects negative values', () => {
    process.env[VAR] = '-1';
    assert.throws(
      () => percentOrDefault(VAR, 0),
      /must be an integer percentage/,
    );
  });

  it('rejects non-numeric values instead of coercing to NaN', () => {
    // `+env.varOrDefault(...)` turned these into NaN, which silently disabled
    // the control it configured: every comparison against NaN is false, so a
    // NaN low watermark could neither skip nor clear the draining latch and
    // the worker stayed aggressive forever.
    for (const v of ['abc', '50GiB', 'NaN', 'true', '85%']) {
      process.env[VAR] = v;
      assert.throws(
        () => percentOrDefault(VAR, 0),
        /must be an integer percentage/,
        `expected rejection for ${JSON.stringify(v)}`,
      );
    }
  });

  it('treats empty and whitespace as unset, matching varOrDefault', () => {
    // varOrDefault falls back on `value.trim() === ''`, so a blank assignment
    // means "use the default" rather than "invalid" -- consistent with every
    // other setting in config.ts.
    for (const v of ['', ' ', '\t']) {
      process.env[VAR] = v;
      assert.equal(percentOrDefault(VAR, 85), 85);
    }
  });

  it('accepts unambiguous numeric forms', () => {
    // Number() resolves these to real integers in range; there is no ambiguity
    // to protect against, so they are valid.
    process.env[VAR] = '1e2';
    assert.equal(percentOrDefault(VAR, 0), 100);
    process.env[VAR] = '0x10';
    assert.equal(percentOrDefault(VAR, 0), 16);
  });

  it('rejects non-integer percentages', () => {
    process.env[VAR] = '85.5';
    assert.throws(
      () => percentOrDefault(VAR, 0),
      /must be an integer percentage/,
    );
  });
});
