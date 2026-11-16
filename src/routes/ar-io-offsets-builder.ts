/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import crypto from 'node:crypto';
import { Response } from 'express';

import { headerNames } from '../constants.js';
import {
  RootArweaveLocation,
  rootArweaveCandidate,
} from '../data/root-arweave-location-source.js';
import { formatContentDigest } from '../lib/digest.js';
import { ContiguousDataAttributes, RootTxLookupResult } from '../types.js';

/**
 * Absolute Arweave weave offsets added to an offsets answer when the root is a
 * stable transaction with a recorded offset. All are weave offsets in Arweave's
 * numbering, the one `GET /chunk/{offset}` takes (Arweave's
 * `GET /tx/{id}/offset` reports the END offset; start = offset - size + 1).
 */
export interface RootArweaveOffsets {
  /** First byte of the root transaction's data in the weave. */
  rootArweaveStartOffset?: number;
  /** Size of the root transaction's data. */
  rootArweaveDataSize?: number;
  /** First byte of the item (its header, for a data item) in the weave. */
  itemArweaveStartOffset?: number;
  /** First byte of the item's payload in the weave. */
  dataArweaveStartOffset?: number;
}

/**
 * Response body of `GET /ar-io/offsets/:id`.
 *
 * {@link RootTxLookupResult}, the internal vocabulary every root TX index
 * already speaks, so a consuming peer can pass the decoded body straight
 * through without a translation layer, plus the absolute Arweave offsets
 * ({@link RootArweaveOffsets}), which peers that don't know them ignore. The
 * {@link RootTxLookupResult} offsets and sizes are byte values relative to the
 * root L1 transaction's data.
 */
export type RootTxOffsetsResponse = RootTxLookupResult & RootArweaveOffsets;

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
export type RootTxOffsetsSource = 'db' | 'cdb64' | 'l1';

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
 * Given `id` and `getRootArweaveLocation`, the answer also carries the root's
 * absolute Arweave offsets ({@link RootArweaveOffsets}) when the root is a
 * stable transaction with a recorded offset, and an ID nothing places inside a
 * root is answered as an L1 transaction when it is one (source `l1`).
 *
 * @returns the response and the lookup that produced it, or `undefined` when
 *   nothing can place the ID. A CDB64 lookup that throws counts as a miss.
 */
export async function resolveRootTxOffsets({
  id,
  attributes,
  lookupLocalCdb64,
  getRootArweaveLocation,
}: {
  /** The requested ID; required for the Arweave offsets and L1 answers. */
  id?: string;
  attributes: ContiguousDataAttributes | undefined;
  lookupLocalCdb64: () => Promise<RootTxLookupResult | undefined>;
  /**
   * The root's absolute Arweave location from this node's own index. When
   * omitted, answers carry no Arweave offsets and L1 IDs are declined.
   */
  getRootArweaveLocation?: (
    txId: string,
  ) => Promise<RootArweaveLocation | undefined>;
}): Promise<
  { offsets: RootTxOffsetsResponse; source: RootTxOffsetsSource } | undefined
> {
  const resolved = await resolveRelativeRootTxOffsets({
    attributes,
    lookupLocalCdb64,
  });
  if (id === undefined || getRootArweaveLocation === undefined) {
    return resolved;
  }

  if (resolved !== undefined) {
    // An answer from our own index names the root only when the item may have
    // an absolute location published at all (see rootArweaveCandidate: items
    // nested more than one level deep in our bundle index are excluded, #907).
    // A CDB64 answer is a band's root-relative location and does not depend on
    // our index's parent offsets.
    const root =
      resolved.source === 'db'
        ? rootArweaveCandidate(id, attributes)
        : resolved.offsets.rootTxId;
    if (root === undefined || root !== resolved.offsets.rootTxId) {
      return resolved;
    }
    const location = await getRootArweaveLocation(root);
    if (location === undefined) {
      return resolved;
    }
    const { rootOffset, rootDataOffset } = resolved.offsets;
    return {
      ...resolved,
      offsets: {
        ...resolved.offsets,
        rootArweaveStartOffset: location.startOffset,
        rootArweaveDataSize: location.dataSize,
        itemArweaveStartOffset:
          rootOffset !== undefined
            ? location.startOffset + rootOffset
            : undefined,
        dataArweaveStartOffset:
          rootDataOffset !== undefined
            ? location.startOffset + rootDataOffset
            : undefined,
      },
    };
  }

  // Nothing places the ID inside a root. It is answered as an L1 transaction
  // only when the location lookup proves it is one: that lookup answers for
  // stable transactions with a recorded offset and nothing else, so an absent
  // root is never taken as proof on its own. The answer is `rootTxId === id`
  // without item offsets, the shape root TX indexes already use for an L1
  // root, so a consuming peer passes it through instead of reading an item
  // header at offset 0.
  if (rootArweaveCandidate(id, attributes ?? EMPTY_ATTRIBUTES) !== id) {
    return undefined;
  }
  const location = await getRootArweaveLocation(id);
  if (location === undefined) {
    return undefined;
  }
  return {
    offsets: {
      rootTxId: id,
      contentType: attributes?.contentType,
      dataSize: location.dataSize,
      rootArweaveStartOffset: location.startOffset,
      rootArweaveDataSize: location.dataSize,
      itemArweaveStartOffset: location.startOffset,
      dataArweaveStartOffset: location.startOffset,
    },
    source: 'l1',
  };
}

/**
 * An attributes record with no root and no parent, so an ID this node has no
 * attributes for is still tried as an L1 transaction.
 */
const EMPTY_ATTRIBUTES = {
  isManifest: false,
  stable: false,
} as ContiguousDataAttributes;

/**
 * The root-relative part of {@link resolveRootTxOffsets}: the local index,
 * then local CDB64 indexes.
 */
async function resolveRelativeRootTxOffsets({
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
