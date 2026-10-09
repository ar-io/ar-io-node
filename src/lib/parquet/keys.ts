/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The keys of a lookup file: unsigned 64-bit integers, so a reader can prune
 * a file sorted by them on its row groups' min and max. Readers prune on
 * integer statistics; on binary ones they measurably do not (a lookup keyed
 * by raw tag bytes read its whole file).
 *
 * Two encodings, each defined here once and written three ways: in plain
 * code ({@link prefix64}, {@link sha256_64}), in DuckDB SQL ({@link
 * prefix64Sql}, {@link sha256_64Sql}), and by any client that reads a lookup.
 * The test vectors in `keys.test.ts` pin all three to the same values.
 *
 * - `prefix64(bytes)`: the first 8 bytes, big-endian, zero-padded on the
 *   right when shorter. For values that are already uniform hashes:
 *   transaction ids, addresses.
 * - `sha256_64(bytes)`: `prefix64(SHA-256(bytes))`. For arbitrary values:
 *   tag names and values.
 *
 * A key is a pointer, never an answer: two values may share one, so a reader
 * confirms a match against the stored bytes or the table row it points to.
 */
import crypto from 'node:crypto';

/** The first 8 bytes of `bytes` as a big-endian unsigned integer (zero-padded when shorter). */
export function prefix64(bytes: Uint8Array): bigint {
  const head = Buffer.alloc(8);
  Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(8, bytes.length)).copy(
    head,
  );
  return head.readBigUInt64BE(0);
}

/** {@link prefix64} of the SHA-256 of `bytes`. */
export function sha256_64(bytes: Uint8Array): bigint {
  return prefix64(crypto.createHash('sha256').update(bytes).digest());
}

/**
 * {@link prefix64} in DuckDB SQL, for a `BLOB` expression. Padded on the
 * right like the code, for the few early transactions whose `target` is
 * shorter than 8 bytes.
 */
export const prefix64Sql = (blob: string) =>
  `(('0x' || rpad(left(hex(${blob}), 16), 16, '0'))::UBIGINT)`;

/** {@link sha256_64} in DuckDB SQL, for a `BLOB` expression. */
export const sha256_64Sql = (blob: string) =>
  `(('0x' || left(sha256(${blob}), 16))::UBIGINT)`;
