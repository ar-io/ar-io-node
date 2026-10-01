/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { Cdb64Reader } from '../cdb64.js';
import {
  Cdb64RootTxValue,
  decodeCdb64Value,
  getDataItemSize,
  getRootTxId,
  isCompleteValue,
  isPathCompleteValue,
  isPathValue,
} from '../cdb64-encoding.js';
import {
  Cdb64Manifest,
  PARTITION_FILE_PATTERN,
  parseManifest,
} from '../cdb64-manifest.js';
import type { BandRecord } from './build.js';

/** Reads a band's manifest. */
export async function readBandManifest(
  bandDir: string,
): Promise<Cdb64Manifest> {
  return parseManifest(
    await fs.readFile(path.join(bandDir, 'manifest.json'), 'utf8'),
  );
}

/**
 * Opens every partition of a band on disk. The manifest may come from
 * anywhere, so only local partition files are opened.
 */
async function openPartitions(
  bandDir: string,
  manifest: Cdb64Manifest,
): Promise<Cdb64Reader[]> {
  const readers: Cdb64Reader[] = [];
  try {
    for (const partition of manifest.partitions) {
      if (partition.location.type !== 'file') {
        throw new Error(
          `Partition ${partition.prefix} is not a local file; only local bands can be read`,
        );
      }
      if (!PARTITION_FILE_PATTERN.test(partition.location.filename)) {
        throw new Error(
          `Partition ${partition.prefix} names ${JSON.stringify(partition.location.filename)}, not a partition file`,
        );
      }
      const reader = new Cdb64Reader(
        path.join(bandDir, partition.location.filename),
      );
      await reader.open();
      readers.push(reader);
    }
  } catch (error) {
    await Promise.all(readers.map((reader) => reader.close()));
    throw error;
  }
  return readers;
}

/** Every entry of a band on disk, partition by partition. */
export async function* bandEntries(
  bandDir: string,
  manifest: Cdb64Manifest,
): AsyncGenerator<{ key: Buffer; value: Cdb64RootTxValue }> {
  const readers = await openPartitions(bandDir, manifest);
  try {
    for (const reader of readers) {
      for await (const { key, value } of reader.entries()) {
        yield { key, value: decodeCdb64Value(value) };
      }
    }
  } finally {
    await Promise.all(readers.map((reader) => reader.close()));
  }
}

/** What {@link openBandRecords} has read so far. */
export interface FoldStats {
  /** Entries returned as records. */
  records: number;
  /**
   * Entries skipped because they hold a path (nested items), which bands
   * built by {@link buildBand} never do.
   */
  pathSkipped: number;
}

/**
 * Opens a published band to fold into its successor: every entry comes back
 * as a record, `folded`, at `height` (bands store no heights).
 *
 * `height` is the band's top. For a closed band it must be the top of its
 * `heightRange`, and is checked against it; for a band open at the tip (an
 * adopted one), the caller supplies it and it must be at least the bottom.
 * Too high, and a stale entry would beat a later re-bundle; too low, and a
 * source re-exporting the old row would undo a correction folded in.
 *
 * Every partition is opened before this returns, so a band that is retired
 * (and deleted) while it is read is still read whole. The entries read are
 * checked against the manifest's count at the end. `stats` is complete once
 * `records` has been read to the end; call `close` if it never is.
 */
export async function openBandRecords(
  bandDir: string,
  height: number,
): Promise<{
  records: AsyncIterable<BandRecord>;
  stats: FoldStats;
  close: () => Promise<void>;
}> {
  if (!Number.isSafeInteger(height) || height < 0) {
    throw new Error(`Folded height must be a non-negative integer: ${height}`);
  }
  const manifest = await readBandManifest(bandDir).catch((error: Error) => {
    throw new Error(`Cannot fold ${bandDir}: ${error.message}`);
  });
  const range = manifest.metadata?.heightRange;
  if (
    !Array.isArray(range) ||
    range.length !== 2 ||
    typeof range[0] !== 'number' ||
    (range[1] !== null && typeof range[1] !== 'number')
  ) {
    throw new Error(`Cannot fold ${bandDir}: its manifest has no heightRange`);
  }
  const [from, to] = range as [number, number | null];
  if (to !== null && height !== to) {
    throw new Error(
      `Cannot fold ${bandDir} at height ${height}: the band ends at ${to}`,
    );
  }
  if (height < from) {
    throw new Error(
      `Cannot fold ${bandDir} at height ${height}: the band starts at ${from}`,
    );
  }

  const readers = await openPartitions(bandDir, manifest).catch(
    (error: Error) => {
      throw new Error(`Cannot fold ${bandDir}: ${error.message}`);
    },
  );
  const close = async () => {
    await Promise.all(readers.map((reader) => reader.close()));
  };
  const stats: FoldStats = { records: 0, pathSkipped: 0 };
  async function* records(): AsyncGenerator<BandRecord> {
    try {
      for (const reader of readers) {
        for await (const { key, value: raw } of reader.entries()) {
          const value = decodeCdb64Value(raw);
          if (isPathValue(value) || isPathCompleteValue(value)) {
            stats.pathSkipped += 1;
            continue;
          }
          const record: BandRecord = {
            id: key,
            rootTxId: getRootTxId(value),
            height,
            folded: true,
          };
          if (isCompleteValue(value)) {
            record.rootOffset = value.rootDataItemOffset;
            record.rootDataOffset = value.rootDataOffset;
            const size = getDataItemSize(value);
            if (size !== undefined) record.size = size;
          }
          stats.records += 1;
          yield record;
        }
      }
      const read = stats.records + stats.pathSkipped;
      if (read !== manifest.totalRecords) {
        throw new Error(
          `Cannot fold ${bandDir}: read ${read} entries, its manifest says ${manifest.totalRecords}`,
        );
      }
    } finally {
      await close();
    }
  }
  return { records: records(), stats, close };
}
