/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Attacks on `l1-4` bands found in review of the witnesses, kept as
 * regression tests: each is refused by `index-l1-verify --bands-dir` and
 * by the importer, with no flag that would accept it.
 *
 * - A pre-2.0 header field the 2.0 seed fold does not cover (timestamp,
 *   reward address, difficulty, nonce, hash, reward pool, wallet list…),
 *   forged and republished: its 2.0 hash no longer recomputes.
 * - A format-1 transaction's `data_root` column forged beside its witness:
 *   under `l1-4` it must be NULL.
 * - A format-2 transaction relabelled format 1 with its own root as a
 *   witness, imported with `--sample-format1 0`: refused unless
 *   `--allow-unsampled`; drawn, it is refuted by its signature.
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
import { verifyBands } from './verify-bands.js';

const log = createTestLogger({ suite: 'l1-witness-attacks' });
const V1 = 100_000;
const P2 = 1_900_000;

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

const failing = (out: Awaited<ReturnType<typeof verifyBands>>) =>
  out.checks.filter((c) => !c.ok).map((c) => c.name);

describe('attacks on l1-4 witnesses', () => {
  let dir: string;
  let source: string;
  let core: string;
  let bandsDir: string;
  let duck: Database;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'l1-witness-attacks-'));
    source = path.join(dir, 'source.db');
    core = path.join(dir, 'core.db');
    bandsDir = path.join(dir, 'bands');
    migratedCore(core);
    const { Database: D } = await import('duckdb-async');
    duck = await D.create(':memory:');
  });
  afterEach(async () => {
    await duck?.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

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
  const sample = (format1: number, txs = 50) => ({
    seed: 7,
    blocks: 20,
    txsPerStratum: txs,
    format1PerStratum: format1,
    v1BytesPerStratum: 1e9,
    concurrency: 2,
  });

  for (const [column, value] of [
    ['block_timestamp', 'block_timestamp + 86400*365'],
    ['reward_addr', "from_hex(repeat('ee', 32))"],
    ['diff', "'5'"],
    ['cumulative_diff', "'9'"],
    ['last_retarget', 'last_retarget + 1'],
    ['nonce', "from_hex(repeat('aa', 32))"],
    ['reward_pool', "'999999999999'"],
    ['hash', "from_hex(repeat('bb', 32))"],
    ['wallet_list', "from_hex(repeat('cc', 48))"],
  ] as const) {
    it(`refuses a forged pre-2.0 ${column}, in verify and import`, async () => {
      await buildCoreDb(source, V1, 21, { verifiable: true });
      holdBlocks(source, core, V1 + 10);
      const [band] = await exportBands(source, bandsDir, [[V1, V1 + 9]]);
      const foldPins = await witnessTestBand(duck, source, band.dir);
      await rewriteTable(
        duck,
        band.dir,
        'blocks',
        `SELECT * REPLACE (CASE WHEN height = ${V1 + 5} THEN ${value} ELSE ${column} END AS ${column}) FROM SRC`,
      );
      await republish(duck, band.dir);
      const verified = await verifyBands(duck, bandsDir, {
        allow: { unanchored: true },
        foldPins,
      });
      assert.equal(verified.ok, false);
      assert.ok(failing(verified).includes('hash_list_1_0'));
      assert.equal(verified.foldBound, 0);
      const out = await fill({
        pool: pool(),
        sample: sample(0),
        allow: {},
        foldPins,
      });
      assert.equal(out.outcomes[0].result, 'refused');
      assert.match(out.outcomes[0].reason ?? '', /hash_list_1_0/);
      const db = new Sqlite(core, { readonly: true });
      try {
        assert.equal(
          db
            .prepare('SELECT COUNT(*) FROM stable_blocks WHERE height = ?')
            .pluck()
            .get(V1 + 5),
          0,
        );
      } finally {
        db.close();
      }
    });
  }

  it('refuses a format-1 data_root forged beside its witness, in verify and import', async () => {
    await buildCoreDb(source, V1, 21, { verifiable: true });
    holdBlocks(source, core, V1 + 10);
    const [band] = await exportBands(source, bandsDir, [[V1, V1 + 9]]);
    const foldPins = await witnessTestBand(duck, source, band.dir);
    const [t] = (await duck.all(
      `SELECT height, block_transaction_index AS bti FROM read_parquet('${band.dir}/transactions.parquet')
       WHERE format = 1 AND data_size > 0 ORDER BY height LIMIT 1`,
    )) as Array<{ height: bigint; bti: number }>;
    await rewriteTable(
      duck,
      band.dir,
      'transactions',
      `SELECT * REPLACE (CASE WHEN height = ${t.height} AND block_transaction_index = ${t.bti} THEN from_hex(repeat('de', 32)) ELSE data_root END AS data_root) FROM SRC`,
    );
    await republish(duck, band.dir);
    const verified = await verifyBands(duck, bandsDir, {
      allow: { unanchored: true },
      foldPins,
    });
    // Unsampled, a pinned band also fails sample_blocks.
    assert.deepEqual(failing(verified), ['witnesses', 'sample_blocks']);
    const out = await fill({
      pool: pool(),
      sample: sample(0),
      allow: {},
      foldPins,
    });
    assert.equal(out.outcomes[0].result, 'refused');
    assert.match(out.outcomes[0].reason ?? '', /witnesses/);
  });

  it('catches a pre-2.0 block whose transactions are reordered, by the attested header sample', async () => {
    await buildCoreDb(source, V1, 21, { verifiable: true });
    const [band] = await exportBands(source, bandsDir, [[V1, V1 + 9]]);
    const foldPins = await witnessTestBand(duck, source, band.dir);
    // The 2.0 hash sorts ids, so the order survives every hash: a block of
    // three, reversed, links and all.
    const h = V1 + 3;
    for (const table of ['transactions', 'block_transactions']) {
      await rewriteTable(
        duck,
        band.dir,
        table,
        `SELECT * REPLACE (CASE WHEN height = ${h} THEN 2 - block_transaction_index ELSE block_transaction_index END AS block_transaction_index) FROM SRC`,
      );
    }
    await republish(duck, band.dir);
    const unsampled = await verifyBands(duck, bandsDir, {
      allow: { unanchored: true },
      foldPins,
    });
    // Undrawn, the order is checked by nothing: never a silent pass.
    assert.deepEqual(failing(unsampled), ['sample_blocks']);
    const sampled = await verifyBands(duck, bandsDir, {
      allow: { unanchored: true },
      foldPins,
      pool: pool(),
      sample: { ...sample(0, 0), blocks: 10 },
    });
    assert.ok(failing(sampled).includes('sample'), failing(sampled).join());
    assert.match(
      sampled.checks.find((c) => c.name === 'sample')?.failures?.[0].found ??
        '',
      /block_transactions/,
    );
    assert.equal(sampled.sample?.blocksAttested, 10);
  });

  it('refuses an l1-4 band stripped of a witness row, whatever --allow flag is given', async () => {
    await buildCoreDb(source, V1, 21, { verifiable: true });
    holdBlocks(source, core, V1 + 10);
    const [band] = await exportBands(source, bandsDir, [[V1, V1 + 9]]);
    const foldPins = await witnessTestBand(duck, source, band.dir);
    // A forged reward_addr, and its block's fork_2_0 row removed so its
    // 2.0 hash is never compared, then described anew.
    await rewriteTable(
      duck,
      band.dir,
      'blocks',
      `SELECT * REPLACE (CASE WHEN height = ${V1 + 5} THEN from_hex(repeat('ee', 32)) ELSE reward_addr END AS reward_addr) FROM SRC`,
    );
    const wf = path.join(band.dir, 'witness_fork_2_0.parquet');
    await duck.exec(
      `COPY (SELECT * FROM read_parquet('${wf}') WHERE height <> ${V1 + 5} ORDER BY height) TO '${wf}.x' (FORMAT PARQUET)`,
    );
    await fsp.rename(`${wf}.x`, wf);
    await republish(duck, band.dir);
    const verified = await verifyBands(duck, bandsDir, {
      allow: { unanchored: true, unbound: true, unverifiedFormat1: true },
      foldPins,
    });
    assert.equal(verified.ok, false);
    assert.ok(
      failing(verified).includes('witnesses'),
      failing(verified).join(),
    );
    const out = await fill({
      pool: pool(),
      sample: sample(0),
      allow: { unbound: true, unverifiedFormat1: true },
      foldPins,
    });
    assert.equal(out.outcomes[0].result, 'refused');
    assert.match(out.outcomes[0].reason ?? '', /witnesses/);
  });

  it('refuses an l1-4 band stripped of a v1 root, whatever --allow flag is given', async () => {
    await buildCoreDb(source, V1, 21, { verifiable: true });
    const [band] = await exportBands(source, bandsDir, [[V1, V1 + 9]]);
    const foldPins = await witnessTestBand(duck, source, band.dir);
    const wf = path.join(band.dir, 'witness_v1_data_roots.parquet');
    await duck.exec(
      `COPY (SELECT * FROM read_parquet('${wf}') WHERE height <> ${V1 + 3} ORDER BY height, id) TO '${wf}.x' (FORMAT PARQUET)`,
    );
    await fsp.rename(`${wf}.x`, wf);
    await republish(duck, band.dir);
    const verified = await verifyBands(duck, bandsDir, {
      allow: { unanchored: true, unbound: true, unverifiedFormat1: true },
      foldPins,
    });
    assert.equal(verified.ok, false);
    assert.ok(
      failing(verified).includes('witnesses'),
      failing(verified).join(),
    );
  });

  for (const [column, value] of [
    ['diff', "'00' || diff"],
    ['cumulative_diff', "cumulative_diff || '.000'"],
    ['reward_pool', "'0' || reward_pool"],
  ] as const) {
    it(`refuses a re-spelt pre-2.0 ${column}, in verify and import`, async () => {
      await buildCoreDb(source, V1, 21, { verifiable: true });
      holdBlocks(source, core, V1 + 10);
      const [band] = await exportBands(source, bandsDir, [[V1, V1 + 9]]);
      const foldPins = await witnessTestBand(duck, source, band.dir);
      await rewriteTable(
        duck,
        band.dir,
        'blocks',
        `SELECT * REPLACE (CASE WHEN height = ${V1 + 5} THEN ${value} ELSE ${column} END AS ${column}) FROM SRC`,
      );
      await republish(duck, band.dir);
      const verified = await verifyBands(duck, bandsDir, {
        allow: { unanchored: true },
        foldPins,
      });
      // A number that no longer reads as one also leaves the 2.0 hash
      // uncomputable: canonical fails either way.
      assert.equal(verified.ok, false);
      assert.ok(
        failing(verified).includes('canonical'),
        failing(verified).join(),
      );
      const out = await fill({
        pool: pool(),
        sample: sample(0),
        allow: {},
        foldPins,
      });
      assert.equal(out.outcomes[0].result, 'refused');
      assert.match(out.outcomes[0].reason ?? '', /canonical/);
    });
  }

  it('anchors a pre-2.0 band at its pinned top: verify and import with no --allow flag', async () => {
    await buildCoreDb(source, V1, 21, { verifiable: true });
    const [band] = await exportBands(source, bandsDir, [[V1, V1 + 9]]);
    const foldPins = await witnessTestBand(duck, source, band.dir);
    const verified = await verifyBands(duck, bandsDir, {
      foldPins,
      pool: pool(),
      sample: sample(0),
    });
    assert.equal(verified.ok, true, failing(verified).join());
    assert.equal(verified.anchored, true);
    assert.equal(verified.anchor?.pinned, true);
    assert.deepEqual(
      verified.accepted.filter((f) => f.startsWith('--allow-')),
      [],
    );
    // A band whose folds stop short of a pin is not anchored.
    const short = { fold: new Map(foldPins.fold), h2: new Map(foldPins.h2) };
    short.fold.delete(V1 + 9);
    short.h2.delete(V1 + 9);
    const unpinned = await verifyBands(duck, bandsDir, {
      foldPins: short,
      pool: pool(),
      sample: sample(0),
    });
    assert.equal(unpinned.ok, false);
    assert.equal(unpinned.anchored, false);
    // Anchored by its pins with no source at all: nothing drew a header,
    // so its transaction order is checked by nothing. Not a pass.
    const noSource = await verifyBands(duck, bandsDir, { foldPins });
    assert.equal(noSource.anchored, true);
    assert.equal(noSource.ok, false);
    assert.ok(
      failing(noSource).includes('sample_blocks'),
      failing(noSource).join(),
    );
    const noSourceAccepted = await verifyBands(duck, bandsDir, {
      foldPins,
      allow: { unsampled: true },
    });
    assert.equal(noSourceAccepted.ok, true, failing(noSourceAccepted).join());
    assert.ok(noSourceAccepted.accepted.includes('--allow-unsampled'));
    // Imported offline into an empty core.db, with nothing above it.
    const db = new Sqlite(core, { timeout: 1000 });
    try {
      const run = await runImport({
        db,
        duck,
        bandsDir,
        log,
        verification: { pool: pool(), sample: sample(0), allow: {}, foldPins },
      });
      assert.equal(run.outcomes[0].result, 'imported', run.outcomes[0].reason);
      assert.equal(run.outcomes[0].check?.binding.kind, 'anchored');
      assert.match(run.outcomes[0].check?.boundBy ?? '', /pinned/);
    } finally {
      db.close();
    }
  });

  it('refuses --sample-blocks 0 and an undrawn format-1 sample, in verify as in import', async () => {
    await buildCoreDb(source, P2, 21, { verifiable: true });
    holdBlocks(source, core, P2 + 10);
    const [band] = await exportBands(source, bandsDir, [[P2, P2 + 9]]);
    // A relabel: tx_root holds, only the format-1 draw would tell.
    const [t] = (await duck.all(
      `SELECT hex(id) AS id, hex(data_root) AS root FROM read_parquet('${band.dir}/transactions.parquet') WHERE height = ${P2 + 1}`,
    )) as Array<{ id: string; root: string }>;
    await rewriteTable(
      duck,
      band.dir,
      'transactions',
      `SELECT * REPLACE (CASE WHEN height = ${P2 + 1} THEN 1 ELSE format END AS format, CASE WHEN height = ${P2 + 1} THEN NULL ELSE data_root END AS data_root) FROM SRC`,
    );
    const wf = `${band.dir}/witness_v1_data_roots.parquet`;
    await duck.exec(
      `CREATE OR REPLACE TABLE w AS SELECT * FROM read_parquet('${wf}') UNION ALL SELECT ${P2 + 1}::UBIGINT, from_hex('${t.id}'), from_hex('${t.root}')`,
    );
    await duck.exec(
      `COPY (SELECT * FROM w ORDER BY height, id) TO '${wf}' (FORMAT PARQUET)`,
    );
    await republish(duck, band.dir);
    const none = { ...sample(0, 0), blocks: 0 };
    // Every count 0, with sources: both gates.
    const zero = await verifyBands(duck, bandsDir, {
      allow: { unanchored: true },
      pool: pool(),
      sample: none,
    });
    assert.ok(failing(zero).includes('sample_format1'), failing(zero).join());
    assert.ok(failing(zero).includes('sample_blocks'), failing(zero).join());
    // No sample at all: the format-1 gate.
    const unsampled = await verifyBands(duck, bandsDir, {
      allow: { unanchored: true },
    });
    assert.deepEqual(failing(unsampled), ['sample_format1']);
    const accepted = await verifyBands(duck, bandsDir, {
      allow: { unanchored: true, unsampled: true },
    });
    assert.equal(accepted.ok, true, failing(accepted).join());
    assert.ok(accepted.accepted.includes('--allow-unsampled'));
    // The importer agrees.
    const out = await fill({
      pool: pool(),
      sample: { ...sample(5), blocks: 0 },
      allow: {},
    });
    assert.equal(out.outcomes[0].result, 'refused');
    assert.match(out.outcomes[0].reason ?? '', /--sample-blocks 0/);
  });

  it('refuses a relabel imported with --sample-format1 0, and catches it when drawn', async () => {
    await buildCoreDb(source, P2, 21, { verifiable: true });
    holdBlocks(source, core, P2 + 10);
    const [band] = await exportBands(source, bandsDir, [[P2, P2 + 9]]);
    // A one-transaction block, so the relabel keeps the tree's order.
    const [t] = (await duck.all(
      `SELECT height, block_transaction_index AS bti, hex(id) AS id, hex(data_root) AS root
       FROM read_parquet('${band.dir}/transactions.parquet')
       WHERE height = ${P2 + 1}`,
    )) as Array<{ height: bigint; bti: number; id: string; root: string }>;
    const h = Number(t.height);
    await rewriteTable(
      duck,
      band.dir,
      'transactions',
      `SELECT * REPLACE (CASE WHEN height = ${h} THEN 1 ELSE format END AS format, CASE WHEN height = ${h} THEN NULL ELSE data_root END AS data_root) FROM SRC`,
    );
    const wf = `${band.dir}/witness_v1_data_roots.parquet`;
    await duck.exec(
      `CREATE OR REPLACE TABLE w AS SELECT * FROM read_parquet('${wf}') UNION ALL SELECT ${h}::UBIGINT, from_hex('${t.id}'), from_hex('${t.root}')`,
    );
    await duck.exec(
      `COPY (SELECT * FROM w ORDER BY height, id) TO '${wf}' (FORMAT PARQUET)`,
    );
    await republish(duck, band.dir);
    // tx_root holds: only the format-1 draw can tell.
    const unsampled = await fill({
      pool: pool(),
      sample: sample(0),
      allow: {},
    });
    assert.equal(unsampled.outcomes[0].result, 'refused');
    assert.match(unsampled.outcomes[0].reason ?? '', /--sample-format1 0/);
    const drawn = await fill({ pool: pool(), sample: sample(5), allow: {} });
    assert.equal(drawn.outcomes[0].result, 'refused');
    assert.match(drawn.outcomes[0].reason ?? '', /sample refutes/);
  });
});
