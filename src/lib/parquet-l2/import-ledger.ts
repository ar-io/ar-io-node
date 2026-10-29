/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The L2 import's ledger, `parquet_l2_imports` in `bundles.db`: one row per
 * band and target, saying what was written and whether it has landed.
 *
 * For the ClickHouse target the importer writes a job and
 * `clickhouse-auto-import` loads it. Auto-import mounts `bundles.db`
 * read-only, so it reports back through the job's directory instead: it
 * moves a loaded job to `done/` (with `loaded.json`) and a job it gave up on
 * to `failed/`. {@link reconcileJobs} reads those into the ledger.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type Sqlite from 'better-sqlite3';

import {
  type L2ImportCounts,
  type L2ImportJob,
  QUEUE_DIR,
} from './import-clickhouse.js';

export { QUEUE_DIR };

export const L2_LEDGER_MIGRATION =
  '2026.10.28T12.00.00.bundles.add-parquet-l2-imports.sql';

export type L2ImportTarget = 'clickhouse' | 'sqlite';

/** A ledger row. */
export interface L2LedgerRow {
  bandId: string;
  target: L2ImportTarget;
  heightFrom: number;
  heightTo: number;
  bandDigest: Buffer;
  job: string | null;
  queuedAt: number | null;
  completedAt: number | null;
}

/** The queue's subdirectories, under the jobs directory. */
export const DONE_DIR = 'done';
export const FAILED_DIR = 'failed';
/** Where `--forget` moves a job whose rows it removed. */
export const FORGOTTEN_DIR = 'forgotten';
/** What auto-import writes into a job it loaded. */
export const LOADED_FILE = 'loaded.json';

export class L2LedgerRefused extends Error {}

/** The ledger's columns the importer reads and writes. */
export const L2_LEDGER_COLUMNS = [
  'band_id',
  'target',
  'index_name',
  'publisher',
  'height_from',
  'height_to',
  'band_digest',
  'job',
  'rows_imported',
  'rows_present',
  'rows_elsewhere',
  'rows_conflicting',
  'rows_unlocated',
  'accepted',
  'started_at',
  'queued_at',
  'completed_at',
] as const;

/**
 * Refuses a `bundles.db` without the ledger. The table itself is checked,
 * not the migrations list: the gateway records every database's migrations
 * in `core.db`, never in `bundles.db`.
 */
export function assertL2LedgerMigrated(db: Sqlite.Database): void {
  const columns = new Set(
    db
      .prepare("SELECT name FROM pragma_table_info('parquet_l2_imports')")
      .pluck()
      .all() as string[],
  );
  const missing = L2_LEDGER_COLUMNS.filter((c) => !columns.has(c));
  if (missing.length > 0) {
    throw new L2LedgerRefused(
      columns.size === 0
        ? `bundles.db has no parquet_l2_imports table (${L2_LEDGER_MIGRATION}): run \`yarn db:migrate up\` (or restart the gateway on this release) first`
        : `bundles.db's parquet_l2_imports lacks ${missing.join(', ')}, so it was not made by ${L2_LEDGER_MIGRATION}; migrating again will not change it (the table exists). Repair it to that migration's schema; it holds only the import ledger (imported rows stay in ClickHouse, and each job's ids in done/)`,
    );
  }
}

/** The ledger's rows for a target, by band id. */
export function readLedger(
  db: Sqlite.Database,
  target: L2ImportTarget,
): Map<string, L2LedgerRow> {
  const rows = db
    .prepare(
      `SELECT band_id, target, height_from, height_to, band_digest, job, queued_at, completed_at
       FROM parquet_l2_imports WHERE target = ?`,
    )
    .all(target) as Array<{
    band_id: string;
    target: L2ImportTarget;
    height_from: number;
    height_to: number;
    band_digest: Buffer;
    job: string | null;
    queued_at: number | null;
    completed_at: number | null;
  }>;
  return new Map(
    rows.map((r) => [
      r.band_id,
      {
        bandId: r.band_id,
        target: r.target,
        heightFrom: r.height_from,
        heightTo: r.height_to,
        bandDigest: r.band_digest,
        job: r.job,
        queuedAt: r.queued_at,
        completedAt: r.completed_at,
      },
    ]),
  );
}

/** Records a job written for a band: queued, not yet landed. */
export function recordQueued(
  db: Sqlite.Database,
  {
    target,
    job,
    accepted,
    startedAt,
    queuedAt,
  }: {
    target: L2ImportTarget;
    job: L2ImportJob;
    accepted: string[];
    startedAt: number;
    queuedAt: number;
  },
): void {
  const c: L2ImportCounts = job.counts;
  db.prepare(
    `INSERT INTO parquet_l2_imports (
       band_id, target, index_name, publisher, height_from, height_to,
       band_digest, job, rows_imported, rows_present, rows_elsewhere,
       rows_conflicting, rows_unlocated, accepted, started_at, queued_at,
       completed_at)
     VALUES (@bandId, @target, @index, @publisher, @from, @to, @digest, @job,
       @written, @present, @elsewhere, @conflicting, @unlocated, @accepted,
       @startedAt, @queuedAt, NULL)
     ON CONFLICT (band_id, target) DO UPDATE SET
       index_name = excluded.index_name, publisher = excluded.publisher,
       height_from = excluded.height_from, height_to = excluded.height_to,
       band_digest = excluded.band_digest, job = excluded.job,
       rows_imported = excluded.rows_imported,
       rows_present = excluded.rows_present,
       rows_elsewhere = excluded.rows_elsewhere,
       rows_conflicting = excluded.rows_conflicting,
       rows_unlocated = excluded.rows_unlocated,
       accepted = excluded.accepted, started_at = excluded.started_at,
       queued_at = excluded.queued_at, completed_at = NULL`,
  ).run({
    bandId: job.bandId,
    target,
    index: job.index,
    publisher: job.publisher,
    from: job.heightRange[0],
    to: job.heightRange[1],
    digest: Buffer.from(job.bandDigest, 'hex'),
    job: job.job,
    written: c.written,
    present: c.present,
    elsewhere: c.elsewhere,
    conflicting: c.conflicting,
    unlocated: c.unlocated,
    accepted: JSON.stringify(accepted),
    startedAt,
    queuedAt,
  });
}

/**
 * Records a band with nothing left to write up to `heightTo` (every item
 * held already): complete, with no job.
 */
export function recordNothingToWrite(
  db: Sqlite.Database,
  {
    target,
    bandId,
    index,
    publisher,
    heightRange,
    bandDigest,
    counts,
    accepted,
    startedAt,
    completedAt,
  }: {
    target: L2ImportTarget;
    bandId: string;
    index: string;
    publisher: string;
    heightRange: [number, number];
    bandDigest: Buffer;
    counts: L2ImportCounts;
    accepted: string[];
    startedAt: number;
    completedAt: number;
  },
): void {
  db.prepare(
    `INSERT INTO parquet_l2_imports (
       band_id, target, index_name, publisher, height_from, height_to,
       band_digest, job, rows_imported, rows_present, rows_elsewhere,
       rows_conflicting, rows_unlocated, accepted, started_at, queued_at,
       completed_at)
     VALUES (@bandId, @target, @index, @publisher, @from, @to, @digest, NULL,
       0, @present, @elsewhere, @conflicting, 0, @accepted, @startedAt, NULL,
       @completedAt)
     ON CONFLICT (band_id, target) DO UPDATE SET
       height_from = excluded.height_from, height_to = excluded.height_to,
       band_digest = excluded.band_digest, job = NULL,
       rows_imported = 0, rows_present = excluded.rows_present,
       rows_elsewhere = excluded.rows_elsewhere,
       rows_conflicting = excluded.rows_conflicting, rows_unlocated = 0,
       accepted = excluded.accepted, started_at = excluded.started_at,
       queued_at = NULL, completed_at = excluded.completed_at`,
  ).run({
    bandId,
    target,
    index,
    publisher,
    from: heightRange[0],
    to: heightRange[1],
    digest: bandDigest,
    present: counts.present,
    elsewhere: counts.elsewhere,
    conflicting: counts.conflicting,
    accepted: JSON.stringify(accepted),
    startedAt,
    completedAt,
  });
}

/** What {@link reconcileJobs} found. */
export interface ReconcileResult {
  /** Jobs auto-import loaded since the last run. */
  loaded: string[];
  /** Jobs auto-import gave up on: their bands are written again. */
  failed: Array<{ job: string; reason: string }>;
  /** Jobs still waiting in the queue. */
  waiting: string[];
}

/**
 * Reads what auto-import did with queued jobs into the ledger: a loaded job
 * completes its band; a failed one clears it, so the next run writes the
 * band again.
 */
export async function reconcileJobs(
  db: Sqlite.Database,
  jobsDir: string,
  now: () => number = () => Math.floor(Date.now() / 1000),
): Promise<ReconcileResult> {
  const result: ReconcileResult = { loaded: [], failed: [], waiting: [] };
  const queued = [...readLedger(db, 'clickhouse').values()].filter(
    (r) => r.job !== null && r.completedAt === null,
  );
  for (const row of queued) {
    const job = row.job as string;
    // The queue first: auto-import only ever moves a job out of it, to
    // done/ or failed/, each move whole (a rename). Looked at in this order,
    // a job moved between two looks is found in the second, never missed.
    if (await exists(path.join(jobsDir, QUEUE_DIR, job))) {
      result.waiting.push(job);
      continue;
    }
    if (await exists(path.join(jobsDir, DONE_DIR, job, LOADED_FILE))) {
      db.prepare(
        'UPDATE parquet_l2_imports SET completed_at = ? WHERE band_id = ? AND target = ? AND job = ?',
      ).run(now(), row.bandId, 'clickhouse', job);
      result.loaded.push(job);
      continue;
    }
    const failedDir = path.join(jobsDir, FAILED_DIR, job);
    const reason = (await exists(failedDir))
      ? await fsp
          .readFile(path.join(failedDir, 'failed.txt'), 'utf8')
          .then((t) => t.trim().split('\n').pop() ?? '')
          .catch(() => '')
      : // In none of the three: removed by hand.
        'job directory missing';
    // The band is written again later. Rows of the job that did load are
    // held by ClickHouse by then, so the new job leaves them out; --forget
    // finds them through this job's written.parquet, kept in failed/.
    db.prepare(
      'DELETE FROM parquet_l2_imports WHERE band_id = ? AND target = ? AND job = ?',
    ).run(row.bandId, 'clickhouse', job);
    result.failed.push({ job, reason });
  }
  return result;
}

const exists = (p: string) =>
  fsp.stat(p).then(
    () => true,
    () => false,
  );

/**
 * The SQLite target's ledger writes. The rows are written by the importer
 * itself, a batch at a time, so the ledger moves with them: each batch adds
 * its counts in the same transaction that writes its rows, and a run killed
 * part way leaves a row whose counts match what is in the database.
 *
 * `rows_imported` adds up over every run of a band (a resumed run and one
 * past a higher ceiling write only rows not yet there). `rows_present` and
 * `rows_conflicting` count rows the gateway wrote itself, so a later run,
 * which finds this band's own rows, does not count them; they and
 * `rows_unlocated` describe the band's latest run.
 */
export class SqliteImportLedger {
  private readonly start: Sqlite.Statement;
  private readonly progress: Sqlite.Statement;
  private readonly complete: Sqlite.Statement;

  constructor(db: Sqlite.Database) {
    this.start = db.prepare(
      `INSERT INTO parquet_l2_imports (
         band_id, target, index_name, publisher, height_from, height_to,
         band_digest, job, rows_imported, rows_present, rows_elsewhere,
         rows_conflicting, rows_unlocated, accepted, started_at, queued_at,
         completed_at)
       VALUES (@bandId, 'sqlite', @index, @publisher, @from, @from - 1,
         @digest, NULL, 0, 0, 0, 0, 0, @accepted, @startedAt, NULL, NULL)
       ON CONFLICT (band_id, target) DO UPDATE SET
         index_name = excluded.index_name, publisher = excluded.publisher,
         rows_imported = CASE WHEN band_digest = excluded.band_digest
           THEN rows_imported ELSE 0 END,
         height_to = CASE WHEN band_digest = excluded.band_digest
           THEN height_to ELSE excluded.height_to END,
         band_digest = excluded.band_digest,
         rows_present = 0, rows_elsewhere = 0, rows_conflicting = 0,
         rows_unlocated = 0, accepted = excluded.accepted,
         started_at = excluded.started_at, completed_at = NULL`,
    );
    this.progress = db.prepare(
      `UPDATE parquet_l2_imports SET
         rows_imported = rows_imported + @written,
         rows_present = rows_present + @present,
         rows_conflicting = rows_conflicting + @conflicting
       WHERE band_id = @bandId AND target = 'sqlite'`,
    );
    this.complete = db.prepare(
      `UPDATE parquet_l2_imports SET
         height_to = MAX(height_to, @heightTo), rows_unlocated = @unlocated,
         completed_at = @completedAt
       WHERE band_id = @bandId AND target = 'sqlite'`,
    );
  }

  /** A run begins: the band's row exists, incomplete, from here on. */
  started({
    bandId,
    index,
    publisher,
    heightFrom,
    bandDigest,
    accepted,
    startedAt,
  }: {
    bandId: string;
    index: string;
    publisher: string;
    heightFrom: number;
    bandDigest: Buffer;
    accepted: string[];
    startedAt: number;
  }): void {
    this.start.run({
      bandId,
      index,
      publisher,
      from: heightFrom,
      digest: bandDigest,
      accepted: JSON.stringify(accepted),
      startedAt,
    });
  }

  /** A batch's counts; call inside the batch's own transaction. */
  addProgress(
    bandId: string,
    {
      written,
      present,
      conflicting,
    }: { written: number; present: number; conflicting: number },
  ): void {
    this.progress.run({ bandId, written, present, conflicting });
  }

  /** The run wrote everything up to `heightTo`. */
  completed({
    bandId,
    heightTo,
    unlocated,
    completedAt,
  }: {
    bandId: string;
    heightTo: number;
    unlocated: number;
    completedAt: number;
  }): void {
    this.complete.run({ bandId, heightTo, unlocated, completedAt });
  }
}
