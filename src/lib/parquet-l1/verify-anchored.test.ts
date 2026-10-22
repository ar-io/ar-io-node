/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import Sqlite from 'better-sqlite3';
import type { Database } from 'duckdb-async';

import { exportBands } from '../../../test/parquet-l1-bands.js';
import { buildCoreDb } from '../../../test/parquet-l1-core-db.js';
import {
  chainNode,
  scriptedFetch,
  scriptedLookup,
} from '../../../test/parquet-l1-headers.js';
import { ArweaveNodePool } from '../onchain/arweave-nodes.js';
import { verifyCoreDb } from './verify.js';
import { verifyBands } from './verify-bands.js';

const FIRST = 1_900_000;

describe('an honest, verifiable chain', () => {
  let dir: string;
  let coreDb: string;
  let bandsDir: string;
  let duck: Database;
  const pool = () =>
    new ArweaveNodePool({
      urls: ['http://a.test', 'http://b.test'],
      fetch: scriptedFetch({
        'http://a.test': chainNode(coreDb),
        'http://b.test': chainNode(coreDb),
      }),
      lookupAll: scriptedLookup(),
      timeoutMs: 5_000,
    });
  const sample = {
    seed: 7,
    blocks: 5,
    txsPerStratum: 5,
    v1BytesPerStratum: 1e6,
    concurrency: 2,
  };

  before(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'l1-anchored-'));
    coreDb = path.join(dir, 'core.db');
    bandsDir = path.join(dir, 'bands');
    await buildCoreDb(coreDb, FIRST, 20, { padded: false, verifiable: true });
    await exportBands(coreDb, bandsDir, [
      [FIRST, FIRST + 9],
      [FIRST + 10, FIRST + 19],
    ]);
    const { Database: D } = await import('duckdb-async');
    duck = await D.create(':memory:');
  });
  after(async () => {
    await duck?.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('verifies a core.db anchored and sampled, with nothing accepted', async () => {
    const db = new Sqlite(coreDb, { readonly: true });
    try {
      const out = await verifyCoreDb(db, {
        from: FIRST - 1,
        to: FIRST + 19,
        pool: pool(),
        sample,
      });
      assert.equal(
        out.ok,
        true,
        JSON.stringify(out.checks.filter((c) => !c.ok)),
      );
      assert.equal(out.anchored, true);
      assert.deepEqual(out.accepted, []);
      assert.equal(out.sample?.blocksChecked, 5);
      assert.ok((out.sample?.txsChecked ?? 0) > 0);
    } finally {
      db.close();
    }
  });

  it('verifies the bands anchored and sampled, with nothing accepted', async () => {
    const out = await verifyBands(duck, bandsDir, { pool: pool(), sample });
    assert.equal(out.ok, true, JSON.stringify(out.checks.filter((c) => !c.ok)));
    assert.equal(out.anchored, true);
    assert.deepEqual(out.accepted, []);
  });
});
