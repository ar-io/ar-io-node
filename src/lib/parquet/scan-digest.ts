/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The row digest ({@link RowDigest}) of a Parquet file or a table, taken in
 * DuckDB rather than row by row in JavaScript: the same bytes, hashed in the
 * same order, at many times the speed.
 *
 * Read one row at a time, a band's tables cost a JavaScript object per row
 * and a Buffer or BigInt per value: about 84,000 rows a second, two hours
 * for the 518M tag rows of the largest `ardrive-l2` band. Here DuckDB
 * encodes each row as {@link RowDigest} does (`0x00` for null; otherwise
 * `0x01`, a 4-byte big-endian length and the bytes), joins the rows of a
 * range of positions in their order, and hands over one Buffer a range,
 * which is hashed as it arrives; one range is read while the one before is
 * hashed.
 *
 * Each row is also checked against the one before it, as the readers it
 * replaces check them: within a range in SQL (nulls last, BLOBs byte by
 * byte, a prefix first, integers by value, which is DuckDB's order and
 * {@link rowComparator}'s), and across ranges by the caller's own
 * comparison of the last row of one range and the first of the next. The
 * first row out of order is reported, with its position.
 *
 * Only what can be encoded exactly is taken: columns of BLOB, VARCHAR,
 * BOOLEAN and integer types, read as the types they are declared, ordered
 * by BLOB and integer columns. Anything else, or any error, is
 * {@link ScanDigestUnavailable} or the error itself; a caller then reads the
 * rows the old way, so what it reports does not depend on which reader ran.
 */
import crypto from 'node:crypto';
import type { Database } from 'duckdb-async';

import type { ColumnSpec } from './check.js';

/** What this reader needs of a DuckDB handle. */
export type ScanDuck = Pick<Database, 'all' | 'stream'>;

/**
 * Runs a task on a DuckDB database of the runner's choosing (one of a
 * pool, each running one task at a time), and gives back its result: how a
 * caller lets reads run side by side. A task never waits on another task.
 */
export type DuckRunner = <T>(
  task: (duck: Database) => Promise<T>,
) => Promise<T>;

/** The scan can't be taken here; read the rows the old way. */
export class ScanDigestUnavailable extends Error {}

/**
 * Whether a DuckDB error is a read running out of its spill share
 * (`max_temp_directory_size`). A pool runner runs such a read again with
 * the whole budget, so nothing may catch it on the way and retry under the
 * same share.
 */
export function outOfSpill(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /max_temp_directory_size/.test(message);
}

/**
 * Integers the Node binding hands over exactly (a number or a BigInt), so
 * the row reader encodes their digits. Not HUGEINT: a large one comes back
 * as an inexact number, which the row reader refuses.
 */
const INTEGER_TYPES = new Set([
  'TINYINT',
  'SMALLINT',
  'INTEGER',
  'BIGINT',
  'UTINYINT',
  'USMALLINT',
  'UINTEGER',
  'UBIGINT',
]);

/**
 * A whole-number decimal (`DECIMAL(p,0)`), such as an L1 band's quantity
 * and reward: DuckDB casts it to its digits with no point, which is what
 * {@link RowDigest} writes for the decimal text a reader hands it.
 */
const WHOLE_DECIMAL = /^DECIMAL\(\d{1,2},0\)$/;

const encodable = (type: string) =>
  type === 'BLOB' ||
  type === 'VARCHAR' ||
  type === 'BOOLEAN' ||
  INTEGER_TYPES.has(type) ||
  WHOLE_DECIMAL.test(type);

/** Types whose order DuckDB and the JavaScript comparisons agree on. */
const orderable = (type: string) => type === 'BLOB' || INTEGER_TYPES.has(type);

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** A 4-byte big-endian length as 8 hex digits. */
const length8 = (expr: string) => `lpad(hex(${expr}), 8, '0')`;

/** One value as {@link RowDigest} encodes it, in hex. */
function encodeSql(column: ColumnSpec): string {
  const c = ident(column.name);
  let value: string;
  if (column.type === 'BLOB') {
    value = `'01' || ${length8(`octet_length(${c})`)} || hex(${c})`;
  } else if (column.type === 'VARCHAR') {
    // hex() of a VARCHAR is its UTF-8 bytes; strlen() counts them.
    value = `'01' || ${length8(`strlen(${c})`)} || hex(${c})`;
  } else if (column.type === 'BOOLEAN') {
    value = `CASE WHEN ${c} THEN '010000000131' ELSE '010000000130' END`;
  } else {
    // An integer (or a whole-number decimal) as its decimal digits, as
    // RowDigest writes a number, bigint or decimal text: CAST gives the
    // canonical form (no sign for 0, no padding, no point).
    const text = `CAST(${c} AS VARCHAR)`;
    value = `'01' || ${length8(`length(${text})`)} || hex(${text})`;
  }
  return `CASE WHEN ${c} IS NULL THEN '00' ELSE ${value} END`;
}

/** The order of `prev` against `cur` in one column: -1, 0 or 1, nulls last. */
function compareSql(column: string): string {
  const c = ident(column);
  const p = ident(`__p_${column}`);
  return `CASE WHEN ${p} IS NULL AND ${c} IS NULL THEN 0 WHEN ${p} IS NULL THEN 1 WHEN ${c} IS NULL THEN -1 WHEN ${p} < ${c} THEN -1 WHEN ${p} > ${c} THEN 1 ELSE 0 END`;
}

/** The order of the row before against this one, by `by`, lexicographic. */
function rowCompareSql(by: string[]): string {
  // The first column's order that is not a tie, else a tie.
  return `coalesce(${by.map((column) => `nullif(${compareSql(column)}, 0)`).join(', ')}, 0)`;
}

export interface ScanOrder {
  /** The columns rows are ordered by. */
  by: string[];
  /**
   * Which rows are out of order, given the order of the row before against
   * this one (`cmp`): `strict`, a row not after the one before (`cmp >= 0`);
   * `identical-ties`, a row before it, or tied with it and not the same row
   * (`cmp > 0`, or `cmp = 0` and a value differs); `sorted`, a row before
   * it (`cmp > 0`).
   */
  rule: 'strict' | 'identical-ties' | 'sorted';
  /**
   * The same rule in JavaScript, for the last row of one range and the
   * first of the next (values in column order, as DuckDB returns them):
   * the order of `prev` against `cur` when `cur` is out of order, else
   * undefined.
   */
  violates: (prev: unknown[], cur: unknown[]) => number | undefined;
}

export interface ScanSource {
  /**
   * A relation with a `position` column numbering its rows from 0 in the
   * order they are digested in, with no gaps, and a filter on it that
   * DuckDB can push down: `read_parquet(..., file_row_number = true)`, or a
   * table's `rowid`.
   */
  relation: string;
  position: string;
  /** Rows per range (default: from the file's footer, else 245,760). */
  rangeRows?: number;
}

export type ScanResult =
  | { rows: number; rowDigest: string }
  | {
      /** The first row out of order, from 0, and the order of the one before against it. */
      outOfOrder: { row: number; cmp: number };
    };

/** About this many encoded bytes are hashed a range. */
const RANGE_BYTES = 48 * 1024 * 1024;
const MIN_RANGE_ROWS = 16_384;
const MAX_RANGE_ROWS = 1_048_576;
const DEFAULT_RANGE_ROWS = 245_760;

/** Rows a range of a Parquet file holds, so that one range is about {@link RANGE_BYTES}. */
export async function parquetRangeRows(
  duck: ScanDuck,
  fileSql: string,
  columns: number,
): Promise<number> {
  const [row] = (await duck.all(
    `SELECT sum(total_uncompressed_size) AS bytes, (SELECT sum(row_group_num_rows) FROM (SELECT DISTINCT row_group_id, row_group_num_rows FROM parquet_metadata(${fileSql}))) AS rows FROM parquet_metadata(${fileSql})`,
  )) as Array<{ bytes: unknown; rows: unknown }>;
  const rows = Number(row?.rows ?? 0);
  const bytes = Number(row?.bytes ?? 0);
  if (!(rows > 0) || !(bytes > 0)) return DEFAULT_RANGE_ROWS;
  // Hex in DuckDB is twice the bytes; each value adds its 5-byte prefix.
  const perRow = bytes / rows + 5 * columns;
  const fit =
    Math.floor(RANGE_BYTES / perRow / MIN_RANGE_ROWS) * MIN_RANGE_ROWS;
  return Math.min(MAX_RANGE_ROWS, Math.max(MIN_RANGE_ROWS, fit));
}

/**
 * The columns' types as DuckDB reads them from `relation`, checked against
 * the declared ones: a value read as another type than declared is encoded
 * differently, so such a relation is left to the old reader.
 *
 * @throws ScanDigestUnavailable when a type differs or can't be encoded.
 */
async function requireTypes(
  duck: ScanDuck,
  relation: string,
  columns: ColumnSpec[],
  order: ScanOrder | undefined,
): Promise<void> {
  const described = (await duck.all(
    `DESCRIBE SELECT ${columns.map((c) => ident(c.name)).join(', ')} FROM ${relation}`,
  )) as Array<{ column_name: string; column_type: string }>;
  if (described.length !== columns.length) {
    throw new ScanDigestUnavailable('columns differ');
  }
  columns.forEach((c, i) => {
    const found = described[i];
    if (
      found.column_name !== c.name ||
      found.column_type !== c.type ||
      !encodable(c.type)
    ) {
      throw new ScanDigestUnavailable(`${c.name}: ${found.column_type}`);
    }
  });
  for (const name of order?.by ?? []) {
    const column = columns.find((c) => c.name === name);
    if (column === undefined || !orderable(column.type)) {
      throw new ScanDigestUnavailable(`can't order by ${name}`);
    }
  }
}

/**
 * Digests `columns` of `source` in its positions' order, each row checked
 * against the one before by `order` when given.
 *
 * @throws ScanDigestUnavailable when the relation's types aren't the ones
 *   declared, or can't be encoded here; any DuckDB error as it is.
 */
export async function scanDigest(
  duck: ScanDuck,
  source: ScanSource,
  columns: ColumnSpec[],
  order?: ScanOrder,
  {
    run,
    lookahead = 4,
  }: {
    /**
     * Where each query runs instead of `duck` (which is then not used):
     * given one, `lookahead` ranges are read side by side, and hashed in
     * their order as they arrive.
     */
    run?: DuckRunner;
    lookahead?: number;
  } = {},
): Promise<ScanResult> {
  const on = <T>(task: (d: ScanDuck) => Promise<T>): Promise<T> =>
    run !== undefined ? run(task) : task(duck);
  await on((d) => requireTypes(d, source.relation, columns, order));
  const rangeRows = source.rangeRows ?? DEFAULT_RANGE_ROWS;
  const names = columns.map((c) => ident(c.name)).join(', ');
  const row = columns.map(encodeSql).join(' || ');
  const pos = ident(source.position);
  // Lags of every column a rule compares: the order columns, and all of
  // them where a tie must be the same row.
  const lagged =
    order === undefined
      ? []
      : order.rule === 'identical-ties'
        ? columns.map((c) => c.name)
        : order.by;
  const lags = lagged
    .map((c) => `lag(${ident(c)}) OVER (ORDER BY __rn) AS ${ident(`__p_${c}`)}`)
    .join(', ');
  const cmp = order === undefined ? '0' : rowCompareSql(order.by);
  const same = lagged
    .map((c) => `${ident(c)} IS NOT DISTINCT FROM ${ident(`__p_${c}`)}`)
    .join(' AND ');
  // Over `__cmp`, the row before's order against this row's.
  const bad =
    order === undefined
      ? 'false'
      : order.rule === 'strict'
        ? '__cmp >= 0'
        : order.rule === 'sorted'
          ? '__cmp > 0'
          : `(__cmp > 0 OR (__cmp = 0 AND NOT (${same})))`;
  const struct = `struct_pack(${columns.map((c, i) => `__c${i} := ${ident(c.name)}`).join(', ')})`;
  // Each range is a query of its own, streamed (its one row read), as the
  // row readers stream theirs.
  const streamed = (sql: string) =>
    on(async (d) => {
      const rows: Array<Record<string, unknown>> = [];
      for await (const r of await d.stream(sql)) {
        rows.push(r as Record<string, unknown>);
      }
      return rows;
    });
  const query = (from: number) =>
    streamed(`WITH r AS (
        SELECT ${pos} AS __rn, ${names} FROM ${source.relation}
        WHERE ${pos} >= ${from} AND ${pos} < ${from + rangeRows}),
      w AS (SELECT __rn, ${names}, ${row} AS __h${lags !== '' ? `, ${lags}` : ''} FROM r),
      c AS (SELECT *, ${cmp} AS __cmp FROM w)
      SELECT count(*) AS n,
        unhex(string_agg(__h, '' ORDER BY __rn)) AS bytes,
        min(__rn) FILTER (WHERE __rn > ${from} AND ${bad}) AS bad_row,
        arg_min(__cmp, __rn) FILTER (WHERE __rn > ${from} AND ${bad}) AS bad_cmp,
        arg_min(${struct}, __rn) AS first_row,
        arg_max(${struct}, __rn) AS last_row
      FROM c`);
  const values = (s: unknown) =>
    columns.map((_, i) => (s as Record<string, unknown>)[`__c${i}`]);

  const hash = crypto.createHash('sha256');
  let rows = 0;
  let previous: unknown[] | undefined;
  let from = 0;
  // Ranges asked for and not yet hashed, in order. On one database the
  // next is asked for only once the one before is read to its end (a
  // query started under a stream cuts it off, which the Node binding does
  // not survive), and is read while that one is hashed; through a runner,
  // each on a database of its own, `lookahead` at a time.
  const inFlight: Array<Promise<Array<Record<string, unknown>>>> = [];
  const ahead = run !== undefined ? Math.max(1, lookahead) : 1;
  // Ranges are asked for up to the rows the relation says it holds (one
  // range when it holds none), and past them only while every range read
  // comes back full: a short range is the end, however many were said.
  const [{ n: said }] = (await on((d) =>
    d.all(`SELECT count(*) AS n FROM ${source.relation}`),
  )) as Array<{ n: unknown }>;
  let horizon = Math.max(1, Math.ceil(Number(said) / rangeRows)) * rangeRows;
  let asked = 0;
  let ended = false;
  const fill = () => {
    while (!ended && inFlight.length < ahead && asked < horizon) {
      inFlight.push(query(asked));
      asked += rangeRows;
    }
  };
  fill();
  try {
    for (;;) {
      const [result] = await inFlight[0];
      inFlight.shift();
      const n = Number(result.n);
      const more = n === rangeRows;
      if (!more) ended = true;
      else if (from + rangeRows >= horizon) horizon += rangeRows;
      fill();
      if (n > 0) {
        // Positions are 0, 1, …: a range not starting at its first is a
        // relation that doesn't number its rows as this reader needs.
        const first = values(result.first_row);
        if (order !== undefined && previous !== undefined) {
          const against = order.violates(previous, first);
          if (against !== undefined) {
            return { outOfOrder: { row: from, cmp: against } };
          }
        }
        if (result.bad_row !== null && result.bad_row !== undefined) {
          return {
            outOfOrder: {
              row: Number(result.bad_row),
              cmp: Number(result.bad_cmp),
            },
          };
        }
        hash.update(result.bytes as Buffer);
        rows += n;
        previous = values(result.last_row);
      }
      if (!more) break;
      from += rangeRows;
    }
  } finally {
    // A range still being read when the scan stops is read to its end
    // first: another query on its database would cut the stream off.
    await Promise.all(inFlight.map((p) => p.catch(() => undefined)));
  }
  return { rows, rowDigest: hash.digest('hex') };
}
