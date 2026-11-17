/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * `backfill-bundles`: queue, behind live indexing, the L1 bundles this
 * gateway skipped and its unbundle filter matches now. One 10,000-height
 * bucket at a time, ascending, paced by the gateway's queues, an hourly byte
 * budget, a daily quiet window and the guards in `guards.ts`.
 */
import type { Logger } from 'winston';

import type { Sample } from '../prometheus-text.js';
import {
  decide,
  DiskSample,
  GuardConfig,
  HourlyByteBudget,
  QuietWindow,
  quietWindowRemainingMs,
  readGuards,
} from './guards.js';
import { BackfillCandidate, BackfillVerdict, buckets } from './select.js';

/** What the gateway answered to one queue request. */
export type QueueOutcome = 'queued' | 'skipped' | 'full' | 'refused';

export interface BackfillDeps {
  log: Logger;
  /** The bundles of one bucket, with their verdicts (see `selectBucket`). */
  selectBucket: (from: number, to: number) => BackfillCandidate[];
  /**
   * The bundle's verdict now, just before queueing it; undefined if still
   * eligible. Optional (tests and callers without bundles.db omit it).
   */
  recheckBundle?: (id: string) => BackfillVerdict | undefined;
  /** POST queue-bundle, non-prioritized. Throws on a transport error. */
  queueBundle: (id: string) => Promise<QueueOutcome>;
  gatewayMetrics: () => Promise<Sample[]>;
  nodeMetrics?: () => Promise<Sample[]>;
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface BackfillOptions {
  from: number;
  to: number;
  dryRun: boolean;
  guards: GuardConfig;
  quietWindow: QuietWindow | undefined;
  bytesPerHour: number | undefined;
  pollMs: number;
  haltAfterSeconds: number;
  /** Stop after this many bundles queued (for a pilot). */
  limit?: number;
}

export interface BucketResult {
  from: number;
  to: number;
  bundles: number;
  verdicts: Partial<Record<BackfillVerdict, number>>;
  selectedBytes: number;
  queued: number;
  alreadyQueued: number;
  refused: number;
}

export interface BackfillResult {
  dryRun: boolean;
  heightRange: [number, number];
  buckets: BucketResult[];
  totals: {
    bundles: number;
    selected: number;
    selectedBytes: number;
    queued: number;
    alreadyQueued: number;
    refused: number;
    verdicts: Partial<Record<BackfillVerdict, number>>;
  };
  /** Selected bundles by Bundler-App-Name ("(none)" for untagged). */
  selectedByBundlerAppName: Record<string, number>;
  /** Seconds spent waiting, by reason. */
  pausedSeconds: Record<string, number>;
  /** Set when a guard stopped the run. */
  halted?: string;
  /** Set when --limit stopped the run. */
  limitReached?: boolean;
}

export class BackfillHalted extends Error {
  constructor(
    message: string,
    readonly result: BackfillResult,
  ) {
    super(message);
  }
}

export async function runBackfill(
  options: BackfillOptions,
  deps: BackfillDeps,
): Promise<BackfillResult> {
  const { log } = deps;
  const budget = new HourlyByteBudget(options.bytesPerHour);
  const haltSince: Record<string, number> = {};
  let previousDisk: DiskSample | undefined;
  const result: BackfillResult = {
    dryRun: options.dryRun,
    heightRange: [options.from, options.to],
    buckets: [],
    totals: {
      bundles: 0,
      selected: 0,
      selectedBytes: 0,
      queued: 0,
      alreadyQueued: 0,
      refused: 0,
      verdicts: {},
    },
    // Null prototype: a Bundler-App-Name of "__proto__" or "constructor" is
    // an app name, not an inherited property.
    selectedByBundlerAppName: Object.create(null) as Record<string, number>,
    pausedSeconds: {},
  };
  const paused = (reason: string, ms: number) => {
    result.pausedSeconds[reason] =
      (result.pausedSeconds[reason] ?? 0) + Math.round(ms / 1000);
  };

  /** Waits until every guard passes, or throws when one halts the run. */
  const waitForGuards = async () => {
    for (;;) {
      const quietMs = quietWindowRemainingMs(options.quietWindow, deps.nowMs());
      if (quietMs > 0) {
        log.info('In the quiet window; waiting', {
          minutes: Math.ceil(quietMs / 60_000),
        });
        paused('quiet window', quietMs);
        await deps.sleep(quietMs);
        // Nothing was observed while asleep: a halt cannot have lasted
        // through it, and a disk rate over the window is not a reading.
        for (const name of Object.keys(haltSince)) delete haltSince[name];
        previousDisk = undefined;
        continue;
      }
      let gateway: Sample[] = [];
      let node: Sample[] | undefined;
      try {
        gateway = await deps.gatewayMetrics();
      } catch (error: any) {
        log.warn('Gateway metrics unreadable', { message: error?.message });
      }
      if (deps.nodeMetrics !== undefined) {
        try {
          node = await deps.nodeMetrics();
        } catch (error: any) {
          log.warn('Node metrics unreadable', { message: error?.message });
        }
      }
      const nowMs = deps.nowMs();
      const read = readGuards({
        config: options.guards,
        gateway,
        node,
        nowMs,
        previousDisk,
      });
      if (read.disk !== undefined) previousDisk = read.disk;
      const decision = decide(read.readings, {
        nowMs,
        haltSince,
        haltAfterSeconds: options.haltAfterSeconds,
      });
      if (decision.state === 'ok') return;
      if (decision.state === 'halt') {
        result.halted = decision.reasons.join('; ');
        throw new BackfillHalted(`Halted: ${result.halted}`, result);
      }
      log.info('Paused', { reasons: decision.reasons });
      for (const guard of decision.guards) paused(guard, options.pollMs);
      await deps.sleep(options.pollMs);
    }
  };

  for (const [from, to] of buckets(options.from, options.to)) {
    const candidates = deps.selectBucket(from, to);
    const bucket: BucketResult = {
      from,
      to,
      bundles: candidates.length,
      verdicts: {},
      selectedBytes: 0,
      queued: 0,
      alreadyQueued: 0,
      refused: 0,
    };
    result.buckets.push(bucket);
    const selected = candidates.filter((c) => c.verdict === 'selected');
    for (const c of candidates) {
      bucket.verdicts[c.verdict] = (bucket.verdicts[c.verdict] ?? 0) + 1;
      result.totals.verdicts[c.verdict] =
        (result.totals.verdicts[c.verdict] ?? 0) + 1;
    }
    for (const c of selected) {
      bucket.selectedBytes += c.dataSize;
      const app = c.bundlerAppName ?? '(none)';
      result.selectedByBundlerAppName[app] =
        (result.selectedByBundlerAppName[app] ?? 0) + 1;
    }
    result.totals.bundles += bucket.bundles;
    result.totals.selected += selected.length;
    result.totals.selectedBytes += bucket.selectedBytes;
    log.info('Bucket selected', {
      from,
      to,
      bundles: bucket.bundles,
      selected: selected.length,
      selectedBytes: bucket.selectedBytes,
    });
    if (options.dryRun) continue;

    for (const c of selected) {
      if (
        options.limit !== undefined &&
        result.totals.queued >= options.limit
      ) {
        result.limitReached = true;
        return result;
      }
      for (;;) {
        await waitForGuards();
        const budgetMs = budget.waitMs(c.dataSize, deps.nowMs());
        if (budgetMs > 0) {
          log.info('Hourly byte budget spent; waiting', {
            minutes: Math.ceil(budgetMs / 60_000),
          });
          paused('byte budget', budgetMs);
          await deps.sleep(budgetMs);
          continue;
        }
        const now = deps.recheckBundle?.(c.id);
        if (now !== undefined) {
          // Queued, indexed or failed since selection: leave it.
          bucket.alreadyQueued++;
          result.totals.alreadyQueued++;
          log.info('Bundle no longer eligible; not queued', {
            id: c.id,
            verdict: now,
          });
          break;
        }
        const outcome = await deps.queueBundle(c.id);
        if (outcome === 'full') {
          paused('queue bundleDataImporter', options.pollMs);
          await deps.sleep(options.pollMs);
          continue;
        }
        if (outcome === 'queued') {
          budget.record(c.dataSize, deps.nowMs());
          bucket.queued++;
          result.totals.queued++;
        } else if (outcome === 'skipped') {
          bucket.alreadyQueued++;
          result.totals.alreadyQueued++;
        } else {
          bucket.refused++;
          result.totals.refused++;
          log.warn('Gateway refused bundle', { id: c.id });
        }
        break;
      }
    }
    log.info('Bucket queued', {
      from,
      to,
      queued: bucket.queued,
      alreadyQueued: bucket.alreadyQueued,
      refused: bucket.refused,
    });
  }
  return result;
}
