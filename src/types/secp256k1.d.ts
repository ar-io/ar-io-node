/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** The part of `secp256k1` (a dependency) the L1 signature check uses. */
declare module 'secp256k1' {
  /** The public key a 64-byte compact signature and its recovery id give for a 32-byte digest. */
  export function ecdsaRecover(
    signature: Uint8Array,
    recid: number,
    message: Uint8Array,
    compressed?: boolean,
  ): Uint8Array;
  const secp256k1: { ecdsaRecover: typeof ecdsaRecover };
  export default secp256k1;
}
