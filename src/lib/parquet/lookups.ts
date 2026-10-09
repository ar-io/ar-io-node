/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Lookup files: Parquet files derived from a dataset's tables and sorted by a
 * key, so a reader finds one transaction, one wallet or one tag value without
 * scanning the tables.
 *
 * Parquet keeps a min and max per row group. In a file sorted by its key those
 * ranges do not overlap, so a reader holding a key reads the footer, then
 * only the one or two row groups whose range can hold it. Over HTTP in
 * verified 256 KiB pieces, finding a transaction in a 100,000-block
 * `parquet-l1` band costs 0.8 MB this way against 88 MB scanning its ids.
 *
 * This module is the engine, and knows no dataset: a dataset declares its
 * lookups as {@link LookupSpec}s next to its tables, and this writes, digests
 * and verifies them. Keys are built with the encodings in `keys.ts`.
 */
import * as path from 'node:path';
import type { Database } from 'duckdb-async';

import type { ColumnSpec } from './check.js';
import { RowDigest } from './digest.js';

/** Rows per row group: the measured best for point lookups in 256 KiB pieces. */
export const LOOKUP_ROW_GROUP_SIZE = 16_384;

/** Table name to the Parquet files holding it: one band's, or many. */
export type TableFiles = Record<string, string[]>;

export interface LookupSpec {
  /** The lookup's name in a band's description, e.g. `tx_id`. */
  name: string;
  /** Its file, beside the tables, e.g. `lookup_tx_id.parquet`. */
  file: string;
  /** Its columns, in order, with the types DuckDB reads them as. */
  columns: ColumnSpec[];
  /**
   * The order rows are written and digested in. Total over the columns, up to
   * identical rows, so one set of rows has one digest.
   */
  orderBy: string[];
  /**
   * SQL giving the lookup's rows, with exactly {@link columns}, from the
   * tables' files. It takes lists so the same spec can be derived over one
   * band or over every band of a dataset.
   */
  derive: (tables: TableFiles) => string;
}

/** What a band's description says of one lookup, as of a table. */
export interface LookupDescription {
  rows: number;
  rowDigest: string;
}

/** A path as a SQL string literal. */
export const sqlPath = (file: string) => `'${file.replace(/'/g, "''")}'`;

/** A list of paths as a SQL list of string literals, for `read_parquet`. */
export const sqlPaths = (files: string[]) =>
  `[${files.map(sqlPath).join(', ')}]`;

/**
 * Reads a column for digesting. A 64-bit unsigned or decimal value can
 * exceed what a JavaScript number holds, so it is read as its decimal text,
 * which the digest encodes the same way.
 */
const selectColumn = (column: ColumnSpec) =>
  column.type.startsWith('DECIMAL') || column.type === 'UBIGINT'
    ? `CAST("${column.name}" AS VARCHAR) AS "${column.name}"`
    : `"${column.name}"`;

/**
 * Writes one lookup into `dir` from the tables' files, and returns its
 * description. Only the lookup's own file is written; placing it in a band
 * (and when) is the caller's.
 */
export async function writeLookup(
  duck: Database,
  spec: LookupSpec,
  tables: TableFiles,
  dir: string,
): Promise<LookupDescription> {
  const file = path.join(dir, spec.file);
  const columns = spec.columns.map((c) => `"${c.name}"`).join(', ');
  const order = spec.orderBy.map((c) => `"${c}"`).join(', ');
  await duck.exec(
    `COPY (SELECT ${columns} FROM (${spec.derive(tables)}) ORDER BY ${order}) TO ${sqlPath(file)} (FORMAT PARQUET, COMPRESSION 'zstd', ROW_GROUP_SIZE ${LOOKUP_ROW_GROUP_SIZE})`,
  );
  return digestLookup(duck, spec, file);
}

/**
 * The row count and row digest of a lookup file, its rows read in the spec's
 * order. The same digest a band's tables use, so it does not depend on the
 * Parquet bytes, and two publishers holding the same rows agree on it.
 */
export async function digestLookup(
  duck: Database,
  spec: LookupSpec,
  file: string,
): Promise<LookupDescription> {
  const digest = new RowDigest(spec.columns);
  const names = spec.columns.map((c) => c.name);
  const stream = await duck.stream(
    `SELECT ${spec.columns.map(selectColumn).join(', ')} FROM read_parquet(${sqlPath(file)}) ORDER BY ${spec.orderBy.map((c) => `"${c}"`).join(', ')}`,
  );
  for await (const row of stream) {
    digest.add(names.map((n) => (row as Record<string, unknown>)[n]));
  }
  return { rows: digest.rows, rowDigest: digest.hex() };
}

/**
 * Checks a lookup file against what it should be.
 *
 * 1. Its rows reproduce `declared`, the description its band carries: the
 *    band is honest about the file.
 * 2. It holds exactly the rows its spec derives from the tables, no more and
 *    no fewer: the file is honest about the tables. Row by row, not by bytes,
 *    so a file another DuckDB version wrote passes when its rows agree.
 *
 * @returns what is wrong, empty when it matches.
 */
export async function verifyLookup(
  duck: Database,
  spec: LookupSpec,
  file: string,
  tables: TableFiles,
  declared: LookupDescription,
): Promise<string[]> {
  // A file that can't be read is a failed check of that file, not an error
  // that ends the verification: the caller reports every band.
  try {
    const problems: string[] = [];
    const found = await digestLookup(duck, spec, file);
    if (
      found.rows !== declared.rows ||
      found.rowDigest !== declared.rowDigest
    ) {
      problems.push(
        `${spec.file}: holds ${found.rows} rows with digest ${found.rowDigest}, its band says ${declared.rows} rows with digest ${declared.rowDigest}`,
      );
    }
    const columns = spec.columns.map((c) => `"${c.name}"`).join(', ');
    const have = `SELECT ${columns} FROM read_parquet(${sqlPath(file)})`;
    const want = `SELECT ${columns} FROM (${spec.derive(tables)})`;
    const [diff] = (await duck.all(
      `SELECT
         (SELECT count(*) FROM (${have} EXCEPT ALL ${want})) AS extra,
         (SELECT count(*) FROM (${want} EXCEPT ALL ${have})) AS missing`,
    )) as Array<{ extra: bigint | number; missing: bigint | number }>;
    const extra = Number(diff.extra);
    const missing = Number(diff.missing);
    if (extra > 0 || missing > 0) {
      problems.push(
        `${spec.file}: ${extra} rows that its tables do not give, and ${missing} of theirs missing`,
      );
    }
    return problems;
  } catch (error) {
    return [
      `${spec.file}: could not be read (${error instanceof Error ? error.message : String(error)})`,
    ];
  }
}
