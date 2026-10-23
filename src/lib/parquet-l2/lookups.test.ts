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

import { RowDigest } from '../parquet/digest.js';
import { prefix64, sha256_64 } from '../parquet/keys.js';
import { digestLookup, sqlPath } from '../parquet/lookups.js';
import {
  lookupsOf,
  PARQUET_L2_LOOKUPS,
  PARQUET_L2_TABLES,
  STATS_BUCKET_HEIGHTS,
} from './layout.js';
import { verifyBandLookups, writeBandLookups } from './lookups.js';

/** A 32-byte id or address, every byte `n`. */
const b32 = (n: number) => Buffer.alloc(32, n);
const hex = (bytes: Buffer) =>
  `'\\x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('\\x')}'::BLOB`;

describe('parquet-l2 lookups', () => {
  let duck: Database;
  let dir: string;

  // Item A sits at two places in one root at height 10 (two rows), and in
  // another root at height 12; it names T as its target. Item B, at 10,
  // names none. Both are O's.
  const A = b32(0xa1);
  const B = b32(0xb2);
  const O = b32(0x0f);
  const T = b32(0x7e);

  /** Writes a table with `values` for the columns named, null elsewhere. */
  const writeTable = async (
    name: string,
    names: string[],
    rows: string[][],
  ) => {
    const spec = PARQUET_L2_TABLES.find((t) => t.name === name)!;
    const select = spec.columns
      .map((c) =>
        names.includes(c.name)
          ? `CAST(v."${c.name}" AS ${c.type}) AS "${c.name}"`
          : `CAST(NULL AS ${c.type}) AS "${c.name}"`,
      )
      .join(', ');
    const from =
      rows.length === 0
        ? `(SELECT ${names.map((n) => `NULL AS "${n}"`).join(', ')} WHERE false) v`
        : `(VALUES ${rows.map((r) => `(${r.join(', ')})`).join(', ')}) v(${names.map((n) => `"${n}"`).join(', ')})`;
    await duck.exec(
      `COPY (SELECT ${select} FROM ${from}) TO ${sqlPath(path.join(dir, spec.file))} (FORMAT PARQUET)`,
    );
  };

  before(async () => {
    duck = await Database.create(':memory:');
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'l2-lookups-'));
    const item = (
      id: Buffer,
      height: number,
      offset: number,
      target?: Buffer,
    ) => [
      hex(id),
      String(height),
      hex(O),
      target === undefined ? 'NULL' : hex(target),
      id === A ? '100' : '50',
      String(offset),
    ];
    await writeTable(
      'data_items',
      ['id', 'height', 'owner_address', 'target', 'data_size', 'offset'],
      [
        item(A, 10, 0, T),
        item(A, 10, 4096, T),
        item(B, 10, 8192),
        item(A, 12, 0, T),
      ],
    );
    const tag = (
      height: number,
      id: Buffer,
      index: number,
      name: string,
      value: string,
    ) => [
      String(height),
      hex(id),
      String(index),
      `'${name}'::BLOB`,
      `'${value}'::BLOB`,
    ];
    // A's tags once per height it sits at, as a band holds them.
    await writeTable(
      'tags',
      ['height', 'id', 'tag_index', 'tag_name', 'tag_value'],
      [
        tag(10, A, 0, 'Drive-Id', 'd1'),
        tag(12, A, 0, 'Drive-Id', 'd1'),
        tag(10, B, 0, 'Drive-Id', 'd1'),
        tag(10, B, 1, 'Drive-Id', 'd2'),
      ],
    );
    await writeTable('wallets', ['address'], []);
    await writeTable('parents', ['id'], []);
  });

  after(async () => {
    await duck.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** The layout written: the key lookup over Drive-Id, stats by it too. */
  const LAYOUT = {
    schema: 'l2-2' as const,
    keyTags: ['Drive-Id'],
    statTags: ['Drive-Id'],
  };

  /** A lookup's rows, in its order, as plain values. */
  const rowsOf = async (name: string) => {
    const spec = lookupsOf(LAYOUT).find((s) => s.name === name)!;
    return (await duck.all(
      `SELECT ${spec.columns.map((c) => (c.type === 'BLOB' ? `CAST("${c.name}" AS VARCHAR) AS "${c.name}"` : `"${c.name}"`)).join(', ')}
       FROM read_parquet(${sqlPath(path.join(dir, spec.file))})`,
    )) as Array<Record<string, unknown>>;
  };

  it('writes one row per item and height, its owner and target, and each tag pair once per item', async () => {
    const described = await writeBandLookups(duck, dir, { layout: LAYOUT });
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(described).map(([name, d]) => [name, d.rows]),
      ),
      { id: 3, wallet: 5, tag: 2, key: 3, stats: 2 },
    );

    // An item at two places in one height is one row; at two heights, two.
    // Rows are in key order, as written.
    // (prefix64(A) < prefix64(B): 0xa1... < 0xb2...)
    assert.deepEqual(await rowsOf('id'), [
      { id8: prefix64(A), height: 10n },
      { id8: prefix64(A), height: 12n },
      { id8: prefix64(B), height: 10n },
    ]);

    // The owner (role 0) of every item and height; the target (role 1)
    // only where there is one.
    assert.deepEqual(
      (await rowsOf('wallet')).map((r) => [
        r.addr8,
        r.role,
        r.height,
        r.data_size,
      ]),
      [
        [prefix64(O), 0, 10n, 50n],
        [prefix64(O), 0, 10n, 100n],
        [prefix64(O), 0, 12n, 100n],
        [prefix64(T), 1, 10n, 100n],
        [prefix64(T), 1, 12n, 100n],
      ],
    );

    // Drive-Id=d1 is carried by A (at two heights, counted once) and B.
    const tags = (await rowsOf('tag')).map((r) => [
      r.name8,
      r.val8,
      r.name,
      r.value,
      r.txs,
      r.first_height,
      r.last_height,
    ]);
    const name8 = sha256_64(Buffer.from('Drive-Id'));
    assert.deepEqual(
      tags.sort((x, y) => String(x[3]).localeCompare(String(y[3]))),
      [
        [name8, sha256_64(Buffer.from('d1')), 'Drive-Id', 'd1', 2n, 10n, 12n],
        [name8, sha256_64(Buffer.from('d2')), 'Drive-Id', 'd2', 1n, 10n, 10n],
      ],
    );

    // The key lookup: Drive-Id=d1 at height 10 (A and B) and 12 (A),
    // d2 at 10 (B), whatever place the items sit at.
    const keys = (await rowsOf('key')).map((r) => [
      r.name8,
      r.val8,
      r.height,
      r.items,
    ]);
    const d1 = sha256_64(Buffer.from('d1'));
    const d2 = sha256_64(Buffer.from('d2'));
    assert.deepEqual(
      keys.sort(
        (x, y) =>
          Number(BigInt(x[1] as bigint) - BigInt(y[1] as bigint)) ||
          Number(x[2]) - Number(y[2]),
      ),
      [
        [name8, d1, 10n, 2n],
        [name8, d1, 12n, 1n],
        [name8, d2, 10n, 1n],
      ].sort((x, y) => Number(x[1] - y[1]) || Number(x[2] - y[2])),
    );
    // In key order: by name8, val8, then height.
    const written = (await rowsOf('key')).map((r) => [r.val8, r.height]);
    assert.deepEqual(
      written,
      [...written].sort(
        (x, y) =>
          Number(BigInt(x[0] as bigint) - BigInt(y[0] as bigint)) ||
          Number(x[1]) - Number(y[1]),
      ),
    );

    // Stats: one bucket (heights 10 and 12 are in the first), every item
    // and height counted once (A at 10 sits at two places), and by
    // Drive-Id: B's first Drive-Id is d1, so d2 counts nothing.
    assert.equal(STATS_BUCKET_HEIGHTS, 1000);
    assert.deepEqual(
      (await rowsOf('stats')).map((r) => [
        r.bucket,
        r.name,
        r.value,
        r.items,
        r.bytes,
      ]),
      [
        [0n, '', '', 3n, 250n],
        [0n, 'Drive-Id', 'd1', 3n, 250n],
      ],
    );

    assert.deepEqual(
      await verifyBandLookups(duck, dir, { ...LAYOUT, lookups: described }),
      [],
    );
  });

  it('writes empty key and stats files for a band with no key or stat tags, and finds files derived for other names', async () => {
    const none = { schema: 'l2-2' as const, keyTags: [], statTags: [] };
    const described = await writeBandLookups(duck, dir, { layout: none });
    assert.equal(described.key.rows, 0);
    // No key tags: no key rows; no stat tags: the totals only.
    assert.equal(described.stats.rows, 1);
    assert.deepEqual(
      await verifyBandLookups(duck, dir, { ...none, lookups: described }),
      [],
    );
    // The same files, checked under the layout they were not derived for.
    const problems = await verifyBandLookups(duck, dir, {
      ...LAYOUT,
      lookups: described,
    });
    assert.equal(problems.length, 2, problems.join('\n'));
    assert.match(
      problems[0],
      /lookup_key\.parquet: 0 rows that its tables do not give, and 3 of theirs missing/,
    );
    assert.match(
      problems[1],
      /stats\.parquet: 0 rows that its tables do not give, and 1 of theirs missing/,
    );
    // Checked from a staging directory, only the files named, as a derive does.
    const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'l2-derive-'));
    try {
      const written = await writeBandLookups(duck, dir, {
        layout: LAYOUT,
        only: ['key', 'stats'],
        outDir: staging,
      });
      assert.deepEqual(Object.keys(written), ['key', 'stats']);
      assert.deepEqual((await fs.readdir(staging)).sort(), [
        'lookup_key.parquet',
        'stats.parquet',
      ]);
      assert.deepEqual(
        await verifyBandLookups(
          duck,
          dir,
          { ...LAYOUT, lookups: written },
          { only: ['key', 'stats'], lookupsDir: staging },
        ),
        [],
      );
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
    // Leave the band as the other tests expect it.
    await writeBandLookups(duck, dir, { layout: LAYOUT });
  });

  it('digests each lookup in its file order, by value', async () => {
    const described = await writeBandLookups(duck, dir, { layout: LAYOUT });
    for (const spec of lookupsOf(LAYOUT)) {
      // As a reader digests a lookup while it reads it: no ORDER BY.
      const digest = new RowDigest(spec.columns);
      const rows = (await duck.all(
        `SELECT ${spec.columns.map((c) => (c.type === 'UBIGINT' ? `CAST("${c.name}" AS VARCHAR) AS "${c.name}"` : `"${c.name}"`)).join(', ')}
         FROM read_parquet(${sqlPath(path.join(dir, spec.file))})`,
      )) as Array<Record<string, unknown>>;
      for (const row of rows) digest.add(spec.columns.map((c) => row[c.name]));
      assert.deepEqual(
        described[spec.name],
        { rows: digest.rows, rowDigest: digest.hex() },
        spec.name,
      );
    }
    // Here the wallet rows of one height differ in size by a digit (50 and
    // 100), so text order would digest them otherwise.
    const wallet = PARQUET_L2_LOOKUPS[1];
    const legacy = await digestLookup(
      duck,
      wallet,
      path.join(dir, wallet.file),
      { order: 'legacy-text' },
    );
    assert.notEqual(legacy.rowDigest, described.wallet.rowDigest);
  });

  it('finds a lookup that disagrees with its band or its tables', async () => {
    const described = await writeBandLookups(duck, dir, { layout: LAYOUT });
    const file = path.join(dir, 'lookup_id.parquet');
    // One row short: the band's description and the tables both disagree.
    await duck.exec(
      `COPY (SELECT * FROM read_parquet(${sqlPath(file)}) LIMIT 2) TO ${sqlPath(`${file}.short`)} (FORMAT PARQUET)`,
    );
    await fs.rename(`${file}.short`, file);
    const problems = await verifyBandLookups(duck, dir, {
      ...LAYOUT,
      lookups: described,
    });
    assert.equal(problems.length, 2, problems.join('\n'));
    assert.match(problems[0], /lookup_id\.parquet: holds 2 rows/);
    assert.match(problems[1], /0 rows that its tables do not give, and 1/);
    // A lookup the band doesn't describe.
    const { wallet: _wallet, ...partial } = described;
    assert.ok(
      (
        await verifyBandLookups(duck, dir, { ...LAYOUT, lookups: partial })
      ).includes('lookup_wallet.parquet: not described in the band'),
    );
  });
});
