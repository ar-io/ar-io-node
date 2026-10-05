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
import type { Logger } from 'winston';
import {
  applyImportPragmas,
  assertDiskSpace,
  remainingHoles,
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

/** The test logger, with every `info` and `warn` kept for assertions. */
function spyLog(): {
  log: Logger;
  lines: Array<[string, Record<string, unknown>]>;
} {
  const lines: Array<[string, Record<string, unknown>]> = [];
  const spy = Object.create(log) as Logger;
  for (const level of ['info', 'warn'] as const) {
    spy[level] = ((message: string, meta: Record<string, unknown>) => {
      lines.push([message, meta ?? {}]);
      return log[level](message, meta);
    }) as Logger[typeof level];
  }
  return { log: spy, lines };
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
      skipped.map((s) => [s.band.id, s.reason]),
      [['a', 'already_imported']],
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

  it('carries on above a held band when a stale ledger row pulled haveTo down', () => {
    // A tip band was interrupted, then superseded by a wider one that
    // imported cleanly. The old row can never complete — nothing will
    // import that id again — so without this the planner reads the band
    // above as a gap and refuses every run from then on.
    const { steps } = planImport(
      [band('tip', 100, 149), band('wider', 100, 199), band('next', 200, 299)],
      { haveTo: 99, blocksTo: 199, held: new Set(['wider']) },
    );
    assert.deepEqual(
      steps.map((s) => s.id),
      ['next'],
    );
  });

  it('still refuses a ledger that outlived the database it describes', () => {
    // The same shape, but the blocks really are absent: an empty core.db
    // with a ledger left over. Trusting the ledger here would leave a
    // hole, so the gap must still be refused.
    assert.throws(
      () =>
        planImport([band('a', 0, 99), band('b', 100, 199)], {
          haveTo: -1,
          blocksTo: -1,
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
      skipped.map((s) => [s.band.id, s.reason]),
      [['a', 'already_imported']],
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
      skipped.map((s) => [s.band.id, s.reason]),
      [['tip', 'covered_by_a_wider_band']],
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

  it("takes indexed_at from the band's clock, not the importer's", async () => {
    // Two imports a second apart must leave the same rows, and a snapshot
    // comparison taken inside one second would not notice if they did
    // not. Assert the value against a band built long enough ago that the
    // wall clock could not produce it by chance.
    const built = '2026-01-02T03:04:05.000Z';
    await importBand(
      target,
      duck,
      { ...entry, band: { ...entry.band, createdAt: built } },
      { log, batchRows: 7 },
    );
    assert.deepEqual(
      target
        .prepare('SELECT DISTINCT indexed_at FROM stable_transactions')
        .pluck()
        .all(),
      [Date.parse(built) / 1000],
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

  it('forgets an unfinished row its own range has rewritten', async () => {
    // A tip band interrupted, then superseded by a wider one. Nothing
    // will ever import the old id again, so its row has to go with the
    // rewrite — otherwise it pulls `haveTo` below a band that has
    // landed, and every later run reads the band above as a gap.
    const [from, to] = entry.band.heightRange;
    target
      .prepare(
        `INSERT INTO parquet_l1_imports (band_id, height_from, height_to,
         band_digest, rows_imported, started_at, completed_at)
         VALUES ('an-older-tip', ?, ?, ?, NULL, 1, NULL)`,
      )
      .run(from, to - 5, Buffer.alloc(32));
    // One outside the range must survive: it describes heights this
    // band did not touch.
    target
      .prepare(
        `INSERT INTO parquet_l1_imports (band_id, height_from, height_to,
         band_digest, rows_imported, started_at, completed_at)
         VALUES ('elsewhere', ?, ?, ?, NULL, 1, NULL)`,
      )
      .run(to + 1, to + 10, Buffer.alloc(32));

    await importBand(target, duck, entry, { log, batchRows: 7 });

    assert.deepEqual(
      target
        .prepare(
          'SELECT band_id FROM parquet_l1_imports WHERE completed_at IS NULL ORDER BY band_id',
        )
        .pluck()
        .all(),
      ['elsewhere'],
      'the superseded row is gone; the one outside the range is not',
    );
    assert.equal(
      readProgress(target).haveTo,
      to,
      'so progress is no longer held below the band that landed',
    );
  });

  it('says where it is while a band is in flight', async () => {
    // A 100,000-height band takes twenty minutes. Without this an operator
    // watching a first import sees the plan, then nothing, then the result.
    const { log: spy, lines } = spyLog();
    let clock = 0;
    await importBand(target, duck, entry, {
      log: spy,
      batchRows: 7,
      progressEveryMs: 1,
      now: () => (clock += 1000),
    });
    const progress = lines.filter(([m]) => m === 'Importing a band');
    assert.ok(progress.length > 1, 'reported more than once');
    assert.deepEqual(
      [...new Set(progress.map(([, meta]) => meta.table))],
      ['wallets', 'blocks', 'transactions', 'block_transactions', 'tags'],
      'named each table as it reached it, in import order',
    );
    const last = progress.at(-1)?.[1] as { rows: number; ofRows: number };
    assert.ok(last.rows > 0 && last.rows <= last.ofRows);
    assert.equal(
      last.ofRows,
      Object.values(entry.band.tables).reduce((n, t) => n + t.rows, 0),
    );
  });

  it('stays quiet when progress is turned off', async () => {
    const { log: spy, lines } = spyLog();
    await importBand(target, duck, entry, {
      log: spy,
      batchRows: 7,
      progressEveryMs: 0,
    });
    assert.equal(lines.filter(([m]) => m === 'Importing a band').length, 0);
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
  let dir: string;

  const TABLES = Object.fromEntries(
    ['blocks', 'block_transactions', 'transactions', 'tags', 'wallets'].map(
      (t) => [t, { rows: 0, rowDigest: '0'.repeat(64) }],
    ),
  );

  /** Writes a band directory, whose name need not match what is inside it. */
  const write = async (
    id: string,
    heightRange: [number, number],
  ): Promise<void> => {
    await fsp.mkdir(path.join(dir, id), { recursive: true });
    await fsp.writeFile(
      path.join(dir, id, 'band.json'),
      JSON.stringify({
        version: 1,
        schema: 'l1-1',
        heightRange,
        tables: TABLES,
        createdAt: '2026-10-04T00:00:00Z',
      }),
    );
  };

  const id = (from: number, to: number) =>
    `l1-h${from}-${to}-f5b1208c-${'a'.repeat(12)}`;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'parquet-l1-bands-'));
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('reads a directory of bands lowest first, ignoring what has no band file', async () => {
    await write(id(100_000, 199_999), [100_000, 199_999]);
    await write(id(0, 99_999), [0, 99_999]);
    await fsp.mkdir(path.join(dir, id(200_000, 299_999)));
    assert.deepEqual(
      (await readBands(dir)).map((b) => b.band.heightRange),
      [
        [0, 99_999],
        [100_000, 199_999],
      ],
    );
  });

  it('passes over a directory whose name is not a band id', async () => {
    await write(id(0, 99_999), [0, 99_999]);
    await write('not-a-band', [100_000, 199_999]);
    await write('l1-h100000-199999-nothex!!-aaaaaaaaaaaa', [100_000, 199_999]);
    assert.deepEqual(
      (await readBands(dir)).map((b) => b.id),
      [id(0, 99_999)],
    );
  });

  it('passes over a band whose name disagrees with the heights inside it', async () => {
    // The name is the ledger's key. A band recorded under heights it does
    // not hold would leave the planner certain of a range nothing filled.
    await write(id(0, 99_999), [0, 99_999]);
    await write(id(100_000, 199_999), [100_000, 149_999]);
    assert.deepEqual(
      (await readBands(dir)).map((b) => b.id),
      [id(0, 99_999)],
    );
  });

  it('passes over an unreadable band file rather than failing the run', async () => {
    await write(id(0, 99_999), [0, 99_999]);
    await fsp.mkdir(path.join(dir, id(100_000, 199_999)));
    await fsp.writeFile(
      path.join(dir, id(100_000, 199_999), 'band.json'),
      '{ not json',
    );
    assert.deepEqual(
      (await readBands(dir)).map((b) => b.id),
      [id(0, 99_999)],
    );
  });

  it('accepts a tip band, which ends short of a whole range', async () => {
    await write(id(2_010_000, 2_014_135), [2_010_000, 2_014_135]);
    assert.equal((await readBands(dir)).length, 1);
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
          e instanceof ImportRefused && /1 unstable rows/.test(e.message),
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
          e instanceof ImportRefused && /open elsewhere/.test(e.message),
      );
    } finally {
      other.exec('ROLLBACK');
      other.close();
      db.close();
    }
  });
});

describe('planImport backfilling below what is held', () => {
  const held = new Set<string>();

  it('fills in the history beneath a gateway that began mid-chain', () => {
    // The case this exists for: 20% of the chain near the tip and
    // nothing underneath. Without --from every band below is skipped as
    // `below_what_core_db_holds` and the hole is permanent.
    const bands = [
      band('a', 0, 99),
      band('b', 100, 199),
      band('c', 200, 299),
      band('d', 300, 399),
    ];
    const atTop = planImport(bands, { haveTo: 299, blocksTo: 299, held });
    assert.deepEqual(
      atTop.steps.map((s) => s.id),
      ['d'],
      'by default it only ever continues upward',
    );

    const backfill = planImport(bands, {
      haveTo: 299,
      blocksTo: 299,
      held,
      from: 0,
      to: 199,
    });
    assert.deepEqual(
      backfill.steps.map((s) => s.id),
      ['a', 'b'],
      'and with --from/--to it fills exactly the gap beneath',
    );
    assert.deepEqual(
      backfill.skipped
        .filter((s) => s.reason === 'above_the_requested_range')
        .map((s) => s.band.id),
      ['c', 'd'],
    );
  });

  it('still refuses a gap inside the run itself', () => {
    assert.throws(
      () =>
        planImport([band('a', 0, 99), band('c', 200, 299)], {
          haveTo: 299,
          blocksTo: 299,
          held,
          from: 0,
        }),
      (e: Error) =>
        e instanceof ImportRefused && /No band covers/.test(e.message),
    );
  });
});

describe('remainingHoles', () => {
  it('finds nothing when the run meets what is held', () => {
    assert.deepEqual(remainingHoles([200, 299], [[0, 199]]), []);
  });

  it('finds nothing for a fresh database filled from the bottom', () => {
    assert.deepEqual(
      remainingHoles(undefined, [
        [0, 99],
        [100, 199],
      ]),
      [],
    );
  });

  it('finds the gap a staged backfill leaves behind', () => {
    // Importing 0-99 under a gateway holding 200+ leaves 100-199
    // missing, and the block importer rewinds across it.
    assert.deepEqual(remainingHoles([200, 299], [[0, 99]]), [[100, 199]]);
  });

  it('finds a gap above what is held', () => {
    assert.deepEqual(remainingHoles([0, 99], [[200, 299]]), [[100, 199]]);
  });

  it('is not confused by overlap, which a band rewriting its range causes', () => {
    assert.deepEqual(remainingHoles([150, 299], [[0, 199]]), []);
  });

  it('is not confused by a range wholly inside another', () => {
    // The reach has to be the furthest seen, not the last seen, or a
    // contained range makes everything after it look like a gap.
    assert.deepEqual(
      remainingHoles(
        [0, 500],
        [
          [100, 200],
          [450, 600],
        ],
      ),
      [],
    );
  });

  it('reports several gaps, lowest first', () => {
    assert.deepEqual(
      remainingHoles(
        [500, 599],
        [
          [0, 99],
          [200, 299],
        ],
      ),
      [
        [100, 199],
        [300, 499],
      ],
    );
  });
});

describe('applyImportPragmas', () => {
  let dir: string;
  let db: Sqlite.Database;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'parquet-l1-pragma-'));
    db = emptyCore(path.join(dir, 'core.db'));
  });
  afterEach(async () => {
    db?.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const read = (name: string) =>
    db.pragma(name, { simple: true }) as number | string;

  it("gives the load a page cache measured in MiB, not SQLite's 2 MB default", () => {
    // The whole point: a negative cache_size is KiB, and the default is
    // what makes a long import decay as the indexes stop fitting.
    applyImportPragmas(db, 512);
    assert.equal(read('cache_size'), -512 * 1024);
  });

  it('keeps WAL and relaxes synchronous to NORMAL', () => {
    applyImportPragmas(db, 1);
    assert.equal(String(read('journal_mode')).toLowerCase(), 'wal');
    assert.equal(read('synchronous'), 1, 'NORMAL');
  });

  it('leaves temp_store alone, so a later sort is not forced into memory', () => {
    // A CREATE INDEX over the 305M-row tag table would try to sort in
    // RAM if this were set to MEMORY. An import does not sort, so there
    // is nothing to gain and a trap to avoid.
    const before = read('temp_store');
    applyImportPragmas(db, 1);
    assert.equal(read('temp_store'), before);
  });
});

describe('assertDiskSpace', () => {
  const rows = (n: number) =>
    ({
      id: 'x',
      dir: '/x',
      band: {
        heightRange: [0, 99],
        tables: { blocks: { rows: n, rowDigest: '' } },
      },
    }) as unknown as ImportableBand;

  const free = (bytes: number) => async () => ({ bsize: 1, bavail: bytes });

  it('lets a run through when the filesystem has room for it', async () => {
    await assertDiskSpace('/x/core.db', [rows(1_000_000)], {
      log,
      statfs: free(1_000_000 * 300 + 4 * 1024 ** 3),
      headroom: 4 * 1024 ** 3,
    });
  });

  it('refuses before the first band rather than part way through the largest', async () => {
    // ENOSPC inside a write transaction is the one failure that leaves an
    // operator with a database to repair instead of a run to restart.
    await assert.rejects(
      assertDiskSpace('/x/core.db', [rows(46_600_000)], {
        log,
        statfs: free(10 * 1024 ** 3),
      }),
      (e: Error) =>
        e instanceof ImportRefused &&
        /10\.0 GiB free/.test(e.message) &&
        /46,600,000 rows/.test(e.message) &&
        /--max-bands/.test(e.message),
    );
  });

  it('imports rather than refusing when free space cannot be read', async () => {
    const { log: spy, lines } = spyLog();
    await assertDiskSpace('/x/core.db', [rows(46_600_000)], {
      log: spy,
      statfs: async () => {
        throw new Error('ENOSYS');
      },
    });
    assert.ok(lines.some(([m]) => /Could not read free space/.test(m)));
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
      await fsp.rename(
        out.dir,
        path.join(bandsDir, `l1-h${from}-${to}-f5b1208c-${'0'.repeat(12)}`),
      );
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
    const middle = path.join(
      bandsDir,
      `l1-h${FIRST + 10}-${FIRST + 19}-f5b1208c-${'0'.repeat(12)}`,
    );
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
    const second = path.join(
      bandsDir,
      `l1-h${FIRST + 10}-${FIRST + 19}-f5b1208c-${'0'.repeat(12)}`,
    );
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
    const { log: spy, lines } = spyLog();
    const again = await runImport({
      db,
      duck,
      bandsDir,
      log: spy,
      batchRows: 9,
    });
    const warned = lines.find(([m]) => /left a band unfinished/.test(m));
    assert.ok(warned, 'the run said an earlier one was interrupted');
    assert.deepEqual(warned?.[1].bands, [path.basename(second)]);
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
    const whole = path.join(
      bandsDir,
      `l1-h${FIRST}-${FIRST + 9}-f5b1208c-${'0'.repeat(12)}`,
    );
    const tip = path.join(
      bandsDir,
      `l1-h${FIRST}-${FIRST + 4}-f5b1208c-${'1'.repeat(12)}`,
    );
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
    assert.deepEqual(
      skipped.map((s) => [s.band.band.heightRange, s.reason]),
      [[[FIRST, FIRST + 4], 'covered_by_a_wider_band']],
    );
  });

  it('refuses a run the filesystem has no room for, before reading a band', async () => {
    await assert.rejects(
      runImport({
        db,
        duck,
        bandsDir,
        log,
        disk: {
          statfs: async () => ({ bsize: 1, bavail: 0 }),
          headroom: 1,
          bytesPerRow: 1,
        },
      }),
      (e: Error) =>
        e instanceof ImportRefused && /free where core.db/.test(e.message),
    );
    assert.deepEqual(
      heights(),
      [null, null],
      'nothing was written before the refusal',
    );
  });

  it('measures only the bands this run will import, so --max-bands is a way out', async () => {
    // The same filesystem that cannot hold three bands can hold one.
    const band1Rows = Object.values(
      (await readBands(bandsDir))[0].band.tables,
    ).reduce((n, t) => n + t.rows, 0);
    const run = await runImport({
      db,
      duck,
      bandsDir,
      log,
      limit: 1,
      disk: {
        statfs: async () => ({ bsize: 1, bavail: band1Rows + 1 }),
        headroom: 1,
        bytesPerRow: 1,
      },
    });
    assert.equal(run.outcomes.length, 1);
    assert.equal(run.haveTo, FIRST + 9);
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
