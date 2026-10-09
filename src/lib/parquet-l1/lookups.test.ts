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

import { sqlPath, writeLookup } from '../parquet/lookups.js';
import { PARQUET_L1_LOOKUPS } from './layout.js';

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
    const described = await writeLookup(duck, spec, { tags: [tags] }, dir);
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
