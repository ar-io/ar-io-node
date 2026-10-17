/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import crypto from 'node:crypto';
import { Response } from 'express';

import { headerNames } from '../constants.js';
import { formatContentDigest } from '../lib/digest.js';
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

/** Which lookup answered an offsets request. */
export type RootTxOffsetsSource = 'db' | 'cdb64';

/**
 * Answers `GET /ar-io/offsets/:id` from this node's own data, never from the
 * network.
 *
 * The local index is asked first, exactly as before. When it can't place the
 * item, or places it without offsets, installed CDB64 indexes (such as bands
 * from Index Sharing) are asked through `lookupLocalCdb64`, which must read
 * local disk only. A CDB64 answer replaces an offset-less local one only when
 * it has offsets for the same root.
 *
 * A CDB64 answer is returned whole and never merged with the local index's
 * fields. In particular it never carries `dataSize` or `contentType`: an index
 * is a publisher's claim, and a location without `dataSize` is one a consumer
 * serves only after verifying the item's signature.
 *
 * @returns the response and the lookup that produced it, or `undefined` when
 *   neither can place the item. A CDB64 lookup that throws counts as a miss.
 */
export async function resolveRootTxOffsets({
  attributes,
  lookupLocalCdb64,
}: {
  attributes: ContiguousDataAttributes | undefined;
  lookupLocalCdb64: () => Promise<RootTxLookupResult | undefined>;
}): Promise<
  { offsets: RootTxOffsetsResponse; source: RootTxOffsetsSource } | undefined
> {
  const fromIndex = buildRootTxOffsets(attributes);
  if (fromIndex?.rootOffset !== undefined) {
    return { offsets: fromIndex, source: 'db' };
  }

  let fromCdb64: RootTxLookupResult | undefined;
  try {
    fromCdb64 = await lookupLocalCdb64();
  } catch {
    fromCdb64 = undefined;
  }

  // Use the CDB64 answer when the local index has nothing, or when it adds
  // offsets to the same root the local index already named.
  if (
    fromCdb64 !== undefined &&
    (fromIndex === undefined ||
      (fromCdb64.rootOffset !== undefined &&
        fromIndex.rootTxId === fromCdb64.rootTxId))
  ) {
    return {
      offsets: {
        rootTxId: fromCdb64.rootTxId,
        path: fromCdb64.path,
        rootOffset: fromCdb64.rootOffset,
        rootDataOffset: fromCdb64.rootDataOffset,
        size: fromCdb64.size,
      },
      source: 'cdb64',
    };
  }

  return fromIndex === undefined
    ? undefined
    : { offsets: fromIndex, source: 'db' };
}

/**
 * Sends a 200 offsets response that the HTTPSIG middleware signs.
 *
 * `X-AR-IO-Root-Transaction-Id` is a signing trigger, and `Content-Digest`,
 * which the signature covers, binds the serialized body to it. So the answer
 * is this gateway's attributable claim, the same way `/ar-io/indexes` signs
 * its document.
 */
export function sendRootTxOffsets(
  res: Response,
  offsets: RootTxOffsetsResponse,
  maxAgeSeconds: number,
): void {
  const body = JSON.stringify(offsets);
  // A band can be replaced or withdrawn, so the TTL stays short.
  res.setHeader('Cache-Control', `public, max-age=${maxAgeSeconds}`);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader(headerNames.rootTransactionId, offsets.rootTxId);
  res.setHeader(
    headerNames.contentDigest,
    formatContentDigest(
      crypto.createHash('sha256').update(body).digest('base64url'),
    ),
  );
  res.status(200).send(body);
}
