/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type {
  DataItemRootIndex,
  NormalizedDataItem,
  PartialJsonTransaction,
} from '../types.js';

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
    // A source that knows the root but not the offset (GraphQL, for a bundle
    // two or more levels deep, answers with a path and no offsets) must not
    // end the lookup: a later one (HyperBEAM, CDB64) may have the offset.
    // Such a result is kept as the fallback if none does.
    result = await rootTxIndex.getRootTx(id, {
      accept: (r) => r.rootTxId === id || r.rootDataOffset !== undefined,
    });
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

/**
 * The item `queue-bundle` hands to `queueBundle` for a bundle placed by
 * {@link resolveQueuedBundleRoot}: an L1 transaction as its own root, a
 * nested bundle with its L1 root and payload offset, which the unbundler
 * adds to each item's offset in the bundle.
 */
export function queuedBundleItem(
  id: string,
  placed: Exclude<QueuedBundleRoot, { kind: 'unresolved' }>,
): NormalizedDataItem | PartialJsonTransaction {
  return (
    placed.kind === 'nested'
      ? {
          id,
          root_tx_id: placed.rootTxId,
          root_parent_offset: placed.rootParentOffset,
          data_offset: 0,
        }
      : { id, root_tx_id: id }
  ) as NormalizedDataItem | PartialJsonTransaction;
}
