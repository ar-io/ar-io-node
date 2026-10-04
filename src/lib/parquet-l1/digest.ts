/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The row digest of a `parquet-l1` table: SHA-256 over its rows in the
 * table's order, each value encoded by its column's type in the layout, so it
 * doesn't depend on the Parquet bytes (which differ between DuckDB versions)
 * or on how a reader returns a value (a number, a bigint or a decimal
 * string). Two publishers holding the same rows have the same digests, and
 * an importer checks the rows it read against the band's.
 *
 * Each value: `0x00` for null; otherwise `0x01`, a 4-byte big-endian
 * length and the bytes: a BLOB as is, a VARCHAR as UTF-8, a number (integer or decimal) as
 * its decimal digits, a BOOLEAN as `1` or `0`.
 */
import crypto from 'node:crypto';

import type { ColumnSpec } from './layout.js';

type Encoder = (value: unknown) => Buffer;

function decimal(value: unknown): Buffer {
  if (typeof value === 'bigint') return Buffer.from(value.toString());
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`Not an exact integer: ${value}`);
    }
    return Buffer.from(String(value));
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    return Buffer.from(BigInt(value).toString());
  }
  throw new Error(`Not an integer: ${String(value)}`);
}

function encoderFor(type: string): Encoder {
  if (type === 'BLOB') {
    return (value) => {
      if (Buffer.isBuffer(value)) return value;
      if (value instanceof Uint8Array) return Buffer.from(value);
      throw new Error('Not bytes');
    };
  }
  if (type === 'VARCHAR') return (value) => Buffer.from(String(value), 'utf8');
  if (type === 'BOOLEAN') {
    return (value) =>
      Buffer.from(value === true || value === 1 || value === 1n ? '1' : '0');
  }
  return decimal;
}

export class RowDigest {
  private readonly hash = crypto.createHash('sha256');
  private readonly encoders: Encoder[];
  rows = 0;

  constructor(private readonly columns: ColumnSpec[]) {
    this.encoders = columns.map((column) => encoderFor(column.type));
  }

  /** Adds one row, its values in the layout's column order. */
  add(values: unknown[]): void {
    if (values.length !== this.encoders.length) {
      throw new Error(
        `A row has ${values.length} values, the table ${this.columns.length} columns`,
      );
    }
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      if (value === null || value === undefined) {
        this.hash.update(Buffer.from([0]));
        continue;
      }
      let bytes: Buffer;
      try {
        bytes = this.encoders[i](value);
      } catch (error) {
        throw new Error(
          `Column ${this.columns[i].name}: ${(error as Error).message}`,
        );
      }
      const length = Buffer.alloc(5);
      length[0] = 1;
      length.writeUInt32BE(bytes.length, 1);
      this.hash.update(length);
      this.hash.update(bytes);
    }
    this.rows += 1;
  }

  hex(): string {
    return this.hash.copy().digest('hex');
  }
}
