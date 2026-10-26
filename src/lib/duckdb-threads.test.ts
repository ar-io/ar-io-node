/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  DEFAULT_DUCKDB_THREADS,
  MAX_DUCKDB_THREADS,
  parseDuckdbThreads,
} from './duckdb-threads.js';

describe('parseDuckdbThreads', () => {
  it('defaults to one thread (DuckDB 1.4 can crash merging a spilled aggregate on more)', () => {
    assert.equal(DEFAULT_DUCKDB_THREADS, 1);
    assert.equal(parseDuckdbThreads(undefined), 1);
  });

  it('takes a whole number from 1 to the maximum', () => {
    assert.equal(parseDuckdbThreads('1'), 1);
    assert.equal(parseDuckdbThreads('4'), 4);
    assert.equal(
      parseDuckdbThreads(String(MAX_DUCKDB_THREADS)),
      MAX_DUCKDB_THREADS,
    );
  });

  it('refuses anything else, naming the option', () => {
    for (const bad of [
      '0',
      '-1',
      '1.5',
      'two',
      '',
      String(MAX_DUCKDB_THREADS + 1),
    ]) {
      assert.throws(
        () => parseDuckdbThreads(bad, '--duckdb-threads'),
        /--duckdb-threads must be a whole number from 1 to 64/,
        bad,
      );
    }
  });
});
