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
  { inFileOrder = false }: { inFileOrder?: boolean } = {},
): Promise<{ rows: number; rowDigest: string }> {
  const file = sqlString(path.join(bandDir, spec.file));
  const digest = new RowDigest(spec.columns);
  const names = spec.columns.map((c) => c.name);
  const compare = rowComparator(spec);
  let previous: unknown[] | undefined;
  const columns = spec.columns.map((c) => `"${c.name}"`).join(', ');
  // File order is only what DuckDB returns while it keeps insertion order.
  if (inFileOrder) await duck.exec('SET preserve_insertion_order = true');
  const stream = await duck.stream(
    `SELECT ${columns} FROM read_parquet(${file})${inFileOrder ? '' : ` ORDER BY ${orderByClause(spec)}`}`,
  );
  for await (const row of stream) {
    const values = names.map((n) => (row as Record<string, unknown>)[n]);
    if (previous !== undefined && compare(previous, values) >= 0) {
      throw new L2TableError(
        'order',
        `${spec.file} holds two rows out of order or of one key`,
      );
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
