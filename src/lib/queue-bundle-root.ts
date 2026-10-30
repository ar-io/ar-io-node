/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { DataItemRootIndex } from '../types.js';

/**
 * Where a bundle queued by ID sits, for the unbundler to record its items'
 * locations against:
 * - `l1`: an L1 transaction (or one no source can place), its own root.
 * - `nested`: a data item; its items' root is the L1 root, and their offsets
 *   start at the bundle's payload offset in it.
 * - `unresolved`: a data item whose root is known but not its offset, so its
 *   items cannot be given correct locations.
 */
export type QueuedBundleRoot =
  | { kind: 'l1' }
  | { kind: 'nested'; rootTxId: string; rootParentOffset: number }
  | { kind: 'unresolved'; rootTxId: string };

/**
 * Places a bundle queued by ID (`POST /ar-io/admin/queue-bundle`).
 *
 * The route used to queue every ID as its own root. For a bundle that is
 * itself a data item, the unbundler then recorded each of its items with the
 * bundle as root and offsets relative to the bundle: a location one level too
 * shallow, which serving later rejects because the "root" is not an L1
 * transaction (#959 item 5). Asking the root-TX index first gives nested
 * bundles their real root and offset.
 */
export async function resolveQueuedBundleRoot(
  id: string,
  rootTxIndex: DataItemRootIndex,
): Promise<QueuedBundleRoot> {
  let result;
  try {
    result = await rootTxIndex.getRootTx(id);
  } catch {
    result = undefined;
  }
  if (result === undefined || result.rootTxId === id) return { kind: 'l1' };
  if (result.rootDataOffset !== undefined) {
    return {
      kind: 'nested',
      rootTxId: result.rootTxId,
      rootParentOffset: result.rootDataOffset,
    };
  }
  return { kind: 'unresolved', rootTxId: result.rootTxId };
}
