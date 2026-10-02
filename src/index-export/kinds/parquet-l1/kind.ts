/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * What to build for the `parquet-l1` index, and building it.
 *
 * Bands cover the fixed height ranges of {@link l1RangeOf}: 0 to 499,999
 * (the sparse early chain), then every 25,000 (`L1_SPAN`). A range below the
 * top is built once and never changes; the range the top falls in is a tip
 * band, rebuilt as the top moves and superseding the tip bands before it.
 * Ranges are built in order, from height 0, because an importer imports a
 * contiguous run.
 */
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Logger } from 'winston';

import { bandPublisherTag } from '../../../lib/index-band/build.js';
import { supersededBands } from '../../../lib/index-publication.js';
import {
  BAND_FILE,
  l1RangeOf,
  MAX_BAND_FILE_BYTES,
  parseBandFile,
  ParquetL1Band,
} from '../../../lib/parquet-l1/layout.js';
import * as metrics from '../../metrics.js';
import { exportL1Band, L1CheckError, L1IncompleteError } from './export.js';

export const L1_INDEX = 'parquet-l1';

export interface L1PublishedBand {
  id: string;
  dir: string;
  from: number;
  to: number;
  band: ParquetL1Band;
}

export interface L1Step {
  /** `h` for a whole range, `d` for the tip band. */
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
 * The bands to build, in order: every whole range up to `top` that isn't
 * published, then the tip band if `top` has moved past the published one.
 * `top` is the highest height a band may hold: one below the stable top, so
 * every band's last block is anchored by the block above it.
 *
 * Each supersedes this publisher's shorter bands from the same start
 * (earlier tip bands), and the ones before those it remembers (`superseded`),
 * so a subscriber that missed a tip band still keeps its old one until the
 * new one installs.
 */
export function planL1(
  bands: L1PublishedBand[],
  top: number,
  superseded: string[] = [],
): L1Step[] {
  if (top < 0) return [];
  const steps: L1Step[] = [];
  const [tipFrom, tipTo] = l1RangeOf(top);
  const shorter = (from: number, to: number) => [
    ...new Set([
      ...superseded.filter((id) => id.startsWith(`l1-h${from}-`)),
      ...bands.filter((b) => b.from === from && b.to < to).map((b) => b.id),
    ]),
  ];
  for (let from = 0; from < tipFrom; ) {
    const [, to] = l1RangeOf(from);
    if (!bands.some((b) => b.from === from && b.to === to)) {
      steps.push({
        role: 'h',
        heightRange: [from, to],
        supersedes: shorter(from, to),
      });
    }
    from = to + 1;
  }
  const whole = top === tipTo;
  if (!bands.some((b) => b.from === tipFrom && b.to >= top)) {
    steps.push({
      role: whole ? 'h' : 'd',
      heightRange: [tipFrom, top],
      supersedes: shorter(tipFrom, top),
    });
  }
  return steps;
}

/** A band's id: its heights, its publisher, and a digest of its rows and heights. */
export function l1BandId(band: ParquetL1Band, publisher: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify(band.heightRange))
    .update(
      Object.keys(band.tables)
        .sort()
        .map((t) => `${t}:${band.tables[t].rows}:${band.tables[t].rowDigest}`)
        .join('\n'),
    )
    .digest('hex')
    .slice(0, 12);
  const [from, to] = band.heightRange;
  return [
    'l1',
    `h${from}`,
    String(to),
    bandPublisherTag(publisher),
    digest,
  ].join('-');
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
  }: {
    coreDbPath: string;
    workDir: string;
    publishDir: string;
    publisher: string;
    dryRun: boolean;
    log: Logger;
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
    const result = await exportL1Band({
      coreDbPath,
      workDir,
      from,
      to,
      supersedes: step.supersedes,
      requireComplete: step.role === 'h',
    });
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
