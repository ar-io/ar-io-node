/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Regression tests for the L1 verifier's fail-open findings (the 2026-10-22
 * audits A and C, and B's bands case). Each case passed (ok: true, or a
 * sound set failed) at 3b32f2ea; each must now be refused by a named check,
 * or, for the sound sets, pass.
 */
import { strict as assert } from 'node:assert';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import Sqlite from 'better-sqlite3';
import type { Database } from 'duckdb-async';

import {
  exportBands,
  republish,
  rewriteTable,
} from '../../../test/parquet-l1-bands.js';
import { buildCoreDb } from '../../../test/parquet-l1-core-db.js';
import {
  chainNode,
  scriptedFetch,
  scriptedLookup,
} from '../../../test/parquet-l1-headers.js';
import { createTestLogger } from '../../../test/test-logger.js';
import { indexL1VerifyCLICommand } from '../../cli/commands/indexL1VerifyCommands.js';
import { ArweaveNodePool } from '../onchain/arweave-nodes.js';
import { FORK_2_0 } from './chain.js';
import { BAND_FILE } from './layout.js';
import { chooseRange, verifyCoreDb } from './verify.js';
import {
  BandsRefused,
  verifyBands,
  type BandsVerifyResult,
} from './verify-bands.js';
import type { L1VerifyReport } from './verify-run.js';

const log = createTestLogger({ suite: 'l1-verify-fail-closed' });
const FIRST = 1_900_000;
const UNANCHORED = { allow: { unanchored: true } };

const failed = (out: L1VerifyReport) =>
  out.checks.filter((c) => !c.ok).map((c) => c.name);

describe('index-l1-verify --bands-dir fails closed', () => {
  let root: string;
  let source: string;
  let honest: string;
  let bandsDir: string;
  let ids: string[];
  let duck: Database;

  before(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'l1-fail-closed-'));
    source = path.join(root, 'source.db');
    honest = path.join(root, 'honest');
    await buildCoreDb(source, FIRST, 20, { padded: false, verifiable: true });
    ids = (
      await exportBands(source, honest, [
        [FIRST, FIRST + 9],
        [FIRST + 10, FIRST + 19],
      ])
    ).map((b) => b.id);
    const { Database: D } = await import('duckdb-async');
    duck = await D.create(':memory:');
  });
  after(async () => {
    await duck?.close();
    await fsp.rm(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    bandsDir = await fsp.mkdtemp(path.join(root, 'case-'));
    await fsp.cp(honest, bandsDir, { recursive: true });
  });
  const band = (i: number) => path.join(bandsDir, ids[i]);
  const verify = (options: Parameters<typeof verifyBands>[2] = {}) =>
    verifyBands(duck, bandsDir, { ...UNANCHORED, window: 7, ...options });

  it('A1: passes the honest set (accepting only that it is unanchored)', async () => {
    const out = await verify();
    assert.equal(out.ok, true, JSON.stringify(failed(out)));
    assert.deepEqual(out.accepted, ['--allow-unanchored']);
    assert.equal(out.anchored, false);
  });

  it('A2: refuses wallets and links tampered beside a band.json that no longer describes them', async () => {
    await rewriteTable(
      duck,
      band(0),
      'wallets',
      `SELECT address, '\\xDEAD'::BLOB AS public_modulus FROM SRC`,
    );
    await rewriteTable(
      duck,
      band(0),
      'block_transactions',
      'SELECT * FROM SRC WHERE false',
    );
    const out = await verify();
    assert.equal(out.ok, false);
    assert.ok(failed(out).includes('tables'), JSON.stringify(failed(out)));
    assert.ok(failed(out).includes('wallets'));
    assert.ok(failed(out).includes('position'));
  });

  it('A2: refuses the same tampering republished self-consistently', async () => {
    await rewriteTable(
      duck,
      band(0),
      'wallets',
      `SELECT address, '\\xDEAD'::BLOB AS public_modulus FROM SRC`,
    );
    await republish(duck, band(0));
    const out = await verify();
    assert.equal(out.ok, false);
    assert.deepEqual(failed(out), ['wallets']);
  });

  it('A3: refuses tags tampered with their lookups rebuilt and described', async () => {
    await rewriteTable(
      duck,
      band(0),
      'tags',
      `SELECT * REPLACE (CASE WHEN tag_index = 1 THEN 'forged'::BLOB ELSE tag_value END AS tag_value) FROM SRC`,
    );
    const { writeBandLookups } = await import('./lookups.js');
    const { parseBandFile, serializeBandFile } = await import('./layout.js');
    const file = path.join(band(0), BAND_FILE);
    const parsed = parseBandFile(await fsp.readFile(file, 'utf8'));
    parsed.lookups = await writeBandLookups(duck, band(0), band(0));
    await fsp.writeFile(file, serializeBandFile(parsed));
    const out = await verify();
    assert.equal(out.ok, false);
    assert.ok(failed(out).includes('tables'));
  });

  it('A4: refuses a set whose edge band has an unreadable band.json, rather than dropping it', async () => {
    await fsp.writeFile(path.join(band(1), BAND_FILE), '{not json');
    const out = await verify();
    assert.equal(out.ok, false);
    assert.ok(failed(out).includes('files'));
  });

  it('A5: refuses --from/--to beyond the bands rather than clamping them', async () => {
    const out = await verify({ from: 0, to: 99_999_999 });
    assert.equal(out.ok, false);
    assert.ok(failed(out).includes('coverage'));
  });

  it('A6: refuses a lookup file out of its key order', async () => {
    const file = path.join(band(0), 'lookup_tx_id.parquet');
    await duck.exec(
      `COPY (SELECT * FROM read_parquet('${file}') ORDER BY id8 DESC, height DESC)
       TO '${file}.x' (FORMAT PARQUET, ROW_GROUP_SIZE 2)`,
    );
    await fsp.rename(`${file}.x`, file);
    const out = await verify();
    assert.equal(out.ok, false);
    assert.ok(failed(out).includes('lookups'), JSON.stringify(failed(out)));
  });

  it('A7: refuses rows outside the band, even republished', async () => {
    for (const table of ['blocks', 'transactions']) {
      await rewriteTable(
        duck,
        band(0),
        table,
        `SELECT * FROM SRC UNION ALL SELECT * REPLACE (height + 5000 AS height) FROM SRC`,
      );
    }
    await republish(duck, band(0));
    const out = await verify({ lookups: false });
    assert.equal(out.ok, false);
    assert.ok(failed(out).includes('tables'), JSON.stringify(failed(out)));
  });

  it('A8: reports a format-1 flip as unbound and fails without --allow-unverified-format1', async () => {
    const h = FIRST + 3;
    await rewriteTable(
      duck,
      band(0),
      'transactions',
      // Its data_root cleared too, as a band holds a format-1 one: one left
      // beside it fails `witnesses` on its own.
      // and the block's offsets dropped, which the relabel would move.
      `SELECT * REPLACE (CASE WHEN height = ${h} AND block_transaction_index = 0 THEN 1::UTINYINT ELSE format END AS format, CASE WHEN height = ${h} AND block_transaction_index = 0 THEN NULL ELSE data_root END AS data_root, CASE WHEN height = ${h} THEN NULL ELSE "offset" END AS "offset") FROM SRC`,
    );
    let dir = await republish(duck, band(0));
    // In an l1-4 band the missing witness fails, whatever is accepted.
    const witnessed = await verify({
      allow: { unanchored: true, unverifiedFormat1: true, unsampled: true },
    });
    assert.equal(witnessed.ok, false);
    assert.ok(failed(witnessed).includes('witnesses'));
    // As l1-3, without witnesses: unbound, and accepted by its flag.
    const { parseBandFile, serializeBandFile, PARQUET_L1_WITNESSES } =
      await import('./layout.js');
    const file = path.join(dir, BAND_FILE);
    const { witnesses: _w, ...rest } = parseBandFile(
      await fsp.readFile(file, 'utf8'),
    );
    void _w;
    for (const spec of PARQUET_L1_WITNESSES) {
      await fsp.rm(path.join(dir, spec.file), { force: true });
    }
    await fsp.writeFile(file, serializeBandFile({ ...rest, schema: 'l1-3' }));
    dir = await republish(duck, dir);
    const out = await verify();
    assert.equal(out.ok, false);
    assert.deepEqual(out.unbound.txRootFormat1?.heights, [h]);
    assert.ok(failed(out).includes('unbound'));
    const accepted = await verify({
      allow: { unanchored: true, unverifiedFormat1: true, unsampled: true },
    });
    assert.equal(accepted.ok, true, JSON.stringify(failed(accepted)));
    assert.ok(accepted.accepted.includes('--allow-unverified-format1'));
  });

  it("refuses an l1-1 band outright: its columns are its publisher's, not canonical", async () => {
    const {
      parseBandFile,
      serializeBandFile,
      PARQUET_L1_LOOKUPS,
      PARQUET_L1_WITNESSES,
    } = await import('./layout.js');
    const file = path.join(band(0), BAND_FILE);
    const parsed = parseBandFile(await fsp.readFile(file, 'utf8'));
    for (const spec of [...PARQUET_L1_LOOKUPS, ...PARQUET_L1_WITNESSES]) {
      await fsp.rm(path.join(band(0), spec.file), { force: true });
    }
    const { lookups: _l, witnesses: _w, ...rest } = parsed;
    void _l;
    void _w;
    await fsp.writeFile(file, serializeBandFile({ ...rest, schema: 'l1-1' }));
    await assert.rejects(
      verify(),
      (e: unknown) =>
        e instanceof BandsRefused &&
        /layout l1-1: these columns were written by the publisher and are not canonical; rebuild the band/.test(
          e.message,
        ),
    );
  });

  it('A9: refuses a transactions file missing columns', async () => {
    const file = path.join(band(0), 'transactions.parquet');
    await duck.exec(
      `COPY (SELECT id, block_transaction_index, height, format, data_size, data_root, owner_address, target
             FROM read_parquet('${file}')) TO '${file}.x' (FORMAT PARQUET)`,
    );
    await fsp.rename(`${file}.x`, file);
    const out = await verify();
    assert.equal(out.ok, false);
    assert.ok(failed(out).includes('schema'));
  });

  it('A10: refuses NULLs, never reading them as zero, even republished', async () => {
    const top = FIRST + 19;
    await rewriteTable(
      duck,
      band(1),
      'blocks',
      `SELECT * REPLACE (CASE WHEN height = ${top} THEN NULL ELSE indep_hash END AS indep_hash) FROM SRC`,
    );
    await rewriteTable(
      duck,
      band(0),
      'transactions',
      `SELECT * REPLACE (CASE WHEN height = ${FIRST + 1} THEN NULL ELSE format END AS format) FROM SRC`,
    );
    await republish(duck, band(0));
    await republish(duck, band(1));
    const out = await verify({ lookups: false });
    assert.equal(out.ok, false);
    assert.ok(failed(out).includes('nulls'), JSON.stringify(failed(out)));
  });

  it('A11: passes two installed generations of one band, listing the other', async () => {
    await fsp.cp(band(0), path.join(bandsDir, `${ids[0]}~2`), {
      recursive: true,
    });
    await fsp.rename(band(0), path.join(bandsDir, `${ids[0]}~1`));
    const out = await verify({ lookups: false });
    assert.equal(out.ok, true, JSON.stringify(failed(out)));
    assert.equal(out.duplicates.length, 1);
  });

  it('A11: refuses two generations of one id holding different tables', async () => {
    const other = path.join(bandsDir, `${ids[0]}~2`);
    await fsp.cp(band(0), other, { recursive: true });
    await rewriteTable(
      duck,
      other,
      'tags',
      'SELECT * FROM SRC WHERE tag_index = 0',
    );
    const { parseBandFile, serializeBandFile } = await import('./layout.js');
    const file = path.join(other, BAND_FILE);
    const parsed = parseBandFile(await fsp.readFile(file, 'utf8'));
    parsed.tables.tags.rows -= 1;
    await fsp.writeFile(file, serializeBandFile(parsed));
    const out = await verify({ lookups: false });
    assert.equal(out.ok, false);
    assert.ok(failed(out).includes('files'));
  });

  it('A12 and C F5: ignores a stray directory and a retired copy, listing them, never reading them', async () => {
    await fsp.mkdir(path.join(bandsDir, 'stray'));
    await fsp.copyFile(
      path.join(band(0), 'blocks.parquet'),
      path.join(bandsDir, 'stray', 'blocks.parquet'),
    );
    const retired = path.join(bandsDir, `${ids[0]}~old`);
    await fsp.cp(band(0), retired, { recursive: true });
    await fsp.unlink(path.join(retired, BAND_FILE));
    const out = await verify({ lookups: false });
    assert.equal(out.ok, true, JSON.stringify(failed(out)));
    assert.deepEqual(
      out.ignored.map((i) => i.entry),
      [`${ids[0]}~old`, 'stray'],
    );
  });

  it('A13: refuses band directories not named for what they hold', async () => {
    await fsp.rename(
      band(0),
      path.join(
        bandsDir,
        `l1-h5-7-${ids[0].split('-')[3]}-${ids[0].split('-')[4]}`,
      ),
    );
    await fsp.rename(band(1), path.join(bandsDir, 'not-a-band-id'));
    const out = await verify({ lookups: false });
    assert.equal(out.ok, false);
    assert.ok(failed(out).includes('identity'));
  });

  it('C F2: refuses an id whose digest is not its tables', async () => {
    const wrong = ids[0].replace(/-[0-9a-f]{12}$/, `-${'0'.repeat(12)}`);
    await fsp.rename(band(0), path.join(bandsDir, wrong));
    const out = await verify({ lookups: false });
    assert.equal(out.ok, false);
    assert.ok(failed(out).includes('identity'));
  });

  it('C F6: reports a truncated Parquet file as a failed check, not a crash', async () => {
    const f = path.join(band(0), 'transactions.parquet');
    const { size } = await fsp.stat(f);
    await fsp.truncate(f, Math.floor(size / 2));
    const out = await verify({ lookups: false });
    assert.equal(out.ok, false);
    assert.ok(failed(out).includes('schema'), JSON.stringify(failed(out)));
  });

  it('B F6: anchors bands too, and refuses wrong digests and a junk id', async () => {
    const file = path.join(band(0), BAND_FILE);
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    for (const t of Object.keys(parsed.tables)) {
      parsed.tables[t].rowDigest = '0'.repeat(64);
      parsed.tables[t].rows = 123456789;
    }
    await fsp.writeFile(file, JSON.stringify(parsed));
    await fsp.rename(
      band(1),
      path.join(
        bandsDir,
        `l1-h${FIRST + 10}-${FIRST + 19}-deadbeef-${'f'.repeat(12)}`,
      ),
    );
    const fetch = scriptedFetch({});
    const out = (await indexL1VerifyCLICommand(
      {
        bandsDir,
        skipLookups: true,
        anchorFrom: 'http://a.test,http://b.test',
      },
      { log, freeBytes: async () => 1e13, fetch, lookupAll: scriptedLookup() },
    ).catch((answer) => answer)) as BandsVerifyResult & {
      checks: Array<{ name: string; ok: boolean }>;
    };
    assert.equal(out.ok, false);
    assert.ok([...fetch.asked.values()].reduce((a, b) => a + b, 0) > 0);
    assert.equal(out.anchored, false);
    const names = out.checks.filter((c) => !c.ok).map((c) => c.name);
    assert.ok(names.includes('tables'));
    assert.ok(names.includes('identity'));
    assert.ok(names.includes('anchor'));
  });

  it('anchors the honest set over the CLI with two machines', async () => {
    const fetch = scriptedFetch({
      'http://a.test': chainNode(source),
      'http://b.test': chainNode(source),
    });
    const out = (await indexL1VerifyCLICommand(
      {
        bandsDir,
        anchorFrom: 'http://a.test,http://b.test',
        sampleBlocks: '4',
        sampleTxs: '4',
        seed: '3',
      },
      { log, freeBytes: async () => 1e13, fetch, lookupAll: scriptedLookup() },
    )) as Record<string, any>;
    assert.equal(out.ok, true);
    assert.equal(out.anchored, true);
    assert.equal(out.mode, 'bands-dir');
  });
});

describe('index-l1-verify --core-db fails closed', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'l1-fail-closed-db-'));
  });
  afterEach(async () => {
    if (dir !== undefined) await fsp.rm(dir, { recursive: true, force: true });
  });
  const nodes = (coreDb: string) => ({
    fetch: scriptedFetch({
      'http://a.test': chainNode(coreDb),
      'http://b.test': chainNode(coreDb),
    }),
    lookupAll: scriptedLookup(),
  });

  it('C1: is not anchored without a source, and fails unless that is accepted', async () => {
    const coreDb = path.join(dir, 'a.db');
    await buildCoreDb(coreDb, FIRST, 5, { padded: false, verifiable: true });
    const out = (await indexL1VerifyCLICommand({ coreDb }, { log }).catch(
      (answer) => answer,
    )) as Record<string, any>;
    assert.equal(out.ok, false);
    assert.equal(out.anchored, false);
    assert.ok(out.skipped.includes('anchor'));
    const anchor = out.checks.find((c: any) => c.name === 'anchor');
    assert.equal(anchor.ok, false);
    assert.match(anchor.detail, /not anchored/);
    const accepted = (await indexL1VerifyCLICommand(
      { coreDb, allowUnanchored: true },
      { log },
    )) as Record<string, any>;
    assert.equal(accepted.ok, true);
    assert.deepEqual(accepted.accepted, ['--allow-unanchored']);
  });

  it('C2: refuses a different chain grafted under the real anchor hash', async () => {
    const real = path.join(dir, 'real.db');
    const fake = path.join(dir, 'fake.db');
    await buildCoreDb(real, FIRST, 5, { padded: false, verifiable: true });
    await buildCoreDb(fake, FIRST, 5, {
      padded: false,
      verifiable: true,
      weaveStart: 7_777,
    });
    const top = FIRST + 4;
    const read = new Sqlite(real, { readonly: true });
    const hash = read
      .prepare('SELECT indep_hash FROM stable_blocks WHERE height = ?')
      .pluck()
      .get(top) as Buffer;
    read.close();
    const db = new Sqlite(fake);
    db.prepare('UPDATE stable_blocks SET indep_hash = ? WHERE height = ?').run(
      hash,
      top,
    );
    db.close();
    const out = (await indexL1VerifyCLICommand(
      {
        coreDb: fake,
        anchorFrom: 'http://a.test,http://b.test',
        sampleBlocks: '0',
        sampleTxs: '0',
      },
      { log, ...nodes(real) },
    ).catch((answer) => answer)) as Record<string, any>;
    assert.equal(out.ok, false);
    assert.equal(out.anchored, false);
    assert.ok(out.anchor.mismatches.length > 0);
    // An anchor that shows the index wrong is not accepted away.
    const accepted = (await indexL1VerifyCLICommand(
      {
        coreDb: fake,
        anchorFrom: 'http://a.test,http://b.test',
        sampleBlocks: '0',
        sampleTxs: '0',
        allowUnanchored: true,
      },
      { log, ...nodes(real) },
    ).catch((answer) => answer)) as Record<string, any>;
    assert.equal(accepted.ok, false);
    assert.ok(!accepted.accepted.includes('--allow-unanchored'));
  });

  it('C3: refuses a NULL indep_hash at the anchor height', async () => {
    const coreDb = path.join(dir, 'a.db');
    await buildCoreDb(coreDb, FIRST, 5, { padded: false, verifiable: true });
    const copy = path.join(dir, 'served.db');
    await fsp.copyFile(coreDb, copy);
    const db = new Sqlite(coreDb);
    db.prepare(
      'UPDATE stable_blocks SET indep_hash = NULL WHERE height = ?',
    ).run(FIRST + 4);
    db.close();
    const out = (await indexL1VerifyCLICommand(
      {
        coreDb,
        anchorFrom: 'http://a.test,http://b.test',
        sampleBlocks: '0',
        sampleTxs: '0',
      },
      { log, ...nodes(copy) },
    ).catch((answer) => answer)) as Record<string, any>;
    assert.equal(out.ok, false);
    assert.equal(out.anchored, false);
    assert.match(out.anchor.problems.join(';'), /no indep_hash/);
  });

  it('C4: refuses a transaction invented below the fork, and one at a height with no block', async () => {
    const coreDb = path.join(dir, 'a.db');
    await buildCoreDb(coreDb, 300_000, 20, { padded: false });
    const db = new Sqlite(coreDb);
    db.prepare(
      `INSERT INTO stable_transactions (id, height, block_transaction_index, format, last_tx,
        owner_address, quantity, reward, data_size, tag_count)
       VALUES (randomblob(32), 300004, 7, 1, x'00', randomblob(32), '999999999999', '0', 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO stable_transactions (id, height, block_transaction_index, format, last_tx,
        owner_address, quantity, reward, data_size, tag_count)
       VALUES (randomblob(32), 9000000, 0, 2, x'00', randomblob(32), '1', '0', 12345, 0)`,
    ).run();
    db.close();
    const out = (await indexL1VerifyCLICommand(
      { coreDb, allowUnanchored: true, allowUnbound: true },
      { log },
    ).catch((answer) => answer)) as Record<string, any>;
    assert.equal(out.ok, false);
    const names = out.checks.filter((c: any) => !c.ok).map((c: any) => c.name);
    assert.ok(names.includes('position'), JSON.stringify(names));
    assert.ok(names.includes('rows'));
    const strict = (await indexL1VerifyCLICommand({ coreDb }, { log }).catch(
      (answer) => answer,
    )) as Record<string, any>;
    assert.equal(strict.unbound.pre20.blocks, 21);
  });

  it('C F8: checks the whole held range by default, not only up to the fork', () => {
    assert.deepEqual(chooseRange([0, 1_999_999]), [0, 1_999_999]);
  });

  it('refuses a range wholly below the fork as unbound and unanchorable', async () => {
    const coreDb = path.join(dir, 'a.db');
    await buildCoreDb(coreDb, FORK_2_0 - 30, 20, { padded: false });
    const sqlite = new Sqlite(coreDb, { readonly: true });
    try {
      const out = await verifyCoreDb(sqlite, {
        from: FORK_2_0 - 31,
        to: FORK_2_0 - 11,
        pool: new ArweaveNodePool({
          urls: ['http://a.test', 'http://b.test'],
          ...nodes(coreDb),
        }),
      });
      assert.equal(out.ok, false);
      assert.equal(out.anchored, false);
      assert.equal(out.unbound.pre20?.blocks, 21);
    } finally {
      sqlite.close();
    }
  });
});
