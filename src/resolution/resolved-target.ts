/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { isValidDataId } from '../lib/validation.js';
import { isValidCid } from '../lib/ipfs-cid.js';

export type ResolvedProtocol = 'arweave' | 'ipfs';

/**
 * Classify (and validate) an ANT record's resolved target.
 *
 * ANT records carry a `targetProtocol` field (`0` = Arweave, `1` = IPFS;
 * absent on older ANTs, which default to Arweave). The target id is an Arweave
 * TX / data-item ID for Arweave records and an IPFS CID for IPFS records, so the
 * id is validated against the format implied by `targetProtocol`:
 *
 * - `targetProtocol === 1` -> `ipfs`; the id must be a valid CID.
 * - anything else          -> `arweave`; the id must be a valid 43-char id.
 *
 * Returns the resolved protocol, or throws if the id does not match the format
 * for that protocol (the caller treats a throw as "name did not resolve").
 *
 * Kept as a pure function (no SDK / network / config) so it is unit-testable in
 * isolation and shared by any resolver that reads ANT records.
 */
export function classifyResolvedTarget(
  resolvedId: string,
  targetProtocol: number | undefined,
): ResolvedProtocol {
  const protocol: ResolvedProtocol = targetProtocol === 1 ? 'ipfs' : 'arweave';

  if (protocol === 'ipfs') {
    if (!isValidCid(resolvedId)) {
      throw new Error('Invalid resolved IPFS CID');
    }
  } else if (!isValidDataId(resolvedId)) {
    throw new Error('Invalid resolved data ID');
  }

  return protocol;
}
