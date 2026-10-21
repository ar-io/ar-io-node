/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Upgrading a published `parquet-l2` band in place to layout `l2-2`: its
 * key lookup and stats are derived from its own tables, for the tag names
 * its index is configured with, and added under the band's id, which the
 * lookups never enter. No row is read from the source, nothing is header
 * checked, and no file already in the band changes, so a subscriber that
 * holds the band fetches the two new files and the new `band.json`. As an
 * L1 band gains its lookups (`runL1Derive`).
 *
 * An `l2-2` band derived for other tag names than the index's now is
 * derived again the same way: the two files are replaced, and the swarm
 * takes it as a band rebuilt under the same id.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Logger } from 'winston';

import { BAND_FILE } from '../../../lib/parquet-l1/layout.js';
import {
  hasDerivedTags,
  keyLookup,
  PARQUET_L2_SCHEMA,
  ParquetL2Band,
  serializeBandFile,
  statsLookup,
} from '../../../lib/parquet-l2/layout.js';
import {
  verifyBandLookups,
  writeBandLookups,
} from '../../../lib/parquet-l2/lookups.js';
import { checkParquetStructure } from '../../../lib/parquet/check.js';
import * as metrics from '../../metrics.js';
import type { L2LiveBand } from './bands.js';
import type { L2IndexConfig } from './config.js';
import { DEFAULT_L2_DUCK_LIMITS, L2DuckLimits, withL2Duck } from './export.js';

export interface L2DeriveOutcome {
  index: string;
  id: string;
  heightRange: [number, number];
  /** `published`: the files and the new `band.json` are in place. */
  result: 'published' | 'couldnt_check' | 'dry_run';
  reason: string;
  details?: string[];
  /** Rows per file derived. */
  rows?: Record<string, number>;
  seconds: number;
}

const sameNames = (a: readonly string[] | undefined, b: readonly string[]) =>
  a !== undefined && a.length === b.length && a.every((n, i) => n === b[i]);

/**
 * Whether a published band carries the key lookup and stats its index is
 * configured for: layout `l2-2`, derived for the same tag names.
 */
export function derivedCurrent(
  band: Pick<ParquetL2Band, 'schema' | 'keyTags' | 'statTags'>,
  index: Pick<L2IndexConfig, 'keyTags' | 'statTags'>,
): boolean {
  return (
    hasDerivedTags(band.schema) &&
    sameNames(band.keyTags, index.keyTags ?? []) &&
    sameNames(band.statTags, index.statTags ?? [])
  );
}

/** The live bands to upgrade in place: those not {@link derivedCurrent}. */
export function planL2Derive(
  bands: L2LiveBand[],
  index: Pick<L2IndexConfig, 'keyTags' | 'statTags'>,
): L2LiveBand[] {
  return bands.filter((band) => !derivedCurrent(band.band, index));
}

/**
 * Derives a published band's key lookup and stats from its own tables and
 * adds them, in place, under the band's id.
 *
 * The files are written in `workDir` (on the band's filesystem), checked
 * against the tables and for the footer subscribers accept, moved into the
 * band, and only then is `band.json` replaced, by a rename: a reader that
 * goes by `band.json` sees the old band or the new one, never files its
 * description doesn't name. A crash part-way leaves files the old
 * description doesn't name, which readers ignore and the next run writes
 * again.
 */
export async function runL2Derive(
  band: L2LiveBand,
  index: L2IndexConfig,
  {
    workDir,
    dryRun,
    log,
    stillHeld,
    limits = DEFAULT_L2_DUCK_LIMITS,
  }: {
    workDir: string;
    dryRun: boolean;
    log: Logger;
    /** Asked just before the band is changed, as for a build. */
    stillHeld?: () => Promise<boolean>;
    limits?: L2DuckLimits;
  },
): Promise<L2DeriveOutcome> {
  const started = Date.now();
  const base = {
    index: index.name,
    id: band.id,
    heightRange: [band.from, band.to] as [number, number],
  };
  const keyTags = index.keyTags ?? [];
  const statTags = index.statTags ?? [];
  const layout = { schema: PARQUET_L2_SCHEMA, keyTags, statTags } as const;
  const specs = [keyLookup(keyTags), statsLookup(statTags)];
  let outcome: L2DeriveOutcome;
  await fs.mkdir(workDir, { recursive: true });
  const staging = await fs.mkdtemp(path.join(workDir, '.band-derive-l2-'));
  try {
    const derived = await withL2Duck(staging, limits, async (duck) => {
      const written = await writeBandLookups(duck, band.dir, {
        layout,
        only: specs.map((spec) => spec.name),
        outDir: staging,
      });
      // The band's own lookups stay as they are; only what was written
      // here is checked, against the band's tables it was derived from.
      const problems = await verifyBandLookups(
        duck,
        band.dir,
        { ...layout, lookups: written },
        { only: specs.map((spec) => spec.name), lookupsDir: staging },
      );
      return { written, problems };
    });
    const rows = Object.fromEntries(
      Object.entries(derived.written).map(([name, l]) => [name, l.rows]),
    );
    if (derived.problems.length > 0) {
      throw new Error(
        `The derived files don't match the band's tables: ${derived.problems.join('; ')}`,
      );
    }
    // Subscribers refuse a footer over the limit: check before publishing,
    // and in a dry run, so it reports a file that couldn't be published.
    for (const spec of specs) {
      await checkParquetStructure(path.join(staging, spec.file));
    }
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
      for (const spec of specs) {
        await fs.rename(
          path.join(staging, spec.file),
          path.join(band.dir, spec.file),
        );
      }
      const { keyTags: _k, statTags: _s, ...rest } = band.band;
      const next: ParquetL2Band = {
        ...rest,
        schema: PARQUET_L2_SCHEMA,
        keyTags: [...keyTags],
        statTags: [...statTags],
        lookups: { ...band.band.lookups, ...derived.written },
      };
      const temporary = path.join(band.dir, `.${BAND_FILE}.tmp`);
      await fs.writeFile(temporary, serializeBandFile(next));
      await fs.rename(temporary, path.join(band.dir, BAND_FILE));
      outcome = {
        ...base,
        result: 'published',
        reason: hasDerivedTags(band.band.schema) ? 'tags_changed' : 'layout',
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
    index: index.name,
    kind: 'derive',
    result: outcome.result,
    reason: outcome.reason,
  });
  log.info('L2 band key lookup and stats derived', { ...outcome });
  return outcome;
}
