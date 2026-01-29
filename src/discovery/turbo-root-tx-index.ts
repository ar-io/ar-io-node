/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { default as axios, AxiosInstance } from 'axios';
import * as rax from 'retry-axios';
import winston from 'winston';
import { LRUCache } from 'lru-cache';
import { TokenBucket } from 'limiter';
import { DataItemRootIndex } from '../types.js';
import * as config from '../config.js';
import * as metrics from '../metrics.js';
import { isValidTxId } from '../lib/validation.js';
import { MAX_BUNDLE_NESTING_DEPTH } from '../arweave/constants.js';

export type CachedTurboOffsets = {
  parentDataItemId?: string;
  rootBundleId?: string;
  startOffsetInParentDataItemPayload?: number;
  startOffsetInRootBundle?: number;
  rawContentLength: number;
  payloadContentType: string;
  payloadDataStart: number;
  payloadContentLength: number;
};

// Special symbol to indicate item was not found (vs being a root tx)
const NOT_FOUND = Symbol('NOT_FOUND');

interface TurboOffsetsResponse {
  parentDataItemId?: string;
  rootBundleId?: string;
  startOffsetInParentDataItemPayload?: number;
  startOffsetInRootBundle?: number;
  rawContentLength: number;
  payloadContentType: string;
  payloadDataStart: number;
  payloadContentLength: number;
}

export class TurboRootTxIndex implements DataItemRootIndex {
  private log: winston.Logger;
  private readonly axiosInstance: AxiosInstance;
  private readonly turboEndpoint: string;
  private readonly cache?: LRUCache<string, CachedTurboOffsets>;
  private readonly limiter: TokenBucket;

  constructor({
    log,
    turboEndpoint = config.TURBO_ENDPOINT,
    requestTimeoutMs = config.TURBO_REQUEST_TIMEOUT_MS,
    requestRetryCount = config.TURBO_REQUEST_RETRY_COUNT,
    rateLimitBurstSize = config.TURBO_ROOT_TX_RATE_LIMIT_BURST_SIZE,
    rateLimitTokensPerInterval = config.TURBO_ROOT_TX_RATE_LIMIT_TOKENS_PER_INTERVAL,
    rateLimitInterval = config.TURBO_ROOT_TX_RATE_LIMIT_INTERVAL,
    cache,
  }: {
    log: winston.Logger;
    turboEndpoint?: string;
    requestTimeoutMs?: number;
    requestRetryCount?: number;
    rateLimitBurstSize?: number;
    rateLimitTokensPerInterval?: number;
    rateLimitInterval?: 'second' | 'minute' | 'hour' | 'day';
    cache?: LRUCache<string, CachedTurboOffsets>;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.turboEndpoint = turboEndpoint;
    this.cache = cache;

    // Initialize rate limiter
    this.limiter = new TokenBucket({
      bucketSize: rateLimitBurstSize,
      tokensPerInterval: rateLimitTokensPerInterval,
      interval: rateLimitInterval,
    });

    // Initialize axios instance with retry configuration
    this.axiosInstance = axios.create({
      timeout: requestTimeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'X-AR-IO-Node-Release': config.AR_IO_NODE_RELEASE,
      },
    });

    // Configure retry-axios for 429 handling with exponential backoff
    this.axiosInstance.defaults.raxConfig = {
      retry: requestRetryCount,
      instance: this.axiosInstance,
      statusCodesToRetry: [
        [100, 199],
        [429, 429],
        [500, 599],
      ],
      onRetryAttempt: (error: any) => {
        const cfg = rax.getConfig(error);
        const attempt = cfg?.currentRetryAttempt ?? 1;
        const status = error?.response?.status;

        log.debug('Retrying Turbo request', {
          attempt,
          status,
          maxRetries: requestRetryCount,
          url: error?.config?.url,
        });
      },
    };

    rax.attach(this.axiosInstance);
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

    // Keep track of visited IDs to prevent infinite loops
    const visited = new Set<string>();
    const chain: TurboOffsetsResponse[] = [];
    let currentId = id;
    let depth = 0;

    while (
      currentId &&
      !visited.has(currentId) &&
      depth < MAX_BUNDLE_NESTING_DEPTH
    ) {
      visited.add(currentId);
      depth++;

      const offsets = await this.queryOffsets(currentId, depth, log);

      if (offsets === NOT_FOUND) {
        // Item not found
        log.debug('Item not found in Turbo', { id: currentId });
        return undefined;
      }

      chain.push(offsets);

      if (offsets.rootBundleId != null) {
        // Found root - calculate final position
        log.debug('Found root bundle in chain', {
          originalId: id,
          rootBundleId: offsets.rootBundleId,
          chainLength: chain.length,
        });
        return this.calculateRootPosition(chain);
      }

      if (offsets.parentDataItemId == null) {
        // No parent and no root = this IS the root (L1 transaction)
        log.debug('Found L1 root transaction', {
          originalId: id,
          rootTxId: currentId,
        });
        return {
          rootTxId: currentId,
          contentType: offsets.payloadContentType,
          size: offsets.rawContentLength,
          dataSize: offsets.payloadContentLength,
        };
      }

      // Continue following the chain
      currentId = offsets.parentDataItemId;
    }

    if (depth >= MAX_BUNDLE_NESTING_DEPTH) {
      log.warn('Maximum nesting depth reached', {
        id,
        depth,
        visited: Array.from(visited),
      });
    }

    if (visited.has(currentId)) {
      log.warn('Circular reference detected in bundle chain', {
        id,
        circularId: currentId,
        visited: Array.from(visited),
      });
    }

    return undefined;
  }

  private async queryOffsets(
    id: string,
    depth: number,
    log: winston.Logger,
  ): Promise<TurboOffsetsResponse | typeof NOT_FOUND> {
    // Check cache first
    const cached = this.cache?.get(id);
    if (cached !== undefined) {
      log.debug('Cache hit for Turbo offsets lookup', { id });
      metrics.rootTxCacheHitTotal.inc({ source: 'turbo' });
      return cached;
    }
    metrics.rootTxCacheMissTotal.inc({ source: 'turbo' });

    try {
      const url = `${this.turboEndpoint}/tx/${id}/offsets`;

      // Apply rate limiting before making request
      if (!this.limiter.tryRemoveTokens(1)) {
        log.debug('Rate limit exceeded - skipping Turbo source', {
          id,
          tokensAvailable: this.limiter.content,
        });
        return NOT_FOUND;
      }

      log.debug('Querying Turbo offsets endpoint', { url });

      const response = await this.axiosInstance.get<TurboOffsetsResponse>(url);

      if (
        response.status === 200 &&
        response.data !== null &&
        response.data !== undefined
      ) {
        const offsets = response.data;

        // Cache the result
        if (this.cache) {
          this.cache.set(id, offsets);
          log.debug('Cached Turbo offsets result', { id });
        }

        log.debug('Turbo offsets query result', {
          id,
          hasParent: offsets.parentDataItemId != null,
          hasRoot: offsets.rootBundleId != null,
          contentType: offsets.payloadContentType,
        });

        return offsets;
      }

      // Unexpected response status
      log.debug('Unexpected response from Turbo offsets', {
        id,
        status: response.status,
      });
      return NOT_FOUND;
    } catch (error: any) {
      if (error.response?.status === 404) {
        // Distinguish between initial lookup vs parent chain traversal
        // depth > 1 means we're following a parent reference that isn't in Turbo
        if (depth > 1 && isValidTxId(id)) {
          log.debug('Parent item not found in Turbo during chain traversal', {
            id,
            depth,
          });
          // Parent not indexed by Turbo - cannot resolve chain
          return NOT_FOUND;
        }

        // Item not found in Turbo (initial lookup)
        log.debug('Item not found in Turbo (404)', { id });

        // Don't cache 404s as the item might appear later
        return NOT_FOUND;
      }

      // Other errors (network, timeout, etc.)
      log.debug('Failed to query Turbo offsets', {
        id,
        error: error.message,
        status: error.response?.status,
      });

      throw error; // Re-throw to trigger circuit breaker
    }
  }

  /**
   * Calculates the final position of a nested data item within its root L1 transaction.
   *
   * This method takes a chain of Turbo offset responses and calculates the cumulative offset
   * required to locate the data item within the root L1 transaction's data field (ANS-104 bundle).
   *
   * The root is always an L1 transaction (rootBundleId). All offsets are relative to the start
   * of the L1's data field, which contains the ANS-104 bundle structure.
   *
   * Note: Turbo lazily populates rootBundleId and startOffsetInRootBundle fields. Any item in
   * the chain (leaf or any ancestor) may have these fields populated. The algorithm uses the
   * first item with root info as the starting point and calculates offsets down to the target.
   *
   * @param chain - Array of TurboOffsetsResponse objects representing the nesting path.
   *                - First element: the target data item (leaf)
   *                - Last element: the item with rootBundleId (could be leaf or any ancestor)
   *                - Chain length varies based on where Turbo has populated root info
   *
   * @returns Object containing:
   *   - rootTxId: The ID of the root L1 transaction
   *   - rootOffset: Byte offset to the data item's start within the L1's data field
   *   - rootDataOffset: Byte offset to the data item's payload within the L1's data field
   *   - contentType: Content type of the original data item
   *   - size: Total size of the original data item (including headers)
   *   - dataSize: Size of the original data item's payload only
   *
   * @example
   * Example 1 - Direct (chain length 1): Leaf item already has root offsets populated
   * Chain: dataItem (has rootBundleId)
   * Note: dataItem has parentDataItemId=parent, but traversal stops since dataItem
   *       already has root info. Parent and ancestors are never queried.
   *
   * L1 Transaction (rootBundleId):
   * └─ Data field (ANS-104 bundle):
   *     └─ [GreatGrandparent DataItem]
   *         └─ [Grandparent DataItem]
   *             └─ [Parent DataItem]
   *                 └─ [Target DataItem]  ← dataItem.startOffsetInRootBundle
   *                     ├─ Headers (signature, owner, tags, etc.)
   *                     └─ Payload ← dataItem.startOffsetInRootBundle + payloadDataStart
   *
   * Result:
   *   rootOffset = dataItem.startOffsetInRootBundle
   *   rootDataOffset = dataItem.startOffsetInRootBundle + dataItem.payloadDataStart
   *
   * @example
   * Example 2 - Traversal (chain length 2): Root offsets populated on parent
   * Chain: dataItem → parent (has rootBundleId)
   * Note: parent has parentDataItemId=grandparent, but traversal stops since parent
   *       already has root info. Grandparent and ancestors are never queried.
   *
   * L1 Transaction (rootBundleId):
   * └─ Data field (ANS-104 bundle):
   *     └─ [GreatGrandparent DataItem]
   *         └─ [Grandparent DataItem]
   *             └─ [Parent DataItem]  ← parent.startOffsetInRootBundle
   *                 ├─ Headers
   *                 └─ Payload
   *                     └─ [Target DataItem]  ← dataItem.startOffsetInParentDataItemPayload
   *                         ├─ Headers
   *                         └─ Payload
   *
   * Calculation steps:
   * 1. Start: rootOffset = parent.startOffsetInRootBundle
   * 2. Add parent.payloadDataStart (to enter parent's payload)
   * 3. Add dataItem.startOffsetInParentDataItemPayload (dataItem's position in parent's payload)
   * 4. rootDataOffset = rootOffset + dataItem.payloadDataStart (to enter dataItem's payload)
   *
   * @example
   * Example 3 - Traversal (chain length 3): Root offsets populated in middle of ancestry
   * Chain: dataItem → parent → grandparent (has rootBundleId)
   * Note: grandparent has parentDataItemId=greatGrandparent, but traversal stops since
   *       grandparent already has root info. GreatGrandparent is never queried.
   *
   * L1 Transaction (rootBundleId):
   * └─ Data field (ANS-104 bundle):
   *     └─ [GreatGrandparent DataItem]
   *         └─ [Grandparent DataItem]  ← grandparent.startOffsetInRootBundle
   *             ├─ Headers
   *             └─ Payload
   *                 └─ [Parent DataItem]  ← parent.startOffsetInParentDataItemPayload
   *                     ├─ Headers
   *                     └─ Payload
   *                         └─ [Target DataItem]  ← dataItem.startOffsetInParentDataItemPayload
   *                             ├─ Headers
   *                             └─ Payload
   *
   * Calculation steps:
   * 1. Start: rootOffset = grandparent.startOffsetInRootBundle
   * 2. Add grandparent.payloadDataStart (to enter grandparent's payload)
   * 3. Add parent.startOffsetInParentDataItemPayload (parent's position in grandparent's payload)
   * 4. Add parent.payloadDataStart (to enter parent's payload)
   * 5. Add dataItem.startOffsetInParentDataItemPayload (dataItem's position in parent's payload)
   * 6. rootDataOffset = rootOffset + dataItem.payloadDataStart (to enter dataItem's payload)
   */
  private calculateRootPosition(chain: TurboOffsetsResponse[]): {
    rootTxId: string;
    rootOffset?: number;
    rootDataOffset?: number;
    contentType?: string;
    size?: number;
    dataSize?: number;
  } {
    // The last item in chain has rootBundleId
    const rootItem = chain[chain.length - 1];
    if (rootItem.rootBundleId == null) {
      throw new Error('Root item must have rootBundleId');
    }

    let rootOffset = rootItem.startOffsetInRootBundle!;

    // Walk back down the chain from parent to child
    for (let i = chain.length - 2; i >= 0; i--) {
      const parent = chain[i + 1];
      const child = chain[i];

      // Add parent's payload start to get into its payload
      rootOffset += parent.payloadDataStart;
      // Add child's position within parent's payload
      rootOffset += child.startOffsetInParentDataItemPayload!;
    }

    // Get metadata from the original item (first in chain)
    const originalItem = chain[0];

    return {
      rootTxId: rootItem.rootBundleId,
      rootOffset: rootOffset,
      rootDataOffset: rootOffset + originalItem.payloadDataStart,
      contentType: originalItem.payloadContentType,
      size: originalItem.rawContentLength,
      dataSize: originalItem.payloadContentLength,
    };
  }
}
