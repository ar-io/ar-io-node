/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Checks of a signature or an owner key against what it must hash to, before
 * either is served or cached.
 *
 * Both values are read from bytes at stored offsets, and a wrong offset reads
 * other bytes of the same size. Nothing else would notice: GraphQL serves
 * them, and the owner cache, keyed by owner address and shared by every item
 * of that owner, would serve them for all of them. Each check is exact, so it
 * never turns a right value away:
 *
 * - a transaction's or data item's id is the SHA-256 of its signature
 *   (Arweave and ANS-104 alike);
 * - an owner address is the SHA-256 of the owner key, as the gateway stores
 *   it for transactions (`ownerToAddress`) and data items (`ans-104.ts`).
 */
import { fromB64Url, sha256B64Url } from './encoding.js';

/** Whether `signature` (base64url) is the signature `id` was made from. */
export function signatureMatchesId(signature: string, id: string): boolean {
  return sha256B64Url(fromB64Url(signature)) === id;
}

/** Whether `owner` (base64url key) is the key `address` was made from. */
export function ownerMatchesAddress(owner: string, address: string): boolean {
  return sha256B64Url(fromB64Url(owner)) === address;
}
