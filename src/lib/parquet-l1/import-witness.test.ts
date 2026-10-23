/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The import with `l1-4` witnesses: a pre-2.0 band whose witnesses bind its
 * blocks fills under the strict default, no `--allow-*` flag; the same band
 * without them (`l1-3`) is refused unless accepted, as before; and a
 * witness that does not hold refuses the band. The chain is a test chain,
 * so its own pinned folds are given (`foldPins`).
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Sqlite from 'better-sqlite3';
import type { Database } from 'duckdb-async';

import { createTestLogger } from '../../../test/test-logger.js';
import {
  exportBands,
  republish,
  rewriteTable,
  witnessTestBand,
} from '../../../test/parquet-l1-bands.js';
import { buildCoreDb } from '../../../test/parquet-l1-core-db.js';
import {
  chainNode,
  scriptedFetch,
  scriptedLookup,
} from '../../../test/parquet-l1-headers.js';
import { ArweaveNodePool } from '../onchain/arweave-nodes.js';
import { LEDGER_MIGRATION, runFill, runImport } from './import.js';
import { BAND_FILE, parseBandFile, serializeBandFile } from './layout.js';

const log = createTestLogger({ suite: 'l1-import-witness' });
/** A pre-2.0 stretch: format-1 transactions, signed over their data. */
const V1 = 100_000;

function migratedCore(file: string): void {
  const db = new Sqlite(file);
  db.exec(fs.readFileSync('test/core-schema.sql', 'utf8'));
  db.exec(fs.readFileSync(`migrations/${LEDGER_MIGRATION}`, 'utf8'));
  db.prepare('INSERT INTO migrations (name) VALUES (?)').run(LEDGER_MIGRATION);
  db.close();
}

function holdBlocks(source: string, core: string, from: number): void {
  const db = new Sqlite(core);
  db.exec(`ATTACH '${source}' AS s`);
  db.exec(
    `INSERT INTO stable_blocks SELECT * FROM s.stable_blocks WHERE height >= ${from}`,
  );
  db.exec('DETACH s');
  db.close();
}

describe('the import with l1-4 witnesses', () => {
  let dir: string;
  let source: string;
  let core: string;
  let bandsDir: string;
  let duck: Database;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'l1-import-witness-'));
    source = path.join(dir, 'source.db');
    core = path.join(dir, 'core.db');
    bandsDir = path.join(dir, 'bands');
    migratedCore(core);
    const { Database: D } = await import('duckdb-async');
    duck = await D.create(':memory:');
    await buildCoreDb(source, V1, 21, { verifiable: true });
    holdBlocks(source, core, V1 + 10);
  });
  afterEach(async () => {
    await duck?.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const fill = async (
    verification: Parameters<typeof runFill>[0]['verification'],
  ) => {
    const db = new Sqlite(core, { timeout: 1000 });
    try {
      return await runFill({
        db,
        duck,
        bandsDir,
        log,
        yieldMs: 0,
        verification,
      });
    } finally {
      db.close();
    }
  };
  const pool = () =>
    new ArweaveNodePool({
      urls: ['http://a.test', 'http://b.test'],
      fetch: scriptedFetch({
        'http://a.test': chainNode(source),
        'http://b.test': chainNode(source),
      }),
      lookupAll: scriptedLookup(),
      timeoutMs: 5_000,
    });
  const sample = {
    seed: 7,
    blocks: 3,
    txsPerStratum: 50,
    format1PerStratum: 0,
    v1BytesPerStratum: 1e9,
    concurrency: 2,
  };

  it('fills a witnessed pre-2.0 band under the strict default, no flag', async () => {
    const [band] = await exportBands(source, bandsDir, [[V1, V1 + 9]]);
    const foldPins = await witnessTestBand(duck, source, band.dir);
    const out = await fill({ pool: pool(), sample, allow: {}, foldPins });
    assert.equal(out.outcomes[0].result, 'imported', out.outcomes[0].reason);
    assert.deepEqual(out.outcomes[0].check?.unbound, {});
    // Nothing accepted that unbinds anything (the sample's zeroes aside).
    assert.deepEqual(
      out.outcomes[0].check?.accepted.filter((f) => f.startsWith('--allow-')),
      [],
    );
    assert.equal(out.outcomes[0].check?.binding.kind, 'held');
  });

  it('refuses the same band without witnesses (l1-3) under the strict default', async () => {
    const [band] = await exportBands(source, bandsDir, [[V1, V1 + 9]]);
    const foldPins = await witnessTestBand(duck, source, band.dir);
    // As l1-3: the witness files gone, none described.
    const file = path.join(band.dir, BAND_FILE);
    const parsed = parseBandFile(await fsp.readFile(file, 'utf8'));
    await fsp.rm(path.join(band.dir, 'witness_v1_data_roots.parquet'));
    await fsp.rm(path.join(band.dir, 'witness_fork_2_0.parquet'));
    const { witnesses: _w, ...rest } = parsed;
    void _w;
    await fsp.writeFile(file, serializeBandFile({ ...rest, schema: 'l1-3' }));
    const refused = await fill({ pool: pool(), sample, allow: {}, foldPins });
    assert.equal(refused.outcomes[0].result, 'refused');
    assert.match(refused.outcomes[0].reason ?? '', /unbound \(pre20\)/);
    // L1_BAND_IMPORT_ALLOW_UNVERIFIED still accepts it.
    const accepted = await fill({
      pool: pool(),
      sample,
      allow: { unbound: true, unverifiedFormat1: true },
      foldPins,
    });
    assert.equal(
      accepted.outcomes[0].result,
      'imported',
      accepted.outcomes[0].reason,
    );
    assert.ok(accepted.outcomes[0].check?.accepted.includes('--allow-unbound'));
  });

  it("writes an l1-4 band's witnessed roots over contradicting ones core.db kept", async () => {
    // core.db already holds the range, with a format-1 data_root and a
    // pre-2.0 tx_root of its own that are not the chain's (the test
    // chain's stand-ins). Importing the band over it must not keep them.
    const own = path.join(dir, 'own.db');
    await fsp.copyFile(source, own);
    {
      const db = new Sqlite(own);
      db.exec(fs.readFileSync(`migrations/${LEDGER_MIGRATION}`, 'utf8'));
      db.prepare('INSERT INTO migrations (name) VALUES (?)').run(
        LEDGER_MIGRATION,
      );
      db.close();
    }
    const [band] = await exportBands(source, bandsDir, [[V1, V1 + 9]]);
    const foldPins = await witnessTestBand(duck, source, band.dir);
    const db = new Sqlite(own, { timeout: 1000 });
    try {
      const out = await runImport({
        db,
        duck,
        bandsDir,
        log,
        from: V1,
        to: V1 + 9,
        verification: { pool: pool(), sample, allow: {}, foldPins },
      });
      assert.equal(out.outcomes[0].result, 'imported', out.outcomes[0].reason);
      const roots = (await duck.all(
        `SELECT hex(id) AS id, hex(data_root) AS root FROM read_parquet('${band.dir}/witness_v1_data_roots.parquet')`,
      )) as Array<{ id: string; root: string }>;
      assert.ok(roots.length > 0);
      for (const r of roots) {
        const stored = db
          .prepare(
            'SELECT hex(data_root) FROM stable_transactions WHERE id = unhex(?)',
          )
          .pluck()
          .get(r.id);
        assert.equal(stored, r.root, `data_root of ${r.id}`);
      }
      const txRoots = (await duck.all(
        `SELECT height, hex(tx_root) AS root FROM read_parquet('${band.dir}/witness_fork_2_0.parquet')`,
      )) as Array<{ height: bigint; root: string }>;
      for (const r of txRoots) {
        const stored = db
          .prepare('SELECT hex(tx_root) FROM stable_blocks WHERE height = ?')
          .pluck()
          .get(Number(r.height));
        assert.equal(stored, r.root, `tx_root at ${r.height}`);
      }
    } finally {
      db.close();
    }
  });

  it('refuses a witnessed band whose transactions do not give its witnessed roots', async () => {
    const [band] = await exportBands(source, bandsDir, [[V1, V1 + 9]]);
    const foldPins = await witnessTestBand(duck, source, band.dir);
    // A transaction's data size changed: its block's transition root no
    // longer recomputes, whatever the band's own digests say.
    await rewriteTable(
      duck,
      band.dir,
      'transactions',
      `SELECT * REPLACE (CASE WHEN height = ${V1 + 3} AND block_transaction_index = 0 THEN data_size + 1 ELSE data_size END AS data_size) FROM SRC`,
    );
    await republish(duck, band.dir);
    const out = await fill({
      pool: pool(),
      sample,
      allow: { unbound: true, unverifiedFormat1: true },
      foldPins,
    });
    assert.equal(out.outcomes[0].result, 'refused');
    assert.match(out.outcomes[0].reason ?? '', /tx_root/);
  });
});
