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
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { Logger } from 'winston';

import { bandPublisherTag } from '../../../lib/index-band/build.js';
import { supersededBands } from '../../../lib/index-publication.js';
import {
  BAND_FILE,
  bandTablesDigest,
  L1_SPAN,
  L1_SUB_SPAN,
  l1RangeOf,
  l1SubRangeOf,
  MAX_BAND_FILE_BYTES,
  parseBandFile,
  ParquetL1Band,
} from '../../../lib/parquet-l1/layout.js';
import * as metrics from '../../metrics.js';
import {
  exportL1Band,
  isTransientSqliteError,
  L1CheckError,
  L1IncompleteError,
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
  const all: L1PublishedBand[] = [];
  for (const name of await fs.readdir(publishDir).catch(() => [] as string[])) {
    if (name.startsWith('.')) continue;
    const dir = path.join(publishDir, name);
    const file = path.join(dir, BAND_FILE);
    const stat = await fs.stat(file).catch(() => undefined);
    if (stat === undefined || stat.size > MAX_BAND_FILE_BYTES) continue;
    let band: ParquetL1Band;
    try {
      band = parseBandFile(await fs.readFile(file, 'utf8'));
    } catch {
      continue;
    }
    all.push({
      id: name,
      dir,
      from: band.heightRange[0],
      to: band.heightRange[1],
      band,
    });
  }
  const superseded = supersededBands(
    all.map(({ id, band }) => ({
      id,
      files: [],
      ...(band.supersedes !== undefined
        ? { metadata: { supersedes: band.supersedes } }
        : {}),
    })),
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
): L1Step[] {
  if (top < 0) return [];
  const steps: L1Step[] = [];
  const covers = (from: number, to: number) => [
    ...new Set([
      ...superseded.filter((id) => {
        const m = /^l1-h(\d+)-(\d+)-/.exec(id);
        return m !== null && Number(m[1]) >= from && Number(m[2]) <= to;
      }),
      ...bands
        .filter(
          (b) =>
            b.from >= from && b.to <= to && !(b.from === from && b.to === to),
        )
        .map((b) => b.id),
    ]),
  ];
  const have = (from: number, to: number) =>
    bands.some((b) => b.from === from && b.to === to);

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
  if (!bands.some((b) => b.from === tipFrom && b.to >= top)) {
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
