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

import { digestLookup, sqlPath, writeLookup } from '../parquet/lookups.js';
import {
  PARQUET_L1_LOOKUP_DIGEST_ORDER,
  PARQUET_L1_LOOKUPS,
} from './layout.js';
import { verifyBandLookups, writeBandLookups } from './lookups.js';

describe('lookup_tag', () => {
  let duck: Database;
  let dir: string;

  before(async () => {
    duck = await Database.create(':memory:');
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lookup-tag-'));
  });
  after(async () => {
    await duck.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('counts each transaction once per pair, with the first and last height', async () => {
    // tx a (height 10) carries App=X twice; tx b (12) App=X once; tx c (11)
    // App=Y and Type=X; tx d (13) App=Y.
    const tags = path.join(dir, 'tags.parquet');
    await duck.exec(
      `COPY (SELECT height::UBIGINT AS height, id::BLOB AS id,
                    tag_index::USMALLINT AS tag_index,
                    tag_name::BLOB AS tag_name, tag_value::BLOB AS tag_value,
                    false AS is_data_item
             FROM (VALUES (10, 'a', 0, 'App', 'X'), (10, 'a', 1, 'App', 'X'),
                          (12, 'b', 0, 'App', 'X'), (11, 'c', 0, 'App', 'Y'),
                          (11, 'c', 1, 'Type', 'X'), (13, 'd', 0, 'App', 'Y'))
                  AS t(height, id, tag_index, tag_name, tag_value))
       TO ${sqlPath(tags)} (FORMAT PARQUET)`,
    );
    const spec = PARQUET_L1_LOOKUPS.find((s) => s.name === 'tag')!;
    const described = await writeLookup(duck, spec, { tags: [tags] }, dir, {
      order: PARQUET_L1_LOOKUP_DIGEST_ORDER,
    });
    assert.equal(described.rows, 3);

    const rows = (await duck.all(
      `SELECT CAST(name AS VARCHAR) AS name, CAST(value AS VARCHAR) AS value,
              txs::INTEGER AS txs, first_height::INTEGER AS first,
              last_height::INTEGER AS last
       FROM read_parquet(${sqlPath(path.join(dir, spec.file))})
       ORDER BY name, value`,
    )) as Array<Record<string, unknown>>;
    assert.deepEqual(rows, [
      { name: 'App', value: 'X', txs: 2, first: 10, last: 12 },
      { name: 'App', value: 'Y', txs: 2, first: 11, last: 13 },
      { name: 'Type', value: 'X', txs: 1, first: 11, last: 11 },
    ]);
  });
});

describe('l1-3 lookup digests', () => {
  let duck: Database;
  let dir: string;

  before(async () => {
    duck = await Database.create(':memory:');
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lookup-l1-3-'));
    // Heights and sizes of one, two and three digits, so their text order
    // (10 < 100 < 9) and their numeric order differ.
    await duck.exec(
      `COPY (SELECT ('\\x' || lpad(to_hex(n), 2, '0') || repeat('\\x00', 31))::BLOB AS id,
                    h::UBIGINT AS height,
                    ('\\x' || lpad(to_hex(n % 2), 2, '0') || repeat('\\x11', 31))::BLOB AS owner_address,
                    CASE WHEN n % 3 = 0 THEN repeat('\\x22', 32)::BLOB END AS target,
                    s::UBIGINT AS data_size
             FROM (VALUES (1, 9, 100), (2, 10, 9), (3, 100, 10), (4, 9, 10),
                          (5, 100, 9), (6, 10, 100))
                  AS t(n, h, s))
       TO ${sqlPath(path.join(dir, 'transactions.parquet'))} (FORMAT PARQUET)`,
    );
    await duck.exec(
      `COPY (SELECT h::UBIGINT AS height, ('\\x' || lpad(to_hex(n), 2, '0') || repeat('\\x00', 31))::BLOB AS id,
                    0::USMALLINT AS tag_index, 'App'::BLOB AS tag_name,
                    v::BLOB AS tag_value, false AS is_data_item
             FROM (VALUES (1, 9, 'X'), (2, 10, 'X'), (3, 100, 'Y'), (4, 9, 'Y'))
                  AS t(n, h, v))
       TO ${sqlPath(path.join(dir, 'tags.parquet'))} (FORMAT PARQUET)`,
    );
  });
  after(async () => {
    await duck.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('are unchanged: published l1-3 bands still verify', async () => {
    // The digests develop (c18d9c83, Release 85) writes for these rows.
    const described = await writeBandLookups(duck, dir, dir);
    assert.deepEqual(described, {
      tx_id: {
        rows: 6,
        rowDigest:
          '3b41d5f295af7505eb5680b1e6c99aa218db4bebccc0c392cb6cd92ae97757dc',
      },
      wallet: {
        rows: 8,
        rowDigest:
          '387cd935bc0488cc70b59d34f169042eed5ee1c8056ef485e4c5dc76b562dc6d',
      },
      tag: {
        rows: 2,
        rowDigest:
          '91d676fbad3e3d6fd2507fb01725c1e4c067e7d241c7fd82ff0afac2da489177',
      },
    });
    assert.equal(PARQUET_L1_LOOKUP_DIGEST_ORDER, 'legacy-text');
    assert.deepEqual(
      await verifyBandLookups(duck, dir, {
        schema: 'l1-3',
        lookups: described,
      } as never),
      [],
    );
    // The fixture tells the orders apart: by value, wallet digests otherwise.
    const wallet = PARQUET_L1_LOOKUPS.find((s) => s.name === 'wallet')!;
    const numeric = await digestLookup(
      duck,
      wallet,
      path.join(dir, wallet.file),
      { order: 'numeric' },
    );
    assert.notEqual(numeric.rowDigest, described.wallet.rowDigest);
  });
});
