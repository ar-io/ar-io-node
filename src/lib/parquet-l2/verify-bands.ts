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
  checkBandHeaders,
  HEADER_CHECK_POOL_FACTOR,
  RootSourceFactory,
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
  PARQUET_L2_LOOKUPS,
  PARQUET_L2_TABLES,
  type ParquetL2Band,
  parseBandFile,
  serializeSelection,
} from './layout.js';
import { verifyBandLookups } from './lookups.js';
import { selectionDuckDb } from './selection.js';
import { digestL2Table, L2TableError } from './tables.js';

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
  /** Overrides the seeded order a pool is read in (tests). */
  random?: () => number;
  concurrency?: number;
  /**
   * The largest share of the items tried in a band that may be under chunks
   * no node holds (default 0.2). Past it the band fails.
   */
  maxUnreadableShare?: number;
  /**
   * Milliseconds one band's reads may take (default: no limit). Reads still
   * pending then are errors, and the band fails.
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
}

/** One band's part of the on-chain check. */
export interface L2OnChainBand {
  id: string;
  /** Rows of `data_items` with a location, and their share of the rows. */
  located: number;
  locatedShare: number;
  checked: number;
  ok: number;
  wrong: number;
  missing: number;
  unreadable: number;
  unreadableShare: number;
  errors: number;
  /** A few of the transport errors, so a band's errors can be judged. */
  errorSample: string[];
  passed: boolean;
  reasons: string[];
}

export interface L2OnChainSummary {
  checked: number;
  ok: number;
  wrong: number;
  /** Items under a root no node has at all: made up, or never mined. */
  missing: number;
  /** Items whose chunk no reachable node holds. */
  unreadable: number;
  /** Items that couldn't be checked (no node reachable, root unbound). */
  errors: number;
  /** Bands whose header check did not pass, by id, with the reasons. */
  failedBands: Array<{ id: string; reasons: string[] }>;
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

/** A 32-bit hash of a string (FNV-1a), to salt a seed per band. */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (const byte of Buffer.from(text, 'utf8')) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
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
        }
      : undefined;
  if (options.l1 !== undefined) {
    l1Bands = await readL1BandDirectory(options.l1.bandsDir);
  }

  const onchainSummary: L2OnChainSummary = {
    checked: 0,
    ok: 0,
    wrong: 0,
    missing: 0,
    unreadable: 0,
    errors: 0,
    failedBands: [],
    unlocatedBands: [],
    bands: [],
    seed: options.onchain?.seed ?? crypto.randomInt(2 ** 31 - 1),
  };
  let items = 0;
  const locatedReport: L2BandsVerifyResult['located'] = [];
  const sigLengths = signatureLengthsSql();
  const selectedSql = selectionDuckDb(ordered[0].band.selection);

  /** Every check of one band; throws only on what it could not read. */
  const checkBand = async ({ dir, id, band }: L2BandOnDisk) => {
    const [from, to] = band.heightRange;
    const fail = (c: VerifyCheck, found: string, expected: string) =>
      addFailure(c, { height: from, found: `${id}: ${found}`, expected });

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
    for (const spec of [...PARQUET_L2_TABLES, ...PARQUET_L2_LOOKUPS]) {
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
    if (!schemaOk) return; // rows of the wrong shape would only mislead

    // tables
    for (const spec of PARQUET_L2_TABLES) {
      const declared = band.tables[spec.name];
      try {
        const read = await digestL2Table(duck, dir, spec, {
          inFileOrder: true,
        });
        if (spec.name === 'data_items') items += read.rows;
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
    const report = (
      c: VerifyCheck,
      row: Record<string, unknown>,
      what: ReadonlyArray<readonly [string, string]>,
    ) => {
      for (const [key, text] of what) {
        if (num(row[key]) > 0) fail(c, `${num(row[key])} ${text}`, '0');
      }
    };

    // required: what the layout never leaves NULL
    const nullCounts = (columns: string[]) =>
      columns
        .map((c) => `count(*) FILTER (WHERE "${c}" IS NULL) AS "null_${c}"`)
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
      ['bad_widths', 'items with an id, address or root that is not 32 bytes'],
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
      ['bad_parent_layout', 'parents whose payload does not start inside them'],
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
      ['bad_count', 'items whose tag_count is not their number of tag rows'],
    ]);
    report(selected, joined, [
      ['not_selected', `items with no tag the selection ${selection} takes`],
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
    locatedReport.push({ id, items: total, unlocated, declared, share });
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

    // lookups
    if (options.lookups !== false) {
      for (const problem of await verifyBandLookups(duck, dir, band)) {
        fail(lookups, problem, 'the rows its tables give, in order');
      }
    }

    // mined: every root in the L1 index, where the items place it
    if (l1Bands !== undefined && minedSummary !== undefined) {
      const covering = coveringL1(l1Bands, from, to);
      if (covering === undefined) {
        minedSummary.uncovered.push(id);
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
        const l1Files = covering.map((b) => path.join(b.dir, btSpec.file));
        for (const l1File of l1Files) {
          await checkParquetFile(duck, l1File, { columns: btSpec.columns });
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
          [
            'moved',
            'roots the L1 index holds at another block_transaction_index than their items give',
          ],
        ]);
        if (num(roots.absent) === 0 && num(roots.moved) === 0) {
          minedSummary.checked += 1;
        }
      }
    }

    // onchain
    if (options.onchain !== undefined && band.tables.data_items.rows > 0) {
      const {
        perBand,
        openRoot,
        random,
        concurrency,
        maxUnreadableShare = 0.2,
        deadlineMs,
      } = options.onchain;
      const pool = perBand * HEADER_CHECK_POOL_FACTOR;
      // Each stratum is sampled on its own, after it is selected, so a band
      // whose nested items are rare still has them checked. The seed, salted
      // by the band's id (not its place in the run), makes the sample and
      // the order it is read in repeatable.
      const salt = hash32(id);
      const stratumSample = async (where: string, stratum: number) =>
        (await duck.all(`SELECT * FROM (
            SELECT id, height, root_transaction_id, root_parent_offset, "offset", data_offset
            FROM ${itemsFile} WHERE "offset" IS NOT NULL AND ${where})
          USING SAMPLE reservoir(${pool} ROWS) REPEATABLE (${(onchainSummary.seed + salt + stratum) % 2 ** 31})`)) as Array<
          Record<string, unknown>
        >;
      const toEntries = (rows: Array<Record<string, unknown>>, label: string) =>
        rows.map(
          (r): BandSampleEntry => ({
            id: Buffer.from(r.id as Buffer).toString('base64url'),
            rootTxId: Buffer.from(r.root_transaction_id as Buffer).toString(
              'base64url',
            ),
            rootOffset: num(r.root_parent_offset) + num(r.offset),
            rootDataOffset: num(r.root_parent_offset) + num(r.data_offset),
            tag: label,
            height: num(r.height),
          }),
        );
      const direct = toEntries(
        await stratumSample('root_parent_offset = 0', 0),
        'direct',
      );
      const nested = toEntries(
        await stratumSample('root_parent_offset <> 0', 1),
        'nested',
      );
      const [counted] = (await duck.all(
        `SELECT count(*) FILTER (WHERE "offset" IS NOT NULL) AS located, count(*) AS n FROM ${itemsFile}`,
      )) as Array<Record<string, unknown>>;
      const located = num(counted.located);
      const locatedShare = num(counted.n) > 0 ? located / num(counted.n) : 0;
      const entries = [...direct, ...nested];
      if (entries.length === 0) {
        // Items, none located: nothing can be read on chain, so the band is
        // not verified there, and fails unless that is allowed.
        onchainSummary.unlocatedBands.push(id);
        onchainSummary.bands.push({
          id,
          located,
          locatedShare,
          checked: 0,
          ok: 0,
          wrong: 0,
          missing: 0,
          unreadable: 0,
          unreadableShare: 0,
          errors: 0,
          errorSample: [],
          passed: allowUnlocated,
          reasons: ['no located items to read on chain'],
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
      const half = Math.ceil(perBand / 2);
      const targets: Record<string, number> =
        direct.length === 0
          ? { nested: perBand }
          : nested.length === 0
            ? { direct: perBand }
            : { direct: half, nested: Math.max(1, perBand - half) };
      const result = await checkBandHeaders({
        entries,
        totalRecords: band.tables.data_items.rows,
        openRoot,
        targets,
        minRecords: 0,
        random: random ?? seededRandom((onchainSummary.seed ^ salt) >>> 0),
        missingRootIsWrong: true,
        maxUnreadableShare,
        ...(deadlineMs !== undefined ? { deadlineMs } : {}),
        ...(concurrency !== undefined ? { concurrency } : {}),
      });
      onchainSummary.checked += result.checked;
      onchainSummary.ok += result.ok;
      onchainSummary.wrong += result.wrong.length;
      onchainSummary.missing += result.missing.length;
      onchainSummary.unreadable += result.unreadable.length;
      onchainSummary.errors += result.errors.length;
      onchainSummary.bands.push({
        id,
        located,
        locatedShare,
        checked: result.checked,
        ok: result.ok,
        wrong: result.wrong.length,
        missing: result.missing.length,
        unreadable: result.unreadable.length,
        unreadableShare: result.unreadableShare,
        errors: result.errors.length,
        errorSample: [...new Set(result.errors.map((e) => e.error))].slice(
          0,
          3,
        ),
        passed: result.passed,
        reasons: result.reasons,
      });
      for (const w of result.wrong) {
        fail(
          onchainCheck,
          `${w.id}: ${w.reason}`,
          'its header at its recorded location',
        );
      }
      if (!result.passed) {
        onchainSummary.failedBands.push({ id, reasons: result.reasons });
        if (result.wrong.length === 0) {
          fail(
            onchainCheck,
            result.reasons.join('; '),
            'enough items verified',
          );
        }
      }
    }
  };

  for (const [index, onDisk] of ordered.entries()) {
    try {
      await checkBand(onDisk);
    } catch (error) {
      // One band that can't be read fails, and the rest are still checked.
      const gone = await isGone(onDisk.dir);
      if (gone) vanished.push(onDisk.id);
      addFailure(complete, {
        height: onDisk.band.heightRange[0],
        found: `${onDisk.id}: ${gone ? 'vanished during the run' : `stopped: ${messageOf(error)}`}`,
        expected: 'every check of the band run to its end',
      });
    }
    options.progress?.(index + 1, ordered.length, onDisk.id);
  }

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
  if (
    options.l1 === undefined ||
    (minedSummary !== undefined && minedSummary.uncovered.length > 0)
  ) {
    skipped.push('mined');
  }

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
