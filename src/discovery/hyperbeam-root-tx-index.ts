/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { default as axios, AxiosInstance } from 'axios';
import winston from 'winston';
import { LRUCache } from 'lru-cache';
import { TokenBucket } from 'limiter';

import {
  ContiguousDataAttributesStore,
  DataItemRootIndex,
  TxBoundarySource,
} from '../types.js';
import { Ans104OffsetSource } from '../data/ans104-offset-source.js';
import * as config from '../config.js';
import * as metrics from '../metrics.js';

export type CachedHyperBeamOffsets = {
  rootTxId: string;
  rootOffset?: number;
  rootDataOffset?: number;
  contentType?: string;
  size?: number;
  dataSize?: number;
};

/**
 * HyperBeamRootTxIndex resolves data item IDs to root transaction information
 * using HyperBEAM's `/raw/{id}/offset` endpoint. HyperBEAM returns a global
 * weave byte offset which is converted to a root TX ID via the local database.
 *
 * Enrichment strategy (two tiers):
 * 1. Offset-guided bundle parsing: recursively parse the root bundle's index
 *    using the offset as a hint to navigate to the target data item, yielding
 *    all metadata fields with ID verification.
 * 2. Local DB attributes: fall back to cached metadata from the data store.
 */
export class HyperBeamRootTxIndex implements DataItemRootIndex {
  private log: winston.Logger;
  private readonly hyperbeamEndpoint: string;
  private readonly axiosInstance: AxiosInstance;
  private readonly cache?: LRUCache<string, CachedHyperBeamOffsets>;
  private readonly limiter: TokenBucket;
  private readonly txBoundarySource: TxBoundarySource;
  private readonly ans104OffsetSource?: Ans104OffsetSource;
  private readonly dataAttributesStore?: ContiguousDataAttributesStore;

  constructor({
    log,
    hyperbeamEndpoint,
    requestTimeoutMs = config.HYPERBEAM_REQUEST_TIMEOUT_MS,
    rateLimitBurstSize = config.HYPERBEAM_ROOT_TX_RATE_LIMIT_BURST_SIZE,
    rateLimitTokensPerInterval = config.HYPERBEAM_ROOT_TX_RATE_LIMIT_TOKENS_PER_INTERVAL,
    rateLimitInterval = config.HYPERBEAM_ROOT_TX_RATE_LIMIT_INTERVAL,
    txBoundarySource,
    ans104OffsetSource,
    dataAttributesStore,
    cache,
  }: {
    log: winston.Logger;
    hyperbeamEndpoint: string;
    requestTimeoutMs?: number;
    rateLimitBurstSize?: number;
    rateLimitTokensPerInterval?: number;
    rateLimitInterval?: 'second' | 'minute' | 'hour' | 'day';
    txBoundarySource: TxBoundarySource;
    ans104OffsetSource?: Ans104OffsetSource;
    dataAttributesStore?: ContiguousDataAttributesStore;
    cache?: LRUCache<string, CachedHyperBeamOffsets>;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.hyperbeamEndpoint = hyperbeamEndpoint;
    this.txBoundarySource = txBoundarySource;
    this.ans104OffsetSource = ans104OffsetSource;
    this.dataAttributesStore = dataAttributesStore;
    this.cache = cache;

    this.limiter = new TokenBucket({
      bucketSize: rateLimitBurstSize,
      tokensPerInterval: rateLimitTokensPerInterval,
      interval: rateLimitInterval,
    });

    this.axiosInstance = axios.create({
      timeout: requestTimeoutMs,
    });
  }

  async getRootTx(id: string): Promise<
    | {
        rootTxId: string;
        rootOffset?: number;
        rootDataOffset?: number;
        contentType?: string;
        size?: number;
        dataSize?: number;
      }
    | undefined
  > {
    const log = this.log.child({ method: 'getRootTx', id });

    // Check cache first
    const cached = this.cache?.get(id);
    if (cached !== undefined) {
      log.debug('Cache hit for HyperBEAM offsets lookup', { id });
      metrics.rootTxCacheHitTotal.inc({ source: 'hyperbeam' });
      return cached;
    }
    metrics.rootTxCacheMissTotal.inc({ source: 'hyperbeam' });

    // Check rate limiter
    if (!this.limiter.tryRemoveTokens(1)) {
      log.debug('Rate limit exceeded for HyperBEAM - skipping', {
        id,
        tokensAvailable: this.limiter.content,
      });
      return undefined;
    }

    try {
      // Fetch global data offset from HyperBEAM
      const url = `${this.hyperbeamEndpoint}/raw/${id}/offset`;
      log.debug('Fetching offset from HyperBEAM', { url });

      const response = await this.axiosInstance.get(url);

      // Parse response as integer (handle both string and number)
      const globalDataOffset =
        typeof response.data === 'number'
          ? response.data
          : parseInt(String(response.data).trim(), 10);

      if (!Number.isFinite(globalDataOffset) || globalDataOffset < 0) {
        log.debug('Invalid offset response from HyperBEAM', {
          id,
          responseData: response.data,
        });
        return undefined;
      }

      // Resolve global offset to root TX boundary via local DB
      const boundary = await this.txBoundarySource.getTxBoundary(
        BigInt(globalDataOffset),
      );

      if (boundary === null || boundary.id === undefined) {
        log.debug('Root TX not found in local database for offset', {
          id,
          globalDataOffset,
          hasBoundary: boundary !== null,
        });
        return undefined;
      }

      const rootTxId = boundary.id;

      // weaveOffset is the end offset (inclusive) of the TX data in the weave
      // TX data spans [weaveOffset - dataSize + 1, weaveOffset]
      const relativeDataOffset =
        globalDataOffset - (boundary.weaveOffset - boundary.dataSize + 1);

      log.debug('Resolved HyperBEAM offset to root TX', {
        id,
        rootTxId,
        globalDataOffset,
        weaveOffset: boundary.weaveOffset,
        txDataSize: boundary.dataSize,
        relativeDataOffset,
      });

      // Build base result
      const result: CachedHyperBeamOffsets = {
        rootTxId,
        rootDataOffset: relativeDataOffset,
      };

      // Tier 1: Offset-guided bundle parsing
      if (this.ans104OffsetSource !== undefined) {
        try {
          const parseResult = await this.ans104OffsetSource.getDataItemByOffset(
            id,
            rootTxId,
            relativeDataOffset,
          );

          if (parseResult !== null) {
            result.rootOffset = parseResult.itemOffset;
            result.rootDataOffset = parseResult.dataOffset;
            result.contentType = parseResult.contentType;
            result.size = parseResult.itemSize;
            result.dataSize = parseResult.dataSize;
          }
        } catch (error: any) {
          log.debug('Offset-guided bundle parsing failed', {
            error: error.message,
          });
        }
      }

      // Tier 2: DB attribute enrichment (fills gaps if parsing failed)
      if (
        result.rootOffset === undefined ||
        result.size === undefined ||
        result.dataSize === undefined ||
        result.contentType === undefined
      ) {
        const dbResult = await this.enrichFromDataAttributes(id, log);

        if (dbResult !== undefined) {
          result.rootOffset ??= dbResult.rootOffset;
          result.contentType ??= dbResult.contentType;
          result.size ??= dbResult.size;
          result.dataSize ??= dbResult.dataSize;
        }
      }

      // Cache the result
      if (this.cache) {
        this.cache.set(id, result);
        log.debug('Cached HyperBEAM offsets result', { id, result });
      }

      log.debug('Successfully resolved via HyperBEAM', {
        id,
        rootTxId: result.rootTxId,
        rootOffset: result.rootOffset,
        rootDataOffset: result.rootDataOffset,
        contentType: result.contentType,
        size: result.size,
        dataSize: result.dataSize,
      });

      return result;
    } catch (error: any) {
      if (error.response?.status === 404) {
        log.debug('Item not found in HyperBEAM (404)', { id });
        return undefined;
      }

      // Re-throw to trigger circuit breaker in CompositeRootTxIndex
      log.debug('HyperBEAM request failed', {
        id,
        error: error.message,
        status: error.response?.status,
      });
      throw error;
    }
  }

  /**
   * Enriches the result with metadata from the local data attributes store.
   */
  private async enrichFromDataAttributes(
    id: string,
    log: winston.Logger,
  ): Promise<
    | {
        rootOffset?: number;
        contentType?: string;
        size?: number;
        dataSize?: number;
      }
    | undefined
  > {
    if (this.dataAttributesStore === undefined) {
      return undefined;
    }

    try {
      const attrs = await this.dataAttributesStore.getDataAttributes(id);
      if (attrs === undefined) {
        return undefined;
      }

      log.debug('Enriching from DB attributes', {
        id,
        hasRootDataItemOffset: attrs.rootDataItemOffset !== undefined,
        hasSize: attrs.size !== undefined,
        hasItemSize: attrs.itemSize !== undefined,
        hasContentType: attrs.contentType !== undefined,
      });

      return {
        rootOffset: attrs.rootDataItemOffset,
        contentType: attrs.contentType,
        size: attrs.itemSize,
        dataSize: attrs.size,
      };
    } catch (error: any) {
      log.debug('DB attribute enrichment failed', {
        id,
        error: error.message,
      });
      return undefined;
    }
  }
}
