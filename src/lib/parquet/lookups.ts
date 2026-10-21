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
import {
  type DuckRunner,
  parquetRangeRows,
  type ScanDuck,
  scanDigest,
  ScanDigestUnavailable,
} from './scan-digest.js';

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

/**
 * The order a lookup's rows are digested in. Rows are always written in the
 * spec's order, by value.
 *
 * - `numeric`: the spec's order by value, the file's own order, so a reader
 *   can digest a lookup as it reads it.
 * - `legacy-text`: the spec's order with every UBIGINT and DECIMAL column
 *   compared as its decimal text (`10` < `100` < `9`). How `l1-3` lookups
 *   were digested, kept so every published `l1-3` band still verifies: the
 *   digest query ordered by its own VARCHAR aliases of those columns.
 */
export type LookupDigestOrder = 'numeric' | 'legacy-text';

export interface LookupDigestOptions {
  order: LookupDigestOrder;
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
 * Whether a column is read as its decimal text for digesting: a 64-bit
 * unsigned or decimal value can exceed what a JavaScript number holds, and
 * the digest encodes the text the same way.
 */
const readAsText = (column: ColumnSpec) =>
  column.type.startsWith('DECIMAL') || column.type === 'UBIGINT';

/**
 * The digest query's name for a column. Under `numeric` a column read as
 * text gets a name of its own, so the ORDER BY sorts the column's values,
 * not the text: an alias of the column's own name would shadow it.
 */
const digestName = (column: ColumnSpec, order: LookupDigestOrder) =>
  order === 'numeric' && readAsText(column)
    ? `__v_${column.name}`
    : column.name;

const selectColumn = (column: ColumnSpec, order: LookupDigestOrder) =>
  readAsText(column)
    ? `CAST("${column.name}" AS VARCHAR) AS "${digestName(column, order)}"`
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
  options: LookupDigestOptions,
): Promise<LookupDescription> {
  const file = path.join(dir, spec.file);
  const columns = spec.columns.map((c) => `"${c.name}"`).join(', ');
  const order = spec.orderBy.map((c) => `"${c}"`).join(', ');
  await duck.exec(
    `COPY (SELECT ${columns} FROM (${spec.derive(tables)}) ORDER BY ${order}) TO ${sqlPath(file)} (FORMAT PARQUET, COMPRESSION 'zstd', ROW_GROUP_SIZE ${LOOKUP_ROW_GROUP_SIZE})`,
  );
  return digestLookup(duck, spec, file, options);
}

/**
 * The row count and row digest of a lookup file, its rows read in the spec's
 * order as `options.order` compares it. The same digest a band's tables
 * use, so it does not depend on the Parquet bytes, and two publishers
 * holding the same rows agree on it.
 */
export async function digestLookup(
  duck: Database,
  spec: LookupSpec,
  file: string,
  options: LookupDigestOptions,
): Promise<LookupDescription> {
  return digestRows(duck, spec, `read_parquet(${sqlPath(file)})`, options);
}

/**
 * The row count and row digest of the spec's columns of `from` (a table
 * expression), as {@link digestLookup} takes a file's. Streamed in the
 * spec's order: DuckDB sorts out of core, so memory stays bounded however
 * many rows there are.
 */
async function digestRows(
  duck: Database,
  spec: LookupSpec,
  from: string,
  options: LookupDigestOptions,
): Promise<LookupDescription> {
  if (options.order === 'numeric') {
    try {
      return await scanSortedRows(duck, spec, from);
    } catch {
      // Read the old way: what it reports is what is reported.
    }
  }
  return readRows(duck, spec, from, options);
}

let sortedTables = 0;

/**
 * {@link digestRows} under `numeric`, in DuckDB: the rows sorted into a
 * temporary table (DuckDB sorts out of core, so it spills as the streamed
 * sort did), then digested in its order by {@link scanDigest}, each row
 * checked to be in the spec's order.
 *
 * @throws ScanDigestUnavailable or a DuckDB error, when the rows must be
 *   read the old way.
 */
export async function scanSortedRows(
  duck: Database,
  spec: LookupSpec,
  from: string,
  /** Rows per range (default 245,760); for tests. */
  rangeRows?: number,
): Promise<LookupDescription> {
  const table = `__lookup_sorted_${process.pid}_${(sortedTables += 1)}`;
  const columns = spec.columns.map((c) => `"${c.name}"`).join(', ');
  await duck.exec(`SET preserve_insertion_order = true`);
  await duck.exec(
    `CREATE TEMP TABLE ${table} AS SELECT ${columns} FROM ${from} ORDER BY ${spec.orderBy.map((c) => `"${c}"`).join(', ')}`,
  );
  try {
    const keys = orderKeys(spec);
    const result = await scanDigest(
      duck,
      {
        relation: table,
        position: 'rowid',
        ...(rangeRows !== undefined ? { rangeRows } : {}),
      },
      spec.columns,
      {
        by: spec.orderBy,
        rule: 'sorted',
        violates: (prev, cur) => {
          const cmp = compareKeys(keys, prev, cur);
          return cmp > 0 ? cmp : undefined;
        },
      },
    );
    // Rows the sort left out of order: not a digest to trust.
    if ('outOfOrder' in result) throw new ScanDigestUnavailable('unsorted');
    return result;
  } finally {
    await duck.exec(`DROP TABLE IF EXISTS ${table}`);
  }
}

/** {@link digestRows} a row at a time in JavaScript. */
export async function readRows(
  duck: Database,
  spec: LookupSpec,
  from: string,
  { order }: LookupDigestOptions,
): Promise<LookupDescription> {
  const digest = new RowDigest(spec.columns);
  const names = spec.columns.map((c) => digestName(c, order));
  // Under `legacy-text` a column read as text is selected under its own
  // name, so ORDER BY names the text; under `numeric`, the column.
  const stream = await duck.stream(
    `SELECT ${spec.columns.map((c) => selectColumn(c, order)).join(', ')} FROM ${from} ORDER BY ${spec.orderBy.map((c) => `"${c}"`).join(', ')}`,
  );
  for await (const row of stream) {
    digest.add(names.map((n) => (row as Record<string, unknown>)[n]));
  }
  return { rows: digest.rows, rowDigest: digest.hex() };
}

/** A lookup file whose rows are not in its spec's order. */
export class LookupOrderError extends Error {}

/** Two values of one column as DuckDB orders them: numbers, text-read integers, bytes. */
function compareLookupValues(a: unknown, b: unknown, text: boolean): number {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull || bNull) return aNull === bNull ? 0 : aNull ? 1 : -1;
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return Buffer.compare(a, b);
  }
  if (text || typeof a === 'bigint' || typeof b === 'bigint') {
    // Columns read as text (UBIGINT, DECIMAL) compare as the integers they
    // write; a DECIMAL(n,0) has no fraction to lose.
    const x = BigInt(a as string | number | bigint);
    const y = BigInt(b as string | number | bigint);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const x = a as number;
  const y = b as number;
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * The row count and row digest of a lookup file read as the file holds its
 * rows, with no sort, each row checked against the one before: never before
 * it in the spec's order, and, where the order ties, the same row (the
 * order is total up to identical rows, so a tie that differs would make the
 * digest depend on how ties fell). Only for the `numeric` digest order,
 * which is the files' own; DuckDB keeps file order while
 * `preserve_insertion_order` is on.
 *
 * @throws LookupOrderError when a row is out of order.
 */
export async function digestLookupInFileOrder(
  duck: Database,
  spec: LookupSpec,
  file: string,
  {
    run,
  }: {
    /**
     * Where to read instead of `duck` (which is then not used): the file's
     * ranges are read side by side on the runner's databases.
     */
    run?: DuckRunner;
  } = {},
): Promise<LookupDescription> {
  // A connection whose configuration is locked can't be told; one that
  // doesn't keep file order can't have its rows read in it.
  const keepOrder = async (d: Database) => {
    const [setting] = (await d.all(
      "SELECT current_setting('preserve_insertion_order') AS kept",
    )) as Array<{ kept: unknown }>;
    if (String(setting?.kept) !== 'true') {
      await d.exec('SET preserve_insertion_order = true');
    }
  };
  if (run === undefined) await keepOrder(duck);
  // In DuckDB ({@link scanDigest}) where it can be; otherwise, or on any
  // error, a row at a time, so what is reported is that reader's.
  try {
    return await scanLookupInFileOrder(duck, spec, file, undefined, run);
  } catch (error) {
    if (error instanceof LookupOrderError) throw error;
  }
  if (run !== undefined) {
    return run(async (d) => {
      await keepOrder(d);
      return readLookupInFileOrder(d, spec, file);
    });
  }
  return readLookupInFileOrder(duck, spec, file);
}

/** A lookup's order columns: where they are, and whether read as text. */
type OrderKeys = Array<{ index: number; text: boolean }>;

function orderKeys(spec: LookupSpec): OrderKeys {
  return spec.orderBy.map((name) => {
    const index = spec.columns.findIndex((c) => c.name === name);
    if (index < 0) throw new Error(`${spec.name} has no column ${name}`);
    return { index, text: readAsText(spec.columns[index]) };
  });
}

/** The order of `previous` against `values` by a lookup's order columns. */
function compareKeys(
  keys: OrderKeys,
  previous: unknown[],
  values: unknown[],
): number {
  let cmp = 0;
  for (const { index, text } of keys) {
    cmp = compareLookupValues(previous[index], values[index], text);
    if (cmp !== 0) break;
  }
  return cmp;
}

/**
 * Whether a row may follow the one before in a lookup file: never before
 * it, and where they tie, the same row. The order of the one before
 * against it when not, else undefined.
 */
function lookupRowViolation(
  spec: LookupSpec,
  keys: OrderKeys,
  previous: unknown[],
  values: unknown[],
): number | undefined {
  const cmp = compareKeys(keys, previous, values);
  if (
    cmp > 0 ||
    (cmp === 0 &&
      values.some(
        (v, i) =>
          compareLookupValues(previous[i], v, readAsText(spec.columns[i])) !==
          0,
      ))
  ) {
    return cmp;
  }
  return undefined;
}

const lookupOrderError = (spec: LookupSpec, row: number, cmp: number) =>
  new LookupOrderError(
    `${spec.file}: row ${row} is ${cmp > 0 ? 'before the row ahead of it' : 'a different row of the same key as the one ahead of it'} in the lookup's order (${spec.orderBy.join(', ')})`,
  );

/**
 * {@link digestLookupInFileOrder} in DuckDB.
 *
 * @throws LookupOrderError when a row is out of order; ScanDigestUnavailable
 *   or a DuckDB error when the file must be read the old way.
 */
export async function scanLookupInFileOrder(
  duck: ScanDuck,
  spec: LookupSpec,
  file: string,
  /** Rows per range (default: from the file's footer); for tests. */
  rangeRows?: number,
  /** Where to read instead of `duck`, side by side. */
  run?: DuckRunner,
): Promise<LookupDescription> {
  const keys = orderKeys(spec);
  const result = await scanDigest(
    duck,
    {
      relation: `read_parquet(${sqlPath(file)}, file_row_number = true)`,
      position: 'file_row_number',
      rangeRows:
        rangeRows ??
        (await (run ?? ((task) => task(duck as Database)))((d) =>
          parquetRangeRows(d, sqlPath(file), spec.columns.length),
        )),
    },
    spec.columns,
    {
      by: spec.orderBy,
      rule: 'identical-ties',
      violates: (prev, cur) => lookupRowViolation(spec, keys, prev, cur),
    },
    run !== undefined ? { run } : {},
  );
  if ('outOfOrder' in result) {
    throw lookupOrderError(
      spec,
      result.outOfOrder.row + 1,
      result.outOfOrder.cmp,
    );
  }
  return result;
}

/**
 * {@link digestLookupInFileOrder} a row at a time in JavaScript: the
 * reader the DuckDB one must agree with. Expects the connection to keep
 * insertion order.
 */
export async function readLookupInFileOrder(
  duck: Database,
  spec: LookupSpec,
  file: string,
): Promise<LookupDescription> {
  const order: LookupDigestOrder = 'numeric';
  const digest = new RowDigest(spec.columns);
  const names = spec.columns.map((c) => digestName(c, order));
  const keys = orderKeys(spec);
  const stream = await duck.stream(
    `SELECT ${spec.columns.map((c) => selectColumn(c, order)).join(', ')} FROM read_parquet(${sqlPath(file)})`,
  );
  let previous: unknown[] | undefined;
  for await (const row of stream) {
    const values = names.map((n) => (row as Record<string, unknown>)[n]);
    if (previous !== undefined) {
      const cmp = lookupRowViolation(spec, keys, previous, values);
      if (cmp !== undefined) {
        throw lookupOrderError(spec, digest.rows + 1, cmp);
      }
    }
    digest.add(values);
    previous = values;
  }
  return { rows: digest.rows, rowDigest: digest.hex() };
}

/**
 * Checks a lookup file against what it should be.
 *
 * 1. Its rows reproduce `declared`, the description its band carries: the
 *    band is honest about the file. Under `numeric` they are read in the
 *    file's own order and must be in the spec's order
 *    ({@link digestLookupInFileOrder}).
 * 2. It holds exactly the rows its spec derives from the tables, no more and
 *    no fewer: the file is honest about the tables. Row by row, not by bytes,
 *    so a file another DuckDB version wrote passes when its rows agree. The
 *    derived rows are digested as the file's are, in the spec's order, which
 *    is total over the columns: the same rows give the same digest, and a
 *    set comparison (which DuckDB holds in memory, and which ran a 1.6M
 *    `parquet-l2` band out of it) is made only to say how they differ.
 *
 * @returns what is wrong, empty when it matches.
 */
export async function verifyLookup(
  duck: Database,
  spec: LookupSpec,
  file: string,
  tables: TableFiles,
  declared: LookupDescription,
  options: LookupDigestOptions,
  {
    run,
    runSorted = run,
  }: {
    run?: DuckRunner;
    /** Where the rows the tables give are sorted (default `run`). */
    runSorted?: DuckRunner;
  } = {},
): Promise<string[]> {
  // Given a runner, the file and the rows its tables give are read side by
  // side, each where the runner puts it; what is reported, and in what
  // order, is as if one were read after the other.
  const derive = () =>
    digestRows(duck, spec, `(${spec.derive(tables)})`, options);
  const early =
    runSorted !== undefined
      ? runSorted((other) =>
          digestRows(other, spec, `(${spec.derive(tables)})`, options),
        )
      : undefined;
  early?.catch(() => undefined);
  const inRunner = <T>(task: (d: Database) => Promise<T>) =>
    run !== undefined ? run(task) : task(duck);
  // A file that can't be read is a failed check of that file, not an error
  // that ends the verification: the caller reports every band.
  try {
    const problems: string[] = [];
    // Under `numeric` the file's own order is the digest's: it is read as
    // it is, each row checked against the one before, so a file out of its
    // order fails here (a reader's binary search over its row groups would
    // miss keys) and no sort of the file is needed.
    let found: LookupDescription;
    try {
      found =
        options.order === 'numeric'
          ? await digestLookupInFileOrder(
              duck,
              spec,
              file,
              run !== undefined ? { run } : {},
            )
          : await inRunner((d) => digestLookup(d, spec, file, options));
    } catch (error) {
      if (error instanceof LookupOrderError) return [error.message];
      throw error;
    }
    if (
      found.rows !== declared.rows ||
      found.rowDigest !== declared.rowDigest
    ) {
      problems.push(
        `${spec.file}: holds ${found.rows} rows with digest ${found.rowDigest}, its band says ${declared.rows} rows with digest ${declared.rowDigest}`,
      );
    }
    const derived = await (early ?? derive());
    if (derived.rows !== found.rows || derived.rowDigest !== found.rowDigest) {
      problems.push(
        await (runSorted ?? inRunner)((d) =>
          describeDifference(d, spec, file, tables),
        ),
      );
    }
    return problems;
  } catch (error) {
    return [
      `${spec.file}: could not be read (${error instanceof Error ? error.message : String(error)})`,
    ];
  } finally {
    // Nothing is left reading once the check is reported.
    await early?.catch(() => undefined);
  }
}

export type { DuckRunner };

/** How a lookup file's rows differ from its tables', once they are known to. */
async function describeDifference(
  duck: Database,
  spec: LookupSpec,
  file: string,
  tables: TableFiles,
): Promise<string> {
  const columns = spec.columns.map((c) => `"${c.name}"`).join(', ');
  const have = `SELECT ${columns} FROM read_parquet(${sqlPath(file)})`;
  const want = `SELECT ${columns} FROM (${spec.derive(tables)})`;
  try {
    const [diff] = (await duck.all(
      `SELECT
         (SELECT count(*) FROM (${have} EXCEPT ALL ${want})) AS extra,
         (SELECT count(*) FROM (${want} EXCEPT ALL ${have})) AS missing`,
    )) as Array<{ extra: bigint | number; missing: bigint | number }>;
    return `${spec.file}: ${Number(diff.extra)} rows that its tables do not give, and ${Number(diff.missing)} of theirs missing`;
  } catch (error) {
    return `${spec.file}: its rows are not the ones its tables give (counting the difference failed: ${error instanceof Error ? error.message : String(error)})`;
  }
}
