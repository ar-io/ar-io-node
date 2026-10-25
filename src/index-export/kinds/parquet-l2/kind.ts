/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Builds one planned `parquet-l2` band (`export.ts`), decides, and
 * publishes it under the index's directory:
 *
 * - the same id as a band it replaces (the same heights, selection and
 *   rows) is `unchanged`: nothing is published, and a band now settled is
 *   only marked so;
 * - a band that replaces others must hold every id they hold and every
 *   location they had (`compare.ts`), and every row it relocates is
 *   header-checked, at most `resettleMaxChanged` of them;
 * - a sample of its located rows is header-checked through the gateway, as
 *   root-TX bands are (`checkBandHeaders`): a wrong header rejects the
 *   band, too few that read leaves it for the next run.
 *
 * What the band replaces, when it was built and whether its heights had
 * settled go beside it in `.publisher.json`, before it is renamed into
 * place.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Logger } from 'winston';

import {
  BandSampleEntry,
  bandPublisherTag,
} from '../../../lib/index-band/build.js';
import {
  checkBandHeaders,
  RootSourceFactory,
} from '../../../lib/index-band/verify.js';
import {
  BandPublisherFacts,
  readPublisherFacts,
  writePublisherFacts,
} from '../../../lib/parquet-l1/layout.js';
import { l2BandId } from '../../../lib/parquet-l2/layout.js';
import * as metrics from '../../metrics.js';
import type { UnlocatedReason } from '../root-tx/sources/item-location.js';
import type { L1PublishedBand } from '../parquet-l1/kind.js';
import {
  compareL2Bands,
  L2_NEWLY_LOCATED_TAG,
  L2_RELOCATED_TAG,
  L2Compare,
  NEWLY_LOCATED_SAMPLE,
} from './compare.js';
import type { L2IndexConfig } from './config.js';
import {
  DEFAULT_L2_DUCK_LIMITS,
  exportL2Band,
  L2_SAMPLE_SIZE,
  L2_STRATUM_SAMPLE_SIZE,
  L2BandStats,
  L2CheckError,
  L2DuckLimits,
  L2ExportResult,
  L2UnavailableError,
  withL2Duck,
} from './export.js';
import { GatewayReads } from './gateway-reads.js';
import type { L2Role, L2Step, L2StepKind } from './planner.js';
import type { L2ItemSource } from './source.js';

export interface L2StepContext {
  index: L2IndexConfig;
  publisher: string;
  /** Where a dry run with `--keep` leaves its bands instead of publishing. */
  keepDir?: string;
  workDir: string;
  source: L2ItemSource;
  /** This publisher's live `parquet-l1` bands, for the roots' positions. */
  l1Bands: L1PublishedBand[];
  walletsDbPath?: string;
  openRoot: RootSourceFactory;
  maxReads: number;
  /** The most rows a band may relocate, each header-checked. */
  resettleMaxChanged: number;
  /** Build and check, publish nothing (or, with `keepDir`, publish there). */
  dryRun: boolean;
  log: Logger;
  /** Whether this run still holds its lock; nothing publishes once it doesn't. */
  stillHeld?: () => Promise<boolean>;
  /** Overrides for the gateway reads' retries (tests). */
  headerCheck?: { retries?: number; retryDelayMs?: number };
  /** Ids this band names as superseded besides the bands it replaces. */
  history?: string[];
  /**
   * Publish into this directory instead of the index's: a part of a split,
   * moved into place with the rest once every part has passed.
   */
  stageDir?: string;
  /** The build's DuckDB limits ({@link DEFAULT_L2_DUCK_LIMITS} when unset). */
  limits?: L2DuckLimits;
  /** Random source for the header-check sample (tests). */
  random?: () => number;
  now?: () => number;
}

export interface L2Outcome {
  /** Where a staged part of a split waits to be published with the rest. */
  stagedAt?: string;
  index: string;
  step: L2StepKind;
  role: L2Role;
  heightRange: [number, number];
  result: 'published' | 'unchanged' | 'rejected' | 'couldnt_check' | 'dry_run';
  reason: string;
  details?: string[];
  id?: string;
  /** What the band names as superseded. */
  supersedes?: string[];
  /** The live bands it was built to replace. */
  replaces?: string[];
  /** Re-settle: what the fingerprint gate found. */
  gate?: { verdict: string; detail?: string };
  /** Rows per table. */
  rows?: Record<string, number>;
  /** Rows and row digest per table, as `band.json` gives them: what two builders compare. */
  tables?: Record<string, { rows: number; rowDigest: string }>;
  /** The band's `createdAt`. */
  createdAt?: string;
  /** The band's `checks`. */
  checks?: Record<string, unknown>;
  stats?: L2BandStats;
  /** Against the bands it replaces. */
  compare?: Omit<L2Compare, 'relocatedEntries' | 'newlyLocatedEntries'>;
  header?: {
    checked: number;
    ok: number;
    wrong: number;
    errors: number;
    /** Candidates handed to the check: the pool its samples are read from. */
    poolSize: number;
    /** Candidates passed over: their roots are gone (404), out of the ratio. */
    unreadable: number;
    /** Unreadable among those tried: an estimate of the band's gone roots. */
    unreadableShare: number;
    /** Rows that passed with a malformed tag count: malformed items, right locations. */
    malformedTags: number;
    malformed?: Array<{ id: string; reason: string; tag?: string }>;
    byTag: Record<
      string,
      {
        checked: number;
        ok: number;
        wrong: number;
        unreadable?: number;
        malformedTags?: number;
      }
    >;
  };
  /** Where a dry run with `--keep` left the band. */
  keptAt?: string;
  bandBytes?: number;
  /** The build's staging directory once the band was written: database and band. */
  stagingBytes?: number;
  seconds: number;
}

const HTTP_STATUS = /status code (\d{3})/;

/**
 * How many entries of each header-check stratum to read, from pools
 * {@link HEADER_CHECK_POOL_FACTOR} times as large: the general sample, the
 * placement and normalisation strata, and a replacement's newly located
 * rows. Relocated rows have no target: every one is read.
 */
export const L2_HEADER_TARGETS: Record<string, number> = {
  '': L2_SAMPLE_SIZE,
  repaired: L2_STRATUM_SAMPLE_SIZE,
  proven: L2_STRATUM_SAMPLE_SIZE,
  absolute: L2_STRATUM_SAMPLE_SIZE,
  deep: L2_STRATUM_SAMPLE_SIZE,
  normalised: L2_STRATUM_SAMPLE_SIZE,
  [L2_NEWLY_LOCATED_TAG]: NEWLY_LOCATED_SAMPLE,
};

/** Every reason an item is unlocated, so a gauge drops to 0 when one clears. */
const UNLOCATED_REASONS: UnlocatedReason[] = [
  'no_offsets',
  'layout',
  'no_parent',
  'inconsistent',
  'deep',
  'ambiguous',
  'parent_two_places',
];

type Decision = Pick<L2Outcome, 'result' | 'reason' | 'details'>;

/** Builds, checks and (unless a dry run) publishes one planned band. */
export async function runL2Step(
  step: L2Step,
  ctx: L2StepContext,
): Promise<L2Outcome> {
  const started = Date.now();
  const supersedes = [
    ...new Set([...(ctx.history ?? []), ...step.replaces.map((b) => b.id)]),
  ];
  const base = {
    index: ctx.index.name,
    step: step.step,
    role: step.role,
    heightRange: step.heightRange,
    ...(step.replaces.length > 0
      ? { replaces: step.replaces.map((band) => band.id) }
      : {}),
  };
  let outcome: L2Outcome;
  let result: L2ExportResult | undefined;
  try {
    const reads = new GatewayReads(ctx.openRoot, {
      maxReads: ctx.maxReads,
      ...ctx.headerCheck,
    });
    try {
      result = await exportL2Band({
        selection: ctx.index.selection,
        keyTags: ctx.index.keyTags,
        statTags: ctx.index.statTags,
        replacedBandDirs: step.replaces.map((band) => band.dir),
        from: step.heightRange[0],
        to: step.heightRange[1],
        source: ctx.source,
        l1Bands: ctx.l1Bands,
        ...(ctx.walletsDbPath !== undefined
          ? { walletsDbPath: ctx.walletsDbPath }
          : {}),
        reads,
        workDir: ctx.workDir,
        ...(ctx.limits !== undefined ? { limits: ctx.limits } : {}),
        ...(ctx.random !== undefined ? { random: ctx.random } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome =
        error instanceof L2CheckError
          ? {
              ...base,
              result: 'rejected',
              reason: error.reason,
              details: [message, ...error.details],
              seconds: 0,
            }
          : {
              ...base,
              result: 'couldnt_check',
              reason:
                error instanceof L2UnavailableError ? error.reason : 'source',
              details: [message],
              seconds: 0,
            };
      return finish(outcome, step, ctx, started);
    }
    const built = result;
    const id = l2BandId(built.band, bandPublisherTag(ctx.publisher));
    const facts = {
      id,
      rows: Object.fromEntries(
        Object.entries(built.band.tables).map(([t, v]) => [t, v.rows]),
      ),
      tables: built.band.tables,
      createdAt: built.band.createdAt,
      stats: built.stats,
      bandBytes: built.bandBytes,
      stagingBytes: built.stagingBytes,
      ...(supersedes.length > 0 ? { supersedes } : {}),
    };
    const decision = await decide(step, ctx, built, id);
    outcome = {
      ...base,
      ...facts,
      // After the header check, which adds what it read.
      checks: built.band.checks ?? {},
      ...decision.decision,
      ...(decision.compare !== undefined ? { compare: decision.compare } : {}),
      ...(decision.header !== undefined ? { header: decision.header } : {}),
      seconds: 0,
    };
    if (decision.decision.result !== 'published') {
      if (outcome.result === 'dry_run' && ctx.keepDir !== undefined) {
        const kept = path.join(ctx.keepDir, ctx.index.name, id);
        await fs.mkdir(path.dirname(kept), { recursive: true });
        await fs.rm(kept, { recursive: true, force: true });
        await writePublisherFacts(built.dir, {
          ...(supersedes.length > 0 ? { supersedes } : {}),
          builtAt: new Date(ctx.now?.() ?? Date.now()).toISOString(),
          ...ownFacts(built, outcome.header),
        });
        await fs.rename(built.dir, kept);
        outcome.keptAt = kept;
      }
      return finish(outcome, step, ctx, started);
    }
    // Facts first, inside the band, so it is never seen without them.
    const at = new Date(ctx.now?.() ?? Date.now()).toISOString();
    await writePublisherFacts(built.dir, {
      ...(supersedes.length > 0 ? { supersedes } : {}),
      builtAt: at,
      ...(step.settles ? { settledAt: at } : {}),
      ...ownFacts(built, outcome.header),
    });
    const into = ctx.stageDir ?? ctx.index.publishDir;
    await fs.mkdir(into, { recursive: true });
    await fs.rename(built.dir, path.join(into, id));
    if (ctx.stageDir !== undefined) outcome.stagedAt = path.join(into, id);
    return finish(outcome, step, ctx, started);
  } catch (error) {
    outcome = {
      ...base,
      result: 'couldnt_check',
      reason: 'publish',
      details: [error instanceof Error ? error.message : String(error)],
      seconds: 0,
    };
    return finish(outcome, step, ctx, started);
  } finally {
    if (result !== undefined) {
      await fs.rm(result.staging, { recursive: true, force: true });
    }
  }
}

/**
 * Whether a built band publishes: `unchanged` when this publisher already
 * has its id (marked settled when the step settles it), else the
 * comparison with the bands it replaces, then the header check.
 */
async function decide(
  step: L2Step,
  ctx: L2StepContext,
  built: L2ExportResult,
  id: string,
): Promise<{
  decision: Decision;
  compare?: L2Outcome['compare'];
  header?: L2Outcome['header'];
}> {
  const same = step.replaces.find((band) => band.id === id);
  if (same !== undefined) {
    if (step.settles && !ctx.dryRun) {
      if (ctx.stillHeld !== undefined && !(await ctx.stillHeld())) {
        return { decision: lockLost() };
      }
      const facts = (await readPublisherFacts(same.dir)) ?? {};
      if (facts.settledAt === undefined) {
        await writePublisherFacts(same.dir, {
          ...facts,
          settledAt: new Date(ctx.now?.() ?? Date.now()).toISOString(),
        });
      }
    }
    return { decision: { result: 'unchanged', reason: 'same_id' } };
  }

  let compare: L2Compare | undefined;
  if (step.replaces.length > 0) {
    compare = await withL2Duck(
      built.staging,
      ctx.limits ?? DEFAULT_L2_DUCK_LIMITS,
      (duck) =>
        compareL2Bands(
          duck,
          step.replaces.map((band) => band.dir),
          built.dir,
          ctx.resettleMaxChanged,
          step.compareRange,
        ),
      { inMemory: true },
    );
  }
  const { relocatedEntries, newlyLocatedEntries, ...reported } = compare ?? {
    relocatedEntries: [] as BandSampleEntry[],
    newlyLocatedEntries: [] as BandSampleEntry[],
  };
  const withCompare = (decision: Decision) => ({
    decision,
    ...(compare !== undefined
      ? { compare: reported as L2Outcome['compare'] }
      : {}),
  });
  if (compare !== undefined) {
    if (compare.missing > 0) {
      return withCompare({
        result: 'rejected',
        reason: 'dropped_items',
        details: [
          `${compare.missing} items of the bands it replaces are missing from it`,
          ...compare.missingSample,
        ],
      });
    }
    if (compare.unlocated > 0) {
      return withCompare({
        result: 'rejected',
        reason: 'unlocated_rows',
        details: [
          `${compare.unlocated} items located by the bands it replaces are unlocated in it`,
          ...compare.unlocatedSample,
        ],
      });
    }
    if (compare.walletsMissing > 0) {
      return withCompare({
        result: 'rejected',
        reason: 'dropped_wallets',
        details: [
          `${compare.walletsMissing} owners' keys of the bands it replaces are missing from it`,
          ...compare.walletsMissingSample,
        ],
      });
    }
    if (compare.relocated > ctx.resettleMaxChanged) {
      return withCompare({
        result: 'rejected',
        reason: 'too_many_changed',
        details: [
          `${compare.relocated} items relocated, over INDEX_EXPORT_ROOT_TX_RESETTLE_MAX_CHANGED (${ctx.resettleMaxChanged}); each would need a header check`,
        ],
      });
    }
  }

  const entries = [
    ...new Map(
      [...built.sample, ...newlyLocatedEntries, ...relocatedEntries].map(
        (entry) => [`${entry.id}:${entry.rootTxId}:${entry.rootOffset}`, entry],
      ),
    ).values(),
  ];
  let header: L2Outcome['header'];
  if (entries.length > 0) {
    // Pools walked until each sample is read, roots that are gone passed
    // over; every relocated row read (no target).
    const check = await checkBandHeaders({
      entries,
      targets: L2_HEADER_TARGETS,
      ...(ctx.random !== undefined ? { random: ctx.random } : {}),
      totalRecords: built.band.tables.data_items.rows,
      openRoot: ctx.openRoot,
      minRecords: 0,
      ...ctx.headerCheck,
    });
    header = {
      checked: check.checked,
      ok: check.ok,
      wrong: check.wrong.length,
      errors: check.errors.length,
      poolSize: check.poolSize,
      unreadable: check.unreadable.length,
      unreadableShare: Number(check.unreadableShare.toFixed(3)),
      malformedTags: check.malformedTags,
      ...(check.malformedTags > 0
        ? { malformed: check.malformed.slice(0, 20) }
        : {}),
      byTag: check.byTag,
    };
    metrics.gateOkRatio.set(
      { index: ctx.index.name, kind: step.role },
      check.checked > 0 ? check.ok / check.checked : 0,
    );
    if (check.malformedTags > 0) {
      metrics.gateMalformedTags.inc(
        { index: ctx.index.name, kind: step.role },
        check.malformedTags,
      );
    }
    if (check.unreadable.length > 0) {
      metrics.gateUnreadable.inc(
        { index: ctx.index.name, kind: step.role },
        check.unreadable.length,
      );
    }
    for (const wrong of check.wrong) {
      metrics.gateWrong.inc({
        index: ctx.index.name,
        kind: step.role,
        tag: wrong.tag ?? '',
      });
    }
    for (const error of check.errors) {
      metrics.gateHttp.inc({
        index: ctx.index.name,
        status: HTTP_STATUS.exec(error.error)?.[1] ?? 'error',
      });
    }
    const withHeader = (decision: Decision) => ({
      ...withCompare(decision),
      header,
    });
    if (check.wrong.length > 0) {
      return withHeader({
        result: 'rejected',
        reason: 'wrong_header',
        details: [
          ...check.reasons,
          ...check.wrong
            .slice(0, 20)
            .map(
              (w) =>
                `${w.id}${w.tag !== undefined ? ` (${w.tag})` : ''}: ${w.reason}`,
            ),
        ],
      });
    }
    // A relocated row replaces a location already published: each must read
    // back right, and a root that is gone proves nothing either.
    const unread = [
      ...check.errors.filter((e) => e.tag === L2_RELOCATED_TAG),
      ...check.unreadable
        .filter((e) => e.tag === L2_RELOCATED_TAG)
        .map((e) => ({
          id: e.id,
          error: `root ${e.rootTxId} not found (404)`,
        })),
    ];
    if (unread.length > 0) {
      return withHeader({
        result: 'couldnt_check',
        reason: 'changed_unchecked',
        details: [
          `${unread.length} relocated items could not be read from the gateway`,
          ...unread.slice(0, 20).map((e) => `${e.id}: ${e.error}`),
        ],
      });
    }
    if (!check.passed) {
      return withHeader({
        result: 'couldnt_check',
        reason: 'gate',
        details: check.reasons,
      });
    }
  }
  const done = (decision: Decision) => ({
    ...withCompare(decision),
    ...(header !== undefined ? { header } : {}),
  });
  if (ctx.dryRun) return done({ result: 'dry_run', reason: 'dry_run' });
  if (
    await fs.stat(path.join(ctx.index.publishDir, id)).then(
      () => true,
      () => false,
    )
  ) {
    // A band of this id that the step doesn't replace is one another band
    // supersedes, not yet swept: publishing over it would leave a gap.
    return done({
      result: 'rejected',
      reason: 'id_taken',
      details: [
        `${id} is already in ${ctx.index.publishDir}, superseded or not this step's to replace; move it away`,
      ],
    });
  }
  if (ctx.stillHeld !== undefined && !(await ctx.stillHeld())) {
    return done(lockLost());
  }
  return done({
    result: 'published',
    reason: step.replaces.length > 0 ? 'replaces' : 'new',
  });
}

/**
 * What only this build knows, for `.publisher.json`, never `band.json`
 * (which holds only what the rows determine): what the header check of the
 * sample read, and the reads the gateway answered 404 for.
 */
function ownFacts(
  built: L2ExportResult,
  header: L2Outcome['header'],
): Pick<BandPublisherFacts, 'headerCheck' | 'unreadable'> {
  return {
    ...(header !== undefined
      ? {
          headerCheck: {
            sampled: header.checked,
            ok: header.ok,
            poolSize: header.poolSize,
            unreadable: header.unreadable,
            unreadableShare: header.unreadableShare,
          },
        }
      : {}),
    unreadable: {
      proofs: built.stats.proofs.unproven,
      keys: built.stats.owners.withoutKeyBy.unreadable,
    },
  };
}

const lockLost = (): Decision => ({
  result: 'couldnt_check',
  reason: 'lock_lost',
  details: ['another run took the lock while this one stalled'],
});

/** Times, counts and logs a finished step. */
function finish(
  outcome: L2Outcome,
  step: L2Step,
  ctx: L2StepContext,
  started: number,
): L2Outcome {
  outcome.seconds = (Date.now() - started) / 1000;
  const index = ctx.index.name;
  metrics.runs.inc({
    index,
    kind: step.role,
    result: outcome.result,
    reason: outcome.reason,
  });
  if (outcome.rows !== undefined) {
    for (const [table, rows] of Object.entries(outcome.rows)) {
      metrics.l2Rows.set({ index, kind: step.role, table }, rows);
    }
  }
  const unlocated = outcome.checks?.unlocated as
    | Record<string, number>
    | undefined;
  if (unlocated !== undefined) {
    for (const reason of new Set([
      ...UNLOCATED_REASONS,
      ...Object.keys(unlocated),
    ])) {
      metrics.l2Unlocated.set(
        { index, kind: step.role, reason },
        unlocated[reason] ?? 0,
      );
    }
  }
  if (outcome.stats !== undefined) {
    metrics.l2OwnersWithoutKey.set(
      { index, kind: step.role },
      outcome.stats.owners.withoutKey,
    );
    for (const [k, n] of Object.entries(outcome.stats.proofs)) {
      if (n > 0) metrics.l2Proofs.inc({ index, outcome: k }, n);
    }
  }
  if (step.step === 'resettle') {
    const result =
      outcome.result === 'published'
        ? 'rebuilt'
        : outcome.result === 'unchanged'
          ? 'unchanged'
          : outcome.result === 'rejected' || outcome.result === 'couldnt_check'
            ? 'failed'
            : undefined;
    if (result !== undefined) {
      metrics.resettles.inc({ index, kind: step.role, result });
    }
  }
  ctx.log.info('L2 band step finished', {
    index,
    step: outcome.step,
    kind: outcome.role,
    heightRange: outcome.heightRange,
    result: outcome.result,
    reason: outcome.reason,
    id: outcome.id,
    rows: outcome.rows,
    checks: outcome.checks,
    seconds: outcome.seconds,
    details: outcome.details?.slice(0, 5),
  });
  return outcome;
}
