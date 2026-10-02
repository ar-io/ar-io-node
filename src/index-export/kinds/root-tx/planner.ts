/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * What to build next for the root-TX index, as pure functions of what is
 * published and how far the sources reach. No I/O; the service runs the
 * steps.
 *
 * The bands, by role:
 *
 * - `h` (history): fixed, closed, never rebuilt.
 * - `r` (recent): `[R_lo, R_hi]`, closed, folded weekly: the previous `r`'s
 *   entries plus the sources' rows above it. Once its span reaches the
 *   maximum it is frozen (a planner rule: it is simply never folded again)
 *   and the next fold starts a new `r` above it.
 * - `d` (delta): `[top + 1 - OVERLAP, tip]` over the highest `h` or `r`,
 *   rebuilt daily from the sources.
 */
import type { BandRole, OwnBand } from '../../state.js';

/** Heights a delta reaches below the band it extends, for late indexing. */
export const OVERLAP_BLOCKS = 512;
/** How often the recent band is folded. */
export const FOLD_INTERVAL_MS = 7 * 24 * 3600 * 1000;

/** One band to build. */
export interface BuildStep {
  role: BandRole;
  /** The band's declared range; `to` null for a delta. */
  heightRange: [number, number | null];
  /** Heights to read from the sources. */
  read: [number, number];
  /** A band whose entries are folded in, at its top height. */
  fold?: OwnBand;
  supersedes: string[];
  /** The band a delta replaces, to skip publishing unchanged content. */
  replaces?: OwnBand;
  /** A recent band that reaches the maximum span: frozen once published. */
  freezes?: boolean;
}

export interface PlanInput {
  bands: OwnBand[];
  /** The highest height every required source holds. */
  stableTop: number;
  startHeight?: number;
  recentMaxBlocks: number;
}

const span = (band: OwnBand) => band.top - band.from + 1;

/** The `r` still being folded: the highest one under the maximum span. */
export function currentRecent(
  bands: OwnBand[],
  recentMaxBlocks: number,
): OwnBand | undefined {
  const recent = bands
    .filter((band) => band.role === 'r')
    .sort((a, b) => b.top - a.top);
  const top = recent[0];
  return top !== undefined && span(top) < recentMaxBlocks ? top : undefined;
}

/** The highest height an `h` or `r` covers; a delta starts above it. */
export function coveredTop(bands: OwnBand[]): number | undefined {
  const tops = bands
    .filter((band) => band.role !== 'd')
    .map((band) => band.top);
  return tops.length > 0 ? Math.max(...tops) : undefined;
}

/**
 * Where bootstrapping starts, or undefined when it is done. A publisher with
 * no `h` or `r` starts at the start height; one without an `r` whose
 * history stops more than a span below the stable top (a bootstrap that was
 * interrupted) carries on above it.
 */
export function bootstrapFrom({
  bands,
  stableTop,
  startHeight,
  recentMaxBlocks,
}: PlanInput): number | undefined {
  const covering = bands.filter((band) => band.role !== 'd');
  if (covering.length === 0) {
    if (startHeight === undefined) {
      throw new Error(
        'No bands of this publisher yet: set INDEX_EXPORT_START_HEIGHT to the lowest height to build (or adopt existing bands)',
      );
    }
    return startHeight;
  }
  if (covering.some((band) => band.role === 'r')) return undefined;
  const covered = coveredTop(bands) as number;
  return covered + recentMaxBlocks <= stableTop ? covered + 1 : undefined;
}

/**
 * Bootstrap from `from` to the stable top: an `h` per span between fixed
 * edges (multiples of the maximum), the last partial span as the first `r`.
 * A delta follows, planned by {@link planDelta} once these are published.
 */
export function planBootstrap(
  { stableTop, recentMaxBlocks }: PlanInput,
  from: number,
): BuildStep[] {
  const steps: BuildStep[] = [];
  let start = from;
  while (start <= stableTop) {
    const edgeEnd =
      (Math.floor(start / recentMaxBlocks) + 1) * recentMaxBlocks - 1;
    if (edgeEnd <= stableTop) {
      steps.push({
        role: 'h',
        heightRange: [start, edgeEnd],
        read: [start, edgeEnd],
        supersedes: [],
      });
      start = edgeEnd + 1;
    } else {
      steps.push({
        role: 'r',
        heightRange: [start, stableTop],
        read: [start, stableTop],
        supersedes: [],
      });
      break;
    }
  }
  return steps;
}

/**
 * The weekly fold, when due. The current `r` folds in the sources' rows from
 * just below its top to the stable top, capped at the maximum span; with no
 * `r` being folded (none, or the last one frozen), a new one starts above
 * the highest covered height. Nothing when there is nothing new to cover.
 */
export function planFold({
  bands,
  stableTop,
  recentMaxBlocks,
}: PlanInput): BuildStep | undefined {
  const recent = currentRecent(bands, recentMaxBlocks);
  if (recent !== undefined) {
    const to = Math.min(stableTop, recent.from + recentMaxBlocks - 1);
    if (to <= recent.top) return undefined;
    // Every unfrozen r inside the new range goes: the one folded, and any a
    // run that lost its lock left beside it.
    const replaced = bands.filter(
      (band) =>
        band.role === 'r' &&
        band.from >= recent.from &&
        band.top <= to &&
        span(band) < recentMaxBlocks,
    );
    return {
      role: 'r',
      heightRange: [recent.from, to],
      read: [Math.max(recent.from, recent.top + 1 - OVERLAP_BLOCKS), to],
      fold: recent,
      supersedes: replaced.map((band) => band.id),
      freezes: to - recent.from + 1 >= recentMaxBlocks,
    };
  }
  const covered = coveredTop(bands);
  if (covered === undefined || stableTop <= covered) return undefined;
  const from = covered + 1;
  const to = Math.min(stableTop, from + recentMaxBlocks - 1);
  return {
    role: 'r',
    heightRange: [from, to],
    read: [from, to],
    supersedes: [],
    freezes: to - from + 1 >= recentMaxBlocks,
  };
}

/**
 * The daily delta: from just below the highest covered height to the stable
 * top, replacing the current deltas. Nothing when the sources don't reach
 * above the covered height.
 */
export function planDelta({
  bands,
  stableTop,
}: PlanInput): BuildStep | undefined {
  const covered = coveredTop(bands);
  if (covered === undefined || stableTop <= covered) return undefined;
  const from = Math.max(0, covered + 1 - OVERLAP_BLOCKS);
  const deltas = bands.filter((band) => band.role === 'd');
  const same = deltas.find((band) => band.from === from && band.to === null);
  return {
    role: 'd',
    heightRange: [from, null],
    read: [from, stableTop],
    supersedes: deltas.map((band) => band.id),
    ...(same !== undefined ? { replaces: same } : {}),
  };
}

/** Whether the weekly fold is due. */
export function foldDue(lastFoldAt: string | undefined, now: number): boolean {
  if (lastFoldAt === undefined) return true;
  const at = Date.parse(lastFoldAt);
  return Number.isNaN(at) || now - at >= FOLD_INTERVAL_MS;
}
