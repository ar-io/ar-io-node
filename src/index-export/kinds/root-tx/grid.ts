/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * What the grid layout (see `planner-grid.ts`) reads from published bands:
 * the heights of the seeds' roots, to place each seed entry in the band its
 * height belongs to; whether a frozen band holds an entry; and how a
 * re-settled band differs from the band it would replace.
 */
import * as path from 'node:path';
import { Logger } from 'winston';

import { Cdb64Reader } from '../../../lib/cdb64.js';
import {
  decodeCdb64Value,
  getRootTxId,
  isCompleteValue,
} from '../../../lib/cdb64-encoding.js';
import {
  Cdb64Manifest,
  PARTITION_FILE_PATTERN,
} from '../../../lib/cdb64-manifest.js';
import { toB64Url } from '../../../lib/encoding.js';
import {
  BandRecord,
  BandSampleEntry,
  Reservoir,
} from '../../../lib/index-band/build.js';
import { openBandRecords } from '../../../lib/index-band/read.js';
import { PartitionedCdb64Reader } from '../../../lib/partitioned-cdb64-reader.js';
import type { OwnBand } from '../../state.js';
import type { BuildStep } from './planner.js';

/** The header-check stratum of every entry a re-settle relocates. */
export const RESETTLE_CHANGED_TAG = 'resettle-changed';
/** The header-check stratum of the entries a re-settle adds, sampled. */
export const RESETTLE_ADDED_TAG = 'resettle-added';

const rootKey = (root: Buffer) => root.toString('latin1');

/**
 * The heights of the seeds' roots, learned from the sources' rows as a run
 * reads them: an item's height is its root's, so one row under a root
 * places every seed entry under it. Bands store no heights, so this is how
 * a seed entry finds its band. Only the seeds' roots are kept, so memory
 * follows the seeds, not the heights read.
 */
export class RootHeights {
  private readonly heights = new Map<string, number>();

  /** Reads every seed's entries once for their roots. */
  static async of(seeds: OwnBand[]): Promise<RootHeights> {
    const heights = new RootHeights();
    for (const seed of seeds) {
      const opened = await openBandRecords(seed.dir, seed.top);
      try {
        for await (const record of opened.records) {
          heights.heights.set(rootKey(record.rootTxId), -1);
        }
      } finally {
        await opened.close();
      }
    }
    return heights;
  }

  /** Records a row's height for its root, when it is a seed's. */
  note(root: Buffer, height: number | undefined): void {
    if (height === undefined) return;
    const key = rootKey(root);
    const known = this.heights.get(key);
    if (known !== undefined && height > known) this.heights.set(key, height);
  }

  /** A seed root's height, or undefined when no row has given it yet. */
  get(root: Buffer): number | undefined {
    const height = this.heights.get(rootKey(root));
    return height === undefined || height < 0 ? undefined : height;
  }

  /** Seed roots, and how many of them have a height. */
  get counts(): { roots: number; placed: number } {
    let placed = 0;
    for (const height of this.heights.values()) if (height >= 0) placed += 1;
    return { roots: this.heights.size, placed };
  }
}

/** Where the seeds' entries went in one build. */
export interface SeedPlacement {
  /** Freeze: entries placed in the band, their root's height in its range. */
  placed: number;
  /**
   * Tip: entries left out, because their root's height is below the tip and
   * the frozen band of that height holds them.
   */
  settled: number;
  /**
   * Tip: entries kept although their root's height is below the tip, since
   * the frozen band of that height doesn't hold them (it was frozen before
   * their root was indexed). A re-settle of that band takes them in.
   */
  carried: number;
  /**
   * Tip: entries kept whose root no source gave this run (expired, or a
   * source that is down), at their seed's top.
   */
  unresolved: number;
}

export const emptyPlacement = (): SeedPlacement => ({
  placed: 0,
  settled: 0,
  carried: 0,
  unresolved: 0,
});

/**
 * The seeds' entries a step takes in, each at its root's height (bands
 * store no heights), as folded records: at equal height they beat a source's
 * row, so a correction already in a seed isn't undone, and a later
 * re-bundle still wins. Never an entry left out of every band:
 *
 * - **Freeze** `[from, to]`: the entries whose root's height is in it. The
 *   rest stay in the seeds, which the tip carries on.
 * - **Tip** `[from, tip]`: every entry, except one whose root's height is
 *   below `from` and that the frozen band of that height holds. One below
 *   `from` that no frozen band holds is kept (`carried`), and one whose
 *   root no source gave this run is kept at its seed's top (`unresolved`).
 *
 * Run after the step's sources have been read, so their rows have placed
 * the roots.
 */
export async function* placeSeedEntries(
  step: BuildStep,
  {
    rootHeights,
    frozenHolds,
  }: {
    rootHeights?: RootHeights;
    frozenHolds?: (id: Buffer, height: number) => Promise<boolean>;
  },
  placement: SeedPlacement,
): AsyncGenerator<BandRecord> {
  const [from, to] = step.heightRange;
  for (const seed of step.seeds ?? []) {
    const opened = await openBandRecords(seed.dir, seed.top);
    try {
      for await (const record of opened.records) {
        const height = rootHeights?.get(record.rootTxId);
        if (to !== null) {
          if (height === undefined || height < from || height > to) continue;
          placement.placed += 1;
          yield { ...record, height };
          continue;
        }
        if (height === undefined) {
          placement.unresolved += 1;
          yield record;
          continue;
        }
        if (height < from) {
          if (
            frozenHolds !== undefined &&
            (await frozenHolds(record.id, height))
          ) {
            placement.settled += 1;
            continue;
          }
          placement.carried += 1;
        }
        yield { ...record, height };
      }
    } finally {
      await opened.close();
    }
  }
}

/**
 * Answers whether the frozen band covering a height holds an id, opening
 * each band once. `close` releases them.
 */
export function frozenLookup(
  frozen: OwnBand[],
  log: Logger,
): {
  holds: (id: Buffer, height: number) => Promise<boolean>;
  close: () => Promise<void>;
} {
  const readers = new Map<string, PartitionedCdb64Reader>();
  return {
    holds: async (id, height) => {
      const band = frozen.find(
        (b) => b.from <= height && height <= (b.to as number),
      );
      if (band === undefined) return false;
      let reader = readers.get(band.id);
      if (reader === undefined) {
        reader = new PartitionedCdb64Reader({
          manifest: band.manifest,
          baseDir: band.dir,
          log,
        });
        await reader.open();
        readers.set(band.id, reader);
      }
      return (await reader.get(id, { localOnly: true })) !== undefined;
    },
    close: async () => {
      await Promise.all([...readers.values()].map((reader) => reader.close()));
      readers.clear();
    },
  };
}

/** How a rebuilt band differs from the band it would replace. */
export interface BandDiff {
  oldEntries: number;
  newEntries: number;
  /** Ids only the new band holds. */
  added: number;
  /** Ids whose root, offsets or size changed. */
  changed: number;
  unchanged: number;
  /** Ids only the old band holds: never allowed. */
  removed: number;
  removedSample: string[];
  /** Changed ids the new band holds without offsets, which no check can read. */
  unverifiable: number;
  unverifiableSample: string[];
  /**
   * Every changed id with offsets, up to the cap, for the header check
   * ({@link RESETTLE_CHANGED_TAG}).
   */
  changedEntries: BandSampleEntry[];
  /** A uniform sample of the added ids with offsets ({@link RESETTLE_ADDED_TAG}). */
  addedSample: BandSampleEntry[];
  /** The ids of `watch` (base64url) the new band added or changed. */
  watched: Set<string>;
}

const SAMPLE_IDS = 20;

function sampleEntry(
  key: Buffer,
  raw: Buffer,
  tag: string,
): BandSampleEntry | undefined {
  const value = decodeCdb64Value(raw);
  if (!isCompleteValue(value)) return undefined;
  return {
    id: toB64Url(key),
    rootTxId: toB64Url(getRootTxId(value)),
    rootOffset: value.rootDataItemOffset,
    rootDataOffset: value.rootDataOffset,
    tag,
  };
}

/** A partition's entries, in id order. */
interface PartitionEntries {
  keys: Buffer[];
  values: Buffer[];
}

/**
 * Reads a partition whole (bands hold a few hundred thousand entries a
 * partition), in id order: as written by `buildBand`, which writes ids in
 * order, or sorted here for a band written another way.
 */
async function readPartition(
  dir: string,
  filename: string | undefined,
): Promise<PartitionEntries> {
  const entries: PartitionEntries = { keys: [], values: [] };
  if (filename === undefined) return entries;
  if (!PARTITION_FILE_PATTERN.test(filename)) {
    throw new Error(
      `${dir} names ${JSON.stringify(filename)}, not a partition file`,
    );
  }
  const reader = new Cdb64Reader(path.join(dir, filename));
  await reader.open();
  let sorted = true;
  try {
    for await (const batch of reader.entryBatches()) {
      for (const { key, value } of batch) {
        const last = entries.keys.length - 1;
        if (sorted && last >= 0 && entries.keys[last].compare(key) >= 0) {
          sorted = false;
        }
        entries.keys.push(key);
        entries.values.push(value);
      }
    }
  } finally {
    await reader.close();
  }
  if (!sorted) {
    const order = entries.keys.map((_, i) => i);
    order.sort((a, b) => entries.keys[a].compare(entries.keys[b]));
    return {
      keys: order.map((i) => entries.keys[i]),
      values: order.map((i) => entries.values[i]),
    };
  }
  return entries;
}

const filesByPrefix = (manifest: Cdb64Manifest, dir: string) =>
  new Map(
    manifest.partitions.map((partition) => {
      if (partition.location.type !== 'file') {
        throw new Error(
          `${dir}: partition ${partition.prefix} is not a local file`,
        );
      }
      return [partition.prefix, partition.location.filename] as const;
    }),
  );

/**
 * Compares two bands entry by entry, one partition at a time, so memory is
 * bounded by the largest partition of either: each is read whole in large
 * pieces and the two are walked side by side in id order. Raw values are
 * compared, so a root, offsets or size that changed is a change, and an id
 * either band holds alone is added or removed. `watch` names ids
 * (base64url) to report in `watched` when they are added or changed.
 */
export async function diffBands(
  old: { dir: string; manifest: Cdb64Manifest },
  next: { dir: string; manifest: Cdb64Manifest },
  {
    maxChanged,
    addedSampleSize,
    watch = new Set(),
    random = Math.random,
  }: {
    maxChanged: number;
    addedSampleSize: number;
    watch?: ReadonlySet<string>;
    random?: () => number;
  },
): Promise<BandDiff> {
  const diff: BandDiff = {
    oldEntries: 0,
    newEntries: 0,
    added: 0,
    changed: 0,
    unchanged: 0,
    removed: 0,
    removedSample: [],
    unverifiable: 0,
    unverifiableSample: [],
    changedEntries: [],
    addedSample: [],
    watched: new Set(),
  };
  const noteWatched = (key: Buffer) => {
    if (watch.size === 0) return;
    const id = toB64Url(key);
    if (watch.has(id)) diff.watched.add(id);
  };
  const added = new Reservoir<BandSampleEntry>(addedSampleSize, random);
  const oldFiles = filesByPrefix(old.manifest, old.dir);
  const newFiles = filesByPrefix(next.manifest, next.dir);
  const prefixes = [
    ...new Set([...oldFiles.keys(), ...newFiles.keys()]),
  ].sort();
  for (const prefix of prefixes) {
    const before = await readPartition(old.dir, oldFiles.get(prefix));
    const after = await readPartition(next.dir, newFiles.get(prefix));
    diff.oldEntries += before.keys.length;
    diff.newEntries += after.keys.length;
    let i = 0;
    let j = 0;
    while (i < before.keys.length || j < after.keys.length) {
      const order =
        i === before.keys.length
          ? 1
          : j === after.keys.length
            ? -1
            : before.keys[i].compare(after.keys[j]);
      if (order < 0) {
        diff.removed += 1;
        if (diff.removedSample.length < SAMPLE_IDS) {
          diff.removedSample.push(toB64Url(before.keys[i]));
        }
        i += 1;
        continue;
      }
      const key = after.keys[j];
      const value = after.values[j];
      j += 1;
      if (order > 0) {
        diff.added += 1;
        noteWatched(key);
        const entry = sampleEntry(key, value, RESETTLE_ADDED_TAG);
        if (entry !== undefined) added.offer(entry);
        continue;
      }
      const was = before.values[i];
      i += 1;
      if (was.equals(value)) {
        diff.unchanged += 1;
        continue;
      }
      diff.changed += 1;
      noteWatched(key);
      const entry = sampleEntry(key, value, RESETTLE_CHANGED_TAG);
      if (entry === undefined) {
        diff.unverifiable += 1;
        if (diff.unverifiableSample.length < SAMPLE_IDS) {
          diff.unverifiableSample.push(toB64Url(key));
        }
      } else if (diff.changedEntries.length < maxChanged) {
        diff.changedEntries.push(entry);
      }
    }
  }
  diff.addedSample = added.items;
  return diff;
}
