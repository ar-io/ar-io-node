/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * How a rebuilt `parquet-l2` band differs from the bands it would replace,
 * read from their `data_items` tables: a band that replaces others never
 * loses an item, nor the location of an item in a root, and every item it
 * relocates is header-checked before it publishes.
 */
import * as path from 'node:path';
import type { Database } from 'duckdb-async';

import type { BandSampleEntry } from '../../../lib/index-band/build.js';
import { toB64Url } from '../../../lib/encoding.js';
import { PARQUET_L2_TABLES } from '../../../lib/parquet-l2/layout.js';

/** The header-check stratum of every row a replacement relocates. */
export const L2_RELOCATED_TAG = 'relocated';

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
}

const file = (dir: string) =>
  `'${path
    .join(dir, PARQUET_L2_TABLES.find((t) => t.name === 'data_items')!.file)
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

/** Compares a new band's items with those of the bands it replaces. */
export async function compareL2Bands(
  duck: Database,
  oldDirs: string[],
  newDir: string,
  maxRelocated: number,
): Promise<L2Compare> {
  const old = `read_parquet([${oldDirs.map(file).join(', ')}])`;
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
  };
  if (compare.missing > 0) compare.missingSample = await ids(missingSql);
  if (compare.unlocated > 0) compare.unlocatedSample = await ids(unlocatedSql);
  if (compare.relocated > 0 && compare.relocated <= maxRelocated) {
    const rows = (await duck.all(relocatedSql)) as Array<{
      id: Buffer;
      root_transaction_id: Buffer;
      root_parent_offset: bigint | number;
      offset: bigint | number;
      data_offset: bigint | number;
    }>;
    compare.relocatedEntries = rows.map((row) => ({
      id: toB64Url(Buffer.from(row.id)),
      rootTxId: toB64Url(Buffer.from(row.root_transaction_id)),
      rootOffset: Number(row.root_parent_offset) + Number(row.offset),
      rootDataOffset: Number(row.root_parent_offset) + Number(row.data_offset),
      tag: L2_RELOCATED_TAG,
    }));
  }
  return compare;
}
