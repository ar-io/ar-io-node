/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { RowDigest } from './digest.js';
import type { ColumnSpec } from './layout.js';

const columns: ColumnSpec[] = [
  { name: 'id', type: 'BLOB' },
  { name: 'height', type: 'UBIGINT' },
  { name: 'quantity', type: 'DECIMAL(20,0)' },
  { name: 'content_type', type: 'VARCHAR' },
  { name: 'is_data_item', type: 'BOOLEAN' },
];

const digest = (rows: unknown[][]) => {
  const d = new RowDigest(columns);
  for (const row of rows) d.add(row);
  return d.hex();
};

describe('RowDigest', () => {
  it('is the same however a reader returns a value', () => {
    const id = Buffer.alloc(32, 1);
    assert.equal(
      digest([[id, 5, '100000000000000000000', 'text/plain', false]]),
      digest([
        [new Uint8Array(id), 5n, 100000000000000000000n, 'text/plain', 0],
      ]),
    );
  });

  it('changes with any value, the order of rows, and null against empty', () => {
    const id = Buffer.alloc(32, 1);
    const base = digest([
      [id, 1, '1', 'a', false],
      [id, 2, '2', 'b', true],
    ]);
    assert.notEqual(
      base,
      digest([
        [id, 2, '2', 'b', true],
        [id, 1, '1', 'a', false],
      ]),
    );
    assert.notEqual(
      base,
      digest([
        [id, 1, '1', 'a', false],
        [id, 2, '2', 'c', true],
      ]),
    );
    assert.notEqual(
      digest([[id, 1, '1', null, false]]),
      digest([[id, 1, '1', '', false]]),
    );
    // Field boundaries are length-prefixed: shifting bytes between fields shows.
    assert.notEqual(
      digest([[id, 1, '1', 'ab', false]]),
      digest([[id, 11, '1', 'b', false]]),
    );
  });

  it('refuses a value of the wrong kind, naming the column', () => {
    const d = new RowDigest(columns);
    assert.throws(
      () => d.add([Buffer.alloc(1), 1.5, '1', 'a', true]),
      /Column height: Not an exact integer/,
    );
    assert.throws(
      () => d.add(['not bytes', 1, '1', 'a', true]),
      /Column id: Not bytes/,
    );
    assert.throws(
      () => d.add([Buffer.alloc(1)]),
      /1 values, the table 5 columns/,
    );
  });
});
