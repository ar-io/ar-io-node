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
import { afterEach, beforeEach, describe, it } from 'node:test';
import Sqlite from 'better-sqlite3';

import type { L2ImportJob } from './import-clickhouse.js';
import {
  assertL2LedgerMigrated,
  L2_LEDGER_MIGRATION,
  L2LedgerRefused,
  readLedger,
  recordNothingToWrite,
  recordQueued,
  reconcileJobs,
} from './import-ledger.js';

const SCHEMA = await fs.readFile(
  new URL('../../../test/bundles-schema.sql', import.meta.url),
  'utf8',
);

const counts = {
  bandRows: 10,
  otherPlacements: 1,
  aboveCeiling: 0,
  present: 2,
  conflicting: 1,
  elsewhere: 1,
  written: 6,
  unlocated: 1,
  tags: 12,
  blocks: 3,
};

const jobFor = (bandId: string, job: string): L2ImportJob => ({
  version: 1,
  kind: 'parquet-l2-import',
  job,
  bandId,
  bandDigest: 'ab'.repeat(32),
  index: 'ardrive-l2',
  publisher: 'publisher-wallet',
  indexedAt: 1_790_000_000,
  heightRange: [100, 199],
  partitions: ['height=100-199'],
  counts,
  conflictExamples: [],
  createdAt: '2026-10-28T00:00:00.000Z',
});

function ledgerDb(migrated = true): Sqlite.Database {
  const db = new Sqlite(':memory:');
  db.exec(SCHEMA);
  db.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY)');
  if (migrated) {
    db.prepare('INSERT INTO migrations VALUES (?)').run(L2_LEDGER_MIGRATION);
  }
  return db;
}

describe('L2 import ledger', () => {
  let jobsDir: string;
  beforeEach(async () => {
    jobsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'l2-ledger-'));
  });
  afterEach(async () => {
    await fs.rm(jobsDir, { recursive: true, force: true });
  });

  it('refuses a bundles.db that has not run the migration', () => {
    assert.throws(
      () => assertL2LedgerMigrated(ledgerDb(false)),
      L2LedgerRefused,
    );
    assertL2LedgerMigrated(ledgerDb());
  });

  it('records a queued job, then a band with nothing left to write', () => {
    const db = ledgerDb();
    recordQueued(db, {
      target: 'clickhouse',
      job: jobFor('band-a', 'job-a'),
      accepted: ['--max-unchecked=2'],
      startedAt: 1,
      queuedAt: 2,
    });
    const row = readLedger(db, 'clickhouse').get('band-a');
    assert.ok(row !== undefined);
    assert.equal(row.job, 'job-a');
    assert.equal(row.completedAt, null);
    assert.deepEqual([row.heightFrom, row.heightTo], [100, 199]);
    const stored = db
      .prepare(
        'SELECT rows_imported, rows_present, rows_elsewhere, rows_conflicting, rows_unlocated, accepted FROM parquet_l2_imports',
      )
      .get();
    assert.deepEqual(stored, {
      rows_imported: 6,
      rows_present: 2,
      rows_elsewhere: 1,
      rows_conflicting: 1,
      rows_unlocated: 1,
      accepted: '["--max-unchecked=2"]',
    });
    assert.equal(readLedger(db, 'sqlite').size, 0, 'per target');

    recordNothingToWrite(db, {
      target: 'clickhouse',
      bandId: 'band-a',
      index: 'ardrive-l2',
      publisher: 'publisher-wallet',
      heightRange: [100, 199],
      bandDigest: Buffer.alloc(32, 1),
      counts: { ...counts, written: 0, present: 8, conflicting: 3 },
      accepted: [],
      startedAt: 3,
      completedAt: 4,
    });
    const again = readLedger(db, 'clickhouse').get('band-a');
    assert.equal(again?.job, null);
    assert.equal(again?.completedAt, 4);
    assert.deepEqual(
      db
        .prepare(
          'SELECT rows_imported, rows_present, rows_conflicting FROM parquet_l2_imports',
        )
        .get(),
      { rows_imported: 0, rows_present: 8, rows_conflicting: 3 },
    );
  });

  it("reads auto-import's outcome back into the ledger", async () => {
    const db = ledgerDb();
    for (const band of ['loaded', 'failed', 'waiting', 'vanished']) {
      recordQueued(db, {
        target: 'clickhouse',
        job: jobFor(band, `job-${band}`),
        accepted: [],
        startedAt: 1,
        queuedAt: 2,
      });
    }
    await fs.mkdir(path.join(jobsDir, 'done', 'job-loaded'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(jobsDir, 'done', 'job-loaded', 'loaded.json'),
      '{}',
    );
    await fs.mkdir(path.join(jobsDir, 'failed', 'job-failed'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(jobsDir, 'failed', 'job-failed', 'failed.txt'),
      'clickhouse-import failed on height=100-199, attempt 3 of 3\n',
    );
    await fs.mkdir(path.join(jobsDir, 'queue', 'job-waiting'), {
      recursive: true,
    });

    const result = await reconcileJobs(db, jobsDir, () => 99);
    assert.deepEqual(result.loaded, ['job-loaded']);
    assert.deepEqual(result.waiting, ['job-waiting']);
    assert.deepEqual(result.failed, [
      {
        job: 'job-failed',
        reason: 'clickhouse-import failed on height=100-199, attempt 3 of 3',
      },
      { job: 'job-vanished', reason: 'job directory missing' },
    ]);
    const ledger = readLedger(db, 'clickhouse');
    assert.equal(ledger.get('loaded')?.completedAt, 99);
    assert.equal(ledger.get('waiting')?.completedAt, null);
    assert.equal(ledger.has('failed'), false, 'written again next run');
    assert.equal(ledger.has('vanished'), false);

    // A loaded job is not reconciled twice.
    const second = await reconcileJobs(db, jobsDir, () => 100);
    assert.deepEqual(second.loaded, []);
    assert.equal(readLedger(db, 'clickhouse').get('loaded')?.completedAt, 99);
  });
});
