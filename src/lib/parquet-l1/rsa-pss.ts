/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * RSA-PSS verification exactly as Arweave verifies a transaction's
 * signature: a port of `rsa_pss:verify/4` and `rsa_pss:verify_legacy/4`
 * (`apps/arweave/src/rsa_pss.erl`, pinned in
 * `test/arweave-consensus-pin.ts`), SHA-256, public exponent 65537.
 *
 * It is not RFC 8017's EMSA-PSS-VERIFY, and OpenSSL's (`crypto.verify`)
 * is stricter: Arweave masks the bits of the first byte above the
 * modulus's bit length instead of requiring them to be zero, and takes
 * the salt to be whatever follows the `0x01` separator, of any length.
 * Real mined transactions rely on both (for example
 * `SnN5f1fBk3hD-_PSnFBFDze-kMBU-NFIKYWvrTEQWTo`, at 1,602,352), so a
 * stricter check would refute an honest index.
 *
 * `legacy` is `verify_legacy/4`, which `ar_wallet:verify_pre_fork_2_4`
 * used for every transaction of a block validated below the 2.4 fork: it
 * sizes the encoded message by `bits div 8` instead of rounding up.
 */
import crypto from 'node:crypto';

const PSS_TRAILER_FIELD = 0xbc;
const PUBLIC_EXPONENT = 65537n;

const toBigInt = (bytes: Buffer): bigint =>
  bytes.length === 0 ? 0n : BigInt(`0x${bytes.toString('hex')}`);

/** `binary:encode_unsigned`: the shortest big-endian bytes (one zero byte for 0). */
const toBytes = (n: bigint): Buffer => {
  const hex = n.toString(16);
  return Buffer.from(hex.length % 2 === 0 ? hex : `0${hex}`, 'hex');
};

const bitSize = (n: bigint): number => (n === 0n ? 0 : n.toString(2).length);
const byteSize = (n: bigint): number => Math.ceil(bitSize(n) / 8);

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if ((e & 1n) === 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

/** `mgf1/3` over SHA-256. */
function mgf1(seed: Buffer, length: number): Buffer {
  const parts: Buffer[] = [];
  let have = 0;
  for (let counter = 0; have < length; counter += 1) {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(counter);
    const block = crypto
      .createHash('sha256')
      .update(Buffer.concat([seed, c]))
      .digest();
    parts.push(block);
    have += block.length;
  }
  return Buffer.concat(parts).subarray(0, length);
}

/** `normalize_to_key_size/2`: masks the first byte to the bits below the modulus's top bit. */
function normalizeToKeySize(bits: number, data: Buffer): Buffer {
  if (data.length === 0) return data;
  const sh = (bits - 1) & 0x7;
  const mask = sh > 0 ? 0xff >> (8 - sh) : 0xff;
  const out = Buffer.from(data);
  out[0] &= mask;
  return out;
}

/** `pad_to_key_size/2`: left zero-padding up to `bytes`, never truncating. */
const padToKeySize = (bytes: number, data: Buffer): Buffer =>
  data.length < bytes
    ? Buffer.concat([Buffer.alloc(bytes - data.length), data])
    : data;

/**
 * Whether `signature` is an RSA-PSS (SHA-256) signature of `message` under
 * the RSA modulus `modulus`, by Arweave's rule. Never throws: anything
 * that would make Arweave's verification raise (and `ar_wallet:verify`
 * then return false) is false.
 */
export function arweaveRsaPssVerify(
  message: Buffer,
  signature: Buffer,
  modulus: Buffer,
  { legacy = false }: { legacy?: boolean } = {},
): boolean {
  const digest = crypto.createHash('sha256').update(message).digest();
  const digestLen = digest.length;
  const n = toBigInt(modulus);
  if (n === 0n) return false;
  const publicBitSize = bitSize(n);
  const privateByteSize = legacy
    ? Math.floor(publicBitSize / 8)
    : Math.floor((publicBitSize + 7) / 8);
  const publicByteSize = byteSize(n);
  if (publicByteSize < digestLen + 2) return false;
  if (publicByteSize !== signature.length) return false;
  const s = toBigInt(signature);
  if (s >= n) return false;
  const dbLen = privateByteSize - digestLen - 1;
  const em = padToKeySize(
    privateByteSize,
    toBytes(modPow(s, PUBLIC_EXPONENT, n)),
  );
  if (em[em.length - 1] !== PSS_TRAILER_FIELD) return false;
  if (em.length < digestLen + 1) return false;
  const maskedDB = em.subarray(0, em.length - digestLen - 1);
  const h = em.subarray(maskedDB.length, maskedDB.length + digestLen);
  if (dbLen < 0) return false;
  const dbMask = mgf1(h, dbLen);
  // crypto:exor raises on unequal lengths; ar_wallet:verify returns false.
  if (maskedDB.length !== dbMask.length) return false;
  const xored = Buffer.alloc(dbLen);
  for (let i = 0; i < dbLen; i += 1) xored[i] = maskedDB[i] ^ dbMask[i];
  const db = normalizeToKeySize(publicBitSize, xored);
  const pos = db.indexOf(1);
  if (pos < 0) return false;
  for (let i = 0; i < pos; i += 1) {
    if (db[i] !== 0) return false;
  }
  const salt = db.subarray(pos + 1);
  const other = crypto
    .createHash('sha256')
    .update(Buffer.concat([Buffer.alloc(8), digest, salt]))
    .digest();
  return other.equals(h);
}
