/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Sqlite from 'better-sqlite3';
import type { Database } from 'duckdb-async';

import { exportL1Band } from '../../index-export/kinds/parquet-l1/export.js';
import { buildCoreDb } from '../../../test/parquet-l1-core-db.js';
import { createTestLogger } from '../../../test/test-logger.js';
import {
  assertImportable,
  bandDigest,
  ImportableBand,
  importBand,
  ImportRefused,
  LEDGER_MIGRATION,
  planImport,
  readBands,
  runImport,
  readProgress,
} from './import.js';

const log = createTestLogger({ suite: 'parquet-l1 import' });
const FIRST = 1_900_000;
const MIGRATION =
  'migrations/2026.10.04T12.00.00.core.add-parquet-l1-imports.sql';

/** An empty core.db with the ledger table, as a migrated gateway has. */
function emptyCore(file: string): Sqlite.Database {
  const db = new Sqlite(file);
  db.exec(fs.readFileSync('test/core-schema.sql', 'utf8'));
  db.exec(fs.readFileSync(MIGRATION, 'utf8'));
  return db;
}

const band = (id: string, from: number, to: number): ImportableBand => ({
  id,
  dir: `/x/${id}`,
  band: { heightRange: [from, to], tables: {} } as never,
});

describe('planImport', () => {
  const held = new Set<string>();

  it('takes bands in height order from where the database stops', () => {
    const { steps } = planImport(
      [band('a', 0, 99), band('b', 100, 199), band('c', 200, 249)],
      { haveTo: 99, held },
    );
    assert.deepEqual(
      steps.map((s) => s.band.heightRange),
      [
        [100, 199],
        [200, 249],
      ],
    );
  });

  it('skips a band the ledger already holds, and goes on from there', () => {
    const { steps, skipped } = planImport(
      [band('a', 0, 99), band('b', 100, 199)],
      { haveTo: 99, held: new Set(['a']) },
    );
    assert.deepEqual(
      steps.map((s) => s.id),
      ['b'],
    );
    assert.deepEqual(
      skipped.map((s) => s.id),
      ['a'],
    );
  });

  it('refuses a ledger that claims heights the database does not hold', () => {
    // Held but absent: the ledger and core.db disagree, so importing `b`
    // would leave 0-99 uncovered. Refuse rather than import around it.
    assert.throws(
      () =>
        planImport([band('a', 0, 99), band('b', 100, 199)], {
          haveTo: -1,
          held: new Set(['a']),
        }),
      (e: Error) =>
        e instanceof ImportRefused && /No band covers height 0/.test(e.message),
    );
  });

  it('finishes a band an earlier run left part way, rather than skipping it', () => {
    // core.db stops inside the band: a crash between chunks. The band is
    // not in the ledger, so it is imported again over what is there.
    const { steps, skipped } = planImport(
      [band('a', 0, 99), band('b', 100, 199)],
      {
        haveTo: 149,
        held: new Set(['a']),
      },
    );
    assert.deepEqual(
      steps.map((s) => s.id),
      ['b'],
    );
    assert.deepEqual(
      skipped.map((s) => s.id),
      ['a'],
    );
  });

  it('refuses a gap rather than importing around it', () => {
    assert.throws(
      () =>
        planImport([band('a', 0, 99), band('c', 200, 299)], {
          haveTo: 99,
          held,
        }),
      (e: Error) =>
        e instanceof ImportRefused &&
        /No band covers height 100/.test(e.message),
    );
  });

  it('prefers the band that reaches furthest where two overlap', () => {
    const { steps, skipped } = planImport(
      [band('whole', 0, 99), band('tip', 0, 49)],
      { haveTo: -1, held },
    );
    assert.deepEqual(
      steps.map((s) => s.id),
      ['whole'],
    );
    assert.deepEqual(
      skipped.map((s) => s.id),
      ['tip'],
    );
  });
});

describe('importBand', () => {
  let dir: string;
  let sourceDb: string;
  let bandDir: string;
  let entry: ImportableBand;
  let duck: Database;
  let target: Sqlite.Database;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'parquet-l1-import-'));
    sourceDb = path.join(dir, 'source.db');
    const workDir = path.join(dir, 'work');
    await fsp.mkdir(workDir);
    await buildCoreDb(sourceDb, FIRST, 30, { signatures: true });
    const result = await exportL1Band({
      coreDbPath: sourceDb,
      workDir,
      from: FIRST,
      to: FIRST + 29,
    });
    bandDir = result.dir;
    entry = {
      id: `l1-h${FIRST}-${FIRST + 29}-test-0`,
      dir: bandDir,
      band: result.band,
    };
    const { Database } = await import('duckdb-async');
    duck = await Database.create(':memory:');
    target = emptyCore(path.join(dir, 'core.db'));
  });

  afterEach(async () => {
    target?.close();
    await duck?.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const counts = (db: Sqlite.Database) =>
    Object.fromEntries(
      [
        'stable_blocks',
        'stable_transactions',
        'stable_block_transactions',
        'stable_transaction_tags',
        'wallets',
        'tag_names',
        'tag_values',
      ].map((t) => [
        t,
        db.prepare(`SELECT COUNT(*) FROM ${t}`).pluck().get() as number,
      ]),
    );

  it('reproduces the rows the band was exported from', async () => {
    const out = await importBand(target, duck, entry, { log, batchRows: 7 });
    const source = new Sqlite(sourceDb, { readonly: true });
    try {
      const want = counts(source);
      const got = counts(target);
      // The source holds one block below the band (the anchor) and its rows.
      assert.equal(got.stable_blocks, 30);
      assert.equal(got.stable_transactions, want.stable_transactions);
      assert.equal(
        got.stable_block_transactions,
        want.stable_block_transactions,
      );
      assert.equal(got.stable_transaction_tags, want.stable_transaction_tags);
      assert.equal(got.wallets, want.wallets);
      assert.equal(got.tag_names, want.tag_names);
      assert.equal(got.tag_values, want.tag_values);
      assert.equal(out.missingTransactions, 0);

      // Every block, byte for byte on the fields the chain fixes.
      const cols =
        'height, indep_hash, previous_block, hash_list_merkle, tx_root, weave_size, tx_count';
      const rows = (db: Sqlite.Database) =>
        db
          .prepare(
            `SELECT ${cols} FROM stable_blocks WHERE height >= ? ORDER BY height`,
          )
          .all(FIRST);
      assert.deepEqual(rows(target), rows(source));

      // And every transaction, including the tag dictionaries resolving back.
      const tx = (db: Sqlite.Database) =>
        db
          .prepare(
            `SELECT id, height, block_transaction_index, last_tx, owner_address,
          data_size, data_root, format, tag_count, signature FROM stable_transactions
          ORDER BY height, block_transaction_index`,
          )
          .all();
      assert.deepEqual(tx(target), tx(source));

      const tags = (db: Sqlite.Database) =>
        db
          .prepare(
            `SELECT t.height, t.transaction_id, t.transaction_tag_index, n.name, v.value
          FROM stable_transaction_tags t
          JOIN tag_names n ON n.hash = t.tag_name_hash
          JOIN tag_values v ON v.hash = t.tag_value_hash
          ORDER BY t.height, t.transaction_id, t.transaction_tag_index`,
          )
          .all();
      assert.deepEqual(tags(target), tags(source));
    } finally {
      source.close();
    }
  });

  it('records the band so a second import is a no-op, and is resumable', async () => {
    await importBand(target, duck, entry, { log, batchRows: 7 });
    const ledger = target
      .prepare(
        'SELECT band_id, height_from, height_to, band_digest, rows_imported FROM parquet_l1_imports',
      )
      .all() as Array<Record<string, unknown>>;
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].band_id, entry.id);
    assert.deepEqual(ledger[0].band_digest, bandDigest(entry.band));

    const progress = readProgress(target);
    assert.equal(progress.haveTo, FIRST + 29);
    assert.deepEqual([...progress.held], [entry.id]);
    // The planner now has nothing to do.
    assert.deepEqual(planImport([entry], progress).steps, []);
  });

  it('commits the band, so it survives closing the database', async () => {
    const file = path.join(dir, 'core.db');
    await importBand(target, duck, entry, { log, batchRows: 7 });
    target.close();
    // A fresh connection sees only what was committed.
    const reopened = new Sqlite(file, { readonly: true });
    try {
      assert.equal(
        reopened.prepare('SELECT COUNT(*) FROM stable_blocks').pluck().get(),
        30,
        'the blocks are durable',
      );
      assert.equal(
        reopened
          .prepare('SELECT COUNT(*) FROM parquet_l1_imports')
          .pluck()
          .get(),
        1,
        'and so is the ledger row',
      );
    } finally {
      reopened.close();
    }
    target = new Sqlite(file);
  });

  it('is idempotent: importing the same band twice changes nothing', async () => {
    await importBand(target, duck, entry, { log, batchRows: 7 });
    const snapshot = () =>
      Object.fromEntries(
        [
          'stable_blocks',
          'stable_transactions',
          'stable_block_transactions',
          'stable_transaction_tags',
          'wallets',
          'tag_names',
          'tag_values',
          'missing_transactions',
        ].map((t) => [
          t,
          JSON.stringify(target.prepare(`SELECT * FROM ${t}`).all(), (_k, v) =>
            v?.type === 'Buffer' ? v.data.join(',') : v,
          ),
        ]),
      );
    const first = snapshot();

    const out = await importBand(target, duck, entry, { log, batchRows: 7 });

    assert.deepEqual(snapshot(), first, 'every table is unchanged');
    assert.equal(out.missingTransactions, 0);
    assert.equal(
      target.prepare('SELECT COUNT(*) FROM parquet_l1_imports').pluck().get(),
      1,
      'one ledger row, not two',
    );
  });

  it('derives missing_tx_count rather than adding to it, so a re-import holds', async () => {
    const db = new Sqlite(sourceDb);
    // Two gone from one block: an incrementing count would say 1, because
    // re-inserting the block resets it to 0 first. Only a derived count
    // says 2.
    db.prepare(
      'DELETE FROM stable_transactions WHERE height = ? AND block_transaction_index IN (0, 1)',
    ).run(FIRST + 3);
    db.close();
    const work2 = path.join(dir, 'work-missing');
    await fsp.mkdir(work2);
    const gapped = await exportL1Band({
      coreDbPath: sourceDb,
      workDir: work2,
      from: FIRST,
      to: FIRST + 29,
    });
    const band2 = { id: 'l1-gapped', dir: gapped.dir, band: gapped.band };
    const count = () =>
      target
        .prepare('SELECT missing_tx_count FROM stable_blocks WHERE height = ?')
        .pluck()
        .get(FIRST + 3);

    const first = await importBand(target, duck, band2, { log, batchRows: 7 });
    assert.equal(first.missingTransactions, 2);
    assert.equal(count(), 2, 'both gaps counted on the block');
    await importBand(target, duck, band2, { log, batchRows: 7 });
    assert.equal(count(), 2, 'still 2 after a re-import');
  });

  it('leaves no ledger row when a band fails part way, and finishes on a re-run', async () => {
    // Commit often enough that the failure lands after some rows are
    // committed: the band is partly in, which is what makes the planner's
    // re-import and the idempotent writes load-bearing.
    const lying = {
      ...entry,
      band: { ...entry.band, tables: { ...entry.band.tables } },
    };
    lying.band.tables.tags = {
      ...lying.band.tables.tags,
      rowDigest: 'f'.repeat(64),
    };
    await assert.rejects(
      importBand(target, duck, lying, { log, batchRows: 5, commitEvery: 10 }),
      /do not reproduce the digest/,
    );
    const partial = target
      .prepare('SELECT COUNT(*) FROM stable_blocks')
      .pluck()
      .get() as number;
    assert.ok(partial > 0, 'the chunks that committed are still there');
    assert.equal(
      target
        .prepare(
          'SELECT COUNT(*) FROM parquet_l1_imports WHERE completed_at IS NULL',
        )
        .pluck()
        .get(),
      1,
      'the band is recorded as unfinished, so a re-run redoes it',
    );

    // The same band, intact: the re-run writes over what is there.
    const out = await importBand(target, duck, entry, {
      log,
      batchRows: 5,
      commitEvery: 10,
    });
    assert.equal(out.missingTransactions, 0);
    assert.equal(
      target.prepare('SELECT COUNT(*) FROM stable_blocks').pluck().get(),
      30,
    );
    assert.equal(
      target
        .prepare(
          'SELECT COUNT(*) FROM parquet_l1_imports WHERE completed_at IS NOT NULL',
        )
        .pluck()
        .get(),
      1,
      'and is finished now',
    );
    // And the rows match the chain it came from, as an uninterrupted run.
    const source = new Sqlite(sourceDb, { readonly: true });
    try {
      const tx = (db: Sqlite.Database) =>
        db
          .prepare(
            'SELECT id, height, block_transaction_index FROM stable_transactions ORDER BY height, block_transaction_index',
          )
          .all();
      assert.deepEqual(tx(target), tx(source));
    } finally {
      source.close();
    }
  });

  it('records a link whose transaction the band lacks as missing, and counts it on the block', async () => {
    const db = new Sqlite(sourceDb);
    db.prepare(
      'DELETE FROM stable_transactions WHERE height = ? AND block_transaction_index = 1',
    ).run(FIRST + 2);
    db.close();
    const work2 = path.join(dir, 'work2');
    await fsp.mkdir(work2);
    const again = await exportL1Band({
      coreDbPath: sourceDb,
      workDir: work2,
      from: FIRST,
      to: FIRST + 29,
    });
    const out = await importBand(
      target,
      duck,
      { id: 'l1-again', dir: again.dir, band: again.band },
      { log, batchRows: 7 },
    );
    assert.equal(out.missingTransactions, 1);
    const missing = target
      .prepare('SELECT height FROM missing_transactions')
      .all();
    assert.deepEqual(missing, [{ height: FIRST + 2 }]);
    assert.equal(
      target
        .prepare('SELECT missing_tx_count FROM stable_blocks WHERE height = ?')
        .pluck()
        .get(FIRST + 2),
      1,
    );
  });
});

describe('readBands', () => {
  it('reads a directory of bands lowest first, ignoring what has no band file', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'parquet-l1-bands-'));
    try {
      const tables = Object.fromEntries(
        ['blocks', 'block_transactions', 'transactions', 'tags', 'wallets'].map(
          (t) => [t, { rows: 0, rowDigest: '0'.repeat(64) }],
        ),
      );
      for (const [id, from, to] of [
        ['b', 100, 199],
        ['a', 0, 99],
      ] as const) {
        await fsp.mkdir(path.join(dir, id));
        await fsp.writeFile(
          path.join(dir, id, 'band.json'),
          JSON.stringify({
            version: 1,
            schema: 'l1-1',
            heightRange: [from, to],
            tables,
            createdAt: '2026-10-04T00:00:00Z',
          }),
        );
      }
      await fsp.mkdir(path.join(dir, 'not-a-band'));
      assert.deepEqual(
        (await readBands(dir)).map((b) => b.id),
        ['a', 'b'],
      );
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('assertImportable', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'parquet-l1-guard-'));
    file = path.join(dir, 'core.db');
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  /** A core.db as the gateway leaves it, optionally already migrated. */
  const core = (migrated: boolean) => {
    const db = new Sqlite(file);
    db.exec(fs.readFileSync('test/core-schema.sql', 'utf8'));
    if (migrated) {
      db.exec(fs.readFileSync(MIGRATION, 'utf8'));
      db.prepare('INSERT INTO migrations (name) VALUES (?)').run(
        LEDGER_MIGRATION,
      );
    }
    return db;
  };

  it('accepts a migrated, quiet database', () => {
    const db = core(true);
    try {
      assertImportable(db);
    } finally {
      db.close();
    }
  });

  it('refuses one that has not run the ledger migration', () => {
    const db = core(false);
    try {
      assert.throws(
        () => assertImportable(db),
        (e: Error) =>
          e instanceof ImportRefused && /yarn db:migrate up/.test(e.message),
      );
    } finally {
      db.close();
    }
  });

  it('refuses one holding unstable blocks, which the importer writes beneath', () => {
    const db = core(true);
    try {
      db.prepare(
        `INSERT INTO new_blocks (indep_hash, height, previous_block, nonce, hash,
         block_timestamp, diff, cumulative_diff, last_retarget, reward_addr,
         reward_pool, block_size, weave_size, hash_list_merkle, tx_root,
         tx_count, missing_tx_count)
         VALUES (?, 5, ?, ?, ?, 1, '1', '2', 3, ?, '4', 0, 0, ?, ?, 0, 0)`,
      ).run(
        Buffer.alloc(48, 1),
        Buffer.alloc(48, 2),
        Buffer.alloc(48, 3),
        Buffer.alloc(32, 4),
        Buffer.alloc(32, 5),
        Buffer.alloc(48, 6),
        Buffer.alloc(32, 7),
      );
      assert.throws(
        () => assertImportable(db),
        (e: Error) =>
          e instanceof ImportRefused && /1 unstable blocks/.test(e.message),
      );
    } finally {
      db.close();
    }
  });

  it('refuses one another writer is holding', () => {
    const db = core(true);
    const other = new Sqlite(file);
    try {
      other.exec('BEGIN IMMEDIATE');
      assert.throws(
        () => assertImportable(db),
        (e: Error) =>
          e instanceof ImportRefused &&
          /open for writing elsewhere/.test(e.message),
      );
    } finally {
      other.exec('ROLLBACK');
      other.close();
      db.close();
    }
  });
});

describe('runImport', () => {
  let dir: string;
  let bandsDir: string;
  let duck: Database;
  let db: Sqlite.Database;
  let sourceDb: string;

  /** Two adjacent bands of 15 heights each, exported from one chain. */
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'parquet-l1-run-'));
    sourceDb = path.join(dir, 'source.db');
    bandsDir = path.join(dir, 'bands');
    const workDir = path.join(dir, 'work');
    await fsp.mkdir(bandsDir);
    await fsp.mkdir(workDir);
    await buildCoreDb(sourceDb, FIRST, 31);
    for (const [from, to] of [
      [FIRST, FIRST + 9],
      [FIRST + 10, FIRST + 19],
      [FIRST + 20, FIRST + 29],
    ]) {
      const out = await exportL1Band({
        coreDbPath: sourceDb,
        workDir,
        from,
        to,
      });
      await fsp.rename(out.dir, path.join(bandsDir, `l1-h${from}-${to}-t-0`));
      await fsp.rm(path.dirname(out.dir), { recursive: true, force: true });
    }
    const { Database } = await import('duckdb-async');
    duck = await Database.create(':memory:');
    db = emptyCore(path.join(dir, 'core.db'));
    db.prepare('INSERT INTO migrations (name) VALUES (?)').run(
      LEDGER_MIGRATION,
    );
  });

  afterEach(async () => {
    db?.close();
    await duck?.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const heights = () =>
    db
      .prepare('SELECT MIN(height), MAX(height) FROM stable_blocks')
      .raw()
      .get();

  it('imports a directory of bands in height order and records where it got to', async () => {
    const run = await runImport({ db, duck, bandsDir, log, batchRows: 9 });
    assert.deepEqual(
      run.outcomes.map((o) => [o.heightRange, o.result]),
      [
        [[FIRST, FIRST + 9], 'imported'],
        [[FIRST + 10, FIRST + 19], 'imported'],
        [[FIRST + 20, FIRST + 29], 'imported'],
      ],
    );
    assert.equal(run.haveTo, FIRST + 29);
    assert.deepEqual(heights(), [FIRST, FIRST + 29]);
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM parquet_l1_imports').pluck().get(),
      3,
    );
  });

  it('does nothing on a second run, and resumes after a partial one', async () => {
    const first = await runImport({
      db,
      duck,
      bandsDir,
      log,
      batchRows: 9,
      limit: 1,
    });
    assert.equal(first.outcomes.length, 1);
    assert.deepEqual(heights(), [FIRST, FIRST + 9]);

    const second = await runImport({ db, duck, bandsDir, log, batchRows: 9 });
    assert.deepEqual(
      second.outcomes.map((o) => o.heightRange),
      [
        [FIRST + 10, FIRST + 19],
        [FIRST + 20, FIRST + 29],
      ],
      'only the bands that were left',
    );
    assert.deepEqual(heights(), [FIRST, FIRST + 29]);

    const third = await runImport({ db, duck, bandsDir, log, batchRows: 9 });
    assert.deepEqual(third.outcomes, [], 'nothing left to do');
  });

  it('stops at a bad band, keeping what came before and leaving what comes after', async () => {
    // The middle band is refused, so the third must not be imported over
    // the hole it leaves: the block importer cannot cross a gap.
    const middle = path.join(bandsDir, `l1-h${FIRST + 10}-${FIRST + 19}-t-0`);
    const file = path.join(middle, 'band.json');
    const json = JSON.parse(await fsp.readFile(file, 'utf8'));
    json.tables.blocks.rowDigest = 'f'.repeat(64);
    await fsp.writeFile(file, JSON.stringify(json));

    const run = await runImport({ db, duck, bandsDir, log, batchRows: 9 });
    assert.deepEqual(
      run.outcomes.map((o) => [o.heightRange[0], o.result]),
      [
        [FIRST, 'imported'],
        [FIRST + 10, 'refused'],
      ],
      'the third band was never attempted',
    );
    assert.match(run.outcomes[1].reason ?? '', /do not reproduce the digest/);
    assert.deepEqual(heights(), [FIRST, FIRST + 9]);
    assert.equal(run.haveTo, FIRST + 9);
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM parquet_l1_imports').pluck().get(),
      1,
    );
  });

  it('re-imports a band a crash left part way, rather than skipping it', async () => {
    // Blocks are written before transactions and tags, so the first chunk
    // to commit carries every block of the band. The database's highest
    // height is then the band's top while most of its rows are missing.
    // Nothing may read that as "this band is done".
    const second = path.join(bandsDir, `l1-h${FIRST + 10}-${FIRST + 19}-t-0`);
    const file = path.join(second, 'band.json');
    const good = await fsp.readFile(file, 'utf8');
    const json = JSON.parse(good);
    // Fail on `transactions`. Blocks are written first and commit before
    // it, so the database's highest height becomes the band's top while
    // the band holds almost nothing — the state that must not be read as
    // "this band is done".
    json.tables.transactions.rowDigest = 'f'.repeat(64);
    await fsp.writeFile(file, JSON.stringify(json));

    // Commit often, so the failure lands after blocks are durable.
    const crashed = await runImport({
      db,
      duck,
      bandsDir,
      log,
      batchRows: 3,
      commitEvery: 5,
    });
    assert.equal(crashed.outcomes[1].result, 'refused');
    assert.equal(
      db.prepare('SELECT MAX(height) FROM stable_blocks').pluck().get(),
      FIRST + 19,
      "every block of the failed band is durable, so the database's top is the band's top",
    );
    const txs = db
      .prepare(
        'SELECT COUNT(*) FROM stable_transactions WHERE height BETWEEN ? AND ?',
      )
      .pluck()
      .get(FIRST + 10, FIRST + 19) as number;
    // Some of its transactions reached disk before it failed, but not all.

    // Put the band back as published and run again.
    await fsp.writeFile(file, good);
    const again = await runImport({ db, duck, bandsDir, log, batchRows: 9 });
    assert.ok(
      again.outcomes.some(
        (o) => o.heightRange[0] === FIRST + 10 && o.result === 'imported',
      ),
      'the half-imported band was imported again, not skipped',
    );
    const after = db
      .prepare(
        'SELECT COUNT(*) FROM stable_transactions WHERE height BETWEEN ? AND ?',
      )
      .pluck()
      .get(FIRST + 10, FIRST + 19) as number;
    assert.ok(
      after > txs,
      `the rest of its transactions are there now (${txs} -> ${after})`,
    );
    assert.deepEqual(heights(), [FIRST, FIRST + 29]);
  });

  it("replaces its height range, so a fork's leftovers do not survive", async () => {
    await runImport({ db, duck, bandsDir, log, batchRows: 9 });
    // A transaction at a height the band covers that the band never had:
    // what an orphaned fork, or an earlier band of another grid, leaves.
    const ghost = Buffer.alloc(32, 0xee);
    db.prepare(
      `INSERT INTO stable_transactions (id, height, block_transaction_index,
       format, last_tx, owner_address, quantity, reward, data_size, tag_count,
       indexed_at) VALUES (?, ?, 0, 2, ?, ?, '0', '0', 0, 0, 5)`,
    ).run(ghost, FIRST + 12, Buffer.alloc(32, 1), Buffer.alloc(32, 2));
    // As a crash would leave it: recorded, but not finished.
    db.prepare(
      'UPDATE parquet_l1_imports SET completed_at = NULL WHERE height_from = ?',
    ).run(FIRST + 10);

    await runImport({ db, duck, bandsDir, log, batchRows: 9 });

    assert.equal(
      db
        .prepare('SELECT COUNT(*) FROM stable_transactions WHERE id = ?')
        .pluck()
        .get(ghost),
      0,
      'the row the band does not contain is gone',
    );
  });

  it('imports the band that reaches furthest where two overlap', async () => {
    // A tip band inside a whole one, as a publisher offers while a range
    // fills. readBands sorts the shorter first, so the planner must drop
    // it rather than import both.
    const whole = path.join(bandsDir, `l1-h${FIRST}-${FIRST + 9}-t-0`);
    const tip = path.join(bandsDir, `l1-h${FIRST}-${FIRST + 4}-tip-0`);
    await fsp.cp(whole, tip, { recursive: true });
    const file = path.join(tip, 'band.json');
    const json = JSON.parse(await fsp.readFile(file, 'utf8'));
    json.heightRange = [FIRST, FIRST + 4];
    await fsp.writeFile(file, JSON.stringify(json));

    const { steps, skipped } = planImport(await readBands(bandsDir), {
      haveTo: -1,
      held: new Set(),
    });
    assert.deepEqual(
      steps.map((s) => s.band.heightRange[1]),
      [FIRST + 9, FIRST + 19, FIRST + 29],
      'the tip band was dropped in favour of the whole one',
    );
    assert.ok(skipped.some((b) => b.id.includes('tip')));
  });

  it('refuses a directory with no bands', async () => {
    const empty = path.join(dir, 'empty');
    await fsp.mkdir(empty);
    await assert.rejects(
      runImport({ db, duck, bandsDir: empty, log }),
      (e: Error) =>
        e instanceof ImportRefused && /holds no bands/.test(e.message),
    );
  });
});
