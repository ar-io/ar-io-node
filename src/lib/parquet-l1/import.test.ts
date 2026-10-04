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
  bandDigest,
  ImportableBand,
  importBand,
  ImportRefused,
  planImport,
  readBands,
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

  it('leaves core.db untouched when a band fails part way', async () => {
    const before = counts(target);
    // A band whose tags claim a row count their rows do not reach.
    const lying = {
      ...entry,
      band: { ...entry.band, tables: { ...entry.band.tables } },
    };
    lying.band.tables.tags = { ...lying.band.tables.tags, rows: 99_999 };
    await assert.rejects(
      importBand(target, duck, lying, { log, batchRows: 7 }),
    );
    assert.deepEqual(counts(target), before, 'nothing was left behind');
    assert.equal(
      target.prepare('SELECT COUNT(*) FROM parquet_l1_imports').pluck().get(),
      0,
      'and no ledger row',
    );
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
