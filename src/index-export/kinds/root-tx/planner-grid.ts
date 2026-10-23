/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * What to build next for the root-TX index in the grid layout
 * (`INDEX_EXPORT_ROOT_TX_LAYOUT=grid`), as pure functions of what is
 * published, how far the sources reach and the clock. No I/O; the service
 * runs the steps.
 *
 * The bands sit on the parquet-l1 grid ({@link L1_SPAN} and
 * {@link L1_SUB_SPAN}), so every publisher cuts the chain at the same
 * heights:
 *
 * - `h`: a whole 100,000-height range. Rolled from its twenty `d` bands once
 *   they all exist (their entries alone), or built from the sources when a
 *   whole range lies below the freeze limit at once (a bootstrap, or a
 *   run catching up).
 * - `d`: a whole 5,000-height range, frozen once its top is the settle lag
 *   below the stable top: the sources' rows for its heights plus the seeds'
 *   entries whose root's height falls in them.
 * - `tip`: from above the frozen bands to the tip, rebuilt each run from the
 *   sources and the previous tip's entries, superseding it.
 *
 * Entries keep arriving after their block (late unbundling, retries,
 * re-bundles), so each frozen band is re-settled on an interval: rebuilt
 * from its own entries and the sources' rows for its range, and replaced
 * only when that adds or relocates entries, under the checks in `kind.ts`.
 */
import {
  L1_SPAN,
  L1_SUB_SPAN,
  l1RangeOf,
  l1SubRangeOf,
} from '../../../lib/parquet-l1/layout.js';
import type { BandRole, OwnBand } from '../../state.js';
import type { BuildStep, GridStepKind } from './planner.js';

/** Own bands the grid layout can't build on: off the grid, or overlapping. */
export class GridLayoutError extends Error {}

/** This publisher's live bands, as the grid layout uses them. */
export interface GridBands {
  /** Closed bands on the grid, by height: what freezes, rolls and re-settles build on. */
  frozen: OwnBand[];
  /** Bands whose entries the next freezes and tip take in; the tip supersedes them. */
  seeds: OwnBand[];
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
 * Sorts this publisher's live bands for the grid layout, or refuses them.
 *
 * - **Frozen:** an `h` over a whole 100,000-height range, a `d` over a whole
 *   5,000-height range, or an `r` over a whole 100,000-height range (a
 *   legacy layout's frozen recent band).
 * - **Seeds:** a `tip`, a band open at the tip (a legacy layout's delta), or
 *   an `r` that starts a 100,000-height range and stops short of its end (a
 *   legacy layout's recent band). Their entries move into the bands the
 *   grid builds, and the tip supersedes them.
 *
 * Refused, so that nothing is built: any other range, an `h` open at the
 * tip, a closed `tip`, and frozen bands that overlap. A band that replaces
 * another names it in `supersedes`, which leaves only the newer one live,
 * so an overlap is two bands nothing reconciles.
 */
export function classifyGridBands(bands: OwnBand[]): GridBands {
  const frozen: OwnBand[] = [];
  const seeds: OwnBand[] = [];
  const problems: string[] = [];
  for (const band of bands) {
    const range = `${band.role} [${band.from}, ${band.to ?? 'tip'}]`;
    if (band.to === null) {
      if (band.role === 'h') {
        problems.push(
          `${band.id} (${range}) is a history band open at the tip`,
        );
      } else {
        seeds.push(band);
      }
      continue;
    }
    const [rangeFrom, rangeTo] = l1RangeOf(band.from);
    if (
      ((band.role === 'h' || band.role === 'r') &&
        isWholeRange(band.from, band.to)) ||
      (band.role === 'd' && isWholeSubRange(band.from, band.to))
    ) {
      frozen.push(band);
    } else if (
      band.role === 'r' &&
      band.from === rangeFrom &&
      band.to < rangeTo
    ) {
      seeds.push(band);
    } else {
      problems.push(
        band.role === 'tip'
          ? `${band.id} (${range}) is a tip band with an end`
          : `${band.id} (${range}) is off the grid`,
      );
    }
  }
  frozen.sort((a, b) => a.from - b.from);
  let reach: OwnBand | undefined;
  for (const band of frozen) {
    if (reach !== undefined && band.from <= (reach.to as number)) {
      problems.push(
        `${reach.id} and ${band.id} overlap, and neither supersedes the other`,
      );
    }
    if (reach === undefined || (band.to as number) > (reach.to as number)) {
      reach = band;
    }
  }
  if (problems.length > 0) {
    throw new GridLayoutError(
      `The grid layout can't build on this publisher's bands: ${problems.join('; ')}. Bands are cut at multiples of ${L1_SPAN} (h) and ${L1_SUB_SPAN} (d) heights: rebuild such a range on the grid (index-band-build, naming the old band in --supersedes) or move the band out of the publish directory, then run again`,
    );
  }
  return { frozen, seeds };
}

/** The top of the highest frozen band, or undefined with none. */
export function frozenTop(frozen: OwnBand[]): number | undefined {
  return frozen.length === 0
    ? undefined
    : Math.max(...frozen.map((band) => band.to as number));
}

/** Where a grid with nothing frozen starts: the start height's 100,000-height range. */
export function gridStart(startHeight?: number): number {
  return l1RangeOf(startHeight ?? 0)[0];
}

export interface GridPlanInput {
  /** This publisher's live bands. */
  bands: OwnBand[];
  /** The highest height every required source holds. */
  stableTop: number;
  /** Blocks a range waits below the stable top before it is frozen. */
  settleBlocks: number;
  startHeight?: number;
}

/**
 * The bands to freeze, in height order, from above the frozen top (or the
 * start height's range, with nothing frozen) for as long as their tops are
 * at or below the freeze limit, `settleBlocks` below the stable top: a whole
 * `h` where a whole 100,000-height range fits, otherwise the next `d`. Each
 * reads the sources for its heights and takes in the seeds' entries that
 * belong there.
 */
export function planFreezes({
  bands,
  stableTop,
  settleBlocks,
  startHeight,
}: GridPlanInput): BuildStep[] {
  const { frozen, seeds } = classifyGridBands(bands);
  const limit = stableTop - settleBlocks;
  const top = frozenTop(frozen);
  let from = top !== undefined ? top + 1 : gridStart(startHeight);
  const steps: BuildStep[] = [];
  for (;;) {
    let role: BandRole;
    if (from % L1_SPAN === 0 && from + L1_SPAN - 1 <= limit) {
      role = 'h';
    } else if (from + L1_SUB_SPAN - 1 <= limit) {
      role = 'd';
    } else {
      break;
    }
    const to = from + (role === 'h' ? L1_SPAN : L1_SUB_SPAN) - 1;
    steps.push({
      grid: 'freeze',
      role,
      heightRange: [from, to],
      read: [from, to],
      supersedes: [],
      freezes: true,
      ...(seeds.length > 0 ? { seeds } : {}),
    });
    from = to + 1;
  }
  return steps;
}

/** A roll, and the `d` ranges it waits for that a dry run built but did not publish. */
export interface GridRoll {
  step: BuildStep;
  awaits: Array<[number, number]>;
}

/**
 * A whole `h` for each 100,000-height range whose twenty `d` bands are all
 * frozen, built from their entries alone and superseding them. `built`
 * are ranges a dry run built without publishing: a roll that `d` ranges
 * among them complete lists them in `awaits`, to report rather than build.
 */
export function planRolls(
  bands: OwnBand[],
  built: Array<[number, number]> = [],
): GridRoll[] {
  const { frozen } = classifyGridBands(bands);
  const deltas = frozen.filter((band) => band.role === 'd');
  const planned = built.filter(([from, to]) => isWholeSubRange(from, to));
  const ranges = [
    ...new Set(
      [
        ...deltas.map((band) => band.from),
        ...planned.map(([from]) => from),
      ].map((from) => l1RangeOf(from)[0]),
    ),
  ].sort((a, b) => a - b);
  const rolls: GridRoll[] = [];
  for (const rangeFrom of ranges) {
    const folds: OwnBand[] = [];
    const awaits: Array<[number, number]> = [];
    for (
      let from = rangeFrom;
      from < rangeFrom + L1_SPAN;
      from += L1_SUB_SPAN
    ) {
      const band = deltas.find((b) => b.from === from);
      if (band !== undefined) {
        folds.push(band);
      } else if (planned.some(([plannedFrom]) => plannedFrom === from)) {
        awaits.push([from, from + L1_SUB_SPAN - 1]);
      }
    }
    if (folds.length + awaits.length < L1_SPAN / L1_SUB_SPAN) continue;
    rolls.push({
      step: {
        grid: 'roll',
        role: 'h',
        heightRange: [rangeFrom, rangeFrom + L1_SPAN - 1],
        folds,
        supersedes: folds.map((band) => band.id),
      },
      awaits,
    });
  }
  return rolls;
}

/**
 * Where the tip starts: above the bands that were frozen when the run
 * began, so that on a day bands freeze the tip still covers their heights,
 * and no order of installing the new bands leaves a subscriber a gap; it
 * moves up over them the next run. With nothing frozen at the start (a
 * bootstrap), above what the run froze; with nothing frozen at all, at the
 * grid's start.
 */
export function tipStart(
  frozenTopAtStart: number | undefined,
  frozenTopNow: number | undefined,
  startHeight?: number,
): number {
  if (frozenTopAtStart !== undefined) return frozenTopAtStart + 1;
  if (frozenTopNow !== undefined) return frozenTopNow + 1;
  return gridStart(startHeight);
}

/**
 * The tip, `[from, tip]`: the sources' rows from `from` to the stable top,
 * plus the seeds' entries, superseding every seed. The sources are read
 * from the lowest seed's start, the rows below `from` only to place the
 * seeds' entries (see `placeSeedEntries`). It `replaces` the tip of the same
 * start when that is the only seed, so unchanged content is not published
 * again. Nothing when the sources don't reach `from`.
 */
export function planTip({
  bands,
  stableTop,
  from,
}: {
  bands: OwnBand[];
  stableTop: number;
  from: number;
}): BuildStep | undefined {
  const { seeds } = classifyGridBands(bands);
  if (stableTop < from) return undefined;
  const readFrom = Math.min(from, ...seeds.map((band) => band.from));
  const same =
    seeds.length === 1 && seeds[0].role === 'tip' && seeds[0].from === from
      ? seeds[0]
      : undefined;
  return {
    grid: 'tip',
    role: 'tip',
    heightRange: [from, null],
    read: [readFrom, stableTop],
    keepFrom: from,
    supersedes: seeds.map((band) => band.id),
    ...(seeds.length > 0 ? { seeds } : {}),
    ...(same !== undefined ? { replaces: same } : {}),
  };
}

/**
 * Whether a frozen band is due to be re-settled: an interval after it was
 * built or last re-settled, whichever is later. Never with an interval of 0.
 */
export function resettleDue(
  band: OwnBand,
  settledAt: string | undefined,
  now: number,
  intervalMs: number,
): boolean {
  if (intervalMs <= 0) return false;
  const times = [settledAt, band.manifest.createdAt]
    .map((at) => (at === undefined ? Number.NaN : Date.parse(at)))
    .filter((at) => !Number.isNaN(at));
  return times.length === 0 || now - Math.max(...times) >= intervalMs;
}

/**
 * The re-settle pass: every frozen band that is due, or all of them when
 * forced, the one with the most entries first. Each is rebuilt from its own
 * entries (folded at its top, so a source's row never displaces one; only
 * an overlay can relocate it) and the sources' rows for its range, as the
 * same role (a legacy frozen `r` as an `h`), replacing and superseding the
 * band it rebuilds.
 */
export function planResettle(
  bands: OwnBand[],
  {
    now,
    intervalMs,
    force,
    settledAt,
  }: {
    now: number;
    intervalMs: number;
    force: boolean;
    settledAt: Record<string, string>;
  },
): BuildStep[] {
  const { frozen } = classifyGridBands(bands);
  return frozen
    .filter(
      (band) => force || resettleDue(band, settledAt[band.id], now, intervalMs),
    )
    .sort(
      (a, b) =>
        b.manifest.totalRecords - a.manifest.totalRecords || a.from - b.from,
    )
    .map((band) => ({
      grid: 'resettle',
      role: band.role === 'r' ? 'h' : band.role,
      heightRange: [band.from, band.to],
      read: [band.from, band.to as number],
      fold: band,
      replaces: band,
      supersedes: [band.id],
    }));
}

/** A step as a run's plan reports it. */
export interface GridPlanEntry {
  step: GridStepKind;
  role: BandRole;
  heightRange: [number, number | null];
  supersedes: string[];
  /** Heights read from the sources. */
  read?: [number, number];
  /** Bands whose entries are folded in whole: a roll's, or a re-settled band. */
  folds?: string[];
  /** Bands whose entries are placed by their root's height. */
  seeds?: string[];
  /** The band an unchanged build leaves in place. */
  replaces?: string;
  /** A dry run's roll: `d` ranges it built but did not publish. */
  awaits?: Array<[number, number]>;
  /** Not built this run, and why. */
  deferred?: string;
}

/** How the run's plan reports a step. */
export function describeGridStep(
  step: BuildStep,
  more: { awaits?: Array<[number, number]>; deferred?: string } = {},
): GridPlanEntry {
  const folds = [
    ...(step.fold !== undefined ? [step.fold] : []),
    ...(step.folds ?? []),
  ];
  return {
    step: step.grid ?? 'freeze',
    role: step.role,
    heightRange: step.heightRange,
    supersedes: step.supersedes,
    ...(step.read !== undefined ? { read: step.read } : {}),
    ...(folds.length > 0 ? { folds: folds.map((band) => band.id) } : {}),
    ...(step.seeds !== undefined
      ? { seeds: step.seeds.map((band) => band.id) }
      : {}),
    ...(step.replaces !== undefined ? { replaces: step.replaces.id } : {}),
    ...(more.awaits !== undefined && more.awaits.length > 0
      ? { awaits: more.awaits }
      : {}),
    ...(more.deferred !== undefined ? { deferred: more.deferred } : {}),
  };
}
