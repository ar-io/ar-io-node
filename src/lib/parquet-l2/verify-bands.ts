/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Checks a directory of `parquet-l2` bands, as any holder of them can: a
 * subscriber before trusting what it installed, a publisher before or after
 * publishing, an operator asked whether an index is sound. No gateway and no
 * database is needed; with `onchain`, the bands' locations are checked
 * against Arweave itself.
 *
 * A verifier fails closed: whatever it cannot check whole is a failure, or
 * is named in `skipped`, never passed by omission. Every SQL predicate is
 * NULL-safe (a NULL where a value is required is a failure, never a row the
 * filter drops); a band that can't be read to the end of its checks (a file
 * gone, an I/O or DuckDB error) fails, and the run goes on to the next.
 *
 * Checks, each reported on its own (see `docs/index-verification.md`):
 *
 * - `identity`: every band's id names its own heights (canonical decimals),
 *   its publisher's tag (exactly, given the publisher), and the digest of
 *   its heights, selection and rows. Internal consistency only: the id is
 *   a 48-bit digest prefix, a name rather than a security binding, and
 *   nothing here ties it to a publisher's signature unless `publication`
 *   is given.
 * - `publication` (with `publication`): the publication is signed by the
 *   publisher's key, and every band is listed in it with every file's size
 *   and SHA-256 as signed.
 * - `selection`: every band holds the same selection.
 * - `files`: each band holds exactly the files its layout requires; every
 *   entry of the directory is a readable band.
 * - `schema`: every Parquet file has exactly its layout's columns, in order,
 *   with its types, and a footer a reader can parse.
 * - `tables`: every table's rows, read in file order, are in the table's
 *   order and digest to what `band.json` says; every owner key hashes to its
 *   address.
 * - `required`: every value the layout requires is set.
 * - `locations`: an item's location is whole or absent, its header laid
 *   out as ANS-104 requires (signature right after the type, owner right
 *   after the signature, payload after the owner and inside the item), its
 *   `data_size` the payload the location gives, its ids 32 bytes, and its
 *   height inside the band.
 * - `parents`: an item directly in its root sits at offset 0 of it; an item
 *   in a nested bundle names one described in `parents`, whose payload
 *   starts where the item's location says.
 * - `consistency`: every tag row belongs to an item of the band at a height
 *   inside it; every item's `tag_count` is its number of tag rows; every
 *   key in `wallets` is an item owner's, and owners without one are no
 *   more than the band says (`checks.ownersWithoutKey`).
 * - `selected`: every item has a tag the band's selection takes.
 * - `lookups`: each lookup file, read in its own order, is in its key's
 *   order and holds exactly the rows its tables give.
 * - `mined` (with an L1 index): every root transaction is in the L1
 *   index's `block_transactions` at the height and index its items give.
 * - `onchain` (optional): a sample of items per band, their headers read
 *   from the root transactions at their recorded locations, must hash to
 *   their ids (`checkBandHeaders`, over whatever root source is given:
 *   `onChainRootSource` proves every byte against the chain).
 */
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SIG_CONFIG } from '@dha-team/arbundles';
import type { Database } from 'duckdb-async';

import { type BandSampleEntry, bandPublisherTag } from '../index-band/build.js';
import {
  checkDrawnHeaders,
  RootSourceFactory,
  type UncheckedReason,
} from '../index-band/verify.js';
import { publicKeyFromSolanaAddress } from '../httpsig.js';
import {
  type BandDescriptor,
  type IndexEntry,
  type IndexPublication,
  parseIndexPublicationDocument,
  supersededBands,
  verifyIndexPublication,
} from '../index-publication.js';
import { checkParquetFile } from '../parquet/check.js';
import {
  type BandOnDisk as L1BandOnDisk,
  PARQUET_L1_TABLES,
  readBandDirectory as readL1BandDirectory,
  readPublisherFacts,
} from '../parquet-l1/layout.js';
import { addFailure, type VerifyCheck } from '../parquet-l1/verify.js';
import {
  BAND_FILE,
  bandFiles,
  bandTablesDigest,
  idHeightRange,
  L2_BAND_ID_PATTERN,
  lookupsOf,
  PARQUET_L2_TABLES,
  type ParquetL2Band,
  parseBandFile,
  serializeSelection,
} from './layout.js';
import type { DuckRunner } from '../parquet/scan-digest.js';
import type { LookupSpec } from '../parquet/lookups.js';
import { bandTableFiles, verifyBandLookups } from './lookups.js';
import { selectionDuckDb } from './selection.js';
import { digestL2Table, L2TableError } from './tables.js';

/** Bands listed in `minedPartial`; the rest are counted. */
export const MAX_PARTIAL_LISTED = 50;

/** Moved roots listed in a result; the rest are counted in the failure. */
export const MAX_MOVED_REPORTED = 20;

/** A set of bands that can't be checked as one index. */
export class L2BandsRefused extends Error {}

export interface L2BandOnDisk {
  /** The band's directory. */
  dir: string;
  /** Its id: the directory name, less an installed generation (`~…`). */
  id: string;
  band: ParquetL2Band;
  /** The bands its publisher says it replaces (`.publisher.json`), if any. */
  supersedes?: string[];
}

/** A directory entry that is not a band that could be read. */
export interface L2DirProblem {
  entry: string;
  problem: string;
}

export interface L2OnChainOptions {
  /** Items per band to read (at most; fewer where a band holds fewer). */
  perBand: number;
  openRoot: RootSourceFactory;
  /**
   * Seeds the sample, and the order its pool is read in, so a run can be
   * repeated (given the same DuckDB thread count and read concurrency). A
   * random seed is drawn when not given; the result reports it.
   */
  seed?: number;
  concurrency?: number;
  /**
   * Drawn entries that may be left unchecked and the band still pass
   * (default 0). Past it, a band with none wrong is inconclusive.
   */
  maxUnchecked?: number;
  /**
   * Milliseconds one band's reads may take (default: no limit). Items not
   * read by then are unchecked.
   */
  deadlineMs?: number;
}

export interface L2PublicationOptions {
  /** The signed publication document, as served or as written. */
  document: string | Buffer;
  /**
   * The key that must have signed it: the publisher's registered observer
   * address (base58), given by the operator or read from the registry.
   */
  publisherKey: string;
  /** The index's name in it, when it lists more than one `parquet-l2` index. */
  index?: string;
  /** Accept a publication past its `expiresAt` (default: refused). */
  allowExpired?: boolean;
  /**
   * Where the key came from, when not from the operator: a registry the
   * run trusted for it, said in `assurance` and `publication.keyFrom`.
   */
  keyFrom?: string;
  /** Injected in tests: the time expiry is judged at. */
  now?: () => number;
}

export interface L2VerifyOptions {
  /** Check only bands inside these heights. */
  from?: number;
  to?: number;
  /** The publisher's wallet: ids are then checked whole, tag included. */
  publisher?: string;
  /** Check lookups (default true): the slowest check on large bands. */
  lookups?: boolean;
  onchain?: L2OnChainOptions;
  /** Bind the bands to a signed publication: every file's digest as signed. */
  publication?: L2PublicationOptions;
  /**
   * A directory of `parquet-l1` bands to find every root transaction in
   * (`mined`). `required`: a band it doesn't cover fails; otherwise such a
   * band is listed in `mined.uncovered`.
   */
  l1?: { bandsDir: string; required: boolean };
  /**
   * The largest share of a band's items that may be unlocated (default
   * 0.001: the most measured in a real `ardrive-l2` band is 0.00035).
   * Unlocated items can't be checked on chain.
   */
  maxUnlocatedShare?: number;
  /**
   * Pass a band whose items are all unlocated (nothing of it can be read
   * on chain), its unlocated items as declared. Default false.
   */
  allowUnlocated?: boolean;
  /** Called after each band, for progress. */
  progress?: (done: number, total: number, id: string) => void;
  /**
   * More DuckDB databases to read with, beside the one given, each set up
   * as that one is: bands are checked side by side, as many at a time as
   * there are databases, and a band's tables and lookups are read side by
   * side, each read on one database at a time. What is found is reported
   * as if every band were checked one after another, in order.
   */
  moreDucks?: Database[];
  /**
   * With `moreDucks`: the bytes all the databases may spill together. Each
   * read then reserves its share before it runs ({@link DuckPool}): a
   * lookup's derivation {@link SPILL_PER_DERIVED_BYTE} per byte of the
   * tables it reads, the SQL checks and the L1 lookup
   * {@link SPILL_PER_GROUPED_BYTE} per byte of `data_items` and `tags`, any
   * other read {@link LIGHT_READ_SPILL_BYTES}; one that runs out runs again
   * with all of it. Without it, every database spills as it is set up to.
   */
  spillBytes?: number;
}

/** One band's part of the on-chain check. */
export interface L2OnChainBand {
  id: string;
  /** Rows of `data_items` with a location, and their share of the rows. */
  located: number;
  locatedShare: number;
  /** Entries drawn; each is ok, wrong or unchecked. */
  drawn: number;
  /**
   * Of them, those drawn uniformly over every located item: the sample
   * the stated bound is about. The rest are nested items drawn on top.
   */
  drawnUniform: number;
  /** Of the drawn, those in nested bundles (uniform and topped up). */
  drawnNested: number;
  ok: number;
  /** Proven contrary, `missing` roots among them. */
  wrong: number;
  missing: number;
  unchecked: number;
  /** Why entries were unchecked, by reason. */
  uncheckedReasons: Partial<Record<UncheckedReason, number>>;
  /** A few of the unchecked entries' errors. */
  errorSample: string[];
  /** None wrong, but more unchecked than allowed. */
  inconclusive: boolean;
  passed: boolean;
  reasons: string[];
}

export interface L2OnChainSummary {
  drawn: number;
  ok: number;
  wrong: number;
  /** Items under a root no node has at all (two machines say so). */
  missing: number;
  /** Items that couldn't be checked, after a second try. */
  unchecked: number;
  /** Bands with an entry wrong, by id, with the reasons. */
  failedBands: Array<{ id: string; reasons: string[] }>;
  /** Bands with none wrong but more unchecked than allowed. */
  inconclusiveBands: string[];
  /** Bands with items but none located: nothing to read on chain. */
  unlocatedBands: string[];
  /** Per band. */
  bands: L2OnChainBand[];
  /** The sample's seed: `--seed` repeats it. */
  seed: number;
}

export interface L2BandsVerifyResult {
  bandsDir: string;
  selection: string;
  bands: number;
  heightRange: [number, number];
  /** Rows of `data_items` read across the bands checked. */
  items: number;
  /** Every check that ran passed. Read with `skipped`. */
  ok: boolean;
  checks: VerifyCheck[];
  /**
   * Checks that did not run, so `ok` says nothing of them: `lookups`,
   * `onchain`, `publication`, `mined`.
   */
  skipped: string[];
  /** Whether the bands were bound to a publisher's signature. */
  publisherBound: boolean;
  publication?: {
    publisher: string;
    keyId: string;
    /** Where the key came from: `operator`, or the registry trusted for it. */
    keyFrom: string;
    sequence: number;
    issuedAt: string;
    expiresAt: string;
    expired: boolean;
    index: string;
    bound: boolean;
    /** Bands it lists in the range checked that the directory lacks. */
    absent: string[];
  };
  /**
   * What the run bound the bands to, and what it did not, in sentences: read
   * with `ok` and `skipped`.
   */
  assurance: string[];
  /**
   * Bands an L1 index found for some bands left out of `mined` (at most
   * {@link MAX_PARTIAL_LISTED}, with the count of all); `skipped` still
   * lists `mined`.
   */
  minedPartial?: { bands: string[]; count: number };
  /** Per band: its unlocated items, what its band.json declares, the share. */
  located: Array<{
    id: string;
    items: number;
    unlocated: number;
    declared: number;
    share: number;
  }>;
  /** How roots were found in blocks, when they were. */
  mined?: {
    l1BandsDir: string;
    /** What the L1 index checks of each root: its block's height and its place in it. */
    checks: { height: true; position: true };
    /** Bands whose every root was found in the L1 index. */
    checked: number;
    /** Bands the L1 index doesn't cover. */
    uncovered: string[];
    /**
     * Roots the L1 index holds at another position in their block than the
     * L2 band gives (at most {@link MAX_MOVED_REPORTED}).
     */
    moved: Array<{
      band: string;
      root: string;
      height: number;
      l2Index: number;
      l1Index: number;
    }>;
  };
  /** Bands left out because a band of the same publisher replaces them. */
  superseded: string[];
  /** Bands only partly inside `from`/`to`: not checked. */
  partial: string[];
  /** Directory entries that disappeared while the run read them. */
  vanished: string[];
  onchain?: L2OnChainSummary;
  seconds: number;
}

/**
 * Signature and owner lengths per signature type (arbundles' table, as the
 * gateway decodes headers), for the `locations` check. A type it doesn't
 * know passes here; the header check is what reads such an item.
 */
function signatureLengthsSql(): string {
  const cases = Object.entries(SIG_CONFIG).map(
    ([type, meta]) =>
      `WHEN ${Number(type)} THEN signature_size = ${meta.sigLength} AND owner_size = ${meta.pubLength}`,
  );
  return `CASE signature_type ${cases.join(' ')} ELSE true END`;
}

const errorCode = (error: unknown): string | undefined =>
  (error as { code?: unknown })?.code as string | undefined;

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Whether a path is gone: ENOENT, and ENOENT again on a second look. */
async function isGone(file: string): Promise<boolean> {
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

/**
 * The bands in a directory: each entry holding a `band.json`, symlinks
 * followed. Installed bands' directories carry a generation
 * (`<id>~<generation>`). Entries starting with `.` are skipped. Any other
 * entry that is not a band that can be read whole is a problem, named; an
 * entry that disappeared while it was read is `vanished`.
 */
export async function readL2BandsDir(bandsDir: string): Promise<{
  bands: L2BandOnDisk[];
  problems: L2DirProblem[];
  vanished: string[];
}> {
  const names = (await fs.readdir(bandsDir)).sort();
  const bands: L2BandOnDisk[] = [];
  const problems: L2DirProblem[] = [];
  const vanished: string[] = [];
  for (const entry of names) {
    if (entry.startsWith('.')) continue;
    const dir = path.join(bandsDir, entry);
    const problem = (text: string) => problems.push({ entry, problem: text });
    // stat follows a symlink: a band reached through one is a band.
    let stat;
    try {
      stat = await fs.stat(dir);
    } catch (error) {
      if (await isGone(dir)) vanished.push(entry);
      else problem(`unreadable: ${errorCode(error) ?? messageOf(error)}`);
      continue;
    }
    if (!stat.isDirectory()) {
      problem('not a directory');
      continue;
    }
    let text: string;
    try {
      text = await fs.readFile(path.join(dir, BAND_FILE), 'utf8');
    } catch (error) {
      if (await isGone(dir)) vanished.push(entry);
      else if (errorCode(error) === 'ENOENT') problem(`no ${BAND_FILE}`);
      else
        problem(
          `${BAND_FILE} unreadable: ${errorCode(error) ?? messageOf(error)}`,
        );
      continue;
    }
    let band: ParquetL2Band;
    try {
      band = parseBandFile(text);
    } catch (error) {
      problem(`${BAND_FILE} is not an l2 band file: ${messageOf(error)}`);
      continue;
    }
    let supersedes: string[] | undefined;
    try {
      supersedes = (await readPublisherFacts(dir))?.supersedes;
    } catch (error) {
      // A claim that can't be read is no claim, and a fault of the band.
      problem(`.publisher.json unreadable: ${messageOf(error)}`);
    }
    bands.push({
      dir,
      id: entry.split('~')[0],
      band,
      ...(supersedes !== undefined ? { supersedes } : {}),
    });
  }
  return { bands, problems, vanished };
}

/** A band id's publisher tag, or undefined when it is not an l2 band id. */
const tagOf = (id: string) => L2_BAND_ID_PATTERN.exec(id)?.[3];

/**
 * The bands no other band replaces, by the rule a subscriber applies to a
 * publication (`supersededBands`), with each claim held to its own
 * publisher's bands and to the heights its claimant covers: a band can
 * replace only a band of its publisher whose heights it covers whole. A
 * publisher's published directory keeps a replaced tip band beside its
 * replacement until it is pruned; an installed set holds only live bands,
 * so nothing is left out of it.
 */
export function liveL2Bands(bands: ReadonlyArray<L2BandOnDisk>): {
  live: L2BandOnDisk[];
  superseded: string[];
} {
  const byId = new Map(bands.map((b) => [b.id, b]));
  const gone = supersededBands(
    bands.map((b) => ({
      id: b.id,
      files: [],
      ...(b.supersedes !== undefined
        ? {
            metadata: {
              supersedes: b.supersedes.filter((other) => {
                const target = byId.get(other);
                const tag = tagOf(b.id);
                return (
                  target !== undefined &&
                  tag !== undefined &&
                  tagOf(other) === tag &&
                  b.band.heightRange[0] <= target.band.heightRange[0] &&
                  b.band.heightRange[1] >= target.band.heightRange[1]
                );
              }),
            },
          }
        : {}),
    })),
  );
  return {
    live: bands.filter((b) => !gone.has(b.id)),
    superseded: bands
      .filter((b) => gone.has(b.id))
      .map((b) => b.id)
      .sort(),
  };
}

/**
 * The bands ordered by height, refused if any overlap or leave a hole: a
 * set like that is not one index's.
 */
export function l2Coverage(bands: ReadonlyArray<L2BandOnDisk>): {
  ordered: L2BandOnDisk[];
  span: [number, number];
} {
  if (bands.length === 0) {
    throw new L2BandsRefused('no l2 band in this directory');
  }
  const ordered = [...bands].sort(
    (a, b) =>
      a.band.heightRange[0] - b.band.heightRange[0] ||
      a.band.heightRange[1] - b.band.heightRange[1],
  );
  for (let i = 1; i < ordered.length; i += 1) {
    const [, previousTo] = ordered[i - 1].band.heightRange;
    const [nextFrom] = ordered[i].band.heightRange;
    if (nextFrom === previousTo + 1) continue;
    throw new L2BandsRefused(
      nextFrom <= previousTo
        ? `bands ${ordered[i - 1].id} and ${ordered[i].id} overlap at height ${nextFrom}`
        : `nothing covers height ${previousTo + 1}: ${ordered[i - 1].id} ends there and ${ordered[i].id} starts at ${nextFrom}`,
    );
  }
  return {
    ordered,
    span: [
      ordered[0].band.heightRange[0],
      ordered[ordered.length - 1].band.heightRange[1],
    ],
  };
}

/**
 * Draws `size` located rows of a band's `data_items` (`itemsFile`, a
 * `read_parquet(...)` expression), repeatably from `key` (a band's
 * {@link drawSeed}): the rows whose `sha256("<key>:<row number>")` (lowercase
 * hex, the row number in decimal, its position in the file from 0) is
 * smallest, ties by row number, with each row's position.
 *
 * The order must be a keyed cryptographic hash. With DuckDB's
 * `hash(row, seed)`, which is `g(row) XOR k(seed)`, rows were picked by
 * their XOR distance from one random value to a public function of the
 * row: a publisher that fabricated the rows whose `g` starts with three
 * zero bits (12.5%) was caught in about 11% of runs, not the 93% the bound
 * claims. (DuckDB's `USING SAMPLE reservoir(n) REPEATABLE`, before that,
 * drew only from about the first 82,000 rows of a band.) Under SHA-256 of a
 * key the publisher can't know, every located row is equally likely and
 * the draws are independent of anything about the rows.
 */
export async function drawLocated(
  duck: Database,
  itemsFile: string,
  { where, size, seed }: { where: string; size: number; seed: string },
): Promise<Array<Record<string, unknown>>> {
  if (size <= 0) return [];
  if (!/^[0-9a-f]{64}$/.test(seed)) {
    throw new Error(
      `a draw's key must be 64 lowercase hex digits, not ${seed}`,
    );
  }
  return (await duck.all(`SELECT id, height, root_transaction_id, root_parent_offset, "offset", data_offset, file_row_number
      FROM ${itemsFile.replace(/\)$/, ', file_row_number = true)')}
      WHERE "offset" IS NOT NULL${where}
      ORDER BY sha256(concat('${seed}', ':', file_row_number::VARCHAR)), file_row_number
      LIMIT ${size}`)) as Array<Record<string, unknown>>;
}

/**
 * What a pass of `perBand` uniformly drawn items means, in plain words. Up
 * to `maxUnchecked` of them may be left unchecked and the band still pass:
 * those are treated as the attacker's, so the bound is for the rest.
 */
export function onchainAssurance(
  perBand: number,
  maxUnchecked: number,
  /** The fewest located items drawn uniformly in any band (min(N, located)). */
  fewestDrawn: number = perBand,
): string {
  const n = Math.min(perBand, fewestDrawn);
  if (n - maxUnchecked <= 0) {
    return `on chain, ${perBand} located items drawn per band (as few as ${fewestDrawn} in a band) with up to ${maxUnchecked} allowed unchecked: nothing can be said of how many items are fabricated`;
  }
  const p = Math.ceil(detectableFraction(n, 0.95, maxUnchecked) * 100);
  return `on chain, ${perBand} located items drawn uniformly per band${fewestDrawn < perBand ? ` (${fewestDrawn} in the band with fewest)` : ''}, none replaced${maxUnchecked > 0 ? `, up to ${maxUnchecked} allowed unchecked, which are treated as possibly fabricated (a fabricated item behind data nobody can read comes back unchecked)` : ''}: a band in which ${p}% or more of the located items are fabricated would have been caught with 95% probability; smaller fractions may not be (unlocated items are not checked on chain at all)`;
}

/**
 * The key of one band's draw (a stratum of it: 0 for the uniform draw, 1 for
 * the nested top-up): sha256(`<run seed>|<band id>|<stratum>`) as 64
 * lowercase hex digits, so every band's draw is its own and no band's can be
 * steered by choosing its place or its neighbours.
 */
export function drawSeed(
  seed: number,
  bandId: string,
  stratum: number,
): string {
  return crypto
    .createHash('sha256')
    .update(`${seed}|${bandId}|${stratum}`)
    .digest('hex');
}

/**
 * The smallest share p of fabricated located items at which a band of `n`
 * drawn entries, up to `k` of them allowed unchecked, passes at most
 * `1 - confidence` of the time. A fabricated item behind data nobody can
 * read comes back unchecked, not wrong, so the band passes when at most k
 * drawn items are fabricated: P(Bin(n, p) <= k) = sum over i <= k of
 * C(n, i) p^i (1 - p)^(n - i). For k = 0 that is (1 - p)^n, so
 * p = 1 - (1 - confidence)^(1/n): 20 drawn, 14%. Otherwise found by
 * bisection (the probability falls as p rises). 1 when nothing is bounded
 * (k >= n).
 */
export function detectableFraction(
  n: number,
  confidence = 0.95,
  k = 0,
): number {
  if (n <= 0 || k >= n) return 1;
  if (k <= 0) return 1 - (1 - confidence) ** (1 / n);
  const passes = (p: number) => {
    let term = (1 - p) ** n; // i = 0
    let sum = term;
    for (let i = 1; i <= k; i += 1) {
      term *= ((n - i + 1) / i) * (p / (1 - p));
      sum += term;
    }
    return sum;
  };
  let lo = 0;
  let hi = 1;
  for (let step = 0; step < 60; step += 1) {
    const mid = (lo + hi) / 2;
    if (passes(mid) <= 1 - confidence) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** A seeded PRNG (mulberry32) giving numbers in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** SHA-256 of a file, streamed. */
async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * The publication's entry for this index, its signature checked against
 * the key given: the key the publisher's gateway record names.
 *
 * @throws L2BandsRefused when the document doesn't verify, or names no
 *   single `parquet-l2` index to bind to.
 */
function boundPublication(
  options: L2PublicationOptions,
  bandIds: string[],
  publisher: string | undefined,
): { publication: IndexPublication; entry: IndexEntry } {
  let parsed;
  try {
    parsed = parseIndexPublicationDocument(options.document);
  } catch (error) {
    throw new L2BandsRefused(`the publication is not one: ${messageOf(error)}`);
  }
  const { publication, signed } = parsed;
  const signature = publication.signature;
  if (signature === undefined) {
    throw new L2BandsRefused('the publication is not signed');
  }
  if (signature.keyId !== options.publisherKey) {
    throw new L2BandsRefused(
      `the publication is signed by ${signature.keyId}, not the publisher's key ${options.publisherKey}`,
    );
  }
  let key;
  try {
    key = publicKeyFromSolanaAddress(options.publisherKey);
  } catch (error) {
    throw new L2BandsRefused(
      `the publisher key is not an address: ${messageOf(error)}`,
    );
  }
  const verified = verifyIndexPublication(signed, key);
  if (!verified.ok) {
    throw new L2BandsRefused(
      `the publication's signature does not verify: ${verified.reason}`,
    );
  }
  const now = (options.now ?? Date.now)();
  if (
    Date.parse(publication.expiresAt) < now &&
    options.allowExpired !== true
  ) {
    throw new L2BandsRefused(
      `the publication expired at ${publication.expiresAt} (sequence ${publication.sequence}, issued ${publication.issuedAt}): fetch a current one, or --allow-expired`,
    );
  }
  if (publisher !== undefined && publication.publisher !== publisher) {
    throw new L2BandsRefused(
      `the publication is ${publication.publisher}'s, not ${publisher}'s`,
    );
  }
  const candidates = publication.indexes.filter(
    (entry) =>
      entry.kind === 'parquet-l2' &&
      (options.index === undefined || entry.name === options.index),
  );
  const holding = candidates.filter((entry) =>
    entry.bands.some((band) => bandIds.includes(band.id)),
  );
  const entry =
    candidates.length === 1
      ? candidates[0]
      : holding.length === 1
        ? holding[0]
        : undefined;
  if (entry === undefined) {
    throw new L2BandsRefused(
      candidates.length === 0
        ? `the publication lists no parquet-l2 index${options.index !== undefined ? ` named ${options.index}` : ''}`
        : 'the publication lists more than one parquet-l2 index holding these bands: name one (--index)',
    );
  }
  return { publication, entry };
}

/** Something a band's check found, applied to the result in band order. */
type Effect = () => void;

/**
 * Spill a lookup's derived rows are expected to need, per byte of the
 * tables they are derived from, when databases share a spill budget:
 * `ardrive-l2`'s h1.8M band derived its tag lookup from 3.7 GB of `tags`
 * in 64.1 GB of spill (17 per byte), its wallet lookup from 3.3 GB of
 * `data_items` in 10.8 GB.
 */
export const SPILL_PER_DERIVED_BYTE = 20;

/**
 * Spill the SQL checks that group a band's `data_items` and `tags` (and
 * the L1 lookup, `data_items`) are expected to need per byte of them: the
 * h1.8M band's consistency check grouped 7 GB in 9.9 GB of spill.
 */
export const SPILL_PER_GROUPED_BYTE = 3;

/**
 * Spill a read that neither sorts nor groups a whole table is let use (a
 * range of rows, a footer), when databases share a spill budget.
 */
export const LIGHT_READ_SPILL_BYTES = 2 ** 30;

/**
 * DuckDB databases that reads take turns on, first come first served: one
 * read on a database at a time (the Node binding runs one query at a time
 * on a database anyway).
 *
 * Given a spill budget, each read reserves a share of it before it starts,
 * and its database is capped at that share (`max_temp_directory_size`)
 * while it runs, so the databases together never spill more than the
 * budget: a read that needs more than is free waits until enough is, and
 * reads behind it go ahead only in what is left beside its share. A read
 * wanting more than the whole budget gets the whole budget, alone.
 */
export class DuckPool {
  private readonly idle: Database[];
  private readonly queue: Array<{
    spill: number;
    start: (duck: Database, spill: number) => void;
  }> = [];
  private reserved = 0;

  constructor(
    ducks: Database[],
    private readonly budget?: number,
  ) {
    this.idle = [...ducks];
    this.size = ducks.length;
  }

  readonly size: number;

  /** Reads asked for and not yet started. */
  get waiting(): number {
    return this.queue.length;
  }

  /**
   * A runner whose reads each reserve `spill` bytes of the budget. A read
   * that runs out of its share runs again, from the start, with the whole
   * budget: what a lone database would have had. Its task must start
   * afresh each time it is run.
   */
  runner = (spill: number): DuckRunner => {
    const once = this.once(spill);
    const whole = this.once(this.budget ?? 0);
    return async <T>(task: (duck: Database) => Promise<T>): Promise<T> => {
      try {
        return await once(task);
      } catch (error) {
        if (
          this.budget === undefined ||
          spill >= this.budget ||
          !/max_temp_directory_size/.test(messageOf(error))
        ) {
          throw error;
        }
        return whole(task);
      }
    };
  };

  private once = (spill: number): DuckRunner => {
    return async <T>(task: (duck: Database) => Promise<T>): Promise<T> => {
      const [duck, share] = await new Promise<[Database, number]>((resolve) => {
        this.queue.push({ spill, start: (d, s) => resolve([d, s]) });
        this.pump();
      });
      try {
        if (this.budget !== undefined) {
          await duck.exec(
            `SET max_temp_directory_size = '${Math.max(1, Math.floor(share / 2 ** 20))}MiB'`,
          );
        }
        return await task(duck);
      } finally {
        this.reserved -= share;
        this.idle.push(duck);
        this.pump();
      }
    };
  };

  /** Runs a read that neither sorts nor groups a whole table. */
  run: DuckRunner = this.runner(LIGHT_READ_SPILL_BYTES);

  private pump(): void {
    // In the order asked, each read whose share is free. One whose share
    // isn't waits, its share kept for it: a read behind it goes first only
    // in what is left beside that, so the one waiting is never starved.
    let kept = 0;
    for (let i = 0; i < this.queue.length && this.idle.length > 0; ) {
      const read = this.queue[i];
      const share =
        this.budget === undefined ? 0 : Math.min(read.spill, this.budget);
      if (
        this.budget !== undefined &&
        this.reserved + kept + share > this.budget
      ) {
        kept += share;
        i += 1;
        continue;
      }
      this.queue.splice(i, 1);
      this.reserved += share;
      read.start(this.idle.pop()!, share);
    }
  }
}

const sqlString = (value: string) => `'${value.replace(/'/g, "''")}'`;
const num = (v: unknown) => Number(v ?? 0);

/** NULL-safe: true only where the predicate is true. */
const holds = (predicate: string) => `coalesce((${predicate}), false)`;
/** Rows where a predicate does not hold, a NULL counted as not holding. */
const countNot = (predicate: string) =>
  `count(*) FILTER (WHERE NOT ${holds(predicate)})`;

/**
 * The L1 bands that together cover `[from, to]` (each step the band reaching
 * furthest), or undefined when a height is left uncovered.
 */
function coveringL1(
  bands: ReadonlyArray<L1BandOnDisk>,
  from: number,
  to: number,
): L1BandOnDisk[] | undefined {
  const covering: L1BandOnDisk[] = [];
  let next = from;
  while (next <= to) {
    const band = bands
      .filter(
        (b) => b.band.heightRange[0] <= next && b.band.heightRange[1] >= next,
      )
      .sort((a, b) => b.band.heightRange[1] - a.band.heightRange[1])[0];
    if (band === undefined) return undefined;
    covering.push(band);
    next = band.band.heightRange[1] + 1;
  }
  return covering;
}

/**
 * Checks a directory of `parquet-l2` bands.
 *
 * @throws L2BandsRefused when the directory is not one index's bands, or a
 *   publication given doesn't verify.
 */
export async function verifyL2Bands(
  duck: Database,
  bandsDir: string,
  options: L2VerifyOptions = {},
): Promise<L2BandsVerifyResult> {
  const began = Date.now();
  const allowUnlocated = options.allowUnlocated === true;
  const maxUnlocatedShare = options.maxUnlocatedShare ?? 0.001;
  // Reading every row in file order relies on DuckDB keeping it.
  await duck.exec('SET preserve_insertion_order = true');
  for (const more of options.moreDucks ?? []) {
    await more.exec('SET preserve_insertion_order = true');
  }
  const pool = new DuckPool(
    [duck, ...(options.moreDucks ?? [])],
    options.spillBytes,
  );
  const found = await readL2BandsDir(bandsDir);
  const { live: all, superseded } = liveL2Bands(found.bands);
  const inside = (from: number, to: number) =>
    (options.from === undefined || from >= options.from) &&
    (options.to === undefined || to <= options.to);
  const overlaps = (from: number, to: number) =>
    (options.from === undefined || to >= options.from) &&
    (options.to === undefined || from <= options.to);
  const inRange = all.filter(({ band }) => inside(...band.heightRange));
  const partial = all
    .filter(
      ({ band }) =>
        !inside(...band.heightRange) && overlaps(...band.heightRange),
    )
    .map((b) => b.id)
    .sort();
  let coverage;
  try {
    coverage = l2Coverage(inRange);
  } catch (error) {
    if (error instanceof L2BandsRefused && found.problems.length > 0) {
      throw new L2BandsRefused(
        `${error.message} (unreadable entries: ${found.problems.map((p) => `${p.entry}: ${p.problem}`).join('; ')})`,
      );
    }
    throw error;
  }
  const { ordered, span } = coverage;

  const check = (name: string, detail: string): VerifyCheck => ({
    name,
    ok: true,
    detail,
  });
  const identity = check(
    'identity',
    "each band's id names its heights, its publisher's tag and the digest of its heights, selection and rows: internal consistency, not a signature",
  );
  const publicationCheck = check(
    'publication',
    'every band is listed in the publication its publisher signed, every file with the size and SHA-256 signed',
  );
  const selectionCheck = check(
    'selection',
    'every band holds the same selection',
  );
  const files = check(
    'files',
    'every entry is a readable band, holding exactly the files its layout requires',
  );
  const schema = check(
    'schema',
    "every Parquet file has exactly its layout's columns, in order, with its types, and a footer a reader can parse",
  );
  const tables = check(
    'tables',
    "each table's rows are in order, digest to what band.json says, and every owner key hashes to its address",
  );
  const required = check('required', 'every value the layout requires is set');
  const locations = check(
    'locations',
    'every location is whole or absent, laid out as ANS-104 requires, with data_size its payload, 32-byte ids and the height inside its band',
  );
  const parents = check(
    'parents',
    'items directly in a root sit at offset 0; items in a nested bundle name one described in parents, whose payload starts where the item says',
  );
  const consistency = check(
    'consistency',
    "every tag row is an item's of the band; every tag_count counts its tags; every key is an owner's, and owners without one are no more than the band says",
  );
  const selected = check(
    'selected',
    "every item has a tag the band's selection takes",
  );
  const lookups = check(
    'lookups',
    'each lookup file is in its order and holds exactly the rows its tables give',
  );
  const mined = check(
    'mined',
    "every root transaction is in the L1 index's block_transactions at the height and index its items give",
  );
  const onchainCheck = check(
    'onchain',
    'a sample of items per band, read at their recorded locations from their root transactions, hash to their ids',
  );
  const complete = check(
    'complete',
    "every band's checks ran to their end, without a file vanishing or an I/O or DuckDB error",
  );

  const coverage_ = check(
    'coverage',
    'every height asked for (--from/--to) lies in a band that is checked',
  );
  const located_ = check(
    'located',
    "every band's unlocated items are the ones its band.json declares, and no more than the share allowed",
  );
  // Heights asked for that no checked band covers: bands only partly
  // inside the range are not checked, so their heights are not either.
  const [spanFrom, spanTo] = span;
  if (options.from !== undefined && options.from < spanFrom) {
    addFailure(coverage_, {
      height: options.from,
      found: `heights ${options.from}-${spanFrom - 1} in no band checked`,
      expected: 'a band over every height asked for',
    });
  }
  if (options.to !== undefined && options.to > spanTo) {
    addFailure(coverage_, {
      height: spanTo + 1,
      found: `heights ${spanTo + 1}-${options.to} in no band checked`,
      expected: 'a band over every height asked for',
    });
  }

  // Entries that are not readable bands, and ones that vanished in range.
  for (const { entry, problem } of found.problems) {
    addFailure(files, {
      height: span[0],
      found: `${entry}: ${problem}`,
      expected: 'a band directory that reads whole',
    });
  }
  const vanished = [...found.vanished];
  for (const entry of found.vanished) {
    const m = L2_BAND_ID_PATTERN.exec(entry.split('~')[0]);
    // Only a vanished entry known to lie wholly outside the range is let go.
    if (m !== null && !overlaps(Number(m[1]), Number(m[2]))) continue;
    addFailure(complete, {
      height: span[0],
      found: `${entry}: vanished while the directory was read`,
      expected: 'every band there to the end of the run',
    });
  }

  const selection = serializeSelection(ordered[0].band.selection);

  // The publication, verified before any band is read.
  let bound: ReturnType<typeof boundPublication> | undefined;
  let listed: Map<string, BandDescriptor> | undefined;
  if (options.publication !== undefined) {
    bound = boundPublication(
      options.publication,
      ordered.map((b) => b.id),
      options.publisher,
    );
    listed = new Map(bound.entry.bands.map((b) => [b.id, b]));
  }
  // Bands the publication lists in the range checked that are not here: a
  // set missing a band is not the publication's index.
  const absent: string[] = [];
  if (bound !== undefined) {
    const here = new Set(found.bands.map((b) => b.id));
    for (const band of bound.entry.bands) {
      if (here.has(band.id)) continue;
      const heights = idHeightRange(band.id);
      const [lo, hi] =
        heights ??
        (band.heightRange !== undefined
          ? [
              band.heightRange[0],
              band.heightRange[1] ?? Number.MAX_SAFE_INTEGER,
            ]
          : [0, Number.MAX_SAFE_INTEGER]);
      if (!overlaps(lo, hi)) continue;
      absent.push(band.id);
      addFailure(publicationCheck, {
        height: lo,
        found: `${band.id}: listed in the publication, not in ${bandsDir}`,
        expected: 'every band it lists in the range checked',
      });
    }
  }
  const publisher = options.publisher ?? bound?.publication.publisher;
  const tag = publisher !== undefined ? bandPublisherTag(publisher) : undefined;

  // The L1 index, when there is one to find roots in.
  let l1Bands: L1BandOnDisk[] | undefined;
  const minedSummary =
    options.l1 !== undefined
      ? {
          l1BandsDir: options.l1.bandsDir,
          checks: { height: true as const, position: true as const },
          checked: 0,
          uncovered: [] as string[],
          moved: [] as Array<{
            band: string;
            root: string;
            height: number;
            l2Index: number;
            l1Index: number;
          }>,
        }
      : undefined;
  if (options.l1 !== undefined) {
    l1Bands = await readL1BandDirectory(options.l1.bandsDir);
  }

  const onchainSummary: L2OnChainSummary = {
    drawn: 0,
    ok: 0,
    wrong: 0,
    missing: 0,
    unchecked: 0,
    failedBands: [],
    inconclusiveBands: [],
    unlocatedBands: [],
    bands: [],
    seed: options.onchain?.seed ?? crypto.randomInt(2 ** 31 - 1),
  };
  let items = 0;
  const locatedReport: L2BandsVerifyResult['located'] = [];
  const sigLengths = signatureLengthsSql();
  const selectedSql = selectionDuckDb(ordered[0].band.selection);

  /**
   * Every check of one band; throws only on what it could not read. What it
   * finds goes into `log`, applied once every band is checked, in band
   * order, so bands checked side by side report as one after another. Its
   * on-chain reads wait for `turn`, the band before it to finish its own.
   */
  const checkBand = async (
    { dir, id, band }: L2BandOnDisk,
    log: Effect[],
    turn: Promise<void>,
  ) => {
    const [from, to] = band.heightRange;
    const failTo =
      (into: Effect[]) => (c: VerifyCheck, found: string, expected: string) => {
        into.push(() =>
          addFailure(c, { height: from, found: `${id}: ${found}`, expected }),
        );
      };
    const fail = failTo(log);
    const reportTo =
      (failInto: ReturnType<typeof failTo>) =>
      (
        c: VerifyCheck,
        row: Record<string, unknown>,
        what: ReadonlyArray<readonly [string, string]>,
      ) => {
        for (const [key, text] of what) {
          if (num(row[key]) > 0) failInto(c, `${num(row[key])} ${text}`, '0');
        }
      };
    // Reads started ahead of the check that reports them, so they run side
    // by side; each settles before the band is done.
    const launched: Array<Promise<unknown>> = [];
    const launch = <T>(read: Promise<T>): Promise<T> => {
      launched.push(read.catch(() => undefined));
      return read;
    };
    try {
      // identity
      const m = L2_BAND_ID_PATTERN.exec(id);
      const digest = bandTablesDigest(band).toString('hex').slice(0, 12);
      if (m === null) {
        fail(
          identity,
          'not an l2 band id',
          'l2-h<from>-<to>-<tag>-<digest>, heights in canonical decimals',
        );
      } else {
        if (Number(m[1]) !== from || Number(m[2]) !== to) {
          fail(
            identity,
            `id heights ${m[1]}-${m[2]}`,
            `band.json heights ${from}-${to}`,
          );
        }
        if (m[4] !== digest) {
          fail(
            identity,
            `id digest ${m[4]}`,
            `the digest of its contents, ${digest}`,
          );
        }
        if (tag !== undefined && m[3] !== tag) {
          fail(identity, `publisher tag ${m[3]}`, `the publisher's tag ${tag}`);
        }
      }

      // selection
      if (serializeSelection(band.selection) !== selection) {
        fail(selectionCheck, serializeSelection(band.selection), selection);
      }

      // files: exactly the layout's, dot-files (a publisher's own) aside
      const present = (await fs.readdir(dir))
        .filter((n) => !n.startsWith('.'))
        .sort();
      const wanted = bandFiles(band.schema);

      // publication: every file as signed
      if (listed !== undefined) {
        const descriptor = listed.get(id);
        if (descriptor === undefined) {
          fail(
            publicationCheck,
            'not listed in the publication',
            'every band listed',
          );
        } else {
          const signedNames = descriptor.files.map((f) => f.name).sort();
          if (signedNames.join(',') !== present.join(',')) {
            fail(
              publicationCheck,
              `holds ${present.join(', ')}`,
              `the files signed: ${signedNames.join(', ')}`,
            );
          }
          for (const file of descriptor.files) {
            if (!present.includes(file.name)) continue;
            const at = path.join(dir, file.name);
            const { size } = await fs.stat(at);
            const sha256 = size === file.size ? await sha256File(at) : '';
            if (size !== file.size || sha256 !== file.sha256) {
              fail(
                publicationCheck,
                `${file.name}: ${size} bytes${sha256 !== '' ? `, SHA-256 ${sha256}` : ''}`,
                `${file.size} bytes, SHA-256 ${file.sha256}, as signed`,
              );
            }
          }
        }
      }

      if (present.join(',') !== wanted.join(',')) {
        fail(files, present.join(', '), wanted.join(', '));
        return; // the rest would only fail on the missing files
      }

      // schema: before any row is read by name
      let schemaOk = true;
      // Row counts are the tables' and lookups' checks, which read the rows.
      await pool.run(async (duck) => {
        for (const spec of [...PARQUET_L2_TABLES, ...lookupsOf(band)]) {
          try {
            await checkParquetFile(duck, path.join(dir, spec.file), {
              columns: spec.columns,
            });
          } catch (error) {
            if (await isGone(path.join(dir, spec.file))) throw error;
            schemaOk = false;
            fail(schema, messageOf(error).replace(`${dir}/`, ''), 'the layout');
          }
        }
      });
      if (!schemaOk) return; // rows of the wrong shape would only mislead

      // Reads that sort or group the band's tables reserve what they are
      // expected to spill, by the tables they read, when the databases
      // share a budget (a read that runs out runs again with all of it). A
      // file that can't be sized counts as empty: reading it fails as it
      // would.
      const sizes = new Map<string, number>();
      if (options.spillBytes !== undefined) {
        for (const spec of PARQUET_L2_TABLES) {
          const at = path.join(dir, spec.file);
          sizes.set(
            at,
            await fs.stat(at).then(
              (stat) => stat.size,
              () => 0,
            ),
          );
        }
      }
      const tableBytes = (...names: string[]) =>
        names.reduce(
          (sum, name) => sum + (sizes.get(path.join(dir, name)) ?? 0),
          0,
        );
      const sortingTables = pool.runner(
        SPILL_PER_GROUPED_BYTE *
          tableBytes('data_items.parquet', 'tags.parquet'),
      );
      const sortingMined = pool.runner(
        SPILL_PER_GROUPED_BYTE * tableBytes('data_items.parquet'),
      );
      // A lookup's rows are derived from the tables its SQL names.
      const sortingLookup = (spec: LookupSpec) => {
        const sql = spec.derive(bandTableFiles(dir));
        return pool.runner(
          SPILL_PER_DERIVED_BYTE *
            [...sizes].reduce(
              (sum, [at, bytes]) => sum + (sql.includes(at) ? bytes : 0),
              0,
            ),
        );
      };

      // From here the reads of the tables, the SQL checks, the lookups and
      // the L1 index run side by side, each reporting into its own log; the
      // logs are taken in this order, up to the first that could not be
      // read, as when they ran one after another.
      // A section that stops keeps what it found before it stopped, as the
      // checks did one after another: its log is taken, then its error.
      const section = (body: (into: Effect[]) => Promise<void>) => {
        const into: Effect[] = [];
        return launch(
          body(into).then(
            () => ({ into, failed: false, error: undefined as unknown }),
            (error: unknown) => ({ into, failed: true, error }),
          ),
        );
      };
      // A section read through a runner that may run it again (more
      // spill): each run logs afresh, and what the last run found before
      // it stopped is kept.
      const rerunnable = async (
        outer: Effect[],
        runner: DuckRunner,
        body: (duck: Database, into: Effect[]) => Promise<void>,
      ) => {
        let last: Effect[] = [];
        try {
          await runner(async (duck) => {
            last = [];
            await body(duck, last);
          });
        } finally {
          outer.push(...last);
        }
      };

      // tables
      const tableReads = PARQUET_L2_TABLES.map((spec) =>
        launch(
          // Read through the pool (`duck` is not used): a table's ranges
          // are read side by side.
          digestL2Table(duck, dir, spec, { inFileOrder: true, run: pool.run }),
        ),
      );
      const tablesSection = section(async (into) => {
        const fail = failTo(into);
        for (const [index, spec] of PARQUET_L2_TABLES.entries()) {
          const declared = band.tables[spec.name];
          try {
            const read = await tableReads[index];
            if (spec.name === 'data_items') {
              into.push(() => {
                items += read.rows;
              });
            }
            if (
              read.rows !== declared.rows ||
              read.rowDigest !== declared.rowDigest
            ) {
              fail(
                tables,
                `${spec.name}: ${read.rows} rows, digest ${read.rowDigest}`,
                `${declared.rows} rows, digest ${declared.rowDigest}`,
              );
            }
          } catch (error) {
            if (!(error instanceof L2TableError)) throw error;
            fail(
              tables,
              `${spec.name}: ${error.message}${error.details.length > 0 ? ` (${error.details.join(', ')})` : ''}`,
              'rows in order, keys that hash to their addresses',
            );
          }
        }
      });

      const file = (name: string) =>
        `read_parquet(${sqlString(path.join(dir, name))})`;
      const itemsFile = file('data_items.parquet');
      const tagsFile = file('tags.parquet');
      const walletsFile = file('wallets.parquet');
      const parentsFile = file('parents.parquet');
      // Offsets are unsigned 64-bit; a malformed row (a payload that starts
      // past its item's end) would underflow them, so the arithmetic is done
      // in 128 bits and such a row is counted, not a crash.
      const wide = (cols: string[]) =>
        `* REPLACE (${cols.map((c) => `CAST("${c}" AS HUGEINT) AS "${c}"`).join(', ')})`;
      const itemsWide = `(SELECT ${wide(['root_parent_offset', 'offset', 'size', 'data_offset', 'owner_offset', 'owner_size', 'signature_offset', 'signature_size', 'data_size'])} FROM ${itemsFile})`;
      const parentsWide = `(SELECT ${wide(['root_parent_offset', 'offset', 'size', 'data_offset'])} FROM ${parentsFile})`;

      const sqlSection = section((outer) =>
        rerunnable(outer, sortingTables, async (duck, into) => {
          const fail = failTo(into);
          const report = reportTo(fail);
          // required: what the layout never leaves NULL
          const nullCounts = (columns: string[]) =>
            columns
              .map(
                (c) => `count(*) FILTER (WHERE "${c}" IS NULL) AS "null_${c}"`,
              )
              .join(', ');
          const requiredOf: Array<[string, string, string[]]> = [
            [
              'data_items',
              itemsFile,
              [
                'id',
                'height',
                'block_transaction_index',
                'root_transaction_id',
                'parent_id',
                'owner_address',
                'data_size',
                'tag_count',
              ],
            ],
            [
              'tags',
              tagsFile,
              ['height', 'id', 'tag_index', 'tag_name', 'tag_value'],
            ],
            ['wallets', walletsFile, ['address', 'public_modulus']],
            [
              'parents',
              parentsFile,
              [
                'id',
                'root_transaction_id',
                'root_parent_offset',
                'offset',
                'size',
                'data_offset',
              ],
            ],
          ];
          for (const [table, from_, columns] of requiredOf) {
            const [row] = (await duck.all(
              `SELECT ${nullCounts(columns)} FROM ${from_}`,
            )) as Array<Record<string, unknown>>;
            report(
              required,
              row,
              columns.map(
                (c) => [`null_${c}`, `${table} rows with no ${c}`] as const,
              ),
            );
          }

          // locations
          const [loc] = (await duck.all(`SELECT
      count(*) FILTER (WHERE NOT (
        (root_parent_offset IS NULL AND "offset" IS NULL AND size IS NULL AND data_offset IS NULL AND owner_offset IS NULL AND owner_size IS NULL AND signature_offset IS NULL AND signature_size IS NULL)
        OR (root_parent_offset IS NOT NULL AND "offset" IS NOT NULL AND size IS NOT NULL AND data_offset IS NOT NULL AND owner_offset IS NOT NULL AND owner_size IS NOT NULL AND signature_offset IS NOT NULL AND signature_size IS NOT NULL))) AS part_location,
      count(*) FILTER (WHERE "offset" IS NOT NULL AND NOT ${holds(`
        signature_offset = "offset" + 2 AND owner_offset = signature_offset + signature_size
        AND data_offset >= owner_offset + owner_size AND data_offset <= "offset" + size
        AND data_size = "offset" + size - data_offset`)}) AS bad_layout,
      count(*) FILTER (WHERE "offset" IS NOT NULL AND signature_type IS NOT NULL AND NOT ${holds(sigLengths)}) AS bad_lengths,
      ${countNot(`octet_length(id) = 32 AND octet_length(root_transaction_id) = 32 AND octet_length(parent_id) = 32
        AND octet_length(owner_address) = 32
        AND (target IS NULL OR octet_length(target) = 32) AND (anchor IS NULL OR octet_length(anchor) = 32)`)} AS bad_widths,
      count(*) FILTER (WHERE ${holds('id = root_transaction_id')}) AS own_root,
      ${countNot(`height BETWEEN ${from} AND ${to}`)} AS outside
      FROM ${itemsWide}`)) as Array<Record<string, unknown>>;
          report(locations, loc, [
            ['part_location', 'items with part of a location'],
            [
              'bad_layout',
              'items whose location is not laid out as ANS-104 requires',
            ],
            [
              'bad_lengths',
              'items whose signature or owner length is not their type’s',
            ],
            [
              'bad_widths',
              'items with an id, address or root that is not 32 bytes',
            ],
            ['own_root', 'items that are their own root transaction'],
            ['outside', 'items outside the band’s heights'],
          ]);

          // parents
          const [par] = (await duck.all(`WITH located AS (
        SELECT parent_id, root_transaction_id, root_parent_offset FROM ${itemsWide} WHERE "offset" IS NOT NULL)
      SELECT
        count(*) FILTER (WHERE ${holds('parent_id = root_transaction_id')} AND NOT ${holds('root_parent_offset = 0')}) AS direct_off_zero,
        count(*) FILTER (WHERE NOT ${holds('parent_id = root_transaction_id')} AND NOT EXISTS (
          SELECT 1 FROM ${parentsWide} p WHERE p.id = located.parent_id
            AND p.root_transaction_id = located.root_transaction_id
            AND p.root_parent_offset + p.data_offset = located.root_parent_offset)) AS undescribed,
        (SELECT ${countNot('size > 0 AND data_offset > "offset" AND data_offset <= "offset" + size')} FROM ${parentsWide}) AS bad_parent_layout,
        (SELECT ${countNot('octet_length(id) = 32 AND octet_length(root_transaction_id) = 32')} FROM ${parentsFile}) AS bad_parent_widths
      FROM located`)) as Array<Record<string, unknown>>;
          report(parents, par, [
            ['direct_off_zero', 'items directly in their root not at offset 0'],
            [
              'undescribed',
              'items in a nested bundle that parents does not describe there',
            ],
            [
              'bad_parent_layout',
              'parents whose payload does not start inside them',
            ],
            ['bad_parent_widths', 'parents whose id or root is not 32 bytes'],
          ]);

          // consistency and selected: tags against items, keys against owners
          const [tagRows] = (await duck.all(`SELECT
        ${countNot(`height BETWEEN ${from} AND ${to}`)} AS outside,
        ${countNot('octet_length(id) = 32')} AS bad_widths
      FROM ${tagsFile}`)) as Array<Record<string, unknown>>;
          report(consistency, tagRows, [
            ['outside', 'tag rows outside the band’s heights'],
            ['bad_widths', 'tag rows whose id is not 32 bytes'],
          ]);
          const [joined] = (await duck.all(`WITH
        t AS (SELECT height, id, count(*) AS n, bool_or(${holds(selectedSql)}) AS sel, true AS in_t
              FROM ${tagsFile} GROUP BY height, id),
        d AS (SELECT height, id, min(tag_count) AS tc_min, max(tag_count) AS tc_max,
                     count(*) FILTER (WHERE tag_count IS NULL) AS tc_null, true AS in_d
              FROM ${itemsFile} GROUP BY height, id)
      SELECT
        count(*) FILTER (WHERE in_t AND in_d IS NULL) AS orphan_tags,
        count(*) FILTER (WHERE in_d AND NOT ${holds('tc_null = 0 AND tc_min = coalesce(n, 0) AND tc_max = coalesce(n, 0)')}) AS bad_count,
        count(*) FILTER (WHERE in_d AND NOT ${holds('sel')}) AS not_selected
      FROM t FULL OUTER JOIN d ON t.height = d.height AND t.id = d.id`)) as Array<
            Record<string, unknown>
          >;
          report(consistency, joined, [
            [
              'orphan_tags',
              'items with tag rows but no data_items row at that height',
            ],
            [
              'bad_count',
              'items whose tag_count is not their number of tag rows',
            ],
          ]);
          report(selected, joined, [
            [
              'not_selected',
              `items with no tag the selection ${selection} takes`,
            ],
          ]);
          const [keys] = (await duck.all(`SELECT
        (SELECT count(*) FROM (SELECT DISTINCT owner_address FROM ${itemsFile} WHERE owner_address IS NOT NULL) d
          ANTI JOIN ${walletsFile} w ON w.address = d.owner_address) AS without_key,
        (SELECT count(*) FROM ${walletsFile} w
          ANTI JOIN (SELECT DISTINCT owner_address FROM ${itemsFile}) d ON w.address = d.owner_address) AS stray_keys`)) as Array<
            Record<string, unknown>
          >;
          report(consistency, keys, [
            ['stray_keys', 'keys in wallets of no item’s owner'],
          ]);
          // A builder leaves out an owner whose key it couldn't find, and says how
          // many it left out. More than it says is a key removed.
          const declaredWithout = band.checks?.ownersWithoutKey;
          const allowedWithout =
            typeof declaredWithout === 'number' &&
            Number.isSafeInteger(declaredWithout) &&
            declaredWithout >= 0
              ? declaredWithout
              : 0;
          if (num(keys.without_key) > allowedWithout) {
            fail(
              consistency,
              `${num(keys.without_key)} owners with no key in wallets`,
              `at most the ${allowedWithout} its band.json says (checks.ownersWithoutKey)`,
            );
          }

          // located: what is unlocated is what band.json declares, and little
          const [counts] = (await duck.all(
            `SELECT count(*) AS n, count(*) FILTER (WHERE "offset" IS NULL) AS unlocated FROM ${itemsFile}`,
          )) as Array<Record<string, unknown>>;
          const total = num(counts.n);
          const unlocated = num(counts.unlocated);
          const declaredRaw = band.checks?.unlocated;
          const declared =
            typeof declaredRaw === 'number'
              ? declaredRaw
              : declaredRaw !== null &&
                  typeof declaredRaw === 'object' &&
                  !Array.isArray(declaredRaw)
                ? Object.values(declaredRaw).reduce<number>(
                    (sum, n) => sum + (typeof n === 'number' ? n : Number.NaN),
                    0,
                  )
                : 0;
          const share = total > 0 ? unlocated / total : 0;
          into.push(() =>
            locatedReport.push({
              id,
              items: total,
              unlocated,
              declared,
              share,
            }),
          );
          if (unlocated !== declared) {
            fail(
              located_,
              `${unlocated} unlocated items`,
              `the ${declared} its band.json declares (checks.unlocated)`,
            );
          }
          const wholly = total > 0 && unlocated === total;
          if (share > maxUnlocatedShare && !(wholly && allowUnlocated)) {
            fail(
              located_,
              `${unlocated} of ${total} items unlocated (${share.toPrecision(3)})`,
              `at most ${maxUnlocatedShare} of them${wholly ? ' (or --allow-unlocated)' : ''}`,
            );
          }
        }),
      );

      // lookups
      const lookupsSection = section(async (into) => {
        if (options.lookups === false) return;
        const fail = failTo(into);
        for (const problem of await verifyBandLookups(duck, dir, band, {
          run: pool.run,
          runSorted: sortingLookup,
        })) {
          fail(lookups, problem, 'the rows its tables give, in order');
        }
      });

      // mined: every root in the L1 index, where the items place it
      const minedSection = section((outer) =>
        rerunnable(outer, sortingMined, async (duck, into) => {
          const fail = failTo(into);
          const report = reportTo(fail);
          if (l1Bands !== undefined && minedSummary !== undefined) {
            const covering = coveringL1(l1Bands, from, to);
            if (covering === undefined) {
              into.push(() => minedSummary.uncovered.push(id));
              if (options.l1?.required === true) {
                fail(
                  mined,
                  `the L1 index in ${options.l1.bandsDir} does not cover heights ${from}-${to}`,
                  'an L1 band over every height',
                );
              }
            } else {
              const btSpec = PARQUET_L1_TABLES.find(
                (t) => t.name === 'block_transactions',
              )!;
              const l1Files = covering.map((b) =>
                path.join(b.dir, btSpec.file),
              );
              for (const l1File of l1Files) {
                await checkParquetFile(duck, l1File, {
                  columns: btSpec.columns,
                });
              }
              // By id and height: a root the L1 index does not hold there is not
              // mined there. At another index of the same block, the indexes
              // disagree on the block's order; that fails too, named apart.
              const [roots] = (await duck.all(`SELECT
            count(*) FILTER (WHERE l.transaction_id IS NULL) AS absent,
            count(*) FILTER (WHERE l.transaction_id IS NOT NULL
              AND NOT ${holds('l.block_transaction_index = d.block_transaction_index')}) AS moved
          FROM (SELECT DISTINCT root_transaction_id, height, block_transaction_index FROM ${itemsFile}) d
          LEFT JOIN (
            SELECT transaction_id, height, block_transaction_index
            FROM read_parquet([${l1Files.map(sqlString).join(', ')}]) WHERE height BETWEEN ${from} AND ${to}) l
          ON l.transaction_id = d.root_transaction_id AND l.height = d.height`)) as Array<
                Record<string, unknown>
              >;
              report(mined, roots, [
                [
                  'absent',
                  'roots not in the L1 index at the height their items give',
                ],
              ]);
              if (num(roots.moved) > 0) {
                // Two indexes disagreeing on a block's order: tx_root does not
                // bind it, so the L1 index may be the one wrong. Named, both
                // positions given, and failed all the same.
                const rows =
                  (await duck.all(`SELECT d.root_transaction_id AS root, d.height,
              d.block_transaction_index AS l2_index, l.block_transaction_index AS l1_index
            FROM (SELECT DISTINCT root_transaction_id, height, block_transaction_index FROM ${itemsFile}) d
            JOIN (
              SELECT transaction_id, height, block_transaction_index
              FROM read_parquet([${l1Files.map(sqlString).join(', ')}]) WHERE height BETWEEN ${from} AND ${to}) l
            ON l.transaction_id = d.root_transaction_id AND l.height = d.height
            WHERE NOT ${holds('l.block_transaction_index = d.block_transaction_index')}
            ORDER BY d.height, d.block_transaction_index LIMIT ${MAX_MOVED_REPORTED}`)) as Array<
                    Record<string, unknown>
                  >;
                into.push(() => {
                  for (const r of rows) {
                    if (minedSummary.moved.length >= MAX_MOVED_REPORTED) break;
                    minedSummary.moved.push({
                      band: id,
                      root: Buffer.from(r.root as Buffer).toString('base64url'),
                      height: num(r.height),
                      l2Index: num(r.l2_index),
                      l1Index: num(r.l1_index),
                    });
                  }
                });
                fail(
                  mined,
                  `${num(roots.moved)} roots the L1 index at ${options.l1?.bandsDir} holds at another block_transaction_index than their items give (see mined.moved)`,
                  "the same position in both: the two indexes disagree on the order of a block, and either may be wrong (tx_root does not bind the order); check the L1 index with index-l1-verify, and compare it with the publisher's own L1 index",
                );
              }
              if (num(roots.absent) === 0 && num(roots.moved) === 0) {
                into.push(() => {
                  minedSummary.checked += 1;
                });
              }
            }
          }
        }),
      );

      for (const done of [
        tablesSection,
        sqlSection,
        lookupsSection,
        minedSection,
      ]) {
        const { into, failed, error } = await done;
        log.push(...into);
        if (failed) throw error;
      }

      // onchain: one denominator, no substitution.
      if (options.onchain !== undefined && band.tables.data_items.rows > 0) {
        const {
          perBand,
          openRoot,
          concurrency,
          maxUnchecked = 0,
          deadlineMs,
        } = options.onchain;
        const [counted] = (await pool.run((duck) =>
          duck.all(
            `SELECT count(*) FILTER (WHERE "offset" IS NOT NULL) AS located,
                count(*) FILTER (WHERE "offset" IS NOT NULL AND root_parent_offset = 0) AS direct,
                count(*) FILTER (WHERE "offset" IS NOT NULL AND root_parent_offset <> 0) AS nested,
                count(*) AS n FROM ${itemsFile}`,
          ),
        )) as Array<Record<string, unknown>>;
        const located = num(counted.located);
        const locatedShare = num(counted.n) > 0 ? located / num(counted.n) : 0;
        // The draw, up front: N items uniformly over every located item of
        // the band (the sample the stated bound is about; a publisher chooses
        // an item's stratum, so a stratified draw would weaken it), then
        // nested items on top until ceil(N/2) are nested, where the band has
        // them, so the nested path is always read. Seeded per band by
        // sha256(seed | band id | stratum): the rows with the smallest
        // sha256("<that key>:<row position>").
        const sample = (where: string, size: number, stratum: number) =>
          pool.run((duck) =>
            drawLocated(duck, itemsFile, {
              where,
              size,
              seed: drawSeed(onchainSummary.seed, id, stratum),
            }),
          );
        const rowKey = (r: Record<string, unknown>) =>
          `${Buffer.from(r.id as Buffer).toString('hex')}:${Buffer.from(r.root_transaction_id as Buffer).toString('hex')}:${String(r.root_parent_offset)}:${String(r.offset)}`;
        const uniform = await sample('', Math.min(perBand, located), 0);
        const nestedWant = Math.ceil(perBand / 2);
        const isNested = (r: Record<string, unknown>) =>
          num(r.root_parent_offset) !== 0;
        const nestedInUniform = uniform.filter(isNested).length;
        const drawnKeys = new Set(uniform.map(rowKey));
        const extra: Array<Record<string, unknown>> = [];
        if (
          nestedInUniform < nestedWant &&
          num(counted.nested) > nestedInUniform
        ) {
          for (const r of await sample(
            ' AND root_parent_offset <> 0',
            Math.min(nestedWant, num(counted.nested)),
            1,
          )) {
            if (nestedInUniform + extra.length >= nestedWant) break;
            if (drawnKeys.has(rowKey(r))) continue;
            drawnKeys.add(rowKey(r));
            extra.push(r);
          }
        }
        const toEntries = (rows: Array<Record<string, unknown>>) =>
          rows.map(
            (r): BandSampleEntry => ({
              id: Buffer.from(r.id as Buffer).toString('base64url'),
              rootTxId: Buffer.from(r.root_transaction_id as Buffer).toString(
                'base64url',
              ),
              rootOffset: num(r.root_parent_offset) + num(r.offset),
              rootDataOffset: num(r.root_parent_offset) + num(r.data_offset),
              tag: isNested(r) ? 'nested' : 'direct',
              height: num(r.height),
            }),
          );
        const entries = [...toEntries(uniform), ...toEntries(extra)];
        const empty = {
          id,
          located,
          locatedShare,
          drawn: 0,
          drawnUniform: 0,
          drawnNested: 0,
          ok: 0,
          wrong: 0,
          missing: 0,
          unchecked: 0,
          uncheckedReasons: {},
          errorSample: [],
          inconclusive: false,
        };
        if (entries.length === 0) {
          // Items, none located: nothing can be read on chain, so the band is
          // not verified there, and fails unless that is allowed.
          log.push(() => {
            onchainSummary.unlocatedBands.push(id);
            onchainSummary.bands.push({
              ...empty,
              passed: allowUnlocated,
              reasons: ['no located items to read on chain'],
            });
          });
          if (!allowUnlocated) {
            fail(
              onchainCheck,
              'no item located: not verified on chain',
              'located items to read (or --allow-unlocated)',
            );
          }
          return;
        }
        // Read on chain band by band, in band order, as one run reads
        // them: once the band before is done.
        await turn;
        const result = await checkDrawnHeaders({
          entries,
          openRoot,
          maxUnchecked,
          ...(deadlineMs !== undefined ? { deadlineMs } : {}),
          ...(concurrency !== undefined ? { concurrency } : {}),
        });
        const missing = result.wrong.filter((w) => w.missing === true).length;
        const bandSummary: L2OnChainBand = {
          ...empty,
          drawn: result.drawn,
          drawnUniform: uniform.length,
          drawnNested: entries.filter((e) => e.tag === 'nested').length,
          ok: result.ok,
          wrong: result.wrong.length,
          missing,
          unchecked: result.unchecked.length,
          uncheckedReasons: result.uncheckedReasons,
          errorSample: result.errorSample,
          inconclusive: result.inconclusive,
          passed: result.passed,
          reasons: result.reasons,
        };
        log.push(() => {
          onchainSummary.drawn += result.drawn;
          onchainSummary.ok += result.ok;
          onchainSummary.wrong += result.wrong.length;
          onchainSummary.missing += missing;
          onchainSummary.unchecked += result.unchecked.length;
          onchainSummary.bands.push(bandSummary);
        });
        for (const w of result.wrong) {
          fail(
            onchainCheck,
            `${w.id}: ${w.reason}`,
            'its header at its recorded location',
          );
        }
        if (result.inconclusive) {
          log.push(() => onchainSummary.inconclusiveBands.push(id));
          fail(
            onchainCheck,
            result.reasons.join('; '),
            `every drawn entry checked (at most ${maxUnchecked} unchecked)`,
          );
        } else if (!result.passed) {
          log.push(() =>
            onchainSummary.failedBands.push({ id, reasons: result.reasons }),
          );
        }
      }
    } finally {
      await Promise.all(launched);
    }
  };

  // On one database, bands are checked one after another, in band order.
  // On more, every band is started at once, the largest first (its reads
  // queue first), so the longest band is not left to run alone at the
  // end; reads take turns on the databases as they free up. Either way
  // their logs are applied in band order.
  const logs: Effect[][] = ordered.map(() => []);
  const starts = ordered.map((_, index) => index);
  if (pool.size > 1) {
    const sizes = await Promise.all(
      ordered.map(async ({ dir }) => {
        let bytes = 0;
        for (const name of await fs.readdir(dir).catch(() => [])) {
          if (!name.endsWith('.parquet')) continue;
          bytes += await fs.stat(path.join(dir, name)).then(
            (stat) => stat.size,
            () => 0,
          );
        }
        return bytes;
      }),
    );
    starts.sort((a, b) => sizes[b] - sizes[a] || a - b);
  }
  const turns = ordered.map(() => {
    let done: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      done = resolve;
    });
    return { promise, done };
  });
  let next = 0;
  let checked = 0;
  const checkBands = async () => {
    while (next < starts.length) {
      const index = starts[next];
      next += 1;
      const onDisk = ordered[index];
      const log = logs[index];
      try {
        await checkBand(
          onDisk,
          log,
          index === 0 ? Promise.resolve() : turns[index - 1].promise,
        );
      } catch (error) {
        // One band that can't be read fails, and the rest are still checked.
        const gone = await isGone(onDisk.dir);
        log.push(() => {
          if (gone) vanished.push(onDisk.id);
          addFailure(complete, {
            height: onDisk.band.heightRange[0],
            found: `${onDisk.id}: ${gone ? 'vanished during the run' : `stopped: ${messageOf(error)}`}`,
            expected: 'every check of the band run to its end',
          });
        });
      } finally {
        turns[index].done();
      }
      checked += 1;
      options.progress?.(checked, ordered.length, onDisk.id);
    }
  };
  await Promise.all(
    Array.from({ length: pool.size > 1 ? ordered.length : 1 }, checkBands),
  );
  for (const log of logs) for (const effect of log) effect();

  const checks = [identity];
  if (options.publication !== undefined) checks.push(publicationCheck);
  checks.push(
    coverage_,
    selectionCheck,
    files,
    schema,
    tables,
    required,
    locations,
    parents,
    consistency,
    selected,
    located_,
  );
  if (options.lookups !== false) checks.push(lookups);
  if (options.l1 !== undefined) checks.push(mined);
  if (options.onchain !== undefined) checks.push(onchainCheck);
  checks.push(complete);

  const skipped: string[] = [];
  if (options.lookups === false) skipped.push('lookups');
  if (options.onchain === undefined) skipped.push('onchain');
  if (options.publication === undefined) skipped.push('publication');
  // Roots are found in blocks by the L1 index (every root of a covered band)
  // or by the root source (each sampled root); neither, and it is unchecked.
  // A partly covered run keeps `mined` here (the check didn't run for every
  // band) and names the bands left out in `minedPartial`.
  if (
    options.l1 === undefined ||
    (minedSummary !== undefined && minedSummary.uncovered.length > 0)
  ) {
    skipped.push('mined');
  }
  const minedPartial =
    minedSummary !== undefined && minedSummary.uncovered.length > 0
      ? {
          bands: minedSummary.uncovered.slice(0, MAX_PARTIAL_LISTED),
          count: minedSummary.uncovered.length,
        }
      : undefined;

  const keyFrom = options.publication?.keyFrom ?? 'operator';
  const assurance = [
    bound !== undefined
      ? `bound to the publication of ${bound.publication.publisher} (sequence ${bound.publication.sequence}, issued ${bound.publication.issuedAt}, expires ${bound.publication.expiresAt}), signed by ${bound.publication.signature?.keyId ?? ''}, ${keyFrom === 'operator' ? 'the key the operator gave' : `a key trusted to ${keyFrom}`}`
      : 'not bound to any signature: the checks show only that the bands agree with themselves (no publication)',
    ...(minedSummary !== undefined
      ? [
          `roots found in the L1 index at ${minedSummary.l1BandsDir}, at their block's height and place in it, for ${minedSummary.checked} bands; that index must have been checked (index-l1-verify) for this to trust nothing`,
        ]
      : []),
    ...(options.onchain !== undefined
      ? [
          onchainAssurance(
            options.onchain.perBand,
            options.onchain.maxUnchecked ?? 0,
            // Bands passed as wholly unlocated (--allow-unlocated) draw
            // nothing: they don't lower the bound of the bands that drew,
            // and when no band drew, nothing can be said (0).
            onchainSummary.bands.length === 0
              ? options.onchain.perBand
              : onchainSummary.bands.some((b) => b.drawnUniform > 0)
                ? Math.min(
                    ...onchainSummary.bands
                      .filter((b) => b.drawnUniform > 0)
                      .map((b) => b.drawnUniform),
                  )
                : 0,
          ),
        ]
      : []),
  ];

  return {
    bandsDir,
    selection,
    bands: ordered.length,
    heightRange: span,
    items,
    ok: checks.every((c) => c.ok),
    checks,
    skipped,
    assurance,
    located: locatedReport,
    ...(minedPartial !== undefined ? { minedPartial } : {}),
    publisherBound: bound !== undefined,
    ...(bound !== undefined
      ? {
          publication: {
            publisher: bound.publication.publisher,
            keyId: bound.publication.signature?.keyId ?? '',
            keyFrom,
            sequence: bound.publication.sequence,
            issuedAt: bound.publication.issuedAt,
            expiresAt: bound.publication.expiresAt,
            expired:
              Date.parse(bound.publication.expiresAt) <
              (options.publication?.now ?? Date.now)(),
            index: bound.entry.name,
            bound: publicationCheck.ok,
            absent,
          },
        }
      : {}),
    ...(minedSummary !== undefined ? { mined: minedSummary } : {}),
    superseded,
    partial,
    vanished: [...new Set(vanished)].sort(),
    ...(options.onchain !== undefined ? { onchain: onchainSummary } : {}),
    seconds: (Date.now() - began) / 1000,
  };
}
