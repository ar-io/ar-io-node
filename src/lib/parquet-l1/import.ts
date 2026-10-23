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
 * Runs with the gateway stopped: it writes `stable_*` directly. `--fill`
 * runs beside a running gateway instead, writing only the heights it lacks.
 *
 * **Nothing is written that was not verified first.** Before a band's first
 * row reaches SQLite, the band is checked whole with the same code as
 * `index-l1-verify --bands-dir` (`verify-bands.ts`, `judge.ts`), and bound
 * to the chain: by the block the gateway already holds above it (its
 * `previous_block` and `hash_list_merkle` must build on the band's top,
 * and that block was synced from the gateway's own nodes), or, with none,
 * by a network anchor (`--anchor-from`). It must also build on the block
 * held below it. Blocks the checks cannot bind (`unbound`: below the 2.0
 * fork, or holding a format-1 transaction with data, where the band
 * carries no `l1-4` witness for them) are refused unless accepted
 * (`--allow-unbound`, `--allow-unverified-format1`). An `l1-4` band's
 * witnesses bind both, so a whole chain of them imports with no flag.
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
 *
 * A band that fails part way (its rows changed under the run, say) is
 * cleared, rows and ledger row, offline as online: what a refused band
 * wrote never stays behind to be served.
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
  TableSpec,
} from './layout.js';
import { IMPORT_ORDER, readTable } from './read.js';
import {
  type ChainBlock,
  expectedHashListMerkle,
  FORK_2_0,
  PREDECESSOR_HAS_NO_MERKLE,
} from './chain.js';
import { anchorBlock } from './anchor.js';
import { readL1Bands } from './bands-dir.js';
import { BandsSource } from './bands-source.js';
import { verifyBands } from './verify-bands.js';
import type { L1Allowances } from './verify-run.js';
import type { VerifyCheck } from './checks.js';
import type { JudgeUnbound } from './judge.js';
import {
  MIN_CONFIRM,
  runSample,
  type SampleOptions,
  type SampleSummary,
} from './sample.js';
import type { ArweaveNodePool } from '../onchain/arweave-nodes.js';
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
  /** For a refusal: `unreadable` when only the sample could not be read ({@link ImportRefused}). */
  refusal?: 'refused' | 'unreadable';
  rows?: number;
  missingTransactions?: number;
  /** What the check before writing found (bound by, accepted, unbound, sample). */
  check?: ImportCheck;
  seconds: number;
}

const refusalOf = (error: unknown): 'refused' | 'unreadable' =>
  error instanceof ImportRefused ? error.kind : 'refused';

/**
 * Forgets every unfinished ledger row whose heights (up to `ceiling`)
 * completed imports started after it now cover between them — one of
 * another grid spanning two bands, say — so it is neither redone nor
 * held against the blocks those imports wrote.
 */
function forgetCoveredUnfinished(db: Sqlite.Database, ceiling: number): void {
  const unfinished = db
    .prepare(
      `SELECT band_id, height_from AS a, height_to AS b, started_at
       FROM parquet_l1_imports WHERE completed_at IS NULL`,
    )
    .all() as Array<{
    band_id: string;
    a: number;
    b: number;
    started_at: number;
  }>;
  if (unfinished.length === 0) return;
  const completed = db.prepare(
    `SELECT height_from AS a, height_to AS b FROM parquet_l1_imports
     WHERE completed_at IS NOT NULL AND started_at >= ?
       AND height_to >= ? AND height_from <= ?`,
  );
  const forget = db.prepare(
    'DELETE FROM parquet_l1_imports WHERE band_id = ? AND completed_at IS NULL',
  );
  for (const row of unfinished) {
    const top = Math.min(row.b, ceiling);
    if (top < row.a) continue;
    const over = (
      completed.all(row.started_at, row.a, top) as Array<{
        a: number;
        b: number;
      }>
    ).map((r): [number, number] => [r.a, r.b]);
    if (uncoveredBy(row.a, top, over).length === 0) forget.run(row.band_id);
  }
}

/** The parts of `[from, to]` none of `ranges` covers, in order. */
export function uncoveredBy(
  from: number,
  to: number,
  ranges: ReadonlyArray<readonly [number, number]>,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let next = from;
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    if (b < next || a > to) continue;
    if (a > next) out.push([next, a - 1]);
    next = Math.max(next, b + 1);
    if (next > to) break;
  }
  if (next <= to) out.push([next, to]);
  return out;
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

/**
 * Why a band was not written. `unreadable`: the sample could not be read
 * (too many draws unanswered: an outage, not evidence against the band),
 * so a caller may simply try again later; `refused`: anything else.
 */
export class ImportRefused extends Error {
  constructor(
    message: string,
    readonly kind: 'refused' | 'unreadable' = 'refused',
  ) {
    super(message);
  }
}

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
 * The busiest band averages about 470 rows a height (46.6M over 100,000
 * heights), so a window is typically under
 * 100,000 rows: a second or so of the write lock at worst. A clear that
 * finds nothing, the usual case, costs a few index probes.
 */
export const CLEAR_WINDOW_HEIGHTS = 200;

/**
 * The statements that clear a height range before a band rewrites it, in
 * the order they run: links and tags before the blocks and transactions
 * they are found through. Each must reach its rows through an index —
 * online they run once per window of heights, so a scan would read the
 * whole table hundreds of times a band. A test holds them to that.
 */
export const CLEAR_SQL = {
  links: `DELETE FROM stable_block_transactions
    WHERE block_indep_hash IN
      (SELECT indep_hash FROM stable_blocks WHERE height BETWEEN ? AND ?)`,
  // By transaction, not by height: the table's key leads with the tag
  // hashes, so a height range is a scan of every tag the gateway holds.
  // Every tag row belongs to a transaction at its height, and tags are
  // written after and cleared before their transactions, so this finds
  // them all.
  tags: `DELETE FROM stable_transaction_tags
    WHERE transaction_id IN
      (SELECT id FROM stable_transactions WHERE height BETWEEN ? AND ?)`,
  transactions: 'DELETE FROM stable_transactions WHERE height BETWEEN ? AND ?',
  missing: 'DELETE FROM missing_transactions WHERE height BETWEEN ? AND ?',
  blocks: 'DELETE FROM stable_blocks WHERE height BETWEEN ? AND ?',
} as const;

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
 * read (`readL1Bands`: an explicit listing, retired copies and stray
 * directories ignored, one copy of each installed band).
 *
 * The name has to be the band's identity because the name is the ledger's
 * key: a band recorded under heights or a digest it does not hold would
 * leave the planner certain of rows nothing wrote. So any entry that is not
 * a readable band named for what it holds refuses the run, named, rather
 * than being passed over. The grid itself is not checked here —
 * {@link planImport} refuses a gap or an overlap whatever grid a band came
 * from, and a publisher that changes the grid should not strand the bands
 * already published.
 *
 * @throws ImportRefused for an entry that is not such a band; the
 *   directory's own error (ENOENT, EACCES) when it cannot be read.
 */
export async function readBands(dir: string): Promise<ImportableBand[]> {
  const listing = await readL1Bands(dir);
  if (listing.problems.length > 0) {
    throw new ImportRefused(
      `${dir} holds entries that are not bands named for what they hold: ${listing.problems.map((p) => `${p.entry}: ${p.problem}`).join('; ')}`,
    );
  }
  return listing.bands.map(({ id, dir: bandDir, band }) => ({
    id,
    dir: bandDir,
    band,
  }));
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
    /**
     * Bands the ledger records as finished, by id, with the digest each
     * was imported with: a band under the same id with other tables (a
     * republished band) is not held.
     */
    held: ReadonlyMap<string, Buffer> | ReadonlySet<string>;
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
): {
  steps: ImportableBand[];
  skipped: SkippedBand[];
  /** Bands the ledger holds under the same id with other tables, imported again. */
  republished: string[];
} {
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
  const isHeld = (b: ImportableBand) => {
    if (held instanceof Map) {
      const digest = held.get(b.id);
      return digest !== undefined && digest.equals(bandDigest(b.band));
    }
    return held.has(b.id);
  };
  // A band the ledger holds under its id, but with other tables: its
  // publisher rebuilt it. Its range is imported again, wherever it lies —
  // a band rewrites only its own heights — and it is never counted held.
  const republished = bands.filter(
    (b) =>
      held instanceof Map &&
      held.has(b.id) &&
      !isHeld(b) &&
      !coveredByWider(b, bands) &&
      // Only within the heights asked for (--from/--to).
      (startAt === undefined || b.band.heightRange[1] >= startAt) &&
      (stopAt === undefined || b.band.heightRange[0] <= stopAt),
  );
  for (const candidate of bands) {
    if (republished.includes(candidate)) continue;
    const [from, to] = candidate.band.heightRange;
    const reason = isHeld(candidate)
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
  steps.push(...republished);
  steps.sort(
    (a, b) =>
      a.band.heightRange[0] - b.band.heightRange[0] ||
      a.band.heightRange[1] - b.band.heightRange[1],
  );
  return { steps, skipped, republished: republished.map((b) => b.id) };
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
 * room for the gateway to start afterwards. A band written over heights
 * that already hold rows goes in one transaction, so its whole size is in
 * the log at once; that is added per such band ({@link assertDiskSpace}'s
 * `walRows`: measured 38 MB of log for 140,000 rows written over held
 * rows, against 6.8 MB fresh).
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
    walRows,
  }: {
    log: Logger;
    statfs?: (path: string) => Promise<{ bsize: number; bavail: number }>;
    bytesPerRow?: number;
    headroom?: number;
    /** Rows the run will write, where that is not every row of `steps`. */
    rows?: number;
    /** Rows written in one transaction each (bands over held rows): their log is kept whole. */
    walRows?: number;
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
  const needed = (rows + (walRows ?? 0)) * bytesPerRow + headroom;
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

/** The migration that records how each imported range was bound. */
export const BINDING_MIGRATION =
  '2026.10.22T12.00.00.core.add-parquet-l1-import-binding.sql';

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
  const columns = new Set(
    db
      .prepare("SELECT name FROM pragma_table_info('parquet_l1_imports')")
      .pluck()
      .all() as string[],
  );
  if (migrated === undefined || !columns.has('binding')) {
    throw new ImportRefused(
      `core.db has not run ${migrated === undefined ? LEDGER_MIGRATION : BINDING_MIGRATION}: run \`yarn db:migrate up\` first, so the importer and the gateway agree on the schema`,
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
  /** Finished bands by id, with the digest each was imported with. */
  held: Map<string, Buffer>;
  unfinished: Array<{ id: string; from: number }>;
} {
  const span = db
    .prepare('SELECT MIN(height) AS lo, MAX(height) AS hi FROM stable_blocks')
    .get() as { lo: number | null; hi: number | null };
  const blocksFrom = span.lo ?? -1;
  const blocksTo = span.hi ?? -1;
  const held = new Map(
    (
      db
        .prepare(
          'SELECT band_id, band_digest FROM parquet_l1_imports WHERE completed_at IS NOT NULL',
        )
        .all() as Array<{ band_id: string; band_digest: Buffer }>
    ).map((r) => [r.band_id, r.band_digest]),
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
 * How a written range was bound to the chain, as its ledger row records
 * it: `anchored` (a network anchor at its top), `held` (the block the
 * gateway held above it, itself trusted), `unanchored` (accepted with
 * --allow-unanchored), plus the flags that accepted something. Only a range
 * bound `anchored` or `held` with nothing accepted may vouch, as the block
 * above, for a band imported below it.
 */
export interface ImportBinding {
  kind: 'anchored' | 'held' | 'unanchored';
  accepted: string[];
}

/** How an import is bound to the chain before it writes, and what it may accept. */
export interface ImportVerification {
  /** Sources for a network anchor where `core.db` holds no block above. */
  pool?: ArweaveNodePool;
  /** Distinct machines that must agree on a network anchor (default 2). */
  anchorMin?: number;
  /** Gaps the operator accepts (`--allow-*`, or `L1_BAND_IMPORT_ALLOW_UNVERIFIED`). */
  allow?: L1Allowances & {
    /** `--allow-unsampled`: write with no sample of headers and signatures. */
    unsampled?: boolean;
  };
  /** The sample drawn from the bands before writing; needs `pool`. */
  sample?: SampleOptions;
  /**
   * The chain's 2.0 seed folds, for a test chain below the 2.0 fork;
   * mainnet's (`FORK_2_0_FOLD_PINS`) otherwise. Never from a command line
   * or the environment.
   */
  foldPins?: ReadonlyMap<number, Buffer>;
}

type HeldBlock = Pick<
  ChainBlock,
  | 'height'
  | 'indep_hash'
  | 'previous_block'
  | 'weave_size'
  | 'tx_root'
  | 'hash_list_merkle'
>;

/**
 * The block the gateway holds at a height: from `stable_blocks`, or, above
 * them, from `new_blocks` — both its block importer fetched from its own
 * nodes. A `new_blocks` row on a fork that is later dropped does not build
 * on a canonical band, so it refuses the fill, which the next run retries.
 */
const heldBlockAt = (
  db: Sqlite.Database,
  height: number,
): HeldBlock | undefined => {
  for (const table of ['stable_blocks', 'new_blocks']) {
    const row = db
      .prepare(
        `SELECT height, indep_hash, previous_block, weave_size, tx_root, hash_list_merkle
         FROM ${table} WHERE height = ? LIMIT 1`,
      )
      .get(height) as HeldBlock | undefined;
    if (row !== undefined) return row;
  }
  return undefined;
};

/**
 * Whether `upper` builds on `lower`: its `previous_block` is `lower`'s hash,
 * and its `hash_list_merkle` is the one `lower` gives, where the era lets
 * one be computed. `undefined` when it does, else why not.
 */
function buildsOn(lower: HeldBlock, upper: HeldBlock): string | undefined {
  const asBuf = (v: Buffer | string | null) =>
    v === null ? null : Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8');
  const prev = asBuf(upper.previous_block);
  const hash = asBuf(lower.indep_hash);
  if (prev === null || hash === null || !prev.equals(hash)) {
    return `the block at ${upper.height} does not name the one at ${lower.height} as its previous_block`;
  }
  const want = expectedHashListMerkle(
    upper.height,
    {
      ...lower,
      tx_root: asBuf(lower.tx_root),
      hash_list_merkle: asBuf(lower.hash_list_merkle),
    } as ChainBlock,
    undefined,
  );
  if (want === PREDECESSOR_HAS_NO_MERKLE) {
    return `the block at ${lower.height} has no hash_list_merkle`;
  }
  if (want === undefined) return undefined;
  const got = asBuf(upper.hash_list_merkle);
  const ok =
    want === null
      ? got === null || got.length === 0
      : got !== null && want.equals(got);
  return ok
    ? undefined
    : `the block at ${upper.height} has a hash_list_merkle the one at ${lower.height} does not give`;
}

/**
 * Whether the block the gateway holds at `height` may vouch for a band
 * beneath it: a block the gateway indexed itself (no imported range covers
 * it), or one an import wrote bound `anchored` or `held` with nothing
 * accepted. A range written unanchored, with gaps accepted, before
 * bindings were recorded, or by an import that never finished vouches for
 * nothing.
 */
function heldBlockVouches(
  db: Sqlite.Database,
  height: number,
): string | undefined {
  // An import that never finished (it crashed, or was refused part way
  // online) left rows whose binding was never recorded: they vouch for
  // nothing until it is redone.
  // One a later import has since completed over these heights is
  // superseded here: its leftovers there were replaced.
  const unfinished = db
    .prepare(
      `SELECT u.band_id FROM parquet_l1_imports u
       WHERE u.completed_at IS NULL AND u.height_from <= ? AND u.height_to >= ?
         AND NOT EXISTS (
           SELECT 1 FROM parquet_l1_imports c
           WHERE c.completed_at IS NOT NULL
             AND c.height_from <= ? AND c.height_to >= ?
             AND c.started_at >= u.started_at)
       LIMIT 1`,
    )
    .pluck()
    .get(height, height, height, height) as string | undefined;
  if (unfinished !== undefined) {
    return `an import of ${unfinished} covering it never finished`;
  }
  const rows = db
    .prepare(
      `SELECT band_id, binding, accepted FROM parquet_l1_imports
       WHERE completed_at IS NOT NULL AND height_from <= ? AND height_to >= ?`,
    )
    .all(height, height) as Array<{
    band_id: string;
    binding: string | null;
    accepted: string | null;
  }>;
  for (const row of rows) {
    // Accepting no sample leaves the block hashes, weave sizes and roots as
    // bound as ever; accepting a gap in that binding does not.
    let gaps: string[] = [];
    try {
      gaps = (JSON.parse(row.accepted ?? '[]') as string[]).filter((flag) =>
        UNBINDING_FLAGS.includes(flag),
      );
    } catch {
      gaps = ['an unreadable record'];
    }
    const trusted =
      (row.binding === 'anchored' || row.binding === 'held') &&
      row.accepted !== null &&
      gaps.length === 0;
    if (!trusted) {
      return `it was imported from ${row.band_id} bound ${row.binding ?? 'by nothing recorded'}${gaps.length > 0 ? ` accepting ${gaps.join(', ')}` : ''}`;
    }
  }
  return undefined;
}

/** Flags that accept a gap in a range's binding: such a range vouches for nothing below it. */
export const UNBINDING_FLAGS = [
  '--allow-unanchored',
  '--allow-unbound',
  '--allow-incomplete',
  '--allow-unverified-format1',
];

/** What the check before an import found, as the import reports it. */
export interface ImportCheck {
  /** How the heights were bound, in words. */
  boundBy: string;
  binding: ImportBinding;
  /** Every flag that accepted something for these heights. */
  accepted: string[];
  unbound: JudgeUnbound;
  skipped: string[];
  assurance: string[];
  sample?: SampleSummary;
}

/**
 * Checks bands before a row of them is written: whole, by the code
 * `index-l1-verify --bands-dir` runs (lookups aside: nothing imports them),
 * then against `core.db` at both edges of `heights`, bound to the chain —
 * by the block the gateway holds above `heights` when that block may vouch
 * ({@link heldBlockVouches}), else by a network anchor — and, through the
 * sample, for what nothing else binds: transaction ids, their order and
 * every transaction field.
 *
 * @throws ImportRefused naming every check that failed.
 */
export async function verifyBeforeImport(
  db: Sqlite.Database,
  duck: import('duckdb-async').Database,
  bandsDir: string,
  bands: ImportableBand[],
  heights: [number, number],
  verification: ImportVerification,
  log: Logger,
): Promise<ImportCheck> {
  const allow = verification.allow ?? {};
  // Sources that are fewer distinct machines than a refutation or an
  // attestation needs can settle neither: a configuration to fix, said
  // before the bands are read, not an outage to wait out.
  if (verification.pool !== undefined) {
    const pool = verification.pool;
    await pool.ready();
    const machines = new Set(pool.urls.map((u) => pool.addressOf(u))).size;
    const need = Math.max(MIN_CONFIRM, verification.anchorMin ?? MIN_CONFIRM);
    if (machines < need) {
      throw new ImportRefused(
        `the sources (--anchor-from) are ${machines} distinct machine${machines === 1 ? '' : 's'}, fewer than the ${need} the anchor and the sample need: add sources`,
      );
    }
  }
  const out = await verifyBands(duck, bandsDir, {
    only: bands.map((b) => b.id),
    lookups: false,
    // Anchored here, below, against what core.db holds.
    allow: { ...allow, unanchored: true },
    ...(verification.foldPins !== undefined
      ? { foldPins: verification.foldPins }
      : {}),
  });
  const failing = out.checks.filter((c) => !c.ok);
  const refuse = (what: string, checks: VerifyCheck[]) =>
    new ImportRefused(
      `${what}: ${checks
        .map(
          (c) =>
            `${c.name} (${(c.failures ?? [])
              .slice(0, 3)
              .map((f) => `${f.height}: ${f.found}`)
              .join('; ')})`,
        )
        .join('; ')}`,
    );
  if (failing.length > 0) throw refuse('the bands do not verify', failing);
  const source = new BandsSource(duck, bands);
  const [from, to] = heights;
  const bandAt = async (h: number): Promise<HeldBlock | undefined> => {
    const row = await source.blockAt(h);
    return row === undefined
      ? undefined
      : {
          height: row.height,
          indep_hash: row.indep_hash as Buffer,
          previous_block: row.previous_block,
          weave_size: String(row.weave_size),
          tx_root: row.tx_root,
          hash_list_merkle: row.hash_list_merkle,
        };
  };
  const bottom = await bandAt(from);
  const top = await bandAt(to);
  if (bottom === undefined || top === undefined) {
    throw new ImportRefused(
      `the bands hold no block at ${bottom === undefined ? from : to}`,
    );
  }
  const below = from > 0 ? heldBlockAt(db, from - 1) : undefined;
  if (below !== undefined) {
    const problem = buildsOn(below, bottom);
    if (problem !== undefined) {
      throw new ImportRefused(
        `the band does not build on the block core.db holds below it: ${problem}`,
      );
    }
  }
  // Lookups are not imported, and the anchor is decided here.
  const accepted = out.accepted.filter(
    (f) => f !== '--allow-unanchored' && f !== '--skip-lookups',
  );
  let binding: ImportBinding | undefined;
  let boundBy = '';
  const notes: string[] = [];
  const above = heldBlockAt(db, to + 1);
  if (above !== undefined) {
    const problem = buildsOn(top, above);
    if (problem !== undefined) {
      throw new ImportRefused(
        `the block core.db holds above the band does not build on it: ${problem}`,
      );
    }
    const doubt = heldBlockVouches(db, to + 1);
    if (doubt === undefined) {
      binding = { kind: 'held', accepted };
      boundBy = `the block core.db holds at ${to + 1} builds on the band's top`;
    } else {
      notes.push(`the block core.db holds at ${to + 1} cannot vouch: ${doubt}`);
    }
  }
  if (binding === undefined && verification.pool !== undefined) {
    const result = await anchorBlock(
      verification.pool,
      to,
      await source.blockAt(to),
      await source.idsAt(to),
      verification.anchorMin ?? 2,
    );
    if (!result.ok) {
      // Too few machines answered at all, and none said anything against
      // the band: an outage to wait out, not a refusal of the band.
      const outage =
        result.mismatches.length === 0 &&
        result.sources.every(
          (src) =>
            src.indepHash !== undefined ||
            (src.error ?? '').startsWith('did not answer'),
        ) &&
        result.sources.some((src) =>
          (src.error ?? '').startsWith('did not answer'),
        ) &&
        new Set(result.sources.flatMap((src) => src.indepHash ?? [])).size <=
          1 &&
        result.problems.every((p) => /distinct machine\(s\) answered/.test(p));
      throw new ImportRefused(
        `the band's top block at ${to} is not anchored: ${[...notes, ...result.problems].join('; ')}`,
        outage ? 'unreadable' : 'refused',
      );
    }
    binding = { kind: 'anchored', accepted };
    boundBy = `the band's top block at ${to} is anchored: ${result.machines} machines agreed on ${result.indepHash ?? ''}, recomputed`;
  }
  if (binding === undefined) {
    if (allow.unanchored !== true) {
      throw new ImportRefused(
        `nothing binds heights ${from}-${to} to the chain: ${notes.length > 0 ? notes.join('; ') : `core.db holds no block at ${to + 1} to build on them`}, and no --anchor-from was given (or --allow-unanchored)`,
      );
    }
    log.warn('Importing bands bound to nothing (--allow-unanchored)', {
      heights,
    });
    binding = {
      kind: 'unanchored',
      accepted: [...accepted, '--allow-unanchored'],
    };
    boundBy = 'nothing (--allow-unanchored)';
  }

  // The sample: what neither the judge nor the binding reaches.
  const skipped = out.skipped.filter(
    (s) => s !== 'anchor' && s !== 'sample' && s !== 'lookups',
  );
  const assurance = out.assurance.filter(
    (a) => !a.startsWith('not anchored') && !a.startsWith('no sample'),
  );
  let sample: SampleSummary | undefined;
  const options = verification.sample;
  if (verification.pool !== undefined && options !== undefined) {
    // A half-skipped sample is a skipped one, for the half. Without the
    // transaction draw, nothing checks transaction ids or fields; without
    // the format-1 draw, nothing catches a transaction relabelled into
    // blocks whose tx_root is accepted unverified.
    const format1 = options.format1PerStratum ?? options.txsPerStratum;
    const gaps: Array<[string, string, string | undefined]> = [];
    if (options.blocks <= 0) {
      gaps.push(['sample_blocks', '--sample-blocks 0', undefined]);
    }
    if (options.txsPerStratum <= 0) {
      gaps.push([
        'sample_txs',
        '--sample-txs 0',
        'transaction ids and every transaction field would be unchecked',
      ]);
    }
    if (format1 <= 0) {
      gaps.push([
        'sample_format1',
        '--sample-format1 0',
        out.unbound.txRootFormat1 !== undefined
          ? 'a transaction relabelled format 1 in the blocks accepted with --allow-unverified-format1 would be unchecked'
          : undefined,
      ]);
    }
    const unchecked = gaps.flatMap(([, , why]) =>
      why === undefined ? [] : [why],
    );
    if (unchecked.length > 0 && allow.unsampled !== true) {
      throw new ImportRefused(
        `the sample asked for leaves part of the bands unchecked (${gaps.map(([, flag]) => flag).join(', ')}): ${unchecked.join('; ')}; sample it, or --allow-unsampled`,
      );
    }
    for (const [name, flag] of gaps) {
      skipped.push(name);
      binding.accepted.push(flag);
    }
    if (unchecked.length > 0) binding.accepted.push('--allow-unsampled');
    const drawn = await runSample(
      source,
      verification.pool,
      { from, to },
      options,
    );
    if (drawn.refuted) {
      throw refuse('the sample refutes the bands', [drawn.check]);
    }
    if (!drawn.check.ok) {
      throw new ImportRefused(
        `the sample could not be read, so the bands are not written yet (an outage is not a refutation; the next run tries again): ${drawn.check.failures
          ?.slice(0, 3)
          .map((f) => f.found)
          .join('; ')}`,
        'unreadable',
      );
    }
    sample = drawn.summary;
    skipped.push(...drawn.summary.empty);
    assurance.push(...drawn.summary.warnings, ...drawn.summary.detects);
  } else if (allow.unsampled === true) {
    binding.accepted.push('--allow-unsampled');
    skipped.push('sample');
    assurance.push(
      'no sample (--allow-unsampled): transaction ids, their order and every transaction field are unchecked against the chain',
    );
  } else {
    throw new ImportRefused(
      `no sample can be drawn (no --anchor-from): transaction ids, their order and every transaction field would be unchecked; give sources, or --allow-unsampled`,
    );
  }
  return {
    boundBy,
    binding,
    accepted: binding.accepted,
    unbound: out.unbound,
    skipped,
    assurance: [boundBy, ...assurance],
    ...(sample !== undefined ? { sample } : {}),
  };
}

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
    leftovers = [],
    binding,
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
    /**
     * Ranges an earlier run left unfinished (its ledger row never
     * completed): rows there are that run's leftovers, which this one
     * replaces. Online, any other row already in the heights refuses the
     * band: a fill writes only what the gateway lacks.
     */
    leftovers?: ReadonlyArray<readonly [number, number]>;
    /** How the band was bound to the chain, recorded in the ledger. */
    binding?: ImportBinding;
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
      SET rows_imported = ?, completed_at = ?, binding = ?, accepted = ?
      WHERE band_id = ?`),
    // An earlier attempt at these heights is finished with: this band
    // cleared the range and rewrote it. Leaving the row would hold
    // `haveTo` below a band nothing can ever finish — a tip superseded
    // by a wider one is never imported again under its old id — and the
    // planner would then read the band above it as a gap, for ever.
    forgetAttempt: db.prepare(
      'DELETE FROM parquet_l1_imports WHERE band_id = ? AND completed_at IS NULL',
    ),
    forgetSuperseded: db.prepare(`DELETE FROM parquet_l1_imports
      WHERE completed_at IS NULL AND height_from >= ?
        AND MIN(height_to, ?) <= ?`),
    // A band replaces its own height range. Whatever is already there came
    // from an earlier attempt at this band, a band of another grid, or a
    // fork the chain has since dropped; none of it should outlive this.
    clearTags: db.prepare(CLEAR_SQL.tags),
    // Whether anything at these heights needs clearing; each an index probe.
    anyRows: db
      .prepare(
        `SELECT
      EXISTS (SELECT 1 FROM stable_blocks WHERE height BETWEEN ? AND ?)
      OR EXISTS (SELECT 1 FROM stable_transactions WHERE height BETWEEN ? AND ?)
      OR EXISTS (SELECT 1 FROM missing_transactions WHERE height BETWEEN ? AND ?)
      AS present`,
      )
      .pluck(),
    clearTxs: db.prepare(CLEAR_SQL.transactions),
    clearLinks: db.prepare(CLEAR_SQL.links),
    clearMissing: db.prepare(CLEAR_SQL.missing),
    clearBlocks: db.prepare(CLEAR_SQL.blocks),
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
  // Whether this attempt has committed anything yet: a failure before that
  // is undone by the rollback alone.
  let committed = false;
  const begin = () => {
    if (open) return;
    db.exec('BEGIN IMMEDIATE');
    open = true;
  };
  const commit = async () => {
    if (!open) return;
    db.exec('COMMIT');
    open = false;
    committed = true;
    sinceCommit = 0;
    if (yieldMs > 0) await sleep(yieldMs);
  };
  // After some errors, SQLITE_FULL or SQLITE_IOERR say, SQLite has already
  // rolled the transaction back itself, and a ROLLBACK then throws. Thrown
  // from the catch below, it would replace the error being handled and skip
  // the online clear.
  const rollback = () => {
    open = false;
    try {
      if (db.inTransaction) db.exec('ROLLBACK');
    } catch (rollbackError) {
      log.warn('Could not roll back', {
        id: entry.id,
        error: (rollbackError as Error).message,
      });
    }
  };
  // Offline the whole range goes at once. Online, a window at a time, each
  // its own transaction: clearing a range an earlier run left half written
  // can mean millions of rows, and one statement deleting them would hold
  // the gateway's writers off for minutes.
  const window = online ? Math.max(1, clearWindow) : to - from + 1;
  const clearRange = async () => {
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
  };
  // Rows already in the heights, before this attempt. Offline, the band is
  // then written as one transaction, so a failure leaves them exactly as
  // they were (the gateway's own rows, or a band imported before); online,
  // only rows an earlier unfinished run left may be replaced.
  const preexisting = insert.anyRows.get(from, to, from, to, from, to) === 1;
  if (preexisting && online) {
    // Only an earlier unfinished run's heights may hold rows: every part of
    // the range outside them must be empty.
    for (const [a, b] of uncoveredBy(from, to, leftovers)) {
      if (insert.anyRows.get(a, b, a, b, a, b) === 1) {
        throw new ImportRefused(
          `heights ${a}-${b} already hold rows that no unfinished import left: a fill writes only heights the gateway lacks`,
        );
      }
    }
  }
  const whole = preexisting && !online;
  const commitAt = whole ? Number.POSITIVE_INFINITY : commitEvery;
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
    // A hole the gateway never held, the usual case online, has nothing to
    // clear: an earlier run that wrote anything there wrote its blocks first.
    const clear =
      !online || insert.anyRows.get(from, to, from, to, from, to) === 1;
    if (clear) await clearRange();
    // Online, nothing is held while the first batch is read, cleared or not.
    if (online) await commit();
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
          } else if (sinceCommit >= commitAt) {
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
    insert.completed.run(
      rows,
      Math.floor(Date.now() / 1000),
      binding?.kind ?? null,
      binding === undefined ? null : JSON.stringify(binding.accepted),
      ledgerKey,
    );
    // After this band's own row is complete, so it is not caught by it.
    insert.forgetSuperseded.run(from, ceiling, to);
    forgetCoveredUnfinished(db, ceiling);
    await commit();
  } catch (error) {
    rollback();
    // Only what this attempt committed is removed. Nothing committed (the
    // whole-band transaction over heights that held rows, or a failure
    // before the first commit): the rollback restored everything, the
    // ledger row included. Otherwise the heights held nothing before but
    // leftovers this attempt replaced, so clearing them and the ledger row
    // removes only this attempt's rows, and the run reports the hole.
    if (!committed) throw error;
    try {
      await clearRange();
      begin();
      insert.forgetAttempt.run(ledgerKey);
      await commit();
    } catch (cleanupError) {
      rollback();
      log.error('Could not clear a range that failed to import', {
        id: entry.id,
        heights: [from, to],
        error: (cleanupError as Error).message,
      });
    }
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
  /** Bands imported again because the ledger held other tables under their id. */
  republished: string[];
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
 * Every planned band is verified and bound to the chain first
 * ({@link verifyBeforeImport}); a plan that does not verify writes nothing.
 *
 * Stopping matters: bands must be imported as a contiguous run, so carrying
 * on past a failure would leave a hole the block importer cannot cross.
 * Bands imported before the failure are committed and the ledger records
 * them, so the next run picks up from there; the band that failed is
 * cleared, and `holes` is read from what the database then holds.
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
  verification = {},
}: {
  db: Sqlite.Database;
  duck: import('duckdb-async').Database;
  bandsDir: string;
  log: Logger;
  /** How the bands are bound to the chain before a row is written. */
  verification?: ImportVerification;
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
  const { steps, skipped, republished } = planImport(bands, {
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
  // A band over heights that already hold rows is one transaction: the
  // log holds all of it at once.
  // The same probe as importBand's `anyRows`, which decides that.
  const holdsRows = db.prepare(
    `SELECT EXISTS (SELECT 1 FROM stable_blocks WHERE height BETWEEN ? AND ?)
       OR EXISTS (SELECT 1 FROM stable_transactions WHERE height BETWEEN ? AND ?)
       OR EXISTS (SELECT 1 FROM missing_transactions WHERE height BETWEEN ? AND ?)`,
  );
  const walRows = planned.reduce((sum, step) => {
    const [a, b] = step.band.heightRange;
    return (holdsRows.pluck().get(a, b, a, b, a, b) as number) === 1
      ? sum + Object.values(step.band.tables).reduce((n, t) => n + t.rows, 0)
      : sum;
  }, 0);
  await assertDiskSpace(db.name, planned, { log, walRows, ...disk });

  const outcomes: ImportOutcome[] = [];
  const haveTo = progress.haveTo;
  // Every planned band, checked whole and bound to the chain, before the
  // first row is written: each contiguous run of the plan is checked as
  // one, and bound once, at its top (a republished band is a run of its
  // own, beneath blocks the database holds).
  const runs: ImportableBand[][] = [];
  for (const entry of planned) {
    const last = runs.at(-1)?.at(-1);
    if (
      last !== undefined &&
      entry.band.heightRange[0] === last.band.heightRange[1] + 1
    ) {
      runs[runs.length - 1].push(entry);
    } else {
      runs.push([entry]);
    }
  }
  const checks = new Map<string, ImportCheck>();
  for (const run of runs) {
    const span: [number, number] = [
      run[0].band.heightRange[0],
      run[run.length - 1].band.heightRange[1],
    ];
    const started = Date.now();
    try {
      const check = await verifyBeforeImport(
        db,
        duck,
        bandsDir,
        run,
        span,
        verification,
        log,
      );
      for (const entry of run) checks.set(entry.id, check);
      log.info('Verified the bands before importing', {
        heights: span,
        boundBy: check.boundBy,
        accepted: check.accepted,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const outcome: ImportOutcome = {
        id: run[0].id,
        heightRange: run[0].band.heightRange,
        result: 'refused',
        reason,
        refusal: refusalOf(error),
        seconds: (Date.now() - started) / 1000,
      };
      onBand?.(outcome);
      log.error('Import refused before writing', { error: reason });
      return {
        haveTo,
        holes: remainingHoles(heldRuns(db), []),
        outcomes: [outcome],
        skipped: skipped.map((s) => ({
          id: s.band.id,
          heightRange: s.band.band.heightRange,
          reason: s.reason,
        })),
        republished,
      };
    }
  }
  for (const entry of planned) {
    const started = Date.now();
    const base = { id: entry.id, heightRange: entry.band.heightRange };
    try {
      const check = checks.get(entry.id);
      const { rows, missingTransactions } = await importBand(db, duck, entry, {
        log,
        ...(batchRows !== undefined ? { batchRows } : {}),
        ...(commitEvery !== undefined ? { commitEvery } : {}),
        ...(check !== undefined ? { binding: check.binding } : {}),
      });
      const outcome: ImportOutcome = {
        ...base,
        result: 'imported',
        rows,
        missingTransactions,
        ...(check !== undefined ? { check } : {}),
        seconds: (Date.now() - started) / 1000,
      };
      outcomes.push(outcome);
      onBand?.(outcome);
    } catch (error) {
      const outcome: ImportOutcome = {
        ...base,
        result: 'refused',
        reason: error instanceof Error ? error.message : String(error),
        refusal: refusalOf(error),
        seconds: (Date.now() - started) / 1000,
      };
      outcomes.push(outcome);
      onBand?.(outcome);
      log.error('Import stopped', { id: entry.id, error: outcome.reason });
      break;
    }
  }
  return {
    // Read back, not tracked: finishing an interrupted band below held
    // blocks raises the trustworthy top past that band.
    haveTo: readProgress(db).haveTo,
    // What the database holds now, not what the plan meant it to: a band
    // refused part way was cleared, and leaves its heights missing.
    holes: remainingHoles(heldRuns(db), []),
    outcomes,
    republished,
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
 * and ranges an earlier run left unfinished. Apart from such a range,
 * which is rewritten whole, nothing the gateway indexed itself is
 * rewritten, and nothing it is about to write is touched. Each
 * band read is checked whole — its digests, the judge, and the blocks held
 * on either side of the heights written ({@link verifyBeforeImport}) —
 * even when only part of it is written. Ranges are filled from the top
 * down, so each is bound by the block above it; the run stops at the first
 * that fails, which is cleared, and what landed before it stays.
 *
 * Safe to run on a schedule: a run with nothing to fill reads the band
 * directory, each band's block file, the ledger and the block height
 * index, and writes nothing to `core.db`.
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
  verification = {},
}: {
  db: Sqlite.Database;
  duck: import('duckdb-async').Database;
  bandsDir: string;
  log: Logger;
  /** How each range is bound to the chain before a row is written. */
  verification?: ImportVerification;
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
  // A directory that cannot be read is an error, never an empty one: the
  // worker decides beforehand whether a directory never created means a
  // gateway with nothing installed yet.
  const bands = await readBands(bandsDir);
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
  // Filled from the top down: each range is then bound by the block the
  // gateway holds above it, its own or one the range above just wrote, and
  // checked, so trust runs down from what the gateway synced itself.
  // `limit` keeps the highest ranges, for the same reason.
  const planned = steps.slice(
    Math.max(0, steps.length - (limit ?? steps.length)),
  );
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
  for (const step of [...planned].reverse()) {
    const started = Date.now();
    const base = {
      id: step.band.id,
      heightRange: step.band.band.heightRange,
      heights: step.heights,
    };
    try {
      const check = await verifyBeforeImport(
        db,
        duck,
        bandsDir,
        [step.band],
        step.heights,
        verification,
        log,
      );
      log.info('Verified a band before filling from it', {
        id: step.band.id,
        heights: step.heights,
        boundBy: check.boundBy,
        accepted: check.accepted,
      });
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
          leftovers: redo,
          binding: check.binding,
        },
      );
      const outcome: ImportOutcome = {
        ...base,
        result: 'imported',
        rows: written,
        missingTransactions,
        check,
        seconds: (Date.now() - started) / 1000,
      };
      outcomes.push(outcome);
      onBand?.(outcome);
    } catch (error) {
      const outcome: ImportOutcome = {
        ...base,
        result: 'refused',
        reason: error instanceof Error ? error.message : String(error),
        refusal: refusalOf(error),
        seconds: (Date.now() - started) / 1000,
      };
      outcomes.push(outcome);
      onBand?.(outcome);
      log.error('Fill stopped', { id: step.band.id, error: outcome.reason });
      break;
    }
  }
  outcomes.sort(
    (a, b) =>
      (a.heights?.[0] ?? a.heightRange[0]) -
      (b.heights?.[0] ?? b.heightRange[0]),
  );
  return { ceiling, outcomes, uncovered };
}
