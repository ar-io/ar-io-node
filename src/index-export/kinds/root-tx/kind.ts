/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Builds one planned root-TX band: the folded bands' entries and every
 * source's records for the step's heights (and, in the grid layout, the
 * seeds' entries placed by height) go through the band library's merge, and
 * the gate decides before anything is renamed into place. A grid re-settle
 * is also compared with the band it would replace, entry by entry.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Logger } from 'winston';

import {
  BandRecord,
  bandContentDigest,
  BandSampleEntry,
  buildBand,
  BuiltBand,
  OVERLAY_CHANGED_TAG,
  PublishDecision,
  SCATTER_RECORD_BYTES,
  StagedBand,
} from '../../../lib/index-band/build.js';
import {
  openBandRecords,
  readBandManifest,
} from '../../../lib/index-band/read.js';
import {
  checkBandHeaders,
  RootSourceFactory,
} from '../../../lib/index-band/verify.js';
import { DEFAULT_RESETTLE_MAX_CHANGED } from '../../config.js';
import * as metrics from '../../metrics.js';
import type { OwnBand } from '../../state.js';
import {
  diffBands,
  emptyPlacement,
  placeSeedEntries,
  RESETTLE_CHANGED_TAG,
  RootHeights,
  SeedPlacement,
} from './grid.js';
import type { BuildStep, GridStepKind } from './planner.js';
import { REPAIRED_TAG, RecordSource, SourceStats } from './sources/rows.js';

export const INDEX_NAME = 'root-tx-index';

/** A band under this many entries is skipped, not published or failed. */
export const MIN_RECORDS = 1000;
/** A band whose conflicting IDs exceed this share is rejected. */
export const CONFLICT_CAP = 0.01;
/** Header-check samples: general, and per tag. */
export const SAMPLE_SIZE = 150;
export const SAMPLE_SIZES = { [REPAIRED_TAG]: 50, [OVERLAY_CHANGED_TAG]: 200 };
// A re-settle checks only its delta instead: every entry it relocates,
// SAMPLE_SIZE of those it adds, and the tagged sample entries among either.

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
  /** Grid layout: what the step did. */
  grid?: GridStepKind;
  result: StepResult;
  reason: string;
  /** Reasons and samples for an operator. */
  details?: string[];
  band?: BuiltBand;
  /** Records given, by source (and `folded`). */
  inputs: Record<string, number>;
  /** Grid freeze and tip: where the seeds' entries went. */
  seeds?: SeedPlacement;
  /** Grid re-settle: the rebuilt band against the published one. */
  resettle?: ResettleReport;
  seconds: number;
  /** Scratch plus the finished band, an upper bound for the disk a build needs. */
  peakBytes?: number;
}

/** A re-settled band against the band it would replace. */
export interface ResettleReport {
  /** The band re-settled. */
  band: string;
  oldEntries: number;
  newEntries: number;
  added: number;
  /** Entries whose root, offsets or size changed, each header-checked. */
  changed: number;
  unchanged: number;
  /** The header check, when it ran: every changed entry, sampled added ones, the usual samples. */
  header?: {
    checked: number;
    ok: number;
    wrong: number;
    errors: number;
    byTag: Record<string, { checked: number; ok: number; wrong: number }>;
  };
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
  /** Grid layout: the seeds' roots, given heights as the sources are read. */
  rootHeights?: RootHeights;
  /** Grid tip: whether the frozen band covering `height` holds `id`. */
  frozenHolds?: (id: Buffer, height: number) => Promise<boolean>;
  /** Grid re-settle: the most entries one band may relocate. */
  resettleMaxChanged?: number;
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
  const placement = step.seeds !== undefined ? emptyPlacement() : undefined;
  let resettle: ResettleReport | undefined;

  async function* foldIn(band: OwnBand): AsyncGenerator<BandRecord> {
    const folded = await openBandRecords(band.dir, band.top);
    try {
      for await (const record of folded.records) yield record;
    } finally {
      await folded.close();
      inputs.folded = (inputs.folded ?? 0) + folded.stats.records;
      if (folded.stats.pathSkipped > 0) {
        metrics.dropped.inc(
          { index: INDEX_NAME, reason: 'folded_path' },
          folded.stats.pathSkipped,
        );
      }
    }
  }

  async function* records(): AsyncGenerator<BandRecord> {
    if (step.fold !== undefined) yield* foldIn(step.fold);
    for (const band of step.folds ?? []) yield* foldIn(band);
    const read = step.read;
    if (read !== undefined) {
      for (const source of ctx.sources) {
        try {
          for await (const record of source.records(read[0], read[1])) {
            ctx.rootHeights?.note(record.rootTxId, record.height);
            // Read only to place the seeds' entries.
            if (
              step.keepFrom !== undefined &&
              record.height !== undefined &&
              record.height < step.keepFrom
            ) {
              continue;
            }
            yield record;
          }
        } catch (error) {
          if (!ctx.optional.has(source.name)) throw error;
          const message =
            error instanceof Error ? error.message : String(error);
          optionalFailures.push(`${source.name}: ${message}`);
          log.warn('Optional source failed; building without it', {
            source: source.name,
            error: message,
          });
        }
      }
    }
    // After the sources, whose rows give the seeds' roots their heights.
    if (placement !== undefined) {
      yield* placeSeedEntries(step, ctx, placement);
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
    const publishIfHeld = async (): Promise<PublishDecision> =>
      ctx.stillHeld !== undefined && !(await ctx.stillHeld())
        ? decline('couldnt_check', 'lock_lost', [
            'another run took the lock while this one stalled',
          ])
        : { publish: true };

    if (
      step.replaces !== undefined &&
      (await bandContentDigest(
        step.replaces.dir,
        step.replaces.manifest.partitions,
      )) === staged.contentDigest
    ) {
      return decline('unchanged', 'same_content');
    }
    // A re-settle replaces a published band only to add or relocate
    // entries, and never loses one.
    let delta: BandSampleEntry[] | undefined;
    if (step.grid === 'resettle' && step.fold !== undefined) {
      const maxChanged = ctx.resettleMaxChanged ?? DEFAULT_RESETTLE_MAX_CHANGED;
      // The build's own strata (repaired, overlay-changed), kept for the
      // entries among them the re-settle adds or relocates.
      const tagged = staged.sample.filter((entry) => entry.tag !== undefined);
      const diff = await diffBands(
        { dir: step.fold.dir, manifest: step.fold.manifest },
        { dir: staged.dir, manifest: await readBandManifest(staged.dir) },
        {
          maxChanged,
          addedSampleSize: SAMPLE_SIZE,
          watch: new Set(tagged.map((entry) => entry.id)),
        },
      );
      resettle = {
        band: step.fold.id,
        oldEntries: diff.oldEntries,
        newEntries: diff.newEntries,
        added: diff.added,
        changed: diff.changed,
        unchanged: diff.unchanged,
      };
      if (diff.removed > 0) {
        return decline('rejected', 'dropped_entries', [
          `${diff.removed} of the band's ${diff.oldEntries} entries would be dropped`,
          ...diff.removedSample,
        ]);
      }
      if (diff.added === 0 && diff.changed === 0) {
        return decline('unchanged', 'same_entries');
      }
      if (diff.changed > maxChanged) {
        return decline('rejected', 'too_many_changed', [
          `${diff.changed} entries relocated, over INDEX_EXPORT_ROOT_TX_RESETTLE_MAX_CHANGED (${maxChanged}); each would need a header check`,
        ]);
      }
      if (diff.unverifiable > 0) {
        return decline('rejected', 'unverifiable_change', [
          `${diff.unverifiable} entries relocated to a root without offsets, which no header check can confirm`,
          ...diff.unverifiableSample,
        ]);
      }
      // The entries the band already held were checked when it was first
      // published, and their roots may since be hard to read: only what
      // changes is checked. A relocated entry keeps its own stratum.
      delta = [
        ...new Map(
          [
            ...diff.addedSample,
            ...tagged.filter((entry) => diff.watched.has(entry.id)),
            ...diff.changedEntries,
          ].map((entry) => [entry.id, entry]),
        ).values(),
      ];
    }
    // Only a band at the tip waits for enough entries: a closed band left
    // out would leave its heights uncovered for good.
    if (
      ((step.role === 'd' && step.heightRange[1] === null) ||
        step.role === 'tip') &&
      staged.records < MIN_RECORDS
    ) {
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
    if (delta !== undefined && delta.length === 0) {
      // It adds only entries without offsets, which no check can read, as
      // for the root-only entries of any build.
      log.info('Re-settle adds only entries without offsets: none to check', {
        added: resettle?.added,
      });
      return publishIfHeld();
    }
    const check = await checkBandHeaders({
      entries: delta ?? staged.sample,
      totalRecords: staged.records,
      openRoot: ctx.openRoot,
      minRecords: 0,
      ...ctx.headerCheck,
    });
    if (resettle !== undefined) {
      resettle.header = {
        checked: check.checked,
        ok: check.ok,
        wrong: check.wrong.length,
        errors: check.errors.length,
        byTag: check.byTag,
      };
    }
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
    // A relocated entry replaces one already published: each must read
    // back right, whatever the share of the rest that did.
    const unread = check.errors.filter((e) => e.tag === RESETTLE_CHANGED_TAG);
    if (unread.length > 0) {
      return decline('couldnt_check', 'changed_unchecked', [
        `${unread.length} relocated entries could not be read from the gateway`,
        ...unread.slice(0, 20).map((e) => `${e.id}: ${e.error}`),
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
    return publishIfHeld();
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
      ...(step.grid !== undefined ? { grid: step.grid } : {}),
      result: empty ? 'skipped' : deterministic ? 'rejected' : 'couldnt_check',
      reason: empty ? 'empty' : deterministic ? 'build' : 'source',
      details: [message],
      inputs,
      ...(placement !== undefined ? { seeds: placement } : {}),
      ...(resettle !== undefined ? { resettle } : {}),
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
    ...(step.grid !== undefined ? { grid: step.grid } : {}),
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
    ...(placement !== undefined ? { seeds: placement } : {}),
    ...(resettle !== undefined ? { resettle } : {}),
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
  if (step.grid === 'resettle') {
    const result =
      outcome.result === 'published'
        ? 'rebuilt'
        : outcome.result === 'unchanged'
          ? 'unchanged'
          : outcome.result === 'rejected' || outcome.result === 'couldnt_check'
            ? 'failed'
            : undefined;
    if (result !== undefined) {
      metrics.resettles.inc({ index: INDEX_NAME, kind: step.role, result });
    }
    if (outcome.resettle !== undefined) {
      for (const change of ['added', 'changed', 'unchanged'] as const) {
        metrics.resettleEntries.set(
          { index: INDEX_NAME, kind: step.role, change },
          outcome.resettle[change],
        );
      }
    }
  }
  if (
    step.grid === 'tip' &&
    outcome.seeds !== undefined &&
    (outcome.result === 'published' || outcome.result === 'unchanged')
  ) {
    metrics.tipUnplaced.set(
      { index: INDEX_NAME },
      outcome.seeds.carried + outcome.seeds.unresolved,
    );
  }
}
