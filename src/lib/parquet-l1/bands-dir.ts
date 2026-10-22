/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Which bands of a `parquet-l1` directory are the index, for the verifier
 * and the importer alike: an explicit listing, never a glob.
 *
 * - A directory with a readable `band.json` is a band, read by its own
 *   files' paths.
 * - A directory without one is ignored and listed (`ignored`), never read:
 *   a retired copy (the index-swarm sidecar unlinks `band.json` first and
 *   sweeps the files later, and names its copies `<id>~<generation>`) or a
 *   stray directory. So is a non-directory. A directory named exactly as a
 *   band id without one is a problem: it is the band, unreadable.
 * - A `band.json` that is there and cannot be read or parsed is a problem,
 *   named: an unreadable band at the edge of a set must not quietly shrink
 *   it.
 * - Two installed generations of one band (`<id>~a`, `<id>~b`), as the
 *   sidecar holds while it replaces a copy: when their tables are the same
 *   (the same {@link bandTablesDigest}), the newest is read and the other
 *   listed in `duplicates`; when they differ, that is a problem.
 * - Every band's name must be its identity: an `l1-h<from>-<to>-<tag>-<12
 *   hex>` id in canonical decimals, whose heights are the heights in its
 *   `band.json`, and whose digest is the first 12 hex digits of its
 *   {@link bandTablesDigest}. A name that disagrees is an identity problem:
 *   the name is the importer's ledger key.
 *
 * The directory itself must be readable: a missing or unreadable directory
 * throws.
 */
import { type BandDirListing, readBandsDir } from '../index-band/read-dir.js';
import {
  BAND_FILE,
  bandTablesDigest,
  MAX_BAND_FILE_BYTES,
  type ParquetL1Band,
  parseBandFile,
  readPublisherFacts,
} from './layout.js';

/** A band of the directory, read whole. */
export interface L1BandOnDisk {
  id: string;
  dir: string;
  band: ParquetL1Band;
  /** The directory entry (the id, or `<id>~<generation>`). */
  entry: string;
}

/** The pattern of an L1 band id: heights, publisher tag, table digest. */
export const L1_BAND_ID =
  /^l1-h(\d{1,15})-(\d{1,15})-([0-9a-f]{8})-([0-9a-f]{12})$/;

/**
 * What is wrong with a band's name as its identity, or undefined when it
 * names the band it holds. `tag`, when known, is the publisher's.
 */
export function l1IdentityProblem(
  id: string,
  band: ParquetL1Band,
  tag?: string,
): string | undefined {
  const m = L1_BAND_ID.exec(id);
  if (m === null) return 'not an l1 band id';
  const [from, to] = band.heightRange;
  if (String(Number(m[1])) !== m[1] || String(Number(m[2])) !== m[2]) {
    return 'heights not in canonical decimals';
  }
  if (Number(m[1]) !== from || Number(m[2]) !== to) {
    return `names heights ${m[1]}-${m[2]}, its band.json holds ${from}-${to}`;
  }
  const digest = bandTablesDigest(band).toString('hex').slice(0, 12);
  if (m[4] !== digest) {
    return `names digest ${m[4]}, its tables digest to ${digest}`;
  }
  if (tag !== undefined && m[3] !== tag) {
    return `names publisher tag ${m[3]}, the publisher's is ${tag}`;
  }
  return undefined;
}

export interface L1BandsListing {
  bands: L1BandOnDisk[];
  /** Entries that are not readable bands, and bands whose name is not their identity. */
  problems: Array<{ entry: string; problem: string }>;
  ignored: BandDirListing<ParquetL1Band>['ignored'];
  vanished: string[];
  /** Other installed generations of a band read once, with identical tables. */
  duplicates: string[];
}

/** The bands of a `parquet-l1` directory, lowest first (see the module comment). */
export async function readL1Bands(bandsDir: string): Promise<L1BandsListing> {
  const listing = await readBandsDir(bandsDir, {
    bandFile: BAND_FILE,
    parse: parseBandFile,
    label: 'l1',
    missingBandFile: 'ignore',
    maxBandFileBytes: MAX_BAND_FILE_BYTES,
    readSupersedes: async (dir) => (await readPublisherFacts(dir))?.supersedes,
    // A directory named exactly as a band (no installed generation) is a
    // band: a retired copy carries its generation. Without its band.json
    // it is an unreadable band, not something to pass over, or a set
    // could shrink silently by losing one.
    bandFileRequired: (entry) => L1_BAND_ID.test(entry),
  });
  const problems = [...listing.problems];
  const duplicates: string[] = [];
  const byId = new Map<string, Array<(typeof listing.bands)[number]>>();
  for (const found of listing.bands) {
    byId.set(found.id, [...(byId.get(found.id) ?? []), found]);
  }
  const bands: L1BandOnDisk[] = [];
  for (const [id, copies] of byId) {
    // Newest first: the replacement rather than the copy about to retire.
    copies.sort((a, b) => b.changedAt - a.changedAt);
    const [kept, ...others] = copies;
    const digest = bandTablesDigest(kept.band).toString('hex');
    const differ = others.filter(
      (o) => bandTablesDigest(o.band).toString('hex') !== digest,
    );
    if (differ.length > 0) {
      problems.push({
        entry: copies.map((c) => c.entry).join(', '),
        problem: `${copies.length} copies of ${id} hold different tables`,
      });
      continue;
    }
    duplicates.push(...others.map((o) => o.entry));
    const identity = l1IdentityProblem(id, kept.band);
    if (identity !== undefined) {
      problems.push({ entry: kept.entry, problem: identity });
    }
    bands.push({ id, dir: kept.dir, band: kept.band, entry: kept.entry });
  }
  bands.sort(
    (a, b) =>
      a.band.heightRange[0] - b.band.heightRange[0] ||
      a.band.heightRange[1] - b.band.heightRange[1],
  );
  return {
    bands,
    problems,
    ignored: listing.ignored,
    vanished: listing.vanished,
    duplicates: duplicates.sort(),
  };
}
