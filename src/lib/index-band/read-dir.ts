/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Reading a directory of bands, for the verifiers and the importer of any
 * band kind (`parquet-l1`, `parquet-l2`), with nothing passed over in
 * silence: every entry is a band read whole, or a named problem, or
 * ignored with its reason, or vanished.
 *
 * Entries starting with `.` are skipped (a publisher's own files). A band
 * reached through a symlink is a band (`stat` follows it). The directory
 * itself must be readable: a missing or unreadable directory throws, so a
 * caller can never mistake "could not look" for "nothing there".
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** A band directory read whole. */
export interface BandDirEntry<B> {
  /** The directory entry's name: the band id, or `<id>~<generation>` as installed. */
  entry: string;
  dir: string;
  /** The band id: the entry less an installed generation (`~…`). */
  id: string;
  band: B;
  /** The text of its band file, as read. */
  bandFileText: string;
  /** When the entry last changed (ctime, which a rename into place sets). */
  changedAt: number;
  /** The bands its publisher says it replaces (`.publisher.json`), if any. */
  supersedes?: string[];
}

/** An entry that is not a band that could be read. */
export interface BandDirProblem {
  entry: string;
  problem: string;
}

export interface BandDirListing<B> {
  bands: Array<BandDirEntry<B>>;
  problems: BandDirProblem[];
  /** Entries that disappeared while the directory was read. */
  vanished: string[];
  /** Entries passed over, never read, with why: only under `missingBandFile: 'ignore'`. */
  ignored: Array<{ entry: string; reason: string }>;
}

export const errorCode = (error: unknown): string | undefined =>
  (error as { code?: unknown })?.code as string | undefined;

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Whether a path is gone: ENOENT, and ENOENT again on a second look. */
export async function isGone(file: string): Promise<boolean> {
  const first = await fs.lstat(file).then(
    () => false,
    (error) => errorCode(error) === 'ENOENT',
  );
  if (!first) return false;
  return fs.lstat(file).then(
    () => false,
    (error) => errorCode(error) === 'ENOENT',
  );
}

/** Installed copies carry a generation after this (`<band id>~<generation>`). */
export const GENERATION_SEPARATOR = '~';

/**
 * Every entry of `bandsDir`, sorted by name: each directory whose band
 * file parses is a band; anything else is a problem, or — under
 * `missingBandFile: 'ignore'` — a directory without a band file (a retired
 * copy, whose band file the index-swarm sidecar unlinks first, or a stray
 * directory) and a non-directory are ignored and listed, never read.
 *
 * @throws when `bandsDir` itself cannot be read (missing, not a
 *   directory, no permission): the caller decides what that means.
 */
export async function readBandsDir<B>(
  bandsDir: string,
  {
    bandFile,
    parse,
    label,
    missingBandFile = 'problem',
    maxBandFileBytes,
    readSupersedes,
  }: {
    bandFile: string;
    parse: (text: string) => B;
    /** The layout, in "is not an <label> band file". */
    label: string;
    missingBandFile?: 'problem' | 'ignore';
    maxBandFileBytes?: number;
    /** The bands a band's publisher says it replaces (its `.publisher.json`). */
    readSupersedes?: (dir: string) => Promise<string[] | undefined>;
  },
): Promise<BandDirListing<B>> {
  const names = (await fs.readdir(bandsDir)).sort();
  const listing: BandDirListing<B> = {
    bands: [],
    problems: [],
    vanished: [],
    ignored: [],
  };
  for (const entry of names) {
    if (entry.startsWith('.')) continue;
    const dir = path.join(bandsDir, entry);
    const problem = (text: string) =>
      listing.problems.push({ entry, problem: text });
    let stat;
    try {
      stat = await fs.stat(dir);
    } catch (error) {
      if (await isGone(dir)) listing.vanished.push(entry);
      else problem(`unreadable: ${errorCode(error) ?? messageOf(error)}`);
      continue;
    }
    if (!stat.isDirectory()) {
      if (missingBandFile === 'ignore') {
        listing.ignored.push({ entry, reason: 'not a directory' });
      } else {
        problem('not a directory');
      }
      continue;
    }
    const file = path.join(dir, bandFile);
    let text: string;
    try {
      if (maxBandFileBytes !== undefined) {
        const { size } = await fs.stat(file);
        if (size > maxBandFileBytes) {
          problem(`${bandFile} is ${size} bytes, over ${maxBandFileBytes}`);
          continue;
        }
      }
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (await isGone(dir)) listing.vanished.push(entry);
      else if (errorCode(error) === 'ENOENT') {
        if (missingBandFile === 'ignore') {
          listing.ignored.push({
            entry,
            reason: `no ${bandFile}: a retired copy or not a band`,
          });
        } else {
          problem(`no ${bandFile}`);
        }
      } else {
        problem(
          `${bandFile} unreadable: ${errorCode(error) ?? messageOf(error)}`,
        );
      }
      continue;
    }
    let band: B;
    try {
      band = parse(text);
    } catch (error) {
      problem(`${bandFile} is not an ${label} band file: ${messageOf(error)}`);
      continue;
    }
    let supersedes: string[] | undefined;
    try {
      supersedes = await readSupersedes?.(dir);
    } catch (error) {
      // A claim that can't be read is no claim, and a fault of the band.
      problem(`.publisher.json unreadable: ${messageOf(error)}`);
    }
    listing.bands.push({
      entry,
      dir,
      id: entry.split(GENERATION_SEPARATOR)[0],
      band,
      bandFileText: text,
      changedAt: stat.ctimeMs,
      ...(supersedes !== undefined ? { supersedes } : {}),
    });
  }
  return listing;
}
