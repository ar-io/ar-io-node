/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * What to build for the `parquet-l1` index, and building it.
 *
 * Bands cover two nested uniform grids, the same for every publisher:
 * whole {@link L1_SPAN} ranges ({@link l1RangeOf}), and whole
 * {@link L1_SUB_SPAN} sub-ranges ({@link l1SubRangeOf}) inside the range the
 * chain's top falls in.
 *
 * L1 is append-only, so a completed range or sub-range is built once and
 * never changes. Only the sub-range holding the top — the tip — is rebuilt
 * as the top moves, superseding the tips before it, until it completes and
 * becomes a sub-range band of its own. A whole range supersedes the
 * sub-ranges beneath it. See {@link planL1}.
 *
 * Bands are built in order, from height 0, because an importer imports a
 * contiguous run.
 *
 * A published band whose tables are current but whose lookups are not (an
 * `l1-2` band once `l1-3` is the layout) is never rebuilt: its lookups are
 * derived from its own tables and added in place ({@link planL1Derive},
 * {@link runL1Derive}), keeping its id.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { Logger } from 'winston';

import { bandPublisherTag } from '../../../lib/index-band/build.js';
import { supersededBands } from '../../../lib/index-publication.js';
import type { Database } from 'duckdb-async';

import {
  BAND_FILE,
  bandSupersedes,
  bandTablesDigest,
  bandTime,
  L1_SPAN,
  L1_SUB_SPAN,
  l1RangeOf,
  l1SubRangeOf,
  lookupsCurrent,
  lookupsOf,
  PARQUET_L1_SCHEMA,
  PARQUET_L1_TABLES,
  ParquetL1Band,
  readBandDirectory,
  readPublisherFacts,
  serializeBandFile,
  tablesCurrent,
  writePublisherFacts,
} from '../../../lib/parquet-l1/layout.js';
import { writeBandLookups } from '../../../lib/parquet-l1/lookups.js';
import * as metrics from '../../metrics.js';
import {
  exportL1Band,
  isTransientSqliteError,
  L1CheckError,
  L1IncompleteError,
  withBandWriter,
} from './export.js';

export const L1_INDEX = 'parquet-l1';

/** Times a band is rebuilt after a read of `core.db` was refused, and the delay before each. */
export const READ_RETRIES = 2;
export const READ_RETRY_DELAY_MS = 15_000;

export interface L1PublishedBand {
  id: string;
  dir: string;
  from: number;
  to: number;
  band: ParquetL1Band;
}

export interface L1Step {
  /** `h` for a whole history range, `d` for a sub-range or the tip. */
  role: 'h' | 'd';
  heightRange: [number, number];
  supersedes: string[];
}

export interface L1Outcome {
  index: typeof L1_INDEX;
  role: 'h' | 'd';
  heightRange: [number, number];
  result: 'published' | 'unchanged' | 'rejected' | 'couldnt_check' | 'dry_run';
  reason: string;
  details?: string[];
  id?: string;
  /** What the band names as superseded. */
  supersedes?: string[];
  rows?: Record<string, number>;
  missingTransactions?: number;
  missingWallets?: number;
  strayTransactions?: number;
  scratchBytes?: number;
  bandBytes?: number;
  seconds: number;
}

/** This publisher's live `parquet-l1` bands: not superseded, with a readable band file. */
export async function deriveL1Bands(
  publishDir: string,
  publisher: string,
): Promise<L1PublishedBand[]> {
  const tag = bandPublisherTag(publisher);
  const all: L1PublishedBand[] = (await readBandDirectory(publishDir)).map(
    (found) => ({
      ...found,
      from: found.band.heightRange[0],
      to: found.band.heightRange[1],
    }),
  );
  const superseded = supersededBands(
    await Promise.all(
      all.map(async (found) => {
        const supersedes = await bandSupersedes(found);
        return {
          id: found.id,
          files: [],
          ...(supersedes !== undefined ? { metadata: { supersedes } } : {}),
        };
      }),
    ),
  );
  return all
    .filter((b) => !superseded.has(b.id) && b.id.split('-')[3] === tag)
    .sort((a, b) => a.from - b.from || a.to - b.to);
}

/**
 * The bands to build, in order, and never more than one per range.
 *
 * `top` is the highest height a band may hold: one below the stable top, so
 * every band's last block is anchored by the block above it.
 *
 * Three levels, because L1 is append-only — a finalised height's rows never
 * change, so only the tip is ever rebuilt:
 *
 * | Role | Covers | Built |
 * | --- | --- | --- |
 * | `h` | a whole {@link L1_SPAN} range | once the range is below `top`; supersedes its `d` bands |
 * | `d` | a whole {@link L1_SUB_SPAN} sub-range | once the sub-range is below `top`; never rebuilt |
 * | tip (`d`) | the one incomplete sub-range | each run `top` has moved; supersedes the tips before it |
 *
 * History is built before the sub-ranges beneath the tip, so an importer
 * reading in height order sees the cheapest covering set first.
 *
 * Each step supersedes this publisher's bands that its own range covers, and
 * the ids it remembers superseding (`superseded`), so a subscriber that
 * missed one still keeps its old band until the new one installs.
 */
export function planL1(
  bands: L1PublishedBand[],
  top: number,
  superseded: string[] = [],
  /** Older-layout bands already rebuilt and found identical; see {@link tablesCurrent}. */
  confirmed: ReadonlySet<string> = new Set(),
): L1Step[] {
  if (top < 0) return [];
  const steps: L1Step[] = [];
  // Current tables are enough: missing lookups are derived, not rebuilt.
  const current = (b: L1PublishedBand) =>
    tablesCurrent(b.band.schema, b.id, confirmed);
  const covers = (from: number, to: number) => [
    ...new Set([
      ...superseded.filter((id) => {
        const m = /^l1-h(\d+)-(\d+)-/.exec(id);
        return m !== null && Number(m[1]) >= from && Number(m[2]) <= to;
      }),
      ...bands
        .filter(
          (b) =>
            b.from >= from &&
            b.to <= to &&
            // A band of this exact range still counts as covered when it
            // was written to an older layout: the rebuilt one has to
            // supersede it, or a subscriber would keep both.
            (!(b.from === from && b.to === to) || !current(b)),
        )
        .map((b) => b.id),
    ]),
  ];
  // A range is only covered by a band of the layout this build writes, so
  // upgrading a publisher rebuilds what the new layout changes instead of
  // leaving the network split across versions.
  const have = (from: number, to: number) =>
    bands.some((b) => b.from === from && b.to === to && current(b));

  // Whole history ranges, oldest first.
  const [activeFrom] = l1RangeOf(top);
  for (let from = 0; from < activeFrom; from += L1_SPAN) {
    const to = from + L1_SPAN - 1;
    if (!have(from, to)) {
      steps.push({
        role: 'h',
        heightRange: [from, to],
        supersedes: covers(from, to),
      });
    }
  }

  // Inside the range the top falls in: whole sub-ranges, then the tip.
  const [tipFrom] = l1SubRangeOf(top);
  for (let from = activeFrom; from < tipFrom; from += L1_SUB_SPAN) {
    const to = from + L1_SUB_SPAN - 1;
    if (!have(from, to)) {
      steps.push({
        role: 'd',
        heightRange: [from, to],
        supersedes: covers(from, to),
      });
    }
  }
  if (!bands.some((b) => b.from === tipFrom && b.to >= top && current(b))) {
    steps.push({
      role: 'd',
      heightRange: [tipFrom, top],
      supersedes: covers(tipFrom, top),
    });
  }
  return steps;
}

/** A band's id: its heights, its publisher, and a digest of its rows and heights. */
export function l1BandId(band: ParquetL1Band, publisher: string): string {
  const digest = bandTablesDigest(band).toString('hex').slice(0, 12);
  const [from, to] = band.heightRange;
  return [
    'l1',
    `h${from}`,
    String(to),
    bandPublisherTag(publisher),
    digest,
  ].join('-');
}

/**
 * Runs an export, building the band again when a read of `core.db` was
 * refused for a reason that passes (see {@link isTransientSqliteError}).
 * Anything else, including a chain check, is thrown at once: rebuilding
 * would only fail the same way.
 */
export async function withReadRetry<T>(
  run: () => Promise<T>,
  {
    log,
    heightRange,
    retries = READ_RETRIES,
    delayMs = READ_RETRY_DELAY_MS,
    sleep = (ms: number) => setTimeout(ms),
  }: {
    log: Logger;
    heightRange: [number, number];
    retries?: number;
    delayMs?: number;
    sleep?: (ms: number) => Promise<unknown>;
  },
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt > retries || !isTransientSqliteError(error)) throw error;
      const delay = delayMs * attempt;
      log.warn('A read of core.db was refused; building this band again', {
        heightRange,
        attempt,
        delayMs: delay,
        error: (error as Error).message,
      });
      await sleep(delay);
    }
  }
}

/** Exports, checks and (unless a dry run) publishes one band. */
export async function runL1Step(
  step: L1Step,
  {
    coreDbPath,
    workDir,
    publishDir,
    publisher,
    dryRun,
    log,
    stillHeld,
  }: {
    coreDbPath: string;
    workDir: string;
    publishDir: string;
    publisher: string;
    dryRun: boolean;
    log: Logger;
    /**
     * Whether this run still holds the lock: asked just before publishing,
     * so a run that stalled past its lock never publishes beside another.
     */
    stillHeld?: () => Promise<boolean>;
  },
): Promise<L1Outcome> {
  const started = Date.now();
  const [from, to] = step.heightRange;
  const base = {
    index: L1_INDEX,
    role: step.role,
    heightRange: step.heightRange,
    ...(step.supersedes.length > 0 ? { supersedes: step.supersedes } : {}),
  } as const;
  let outcome: L1Outcome;
  try {
    // The gateway writes to core.db while this reads it, so a read can be
    // refused mid-band during a WAL checkpoint. That costs the whole band,
    // so it is retried here rather than left for the next run.
    const result = await withReadRetry(
      () =>
        exportL1Band({
          coreDbPath,
          workDir,
          from,
          to,
          supersedes: step.supersedes,
          requireComplete: step.role === 'h',
        }),
      { log, heightRange: step.heightRange },
    );
    const id = l1BandId(result.band, publisher);
    const staging = path.dirname(result.dir);
    const facts = {
      id,
      rows: Object.fromEntries(
        Object.entries(result.band.tables).map(([t, v]) => [t, v.rows]),
      ),
      missingTransactions: result.missingTransactions,
      missingWallets: result.missingWallets,
      strayTransactions: result.strayTransactions,
      scratchBytes: result.scratchBytes,
      bandBytes: result.bandBytes,
    };
    try {
      const target = path.join(publishDir, id);
      const exists = await fs.stat(path.join(target, BAND_FILE)).then(
        () => true,
        () => false,
      );
      if (dryRun) {
        outcome = {
          ...base,
          ...facts,
          result: 'dry_run',
          reason: 'dry_run',
          seconds: 0,
        };
      } else if (stillHeld !== undefined && !(await stillHeld())) {
        outcome = {
          ...base,
          ...facts,
          result: 'couldnt_check',
          reason: 'lock_lost',
          details: ['another run took the lock while this one stalled'],
          seconds: 0,
        };
      } else if (exists) {
        outcome = {
          ...base,
          ...facts,
          result: 'unchanged',
          reason: 'same_id',
          seconds: 0,
        };
      } else {
        await fs.mkdir(publishDir, { recursive: true });
        await fs.rename(result.dir, target);
        outcome = {
          ...base,
          ...facts,
          result: 'published',
          reason: 'new',
          seconds: 0,
        };
      }
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outcome =
      error instanceof L1CheckError
        ? {
            ...base,
            result: 'rejected',
            reason: 'chain',
            details: [message],
            seconds: 0,
          }
        : {
            ...base,
            result: 'couldnt_check',
            reason:
              error instanceof L1IncompleteError ? 'incomplete' : 'source',
            details: [message],
            seconds: 0,
          };
  }
  outcome.seconds = (Date.now() - started) / 1000;
  metrics.runs.inc({
    index: L1_INDEX,
    kind: step.role,
    result: outcome.result,
    reason: outcome.reason,
  });
  log.info('L1 band step finished', { ...outcome });
  return outcome;
}

/**
 * The time of a published band's top block, from its own blocks table: the
 * `createdAt` every publisher of the band's rows writes.
 */
export async function bandTopTime(
  duck: Database,
  band: L1PublishedBand,
): Promise<string> {
  const blocks = PARQUET_L1_TABLES.find((t) => t.name === 'blocks')!.file;
  const file = path.join(band.dir, blocks).replace(/'/g, "''");
  const [row] = (await duck.all(
    `SELECT CAST(block_timestamp AS BIGINT) AS ts FROM read_parquet('${file}') WHERE height = ${band.to}`,
  )) as Array<{ ts: bigint | number }>;
  if (row === undefined) {
    throw new Error(`band ${band.id} has no block ${band.to} to date it by`);
  }
  return bandTime(Number(row.ts));
}

/**
 * Puts a band's description in place as every publisher of its rows writes
 * it ({@link serializeBandFile}), keeping what is this publisher's own, the
 * bands it replaces and when it was built, beside it in `.publisher.json`.
 *
 * The facts are written first: a crash between the two leaves an old
 * `band.json` and a facts file naming the same bands, which readers agree
 * on, and the next run finishes the job. `band.json` is replaced by a
 * rename, so a reader sees one whole description or the other.
 */
export async function settleBandFile(
  band: L1PublishedBand,
  next: ParquetL1Band,
): Promise<void> {
  const facts = await readPublisherFacts(band.dir);
  const supersedes = facts?.supersedes ?? band.band.supersedes;
  // A band written before the facts file held its build time in band.json.
  const builtAt =
    facts?.builtAt ?? (facts === undefined ? band.band.createdAt : undefined);
  await writePublisherFacts(band.dir, {
    ...(supersedes !== undefined && supersedes.length > 0
      ? { supersedes }
      : {}),
    ...(builtAt !== undefined ? { builtAt } : {}),
  });
  const temporary = path.join(band.dir, `.${BAND_FILE}.tmp`);
  await fs.writeFile(temporary, serializeBandFile(next));
  await fs.rename(temporary, path.join(band.dir, BAND_FILE));
}

/**
 * Whether a published band's description is already as every publisher of
 * its rows writes it: canonical, with nothing of this publisher's in it, and
 * the publisher's facts beside it. Reads only the two small files.
 */
export async function bandFileSettled(band: L1PublishedBand): Promise<boolean> {
  if (band.band.supersedes !== undefined) return false;
  if (
    (await readPublisherFacts(band.dir).catch(() => undefined)) === undefined
  ) {
    return false;
  }
  const text = await fs
    .readFile(path.join(band.dir, BAND_FILE), 'utf8')
    .catch(() => undefined);
  return text === serializeBandFile(band.band);
}

/** What settling one published band's description came to. */
export interface L1NormalizeOutcome {
  index: typeof L1_INDEX;
  id: string;
  heightRange: [number, number];
  /** `published`: the band's `band.json` is now as every publisher writes it. */
  result: 'published' | 'couldnt_check' | 'dry_run';
  reason: string;
  details?: string[];
  seconds: number;
}

/**
 * The published bands whose `band.json` is not yet as every publisher of
 * their rows writes it: those written before band files were made the same
 * for every publisher. Each is settled in place under its id, its rows
 * untouched, so subscribers fetch only the new `band.json`.
 */
export async function planL1Normalize(
  bands: L1PublishedBand[],
): Promise<L1PublishedBand[]> {
  const settled = await Promise.all(bands.map(bandFileSettled));
  return bands.filter((_, i) => !settled[i]);
}

/**
 * Settles one published band's `band.json` ({@link settleBandFile}), dating
 * it by its top block. Reads one column of the band's blocks table; no read
 * of `core.db`, and no file of the band's rows changes.
 */
export async function runL1Normalize(
  band: L1PublishedBand,
  {
    workDir,
    dryRun,
    log,
    stillHeld,
  }: {
    workDir: string;
    dryRun: boolean;
    log: Logger;
    /** Asked just before the band is changed, as for a build. */
    stillHeld?: () => Promise<boolean>;
  },
): Promise<L1NormalizeOutcome> {
  const started = Date.now();
  const base = {
    index: L1_INDEX,
    id: band.id,
    heightRange: [band.from, band.to] as [number, number],
  } as const;
  let outcome: L1NormalizeOutcome;
  await fs.mkdir(workDir, { recursive: true });
  const staging = await fs.mkdtemp(path.join(workDir, 'normalize-'));
  try {
    const createdAt = await withBandWriter(staging, (duck) =>
      bandTopTime(duck, band),
    );
    if (dryRun) {
      outcome = { ...base, result: 'dry_run', reason: 'dry_run', seconds: 0 };
    } else if (stillHeld !== undefined && !(await stillHeld())) {
      outcome = {
        ...base,
        result: 'couldnt_check',
        reason: 'lock_lost',
        details: ['another run took the lock while this one stalled'],
        seconds: 0,
      };
    } else {
      await settleBandFile(band, { ...band.band, createdAt });
      outcome = { ...base, result: 'published', reason: 'settled', seconds: 0 };
    }
  } catch (error) {
    outcome = {
      ...base,
      result: 'couldnt_check',
      reason: 'normalize',
      details: [error instanceof Error ? error.message : String(error)],
      seconds: 0,
    };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
  outcome.seconds = (Date.now() - started) / 1000;
  metrics.runs.inc({
    index: L1_INDEX,
    kind: 'normalize',
    result: outcome.result,
    reason: outcome.reason,
  });
  log.info('L1 band file settled', { ...outcome });
  return outcome;
}

/** What deriving one published band's lookups came to. */
export interface L1DeriveOutcome {
  index: typeof L1_INDEX;
  id: string;
  heightRange: [number, number];
  /** `published`: the lookups and the new `band.json` are in place. */
  result: 'published' | 'couldnt_check' | 'dry_run';
  reason: string;
  details?: string[];
  /** Rows per lookup. */
  rows?: Record<string, number>;
  seconds: number;
}

/**
 * The published bands to upgrade by deriving their lookups: tables current
 * (see {@link tablesCurrent}), lookups not. Never a rebuild, and no read of
 * `core.db`.
 */
export function planL1Derive(
  bands: L1PublishedBand[],
  confirmed: ReadonlySet<string> = new Set(),
): L1PublishedBand[] {
  return bands.filter(
    (b) =>
      tablesCurrent(b.band.schema, b.id, confirmed) &&
      !lookupsCurrent(b.band.schema),
  );
}

/**
 * Derives a published band's lookups from its own tables and adds them, in
 * place, under the band's id.
 *
 * The lookups are written in `workDir` (on the band's filesystem), moved
 * into the band, and only then is the band's `band.json` replaced, by a
 * rename: a reader that goes by `band.json` (publisher, subscriber,
 * importer) sees the old band or the new one, never lookups its description
 * doesn't name. No file already in the band is touched. A crash part-way
 * leaves lookup files the old description doesn't name, which readers
 * ignore and the next run writes again.
 */
export async function runL1Derive(
  band: L1PublishedBand,
  {
    workDir,
    dryRun,
    log,
    stillHeld,
  }: {
    workDir: string;
    dryRun: boolean;
    log: Logger;
    /** Asked just before the band is changed, as for a build. */
    stillHeld?: () => Promise<boolean>;
  },
): Promise<L1DeriveOutcome> {
  const started = Date.now();
  const base = {
    index: L1_INDEX,
    id: band.id,
    heightRange: [band.from, band.to] as [number, number],
  } as const;
  let outcome: L1DeriveOutcome;
  await fs.mkdir(workDir, { recursive: true });
  const staging = await fs.mkdtemp(path.join(workDir, 'derive-'));
  try {
    const { lookups, createdAt } = await withBandWriter(
      staging,
      async (duck) => ({
        lookups: await writeBandLookups(duck, band.dir, staging),
        createdAt: await bandTopTime(duck, band),
      }),
    );
    const rows = Object.fromEntries(
      Object.entries(lookups).map(([name, l]) => [name, l.rows]),
    );
    if (dryRun) {
      outcome = {
        ...base,
        result: 'dry_run',
        reason: 'dry_run',
        rows,
        seconds: 0,
      };
    } else if (stillHeld !== undefined && !(await stillHeld())) {
      outcome = {
        ...base,
        result: 'couldnt_check',
        reason: 'lock_lost',
        details: ['another run took the lock while this one stalled'],
        rows,
        seconds: 0,
      };
    } else {
      for (const spec of lookupsOf(PARQUET_L1_SCHEMA)) {
        await fs.rename(
          path.join(staging, spec.file),
          path.join(band.dir, spec.file),
        );
      }
      await settleBandFile(band, {
        version: 1,
        schema: PARQUET_L1_SCHEMA,
        heightRange: band.band.heightRange,
        tables: band.band.tables,
        lookups,
        createdAt,
      });
      outcome = {
        ...base,
        result: 'published',
        reason: 'lookups',
        rows,
        seconds: 0,
      };
    }
  } catch (error) {
    outcome = {
      ...base,
      result: 'couldnt_check',
      reason: 'derive',
      details: [error instanceof Error ? error.message : String(error)],
      seconds: 0,
    };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
  outcome.seconds = (Date.now() - started) / 1000;
  metrics.runs.inc({
    index: L1_INDEX,
    kind: 'derive',
    result: outcome.result,
    reason: outcome.reason,
  });
  log.info('L1 band lookups derived', { ...outcome });
  return outcome;
}
