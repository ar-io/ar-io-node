/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Reading a `parquet-l1` band back, for an importer.
 *
 * A band's files arrive from a publisher, so nothing in them is trusted. The
 * sidecar has already checked them against the signed digests and the
 * layout; this reads the rows and checks them against what the band's own
 * `band.json` claims: the row count and the row digest of each table, in the
 * table's order. A band whose rows don't reproduce its digests is refused
 * before a single row reaches SQLite.
 *
 * Rows come back in batches so a 1.4 GB band never has to fit in memory.
 */
import type { Database } from 'duckdb-async';
import * as path from 'node:path';

import type { ColumnSpec } from '../parquet/check.js';
import { RowDigest } from './digest.js';
import { ParquetL1Band, PARQUET_L1_TABLES, TableSpec } from './layout.js';

/** Rows read per batch: enough to amortise the query, small enough to hold. */
export const READ_BATCH_ROWS = 50_000;
/**
 * Heights per query for a table ordered by height. The densest 1,000
 * heights of the chain hold roughly a quarter of a million tag rows.
 */
export const READ_HEIGHT_WINDOW = 1_000;

export class BandRowsError extends Error {}

/**
 * Columns the chain fixes the width of: a hash is a hash. Zero is allowed
 * too, because the chain leaves some of them empty (every `tx_root` before
 * 2.0, `previous_block` at genesis).
 */
const EXACT_BYTES: Record<string, number> = {
  indep_hash: 48,
  previous_block: 48,
  hash_list_merkle: 48,
  id: 32,
  transaction_id: 32,
  owner_address: 32,
  address: 32,
};

/**
 * Everything else a band may carry in a blob. Not a shape the chain
 * promises — early transactions really do hold a 1-byte `target`, and
 * `tag_name` is whatever its author wrote — so this only stops a band
 * inflating the database with something absurd. An RSA-4096 key is 512
 * bytes and Arweave caps tags well below this.
 */
const MAX_BYTES = 16 * 1024;

/**
 * How a column is read back.
 *
 * Whole numbers wider than a double come back as text, not as JavaScript
 * numbers: DuckDB hands a `DECIMAL(20,0)` to node as a number, and an
 * Arweave quantity of 5e17 is far past the 2^53 a double holds exactly, so
 * reading it as a number silently rounds it. A `UBIGINT` arrives as a
 * bigint and is exact, but the chain's weave offsets are close enough to
 * the limit that it is not worth depending on which one a driver picks.
 * The digest treats "5" and 5 alike, so this doesn't change it.
 */
function selectColumn(column: ColumnSpec): string {
  const wide = column.type.startsWith('DECIMAL') || column.type === 'UBIGINT';
  return wide
    ? `CAST(t."${column.name}" AS VARCHAR) AS "${column.name}"`
    : `t."${column.name}"`;
}

/**
 * Checks one row's values against the layout: a blob column the chain fixes
 * the width of must have that width, and a height must be in the band.
 * Everything else the row digest covers.
 */
function checkRow(
  spec: TableSpec,
  values: unknown[],
  heightRange: [number, number],
): void {
  for (const [i, column] of spec.columns.entries()) {
    const value = values[i];
    if (value === null || value === undefined) continue;
    if (column.type === 'BLOB') {
      const length = (value as Uint8Array).length;
      const exact = EXACT_BYTES[column.name];
      if (exact !== undefined && length !== exact && length !== 0) {
        throw new BandRowsError(
          `${spec.name}.${column.name} is ${length} bytes, not ${exact}`,
        );
      }
      if (length > MAX_BYTES) {
        throw new BandRowsError(
          `${spec.name}.${column.name} is ${length} bytes, over the ${MAX_BYTES} a band may carry`,
        );
      }
    }
    if (column.name === 'height') {
      const height = Number(value);
      if (height < heightRange[0] || height > heightRange[1]) {
        throw new BandRowsError(
          `${spec.name} holds height ${height}, outside the band's ${JSON.stringify(heightRange)}`,
        );
      }
    }
  }
}

/**
 * Reads one table of a band in batches, in the order its digest was taken,
 * checking each row and the digest of the whole. `onBatch` sees rows as
 * arrays in the layout's column order.
 */
export async function readTable(
  duck: Database,
  dir: string,
  spec: TableSpec,
  band: ParquetL1Band,
  onBatch: (rows: unknown[][]) => Promise<void>,
  batchRows = READ_BATCH_ROWS,
  /**
   * Columns to read beyond the layout's, as `<expression> AS <name>`. They
   * come after the layout's in each row and are left out of the digest: the
   * digest covers what the band says it holds, not what a reader joined to
   * it. Used to carry a tag's `block_transaction_index`, which the layout
   * keys by transaction id.
   */
  extra: { select: string[]; from: string } = { select: [], from: '' },
  /** Heights read per query, for a table ordered by height. */
  heightWindow = READ_HEIGHT_WINDOW,
): Promise<number> {
  const described = band.tables[spec.name];
  if (described === undefined) {
    throw new BandRowsError(`${BAND_LABEL}: ${spec.name} is not described`);
  }
  const file = path.join(dir, spec.file).replace(/'/g, "''");
  const self = `read_parquet('${file}')`;
  const columns = [
    ...spec.columns.map((c) => selectColumn(c)),
    ...extra.select,
  ].join(', ');
  const order = spec.orderBy.map((c) => `t."${c}"`).join(', ');
  const from = extra.from === '' ? `${self} t` : `${self} t ${extra.from}`;
  const digest = new RowDigest(spec.columns);
  const names = [
    ...spec.columns.map((c) => c.name),
    ...extra.select.map((e) => e.slice(e.lastIndexOf(' ') + 1)),
  ];
  let read = 0;
  let batch: unknown[][] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const sending = batch;
    batch = [];
    await onBatch(sending);
  };
  const take = async (where: string) => {
    // Streamed, so a window's rows are not all held at once; the window
    // itself is what stops DuckDB reading far ahead of the writer. Paging
    // with LIMIT/OFFSET instead would re-scan and re-sort the file for
    // every page, which on a 25M-row table read through a join is
    // quadratic.
    const stream = await duck.stream(
      `SELECT ${columns} FROM ${from}${where} ORDER BY ${order}`,
    );
    for await (const row of stream) {
      const values = names.map((n) => (row as Record<string, unknown>)[n]);
      const own = values.slice(0, spec.columns.length);
      checkRow(spec, own, band.heightRange);
      digest.add(own);
      read += 1;
      if (read > described.rows) {
        throw new BandRowsError(
          `${spec.name} holds more than the ${described.rows} rows its band.json claims`,
        );
      }
      batch.push(values);
      if (batch.length >= batchRows) await flush();
    }
    await flush();
  };

  // A table ordered by height is read a window of heights at a time, in
  // ascending order, so the rows still reach the digest in the table's
  // order. This bounds the work in any one query — the largest band's tag
  // table is 25M rows read through a join — and makes progress visible.
  // It is not what keeps memory down: the importer holds about 450 MB
  // whichever way the rows are read, and what looks like gigabytes in
  // `docker stats` is the page cache of the database being written.
  if (spec.orderBy[0] === 'height' && heightWindow > 0) {
    const [low, high] = band.heightRange;
    // Reading by window would quietly leave a row outside the band
    // unread, and the count and digest would then disagree for a reason
    // that doesn't name the cause. Ask directly, once per table.
    const [stray] = (await duck.all(
      `SELECT COUNT(*) AS n FROM ${self} t WHERE t."height" < ${low} OR t."height" > ${high}`,
    )) as Array<{ n: number | bigint }>;
    if (Number(stray.n) > 0) {
      throw new BandRowsError(
        `${spec.name} holds ${Number(stray.n)} rows outside the band's ${JSON.stringify(band.heightRange)}`,
      );
    }
    for (let at = low; at <= high; at += heightWindow) {
      const end = Math.min(high, at + heightWindow - 1);
      await take(` WHERE t."height" BETWEEN ${at} AND ${end}`);
    }
  } else {
    await take('');
  }
  if (read !== described.rows) {
    throw new BandRowsError(
      `${spec.name} holds ${read} rows, its band.json claims ${described.rows}`,
    );
  }
  if (digest.hex() !== described.rowDigest) {
    throw new BandRowsError(
      `${spec.name} rows do not reproduce the digest its band.json claims`,
    );
  }
  return read;
}

const BAND_LABEL = 'band.json';

/** The tables of a band, in the order an importer must write them. */
export const IMPORT_ORDER: TableSpec[] = [
  'wallets',
  'blocks',
  'transactions',
  'block_transactions',
  'tags',
].map((name) => PARQUET_L1_TABLES.find((t) => t.name === name) as TableSpec);
