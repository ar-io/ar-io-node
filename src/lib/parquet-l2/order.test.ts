/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { orderByClause, PARQUET_L2_TABLES } from './layout.js';
import { withBandWriter } from '../../index-export/kinds/parquet-l1/export.js';
import { rowComparator, rowIdentity } from './order.js';

const DATA_ITEMS = PARQUET_L2_TABLES.find((t) => t.name === 'data_items')!;

describe('rowComparator', () => {
  it("sorts data_items rows as DuckDB's ORDER BY does", async () => {
    // Ids sharing prefixes, of other lengths, with high bytes; locations
    // set and null.
    const ids = [
      Buffer.from('00', 'hex'),
      Buffer.from('0000', 'hex'),
      Buffer.from('ff', 'hex'),
      Buffer.from('7f00', 'hex'),
      Buffer.from('80', 'hex'),
      ...Array.from({ length: 20 }, (_, i) =>
        crypto.createHash('sha256').update(String(i)).digest(),
      ),
    ];
    const rows: unknown[][] = [];
    let n = 0;
    for (const height of [10, 2, 2 ** 40]) {
      for (const bti of [3, 0]) {
        for (const id of ids) {
          n += 1;
          const located = n % 3 !== 0;
          const values: Record<string, unknown> = {
            id,
            height,
            block_transaction_index: bti,
            root_parent_offset: located ? (n % 5) * 1000 : null,
            offset: located ? n * 7 : null,
          };
          rows.push(DATA_ITEMS.columns.map((c) => values[c.name] ?? null));
        }
      }
    }
    const compare = rowComparator(DATA_ITEMS);
    const js = [...rows].sort(compare).map((row) => rowIdentity(row));
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parquet-l2-order-'));
    try {
      const fromDuck = await withBandWriter(dir, async (duck) => {
        const literal = (value: unknown, type: string) =>
          value === null
            ? `NULL::${type}`
            : type === 'BLOB'
              ? `unhex('${(value as Buffer).toString('hex')}')`
              : `${String(value)}::${type}`;
        const values = rows
          .map(
            (row) =>
              `(${row.map((v, i) => literal(v, DATA_ITEMS.columns[i].type)).join(', ')})`,
          )
          .join(', ');
        const names = DATA_ITEMS.columns.map((c) => `"${c.name}"`).join(', ');
        return (await duck.all(
          `SELECT * FROM (VALUES ${values}) v(${names}) ORDER BY ${orderByClause(DATA_ITEMS)}`,
        )) as Array<Record<string, unknown>>;
      });
      const duck = fromDuck.map((row) =>
        rowIdentity(
          DATA_ITEMS.columns.map((c) => {
            const value = row[c.name];
            return typeof value === 'bigint' ? Number(value) : value;
          }),
        ),
      );
      assert.deepEqual(js, duck);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('compares numbers and bigints alike, and puts nulls last', () => {
    const compare = rowComparator(DATA_ITEMS);
    const row = (height: unknown, offset: unknown) =>
      DATA_ITEMS.columns.map((c) =>
        c.name === 'height'
          ? height
          : c.name === 'offset'
            ? offset
            : c.name === 'id'
              ? Buffer.alloc(32)
              : c.name === 'block_transaction_index'
                ? 0
                : null,
      );
    assert.equal(compare(row(5, 1), row(5n, 1n)), 0);
    assert.ok(compare(row(5, 1), row(6n, 0)) < 0);
    assert.ok(compare(row(5, 1), row(5, null)) < 0);
    assert.ok(compare(row(5, null), row(5, 1)) > 0);
  });

  it('gives rows one identity exactly when their values agree', () => {
    assert.equal(
      rowIdentity([Buffer.from('ab'), 1, null, 'x']),
      rowIdentity([Buffer.from('ab'), 1, null, 'x']),
    );
    assert.notEqual(rowIdentity([null, 1]), rowIdentity([1, null]));
    assert.notEqual(rowIdentity(['1']), rowIdentity([1]));
    assert.notEqual(
      rowIdentity([Buffer.from('a|b')]),
      rowIdentity([Buffer.from('a'), Buffer.from('b')]),
    );
  });
});
