/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { BandRecord } from '../../../../lib/index-band/build.js';
import { readBandRecordsCsv } from '../../../../lib/index-band/csv.js';
import {
  countDrop,
  newSourceStats,
  RecordSource,
  SourceStats,
} from './rows.js';

/**
 * An overlay file: `<from>-<to>.csv`, covering exactly those heights. Temp
 * names (`*.tmp`, `*.partial`) and dot-files don't match, so a producer
 * writes under one of those and renames when done.
 */
const OVERLAY_FILE = /^(\d+)-(\d+)\.csv$/;

export interface OverlayFile {
  name: string;
  from: number;
  to: number;
}

/** The overlay files in a directory, by coverage; anything else is ignored. */
export async function listOverlayFiles(dir: string): Promise<OverlayFile[]> {
  const names = await fs.readdir(dir);
  const files: OverlayFile[] = [];
  for (const name of names) {
    const match = OVERLAY_FILE.exec(name);
    if (match === null) continue;
    const from = Number(match[1]);
    const to = Number(match[2]);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to < from) {
      continue;
    }
    files.push({ name, from, to });
  }
  return files.sort((a, b) => a.from - b.from || a.to - b.to);
}

/**
 * An authoritative overlay, such as a bundler's own offsets: a directory of
 * CSV files in the format `index-band-build` reads (`height` required), each
 * named for the heights it covers. Files may not overlap.
 *
 * Its records are rank 1 with the file's coverage as `coverageTo`, so they
 * beat every peer's except a peer's row above that coverage (a later
 * re-bundle). A row outside its file's coverage is left out
 * (`outside_coverage`). It doesn't cap the run's stable height.
 *
 * Producers write a file under a temp name (`*.tmp`, `*.partial`) and rename
 * it into place, and replace a file the same way.
 */
export class CsvOverlaySource implements RecordSource {
  readonly stats: SourceStats = newSourceStats();

  /**
   * @param rank 1 (the default) for an overlay; 0 for a peer's records
   *   exported to files (another indexer's `index-band-export`, where its
   *   database isn't reachable), which compete like any peer's and, like
   *   one, cap the run's stable height at their coverage.
   */
  constructor(
    readonly name: string,
    readonly dir: string,
    readonly rank: 0 | 1 = 1,
  ) {}

  /** The top of the highest file's coverage, or -1 with no files. */
  async stableHeight(): Promise<number> {
    const files = await this.files();
    return files.reduce((top, file) => Math.max(top, file.to), -1);
  }

  async *records(from: number, to: number): AsyncIterable<BandRecord> {
    const files = (await this.files()).filter(
      (file) => file.to >= from && file.from <= to,
    );
    for (let i = 1; i < files.length; i++) {
      if (files[i].from <= files[i - 1].to) {
        throw new Error(
          `Overlay ${this.name} (${this.dir}): ${files[i - 1].name} and ${files[i].name} overlap; give each height to one file`,
        );
      }
    }
    for (const file of files) {
      const filePath = path.join(this.dir, file.name);
      const handle = await fs.open(filePath, 'r');
      try {
        // Read through the handle opened above, so a file renamed over
        // this one meanwhile isn't mixed in.
        const rows = readBandRecordsCsv(
          () => handle.createReadStream({ start: 0, autoClose: false }),
          { skipHeader: await hasHeader(handle) },
        );
        try {
          for await (const row of rows) {
            this.stats.rowsRead += 1;
            const height = row.height;
            if (height === undefined) {
              countDrop(this.stats, 'no_height');
              continue;
            }
            if (height < file.from || height > file.to) {
              countDrop(this.stats, 'outside_coverage');
              continue;
            }
            if (height < from || height > to) continue;
            if (row.rootOffset === undefined) this.stats.rootOnly += 1;
            this.stats.records += 1;
            yield this.rank === 1
              ? { ...row, rank: 1, coverageTo: file.to, source: this.name }
              : { ...row, source: this.name };
          }
        } catch (error) {
          throw new Error(
            `Overlay ${this.name}, ${filePath}: ${(error as Error).message}`,
          );
        }
      } finally {
        await handle.close();
      }
    }
  }

  /**
   * Deletes the files whose whole coverage lies within `[from, to]` and that
   * were last written before `writtenBefore` (ms): heights a frozen band
   * holds, from files the band was built from. A file written or replaced
   * after the band was built was never read into it, so it stays. Returns
   * their names.
   */
  async prune(
    from: number,
    to: number,
    writtenBefore: number,
  ): Promise<string[]> {
    const pruned: string[] = [];
    for (const file of await this.files()) {
      if (file.from < from || file.to > to) continue;
      const filePath = path.join(this.dir, file.name);
      const stat = await fs.stat(filePath).catch(() => undefined);
      if (stat === undefined || stat.mtimeMs >= writtenBefore) continue;
      await fs.rm(filePath, { force: true });
      pruned.push(file.name);
    }
    return pruned;
  }

  /** Seconds since the newest overlay file was written, or undefined with none. */
  async ageSeconds(now = Date.now()): Promise<number | undefined> {
    let newest: number | undefined;
    for (const file of await this.files()) {
      const { mtimeMs } = await fs.stat(path.join(this.dir, file.name));
      if (newest === undefined || mtimeMs > newest) newest = mtimeMs;
    }
    return newest === undefined ? undefined : (now - newest) / 1000;
  }

  async close(): Promise<void> {
    // Nothing held between reads.
  }

  private async files(): Promise<OverlayFile[]> {
    try {
      return await listOverlayFiles(this.dir);
    } catch (error) {
      throw new Error(
        `Overlay ${this.name}: cannot list ${this.dir}: ${(error as Error).message}`,
      );
    }
  }
}

/**
 * Whether a CSV file starts with the header line `writeBandRecordsCsv`
 * writes, after any byte-order mark.
 */
async function hasHeader(handle: fs.FileHandle): Promise<boolean> {
  const { buffer, bytesRead } = await handle.read(Buffer.alloc(16), 0, 16, 0);
  return buffer
    .subarray(0, bytesRead)
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .startsWith('data_item_id');
}
