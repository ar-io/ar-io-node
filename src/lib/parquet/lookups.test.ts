/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Database } from 'duckdb-async';

import { RowDigest } from './digest.js';
import { prefix64Sql } from './keys.js';
import {
  digestLookup,
  digestLookupInFileOrder,
  LookupOrderError,
  LookupSpec,
  sqlPath,
  sqlPaths,
  verifyLookup,
  writeLookup,
} from './lookups.js';

/** A lookup of a toy table: each key's prefix, to the group it is in. */
const spec: LookupSpec = {
  name: 'k',
  file: 'lookup_k.parquet',
  columns: [
    { name: 'k8', type: 'UBIGINT' },
    { name: 'grp', type: 'UBIGINT' },
  ],
  orderBy: ['k8', 'grp'],
  derive: (t) =>
    `SELECT ${prefix64Sql('k')} AS k8, grp FROM read_parquet(${sqlPaths(t.items)})`,
};

const ORDER = { order: 'numeric' } as const;

describe('lookup engine', () => {
  let duck: Database;
  let dir: string;
  let tables: { items: string[] };

  before(async () => {
    duck = await Database.create(':memory:');
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lookups-'));
    // Two source files, as a lookup may be derived over many bands. Keys
    // are random 32-byte values, as ids are.
    tables = {
      items: [path.join(dir, 'a.parquet'), path.join(dir, 'b.parquet')],
    };
    for (const [i, file] of tables.items.entries()) {
      await duck.exec(
        `COPY (SELECT sha256(CAST(${i} * 1000 + range AS VARCHAR))::BLOB AS k, (range % 7)::UBIGINT AS grp
               FROM range(500))
         TO ${sqlPath(file)} (FORMAT PARQUET)`,
      );
    }
  });
  after(async () => {
    await duck.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes the derived rows sorted by key, and describes them', async () => {
    const out = path.join(dir, 'w1');
    await fs.mkdir(out);
    const described = await writeLookup(duck, spec, tables, out, ORDER);
    assert.equal(described.rows, 1000);
    assert.match(described.rowDigest, /^[0-9a-f]{64}$/);
    const rows = (await duck.all(
      `SELECT CAST(k8 AS VARCHAR) AS k8 FROM read_parquet(${sqlPath(path.join(out, spec.file))})`,
    )) as Array<{ k8: string }>;
    const keys = rows.map((r) => BigInt(r.k8));
    assert.deepEqual(
      keys,
      [...keys].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)),
      'sorted on disk by key',
    );
  });

  it('writes the same bytes and digest from the same rows', async () => {
    const one = path.join(dir, 'd1');
    const two = path.join(dir, 'd2');
    await fs.mkdir(one);
    await fs.mkdir(two);
    const a = await writeLookup(duck, spec, tables, one, ORDER);
    const b = await writeLookup(duck, spec, tables, two, ORDER);
    assert.deepEqual(a, b);
    assert.deepEqual(
      await fs.readFile(path.join(one, spec.file)),
      await fs.readFile(path.join(two, spec.file)),
    );
  });

  it('digests rows, not bytes: the digest is the description', async () => {
    const out = path.join(dir, 'g');
    await fs.mkdir(out);
    const described = await writeLookup(duck, spec, tables, out, ORDER);
    assert.deepEqual(
      await digestLookup(duck, spec, path.join(out, spec.file), ORDER),
      described,
    );
  });

  it('verifies a faithful lookup', async () => {
    const out = path.join(dir, 'v');
    await fs.mkdir(out);
    const described = await writeLookup(duck, spec, tables, out, ORDER);
    assert.deepEqual(
      await verifyLookup(
        duck,
        spec,
        path.join(out, spec.file),
        tables,
        described,
        ORDER,
      ),
      [],
    );
  });

  it('refuses a lookup whose band lies about it', async () => {
    const out = path.join(dir, 'lie');
    await fs.mkdir(out);
    const described = await writeLookup(duck, spec, tables, out, ORDER);
    const problems = await verifyLookup(
      duck,
      spec,
      path.join(out, spec.file),
      tables,
      { rows: described.rows, rowDigest: 'f'.repeat(64) },
      ORDER,
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /its band says 1000 rows with digest f+/);
  });

  it('refuses a lookup that points somewhere its tables do not', async () => {
    const out = path.join(dir, 'bad');
    await fs.mkdir(out);
    const file = path.join(out, spec.file);
    // One pointer moved to another group, and the description made to match
    // the forged file: only the check against the tables can catch it.
    await duck.exec(
      `COPY (SELECT k8, CASE WHEN row_number() OVER (ORDER BY k8, grp) = 1 THEN grp + 100 ELSE grp END AS grp
             FROM (${spec.derive(tables)}) ORDER BY k8, grp)
       TO ${sqlPath(file)} (FORMAT PARQUET)`,
    );
    const forged = await digestLookup(duck, spec, file, ORDER);
    const problems = await verifyLookup(
      duck,
      spec,
      file,
      tables,
      forged,
      ORDER,
    );
    assert.equal(problems.length, 1);
    assert.match(
      problems[0],
      /1 rows that its tables do not give, and 1 of theirs missing/,
    );
  });

  it('refuses a lookup that holds one of its rows twice', async () => {
    const out = path.join(dir, 'dup');
    await fs.mkdir(out);
    const file = path.join(out, spec.file);
    // Every row the tables give, and one of them again: a set of rows would
    // match, the rows don't.
    await duck.exec(
      `COPY (SELECT k8, grp FROM (
               SELECT * FROM (${spec.derive(tables)})
               UNION ALL (SELECT * FROM (${spec.derive(tables)}) ORDER BY k8, grp LIMIT 1))
             ORDER BY k8, grp)
       TO ${sqlPath(file)} (FORMAT PARQUET)`,
    );
    const forged = await digestLookup(duck, spec, file, ORDER);
    assert.equal(forged.rows, 1001);
    const problems = await verifyLookup(
      duck,
      spec,
      file,
      tables,
      forged,
      ORDER,
    );
    assert.equal(problems.length, 1);
    assert.match(
      problems[0],
      /1 rows that its tables do not give, and 0 of theirs missing/,
    );
  });

  it('passes a spill-limit error from the sorted scan up to the runner, without sorting again (CodeRabbit, #1074)', async () => {
    const one: LookupSpec = {
      name: 'v',
      file: 'lookup_spill.parquet',
      columns: [{ name: 'v', type: 'UBIGINT' }],
      orderBy: ['v'],
      derive: () =>
        'SELECT v::UBIGINT AS v FROM (VALUES (100), (9), (10)) t(v)',
    };
    const out = path.join(dir, 'spill');
    await fs.mkdir(out);
    await writeLookup(duck, one, {}, out, { order: 'numeric' });
    let streamed = 0;
    // The sort runs out of its share; the old reader must not start.
    const spilling = new Proxy(duck, {
      get(target, key, receiver) {
        if (key === 'exec') {
          return async (sql: string) => {
            if (/CREATE TEMP TABLE/.test(sql)) {
              throw new Error(
                'Out of Memory Error: failed to offload data block: could not write: max_temp_directory_size is 1.0 MiB',
              );
            }
            return target.exec(sql);
          };
        }
        if (key === 'stream') {
          return (...args: Parameters<Database['stream']>) => {
            streamed += 1;
            return target.stream(...args);
          };
        }
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await assert.rejects(
      digestLookup(spilling, one, path.join(out, one.file), {
        order: 'numeric',
      }),
      /max_temp_directory_size/,
    );
    assert.equal(streamed, 0);
  });

  it('digests in numeric order, or in the text order l1-3 used', async () => {
    // One UBIGINT column, 9, 10 and 100: as text, 10 < 100 < 9. Under
    // `legacy-text` the digest query's text alias "v" shadowed the column
    // in its ORDER BY; under `numeric` the rows are digested in the file's
    // own order.
    const one: LookupSpec = {
      name: 'v',
      file: 'lookup_v.parquet',
      columns: [{ name: 'v', type: 'UBIGINT' }],
      orderBy: ['v'],
      derive: () =>
        'SELECT v::UBIGINT AS v FROM (VALUES (100), (9), (10)) t(v)',
    };
    const out = path.join(dir, 'order');
    await fs.mkdir(out);
    const numeric = await writeLookup(duck, one, {}, out, {
      order: 'numeric',
    });
    const file = path.join(out, one.file);
    const legacy = await digestLookup(duck, one, file, {
      order: 'legacy-text',
    });
    const byHand = (values: string[]) => {
      const digest = new RowDigest(one.columns);
      for (const v of values) digest.add([v]);
      return { rows: digest.rows, rowDigest: digest.hex() };
    };
    assert.deepEqual(numeric, byHand(['9', '10', '100']));
    assert.deepEqual(legacy, byHand(['10', '100', '9']));
    assert.notEqual(numeric.rowDigest, legacy.rowDigest);
    // The file itself is in numeric order either way.
    const rows = (await duck.all(
      `SELECT CAST(v AS VARCHAR) AS v FROM read_parquet(${sqlPath(file)})`,
    )) as Array<{ v: string }>;
    assert.deepEqual(
      rows.map((r) => r.v),
      ['9', '10', '100'],
    );
    // Each order verifies only its own digest.
    assert.deepEqual(
      await verifyLookup(duck, one, file, {}, legacy, {
        order: 'legacy-text',
      }),
      [],
    );
    assert.equal(
      (await verifyLookup(duck, one, file, {}, legacy, { order: 'numeric' }))
        .length,
      1,
    );
  });

  it('digests a numeric lookup in file order as its sorted digest, and refuses rows out of order', async () => {
    // A key ordered on one column, a payload column after it.
    const keyed: LookupSpec = {
      name: 'kv',
      file: 'lookup_kv.parquet',
      columns: [
        { name: 'k', type: 'UBIGINT' },
        { name: 'v', type: 'UBIGINT' },
      ],
      orderBy: ['k'],
      derive: () => 'SELECT 1',
    };
    const write = async (name: string, rows: Array<[string, number]>) => {
      const file = path.join(dir, name);
      await duck.exec(
        `COPY (SELECT * FROM (VALUES ${rows.map(([k, v]) => `(${k}::UBIGINT, ${v}::UBIGINT)`).join(', ')}) t(k, v))
         TO ${sqlPath(file)} (FORMAT PARQUET)`,
      );
      return file;
    };
    // 9 < 10 < 2^64-1 by value, not as text; an identical row may repeat.
    const sorted = await write('kv-sorted.parquet', [
      ['9', 1],
      ['10', 1],
      ['10', 1],
      ['18446744073709551615', 0],
    ]);
    assert.deepEqual(
      await digestLookupInFileOrder(duck, keyed, sorted),
      await digestLookup(duck, keyed, sorted, ORDER),
    );
    for (const rows of [
      [
        ['10', 1],
        ['9', 1],
      ],
      // A tie on the key that differs elsewhere: the order is not total.
      [
        ['10', 1],
        ['10', 2],
      ],
    ] as Array<Array<[string, number]>>) {
      const file = await write(`kv-${rows.length}-${rows[1][1]}.parquet`, rows);
      await assert.rejects(
        digestLookupInFileOrder(duck, keyed, file),
        LookupOrderError,
      );
    }
  });
});
