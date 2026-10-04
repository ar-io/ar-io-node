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

import { RowDigest } from './digest.js';
import { ParquetL1Band, PARQUET_L1_TABLES, TableSpec } from './layout.js';

/** Rows read per batch: enough to amortise the query, small enough to hold. */
export const READ_BATCH_ROWS = 50_000;

export class BandRowsError extends Error {}

/** The byte lengths a column must have, where the chain fixes them. */
const FIXED_BYTES: Record<string, number> = {
  indep_hash: 48,
  previous_block: 48,
  hash_list_merkle: 48,
  id: 32,
  transaction_id: 32,
  data_root: 32,
  owner_address: 32,
  target: 32,
  address: 32,
};

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
    const fixed = FIXED_BYTES[column.name];
    if (fixed !== undefined && column.type === 'BLOB') {
      const length = (value as Uint8Array).length;
      // tx_root and an empty value are zero bytes; a wrong non-zero width is
      // not something the chain produces.
      if (length !== fixed && length !== 0) {
        throw new BandRowsError(
          `${spec.name}.${column.name} is ${length} bytes, not ${fixed}`,
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
): Promise<number> {
  const described = band.tables[spec.name];
  if (described === undefined) {
    throw new BandRowsError(`${BAND_LABEL}: ${spec.name} is not described`);
  }
  const file = path.join(dir, spec.file).replace(/'/g, "''");
  const self = `read_parquet('${file}')`;
  const columns = [
    ...spec.columns.map((c) => `t."${c.name}"`),
    ...extra.select,
  ].join(', ');
  const order = spec.orderBy.map((c) => `t."${c}"`).join(', ');
  const from = extra.from === '' ? `${self} t` : `${self} t ${extra.from}`;
  const digest = new RowDigest(spec.columns);
  const names = [
    ...spec.columns.map((c) => c.name),
    ...extra.select.map((e) => e.slice(e.lastIndexOf(' ') + 1)),
  ];
  // One streaming pass. Paging with LIMIT/OFFSET would re-scan and re-sort
  // the file for every page, which on a 14M-row table (and, for tags, a
  // join) is quadratic.
  const stream = await duck.stream(
    `SELECT ${columns} FROM ${from} ORDER BY ${order}`,
  );
  let read = 0;
  let batch: unknown[][] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const sending = batch;
    batch = [];
    await onBatch(sending);
  };
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
