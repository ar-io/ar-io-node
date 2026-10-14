/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * A table's order (`orderByClause`) and row identity in JavaScript, so the
 * exporter can sort and deduplicate a window's rows itself and write each
 * table in its order without a sort of the whole band.
 *
 * The comparison is DuckDB's for the layout's types: integers by value,
 * BLOBs byte by byte (unsigned, a prefix first), nulls last. A band is read
 * back and every row checked against the one before it, so a disagreement
 * would refuse the band, never publish one out of order.
 */
import type { TableSpec } from '../../../lib/parquet-l1/layout.js';

type Value = unknown;

const isNull = (value: Value) => value === null || value === undefined;

function compareValues(a: Value, b: Value): number {
  if (isNull(a)) return isNull(b) ? 0 : 1;
  if (isNull(b)) return -1;
  if (a instanceof Uint8Array) {
    return Buffer.compare(a, b as Uint8Array);
  }
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    const x = BigInt(a as number | bigint);
    const y = BigInt(b as number | bigint);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const x = a as number;
  const y = b as number;
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Compares two rows of a table (values in its column order) by its
 * `orderBy` columns, ascending, nulls last.
 */
export function rowComparator(
  spec: TableSpec,
): (a: Value[], b: Value[]) => number {
  const at = spec.orderBy.map((name) => {
    const index = spec.columns.findIndex((c) => c.name === name);
    if (index < 0) throw new Error(`${spec.name} has no column ${name}`);
    return index;
  });
  return (a, b) => {
    for (const i of at) {
      const order = compareValues(a[i], b[i]);
      if (order !== 0) return order;
    }
    return 0;
  };
}

/**
 * A row's identity as a string, its values encoded as a row digest encodes
 * them (null apart from every value, a length before each), so two rows
 * share it exactly when they hold the same values.
 */
export function rowIdentity(values: Value[]): string {
  const parts: string[] = [];
  for (const value of values) {
    if (isNull(value)) {
      parts.push('\u0000');
      continue;
    }
    const text =
      Buffer.isBuffer(value) || value instanceof Uint8Array
        ? `b${Buffer.from(value as Uint8Array).toString('latin1')}`
        : typeof value === 'string'
          ? `s${value}`
          : typeof value === 'boolean'
            ? `t${value ? 1 : 0}`
            : `n${String(value)}`;
    parts.push(`${text.length}:${text}`);
  }
  return parts.join('|');
}
