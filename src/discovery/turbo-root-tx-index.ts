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
import { DataItemRootTxIndex } from '../types.js';
import * as config from '../config.js';
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

export class TurboRootTxIndex implements DataItemRootTxIndex {
  private log: winston.Logger;
  private readonly axiosInstance: AxiosInstance;
  private readonly turboEndpoint: string;
  private readonly cache?: LRUCache<string, CachedTurboOffsets>;

  constructor({
    log,
    turboEndpoint = config.TURBO_ENDPOINT,
    requestTimeoutMs = config.TURBO_REQUEST_TIMEOUT_MS,
    requestRetryCount = config.TURBO_REQUEST_RETRY_COUNT,
    cache,
  }: {
    log: winston.Logger;
    turboEndpoint?: string;
    requestTimeoutMs?: number;
    requestRetryCount?: number;
    cache?: LRUCache<string, CachedTurboOffsets>;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.turboEndpoint = turboEndpoint;
    this.cache = cache;

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

  async getRootTxId(id: string): Promise<
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
    const log = this.log.child({ method: 'getRootTxId', id });

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
    if (this.cache?.has(id)) {
      const cached = this.cache.get(id)!;
      log.debug('Cache hit for Turbo offsets lookup', { id });
      return cached;
    }

    try {
      const url = `${this.turboEndpoint}/tx/${id}/offsets`;
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
        // Check if this could be an L1 transaction (Turbo doesn't index L1 txs)
        // Only do this check after the first lookup (depth > 1) to avoid false positives
        if (depth > 1 && isValidTxId(id)) {
          log.debug('Treating as potential L1 transaction after Turbo 404', {
            id,
            depth,
          });
          // Return undefined to indicate this is a root transaction
          return NOT_FOUND;
        }

        // Item not found in Turbo
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
   * Calculates the final position of a nested data item within its root bundle.
   *
   * This method takes a chain of Turbo offset responses representing the path from
   * a nested data item up to its root bundle, and calculates the cumulative offset
   * required to locate the data item within the root bundle.
   *
   * @param chain - Array of TurboOffsetsResponse objects from child to root.
   *                The first element is the target data item, and the last element
   *                contains the rootBundleId.
   *
   * @returns Object containing:
   *   - rootTxId: The ID of the root bundle transaction
   *   - rootOffset: Offset to the start of the data item within the root bundle
   *   - rootDataOffset: Offset to the start of the data item's payload within the root bundle
   *   - contentType: Content type of the original data item
   *   - size: Total size of the original data item (including headers)
   *   - dataSize: Size of the original data item's payload only
   *
   * @example
   * For a 3-level chain: dataItem → parent → root
   *
   * Offset calculation:
   * 1. Start with root's startOffsetInRootBundle (where parent begins in root)
   * 2. Add root's payloadDataStart (to get into root's payload)
   * 3. Add parent's startOffsetInParentDataItemPayload (where dataItem begins in parent)
   * 4. rootDataOffset = rootOffset + dataItem's payloadDataStart
   *
   * Visual representation:
   * ```
   * Root Bundle:
   * [headers] [payload-start] [parent headers] [parent payload-start] [dataItem headers] [dataItem payload]
   *           ^                                                        ^                   ^
   *           |                                                        |                   |
   *           startOffsetInRootBundle                                 rootOffset          rootDataOffset
   * ```
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
