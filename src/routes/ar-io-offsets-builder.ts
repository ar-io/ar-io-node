/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { ContiguousDataAttributes, RootTxLookupResult } from '../types.js';

/**
 * Response body of `GET /ar-io/offsets/:id`.
 *
 * Deliberately identical in shape to {@link RootTxLookupResult}, the internal
 * vocabulary every root TX index already speaks, so a consuming peer can pass
 * the decoded body straight through without a translation layer. All offsets
 * and sizes are byte values relative to the root L1 transaction's data.
 */
export type RootTxOffsetsResponse = RootTxLookupResult;

/**
 * Projects locally indexed data attributes into the offsets response.
 *
 * This is a pure index read — it never touches contiguous data. An item that
 * has been unbundled and indexed resolves here even when none of its bytes are
 * cached locally, because {@link ContiguousDataAttributes} derives
 * `rootDataItemOffset` / `rootDataOffset` from the bundle index
 * (`root_parent_offset` + `data_item_offset` / `data_offset`) when the
 * cache-side columns are absent.
 *
 * @param attributes - attributes for the requested ID, or `undefined` when the
 *   ID is unknown to this node.
 * @returns the response body, or `undefined` when this node cannot place the
 *   ID inside a root transaction. Callers should treat `undefined` as 404.
 */
export function buildRootTxOffsets(
  attributes: ContiguousDataAttributes | undefined,
): RootTxOffsetsResponse | undefined {
  const rootTxId = attributes?.rootTransactionId;

  // Without a root transaction there is nothing to locate the item against.
  // Note this also covers bare L1 transactions: we decline rather than assert
  // `rootTxId === id`, because an absent root parent is not by itself proof
  // that the ID names an L1 transaction.
  if (attributes === undefined || rootTxId === undefined) {
    return undefined;
  }

  // The traversal path is only derivable for the single-level case, where the
  // immediate parent *is* the root bundle. Multi-level nesting would require
  // walking the parent chain, which this endpoint intentionally does not do —
  // consumers fall back to header parsing for those.
  const path =
    attributes.parentId !== undefined && attributes.parentId === rootTxId
      ? [rootTxId]
      : undefined;

  return {
    rootTxId,
    path,
    rootOffset: attributes.rootDataItemOffset,
    rootDataOffset: attributes.rootDataOffset,
    contentType: attributes.contentType,
    size: attributes.itemSize,
    // `size` on the attributes record is the payload length; the data item's
    // total length (header + payload) is carried separately as `itemSize`.
    dataSize: attributes.size,
  };
}
