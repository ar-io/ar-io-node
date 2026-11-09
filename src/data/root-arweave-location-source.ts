/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { LRUCache } from 'lru-cache';
import winston from 'winston';

import {
  ContiguousDataAttributes,
  DataAttributesSource,
  TxGeometrySource,
} from '../types.js';

/**
 * Where a root L1 transaction's data sits in the Arweave weave.
 *
 * `startOffset` is the absolute weave offset of the first byte of the
 * transaction's data, in Arweave's offset numbering (the one
 * `GET /chunk/{offset}` takes), the same convention as
 * `X-Arweave-Chunk-Tx-Start-Offset`. Arweave's own `GET /tx/{id}/offset`
 * reports the END offset instead; the two are related by
 * `startOffset = offset - size + 1`.
 */
export interface RootArweaveLocation {
  startOffset: number;
  dataSize: number;
}

const NOT_FOUND = Symbol('not-found');

/**
 * Resolves the absolute Arweave location of a root transaction from this
 * node's own index, never from the network.
 *
 * Only stable transactions whose offset the offset importer has recorded are
 * answered (see `selectStableTransactionGeometryById`). Stable rows are past
 * the fork depth and never change, so a found location is cached without
 * expiry. A miss is remembered only briefly: the importer fills offsets in
 * behind the chain tip, and a root that is unknown now may be answerable a
 * minute later.
 */
export class RootArweaveLocationSource {
  private log: winston.Logger;
  private txGeometrySource: TxGeometrySource;
  private found: LRUCache<string, RootArweaveLocation>;
  private missing: LRUCache<string, typeof NOT_FOUND>;

  constructor({
    log,
    txGeometrySource,
    cacheSize = 100_000,
    missTtlMs = 60_000,
  }: {
    log: winston.Logger;
    txGeometrySource: TxGeometrySource;
    cacheSize?: number;
    missTtlMs?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.txGeometrySource = txGeometrySource;
    this.found = new LRUCache({ max: cacheSize });
    this.missing = new LRUCache({ max: cacheSize, ttl: missTtlMs });
  }

  /**
   * @returns the transaction's Arweave location, or `undefined` when it is not
   *   a stable transaction with a recorded offset (or the lookup failed).
   */
  async getRootArweaveLocation(
    txId: string,
  ): Promise<RootArweaveLocation | undefined> {
    const cached = this.found.get(txId);
    if (cached !== undefined) {
      return cached;
    }
    if (this.missing.has(txId)) {
      return undefined;
    }

    let location: RootArweaveLocation | undefined;
    try {
      const geometry = await this.txGeometrySource.getTxGeometry(txId);
      if (
        geometry !== undefined &&
        Number.isSafeInteger(geometry.offset) &&
        Number.isSafeInteger(geometry.size) &&
        geometry.size > 0 &&
        geometry.offset - geometry.size + 1 >= 0
      ) {
        location = {
          startOffset: geometry.offset - geometry.size + 1,
          dataSize: geometry.size,
        };
      }
    } catch (error: any) {
      // A failed read is a miss, not an error for the caller: the response is
      // served without the location rather than failing.
      this.log.debug('Failed to read root transaction geometry', {
        txId,
        message: error?.message,
      });
      return undefined;
    }

    if (location === undefined) {
      this.missing.set(txId, NOT_FOUND);
      return undefined;
    }
    this.found.set(txId, location);
    return location;
  }
}

/**
 * The root transaction whose Arweave location may be published for `id`, or
 * `undefined` when none should be.
 *
 * - An L1 transaction (no root, no parent) is its own root. Whether `id` really
 *   is a stable L1 transaction is settled by the location lookup itself, which
 *   only answers for stable transactions.
 * - A data item directly inside its root bundle (`parentId === root`) uses
 *   that root.
 * - A data item whose location did not come from our own bundle index (no
 *   `parentId`; it was placed by a fetch or a root-TX index) uses its root.
 * - A data item nested more than one level deep in our own bundle index is
 *   excluded. Its root-relative offset is `root_parent_offset + offset`, and a
 *   nested bundle unbundled before its own position was known is recorded with
 *   `root_parent_offset = 0` (#907) with nothing on the row to tell it apart.
 *   Publishing an absolute location derived from such a row would sign a
 *   value we cannot vouch for, so these items get none until the index can
 *   flag confirmed parent offsets.
 */
export function rootArweaveCandidate(
  id: string,
  attributes: ContiguousDataAttributes | undefined,
): string | undefined {
  if (attributes === undefined) {
    return undefined;
  }
  const root = attributes.rootTransactionId;
  const parent = attributes.parentId;
  if (root == null) {
    return parent == null ? id : undefined;
  }
  if (parent != null && parent !== root) {
    return undefined;
  }
  return root;
}

/**
 * Attributes for `id` with its root's Arweave location added
 * (`rootArweaveStartOffset` / `rootArweaveDataSize`), when one may be
 * published. Returns a new object; the input is never mutated (it may be a
 * cache entry shared with other requests).
 */
export async function withRootArweaveLocation(
  id: string,
  attributes: ContiguousDataAttributes | undefined,
  locations: RootArweaveLocationSource,
): Promise<ContiguousDataAttributes | undefined> {
  const root = rootArweaveCandidate(id, attributes);
  if (attributes === undefined || root === undefined) {
    return attributes;
  }
  const location = await locations.getRootArweaveLocation(root);
  if (location === undefined) {
    return attributes;
  }
  return {
    ...attributes,
    rootArweaveStartOffset: location.startOffset,
    rootArweaveDataSize: location.dataSize,
  };
}

/**
 * A {@link DataAttributesSource} whose answers carry the root's Arweave
 * location (see {@link withRootArweaveLocation}).
 *
 * The location is added on every read rather than stored with the attributes:
 * attribute caches keep entries without expiry, so an item first read before
 * its root became stable would otherwise never gain its location.
 */
export class RootArweaveAnnotatingDataAttributesSource
  implements DataAttributesSource
{
  private source: DataAttributesSource;
  private locations: RootArweaveLocationSource;

  constructor({
    source,
    locations,
  }: {
    source: DataAttributesSource;
    locations: RootArweaveLocationSource;
  }) {
    this.source = source;
    this.locations = locations;
  }

  async getDataAttributes(
    id: string,
  ): Promise<ContiguousDataAttributes | undefined> {
    return withRootArweaveLocation(
      id,
      await this.source.getDataAttributes(id),
      this.locations,
    );
  }
}
