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
 * Checks, each reported on its own (see `docs/index-verification.md`):
 *
 * - `identity`: every band's id names its own heights and the digest of its
 *   heights, selection and rows (and, given the publisher, its tag), so the
 *   id a publication signs is the content on disk.
 * - `coverage`: the bands cover one unbroken height range, no overlaps.
 * - `selection`: every band holds the same selection.
 * - `files`: each band holds exactly the files its layout requires.
 * - `tables`: every table's rows, read in file order, are in the table's
 *   order and digest to what `band.json` says; every owner key hashes to its
 *   address.
 * - `locations`: an item's location is whole or absent, its header laid
 *   out as ANS-104 requires (signature right after the type, owner right
 *   after the signature, payload after the owner and inside the item), its
 *   `data_size` the payload the location gives, its ids 32 bytes, and its
 *   height inside the band.
 * - `parents`: an item directly in its root sits at offset 0 of it; an item
 *   in a nested bundle names one described in `parents`, whose payload
 *   starts where the item's location says.
 * - `lookups`: each lookup file holds exactly the rows its tables give.
 * - `onchain` (optional): a sample of items per band, their headers read
 *   from the root transactions at their recorded locations, must hash to
 *   their ids (`checkBandHeaders`, over whatever root source is given:
 *   `onChainRootSource` proves every byte against the chain).
 */
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
import { addFailure, type VerifyCheck } from '../parquet-l1/verify.js';
import {
  BAND_FILE,
  bandFiles,
  bandTablesDigest,
  idHeightRange,
  L2_BAND_ID_PATTERN,
  PARQUET_L2_TABLES,
  type ParquetL2Band,
  parseBandFile,
  serializeSelection,
} from './layout.js';
import { verifyBandLookups } from './lookups.js';
import { digestL2Table, L2TableError } from './tables.js';

/** A set of bands that can't be checked as one index. */
export class L2BandsRefused extends Error {}

export interface L2BandOnDisk {
  /** The band's directory. */
  dir: string;
  /** Its id: the directory name, less an installed generation (`~…`). */
  id: string;
  band: ParquetL2Band;
}

export interface L2OnChainOptions {
  /** Items per band to read (at most; fewer where a band holds fewer). */
  perBand: number;
  openRoot: RootSourceFactory;
  random?: () => number;
  concurrency?: number;
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
  /** Called after each band, for progress. */
  progress?: (done: number, total: number, id: string) => void;
}

export interface L2OnChainSummary {
  checked: number;
  ok: number;
  wrong: number;
  /** Items whose root (or a chunk of it) no reachable node holds. */
  unreadable: number;
  /** Items that couldn't be checked (no node reachable, root unbound). */
  errors: number;
  /** Bands whose header check did not pass, by id, with the reasons. */
  failedBands: Array<{ id: string; reasons: string[] }>;
}

export interface L2BandsVerifyResult {
  bandsDir: string;
  selection: string;
  bands: number;
  heightRange: [number, number];
  /** Rows of `data_items` across the bands checked. */
  items: number;
  ok: boolean;
  checks: VerifyCheck[];
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

/**
 * The bands in a directory: each subdirectory holding a `band.json`.
 * Installed bands' directories carry a generation (`<id>~<generation>`).
 * Entries starting with `.` are skipped.
 */
export async function readL2BandsDir(
  bandsDir: string,
): Promise<L2BandOnDisk[]> {
  const entries = await fs.readdir(bandsDir, { withFileTypes: true });
  const bands: L2BandOnDisk[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = path.join(bandsDir, entry.name);
    let text: string;
    try {
      text = await fs.readFile(path.join(dir, BAND_FILE), 'utf8');
    } catch {
      continue;
    }
    let band: ParquetL2Band;
    try {
      band = parseBandFile(text);
    } catch (error) {
      throw new L2BandsRefused(
        `${entry.name}: ${BAND_FILE} is not an l2 band file: ${(error as Error).message}`,
      );
    }
    bands.push({ dir, id: entry.name.split('~')[0], band });
  }
  return bands;
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

const sqlString = (value: string) => `'${value.replace(/'/g, "''")}'`;
const num = (v: unknown) => Number(v ?? 0);

/**
 * Checks a directory of `parquet-l2` bands.
 *
 * @throws L2BandsRefused when the directory is not one index's bands.
 */
export async function verifyL2Bands(
  duck: Database,
  bandsDir: string,
  options: L2VerifyOptions = {},
): Promise<L2BandsVerifyResult> {
  const began = Date.now();
  const all = await readL2BandsDir(bandsDir);
  const inRange = all.filter(
    ({ band }) =>
      (options.from === undefined || band.heightRange[0] >= options.from) &&
      (options.to === undefined || band.heightRange[1] <= options.to),
  );
  const { ordered, span } = l2Coverage(inRange);

  const check = (name: string, detail: string): VerifyCheck => ({
    name,
    ok: true,
    detail,
  });
  const identity = check(
    'identity',
    "each band's id names its heights and the digest of its heights, selection and rows",
  );
  const selectionCheck = check(
    'selection',
    'every band holds the same selection',
  );
  const files = check(
    'files',
    'each band holds exactly the files its layout requires',
  );
  const tables = check(
    'tables',
    "each table's rows are in order, digest to what band.json says, and every owner key hashes to its address",
  );
  const locations = check(
    'locations',
    'every location is whole or absent, laid out as ANS-104 requires, with data_size its payload, 32-byte ids and the height inside its band',
  );
  const parents = check(
    'parents',
    'items directly in a root sit at offset 0; items in a nested bundle name one described in parents, whose payload starts where the item says',
  );
  const lookups = check(
    'lookups',
    'each lookup file holds exactly the rows its tables give',
  );
  const onchainCheck = check(
    'onchain',
    'a sample of items per band, read at their recorded locations from their root transactions, hash to their ids',
  );

  const selection = serializeSelection(ordered[0].band.selection);
  const tag =
    options.publisher !== undefined
      ? bandPublisherTag(options.publisher)
      : undefined;
  const onchainSummary: L2OnChainSummary = {
    checked: 0,
    ok: 0,
    wrong: 0,
    unreadable: 0,
    errors: 0,
    failedBands: [],
  };
  let items = 0;
  const sigLengths = signatureLengthsSql();

  for (const [index, { dir, id, band }] of ordered.entries()) {
    const [from, to] = band.heightRange;
    const fail = (c: VerifyCheck, found: string, expected: string) =>
      addFailure(c, { height: from, found: `${id}: ${found}`, expected });

    // identity
    const m = L2_BAND_ID_PATTERN.exec(id);
    const heights = idHeightRange(id);
    const digest = bandTablesDigest(band).toString('hex').slice(0, 12);
    if (m === null || heights === undefined) {
      fail(identity, 'not an l2 band id', 'l2-h<from>-<to>-<tag>-<digest>');
    } else {
      if (heights[0] !== from || heights[1] !== to) {
        fail(
          identity,
          `id heights ${heights.join('-')}`,
          `band.json heights ${from}-${to}`,
        );
      }
      if (m[3] !== digest) {
        fail(
          identity,
          `id digest ${m[3]}`,
          `the digest of its contents, ${digest}`,
        );
      }
      if (tag !== undefined && !id.includes(`-${tag}-`)) {
        fail(identity, 'another publisher tag', `the publisher's tag ${tag}`);
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
    if (present.join(',') !== wanted.join(',')) {
      fail(files, present.join(', '), wanted.join(', '));
      continue; // the rest would only fail on the missing files
    }

    // tables
    for (const spec of PARQUET_L2_TABLES) {
      const declared = band.tables[spec.name];
      try {
        const read = await digestL2Table(duck, dir, spec, {
          inFileOrder: true,
        });
        if (declared === undefined) {
          fail(
            tables,
            `${spec.name} not described`,
            'every table in band.json',
          );
        } else if (
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
        if (error instanceof L2TableError) {
          fail(
            tables,
            `${spec.name}: ${error.message}${error.details.length > 0 ? ` (${error.details.join(', ')})` : ''}`,
            'rows in order, keys that hash to their addresses',
          );
        } else {
          throw error;
        }
      }
    }
    items += band.tables.data_items?.rows ?? 0;

    // locations
    const itemsFile = `read_parquet(${sqlString(path.join(dir, 'data_items.parquet'))})`;
    const parentsFile = `read_parquet(${sqlString(path.join(dir, 'parents.parquet'))})`;
    const [loc] = (await duck.all(`SELECT
      count(*) FILTER (WHERE NOT (
        (root_parent_offset IS NULL AND "offset" IS NULL AND size IS NULL AND data_offset IS NULL AND owner_offset IS NULL AND owner_size IS NULL AND signature_offset IS NULL AND signature_size IS NULL)
        OR (root_parent_offset IS NOT NULL AND "offset" IS NOT NULL AND size IS NOT NULL AND data_offset IS NOT NULL AND owner_offset IS NOT NULL AND owner_size IS NOT NULL AND signature_offset IS NOT NULL AND signature_size IS NOT NULL))) AS part_location,
      count(*) FILTER (WHERE "offset" IS NOT NULL AND NOT (
        signature_offset = "offset" + 2 AND owner_offset = signature_offset + signature_size
        AND data_offset >= owner_offset + owner_size AND data_offset <= "offset" + size
        AND data_size = "offset" + size - data_offset)) AS bad_layout,
      count(*) FILTER (WHERE "offset" IS NOT NULL AND signature_type IS NOT NULL AND NOT (${sigLengths})) AS bad_lengths,
      count(*) FILTER (WHERE octet_length(id) <> 32 OR octet_length(root_transaction_id) <> 32 OR octet_length(parent_id) <> 32
        OR (owner_address IS NOT NULL AND octet_length(owner_address) <> 32)
        OR (target IS NOT NULL AND octet_length(target) <> 32) OR (anchor IS NOT NULL AND octet_length(anchor) <> 32)) AS bad_widths,
      count(*) FILTER (WHERE height < ${from} OR height > ${to}) AS outside
      FROM ${itemsFile}`)) as Array<Record<string, unknown>>;
    for (const [key, what] of [
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
      ['outside', 'items outside the band’s heights'],
    ] as const) {
      if (num(loc[key]) > 0) fail(locations, `${num(loc[key])} ${what}`, '0');
    }

    // parents
    const [par] = (await duck.all(`WITH located AS (
        SELECT parent_id, root_transaction_id, root_parent_offset FROM ${itemsFile} WHERE "offset" IS NOT NULL)
      SELECT
        count(*) FILTER (WHERE parent_id = root_transaction_id AND root_parent_offset <> 0) AS direct_off_zero,
        count(*) FILTER (WHERE parent_id <> root_transaction_id AND NOT EXISTS (
          SELECT 1 FROM ${parentsFile} p WHERE p.id = located.parent_id
            AND p.root_transaction_id = located.root_transaction_id
            AND p.root_parent_offset + p.data_offset = located.root_parent_offset)) AS undescribed
      FROM located`)) as Array<Record<string, unknown>>;
    if (num(par.direct_off_zero) > 0) {
      fail(
        parents,
        `${num(par.direct_off_zero)} items directly in their root not at offset 0`,
        '0',
      );
    }
    if (num(par.undescribed) > 0) {
      fail(
        parents,
        `${num(par.undescribed)} items in a nested bundle that parents does not describe there`,
        '0',
      );
    }

    // lookups
    if (options.lookups !== false) {
      for (const problem of await verifyBandLookups(duck, dir, band)) {
        fail(lookups, problem, 'the rows its tables give');
      }
    }

    // onchain
    if (
      options.onchain !== undefined &&
      (band.tables.data_items?.rows ?? 0) > 0
    ) {
      const { perBand, openRoot, random, concurrency } = options.onchain;
      const pool = perBand * HEADER_CHECK_POOL_FACTOR;
      const sample =
        (await duck.all(`SELECT id, root_transaction_id, root_parent_offset, "offset", data_offset,
          CASE WHEN root_parent_offset = 0 THEN 'direct' ELSE 'nested' END AS stratum
        FROM ${itemsFile} WHERE "offset" IS NOT NULL USING SAMPLE ${pool} ROWS`)) as Array<
          Record<string, unknown>
        >;
      const entries: BandSampleEntry[] = sample.map((r) => ({
        id: Buffer.from(r.id as Buffer).toString('base64url'),
        rootTxId: Buffer.from(r.root_transaction_id as Buffer).toString(
          'base64url',
        ),
        rootOffset: num(r.root_parent_offset) + num(r.offset),
        rootDataOffset: num(r.root_parent_offset) + num(r.data_offset),
        tag: r.stratum as string,
      }));
      const nested = entries.filter((e) => e.tag === 'nested').length;
      const targets = {
        direct: Math.max(1, Math.ceil(perBand / 2)),
        nested: nested > 0 ? Math.max(1, Math.floor(perBand / 2)) : 0,
      };
      const result = await checkBandHeaders({
        entries,
        totalRecords: band.tables.data_items.rows,
        openRoot,
        targets,
        minRecords: 0,
        ...(random !== undefined ? { random } : {}),
        ...(concurrency !== undefined ? { concurrency } : {}),
      });
      onchainSummary.checked += result.checked;
      onchainSummary.ok += result.ok;
      onchainSummary.wrong += result.wrong.length;
      onchainSummary.unreadable += result.unreadable.length;
      onchainSummary.errors += result.errors.length;
      for (const w of result.wrong)
        fail(
          onchainCheck,
          `${w.id}: ${w.reason}`,
          'its header at its recorded location',
        );
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

    options.progress?.(index + 1, ordered.length, id);
  }

  const checks = [identity, selectionCheck, files, tables, locations, parents];
  if (options.lookups !== false) checks.push(lookups);
  if (options.onchain !== undefined) checks.push(onchainCheck);
  return {
    bandsDir,
    selection,
    bands: ordered.length,
    heightRange: span,
    items,
    ok: checks.every((c) => c.ok),
    checks,
    ...(options.onchain !== undefined ? { onchain: onchainSummary } : {}),
    seconds: (Date.now() - began) / 1000,
  };
}
