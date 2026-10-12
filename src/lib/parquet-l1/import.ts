/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Importing `parquet-l1` bands into a gateway's `core.db`, so a new gateway
 * starts from a published index instead of indexing the chain block by
 * block.
 *
 * Runs with the gateway stopped: it writes `stable_*` directly and makes no
 * network calls.
 *
 * A band replaces its own height range, and is recorded in
 * `parquet_l1_imports` before its rows are written and completed after
 * them. That is what makes an interrupted import safe: a band writes all
 * of its blocks long before its transactions, so how far `stable_blocks`
 * reaches says nothing about how much of a band landed. Progress is read
 * from the ledger, and a band left unfinished is imported again over
 * whatever it managed to write.
 *
 * Bands are imported in height order and a gap is refused: the block
 * importer rewinds across one and gives up after `MAX_FORK_DEPTH`.
 */
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import Sqlite from 'better-sqlite3';
import { Logger } from 'winston';

import {
  BAND_FILE,
  bandTablesDigest,
  idHeightRange,
  PARQUET_L1_TABLES,
  ParquetL1Band,
  readBandDirectory,
  TableSpec,
} from './layout.js';
import { IMPORT_ORDER, readTable } from './read.js';
import { FORK_2_0 } from './chain.js';
import sleep from '../wait.js';

/** A band on disk, ready to import. */
export interface ImportableBand {
  id: string;
  dir: string;
  band: ParquetL1Band;
}

export interface ImportOutcome {
  id: string;
  heightRange: [number, number];
  /** The heights written, when not the whole band. */
  heights?: [number, number];
  result: 'imported' | 'refused';
  reason?: string;
  rows?: number;
  missingTransactions?: number;
  seconds: number;
}

/** A band on disk the run had no use for, and why. */
export interface SkippedBand {
  band: ImportableBand;
  reason:
    | 'already_imported'
    | 'covered_by_a_wider_band'
    | 'below_what_core_db_holds'
    | 'above_the_requested_range';
}

export class ImportRefused extends Error {}

const spec = (name: string) =>
  PARQUET_L1_TABLES.find((t) => t.name === name) as TableSpec;

/**
 * Rows written before a commit. Bounds the WAL and the memory a write
 * transaction holds; the cost of a crash is re-importing one band.
 */
export const COMMIT_EVERY_ROWS = 2_000_000;

/**
 * How often a band in flight says where it is. The largest band takes
 * around twenty minutes, so an operator watching a first import needs to
 * see something between the plan and the result.
 */
export const PROGRESS_EVERY_MS = 60_000;

/**
 * Heights cleared per transaction when filling beneath a running gateway.
 * The busiest heights hold about 470 rows each, so a window is under
 * 100,000 rows: a second or so of the write lock at worst. A clear that
 * finds nothing, the usual case, costs a few index probes.
 */
export const CLEAR_WINDOW_HEIGHTS = 200;

/**
 * Rows read, and so written, per transaction when filling beneath a
 * running gateway. Core waits up to 30 s for the write lock, and a batch
 * this size holds it for well under one.
 */
export const FILL_BATCH_ROWS = 10_000;

/**
 * Pause after each fill transaction. SQLite grants the lock to whichever
 * writer retries first, and the gateway's writers back off while they
 * wait, so a writer that begins again at once can keep them out.
 */
export const FILL_YIELD_MS = 50;

/**
 * A band's identity for the ledger. The same digest the band's id carries,
 * so a band recorded as imported cannot be a different band under the same
 * name.
 */
export const bandDigest = bandTablesDigest;

export { idHeightRange };

/**
 * Every band of a `parquet-l1` directory, lowest first, with its band file
 * read.
 *
 * A directory is named by its band id, or `<band id>~<generation>` as the
 * index-swarm sidecar installs it ({@link readBandDirectory} reads both, and
 * one copy of each band). One whose band id is not a band id, or disagrees
 * with the band inside it, is passed over rather than refused: the directory holds
 * whatever a publisher and a subscriber left there, and one band nobody can
 * read must not stop the rest importing.
 *
 * The name has to agree with the band because the name is the ledger's key.
 * A band recorded under heights it does not hold would leave the planner
 * certain of a range nothing filled. The grid itself is not checked here —
 * {@link planImport} refuses a gap or an overlap whatever grid a band came
 * from, and a publisher that changes the grid should not strand the bands
 * already published.
 */
export async function readBands(dir: string): Promise<ImportableBand[]> {
  const bands: ImportableBand[] = [];
  for (const found of await readBandDirectory(dir)) {
    const named = idHeightRange(found.id);
    if (named === undefined) continue;
    const [from, to] = found.band.heightRange;
    if (from !== named[0] || to !== named[1]) continue;
    bands.push(found);
  }
  return bands.sort(
    (a, b) =>
      a.band.heightRange[0] - b.band.heightRange[0] ||
      a.band.heightRange[1] - b.band.heightRange[1],
  );
}

/**
 * The bands to import, in height order: those the ledger doesn't hold that
 * carry heights above what `core.db` already has. Overlapping bands are
 * dropped in favour of the one that reaches furthest.
 *
 * A gap is refused rather than imported around, because the block importer
 * rewinds across one and gives up after `MAX_FORK_DEPTH`. An empty database
 * is the exception: it has no history to be continuous with, so it adopts
 * the lowest band's start.
 *
 * Only a band the ledger records as finished counts as held. One left
 * unfinished is imported again, over whatever it managed to write.
 */
export function planImport(
  bands: ImportableBand[],
  {
    haveTo,
    held,
    blocksTo = haveTo,
    from: startAt,
    to: stopAt,
  }: {
    haveTo: number;
    held: ReadonlySet<string>;
    /**
     * The highest height `stable_blocks` actually reaches, which can be
     * above `haveTo` when an unfinished band pulled that down. Used to
     * tell "these heights are there, the ledger just has a stale row"
     * from "the ledger claims heights the database does not hold".
     */
    blocksTo?: number;
    /**
     * Start here instead of continuing from the top of what `core.db`
     * holds. This is how a gateway that began mid-chain fills in the
     * history beneath it: a band rewrites only its own height range, so
     * importing below what is held cannot disturb it.
     */
    from?: number;
    /** Stop after the band covering this height, so a backfill need not redo what is already held. */
    to?: number;
  },
): { steps: ImportableBand[]; skipped: SkippedBand[] } {
  const steps: ImportableBand[] = [];
  const skipped: SkippedBand[] = [];
  // An empty database takes the lowest band's start as its own: the result
  // is a gateway whose history begins there, as one started with
  // START_HEIGHT does. A database that already holds blocks must be
  // continued from, not left with a hole.
  const lowest = bands.reduce(
    (low, b) => Math.min(low, b.band.heightRange[0]),
    Number.MAX_SAFE_INTEGER,
  );
  let next = startAt ?? (haveTo < 0 ? lowest : haveTo + 1);
  // Sorted by start then end, so a tip band comes before the whole band
  // that covers it. Drop any band another wholly contains, or the shorter
  // would be imported and the longer then import over it.
  const covered = (b: ImportableBand) => coveredByWider(b, bands);
  for (const candidate of bands) {
    const [from, to] = candidate.band.heightRange;
    const reason = held.has(candidate.id)
      ? 'already_imported'
      : covered(candidate)
        ? 'covered_by_a_wider_band'
        : to < next
          ? 'below_what_core_db_holds'
          : stopAt !== undefined && candidate.band.heightRange[0] > stopAt
            ? 'above_the_requested_range'
            : undefined;
    if (reason !== undefined) {
      skipped.push({ band: candidate, reason });
      // A band the ledger holds, whose heights the database really does
      // hold, has landed: carry on above it. Without this, an unfinished
      // row that pulled `haveTo` down makes the band above it look like
      // a gap and refuses every run from then on. The `blocksTo` test is
      // what stops this trusting a ledger that outlived its database.
      if (reason === 'already_imported' && to <= blocksTo) {
        next = Math.max(next, to + 1);
      }
      continue;
    }
    if (from > next) {
      throw new ImportRefused(
        `No band covers height ${next}: the next starts at ${from}. An import must be contiguous, or the block importer rewinds across the gap`,
      );
    }
    if (from < next) {
      // Starts below what is held but reaches past it: a band an earlier
      // run left part way through. Importing it again is safe — every
      // write is idempotent — and is the only way to finish it.
      steps.push(candidate);
      next = to + 1;
      continue;
    }
    steps.push(candidate);
    next = to + 1;
  }
  return { steps, skipped };
}

/**
 * Bytes of `core.db` a band row costs, measured: the 100,000-height band
 * at the chain's busiest heights holds 46.6M rows and leaves a 12 GB
 * database, indexes included. Rounded up, because a run that stops for
 * want of disk part way through costs far more than one that waits.
 */
export const BYTES_PER_ROW = 300;

/**
 * Free bytes an import keeps back beyond its estimate: the write-ahead log
 * a band in flight builds (1.9 GB at the largest band's chunk size), and
 * room for the gateway to start afterwards.
 */
export const DISK_HEADROOM_BYTES = 4 * 1024 ** 3;

/**
 * Refuses a run the filesystem holding `core.db` has no room for, before a
 * band is read rather than part way through the largest one.
 *
 * The estimate is deliberately rough and deliberately high. A full chain is
 * hundreds of gigabytes, and `ENOSPC` inside a write transaction is the one
 * failure that leaves an operator with a database to repair instead of a
 * run to restart.
 */
export async function assertDiskSpace(
  coreDbPath: string,
  steps: ImportableBand[],
  {
    log,
    statfs = fs.statfs,
    bytesPerRow = BYTES_PER_ROW,
    headroom = DISK_HEADROOM_BYTES,
    rows: estimatedRows,
  }: {
    log: Logger;
    statfs?: (path: string) => Promise<{ bsize: number; bavail: number }>;
    bytesPerRow?: number;
    headroom?: number;
    /** Rows the run will write, where that is not every row of `steps`. */
    rows?: number;
  },
): Promise<void> {
  const rows =
    estimatedRows ??
    steps.reduce(
      (sum, step) =>
        sum +
        Object.values(step.band.tables).reduce((n, table) => n + table.rows, 0),
      0,
    );
  const needed = rows * bytesPerRow + headroom;
  let free: number;
  try {
    const stat = await statfs(path.dirname(path.resolve(coreDbPath)));
    free = stat.bsize * stat.bavail;
  } catch (error) {
    // Not every filesystem answers. Better to import than to refuse over
    // a check that could not be made.
    log.warn('Could not read free space; importing without the check', {
      coreDbPath,
      error: (error as Error).message,
    });
    return;
  }
  const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (free < needed) {
    throw new ImportRefused(
      `${gib(free)} free where core.db lives, and ${steps.length} bands of ${rows.toLocaleString()} rows need about ${gib(needed)} (${gib(headroom)} of it kept back for the write-ahead log and the gateway). Free space, or import fewer bands with --max-bands`,
    );
  }
  log.info('Disk checked', {
    freeBytes: free,
    estimatedBytes: needed,
    bands: steps.length,
    rows,
  });
}

/**
 * Sets the database up for a bulk load.
 *
 * `cache_size` is the one that matters. SQLite's default page cache is 2 MB,
 * and a bootstrap spends its time maintaining indexes: once those outgrow
 * the cache every insert becomes random I/O, and the rate falls as the
 * database fills. Measured on a full-chain run with the default: 31,730
 * rows/s at 8 GB, down to 7,758 at 27 GB.
 *
 * `synchronous = NORMAL` is durable against this process dying, which is
 * the failure that happens. A band lost to a power cut is safe to redo:
 * the ledger records it unfinished and the range is rewritten.
 *
 * Deliberately not set: `temp_store`. An import is inserts, not sorts, so
 * it has nothing to gain, and forcing temp storage into memory would be
 * actively wrong for anything that does sort — a `CREATE INDEX` over the
 * 305M-row tag table would try to do it in RAM.
 */
export function applyImportPragmas(
  db: Sqlite.Database,
  cacheMib: number,
): void {
  db.pragma('journal_mode = WAL');
  db.pragma(`cache_size = -${cacheMib * 1024}`);
  db.pragma('synchronous = NORMAL');
}

/**
 * Heights that would still be missing after a run, given what `core.db`
 * holds and what the run will import.
 *
 * The importer's promise is that it never leaves a hole in
 * `stable_blocks`, because the block importer rewinds across one and
 * gives up after `MAX_FORK_DEPTH`. Continuing upward from the top kept
 * that promise for free. Filling in underneath cannot, so the hole is
 * worked out directly and reported.
 *
 * `held` is every run of heights `stable_blocks` covers — not its lowest
 * and highest, which would miss a gap in the middle. Two staged
 * backfills can leave 0-99 and 200-299, where min and max alone say
 * 0-299 and report nothing missing, and the gateway then rewinds across
 * 100-199. Ranges are inclusive, and the result is the gaps between the
 * union's pieces, lowest first.
 */
export function remainingHoles(
  held: ReadonlyArray<readonly [number, number]>,
  planned: ReadonlyArray<readonly [number, number]>,
): Array<[number, number]> {
  const pieces = [...planned, ...held]
    .filter(([from, to]) => to >= from)
    .sort((a, b) => a[0] - b[0]);
  if (pieces.length === 0) return [];
  const holes: Array<[number, number]> = [];
  let reach = pieces[0][1];
  for (const [from, to] of pieces.slice(1)) {
    if (from > reach + 1) holes.push([reach + 1, from - 1]);
    reach = Math.max(reach, to);
  }
  return holes;
}

/**
 * The runs of consecutive heights `stable_blocks` holds.
 *
 * Gaps-and-islands: a height minus its row number is constant across a
 * run, so grouping by that difference gives each run's ends. A full scan
 * of the height index, which is the right price for an offline tool that
 * is about to write tens of gigabytes — and the only way to see a gap in
 * the middle, which `MIN`/`MAX` cannot.
 */
export function heldRuns(db: Sqlite.Database): Array<[number, number]> {
  return (
    db
      .prepare(
        `SELECT MIN(height) AS lo, MAX(height) AS hi FROM (
           SELECT height, height - ROW_NUMBER() OVER (ORDER BY height) AS run
           FROM stable_blocks)
         GROUP BY run ORDER BY lo`,
      )
      .all() as Array<{ lo: number; hi: number }>
  ).map((r) => [r.lo, r.hi]);
}

/**
 * The highest height an online fill may write, or -1 when the gateway holds
 * no blocks yet and there is nothing to fill beneath.
 *
 * A running gateway writes its own heights from the tip down: the block
 * importer adds `new_*` rows at the tip, and the flush moves them into
 * `stable_*` once they are deep enough. Neither writes below the top of
 * `stable_blocks`, so every height up to it is the fill's to write and
 * none above it is. A gateway that has not flushed yet holds only
 * `new_blocks`, and its lowest one is where it began.
 */
export function fillCeiling(db: Sqlite.Database): number {
  const stableTop = db
    .prepare('SELECT MAX(height) FROM stable_blocks')
    .pluck()
    .get() as number | null;
  const newBottom = db
    .prepare('SELECT MIN(height) FROM new_blocks')
    .pluck()
    .get() as number | null;
  if (stableTop === null) return newBottom === null ? -1 : newBottom - 1;
  return newBottom === null ? stableTop : Math.min(stableTop, newBottom - 1);
}

/** Inclusive ranges, merged where they overlap or touch, lowest first. */
export function mergeRanges(
  ranges: ReadonlyArray<readonly [number, number]>,
): Array<[number, number]> {
  const sorted = ranges
    .filter(([a, b]) => b >= a)
    .map(([a, b]): [number, number] => [a, b])
    .sort((x, y) => x[0] - y[0]);
  const merged: Array<[number, number]> = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range[0] <= last[1] + 1) {
      last[1] = Math.max(last[1], range[1]);
    } else {
      merged.push(range);
    }
  }
  return merged;
}

/** The heights in `[lo, hi]` that `held` does not cover, as inclusive ranges. */
export function missingRanges(
  held: ReadonlyArray<readonly [number, number]>,
  lo: number,
  hi: number,
): Array<[number, number]> {
  const missing: Array<[number, number]> = [];
  let next = lo;
  for (const [a, b] of mergeRanges(held)) {
    if (next > hi) break;
    if (b < next) continue;
    if (a > hi) break;
    if (a > next) missing.push([next, a - 1]);
    next = Math.max(next, b + 1);
  }
  if (next <= hi) missing.push([next, hi]);
  return missing;
}

/**
 * True when another band wholly contains this one and reaches further, as a
 * whole band does the tip bands it replaced. The shorter is never imported:
 * the longer would only import over it.
 */
function coveredByWider(
  band: ImportableBand,
  bands: ReadonlyArray<ImportableBand>,
): boolean {
  const [from, to] = band.band.heightRange;
  return bands.some(
    (other) =>
      other !== band &&
      other.band.heightRange[0] <= from &&
      other.band.heightRange[1] >= to &&
      other.band.heightRange[1] - other.band.heightRange[0] > to - from,
  );
}

/** Heights one band fills beneath a running gateway. */
export interface FillStep {
  band: ImportableBand;
  heights: [number, number];
}

/**
 * The steps that fill what `core.db` is missing at or below `ceiling`, from
 * the bands that hold it, lowest first.
 *
 * Only missing heights are written, so nothing the gateway indexed itself
 * is rewritten — except `redo`, ranges a run left unfinished, which look
 * held because a band writes its blocks long before their transactions.
 * A band's tip may be published before its whole range is mined, so a
 * band fills only up to `top`, the highest block it holds; anything above
 * that waits for the band that replaces it.
 *
 * `uncovered` is what no band on disk can fill yet: bands still
 * downloading, or the heights between the newest band and where the
 * gateway began, which the publisher's next tip band will hold.
 */
export function planFill(
  bands: ReadonlyArray<ImportableBand>,
  {
    held,
    ceiling,
    redo = [],
    top = new Map(),
    from = 0,
    to = ceiling,
  }: {
    held: ReadonlyArray<readonly [number, number]>;
    ceiling: number;
    redo?: ReadonlyArray<readonly [number, number]>;
    /** The highest height each band (by id) holds, where below its range's end. */
    top?: ReadonlyMap<string, number>;
    from?: number;
    to?: number;
  },
): { steps: FillStep[]; uncovered: Array<[number, number]> } {
  const lo = Math.max(0, from);
  const hi = Math.min(ceiling, to);
  if (hi < lo) return { steps: [], uncovered: [] };
  let holes = mergeRanges([
    ...missingRanges(held, lo, hi),
    ...redo.map(([a, b]): [number, number] => [
      Math.max(a, lo),
      Math.min(b, hi),
    ]),
  ]);
  const steps: FillStep[] = [];
  for (const band of bands) {
    if (coveredByWider(band, bands)) continue;
    const [bandFrom, bandTo] = band.band.heightRange;
    const reach = Math.min(bandTo, top.get(band.id) ?? bandTo);
    const left: Array<[number, number]> = [];
    for (const [a, b] of holes) {
      const start = Math.max(a, bandFrom);
      const end = Math.min(b, reach);
      if (start > end) {
        left.push([a, b]);
        continue;
      }
      steps.push({ band, heights: [start, end] });
      if (a < start) left.push([a, start - 1]);
      if (end < b) left.push([end + 1, b]);
    }
    holes = mergeRanges(left);
  }
  steps.sort((x, y) => x.heights[0] - y.heights[0]);
  return { steps, uncovered: holes };
}

/**
 * The ledger key for heights a band filled: the band's own id when it
 * filled its whole range, so the offline planner counts the band as held,
 * and the id with the heights otherwise.
 */
export function fillLedgerKey(step: FillStep): string {
  const [from, to] = step.band.band.heightRange;
  return step.heights[0] === from && step.heights[1] === to
    ? step.band.id
    : `${step.band.id}@${step.heights[0]}-${step.heights[1]}`;
}

/**
 * The migration this importer was written against; its table must exist.
 * Named as `src/migrate.ts` records it in `migrations`: the file's name,
 * `.sql` and all.
 */
export const LEDGER_MIGRATION =
  '2026.10.04T12.00.00.core.add-parquet-l1-imports.sql';

/**
 * Refuses a `core.db` that has not run the ledger migration, so the gateway
 * and the importer agree on the schema: an older `core.db` is missing
 * columns an import writes.
 */
export function assertMigrated(db: Sqlite.Database): void {
  const migrated = db
    .prepare('SELECT 1 FROM migrations WHERE name = ?')
    .pluck()
    .get(LEDGER_MIGRATION);
  if (migrated === undefined) {
    throw new ImportRefused(
      `core.db has not run ${LEDGER_MIGRATION}: run \`yarn db:migrate up\` first, so the importer and the gateway agree on the schema`,
    );
  }
}

/**
 * Refuses a `core.db` an import would damage or silently half-fill.
 *
 * - The ledger migration must have run, so the gateway and the importer
 *   agree on the schema. An older `core.db` is missing columns this writes.
 * - `new_*` must be empty. Those are the unstable rows near the tip; an
 *   import writes `stable_*` beneath them, and the block importer would
 *   then flush them over heights it never fetched.
 * - The gateway must be stopped. `locking_mode = EXCLUSIVE` takes the
 *   database for the whole run and fails if anything else is attached,
 *   which `BEGIN IMMEDIATE` alone does not: a gateway that happens to be
 *   idle between flushes holds no write lock to collide with, and an
 *   import releases its own lock at every chunk.
 */
export function assertImportable(db: Sqlite.Database): void {
  assertMigrated(db);
  // Any of the three: a transaction can arrive before its block, so
  // `new_blocks` alone can be empty while the others are not.
  const unstable = (
    ['new_blocks', 'new_transactions', 'new_block_transactions'] as const
  ).reduce(
    (total, table) =>
      total +
      (db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number),
    0,
  );
  if (unstable > 0) {
    throw new ImportRefused(
      `core.db holds ${unstable} unstable rows: stop the gateway and let them flush, or reset them, before importing beneath them`,
    );
  }
  // Takes the database for the run, and keeps it: a gateway started half
  // way through would otherwise write `new_*` over heights being rewritten
  // beneath it.
  try {
    db.pragma('locking_mode = EXCLUSIVE');
    db.exec('BEGIN IMMEDIATE');
    db.exec('COMMIT');
  } catch (error) {
    db.pragma('locking_mode = NORMAL');
    const message = (error as Error).message;
    throw new ImportRefused(
      /busy|locked/i.test(message)
        ? `core.db is open elsewhere (${message}); stop the gateway before importing`
        : `core.db would not take an exclusive lock: ${message}`,
    );
  }
}

/** What `core.db` already holds, and the bands it was built from. */
export function readProgress(db: Sqlite.Database): {
  haveTo: number;
  /** The lowest height `stable_blocks` holds, or -1 when it holds none. */
  blocksFrom: number;
  /** The highest height `stable_blocks` holds, before any unfinished band pulls it down. */
  blocksTo: number;
  held: Set<string>;
  unfinished: Array<{ id: string; from: number }>;
} {
  const span = db
    .prepare('SELECT MIN(height) AS lo, MAX(height) AS hi FROM stable_blocks')
    .get() as { lo: number | null; hi: number | null };
  const blocksFrom = span.lo ?? -1;
  const blocksTo = span.hi ?? -1;
  const held = new Set(
    db
      .prepare(
        'SELECT band_id FROM parquet_l1_imports WHERE completed_at IS NOT NULL',
      )
      .pluck()
      .all() as string[],
  );
  const unfinished = (
    db
      .prepare(
        'SELECT band_id, height_from FROM parquet_l1_imports WHERE completed_at IS NULL ORDER BY height_from',
      )
      .all() as Array<{ band_id: string; height_from: number }>
  ).map((row) => ({ id: row.band_id, from: row.height_from }));

  // A band writes all of its blocks long before its transactions, so how
  // far `stable_blocks` reaches is not how far the database can be
  // trusted. Where a band was left unfinished, the trustworthy top is the
  // height below where it began.
  const haveTo = unfinished.reduce(
    (top, band) => Math.min(top, band.from - 1),
    blocksTo,
  );
  return { haveTo, blocksFrom, blocksTo, held, unfinished };
}

const sha1 = (bytes: Buffer) =>
  crypto.createHash('sha1').update(bytes).digest();

const asBuffer = (value: unknown): Buffer =>
  Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);

/**
 * Imports one band, or the part of it `heights` names, ending with its
 * ledger row.
 *
 * Offline, the band is written in chunks of `commitEvery` rows while the
 * database is held for the run. `online` is for a gateway that is running:
 * each batch read is its own short transaction, begun only once the batch
 * is in hand and followed by a pause of `yieldMs`, so the gateway's own
 * writers are never shut out for long, and the range is cleared a window
 * of heights at a time for the same reason.
 *
 * Idempotent: every write is `INSERT OR REPLACE`/`OR IGNORE` keyed the way
 * the table is, and `missing_tx_count` is derived from the rows rather than
 * incremented, so importing the same band twice leaves `core.db` exactly as
 * importing it once does. The planner skips a band the ledger holds; this
 * is what makes that an optimisation rather than a correctness rule.
 *
 * Order matters: owners and blocks before the rows that point at them,
 * transactions before the links and tags that name them. A link whose
 * transaction the band lacks becomes a `missing_transactions` row, so the
 * gateway backfills it the usual way rather than trusting a count.
 */
export async function importBand(
  db: Sqlite.Database,
  duck: import('duckdb-async').Database,
  entry: ImportableBand,
  {
    log,
    batchRows,
    commitEvery = COMMIT_EVERY_ROWS,
    progressEveryMs = PROGRESS_EVERY_MS,
    now = Date.now,
    heights,
    ledgerKey = entry.id,
    ceiling = Number.MAX_SAFE_INTEGER,
    online = false,
    yieldMs = 0,
    clearWindow = CLEAR_WINDOW_HEIGHTS,
  }: {
    log: Logger;
    batchRows?: number;
    commitEvery?: number;
    progressEveryMs?: number;
    now?: () => number;
    /** Write only these heights of the band (inclusive); all of it by default. */
    heights?: [number, number];
    /** The ledger row's key; the band's id by default. */
    ledgerKey?: string;
    /** The highest height this run may write; bounds which unfinished rows it settles. */
    ceiling?: number;
    /** The gateway is running: short transactions, with a pause after each. */
    online?: boolean;
    yieldMs?: number;
    /** Heights cleared per transaction when online. */
    clearWindow?: number;
  },
): Promise<{ rows: number; missingTransactions: number }> {
  const { band, dir } = entry;
  const [from, to] = heights ?? band.heightRange;
  // A row outside the heights being written is read, so the band's digest
  // is still checked whole, but not written.
  const wanted =
    heights === undefined
      ? () => true
      : (height: number) => height >= from && height <= to;
  // Format-1 data roots this gateway holds for the band's range, kept across
  // the clear below. A temporary table, not a map: a busy range can hold
  // hundreds of thousands of format-1 transactions. See `keepDataRoots`.
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS parquet_l1_kept_data_roots
    (id BLOB PRIMARY KEY, data_root BLOB NOT NULL)`);
  const insert = {
    wallets: db.prepare(
      'INSERT OR IGNORE INTO wallets (address, public_modulus) VALUES (?, ?)',
    ),
    blocks:
      db.prepare(`INSERT OR REPLACE INTO stable_blocks (indep_hash, height,
      previous_block, nonce, hash, block_timestamp, tx_count, block_size, diff,
      cumulative_diff, last_retarget, reward_addr, reward_pool, weave_size,
      usd_to_ar_rate_dividend, usd_to_ar_rate_divisor,
      scheduled_usd_to_ar_rate_dividend, scheduled_usd_to_ar_rate_divisor,
      hash_list_merkle, wallet_list, tx_root, missing_tx_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`),
    transactions: db.prepare(`INSERT OR REPLACE INTO stable_transactions (id,
      block_transaction_index, target, quantity, reward, last_tx, data_size,
      content_type, format, height, owner_address, data_root, offset,
      content_encoding, tag_count, signature, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    link: db.prepare(`INSERT OR IGNORE INTO stable_block_transactions
      (block_indep_hash, transaction_id, block_transaction_index) VALUES (?, ?, ?)`),
    missing: db.prepare(`INSERT OR IGNORE INTO missing_transactions
      (block_indep_hash, transaction_id, height) VALUES (?, ?, ?)`),
    tagName: db.prepare(
      'INSERT OR IGNORE INTO tag_names (hash, name) VALUES (?, ?)',
    ),
    tagValue: db.prepare(
      'INSERT OR IGNORE INTO tag_values (hash, value) VALUES (?, ?)',
    ),
    tag: db.prepare(`INSERT OR IGNORE INTO stable_transaction_tags (tag_name_hash,
      tag_value_hash, height, block_transaction_index, transaction_tag_index,
      transaction_id) VALUES (?, ?, ?, ?, ?, ?)`),
    // Derived from the rows, not incremented: an import that runs twice
    // must land on the same number.
    countMissing: db.prepare(`UPDATE stable_blocks SET missing_tx_count =
      (SELECT COUNT(*) FROM missing_transactions m WHERE m.height = stable_blocks.height)
      WHERE height BETWEEN ? AND ?`),
    hashAt: db
      .prepare('SELECT indep_hash FROM stable_blocks WHERE height = ?')
      .pluck(),
    // A band holds no format-1 data_root (the header carries none, so
    // gateways disagree), but a gateway that computed one keeps it. Keyed by
    // transaction id, which names the same transaction on any fork.
    forgetKeptDataRoots: db.prepare('DELETE FROM parquet_l1_kept_data_roots'),
    keepDataRoots: db.prepare(`INSERT INTO parquet_l1_kept_data_roots
      SELECT id, data_root FROM stable_transactions
      WHERE height BETWEEN ? AND ? AND format = 1
        AND data_root IS NOT NULL AND length(data_root) > 0`),
    restoreDataRoots: db.prepare(`UPDATE stable_transactions
      SET data_root = k.data_root
      FROM parquet_l1_kept_data_roots k
      WHERE stable_transactions.id = k.id`),
    // Read before the range is cleared: see `keptTxRoots`.
    storedTxRoots:
      db.prepare(`SELECT height, indep_hash, tx_root FROM stable_blocks
      WHERE height BETWEEN ? AND ? AND tx_root IS NOT NULL`),
    haveTx: db
      .prepare('SELECT 1 FROM stable_transactions WHERE id = ?')
      .pluck(),
    btiOf: db
      .prepare(
        'SELECT block_transaction_index FROM stable_transactions WHERE id = ?',
      )
      .pluck(),
    pending: db.prepare(`INSERT OR REPLACE INTO parquet_l1_imports (band_id,
      height_from, height_to, band_digest, rows_imported, started_at,
      completed_at) VALUES (?, ?, ?, ?, NULL, ?, NULL)`),
    completed: db.prepare(`UPDATE parquet_l1_imports
      SET rows_imported = ?, completed_at = ? WHERE band_id = ?`),
    // An earlier attempt at these heights is finished with: this band
    // cleared the range and rewrote it. Leaving the row would hold
    // `haveTo` below a band nothing can ever finish — a tip superseded
    // by a wider one is never imported again under its old id — and the
    // planner would then read the band above it as a gap, for ever.
    forgetSuperseded: db.prepare(`DELETE FROM parquet_l1_imports
      WHERE completed_at IS NULL AND height_from >= ?
        AND MIN(height_to, ?) <= ?`),
    // A band replaces its own height range. Whatever is already there came
    // from an earlier attempt at this band, a band of another grid, or a
    // fork the chain has since dropped; none of it should outlive this.
    clearTags: db.prepare(
      'DELETE FROM stable_transaction_tags WHERE height BETWEEN ? AND ?',
    ),
    clearTxs: db.prepare(
      'DELETE FROM stable_transactions WHERE height BETWEEN ? AND ?',
    ),
    clearLinks: db.prepare(`DELETE FROM stable_block_transactions
      WHERE block_indep_hash IN
        (SELECT indep_hash FROM stable_blocks WHERE height BETWEEN ? AND ?)`),
    clearMissing: db.prepare(
      'DELETE FROM missing_transactions WHERE height BETWEEN ? AND ?',
    ),
    clearBlocks: db.prepare(
      'DELETE FROM stable_blocks WHERE height BETWEEN ? AND ?',
    ),
  };

  // The band's own time, not when it is being imported: importing the same
  // band twice must leave the same rows. Its top block's time, so every
  // publisher's copy of a band gives the same rows too (a band written
  // before band files were the same for every publisher carries when it
  // was built).
  const indexedAt = Math.floor(Date.parse(band.createdAt) / 1000);
  const keptTxRoots = new Map<number, { indepHash: Buffer; txRoot: Buffer }>();
  let rows = 0;
  let missingTransactions = 0;

  const blockColumns = spec('blocks').columns;
  const heightColumn = blockColumns.findIndex((c) => c.name === 'height');
  const hashColumn = blockColumns.findIndex((c) => c.name === 'indep_hash');
  const txRootColumn = blockColumns.findIndex((c) => c.name === 'tx_root');

  // Each writer returns the rows it wrote. Owners carry no height, so a
  // band's are all written whatever part of it is wanted: an owner row is
  // keyed by address and written only if missing.
  const writers: Record<string, (batch: unknown[][]) => number> = {
    wallets: (batch) => {
      for (const [address, modulus] of batch) {
        insert.wallets.run(
          asBuffer(address),
          modulus === null ? null : asBuffer(modulus),
        );
      }
      return batch.length;
    },
    blocks: (batch) => {
      let written = 0;
      for (const r of batch) {
        if (!wanted(Number(r[heightColumn]))) continue;
        written += 1;
        const values = r.map((v, i) =>
          v === null || v === undefined
            ? null
            : spec('blocks').columns[i].type === 'BLOB'
              ? asBuffer(v)
              : typeof v === 'bigint'
                ? Number(v)
                : v,
        );
        // A pre-fork `tx_root` is not committed by the block hash, so a
        // band's is just its publisher's header source talking: an `l1-2`
        // band holds none, and an `l1-1` band holds whatever the publisher
        // stored — empty bytes from vilenarios.com, 32 bytes elsewhere. A
        // gateway that indexed the block itself keeps its own, whatever the
        // band says: the insert replaces the row, so put it back.
        // `readTable` casts UBIGINT to VARCHAR (a UBIGINT arrives in node as
        // a double and would round), so a height here is a string.
        const kept = keptTxRoots.get(Number(values[heightColumn]));
        // Only for the same block: a row the band replaces may be a fork
        // the chain dropped, and its root belongs to that block alone.
        if (
          kept !== undefined &&
          kept.indepHash.equals(values[hashColumn] as Buffer)
        ) {
          values[txRootColumn] = kept.txRoot;
        }
        insert.blocks.run(...values);
      }
      return written;
    },
    transactions: (batch) => {
      let written = 0;
      for (const r of batch) {
        const [
          id,
          bti,
          ,
          target,
          quantity,
          reward,
          anchor,
          dataSize,
          contentType,
          format,
          height,
          owner,
          dataRoot,
          offset,
          contentEncoding,
          tagCount,
          signature,
        ] = r;
        if (!wanted(Number(height))) continue;
        written += 1;
        insert.transactions.run(
          asBuffer(id),
          Number(bti),
          target === null ? null : asBuffer(target),
          String(quantity),
          String(reward),
          asBuffer(anchor),
          // Nullable, and a partial index keys on `data_size > 0`, so a
          // missing size must stay missing rather than become a zero.
          dataSize === null ? null : Number(dataSize),
          contentType ?? null,
          Number(format),
          Number(height),
          asBuffer(owner),
          dataRoot === null ? null : asBuffer(dataRoot),
          offset === null ? null : Number(offset),
          contentEncoding ?? null,
          // NOT NULL in the schema: a band that carries no count would
          // otherwise abort the import part way through.
          tagCount === null ? 0 : Number(tagCount),
          signature === null ? null : asBuffer(signature),
          // A band carries no `indexed_at`, so that two publishers of the
          // same chain write the same rows; the importer supplies one.
          indexedAt,
        );
      }
      return written;
    },
    block_transactions: (batch) => {
      let written = 0;
      // Looked up rather than held in memory: a 100,000-height band has
      // about a million transactions, and a map of their ids would be
      // hundreds of megabytes. These are primary-key reads inside the
      // transaction, so they see the rows written moments ago.
      for (const [height, bti, txId] of batch) {
        const h = Number(height);
        if (!wanted(h)) continue;
        written += 1;
        const indepHash = insert.hashAt.get(h) as Buffer | undefined;
        if (indepHash === undefined) {
          throw new ImportRefused(
            `A link at height ${h} has no block in the band`,
          );
        }
        const id = asBuffer(txId);
        insert.link.run(indepHash, id, Number(bti));
        if (insert.haveTx.get(id) === undefined) {
          insert.missing.run(indepHash, id, h);
          missingTransactions += 1;
        }
      }
      return written;
    },
    tags: (batch) => {
      let written = 0;
      // The transaction's position comes from SQLite, where the band's
      // transactions already are. Joining the Parquet file for it would
      // re-scan every transaction of the band once per height window.
      for (const r of batch) {
        const [height, id, tagIndex, name, value] = r;
        if (!wanted(Number(height))) continue;
        written += 1;
        const bti = insert.btiOf.get(asBuffer(id));
        if (bti === null || bti === undefined) {
          throw new ImportRefused(
            `A tag at height ${Number(height)} names a transaction the band lacks`,
          );
        }
        const nameBytes = asBuffer(name);
        const valueBytes = asBuffer(value);
        const nameHash = sha1(nameBytes);
        const valueHash = sha1(valueBytes);
        insert.tagName.run(nameHash, nameBytes);
        insert.tagValue.run(valueHash, valueBytes);
        insert.tag.run(
          nameHash,
          valueHash,
          Number(height),
          Number(bti),
          Number(tagIndex),
          asBuffer(id),
        );
      }
      return written;
    },
  };

  const expected: Record<string, number> = Object.fromEntries(
    IMPORT_ORDER.map((t) => [t.name, band.tables[t.name]?.rows ?? 0]),
  );
  const total = Object.values(expected).reduce((sum, n) => sum + n, 0);
  const startedAt = now();
  let lastProgress = startedAt;
  let read = 0;
  let readBefore = 0;
  let sinceCommit = 0;
  let open = false;
  const begin = () => {
    if (open) return;
    db.exec('BEGIN IMMEDIATE');
    open = true;
  };
  const commit = async () => {
    if (!open) return;
    db.exec('COMMIT');
    open = false;
    sinceCommit = 0;
    if (yieldMs > 0) await sleep(yieldMs);
  };
  try {
    begin();
    // Recorded before a single row is written, so a crash leaves the band
    // marked unfinished rather than looking done, and the range is cleared
    // so what lands is the band's own content and nothing else.
    insert.pending.run(
      ledgerKey,
      from,
      to,
      bandDigest(band),
      Math.floor(Date.now() / 1000),
    );
    // An `l1-2` band holds no pre-fork `tx_root`: below the fork the field
    // is not committed by the block hash, publishers disagree on it, and
    // writing one value is what lets their digests match. A gateway that
    // indexed the chain itself does have one, and importing a band must not
    // erase it — so keep what is stored, before the range is cleared, and
    // put it back.
    if (from < FORK_2_0) {
      for (const row of insert.storedTxRoots.all(
        from,
        Math.min(to, FORK_2_0 - 1),
      ) as Array<{
        height: number;
        indep_hash: Buffer | null;
        tx_root: Buffer | string | null;
      }>) {
        const stored = row.tx_root;
        if (row.indep_hash !== null && stored !== null && stored.length > 0) {
          keptTxRoots.set(row.height, {
            indepHash: row.indep_hash,
            txRoot: Buffer.isBuffer(stored)
              ? stored
              : Buffer.from(stored, 'utf8'),
          });
        }
      }
    }
    insert.forgetKeptDataRoots.run();
    insert.keepDataRoots.run(from, to);
    // Offline the whole range goes at once. Online, a window at a time, each
    // its own transaction: clearing a range an earlier run left half
    // written can mean millions of rows, and one statement deleting them
    // would hold the gateway's writers off for minutes.
    const window = online ? Math.max(1, clearWindow) : to - from + 1;
    for (let low = from; low <= to; low += window) {
      const high = Math.min(to, low + window - 1);
      begin();
      insert.clearLinks.run(low, high);
      insert.clearTags.run(low, high);
      insert.clearTxs.run(low, high);
      insert.clearMissing.run(low, high);
      insert.clearBlocks.run(low, high);
      if (online) await commit();
    }
    for (const table of IMPORT_ORDER) {
      readBefore = read;
      // The row count comes from the batches as they arrive, not from
      // `readTable`'s return: the progress line needs a running total part
      // way through a table.
      await readTable(
        duck,
        dir,
        table,
        band,
        async (batch) => {
          // Online, the write lock is taken only once a batch is in hand,
          // never held while DuckDB reads the next one.
          begin();
          const written = writers[table.name](batch);
          rows += written;
          read += batch.length;
          sinceCommit += written;
          // Never between a block and the links that need its hash, nor
          // between a transaction and its tags: each table is finished
          // before the next begins, so a chunk boundary inside one is safe.
          if (online) {
            await commit();
          } else if (sinceCommit >= commitEvery) {
            await commit();
            begin();
          }
          if (progressEveryMs > 0 && now() - lastProgress >= progressEveryMs) {
            lastProgress = now();
            log.info('Importing a band', {
              id: entry.id,
              heightRange: band.heightRange,
              ...(heights !== undefined ? { heights } : {}),
              table: table.name,
              tableRows: `${read - readBefore}/${expected[table.name]}`,
              rows: read,
              ofRows: total,
              elapsedSeconds: Math.round((now() - startedAt) / 1000),
            });
          }
        },
        batchRows,
      );
    }
    begin();
    insert.restoreDataRoots.run();
    insert.forgetKeptDataRoots.run();
    insert.countMissing.run(from, to);
    insert.completed.run(rows, Math.floor(Date.now() / 1000), ledgerKey);
    // After this band's own row is complete, so it is not caught by it.
    insert.forgetSuperseded.run(from, ceiling, to);
    await commit();
  } catch (error) {
    if (open) db.exec('ROLLBACK');
    throw error;
  }
  log.info('Imported a band', {
    id: entry.id,
    heightRange: band.heightRange,
    ...(heights !== undefined ? { heights } : {}),
    rows,
    missingTransactions,
  });
  return { rows, missingTransactions };
}

export interface ImportRunResult {
  haveTo: number;
  outcomes: ImportOutcome[];
  /** Heights still missing after the run; the gateway must not be started on one. */
  holes: Array<[number, number]>;
  /** Bands on disk the run had no use for, with why. */
  skipped: Array<{
    id: string;
    heightRange: [number, number];
    reason: SkippedBand['reason'];
  }>;
}

/**
 * Imports every band of `bandsDir` that `core.db` is missing, lowest first,
 * stopping at the first that fails.
 *
 * Stopping matters: bands must be imported as a contiguous run, so carrying
 * on past a failure would leave a hole the block importer cannot cross.
 * What was imported before the failure is committed and the ledger records
 * it, so the next run picks up from there.
 */
export async function runImport({
  db,
  duck,
  bandsDir,
  log,
  limit,
  batchRows,
  commitEvery,
  from,
  to,
  onBand,
  disk,
}: {
  db: Sqlite.Database;
  duck: import('duckdb-async').Database;
  bandsDir: string;
  log: Logger;
  /** Import at most this many bands, for a first run an operator watches. */
  limit?: number;
  batchRows?: number;
  commitEvery?: number;
  /** Start here instead of continuing from the top of what `core.db` holds. */
  from?: number;
  /** Stop after the band covering this height. */
  to?: number;
  onBand?: (outcome: ImportOutcome) => void;
  /** Overrides for {@link assertDiskSpace}, for tests. */
  disk?: Partial<Parameters<typeof assertDiskSpace>[2]>;
}): Promise<ImportRunResult> {
  assertImportable(db);
  const bands = await readBands(bandsDir);
  if (bands.length === 0) {
    throw new ImportRefused(`${bandsDir} holds no bands with a ${BAND_FILE}`);
  }
  const progress = readProgress(db);
  const { steps, skipped } = planImport(bands, {
    ...progress,
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
  });
  if (progress.unfinished.length > 0) {
    // An earlier run was interrupted. Its band is imported again over
    // what it wrote, and anything it had reached above that band is
    // rewritten with it, so say so rather than leaving an operator to
    // wonder why the run starts below what `stable_blocks` holds.
    log.warn('An earlier run left a band unfinished; importing it again', {
      bands: progress.unfinished.map((b) => b.id),
      fromHeight: progress.haveTo + 1,
    });
  }
  log.info('Planned an import', {
    bandsOnDisk: bands.length,
    toImport: steps.length,
    skipped: skipped.length,
    fromHeight: progress.haveTo + 1,
  });
  const planned = steps.slice(0, limit ?? steps.length);
  const holes = remainingHoles(
    heldRuns(db),
    planned.map((b) => b.band.heightRange),
  );
  if (holes.length > 0) {
    // Not refused: a backfill done in stages legitimately leaves a hole
    // between runs, the same way `--max-bands` does going upward. But
    // the gateway must not be started on one, so it is said loudly and
    // carried in the result.
    log.warn('This run will leave heights uncovered', {
      holes,
      detail:
        'the block importer rewinds across a gap; close it before starting the gateway',
    });
  }
  await assertDiskSpace(db.name, planned, { log, ...disk });

  const outcomes: ImportOutcome[] = [];
  let haveTo = progress.haveTo;
  for (const entry of planned) {
    const started = Date.now();
    const base = { id: entry.id, heightRange: entry.band.heightRange };
    try {
      const { rows, missingTransactions } = await importBand(db, duck, entry, {
        log,
        ...(batchRows !== undefined ? { batchRows } : {}),
        ...(commitEvery !== undefined ? { commitEvery } : {}),
      });
      haveTo = entry.band.heightRange[1];
      const outcome: ImportOutcome = {
        ...base,
        result: 'imported',
        rows,
        missingTransactions,
        seconds: (Date.now() - started) / 1000,
      };
      outcomes.push(outcome);
      onBand?.(outcome);
    } catch (error) {
      const outcome: ImportOutcome = {
        ...base,
        result: 'refused',
        reason: error instanceof Error ? error.message : String(error),
        seconds: (Date.now() - started) / 1000,
      };
      outcomes.push(outcome);
      onBand?.(outcome);
      log.error('Import stopped', { id: entry.id, error: outcome.reason });
      break;
    }
  }
  return {
    haveTo,
    holes,
    outcomes,
    skipped: skipped.map((s) => ({
      id: s.band.id,
      heightRange: s.band.band.heightRange,
      reason: s.reason,
    })),
  };
}

export interface FillRunResult {
  /** The highest height the run could write: the bottom of what the gateway writes itself. */
  ceiling: number;
  outcomes: ImportOutcome[];
  /** Heights at or below the ceiling that no band on disk holds yet. */
  uncovered: Array<[number, number]>;
}

/** The highest height each band holds, which for a tip band is below its range's end. */
async function bandTops(
  duck: import('duckdb-async').Database,
  bands: ReadonlyArray<ImportableBand>,
): Promise<Map<string, number>> {
  const tops = new Map<string, number>();
  const file = spec('blocks').file;
  for (const entry of bands) {
    const where = path.join(entry.dir, file).replace(/'/g, "''");
    const [row] = await duck.all(
      `SELECT CAST(max(height) AS VARCHAR) AS top FROM read_parquet('${where}')`,
    );
    const top = row?.top as string | null | undefined;
    tops.set(entry.id, top === null || top === undefined ? -1 : Number(top));
  }
  return tops;
}

/**
 * Fills what `core.db` is missing beneath a gateway from the bands in
 * `bandsDir`, while the gateway runs.
 *
 * Writes only heights `stable_blocks` lacks at or below {@link fillCeiling},
 * and ranges an earlier run left unfinished. Nothing the gateway indexed
 * itself is rewritten, and nothing it is about to write is touched. Each
 * band read is checked whole, against its digests, even when only part of
 * it is written. Stops at the first band that fails; what landed before it
 * is committed, and the ledger lets the next run carry on.
 *
 * Safe to run on a schedule: a run with nothing to fill reads the band
 * directory and `stable_blocks`'s height index, and writes nothing.
 */
export async function runFill({
  db,
  duck,
  bandsDir,
  log,
  from,
  to,
  limit,
  batchRows = FILL_BATCH_ROWS,
  yieldMs = FILL_YIELD_MS,
  onBand,
  disk,
}: {
  db: Sqlite.Database;
  duck: import('duckdb-async').Database;
  bandsDir: string;
  log: Logger;
  from?: number;
  to?: number;
  /** Fill at most this many ranges, then stop. */
  limit?: number;
  batchRows?: number;
  yieldMs?: number;
  onBand?: (outcome: ImportOutcome) => void;
  disk?: Partial<Parameters<typeof assertDiskSpace>[2]>;
}): Promise<FillRunResult> {
  assertMigrated(db);
  const ceiling = fillCeiling(db);
  if (ceiling < 0) {
    log.info(
      'core.db holds no blocks yet, so there is nothing to fill beneath',
    );
    return { ceiling, outcomes: [], uncovered: [] };
  }
  let bands: ImportableBand[];
  try {
    bands = await readBands(bandsDir);
  } catch (error) {
    // No bands installed yet is the normal state of a new gateway.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    bands = [];
  }
  const redo = (
    db
      .prepare(
        'SELECT height_from AS a, height_to AS b FROM parquet_l1_imports WHERE completed_at IS NULL',
      )
      .all() as Array<{ a: number; b: number }>
  ).map((r): [number, number] => [r.a, r.b]);
  const { steps, uncovered } = planFill(bands, {
    held: heldRuns(db),
    ceiling,
    redo,
    top: await bandTops(duck, bands),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
  });
  const planned = steps.slice(0, limit ?? steps.length);
  log.info('Planned a fill', {
    ceiling,
    bandsOnDisk: bands.length,
    toFill: planned.map((step) => step.heights),
    ...(uncovered.length > 0 ? { uncovered } : {}),
  });
  if (planned.length === 0) return { ceiling, outcomes: [], uncovered };

  // A share of each band's rows, by the share of its heights written.
  const rows = planned.reduce((sum, step) => {
    const [bandFrom, bandTo] = step.band.band.heightRange;
    const share =
      (step.heights[1] - step.heights[0] + 1) / (bandTo - bandFrom + 1);
    const bandRows = Object.values(step.band.band.tables).reduce(
      (n, table) => n + table.rows,
      0,
    );
    return sum + Math.ceil(bandRows * share);
  }, 0);
  await assertDiskSpace(
    db.name,
    planned.map((step) => step.band),
    { log, rows, ...disk },
  );

  const outcomes: ImportOutcome[] = [];
  for (const step of planned) {
    const started = Date.now();
    const base = {
      id: step.band.id,
      heightRange: step.band.band.heightRange,
      heights: step.heights,
    };
    try {
      const { rows: written, missingTransactions } = await importBand(
        db,
        duck,
        step.band,
        {
          log,
          heights: step.heights,
          ledgerKey: fillLedgerKey(step),
          ceiling,
          online: true,
          yieldMs,
          batchRows,
        },
      );
      const outcome: ImportOutcome = {
        ...base,
        result: 'imported',
        rows: written,
        missingTransactions,
        seconds: (Date.now() - started) / 1000,
      };
      outcomes.push(outcome);
      onBand?.(outcome);
    } catch (error) {
      const outcome: ImportOutcome = {
        ...base,
        result: 'refused',
        reason: error instanceof Error ? error.message : String(error),
        seconds: (Date.now() - started) / 1000,
      };
      outcomes.push(outcome);
      onBand?.(outcome);
      log.error('Fill stopped', { id: step.band.id, error: outcome.reason });
      break;
    }
  }
  return { ceiling, outcomes, uncovered };
}
