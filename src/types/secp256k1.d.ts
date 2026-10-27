/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The part of `secp256k1` (a dependency) the L1 signature check uses, and
 * the index-export test fixture signs with.
 */
declare module 'secp256k1' {
  /** The public key a 64-byte compact signature and its recovery id give for a 32-byte digest. */
  export function ecdsaRecover(
    signature: Uint8Array,
    recid: number,
    message: Uint8Array,
    compressed?: boolean,
  ): Uint8Array;
  /** A 64-byte compact signature of a 32-byte digest, and its recovery id. */
  export function ecdsaSign(
    message: Uint8Array,
    privateKey: Uint8Array,
  ): { signature: Uint8Array; recid: number };
  const secp256k1: {
    ecdsaRecover: typeof ecdsaRecover;
    ecdsaSign: typeof ecdsaSign;
  };
  export default secp256k1;
}
