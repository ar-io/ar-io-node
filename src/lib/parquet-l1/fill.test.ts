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
  CLEAR_SQL,
  fillCeiling,
  fillLedgerKey,
  ImportableBand,
  importBand,
  LEDGER_MIGRATION,
  mergeRanges,
  missingRanges,
  planFill,
  readBands,
  runFill,
} from './import.js';

const log = createTestLogger({ suite: 'parquet-l1 fill' });
const FIRST = 1_900_000;

const band = (id: string, from: number, to: number): ImportableBand => ({
  id,
  dir: `/x/${id}`,
  band: { heightRange: [from, to], tables: {} } as never,
});

/** An empty core.db as a migrated gateway has it. */
function emptyCore(file: string): Sqlite.Database {
  const db = new Sqlite(file);
  db.exec(fs.readFileSync('test/core-schema.sql', 'utf8'));
  db.exec(fs.readFileSync(`migrations/${LEDGER_MIGRATION}`, 'utf8'));
  db.prepare('INSERT INTO migrations (name) VALUES (?)').run(LEDGER_MIGRATION);
  return db;
}

/** A block the gateway's own importer holds near the tip. */
function newBlock(db: Sqlite.Database, height: number): void {
  db.prepare(
    `INSERT INTO new_blocks (indep_hash, height, nonce, hash, block_timestamp,
       diff, last_retarget, reward_pool, block_size, weave_size, tx_count,
       missing_tx_count)
     VALUES (?, ?, x'00', x'00', 0, '0', 0, '0', 0, 0, 0, 0)`,
  ).run(Buffer.from(`new-${height}`), height);
}

describe('mergeRanges', () => {
  it('merges ranges that overlap or touch, lowest first', () => {
    assert.deepEqual(
      mergeRanges([
        [20, 29],
        [0, 9],
        [10, 12],
        [25, 40],
        [50, 50],
      ]),
      [
        [0, 12],
        [20, 40],
        [50, 50],
      ],
    );
  });

  it('drops an empty range', () => {
    assert.deepEqual(mergeRanges([[5, 4]]), []);
  });
});

describe('missingRanges', () => {
  it('finds what lies below, between and above what is held', () => {
    assert.deepEqual(
      missingRanges(
        [
          [10, 19],
          [30, 39],
        ],
        0,
        49,
      ),
      [
        [0, 9],
        [20, 29],
        [40, 49],
      ],
    );
  });

  it('finds nothing when what is held covers the span', () => {
    assert.deepEqual(missingRanges([[0, 99]], 10, 20), []);
  });

  it('finds nothing in an empty span', () => {
    assert.deepEqual(missingRanges([], 10, 9), []);
  });
});

describe('planFill', () => {
  const bands = [band('a', 0, 99), band('b', 100, 199), band('c', 200, 299)];

  it('fills the history beneath a gateway that began mid-chain', () => {
    const { steps, uncovered } = planFill(bands, {
      held: [[200, 450]],
      ceiling: 450,
    });
    assert.deepEqual(
      steps.map((s) => [s.band.id, s.heights]),
      [
        ['a', [0, 99]],
        ['b', [100, 199]],
      ],
    );
    assert.deepEqual(uncovered, []);
  });

  it('writes only the part of a band below where the gateway began', () => {
    const { steps } = planFill(bands, { held: [[150, 450]], ceiling: 450 });
    assert.deepEqual(
      steps.map((s) => [s.band.id, s.heights]),
      [
        ['a', [0, 99]],
        ['b', [100, 149]],
      ],
    );
  });

  it('fills a hole inside what the gateway holds, and nothing else', () => {
    const { steps } = planFill(bands, {
      held: [
        [0, 49],
        [60, 450],
      ],
      ceiling: 450,
    });
    assert.deepEqual(
      steps.map((s) => [s.band.id, s.heights]),
      [['a', [50, 59]]],
    );
  });

  it('never plans a height above the ceiling', () => {
    const { steps, uncovered } = planFill(bands, {
      held: [[0, 99]],
      ceiling: 99,
    });
    assert.deepEqual(steps, []);
    assert.deepEqual(uncovered, []);
  });

  it('fills a tip band only as far as the blocks it holds', () => {
    const { steps, uncovered } = planFill(
      [band('whole', 0, 199), band('tip', 200, 249)],
      { held: [[300, 450]], ceiling: 450, top: new Map([['tip', 230]]) },
    );
    assert.deepEqual(
      steps.map((s) => [s.band.id, s.heights]),
      [
        ['whole', [0, 199]],
        ['tip', [200, 230]],
      ],
    );
    // What the publisher's next tip band will hold.
    assert.deepEqual(uncovered, [[231, 299]]);
  });

  it('redoes a range a run left unfinished, though its blocks are there', () => {
    const { steps } = planFill(bands, {
      held: [[0, 450]],
      ceiling: 450,
      redo: [[100, 199]],
    });
    assert.deepEqual(
      steps.map((s) => [s.band.id, s.heights]),
      [['b', [100, 199]]],
    );
  });

  it('redoes only the part of an unfinished range at or below the ceiling', () => {
    const { steps } = planFill(bands, {
      held: [[0, 450]],
      ceiling: 150,
      redo: [[100, 199]],
    });
    assert.deepEqual(
      steps.map((s) => [s.band.id, s.heights]),
      [['b', [100, 150]]],
    );
  });

  it('takes the wider of two bands that cover the same heights', () => {
    const { steps } = planFill([band('tip', 0, 49), band('whole', 0, 99)], {
      held: [[100, 200]],
      ceiling: 200,
    });
    assert.deepEqual(
      steps.map((s) => [s.band.id, s.heights]),
      [['whole', [0, 99]]],
    );
  });

  it('keeps to --from and --to', () => {
    const { steps } = planFill(bands, {
      held: [[250, 450]],
      ceiling: 450,
      from: 50,
      to: 120,
    });
    assert.deepEqual(
      steps.map((s) => [s.band.id, s.heights]),
      [
        ['a', [50, 99]],
        ['b', [100, 120]],
      ],
    );
  });

  it('reports what no band holds yet', () => {
    const { steps, uncovered } = planFill([band('a', 0, 99)], {
      held: [[300, 450]],
      ceiling: 450,
    });
    assert.deepEqual(
      steps.map((s) => s.heights),
      [[0, 99]],
    );
    assert.deepEqual(uncovered, [[100, 299]]);
  });

  it('plans nothing beneath a gateway that holds no blocks', () => {
    assert.deepEqual(planFill(bands, { held: [], ceiling: -1 }), {
      steps: [],
      uncovered: [],
    });
  });
});

describe('fillLedgerKey', () => {
  it("is the band's id when the whole band was filled", () => {
    assert.equal(
      fillLedgerKey({ band: band('a', 0, 99), heights: [0, 99] }),
      'a',
    );
  });

  it('carries the heights when only part was', () => {
    assert.equal(
      fillLedgerKey({ band: band('a', 0, 99), heights: [50, 59] }),
      'a@50-59',
    );
  });
});

describe('CLEAR_SQL', () => {
  it('reaches every row through an index, never a scan of a table', () => {
    // Online, each runs once per window of heights. A scan of the tag
    // table there read every tag the gateway held, hundreds of times a
    // band: the first live fill spent 252 s of 285 clearing a hole.
    const db = new Sqlite(':memory:');
    try {
      db.exec(fs.readFileSync('test/core-schema.sql', 'utf8'));
      for (const [name, sql] of Object.entries(CLEAR_SQL)) {
        const plan = (
          db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1, 2) as Array<{
            detail: string;
          }>
        ).map((row) => row.detail);
        assert.ok(
          !plan.some((step) => /^SCAN/.test(step)),
          `${name}: ${plan.join('; ')}`,
        );
      }
    } finally {
      db.close();
    }
  });
});

describe('fillCeiling', () => {
  let dir: string;
  let db: Sqlite.Database;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'parquet-l1-ceiling-'));
    db = emptyCore(path.join(dir, 'core.db'));
  });

  afterEach(async () => {
    db.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('is -1 for a gateway that holds no blocks', () => {
    assert.equal(fillCeiling(db), -1);
  });

  it('is just below where a gateway that has not flushed yet began', () => {
    newBlock(db, 500);
    newBlock(db, 501);
    assert.equal(fillCeiling(db), 499);
  });

  it('is the top of stable_blocks once the gateway has flushed', async () => {
    db.close();
    await buildCoreDb(path.join(dir, 'held.db'), FIRST, 10);
    db = new Sqlite(path.join(dir, 'held.db'));
    newBlock(db, FIRST + 10);
    assert.equal(fillCeiling(db), FIRST + 9);
  });
});

describe('runFill', () => {
  let dir: string;
  let bandsDir: string;
  let sourceDb: string;
  let duck: Database;
  let db: Sqlite.Database;
  let bands: ImportableBand[];

  /** Three adjacent bands of 10 heights each, exported from one chain. */
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'parquet-l1-fill-'));
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
    bands = await readBands(bandsDir);
    const { Database } = await import('duckdb-async');
    duck = await Database.create(':memory:');
    db = emptyCore(path.join(dir, 'core.db'));
  });

  afterEach(async () => {
    db?.close();
    await duck?.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  /** Rows per table at the bands' heights. */
  const counts = (handle: Sqlite.Database) => ({
    blocks: handle
      .prepare(
        'SELECT COUNT(*) FROM stable_blocks WHERE height BETWEEN ? AND ?',
      )
      .pluck()
      .get(FIRST, FIRST + 29),
    transactions: handle
      .prepare(
        'SELECT COUNT(*) FROM stable_transactions WHERE height BETWEEN ? AND ?',
      )
      .pluck()
      .get(FIRST, FIRST + 29),
    tags: handle
      .prepare(
        'SELECT COUNT(*) FROM stable_transaction_tags WHERE height BETWEEN ? AND ?',
      )
      .pluck()
      .get(FIRST, FIRST + 29),
    links: handle
      .prepare(
        `SELECT COUNT(*) FROM stable_block_transactions WHERE block_indep_hash IN
           (SELECT indep_hash FROM stable_blocks WHERE height BETWEEN ? AND ?)`,
      )
      .pluck()
      .get(FIRST, FIRST + 29),
  });

  const sourceTxs = (from: number, to: number) => {
    const handle = new Sqlite(sourceDb, { readonly: true });
    try {
      return handle
        .prepare(
          'SELECT COUNT(*) FROM stable_transactions WHERE height BETWEEN ? AND ?',
        )
        .pluck()
        .get(from, to);
    } finally {
      handle.close();
    }
  };

  const source = () => {
    const handle = new Sqlite(sourceDb, { readonly: true });
    try {
      return counts(handle);
    } finally {
      handle.close();
    }
  };

  /**
   * Gives the gateway the heights `[from, to]` as its own: imported, then
   * marked, so a test can tell whether a fill rewrote them.
   */
  const gatewayHolds = async (from: number, to: number) => {
    for (const entry of bands) {
      const [a, b] = entry.band.heightRange;
      const start = Math.max(a, from);
      const end = Math.min(b, to);
      if (start > end) continue;
      await importBand(db, duck, entry, {
        log,
        heights: [start, end],
        ledgerKey: `gateway-${start}`,
      });
    }
    db.prepare('DELETE FROM parquet_l1_imports').run();
    db.prepare(
      'UPDATE stable_transactions SET indexed_at = 42 WHERE height BETWEEN ? AND ?',
    ).run(from, to);
  };

  const marked = (from: number, to: number) =>
    db
      .prepare(
        'SELECT COUNT(*) FROM stable_transactions WHERE indexed_at = 42 AND height BETWEEN ? AND ?',
      )
      .pluck()
      .get(from, to) as number;

  const removeHeights = (from: number, to: number) => {
    db.prepare(
      `DELETE FROM stable_block_transactions WHERE block_indep_hash IN
         (SELECT indep_hash FROM stable_blocks WHERE height BETWEEN ? AND ?)`,
    ).run(from, to);
    for (const table of [
      'stable_transaction_tags',
      'stable_transactions',
      'missing_transactions',
      'stable_blocks',
    ]) {
      db.prepare(`DELETE FROM ${table} WHERE height BETWEEN ? AND ?`).run(
        from,
        to,
      );
    }
  };

  it('fills beneath a gateway that began mid-chain, leaving its own rows alone', async () => {
    await gatewayHolds(FIRST + 20, FIRST + 29);
    const before = marked(FIRST + 20, FIRST + 29);
    assert.ok(before > 0);

    const run = await runFill({ db, duck, bandsDir, log, batchRows: 4 });

    assert.equal(run.ceiling, FIRST + 29);
    assert.deepEqual(
      run.outcomes.map((o) => [o.heights, o.result]),
      [
        [[FIRST, FIRST + 9], 'imported'],
        [[FIRST + 10, FIRST + 19], 'imported'],
      ],
    );
    // The test's chain starts at FIRST; a real one has bands from 0.
    assert.deepEqual(run.uncovered, [[0, FIRST - 1]]);
    assert.deepEqual(counts(db), source());
    assert.equal(marked(FIRST + 20, FIRST + 29), before);
    // Whole bands are recorded under their own ids.
    assert.deepEqual(
      db
        .prepare(
          'SELECT band_id FROM parquet_l1_imports WHERE completed_at IS NOT NULL ORDER BY height_from',
        )
        .pluck()
        .all(),
      bands.slice(0, 2).map((b) => b.id),
    );
  });

  it('writes only the part of a band below where the gateway began', async () => {
    await gatewayHolds(FIRST + 15, FIRST + 29);
    const before = marked(FIRST + 15, FIRST + 29);

    const run = await runFill({ db, duck, bandsDir, log, batchRows: 4 });

    assert.deepEqual(
      run.outcomes.map((o) => o.heights),
      [
        [FIRST, FIRST + 9],
        [FIRST + 10, FIRST + 14],
      ],
    );
    assert.deepEqual(counts(db), source());
    assert.equal(marked(FIRST + 15, FIRST + 29), before);
    assert.ok(
      db
        .prepare('SELECT 1 FROM parquet_l1_imports WHERE band_id = ?')
        .pluck()
        .get(`${bands[1].id}@${FIRST + 10}-${FIRST + 14}`),
    );
  });

  it('fills a hole inside what the gateway holds', async () => {
    await gatewayHolds(FIRST, FIRST + 29);
    removeHeights(FIRST + 12, FIRST + 13);

    const run = await runFill({ db, duck, bandsDir, log, batchRows: 4 });

    assert.deepEqual(
      run.outcomes.map((o) => o.heights),
      [[FIRST + 12, FIRST + 13]],
    );
    assert.deepEqual(counts(db), source());
    // Only the hole was written: everything around it is still the
    // gateway's, and nothing in it is.
    assert.equal(
      marked(FIRST, FIRST + 29),
      (counts(db).transactions as number) -
        (sourceTxs(FIRST + 12, FIRST + 13) as number),
    );
    assert.equal(marked(FIRST + 12, FIRST + 13), 0);
  });

  it('writes nothing when nothing is missing', async () => {
    await gatewayHolds(FIRST, FIRST + 29);
    const run = await runFill({ db, duck, bandsDir, log });
    assert.deepEqual(run.outcomes, []);
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM parquet_l1_imports').pluck().get(),
      0,
    );
  });

  it('fills nothing beneath a gateway that holds no blocks yet', async () => {
    const run = await runFill({ db, duck, bandsDir, log });
    assert.equal(run.ceiling, -1);
    assert.deepEqual(run.outcomes, []);
  });

  it('treats a missing band directory as no bands yet', async () => {
    await gatewayHolds(FIRST + 20, FIRST + 29);
    const run = await runFill({
      db,
      duck,
      bandsDir: path.join(dir, 'not-there'),
      log,
    });
    assert.deepEqual(run.outcomes, []);
    assert.deepEqual(run.uncovered, [[0, FIRST + 19]]);
  });

  it('fills beneath a gateway that has only unflushed blocks', async () => {
    newBlock(db, FIRST + 30);
    const run = await runFill({ db, duck, bandsDir, log, batchRows: 4 });
    assert.equal(run.ceiling, FIRST + 29);
    assert.equal(run.outcomes.length, 3);
    assert.deepEqual(counts(db), source());
  });

  it('redoes a range a run left unfinished, and settles its ledger row', async () => {
    await gatewayHolds(FIRST, FIRST + 29);
    // A crash part way: the blocks are there, the transactions not.
    db.prepare(
      'DELETE FROM stable_transaction_tags WHERE height BETWEEN ? AND ?',
    ).run(FIRST + 10, FIRST + 19);
    db.prepare(
      'DELETE FROM stable_transactions WHERE height BETWEEN ? AND ?',
    ).run(FIRST + 10, FIRST + 19);
    db.prepare(
      `INSERT INTO parquet_l1_imports (band_id, height_from, height_to,
         band_digest, started_at) VALUES ('crashed', ?, ?, x'00', 0)`,
    ).run(FIRST + 10, FIRST + 19);

    const run = await runFill({ db, duck, bandsDir, log, batchRows: 4 });

    assert.deepEqual(
      run.outcomes.map((o) => o.heights),
      [[FIRST + 10, FIRST + 19]],
    );
    assert.deepEqual(counts(db), source());
    assert.equal(
      db
        .prepare(
          'SELECT COUNT(*) FROM parquet_l1_imports WHERE completed_at IS NULL',
        )
        .pluck()
        .get(),
      0,
    );
    // And the next run has nothing to do.
    const again = await runFill({ db, duck, bandsDir, log });
    assert.deepEqual(again.outcomes, []);
  });

  it('never holds the write lock while it waits, so a gateway writing alongside gets in', async () => {
    await gatewayHolds(FIRST + 20, FIRST + 29);
    // Another connection, as the gateway's writer is, with a short busy
    // timeout. It shares this thread, so it can only run while the fill
    // awaits: if the fill held a transaction across an await, the writer
    // would wait out its timeout and fail.
    const gateway = new Sqlite(path.join(dir, 'core.db'), { timeout: 200 });
    let writes = 0;
    const failures: string[] = [];
    let height = FIRST + 100;
    const timer = setInterval(() => {
      try {
        newBlock(gateway, height);
        height += 1;
        writes += 1;
      } catch (error) {
        failures.push((error as Error).message);
      }
    }, 1);
    try {
      await runFill({ db, duck, bandsDir, log, batchRows: 3, yieldMs: 2 });
    } finally {
      clearInterval(timer);
      gateway.close();
    }
    assert.deepEqual(failures, []);
    assert.ok(writes > 0, 'the writer never got a turn');
    assert.deepEqual(counts(db), source());
  });
});
