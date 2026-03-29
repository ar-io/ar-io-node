/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { LRUCache } from 'lru-cache';
import winston from 'winston';

import { Ans104OffsetSource, DataItemMeta } from './ans104-offset-source.js';
import { utf8ToB64Url } from '../lib/encoding.js';
import {
  DataItemIndexWriter,
  GqlQueryable,
  GqlTransaction,
  NormalizedBundleDataItem,
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

/** Normalized data item metadata suitable for building /tx/{id} responses. */
export interface ResolvedDataItemMeta {
  id: string;
  signature: string;
  signatureType: number;
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
  /** Internal: raw extraction data for persistence. Not used externally. */
  _meta?: DataItemMeta & { itemOffset: number; itemSize: number };
}

export class DataItemMetaResolver {
  private log: winston.Logger;
  private gqlQueryable: GqlQueryable;
  private rootTxIndex: RootTxIndex;
  private ans104OffsetSources: Ans104OffsetSource[];
  private dataItemIndexWriter?: DataItemIndexWriter;
  private cache: LRUCache<string, ResolvedDataItemMeta>;

  constructor({
    log,
    gqlQueryable,
    rootTxIndex,
    ans104OffsetSources,
    dataItemIndexWriter,
    cacheSize = 10_000,
  }: {
    log: winston.Logger;
    gqlQueryable: GqlQueryable;
    rootTxIndex: RootTxIndex;
    ans104OffsetSources: Ans104OffsetSource[];
    dataItemIndexWriter?: DataItemIndexWriter;
    cacheSize?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.gqlQueryable = gqlQueryable;
    this.rootTxIndex = rootTxIndex;
    this.ans104OffsetSources = ans104OffsetSources;
    this.dataItemIndexWriter = dataItemIndexWriter;
    this.cache = new LRUCache({ max: cacheSize });
  }

  /**
   * Resolves data item metadata by ID. Tries indexed DB first, then on-demand
   * binary extraction from parent bundle.
   *
   * Returns undefined if the ID is not a data item or cannot be resolved.
   */
  async resolve(id: string): Promise<ResolvedDataItemMeta | undefined> {
    const log = this.log.child({ method: 'resolve', id });

    // Check LRU cache
    const cached = this.cache.get(id);
    if (cached !== undefined) {
      log.debug('Data item meta cache hit');
      return cached;
    }

    // Tier 1: Check indexed data in DB (both L1 transactions and L2 data items)
    try {
      const gqlTx = await this.gqlQueryable.getGqlTransaction({ id });
      if (gqlTx !== null && gqlTx !== undefined) {
        const resolved = this.fromGqlTransaction(gqlTx);
        this.cache.set(id, resolved);
        return resolved;
      }
    } catch (error: any) {
      log.debug('GQL transaction lookup failed', { error: error.message });
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
      let resolved: ResolvedDataItemMeta | undefined;
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
            isStable: false,
            _meta: {
              ...meta,
              itemOffset: offsetResult.itemOffset,
              itemSize: offsetResult.itemSize,
            },
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
      if (this.dataItemIndexWriter != null && resolved._meta != null) {
        this.saveToIndex(resolved, rootTxId, log).catch((error) => {
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
    resolved: ResolvedDataItemMeta,
    rootTxId: string,
    log: winston.Logger,
  ): Promise<void> {
    if (this.dataItemIndexWriter == null || resolved._meta == null) {
      return;
    }

    const m = resolved._meta;
    const item: NormalizedBundleDataItem = {
      id: m.id,
      anchor: m.anchor,
      signature: m.signature,
      signature_type: m.signatureType,
      signature_offset: m.signatureOffset,
      signature_size: m.signatureSize,
      owner: m.owner,
      owner_address: m.ownerAddress,
      owner_offset: m.ownerOffset,
      owner_size: m.ownerSize,
      target: m.target,
      content_type: m.contentType,
      data_size: m.payloadSize,
      data_offset: m.itemOffset + m.headerSize,
      data_hash: '', // Not available without reading the full payload
      tags: m.tags.map((t) => ({
        name: utf8ToB64Url(t.name),
        value: utf8ToB64Url(t.value),
      })),
      offset: m.itemOffset,
      size: m.itemSize,
      index: 0,
      parent_id: rootTxId,
      parent_index: 0,
      root_tx_id: rootTxId,
      root_parent_offset: 0,
      filter: '{"always": true}',
    };

    await this.dataItemIndexWriter.saveDataItem(item);
    log.debug('Persisted on-demand data item to index', { id: m.id });
  }

  private fromGqlTransaction(gqlTx: GqlTransaction): ResolvedDataItemMeta {
    return {
      id: gqlTx.id,
      signature: gqlTx.signature ?? '',
      signatureType: 1, // Default to Arweave signature type
      ownerAddress: gqlTx.ownerAddress,
      owner: gqlTx.ownerKey ?? gqlTx.ownerAddress,
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
