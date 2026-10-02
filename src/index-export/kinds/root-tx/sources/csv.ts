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

/** A file as it was when a build read it, so pruning can tell it hasn't changed. */
interface ReadFile {
  from: number;
  to: number;
  ino: number;
  size: number;
  mtimeMs: number;
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
  readonly rank = 1;
  readonly stats: SourceStats = newSourceStats();
  private readonly read = new Map<string, ReadFile>();

  constructor(
    readonly name: string,
    readonly dir: string,
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
        const stat = await handle.stat();
        this.read.set(file.name, {
          from: file.from,
          to: file.to,
          ino: stat.ino,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
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
            yield { ...row, rank: 1, coverageTo: file.to, source: this.name };
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
   * Deletes the files a frozen band was built from: those this source read
   * whose whole coverage lies within `[from, to]`, the band's range, and
   * that haven't changed since (a replacement dropped in meanwhile was never
   * read, so it stays). Returns their names.
   */
  async prune(from: number, to: number): Promise<string[]> {
    const pruned: string[] = [];
    for (const [name, seen] of this.read) {
      if (seen.from < from || seen.to > to) continue;
      const filePath = path.join(this.dir, name);
      const now = await fs.stat(filePath).catch(() => undefined);
      if (
        now === undefined ||
        now.ino !== seen.ino ||
        now.size !== seen.size ||
        now.mtimeMs !== seen.mtimeMs
      ) {
        continue;
      }
      await fs.rm(filePath, { force: true });
      this.read.delete(name);
      pruned.push(name);
    }
    return pruned.sort();
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
