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

import { prefix64Sql } from './keys.js';
import {
  digestLookup,
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
    const described = await writeLookup(duck, spec, tables, out);
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
    const a = await writeLookup(duck, spec, tables, one);
    const b = await writeLookup(duck, spec, tables, two);
    assert.deepEqual(a, b);
    assert.deepEqual(
      await fs.readFile(path.join(one, spec.file)),
      await fs.readFile(path.join(two, spec.file)),
    );
  });

  it('digests rows, not bytes: the digest is the description', async () => {
    const out = path.join(dir, 'g');
    await fs.mkdir(out);
    const described = await writeLookup(duck, spec, tables, out);
    assert.deepEqual(
      await digestLookup(duck, spec, path.join(out, spec.file)),
      described,
    );
  });

  it('verifies a faithful lookup', async () => {
    const out = path.join(dir, 'v');
    await fs.mkdir(out);
    const described = await writeLookup(duck, spec, tables, out);
    assert.deepEqual(
      await verifyLookup(
        duck,
        spec,
        path.join(out, spec.file),
        tables,
        described,
      ),
      [],
    );
  });

  it('refuses a lookup whose band lies about it', async () => {
    const out = path.join(dir, 'lie');
    await fs.mkdir(out);
    const described = await writeLookup(duck, spec, tables, out);
    const problems = await verifyLookup(
      duck,
      spec,
      path.join(out, spec.file),
      tables,
      { rows: described.rows, rowDigest: 'f'.repeat(64) },
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
    const forged = await digestLookup(duck, spec, file);
    const problems = await verifyLookup(duck, spec, file, tables, forged);
    assert.equal(problems.length, 1);
    assert.match(
      problems[0],
      /1 rows that its tables do not give, and 1 of theirs missing/,
    );
  });
});
