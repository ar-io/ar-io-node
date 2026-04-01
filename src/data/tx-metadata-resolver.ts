/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { LRUCache } from 'lru-cache';
import winston from 'winston';

import { Ans104OffsetSource } from './ans104-offset-source.js';
import { fromB64Url, sha256B64Url, utf8ToB64Url } from '../lib/encoding.js';
import {
  DataItemIndexWriter,
  GqlQueryable,
  GqlTransaction,
  NormalizedBundleDataItem,
  PartialJsonTransactionStore,
} from '../types.js';

interface RootTxIndex {
  getRootTx(id: string): Promise<
    | {
        rootTxId: string;
        path?: string[];
        rootOffset?: number;
        rootDataOffset?: number;
        contentType?: string;
        size?: number;
        dataSize?: number;
      }
    | undefined
  >;
}

/** Normalized transaction/data item metadata. */
export interface ResolvedTxMetadata {
  id: string;
  signature: string;
  signatureType?: number;
  ownerAddress: string;
  owner: string;
  target: string;
  anchor: string;
  tags: { name: string; value: string }[];
  dataSize: number;
  contentType?: string;
  parentId?: string;
  rootTransactionId?: string;
  isStable?: boolean;
  // Offset fields from binary extraction (used for persistence)
  signatureOffset?: number;
  signatureSize?: number;
  ownerOffset?: number;
  ownerSize?: number;
  headerSize?: number;
  itemOffset?: number;
  itemSize?: number;
}

export class TxMetadataResolver {
  private log: winston.Logger;
  private txStore?: PartialJsonTransactionStore;
  private gqlQueryable: GqlQueryable;
  private rootTxIndex: RootTxIndex;
  private ans104OffsetSources: Ans104OffsetSource[];
  private dataItemIndexWriter?: DataItemIndexWriter;
  private cache: LRUCache<string, ResolvedTxMetadata>;
  private pendingPromises: Map<string, Promise<ResolvedTxMetadata | undefined>>;

  constructor({
    log,
    txStore,
    gqlQueryable,
    rootTxIndex,
    ans104OffsetSources,
    dataItemIndexWriter,
    cacheSize = 10_000,
  }: {
    log: winston.Logger;
    txStore?: PartialJsonTransactionStore;
    gqlQueryable: GqlQueryable;
    rootTxIndex: RootTxIndex;
    ans104OffsetSources: Ans104OffsetSource[];
    dataItemIndexWriter?: DataItemIndexWriter;
    cacheSize?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.txStore = txStore;
    this.gqlQueryable = gqlQueryable;
    this.rootTxIndex = rootTxIndex;
    this.ans104OffsetSources = ans104OffsetSources;
    this.dataItemIndexWriter = dataItemIndexWriter;
    this.cache = new LRUCache({ max: cacheSize });
    this.pendingPromises = new Map();
  }

  /**
   * Fast local-only resolution from LMDB txStore, LRU cache, and GQL DB.
   * Does not attempt remote resolution. Returns undefined if not locally
   * available — the caller can trigger background indexing separately.
   */
  async resolveFromLocal(id: string): Promise<ResolvedTxMetadata | undefined> {
    // Check LRU cache
    const cached = this.cache.get(id);
    if (cached !== undefined) {
      return cached;
    }

    // Check L1 LMDB header store (base64url-encoded tags need decoding)
    if (this.txStore != null) {
      try {
        const tx = await this.txStore.get(id);
        if (tx != null) {
          const resolved: ResolvedTxMetadata = {
            id,
            signature: tx.signature ?? '',
            ownerAddress:
              tx.owner != null && tx.owner.length > 0
                ? sha256B64Url(fromB64Url(tx.owner))
                : '',
            owner: tx.owner ?? '',
            target: tx.target ?? '',
            anchor: tx.last_tx ?? '',
            tags: (tx.tags ?? []).map((t) => ({
              name: fromB64Url(t.name).toString('utf8'),
              value: fromB64Url(t.value).toString('utf8'),
            })),
            dataSize: parseInt(tx.data_size, 10) || 0,
            contentType: undefined,
          };
          this.cache.set(id, resolved);
          return resolved;
        }
      } catch {
        // LMDB lookup failed — continue to GQL
      }
    }

    // Check local GQL DB
    try {
      const gqlTx = await this.gqlQueryable.getGqlTransaction({ id });
      if (gqlTx !== null && gqlTx !== undefined) {
        const resolved = this.fromGqlTransaction(gqlTx);
        this.cache.set(id, resolved);
        return resolved;
      }
    } catch {
      // DB lookup failed — not available locally
    }

    return undefined;
  }

  async resolve(id: string): Promise<ResolvedTxMetadata | undefined> {
    // Coalesce concurrent requests for the same ID
    const existingPromise = this.pendingPromises.get(id);
    if (existingPromise) {
      return existingPromise;
    }

    const promise = this.resolveInner(id);
    this.pendingPromises.set(id, promise);

    try {
      return await promise;
    } finally {
      this.pendingPromises.delete(id);
    }
  }

  private async resolveInner(
    id: string,
  ): Promise<ResolvedTxMetadata | undefined> {
    const log = this.log.child({ method: 'resolve', id });

    // Check LRU cache and local DB first (fast path)
    const local = await this.resolveFromLocal(id);
    if (local !== undefined) {
      return local;
    }

    // Tier 2: On-demand extraction via root tx index + binary parse
    try {
      const rootTxResult = await this.rootTxIndex.getRootTx(id);
      if (rootTxResult === undefined) {
        log.debug('Root tx index returned no result');
        return undefined;
      }

      const { rootTxId, path } = rootTxResult;
      log.debug('Found root transaction', { rootTxId, hasPath: !!path });

      // Try each offset source in sequence (gateways, then chunks/Arweave nodes)
      let resolved: ResolvedTxMetadata | undefined;
      for (const offsetSource of this.ans104OffsetSources) {
        try {
          // Find offset within the bundle
          let offsetResult;
          if (path !== undefined && path.length > 0) {
            offsetResult = await offsetSource.getDataItemOffsetWithPath(
              id,
              path,
            );
          } else {
            offsetResult = await offsetSource.getDataItemOffset(id, rootTxId);
          }

          if (offsetResult === null) {
            log.debug('Data item offset not found via source', {
              source: offsetSource.constructor.name,
            });
            continue;
          }

          // Extract full metadata from the binary header
          const meta = await offsetSource.extractDataItemMeta(
            rootTxId,
            offsetResult.itemOffset,
            offsetResult.itemSize,
          );

          // Check if the root L1 transaction is stable (has a block height)
          let isStable = false;
          try {
            const rootTx = await this.gqlQueryable.getGqlTransaction({
              id: rootTxId,
            });
            isStable = rootTx?.height != null;
          } catch {
            // If we can't check, assume unstable
          }

          resolved = {
            id: meta.id,
            signature: meta.signature,
            signatureType: meta.signatureType,
            ownerAddress: meta.ownerAddress,
            owner: meta.owner,
            target: meta.target,
            anchor: meta.anchor,
            tags: meta.tags,
            dataSize: meta.payloadSize,
            contentType: meta.contentType,
            rootTransactionId: rootTxId,
            isStable,
            signatureOffset: meta.signatureOffset,
            signatureSize: meta.signatureSize,
            ownerOffset: meta.ownerOffset,
            ownerSize: meta.ownerSize,
            headerSize: meta.headerSize,
            itemOffset: offsetResult.itemOffset,
            itemSize: offsetResult.itemSize,
          };
          break;
        } catch (sourceError: any) {
          log.debug('Offset source failed, trying next', {
            source: offsetSource.constructor.name,
            error: sourceError.message,
          });
        }
      }

      if (resolved === undefined) {
        log.debug('All offset sources failed');
        return undefined;
      }

      this.cache.set(id, resolved);
      log.debug('Resolved data item metadata on-demand', {
        rootTxId,
        tagCount: resolved.tags.length,
      });

      // Persist to database for future lookups (GraphQL, other gateways, etc.)
      if (this.dataItemIndexWriter != null && resolved.itemOffset != null) {
        this.saveToIndex(resolved, rootTxId, path, log).catch((error) => {
          log.error('Failed to persist on-demand data item to index', {
            id,
            rootTxId,
            error: error.message,
            stack: error.stack,
          });
        });
      }

      return resolved;
    } catch (error: any) {
      log.warn('On-demand data item metadata extraction failed', {
        error: error.message,
      });
      return undefined;
    }
  }

  private async saveToIndex(
    resolved: ResolvedTxMetadata,
    rootTxId: string,
    path: string[] | undefined,
    log: winston.Logger,
  ): Promise<void> {
    if (
      this.dataItemIndexWriter == null ||
      resolved.itemOffset == null ||
      resolved.itemSize == null ||
      resolved.headerSize == null
    ) {
      return;
    }

    const item: NormalizedBundleDataItem = {
      id: resolved.id,
      anchor: resolved.anchor,
      signature: resolved.signature,
      signature_type: resolved.signatureType ?? 1,
      signature_offset: resolved.signatureOffset ?? 0,
      signature_size: resolved.signatureSize ?? 0,
      owner: resolved.owner,
      owner_address: resolved.ownerAddress,
      owner_offset: resolved.ownerOffset ?? 0,
      owner_size: resolved.ownerSize ?? 0,
      target: resolved.target,
      content_type: resolved.contentType,
      data_size: resolved.dataSize,
      data_offset: resolved.itemOffset + resolved.headerSize,
      data_hash: null, // Not available without reading the full payload
      tags: resolved.tags.map((t) => ({
        name: utf8ToB64Url(t.name),
        value: utf8ToB64Url(t.value),
      })),
      offset: resolved.itemOffset,
      size: resolved.itemSize,
      index: 0,
      parent_id:
        path != null && path.length > 1
          ? path[path.length - 1] // Immediate parent for nested bundles
          : rootTxId,
      parent_index: 0,
      root_tx_id: rootTxId,
      root_parent_offset: 0,
      filter: '{"always": true}',
    };

    await this.dataItemIndexWriter.saveDataItem(item);
    log.debug('Persisted on-demand data item to index', { id: resolved.id });
  }

  private fromGqlTransaction(gqlTx: GqlTransaction): ResolvedTxMetadata {
    return {
      id: gqlTx.id,
      signature: gqlTx.signature ?? '',
      signatureType: gqlTx.signatureType ?? undefined,
      ownerAddress: gqlTx.ownerAddress,
      owner: gqlTx.ownerKey ?? '',
      target: gqlTx.recipient ?? '',
      anchor: gqlTx.anchor ?? '',
      tags: gqlTx.tags.map((t) => ({
        name: String(t.name),
        value: String(t.value),
      })),
      dataSize: parseInt(gqlTx.dataSize, 10) || 0,
      contentType: gqlTx.contentType ?? undefined,
      parentId: gqlTx.parentId ?? undefined,
      rootTransactionId: undefined, // Not directly available from GqlTransaction
      isStable: gqlTx.height !== null,
    };
  }
}
