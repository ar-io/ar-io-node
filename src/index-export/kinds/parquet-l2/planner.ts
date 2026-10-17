/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * What to build next for a `parquet-l2` index, as pure functions of what is
 * published, how far the source reaches and the clock. No I/O; the service
 * runs the steps.
 *
 * The grid is the root-TX grid layout's (`root-tx/planner-grid.ts`) on the
 * parquet-l1 heights, with one difference the layout forces: every L2 band
 * covers a whole 100,000-height range, a whole 5,000-height sub-range, or a
 * sub-range cut short at the top (`isL1BandRange`), so the heights above the
 * frozen bands are covered by one band per sub-range rather than one tip.
 * Every id reads `l2-h<from>-<to>-…`; which bands are frozen is the
 * publisher's own fact, kept beside each band (`.publisher.json`
 * `settledAt`).
 *
 * - `h`: a whole range, always frozen. Built from the source when the whole
 *   range has settled at once (a bootstrap, a catch-up), or rolled, once
 *   its twenty `d` bands are frozen, by building it from the source again
 *   (deterministic: the same rows give the same band) and checking it
 *   against theirs.
 * - `d`: a whole sub-range, frozen once its top is the settle lag below the
 *   source's stable top.
 * - tip: every sub-range above the frozen bands, each rebuilt each run from
 *   the source and superseding the one before it of the same start; the
 *   top one is cut short at the stable top. When a sub-range settles, its
 *   tip band is rebuilt once more and frozen as its `d`.
 *
 * Frozen bands are re-settled on an interval: rebuilt from the source, and
 * replaced only when that adds rows, under the checks in `kind.ts`.
 */
import {
  isL1BandRange,
  L1_SPAN,
  L1_SUB_SPAN,
  l1RangeOf,
  l1SubRangeOf,
} from '../../../lib/parquet-l1/layout.js';
import { GridLayoutError } from '../root-tx/planner-grid.js';
import type { L2LiveBand } from './bands.js';

export type L2Role = 'h' | 'd' | 'tip';
export type L2StepKind = 'freeze' | 'roll' | 'tip' | 'resettle' | 'pin';

export interface L2Step {
  step: L2StepKind;
  role: L2Role;
  heightRange: [number, number];
  /** Live bands it replaces: what it is compared with, and supersedes. */
  replaces: L2LiveBand[];
  /** Whether the band built is frozen (its heights settled). */
  settles: boolean;
}

const isWholeRange = (from: number, to: number) => {
  const [rangeFrom, rangeTo] = l1RangeOf(from);
  return from === rangeFrom && to === rangeTo;
};

const isWholeSubRange = (from: number, to: number) => {
  const [subFrom, subTo] = l1SubRangeOf(from);
  return from === subFrom && to === subTo;
};

/**
 * A band's role: a whole range is `h`; a whole sub-range is `d` once frozen
 * (`settledAt`), a tip before; a sub-range cut short is a tip. Undefined off
 * the grid.
 */
export function l2Role(band: L2LiveBand): L2Role | undefined {
  if (!isL1BandRange(band.from, band.to)) return undefined;
  if (isWholeRange(band.from, band.to)) return 'h';
  if (
    isWholeSubRange(band.from, band.to) &&
    band.facts.settledAt !== undefined
  ) {
    return 'd';
  }
  return 'tip';
}

export interface L2GridBands {
  /** Frozen bands, by height. */
  frozen: L2LiveBand[];
  /** Tip bands, by height: one per sub-range above the frozen ones. */
  tips: L2LiveBand[];
}

/**
 * Sorts an index's live bands, or refuses them: a band off the grid, frozen
 * bands that overlap, a tip inside the frozen heights, or two tips of one
 * sub-range. Each is two bands nothing reconciles, so nothing is built
 * until an operator settles them.
 */
export function classifyL2Bands(bands: L2LiveBand[]): L2GridBands {
  const frozen: L2LiveBand[] = [];
  const tips: L2LiveBand[] = [];
  const problems: string[] = [];
  for (const band of bands) {
    const role = l2Role(band);
    if (role === undefined) {
      problems.push(`${band.id} [${band.from}, ${band.to}] is off the grid`);
    } else if (role === 'tip') {
      tips.push(band);
    } else {
      frozen.push(band);
    }
  }
  frozen.sort((a, b) => a.from - b.from);
  tips.sort((a, b) => a.from - b.from);
  for (let i = 1; i < frozen.length; i++) {
    if (frozen[i].from <= frozen[i - 1].to) {
      problems.push(`${frozen[i - 1].id} and ${frozen[i].id} overlap`);
    }
  }
  const top = l2FrozenTop(frozen);
  for (const [i, tip] of tips.entries()) {
    if (top !== undefined && tip.from <= top) {
      problems.push(`tip ${tip.id} lies inside the frozen heights`);
    }
    if (i > 0 && tips[i - 1].from === tip.from) {
      problems.push(
        `${tips[i - 1].id} and ${tip.id} are tips of one sub-range`,
      );
    }
  }
  if (problems.length > 0) {
    throw new GridLayoutError(
      `The parquet-l2 grid can't build on this publisher's bands: ${problems.join('; ')}. Move the bands that don't belong out of the index's publish directory, then run again`,
    );
  }
  return { frozen, tips };
}

/** The top of the highest frozen band, or undefined with none. */
export function l2FrozenTop(frozen: L2LiveBand[]): number | undefined {
  return frozen.length === 0
    ? undefined
    : Math.max(...frozen.map((band) => band.to));
}

/** Where a grid with nothing frozen starts: the start height's 100,000-height range. */
export const l2GridStart = (startHeight?: number) =>
  l1RangeOf(startHeight ?? 0)[0];

const within = (band: L2LiveBand, from: number, to: number) =>
  band.from >= from && band.to <= to;

/**
 * The bands to freeze, in height order, from above the frozen top for as
 * long as their tops are at or below the freeze limit (`settleBlocks`
 * below the stable top): a whole `h` where a whole range fits, otherwise
 * the next `d`. Each replaces the tip bands of its heights.
 */
export function planL2Freezes({
  bands,
  stableTop,
  settleBlocks,
  startHeight,
}: {
  bands: L2LiveBand[];
  stableTop: number;
  settleBlocks: number;
  startHeight?: number;
}): L2Step[] {
  const { frozen, tips } = classifyL2Bands(bands);
  const limit = stableTop - settleBlocks;
  const top = l2FrozenTop(frozen);
  let from = top !== undefined ? top + 1 : l2GridStart(startHeight);
  const steps: L2Step[] = [];
  for (;;) {
    let role: L2Role;
    if (from % L1_SPAN === 0 && from + L1_SPAN - 1 <= limit) role = 'h';
    else if (from + L1_SUB_SPAN - 1 <= limit) role = 'd';
    else break;
    const to = from + (role === 'h' ? L1_SPAN : L1_SUB_SPAN) - 1;
    steps.push({
      step: 'freeze',
      role,
      heightRange: [from, to],
      replaces: tips.filter((tip) => within(tip, from, to)),
      settles: true,
    });
    from = to + 1;
  }
  return steps;
}

/**
 * An `h` for each 100,000-height range whose twenty `d` bands are all
 * frozen, rebuilt from the source and replacing them.
 */
export function planL2Rolls(bands: L2LiveBand[]): L2Step[] {
  const { frozen } = classifyL2Bands(bands);
  const deltas = frozen.filter((band) => l2Role(band) === 'd');
  const ranges = [
    ...new Set(deltas.map((band) => l1RangeOf(band.from)[0])),
  ].sort((a, b) => a - b);
  const steps: L2Step[] = [];
  for (const rangeFrom of ranges) {
    const to = rangeFrom + L1_SPAN - 1;
    const folds = deltas.filter((band) => within(band, rangeFrom, to));
    if (folds.length < L1_SPAN / L1_SUB_SPAN) continue;
    steps.push({
      step: 'roll',
      role: 'h',
      heightRange: [rangeFrom, to],
      replaces: folds,
      settles: true,
    });
  }
  return steps;
}

/**
 * The tip: a band per sub-range from above the frozen top (or the grid's
 * start) to the stable top, the last cut short there, each replacing the
 * tip band of the same start.
 */
export function planL2Tip({
  bands,
  stableTop,
  startHeight,
  above,
}: {
  bands: L2LiveBand[];
  stableTop: number;
  startHeight?: number;
  /**
   * Heights at or below this are taken: a dry run's freezes, built but not
   * published.
   */
  above?: number;
}): L2Step[] {
  const { frozen, tips } = classifyL2Bands(bands);
  const top = Math.max(l2FrozenTop(frozen) ?? -1, above ?? -1);
  const steps: L2Step[] = [];
  for (
    let from = top >= 0 ? top + 1 : l2GridStart(startHeight);
    from <= stableTop;
    from += L1_SUB_SPAN
  ) {
    const to = Math.min(from + L1_SUB_SPAN - 1, stableTop);
    steps.push({
      step: 'tip',
      role: 'tip',
      heightRange: [from, to],
      replaces: tips.filter((tip) => tip.from === from),
      settles: false,
    });
  }
  return steps;
}

/**
 * Whether a frozen band is due to be re-settled: an interval after it was
 * settled or last re-settled, whichever is later. Never with an interval of
 * 0.
 */
export function l2ResettleDue(
  band: L2LiveBand,
  resettledAt: string | undefined,
  now: number,
  intervalMs: number,
): boolean {
  if (intervalMs <= 0) return false;
  const times = [resettledAt, band.facts.settledAt, band.facts.builtAt]
    .map((at) => (at === undefined ? Number.NaN : Date.parse(at)))
    .filter((at) => !Number.isNaN(at));
  return times.length === 0 || now - Math.max(...times) >= intervalMs;
}

/** The frozen bands to re-settle: due, or all when forced; the largest first. */
export function planL2Resettle(
  bands: L2LiveBand[],
  {
    now,
    intervalMs,
    force,
    resettledAt,
  }: {
    now: number;
    intervalMs: number;
    force: boolean;
    resettledAt: Record<string, string>;
  },
): L2Step[] {
  const { frozen } = classifyL2Bands(bands);
  return frozen
    .filter(
      (band) =>
        force || l2ResettleDue(band, resettledAt[band.id], now, intervalMs),
    )
    .sort(
      (a, b) =>
        b.band.tables.data_items.rows - a.band.tables.data_items.rows ||
        a.from - b.from,
    )
    .map((band) => ({
      step: 'resettle' as const,
      role: l2Role(band) as L2Role,
      heightRange: [band.from, band.to] as [number, number],
      replaces: [band],
      settles: true,
    }));
}

/**
 * One band of a given range, for an operator's run (`--range`): a whole
 * range or sub-range, or a sub-range cut short, at or below the stable top.
 * It is compared with this publisher's band of the same range, if any.
 */
export function planL2Pin({
  bands,
  range,
  stableTop,
  settleBlocks,
}: {
  bands: L2LiveBand[];
  range: [number, number];
  stableTop: number;
  settleBlocks: number;
}): L2Step {
  const [from, to] = range;
  if (!isL1BandRange(from, to)) {
    throw new GridLayoutError(
      `--range ${from}-${to} is not on the grid: a whole ${L1_SPAN}-height range, a whole ${L1_SUB_SPAN}-height sub-range, or a sub-range cut short`,
    );
  }
  if (to > stableTop) {
    throw new GridLayoutError(
      `--range ${from}-${to} reaches past the source's stable top, ${stableTop}`,
    );
  }
  const whole = isWholeRange(from, to);
  const settles =
    (whole || isWholeSubRange(from, to)) && to <= stableTop - settleBlocks;
  return {
    step: 'pin',
    role: whole ? 'h' : settles ? 'd' : 'tip',
    heightRange: [from, to],
    replaces: bands.filter((band) => band.from === from && band.to === to),
    settles,
  };
}

/** A step as a run's plan reports it. */
export interface L2PlanEntry {
  step: L2StepKind;
  role: L2Role;
  heightRange: [number, number];
  replaces?: string[];
  /** Not built this run, and why. */
  deferred?: string;
}

export function describeL2Step(step: L2Step, deferred?: string): L2PlanEntry {
  return {
    step: step.step,
    role: step.role,
    heightRange: step.heightRange,
    ...(step.replaces.length > 0
      ? { replaces: step.replaces.map((band) => band.id) }
      : {}),
    ...(deferred !== undefined ? { deferred } : {}),
  };
}
