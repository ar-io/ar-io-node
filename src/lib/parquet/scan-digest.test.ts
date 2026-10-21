/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The DuckDB readers ({@link scanDigest} and its callers) against the row
 * readers they replace, on generated data: the same digest, the same rows,
 * and the same refusal, word for word, at the same row, whatever the
 * ranges they are read in.
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Database } from 'duckdb-async';

import { PARQUET_L2_TABLES } from '../parquet-l2/layout.js';
import { rowComparator } from '../parquet-l2/order.js';
import { readL2Table, scanL2Table } from '../parquet-l2/tables.js';
import type { ColumnSpec } from './check.js';
import { RowDigest } from './digest.js';
import {
  type LookupSpec,
  readLookupInFileOrder,
  readRows,
  scanLookupInFileOrder,
  scanSortedRows,
  sqlPath,
} from './lookups.js';
import { scanDigest, ScanDigestUnavailable } from './scan-digest.js';

/** mulberry32: repeatable cases. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function literal(value: unknown, type: string): string {
  if (value === null) return `NULL::${type}`;
  if (Buffer.isBuffer(value)) return `from_hex('${value.toString('hex')}')`;
  if (typeof value === 'string') {
    return `'${value.replace(/'/g, "''")}'::${type}`;
  }
  return `(${String(value)})::${type}`;
}

/** Writes rows in the order given, in small row groups. */
async function writeRows(
  duck: Database,
  file: string,
  columns: ColumnSpec[],
  rows: unknown[][],
): Promise<void> {
  const names = columns.map((c) => `"${c.name}"`).join(', ');
  const empty = rows.length === 0;
  const values = (empty ? [columns.map(() => null)] : rows)
    .map(
      (row, n) =>
        `(${n}, ${row.map((v, i) => literal(v, columns[i].type)).join(', ')})`,
    )
    .join(', ');
  await duck.exec(
    `COPY (SELECT ${names} FROM (VALUES ${values}) v(__n, ${names})${empty ? ' WHERE false' : ''} ORDER BY __n) TO ${sqlPath(file)} (FORMAT PARQUET, ROW_GROUP_SIZE 7)`,
  );
}

/** What a reader gave: its digest, or the error it threw. */
async function outcome(read: () => Promise<unknown>): Promise<unknown> {
  try {
    return { ok: await read() };
  } catch (error) {
    return {
      error: (error as Error).constructor.name,
      message: (error as Error).message,
      reason: (error as { reason?: unknown }).reason,
    };
  }
}

const RANGES = [1, 2, 3, 7, 16, 1000];

/** Bytes that sort tricky: empty, prefixes, high bits. */
const BLOBS = ['', '00', '0000', '00ff', '01', '7f', '80', 'ff', 'ff00'].map(
  (h) => Buffer.from(h, 'hex'),
);

describe('scanDigest against the row readers', () => {
  let duck: Database;
  /** Three databases, one task on each at a time, as verifyL2Bands has. */
  const pool = {
    ducks: [] as Database[],
    waiting: [] as Array<() => void>,
    run: async <T>(task: (d: Database) => Promise<T>): Promise<T> => {
      while (pool.ducks.length === 0) {
        await new Promise<void>((resolve) => pool.waiting.push(resolve));
      }
      const d = pool.ducks.pop()!;
      try {
        return await task(d);
      } finally {
        pool.ducks.push(d);
        pool.waiting.shift()?.();
      }
    },
  };
  let dir: string;
  before(async () => {
    duck = await Database.create(':memory:');
    await duck.exec('SET preserve_insertion_order = true; SET threads = 2');
    for (let i = 0; i < 3; i += 1) {
      const d = await Database.create(':memory:');
      await d.exec('SET preserve_insertion_order = true; SET threads = 1');
      pool.ducks.push(d);
    }
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-digest-'));
  });
  after(async () => {
    await duck.close();
    for (const d of pool.ducks) await d.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('digests every type it takes, nulls included, as RowDigest does', async () => {
    const columns: ColumnSpec[] = [
      { name: 'b', type: 'BLOB' },
      { name: 's', type: 'VARCHAR' },
      { name: 't', type: 'BOOLEAN' },
      { name: 'u64', type: 'UBIGINT' },
      { name: 'i64', type: 'BIGINT' },
      { name: 'i', type: 'INTEGER' },
      { name: 'u16', type: 'USMALLINT' },
      { name: 'u8', type: 'UTINYINT' },
    ];
    const pick = <T>(r: () => number, xs: T[]) =>
      xs[Math.floor(r() * xs.length)];
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = random(seed);
      const rows = Array.from({ length: Math.floor(r() * 40) }, () => [
        r() < 0.2 ? null : pick(r, BLOBS),
        r() < 0.2 ? null : pick(r, ['', 'a', "it's", 'héllo', '日本', '😀 x']),
        r() < 0.2 ? null : r() < 0.5,
        r() < 0.2
          ? null
          : pick(r, ['0', '1', '9007199254740993', '18446744073709551615']),
        r() < 0.2 ? null : pick(r, ['-9223372036854775808', '-1', '0', '42']),
        r() < 0.2 ? null : pick(r, [-2147483648, -1, 0, 2147483647]),
        r() < 0.2 ? null : pick(r, [0, 1, 65535]),
        r() < 0.2 ? null : pick(r, [0, 255]),
      ]);
      const file = path.join(dir, `types-${seed}.parquet`);
      await writeRows(duck, file, columns, rows);
      const digest = new RowDigest(columns);
      for (const row of (await duck.all(
        `SELECT * FROM read_parquet(${sqlPath(file)})`,
      )) as Array<Record<string, unknown>>) {
        digest.add(columns.map((c) => row[c.name]));
      }
      for (const rangeRows of RANGES) {
        assert.deepEqual(
          await scanDigest(
            duck,
            {
              relation: `read_parquet(${sqlPath(file)}, file_row_number = true)`,
              position: 'file_row_number',
              rangeRows,
            },
            columns,
          ),
          { rows: digest.rows, rowDigest: digest.hex() },
          `seed ${seed}, ranges of ${rangeRows}`,
        );
      }
    }
  });

  it('leaves HUGEINT to the row reader, which refuses an inexact one', async () => {
    const columns: ColumnSpec[] = [{ name: 'h', type: 'HUGEINT' }];
    const file = path.join(dir, 'huge.parquet');
    await writeRows(duck, file, columns, [
      ['-170141183460469231731687303715884105727'],
    ]);
    await assert.rejects(
      scanDigest(
        duck,
        {
          relation: `read_parquet(${sqlPath(file)}, file_row_number = true)`,
          position: 'file_row_number',
        },
        columns,
      ),
      ScanDigestUnavailable,
    );
  });

  it('leaves to the row reader a column read as another type than declared', async () => {
    const file = path.join(dir, 'recast.parquet');
    await writeRows(duck, file, [{ name: 'x', type: 'DOUBLE' }], [[1.5]]);
    await assert.rejects(
      scanDigest(
        duck,
        {
          relation: `read_parquet(${sqlPath(file)}, file_row_number = true)`,
          position: 'file_row_number',
        },
        [{ name: 'x', type: 'UBIGINT' }],
      ),
      ScanDigestUnavailable,
    );
  });

  it("checks a table's order as the row reader does, refusing at the same rows", async () => {
    const spec = PARQUET_L2_TABLES.find((t) => t.name === 'tags')!;
    const compare = rowComparator(spec);
    const seen = new Set<string>();
    for (let seed = 1; seed <= 40; seed += 1) {
      const r = random(seed);
      const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
      let rows = Array.from({ length: 1 + Math.floor(r() * 30) }, () => [
        r() < 0.05 ? null : BigInt(Math.floor(r() * 3)),
        r() < 0.05 ? null : pick(BLOBS),
        r() < 0.05 ? null : Math.floor(r() * 3),
        pick(BLOBS),
        r() < 0.1 ? null : pick(BLOBS),
      ]);
      rows.sort(compare);
      // Mostly in order and distinct; some with a swap or a repeat.
      const fault = r();
      if (fault < 0.6) {
        rows = rows.filter(
          (row, i) => i === 0 || compare(rows[i - 1], row) < 0,
        );
      }
      if (fault > 0.8 && rows.length > 1) {
        const i = Math.floor(r() * (rows.length - 1));
        [rows[i], rows[i + 1]] = [rows[i + 1], rows[i]];
      } else if (fault > 0.6) {
        rows.splice(Math.floor(r() * rows.length), 0, pick(rows));
      }
      const bandDir = path.join(dir, `table-${seed}`);
      await fs.mkdir(bandDir);
      await writeRows(duck, path.join(bandDir, spec.file), spec.columns, rows);
      const old = await outcome(() =>
        readL2Table(duck, bandDir, spec, { inFileOrder: true }),
      );
      seen.add(String((old as { message?: string }).message ?? 'ok'));
      for (const rangeRows of RANGES) {
        assert.deepEqual(
          await outcome(() => scanL2Table(duck, bandDir, spec, rangeRows)),
          old,
          `seed ${seed}, ranges of ${rangeRows}`,
        );
        assert.deepEqual(
          await outcome(() =>
            scanL2Table(duck, bandDir, spec, rangeRows, pool.run),
          ),
          old,
          `seed ${seed}, ranges of ${rangeRows} side by side`,
        );
      }
    }
    // Both kinds of case were drawn: rows read whole, and rows refused.
    assert.ok(seen.has('ok') && seen.size > 1, [...seen].join('; '));
  });

  const lookup: LookupSpec = {
    name: 'tag',
    file: 'lookup_tag.parquet',
    columns: [
      { name: 'name8', type: 'UBIGINT' },
      { name: 'val8', type: 'UBIGINT' },
      { name: 'name', type: 'BLOB' },
      { name: 'value', type: 'BLOB' },
      { name: 'txs', type: 'UBIGINT' },
      { name: 'role', type: 'UTINYINT' },
    ],
    orderBy: ['name8', 'val8', 'name', 'value'],
    derive: () => 'unused',
  };

  it("checks a lookup's order as the row reader does: the same message at the same row", async () => {
    const keys = [0n, 1n, 2n ** 63n, 2n ** 64n - 1n];
    const seen = new Set<string>();
    for (let seed = 1; seed <= 40; seed += 1) {
      const r = random(1000 + seed);
      const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
      let rows: unknown[][] = Array.from(
        { length: 1 + Math.floor(r() * 30) },
        () => [
          pick(keys),
          pick(keys),
          r() < 0.05 ? null : pick(BLOBS),
          pick(BLOBS),
          r() < 0.1 ? null : BigInt(Math.floor(r() * 3)),
          Math.floor(r() * 2),
        ],
      );
      const cmp = (a: unknown[], b: unknown[]) => {
        for (const i of [0, 1, 2, 3]) {
          const [x, y] = [a[i], b[i]];
          if (x === null || y === null) {
            if (x !== y) return x === null ? 1 : -1;
            continue;
          }
          const o =
            typeof x === 'bigint'
              ? x < (y as bigint)
                ? -1
                : x > (y as bigint)
                  ? 1
                  : 0
              : Buffer.compare(x as Buffer, y as Buffer);
          if (o !== 0) return o;
        }
        return 0;
      };
      rows.sort(cmp);
      const fault = r();
      if (fault < 0.5) {
        rows = rows.filter((row, i) => i === 0 || cmp(rows[i - 1], row) < 0);
      }
      if (fault > 0.85 && rows.length > 1) {
        const i = Math.floor(r() * (rows.length - 1));
        [rows[i], rows[i + 1]] = [rows[i + 1], rows[i]];
      } else if (fault > 0.7) {
        // The same row twice: allowed.
        const i = Math.floor(r() * rows.length);
        rows.splice(i, 0, [...rows[i]]);
      } else if (fault > 0.5) {
        // The same key, another row: refused.
        const i = Math.floor(r() * rows.length);
        rows.splice(i, 0, [...rows[i].slice(0, 4), 7n, rows[i][5]]);
      }
      const file = path.join(dir, `lookup-${seed}.parquet`);
      await writeRows(duck, file, lookup.columns, rows);
      const old = await outcome(() =>
        readLookupInFileOrder(duck, lookup, file),
      );
      const said = (old as { message?: string }).message ?? 'ok';
      seen.add(
        /before the row/.test(said)
          ? 'before'
          : /different row/.test(said)
            ? 'tie'
            : said,
      );
      for (const rangeRows of RANGES) {
        assert.deepEqual(
          await outcome(() =>
            scanLookupInFileOrder(duck, lookup, file, rangeRows),
          ),
          old,
          `seed ${seed}, ranges of ${rangeRows}`,
        );
        assert.deepEqual(
          await outcome(() =>
            scanLookupInFileOrder(duck, lookup, file, rangeRows, pool.run),
          ),
          old,
          `seed ${seed}, ranges of ${rangeRows} side by side`,
        );
      }
      // Sorted, as a lookup's rows are derived: the same digest both ways.
      const from = `read_parquet(${sqlPath(file)})`;
      const sorted = await readRows(duck, lookup, from, { order: 'numeric' });
      for (const rangeRows of RANGES) {
        assert.deepEqual(
          await scanSortedRows(duck, lookup, from, rangeRows),
          sorted,
          `seed ${seed}, sorted, ranges of ${rangeRows}`,
        );
      }
    }
    // Rows read whole, a row before the one ahead, and a key's other row.
    assert.deepEqual([...seen].sort(), ['before', 'ok', 'tie']);
  });
});
