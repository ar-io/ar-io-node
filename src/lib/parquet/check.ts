/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Checks a Parquet file's footer and schema before anything relies on it:
 * the shared check for every Parquet band kind.
 *
 * The bytes arrive from a remote publisher (already matched to the digests it
 * signed), so the cheap structural checks run first in plain code: the
 * `PAR1` magic at both ends and a footer length that fits the file. Only then
 * does DuckDB read the footer, with a small memory limit and one thread, to
 * report the columns, their types and the row count. No row data is read.
 */
import * as fs from 'node:fs/promises';
import type { Database } from 'duckdb-async';

/** A column a Parquet file must have, as DuckDB reads it. */
export interface ColumnSpec {
  name: string;
  /** The column's type as DuckDB reads it from the Parquet file. */
  type: string;
}

const MAGIC = Buffer.from('PAR1');
/**
 * A footer longer than this is not a footer we will parse: DuckDB decodes
 * it in this process, so a publisher's file mustn't hand it much. A band's
 * real footers are tens of kilobytes (a few dozen row groups).
 */
export const MAX_FOOTER_BYTES = 2 * 1024 * 1024;

export interface ParquetFileReport {
  rows: number;
  columns: ColumnSpec[];
}

/**
 * Checks the magic bytes and footer length of a Parquet file.
 *
 * @throws with a message naming the file and what is wrong.
 */
export async function checkParquetStructure(file: string): Promise<void> {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (size < 12)
      throw new Error(`${file}: too short for Parquet (${size} bytes)`);
    const head = Buffer.alloc(4);
    await handle.read(head, 0, 4, 0);
    const tail = Buffer.alloc(8);
    await handle.read(tail, 0, 8, size - 8);
    if (!head.equals(MAGIC) || !tail.subarray(4).equals(MAGIC)) {
      throw new Error(`${file}: not a Parquet file (no PAR1 magic)`);
    }
    const footer = tail.readUInt32LE(0);
    if (footer === 0 || footer > size - 12 || footer > MAX_FOOTER_BYTES) {
      throw new Error(`${file}: footer length ${footer} doesn't fit the file`);
    }
  } finally {
    await handle.close();
  }
}

/**
 * A DuckDB connection for reading footers: small, single-threaded, local
 * only. DuckDB is a native module, loaded only here, so a process that never
 * checks a Parquet file (the sidecar, for CDB64 bands) never loads it.
 */
export async function openFooterReader(): Promise<Database> {
  const { Database } = await import('duckdb-async');
  const db = await Database.create(':memory:');
  await db.exec(
    "SET memory_limit = '256MB'; SET threads = 1; SET autoinstall_known_extensions = false; SET autoload_known_extensions = false; SET lock_configuration = true;",
  );
  return db;
}

const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

/**
 * Reads a Parquet file's columns (as DuckDB types) and row count from its
 * footer, after {@link checkParquetStructure}.
 */
export async function readParquetFooter(
  db: Database,
  file: string,
): Promise<ParquetFileReport> {
  await checkParquetStructure(file);
  const path = quote(file);
  const columns = (await db.all(
    `DESCRIBE SELECT * FROM read_parquet(${path})`,
  )) as Array<{ column_name: string; column_type: string }>;
  const [meta] = (await db.all(
    `SELECT num_rows FROM parquet_file_metadata(${path})`,
  )) as Array<{ num_rows: bigint | number }>;
  return {
    rows: Number(meta?.num_rows ?? 0),
    columns: columns.map((c) => ({ name: c.column_name, type: c.column_type })),
  };
}

/**
 * Checks a Parquet file holds exactly the expected columns, in order, with
 * the expected types, and `rows` rows when given.
 *
 * @throws with a message naming the file and the first difference.
 */
export async function checkParquetFile(
  db: Database,
  file: string,
  expected: { columns: ColumnSpec[]; rows?: number },
): Promise<void> {
  const report = await readParquetFooter(db, file);
  const have = report.columns.map((c) => `${c.name} ${c.type}`);
  const want = expected.columns.map((c) => `${c.name} ${c.type}`);
  if (have.length !== want.length || have.some((c, i) => c !== want[i])) {
    const at = have.findIndex((c, i) => c !== want[i]);
    throw new Error(
      `${file}: columns differ from the layout at ${at === -1 ? have.length : at}: have ${JSON.stringify(have[at] ?? null)}, want ${JSON.stringify(want[at] ?? null)}`,
    );
  }
  if (expected.rows !== undefined && report.rows !== expected.rows) {
    throw new Error(
      `${file}: holds ${report.rows} rows, its band says ${expected.rows}`,
    );
  }
}
