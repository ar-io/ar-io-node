/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { CID } from 'multiformats/cid';
import { base32 } from 'multiformats/bases/base32';
import { base58btc } from 'multiformats/bases/base58';

/**
 * Safely parse a CID string (v0 or v1). Returns null on invalid input.
 */
export function parseCid(cidString: string): CID | null {
  try {
    return CID.parse(cidString);
  } catch {
    return null;
  }
}

/**
 * Quick validation: attempts parse, returns boolean.
 */
export function isValidCid(cidString: string): boolean {
  return parseCid(cidString) !== null;
}

/**
 * Check if a CID is version 0 (starts with `Qm`, base58btc, dag-pb codec).
 */
export function isCidV0(cid: CID): boolean {
  return cid.version === 0;
}

/**
 * Convert any CID string to CIDv1 base32lower (DNS-safe).
 * Returns the base32lower string representation.
 * Throws if the input is not a valid CID.
 */
export function cidToV1Base32(cidString: string): string {
  const cid = CID.parse(cidString);
  if (cid.version === 0) {
    return cid.toV1().toString(base32);
  }
  return cid.toString(base32);
}

/**
 * Canonical string representation of a CID.
 * v0 → base58btc, v1 → base32lower.
 */
export function cidToString(cid: CID): string {
  if (cid.version === 0) {
    return cid.toString(base58btc);
  }
  return cid.toString(base32);
}

export { CID };
