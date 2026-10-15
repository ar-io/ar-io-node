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
  /** (id, root) pairs located before and not now: never allowed. */
  unlocated: number;
  unlocatedSample: string[];
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

/** Compares a new band's items and keys with those of the bands it replaces. */
export async function compareL2Bands(
  duck: Database,
  oldDirs: string[],
  newDir: string,
  maxRelocated: number,
): Promise<L2Compare> {
  const old = `read_parquet([${oldDirs.map((dir) => file(dir)).join(', ')}])`;
  const next = `read_parquet(${file(newDir)})`;
  await duck.exec(`
    CREATE OR REPLACE TEMP VIEW o AS SELECT * FROM ${old};
    CREATE OR REPLACE TEMP VIEW n AS SELECT * FROM ${next};`);
  const missingSql = 'SELECT DISTINCT o.id FROM o ANTI JOIN n ON n.id = o.id';
  const unlocatedSql = `
    SELECT DISTINCT o.id, o.root_transaction_id FROM o
    ANTI JOIN (SELECT id, root_transaction_id FROM n WHERE "offset" IS NOT NULL) x
      ON x.id = o.id AND x.root_transaction_id = o.root_transaction_id
    WHERE o."offset" IS NOT NULL`;
  const sameLocation = LOCATION.map((c) => `p."${c}" = n."${c}"`).join(' AND ');
  const relocatedSql = `
    SELECT n.id, n.root_transaction_id, n.root_parent_offset, n."offset", n.data_offset
    FROM n
    WHERE n."offset" IS NOT NULL
      AND EXISTS (SELECT 1 FROM o p WHERE p.id = n.id
        AND p.root_transaction_id = n.root_transaction_id AND p."offset" IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM o p WHERE p.id = n.id
        AND p.root_transaction_id = n.root_transaction_id AND ${sameLocation})`;
  const newlyLocatedSql = `
    SELECT n.id, n.root_transaction_id, n.root_parent_offset, n."offset", n.data_offset
    FROM n
    WHERE n."offset" IS NOT NULL
      AND EXISTS (SELECT 1 FROM o p WHERE p.id = n.id
        AND p.root_transaction_id = n.root_transaction_id)
      AND NOT EXISTS (SELECT 1 FROM o p WHERE p.id = n.id
        AND p.root_transaction_id = n.root_transaction_id AND p."offset" IS NOT NULL)`;
  const walletsMissingSql = `
    SELECT DISTINCT o.address AS id
    FROM read_parquet([${oldDirs.map((dir) => file(dir, 'wallets')).join(', ')}]) o
    ANTI JOIN read_parquet(${file(newDir, 'wallets')}) n ON n.address = o.address`;
  const ids = async (sql: string) =>
    (
      (await duck.all(`${sql} ORDER BY 1 LIMIT ${SAMPLE}`)) as Array<{
        id: Buffer;
      }>
    ).map((row) => toB64Url(Buffer.from(row.id)));

  const compare: L2Compare = {
    oldRows: await count(duck, 'SELECT * FROM o'),
    newRows: await count(duck, 'SELECT * FROM n'),
    added: await count(
      duck,
      'SELECT DISTINCT n.id FROM n ANTI JOIN o ON o.id = n.id',
    ),
    missing: await count(duck, missingSql),
    missingSample: [],
    unlocated: await count(duck, unlocatedSql),
    unlocatedSample: [],
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
  return compare;
}
