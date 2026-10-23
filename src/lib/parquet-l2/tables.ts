/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Reading an `l2-1` band's tables back as a reader must: every row in its
 * table's order, digested as the band describes it. Shared by the exporter,
 * which checks what it wrote, and by `index-l2-verify`, which checks what it
 * was given.
 */
import crypto from 'node:crypto';
import * as path from 'node:path';
import type { Database } from 'duckdb-async';

import { toB64Url } from '../encoding.js';
import { RowDigest } from '../parquet/digest.js';
import {
  type DuckRunner,
  parquetRangeRows,
  scanDigest,
} from '../parquet/scan-digest.js';
import type { TableSpec } from '../parquet-l1/layout.js';
import { orderByClause } from './layout.js';
import { rowComparator } from './order.js';

/**
 * A table that doesn't read as its layout requires: rows out of order or of
 * one key (`order`), or an owner's key that doesn't hash to its address
 * (`wallet_hash`). `details` names the offending ids, a few at most.
 */
export class L2TableError extends Error {
  constructor(
    readonly reason: 'order' | 'wallet_hash',
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
  }
}

const sqlString = (value: string) => `'${value.replace(/'/g, "''")}'`;

/**
 * Reads a band's table and digests it: in its order, every row after the one
 * before it, each `wallets` key checked against its address. `inFileOrder`
 * reads the rows as the file holds them, with no sort, so memory stays flat
 * however large the table; the order check then also proves the file was
 * written in its table's order, as `l2-1` requires.
 *
 * @throws L2TableError when the rows are out of order or a key is wrong.
 */
export async function digestL2Table(
  duck: Database,
  bandDir: string,
  spec: TableSpec,
  {
    inFileOrder = false,
    run,
  }: {
    inFileOrder?: boolean;
    /**
     * Where to read, in file order, instead of `duck` (which is then not
     * used): its ranges are read side by side on the runner's databases,
     * each of which must keep insertion order.
     */
    run?: DuckRunner;
  } = {},
): Promise<{ rows: number; rowDigest: string }> {
  if (run !== undefined && inFileOrder) {
    if (spec.name !== 'wallets') {
      try {
        return await scanL2Table(duck, bandDir, spec, undefined, run);
      } catch (error) {
        if (error instanceof L2TableError) throw error;
      }
    }
    return run((d) => readL2Table(d, bandDir, spec, { inFileOrder }));
  }
  // File order is only what DuckDB returns while it keeps insertion order.
  if (inFileOrder) await duck.exec('SET preserve_insertion_order = true');
  // In file order, every table but `wallets` (whose keys are hashed here,
  // and which is small) is digested in DuckDB: the same digest and the
  // same order check, many times faster. Where that reader can't be used
  // (a type it doesn't encode, any error), the rows are read one by one,
  // so what is reported is what the row reader reports.
  if (inFileOrder && spec.name !== 'wallets') {
    try {
      return await scanL2Table(duck, bandDir, spec);
    } catch (error) {
      if (error instanceof L2TableError) throw error;
    }
  }
  return readL2Table(duck, bandDir, spec, { inFileOrder });
}

/** {@link digestL2Table} in file order, in DuckDB ({@link scanDigest}). */
export async function scanL2Table(
  duck: Database,
  bandDir: string,
  spec: TableSpec,
  /** Rows per range (default: from the file's footer); for tests. */
  rangeRows?: number,
  /** Where to read instead of `duck`, side by side. */
  run?: DuckRunner,
): Promise<{ rows: number; rowDigest: string }> {
  const file = sqlString(path.join(bandDir, spec.file));
  const compare = rowComparator(spec);
  const result = await scanDigest(
    duck,
    {
      relation: `read_parquet(${file}, file_row_number = true)`,
      position: 'file_row_number',
      rangeRows:
        rangeRows ??
        (await (run ?? ((task) => task(duck)))((d) =>
          parquetRangeRows(d, file, spec.columns.length),
        )),
    },
    spec.columns,
    {
      by: spec.orderBy,
      rule: 'strict',
      violates: (prev, cur) => {
        const order = compare(prev, cur);
        return order >= 0 ? order : undefined;
      },
    },
    run !== undefined ? { run } : {},
  );
  if ('outOfOrder' in result) throw outOfOrder(spec);
  return result;
}

const outOfOrder = (spec: TableSpec) =>
  new L2TableError(
    'order',
    `${spec.file} holds two rows out of order or of one key`,
  );

/**
 * {@link digestL2Table} a row at a time in JavaScript: the reader the
 * DuckDB one ({@link scanL2Table}) must agree with, and the one used where
 * it can't be.
 */
export async function readL2Table(
  duck: Database,
  bandDir: string,
  spec: TableSpec,
  { inFileOrder = false }: { inFileOrder?: boolean } = {},
): Promise<{ rows: number; rowDigest: string }> {
  const file = sqlString(path.join(bandDir, spec.file));
  const digest = new RowDigest(spec.columns);
  const names = spec.columns.map((c) => c.name);
  const compare = rowComparator(spec);
  let previous: unknown[] | undefined;
  const columns = spec.columns.map((c) => `"${c.name}"`).join(', ');
  if (inFileOrder) await duck.exec('SET preserve_insertion_order = true');
  const stream = await duck.stream(
    `SELECT ${columns} FROM read_parquet(${file})${inFileOrder ? '' : ` ORDER BY ${orderByClause(spec)}`}`,
  );
  for await (const row of stream) {
    const values = names.map((n) => (row as Record<string, unknown>)[n]);
    if (previous !== undefined && compare(previous, values) >= 0) {
      throw outOfOrder(spec);
    }
    if (spec.name === 'wallets') {
      const [address, key] = values as [Buffer, Buffer];
      if (
        !crypto
          .createHash('sha256')
          .update(Buffer.from(key))
          .digest()
          .equals(Buffer.from(address))
      ) {
        throw new L2TableError(
          'wallet_hash',
          "an owner's key doesn't hash to its address",
          [toB64Url(Buffer.from(address))],
        );
      }
    }
    digest.add(values);
    previous = values;
  }
  return { rows: digest.rows, rowDigest: digest.hex() };
}
