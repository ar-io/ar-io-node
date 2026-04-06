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
  byteArrayToLong,
  deserializeTags,
  MAX_TAG_BYTES,
} from '@dha-team/arbundles';

import {
  ContiguousDataAttributesStore,
  ContiguousDataSource,
  DataItemRootIndex,
  TxBoundarySource,
} from '../types.js';
import { getSignatureMeta, isValidSignatureConfig } from '../lib/bundles.js';
import * as config from '../config.js';
import * as metrics from '../metrics.js';

// Maximum ANS-104 data item header size (same formula as ans104-offset-source.ts)
const MAX_DATA_ITEM_HEADER_SIZE =
  2 + 2052 + 1025 + 33 + 33 + 16 + MAX_TAG_BYTES + 1024;

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
 * 1. Backward-scan header parsing: fetch chunk data before the data offset,
 *    scan for the ANS-104 header to extract rootOffset and contentType.
 * 2. Local DB attributes: fall back to cached metadata from the data store.
 */
export class HyperBeamRootTxIndex implements DataItemRootIndex {
  private log: winston.Logger;
  private readonly hyperbeamEndpoint: string;
  private readonly axiosInstance: AxiosInstance;
  private readonly cache?: LRUCache<string, CachedHyperBeamOffsets>;
  private readonly limiter: TokenBucket;
  private readonly txBoundarySource: TxBoundarySource;
  private readonly contiguousDataSource?: ContiguousDataSource;
  private readonly dataAttributesStore?: ContiguousDataAttributesStore;

  constructor({
    log,
    hyperbeamEndpoint,
    requestTimeoutMs = config.HYPERBEAM_REQUEST_TIMEOUT_MS,
    rateLimitBurstSize = config.HYPERBEAM_ROOT_TX_RATE_LIMIT_BURST_SIZE,
    rateLimitTokensPerInterval = config.HYPERBEAM_ROOT_TX_RATE_LIMIT_TOKENS_PER_INTERVAL,
    rateLimitInterval = config.HYPERBEAM_ROOT_TX_RATE_LIMIT_INTERVAL,
    txBoundarySource,
    contiguousDataSource,
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
    contiguousDataSource?: ContiguousDataSource;
    dataAttributesStore?: ContiguousDataAttributesStore;
    cache?: LRUCache<string, CachedHyperBeamOffsets>;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.hyperbeamEndpoint = hyperbeamEndpoint;
    this.txBoundarySource = txBoundarySource;
    this.contiguousDataSource = contiguousDataSource;
    this.dataAttributesStore = dataAttributesStore;
    this.cache = cache;

    this.limiter = new TokenBucket({
      bucketSize: rateLimitBurstSize,
      tokensPerInterval: rateLimitTokensPerInterval,
      interval: rateLimitInterval,
    });

    this.axiosInstance = axios.create({
      timeout: requestTimeoutMs,
      headers: {
        'X-AR-IO-Node-Release': config.AR_IO_NODE_RELEASE,
      },
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

      // Tier 1: Backward-scan header parsing
      const scanResult = await this.enrichFromBackwardScan(
        rootTxId,
        relativeDataOffset,
        log,
      );

      if (scanResult !== undefined) {
        result.rootOffset = scanResult.rootOffset;
        result.contentType = scanResult.contentType;
      }

      // Tier 2: DB attribute enrichment (fills gaps from backward-scan)
      if (
        result.rootOffset === undefined ||
        result.size === undefined ||
        result.dataSize === undefined ||
        result.contentType === undefined
      ) {
        const dbResult = await this.enrichFromDataAttributes(
          id,
          relativeDataOffset,
          log,
        );

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
   * Scans backwards from the data offset to find and parse the ANS-104
   * data item header. Returns rootOffset and contentType if a structurally
   * valid header is found.
   */
  private async enrichFromBackwardScan(
    rootTxId: string,
    relativeDataOffset: number,
    log: winston.Logger,
  ): Promise<{ rootOffset: number; contentType?: string } | undefined> {
    if (this.contiguousDataSource === undefined) {
      return undefined;
    }

    if (relativeDataOffset <= 0) {
      return undefined;
    }

    try {
      const fetchStart = Math.max(
        0,
        relativeDataOffset - MAX_DATA_ITEM_HEADER_SIZE,
      );
      const fetchSize = relativeDataOffset - fetchStart;

      if (fetchSize <= 0) {
        return undefined;
      }

      log.debug('Fetching chunk data for backward-scan', {
        rootTxId,
        fetchStart,
        fetchSize,
      });

      const data = await this.contiguousDataSource.getData({
        id: rootTxId,
        region: { offset: fetchStart, size: fetchSize },
      });

      // Collect stream into buffer
      const chunks: Buffer[] = [];
      for await (const chunk of data.stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const buffer = Buffer.concat(chunks);

      return this.parseHeaderFromBuffer(buffer, fetchStart, log);
    } catch (error: any) {
      log.debug('Backward-scan enrichment failed', {
        rootTxId,
        error: error.message,
      });
      return undefined;
    }
  }

  /**
   * Scans a buffer backwards for a valid ANS-104 data item header.
   * The buffer represents data ending at the known data offset within the
   * root TX. A valid header must parse structurally and end exactly at
   * the end of the buffer.
   */
  private parseHeaderFromBuffer(
    buffer: Buffer,
    fetchStart: number,
    log: winston.Logger,
  ): { rootOffset: number; contentType?: string } | undefined {
    // Scan backwards for signature type candidates
    // Signature type is a 2-byte little-endian uint16 with values 1-7
    for (let i = buffer.length - 4; i >= 0; i--) {
      const sigTypeByte = buffer[i];
      const sigTypeHighByte = buffer[i + 1];

      // Check for valid signature type: low byte 1-7, high byte 0
      if (
        sigTypeByte < 1 ||
        sigTypeByte > 7 ||
        sigTypeHighByte !== 0 ||
        !isValidSignatureConfig(sigTypeByte)
      ) {
        continue;
      }

      const result = this.tryParseHeaderAt(buffer, i, log);
      if (result !== undefined) {
        return {
          rootOffset: fetchStart + i,
          contentType: result.contentType,
        };
      }
    }

    log.debug('No valid ANS-104 header found in backward-scan');
    return undefined;
  }

  /**
   * Attempts to parse an ANS-104 data item header starting at the given
   * position in the buffer. Returns metadata if the parsed header ends
   * exactly at the buffer boundary (the known data offset).
   */
  private tryParseHeaderAt(
    buffer: Buffer,
    startPos: number,
    log: winston.Logger,
  ): { contentType?: string } | undefined {
    try {
      let offset = startPos;
      const bufLen = buffer.length;

      // Signature type (2 bytes)
      if (offset + 2 > bufLen) return undefined;
      const signatureType = buffer[offset] | (buffer[offset + 1] << 8);
      offset += 2;

      const { sigLength, pubLength } = getSignatureMeta(signatureType);

      // Skip signature
      offset += sigLength;
      if (offset > bufLen) return undefined;

      // Skip owner/public key
      offset += pubLength;
      if (offset > bufLen) return undefined;

      // Target flag (1 byte, must be 0 or 1)
      if (offset + 1 > bufLen) return undefined;
      const targetFlag = buffer[offset];
      if (targetFlag !== 0 && targetFlag !== 1) return undefined;
      offset += 1;
      if (targetFlag === 1) {
        offset += 32;
        if (offset > bufLen) return undefined;
      }

      // Anchor flag (1 byte, must be 0 or 1)
      if (offset + 1 > bufLen) return undefined;
      const anchorFlag = buffer[offset];
      if (anchorFlag !== 0 && anchorFlag !== 1) return undefined;
      offset += 1;
      if (anchorFlag === 1) {
        offset += 32;
        if (offset > bufLen) return undefined;
      }

      // Tags metadata: 8-byte count + 8-byte bytes length
      if (offset + 16 > bufLen) return undefined;
      const tagCount = byteArrayToLong(buffer.subarray(offset, offset + 8));
      const tagBytesLength = byteArrayToLong(
        buffer.subarray(offset + 8, offset + 16),
      );
      offset += 16;

      // Validate tag values are reasonable
      if (tagCount < 0 || tagCount > 4096) return undefined;
      if (tagBytesLength < 0 || tagBytesLength > MAX_TAG_BYTES)
        return undefined;

      // Parse tags if present
      let contentType: string | undefined;
      if (tagBytesLength > 0) {
        if (offset + tagBytesLength > bufLen) return undefined;
        const tagsBytes = buffer.subarray(offset, offset + tagBytesLength);

        if (tagCount > 0) {
          try {
            const tags = deserializeTags(Buffer.from(tagsBytes));
            const contentTypeTag = tags.find(
              (tag) => tag.name.toLowerCase() === 'content-type',
            );
            contentType = contentTypeTag?.value;
          } catch {
            // Tag deserialization failed — not a valid header
            return undefined;
          }
        }

        offset += tagBytesLength;
      }

      // Key validation: parsed header must end exactly at buffer boundary
      if (offset !== bufLen) return undefined;

      log.debug('Backward-scan found valid ANS-104 header', {
        signatureType,
        headerSize: bufLen - startPos,
        contentType,
      });

      return { contentType };
    } catch {
      return undefined;
    }
  }

  /**
   * Enriches the result with metadata from the local data attributes store.
   */
  private async enrichFromDataAttributes(
    id: string,
    _relativeDataOffset: number,
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
