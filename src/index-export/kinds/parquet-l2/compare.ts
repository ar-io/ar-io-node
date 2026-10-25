/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * How a rebuilt `parquet-l2` band differs from the bands it would replace,
 * read from their `data_items` and `wallets` tables: a band that replaces
 * others never loses an item, the location of an item in a root, or an
 * owner's key; every item it relocates is header-checked before it
 * publishes, and a sample of those it locates for the first time. Locating
 * an item, or keying an owner, the old bands couldn't is an improvement,
 * and allowed.
 */
import * as path from 'node:path';
import type { Database } from 'duckdb-async';

import type { BandSampleEntry } from '../../../lib/index-band/build.js';
import { HEADER_CHECK_POOL_FACTOR } from '../../../lib/index-band/verify.js';
import { toB64Url } from '../../../lib/encoding.js';
import { PARQUET_L2_TABLES } from '../../../lib/parquet-l2/layout.js';

/** The header-check stratum of every row a replacement relocates. */
export const L2_RELOCATED_TAG = 'relocated';
/**
 * The header-check stratum of rows located now and not before: a pool of
 * {@link HEADER_CHECK_POOL_FACTOR} times the sample, walked until the
 * sample is read.
 */
export const L2_NEWLY_LOCATED_TAG = 'newly-located';
export const NEWLY_LOCATED_SAMPLE = 150;

const SAMPLE = 20;

export interface L2Compare {
  oldRows: number;
  newRows: number;
  /** Ids the new band holds and the old ones don't. */
  added: number;
  /** Ids the old bands hold and the new one doesn't: never allowed. */
  missing: number;
  missingSample: string[];
  /**
   * (id, root) pairs located before and not now, where the old location
   * could be checked (directly in the root, or under a parent the old
   * bands' `parents` describes at that place): never allowed.
   */
  unlocated: number;
  unlocatedSample: string[];
  /**
   * (id, root) pairs located before only under a parent the old bands'
   * `parents` does not describe at that place (a location no reader can
   * check: the parent's own row was inconsistent, ar-io-node #937), and
   * unlocated now. A correction, not a loss: allowed, and reported.
   */
  corrected: number;
  correctedSample: string[];
  /** Located rows of an (id, root) the old bands located elsewhere. */
  relocated: number;
  /** Every relocated row, up to the cap, for the header check. */
  relocatedEntries: BandSampleEntry[];
  /** (id, root) pairs the old bands held unlocated and the new one locates. */
  newlyLocated: number;
  /** A sample of them, for the header check. */
  newlyLocatedEntries: BandSampleEntry[];
  /** Owners whose key the old bands hold and the new one doesn't: never allowed. */
  walletsMissing: number;
  walletsMissingSample: string[];
}

const file = (dir: string, table = 'data_items') =>
  `'${path
    .join(dir, PARQUET_L2_TABLES.find((t) => t.name === table)!.file)
    .replace(/'/g, "''")}'`;

const LOCATION = [
  'root_parent_offset',
  'offset',
  'size',
  'data_offset',
  'owner_offset',
  'owner_size',
  'signature_offset',
  'signature_size',
];

async function count(duck: Database, sql: string): Promise<number> {
  const [row] = (await duck.all(
    `SELECT count(*) AS n FROM (${sql})`,
  )) as Array<{
    n: bigint | number;
  }>;
  return Number(row?.n ?? 0);
}

interface LocatedRow {
  id: Buffer;
  root_transaction_id: Buffer;
  root_parent_offset: bigint | number;
  offset: bigint | number;
  data_offset: bigint | number;
}

/** A located row as the header check reads it. */
const entry = (row: LocatedRow, tag: string): BandSampleEntry => ({
  id: toB64Url(Buffer.from(row.id)),
  rootTxId: toB64Url(Buffer.from(row.root_transaction_id)),
  rootOffset: Number(row.root_parent_offset) + Number(row.offset),
  rootDataOffset: Number(row.root_parent_offset) + Number(row.data_offset),
  tag,
});

/**
 * Compares a new band's items and keys with those of the bands it replaces.
 *
 * One pass: each side is reduced to one row per (id, root) with what the
 * comparison asks of it, the two are joined once into a narrow temp table
 * (`cmp`), and every count and sample reads that table. Reading the two
 * `data_items` files once per question, as this did, took over an hour on
 * a 6.7M-item band under the build's 2 GB DuckDB limit; this takes about
 * a minute. Relocations alone need the location columns, and are found by
 * one anti join of the new located rows against the old on all of them.
 */
export async function compareL2Bands(
  duck: Database,
  oldDirs: string[],
  newDir: string,
  maxRelocated: number,
  /**
   * Compare against only the old bands' rows at these heights: a band that
   * replaces part of a larger one (a split) answers for its own heights.
   * Owners' keys are then those of the old rows at these heights.
   */
  heightRange?: [number, number],
): Promise<L2Compare> {
  const within =
    heightRange !== undefined
      ? ` WHERE height BETWEEN ${Math.trunc(heightRange[0])} AND ${Math.trunc(heightRange[1])}`
      : '';
  const old = `(SELECT * FROM read_parquet([${oldDirs.map((dir) => file(dir)).join(', ')}])${within})`;
  const oldParents = `read_parquet([${oldDirs.map((dir) => file(dir, 'parents')).join(', ')}])`;
  const next = `read_parquet(${file(newDir)})`;
  const pair = (p: string) =>
    `${p}.id = n.id AND ${p}.root_transaction_id = n.root_transaction_id`;
  // A location as one 64-bit key, so the join that finds relocations is on
  // three narrow columns of two materialised tables rather than ten of the
  // Parquet files (the old rows' eight location columns beside id and root
  // ran the join out of the build's memory and into a spill that took over
  // an hour; keyed and materialised first, it takes a second). Two
  // locations of one item and root that differ yet hash alike (one chance
  // in 2^64) would hide a relocation from the header check, never report a
  // false one.
  const locationKey = (p: string) =>
    `hash(${LOCATION.map((c) => `${p}."${c}"`).join(', ')})`;
  // One statement per call, so a slow one shows in a profile as itself.
  // The semi joins filter their right side in a subquery: a filter on one
  // side in a semi join's ON clause had DuckDB 1.4.2 deduplicate the wide
  // left side instead, spilling for over ten minutes on a 6.7M-item band.
  for (const statement of [
    `CREATE OR REPLACE TEMP VIEW o AS SELECT * FROM ${old} o`,
    `CREATE OR REPLACE TEMP VIEW n AS SELECT * FROM ${next}`,
    `-- Per (id, root) of each side: whether it is located, and (old side)
    -- whether at a place a reader could check: directly in the root, or
    -- under a parent the old bands' parents table describes where the
    -- item says its payload starts (the rule index-l2-verify checks).
    CREATE OR REPLACE TEMP TABLE cmp AS
    WITH described AS (
      SELECT DISTINCT id AS parent_id, root_transaction_id,
             root_parent_offset + data_offset AS payload_start
      FROM ${oldParents}),
    old_pairs AS (
      SELECT o.id, o.root_transaction_id,
             bool_or(o."offset" IS NOT NULL) AS old_located,
             bool_or(o."offset" IS NOT NULL AND
               (o.parent_id = o.root_transaction_id OR d.parent_id IS NOT NULL)) AS checkable
      FROM o
      LEFT JOIN described d ON d.parent_id = o.parent_id
        AND d.root_transaction_id = o.root_transaction_id
        AND d.payload_start = o.root_parent_offset
      GROUP BY 1, 2),
    new_pairs AS (
      SELECT id, root_transaction_id, bool_or("offset" IS NOT NULL) AS new_located
      FROM n GROUP BY 1, 2)
    SELECT coalesce(a.id, b.id) AS id,
           coalesce(a.root_transaction_id, b.root_transaction_id) AS root_transaction_id,
           a.id IS NOT NULL AS in_old,
           b.id IS NOT NULL AS in_new,
           coalesce(a.old_located, false) AS old_located,
           coalesce(a.checkable, false) AS checkable,
           coalesce(b.new_located, false) AS new_located
    FROM old_pairs a
    FULL OUTER JOIN new_pairs b
      ON a.id = b.id AND a.root_transaction_id = b.root_transaction_id`,
    `-- The located rows of each side, keyed.
    CREATE OR REPLACE TEMP TABLE o_loc AS
    SELECT o.id, o.root_transaction_id, ${locationKey('o')} AS loc
    FROM o WHERE o."offset" IS NOT NULL`,
    `CREATE OR REPLACE TEMP TABLE n_loc AS
    SELECT n.id, n.root_transaction_id, ${locationKey('n')} AS loc,
           n.root_parent_offset, n."offset", n.data_offset
    FROM n WHERE n."offset" IS NOT NULL`,
    `-- New located rows of a pair the old bands located, at a location none
    -- of their rows had, and new located rows of a pair they held unlocated.
    CREATE OR REPLACE TEMP TABLE reloc AS
    SELECT n.id, n.root_transaction_id, n.root_parent_offset, n."offset", n.data_offset
    FROM n_loc n
    ANTI JOIN o_loc q ON ${pair('q')} AND q.loc = n.loc
    SEMI JOIN (SELECT id, root_transaction_id FROM cmp WHERE old_located) c
      ON ${pair('c')}`,
    `CREATE OR REPLACE TEMP TABLE newloc AS
    SELECT n.id, n.root_transaction_id, n.root_parent_offset, n."offset", n.data_offset
    FROM n_loc n
    SEMI JOIN (SELECT id, root_transaction_id FROM cmp WHERE in_old AND NOT old_located) c
      ON ${pair('c')}`,
  ]) {
    await duck.exec(statement);
  }
  // Ids, not pairs: an item held under another root is still held.
  const missingSql = `
    SELECT DISTINCT id FROM cmp WHERE in_old
    EXCEPT SELECT id FROM cmp WHERE in_new`;
  const addedSql = `
    SELECT DISTINCT id FROM cmp WHERE in_new
    EXCEPT SELECT id FROM cmp WHERE in_old`;
  const unlocatedSql = `
    SELECT id, root_transaction_id FROM cmp
    WHERE old_located AND checkable AND NOT new_located`;
  const correctedSql = `
    SELECT id, root_transaction_id FROM cmp
    WHERE old_located AND NOT checkable AND NOT new_located`;
  const relocatedSql = 'SELECT * FROM reloc n';
  const newlyLocatedSql = 'SELECT * FROM newloc n';
  const oldWallets =
    heightRange === undefined
      ? `read_parquet([${oldDirs.map((dir) => file(dir, 'wallets')).join(', ')}])`
      : `(SELECT w.* FROM read_parquet([${oldDirs.map((dir) => file(dir, 'wallets')).join(', ')}]) w
          SEMI JOIN (SELECT DISTINCT owner_address FROM o) s ON s.owner_address = w.address)`;
  const walletsMissingSql = `
    SELECT DISTINCT o.address AS id
    FROM ${oldWallets} o
    ANTI JOIN read_parquet(${file(newDir, 'wallets')}) n ON n.address = o.address`;
  const ids = async (sql: string) =>
    (
      (await duck.all(`${sql} ORDER BY 1 LIMIT ${SAMPLE}`)) as Array<{
        id: Buffer;
      }>
    ).map((row) => toB64Url(Buffer.from(row.id)));
  const [counts] = (await duck.all(`
    SELECT count(*) FILTER (WHERE old_located AND checkable AND NOT new_located) AS unlocated,
           count(*) FILTER (WHERE old_located AND NOT checkable AND NOT new_located) AS corrected
    FROM cmp`)) as Array<Record<string, bigint | number>>;

  const compare: L2Compare = {
    oldRows: await count(duck, 'SELECT * FROM o'),
    newRows: await count(duck, 'SELECT * FROM n'),
    added: await count(duck, addedSql),
    missing: await count(duck, missingSql),
    missingSample: [],
    unlocated: Number(counts.unlocated),
    unlocatedSample: [],
    corrected: Number(counts.corrected),
    correctedSample: [],
    relocated: await count(duck, relocatedSql),
    relocatedEntries: [],
    newlyLocated: await count(duck, newlyLocatedSql),
    newlyLocatedEntries: [],
    walletsMissing: await count(duck, walletsMissingSql),
    walletsMissingSample: [],
  };
  if (compare.walletsMissing > 0) {
    compare.walletsMissingSample = await ids(walletsMissingSql);
  }
  if (compare.missing > 0) compare.missingSample = await ids(missingSql);
  if (compare.unlocated > 0) compare.unlocatedSample = await ids(unlocatedSql);
  if (compare.corrected > 0) compare.correctedSample = await ids(correctedSql);
  if (compare.relocated > 0 && compare.relocated <= maxRelocated) {
    const rows = (await duck.all(relocatedSql)) as LocatedRow[];
    compare.relocatedEntries = rows.map((row) => entry(row, L2_RELOCATED_TAG));
  }
  if (compare.newlyLocated > 0) {
    // A spread of them, the same each time for the same rows.
    const rows = (await duck.all(
      `${newlyLocatedSql} ORDER BY hash(n.id, n.root_transaction_id) LIMIT ${NEWLY_LOCATED_SAMPLE * HEADER_CHECK_POOL_FACTOR}`,
    )) as LocatedRow[];
    compare.newlyLocatedEntries = rows.map((row) =>
      entry(row, L2_NEWLY_LOCATED_TAG),
    );
  }
  await duck.exec(
    'DROP TABLE IF EXISTS cmp; DROP TABLE IF EXISTS o_loc; DROP TABLE IF EXISTS n_loc; DROP TABLE IF EXISTS reloc; DROP TABLE IF EXISTS newloc;',
  );
  return compare;
}
