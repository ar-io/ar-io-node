/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Builds one planned root-TX band: the folded band's entries and every
 * source's records for the step's heights go through the band library's
 * merge, and the gate decides before anything is renamed into place.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Logger } from 'winston';

import {
  BandRecord,
  bandContentDigest,
  buildBand,
  BuiltBand,
  OVERLAY_CHANGED_TAG,
  PublishDecision,
  SCATTER_RECORD_BYTES,
  StagedBand,
} from '../../../lib/index-band/build.js';
import { openBandRecords } from '../../../lib/index-band/read.js';
import {
  checkBandHeaders,
  RootSourceFactory,
} from '../../../lib/index-band/verify.js';
import * as metrics from '../../metrics.js';
import type { BuildStep } from './planner.js';
import { REPAIRED_TAG, RecordSource, SourceStats } from './sources/rows.js';

export const INDEX_NAME = 'root-tx-index';

/** A band under this many entries is skipped, not published or failed. */
export const MIN_RECORDS = 1000;
/** A band whose conflicting IDs exceed this share is rejected. */
export const CONFLICT_CAP = 0.01;
/** Header-check samples: general, and per tag. */
export const SAMPLE_SIZE = 150;
export const SAMPLE_SIZES = { [REPAIRED_TAG]: 50, [OVERLAY_CHANGED_TAG]: 200 };

export type StepResult =
  | 'published'
  | 'unchanged'
  | 'skipped'
  | 'couldnt_check'
  | 'rejected'
  | 'dry_run';

export interface StepOutcome {
  role: BuildStep['role'];
  heightRange: BuildStep['heightRange'];
  result: StepResult;
  reason: string;
  /** Reasons and samples for an operator. */
  details?: string[];
  band?: BuiltBand;
  /** Records given, by source (and `folded`). */
  inputs: Record<string, number>;
  seconds: number;
  /** Scratch plus the finished band, an upper bound for the disk a build needs. */
  peakBytes?: number;
}

export interface StepContext {
  log: Logger;
  publisher: string;
  publishDir: string;
  workDir: string;
  sources: RecordSource[];
  /** Sources whose failure is counted and skipped, not fatal. */
  optional: Set<string>;
  openRoot: RootSourceFactory;
  dryRun: boolean;
  /** Whether this run still holds its lock; nothing publishes once it doesn't. */
  stillHeld?: () => Promise<boolean>;
  /** The run's clock, stamped into the band manifest. */
  now?: () => number;
  /** Overrides for the header check's read retries (tests). */
  headerCheck?: { retries?: number; retryDelayMs?: number };
}

/**
 * Build failures that are not about reaching a source: the same records give
 * the same failure, so retrying only repeats the work.
 */
const DETERMINISTIC =
  /read-back failed|must be 32 bytes|rank must be|folded record needs|coverageTo is for|outside its coverage|is the build's own|more than one partition can hold|at most \d+ (sources|sample tags)|Cannot fold/;

const HTTP_STATUS = /status code (\d{3})/;

/** What changed in a source's stats over one step. */
function statsDelta(before: SourceStats, after: SourceStats) {
  const delta = (a: Record<string, number>, b: Record<string, number>) =>
    Object.fromEntries(
      Object.keys(b)
        .map((key) => [key, (b[key] ?? 0) - (a[key] ?? 0)] as const)
        .filter(([, n]) => n > 0),
    );
  return {
    records: after.records - before.records,
    unrepaired: delta(before.unrepaired, after.unrepaired),
    dropped: delta(before.dropped, after.dropped),
  };
}

const snapshot = (stats: SourceStats): SourceStats =>
  JSON.parse(JSON.stringify(stats)) as SourceStats;

async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    const stat = await fs.stat(path.join(dir, name)).catch(() => undefined);
    if (stat?.isFile() === true) total += stat.size;
  }
  return total;
}

/** Builds, checks and (unless a dry run) publishes one planned band. */
export async function buildStepBand(
  step: BuildStep,
  ctx: StepContext,
): Promise<StepOutcome> {
  const started = Date.now();
  const log = ctx.log.child({ kind: step.role, heightRange: step.heightRange });
  const inputs: Record<string, number> = {};
  const before = new Map(
    ctx.sources.map((source) => [source.name, snapshot(source.stats)]),
  );
  const optionalFailures: string[] = [];

  async function* records(): AsyncGenerator<BandRecord> {
    if (step.fold !== undefined) {
      const folded = await openBandRecords(step.fold.dir, step.fold.top);
      try {
        for await (const record of folded.records) yield record;
      } finally {
        await folded.close();
        inputs.folded = folded.stats.records;
        if (folded.stats.pathSkipped > 0) {
          metrics.dropped.inc(
            { index: INDEX_NAME, reason: 'folded_path' },
            folded.stats.pathSkipped,
          );
        }
      }
    }
    for (const source of ctx.sources) {
      try {
        for await (const record of source.records(step.read[0], step.read[1])) {
          yield record;
        }
      } catch (error) {
        if (!ctx.optional.has(source.name)) throw error;
        const message = error instanceof Error ? error.message : String(error);
        optionalFailures.push(`${source.name}: ${message}`);
        log.warn('Optional source failed; building without it', {
          source: source.name,
          error: message,
        });
      }
    }
  }

  let gate:
    | { result: StepResult; reason: string; details?: string[] }
    | undefined;
  let peakBytes: number | undefined;
  const beforePublish = async (
    staged: StagedBand,
  ): Promise<PublishDecision> => {
    const given =
      Object.values(inputs).reduce((sum, n) => sum + n, 0) +
      ctx.sources.reduce(
        (sum, source) =>
          sum + source.stats.records - (before.get(source.name)?.records ?? 0),
        0,
      );
    peakBytes = given * SCATTER_RECORD_BYTES + (await dirBytes(staged.dir));
    const decline = (
      result: StepResult,
      reason: string,
      details?: string[],
    ): PublishDecision => {
      gate = { result, reason, ...(details !== undefined ? { details } : {}) };
      return { publish: false, reasons: [reason, ...(details ?? [])] };
    };

    if (
      step.replaces !== undefined &&
      (await bandContentDigest(
        step.replaces.dir,
        step.replaces.manifest.partitions,
      )) === staged.contentDigest
    ) {
      return decline('unchanged', 'same_content');
    }
    // Only a delta waits for enough entries: an h or r left out would leave
    // its heights uncovered for good.
    if (step.role === 'd' && staged.records < MIN_RECORDS) {
      return decline('skipped', 'below_min', [
        `${staged.records} entries, fewer than ${MIN_RECORDS}`,
      ]);
    }
    // A band that freezes is never folded again, so rows a failed optional
    // source would have given could never join it.
    if (step.freezes === true && optionalFailures.length > 0) {
      return decline('couldnt_check', 'optional_source_on_freeze', [
        ...optionalFailures,
      ]);
    }
    if (staged.conflicts > CONFLICT_CAP * staged.records) {
      return decline('rejected', 'conflicts', [
        `${staged.conflicts} conflicting IDs, over ${CONFLICT_CAP * 100}% of ${staged.records}`,
        ...staged.conflictSample.map(
          (c) => `${c.id} in ${c.rootTxId}: ${c.sources.join(' vs ')}`,
        ),
      ]);
    }

    if (staged.sample.length === 0) {
      return decline('rejected', 'no_offsets', [
        `none of its ${staged.records} entries has offsets to check`,
      ]);
    }
    const check = await checkBandHeaders({
      entries: staged.sample,
      totalRecords: staged.records,
      openRoot: ctx.openRoot,
      minRecords: 0,
      ...ctx.headerCheck,
    });
    metrics.gateOkRatio.set(
      { index: INDEX_NAME, kind: step.role },
      check.checked > 0 ? check.ok / check.checked : 0,
    );
    for (const wrong of check.wrong) {
      metrics.gateWrong.inc({
        index: INDEX_NAME,
        kind: step.role,
        tag: wrong.tag ?? '',
      });
    }
    for (const error of check.errors) {
      metrics.gateHttp.inc({
        index: INDEX_NAME,
        status: HTTP_STATUS.exec(error.error)?.[1] ?? 'error',
      });
    }
    if (check.wrong.length > 0) {
      return decline('rejected', 'wrong_header', [
        ...check.reasons,
        ...check.wrong
          .slice(0, 20)
          .map(
            (w) =>
              `${w.id}${w.tag !== undefined ? ` (${w.tag})` : ''}: ${w.reason}`,
          ),
      ]);
    }
    if (!check.passed) {
      return decline('couldnt_check', 'gate', check.reasons);
    }
    log.info('Header check passed', {
      checked: check.checked,
      ok: check.ok,
      byTag: check.byTag,
    });
    if (ctx.stillHeld !== undefined && !(await ctx.stillHeld())) {
      return decline('couldnt_check', 'lock_lost', [
        'another run took the lock while this one stalled',
      ]);
    }
    return { publish: true };
  };

  let band: BuiltBand;
  try {
    band = await buildBand({
      ...(ctx.now !== undefined ? { now: ctx.now } : {}),
      log,
      records: records(),
      publishDir: ctx.publishDir,
      workDir: ctx.workDir,
      publisher: ctx.publisher,
      kind: step.role,
      heightRange: step.heightRange,
      supersedes: step.supersedes,
      metadata: { publisher: ctx.publisher },
      beforePublish,
      dryRun: ctx.dryRun,
      sampleSize: SAMPLE_SIZE,
      sampleSizes: SAMPLE_SIZES,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Empty because nothing was given: a range with no data, nothing to
    // cover. Empty because every record was invalid: the records are wrong,
    // and the same records would be again.
    const invalid = /Band would be empty: [1-9]\d* of the records/.test(
      message,
    );
    const empty = !invalid && /Band would be empty/.test(message);
    const deterministic = invalid || DETERMINISTIC.test(message);
    const outcome: StepOutcome = {
      role: step.role,
      heightRange: step.heightRange,
      result: empty ? 'skipped' : deterministic ? 'rejected' : 'couldnt_check',
      reason: empty ? 'empty' : deterministic ? 'build' : 'source',
      details: [message],
      inputs,
      seconds: (Date.now() - started) / 1000,
    };
    countStep(outcome, step, ctx, before);
    return outcome;
  }

  for (const source of ctx.sources) {
    inputs[source.name] =
      source.stats.records - (before.get(source.name)?.records ?? 0);
  }
  const outcome: StepOutcome = {
    role: step.role,
    heightRange: step.heightRange,
    ...(gate !== undefined
      ? gate
      : band.published
        ? { result: 'published' as const, reason: 'new' }
        : band.unchanged
          ? { result: 'unchanged' as const, reason: 'same_id' }
          : { result: 'dry_run' as const, reason: 'dry_run' }),
    ...(optionalFailures.length > 0
      ? {
          details: [
            ...(gate?.details ?? []),
            ...optionalFailures.map((f) => `optional source failed: ${f}`),
          ],
        }
      : {}),
    band,
    inputs,
    seconds: (Date.now() - started) / 1000,
    ...(peakBytes !== undefined ? { peakBytes } : {}),
  };
  countStep(outcome, step, ctx, before);
  return outcome;
}

/** Updates the metrics for a finished step. */
function countStep(
  outcome: StepOutcome,
  step: BuildStep,
  ctx: StepContext,
  before: Map<string, SourceStats>,
): void {
  metrics.runs.inc({
    index: INDEX_NAME,
    kind: step.role,
    result: outcome.result,
    reason: outcome.reason,
  });
  for (const source of ctx.sources) {
    const start = before.get(source.name);
    if (start === undefined) continue;
    const delta = statsDelta(start, source.stats);
    metrics.records.set(
      { index: INDEX_NAME, kind: step.role, source: source.name },
      delta.records,
    );
    for (const [reason, n] of Object.entries(delta.unrepaired)) {
      metrics.unrepaired.inc({ index: INDEX_NAME, reason }, n);
    }
    for (const [reason, n] of Object.entries(delta.dropped)) {
      metrics.dropped.inc({ index: INDEX_NAME, reason }, n);
    }
  }
  if (outcome.band !== undefined) {
    metrics.conflicts.inc({ index: INDEX_NAME }, outcome.band.conflicts);
    if (outcome.band.dropped > 0) {
      metrics.dropped.inc(
        { index: INDEX_NAME, reason: 'invalid' },
        outcome.band.dropped,
      );
    }
  }
}
