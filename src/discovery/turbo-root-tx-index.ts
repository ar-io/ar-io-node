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

type CachedRootTx = { bundleId?: string };

// Special symbol to indicate item was not found (vs being a root tx)
const NOT_FOUND = Symbol('NOT_FOUND');

interface TurboStatusResponse {
  status: string;
  bundleId?: string;
  info?: string;
  rawContentLength?: number;
  payloadContentType?: string;
  payloadDataStart?: number;
  payloadContentLength?: number;
  winc?: string;
}

export class TurboRootTxIndex implements DataItemRootTxIndex {
  private log: winston.Logger;
  private readonly axiosInstance: AxiosInstance;
  private readonly turboEndpoint: string;
  private readonly cache?: LRUCache<string, CachedRootTx>;

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
    cache?: LRUCache<string, CachedRootTx>;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.turboEndpoint = turboEndpoint;
    this.cache = cache;

    // Initialize axios instance with retry configuration
    this.axiosInstance = axios.create({
      timeout: requestTimeoutMs,
      headers: {
        'Content-Type': 'application/json',
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

  async getRootTxId(id: string): Promise<string | undefined> {
    const log = this.log.child({ method: 'getRootTxId', id });

    // Keep track of visited IDs to prevent infinite loops
    const visited = new Set<string>();
    let currentId = id;
    let depth = 0;
    const MAX_DEPTH = 10; // Reasonable limit for nested bundles

    while (currentId && !visited.has(currentId) && depth < MAX_DEPTH) {
      visited.add(currentId);
      depth++;

      const queryResult = await this.queryBundleId(currentId, depth, log);

      // queryResult can be:
      // - undefined: item is a root transaction (not bundled)
      // - string: the bundle ID that contains this item
      // - NOT_FOUND: item not found

      if (queryResult === NOT_FOUND) {
        // Item not found
        log.debug('Item not found in Turbo', { id: currentId });
        return undefined;
      }

      if (queryResult === undefined) {
        // This is a root transaction (not bundled)
        log.debug('Found root transaction', {
          originalId: id,
          rootTxId: currentId,
          depth: depth - 1,
        });
        return currentId;
      }

      // Continue following the chain
      currentId = queryResult;
    }

    if (depth >= MAX_DEPTH) {
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

    return currentId;
  }

  private async queryBundleId(
    id: string,
    depth: number,
    log: winston.Logger,
  ): Promise<string | undefined | typeof NOT_FOUND> {
    // Check cache first
    if (this.cache?.has(id)) {
      const cached = this.cache.get(id);
      log.debug('Cache hit for Turbo lookup', {
        id,
        bundleId: cached?.bundleId,
      });
      return cached?.bundleId;
    }

    try {
      const url = `${this.turboEndpoint}/tx/${id}/status`;
      log.debug('Querying Turbo status endpoint', { url });

      const response = await this.axiosInstance.get<TurboStatusResponse>(url);

      if (
        response.status === 200 &&
        response.data !== null &&
        response.data !== undefined
      ) {
        const { bundleId } = response.data;

        // bundleId will be undefined if this is a root transaction
        // or a string if this item is bundled
        const result = bundleId;

        // Cache the result
        if (this.cache) {
          this.cache.set(id, { bundleId: result });
          log.debug('Cached Turbo lookup result', { id, bundleId: result });
        }

        log.debug('Turbo status query result', {
          id,
          bundledIn: result,
          status: response.data.status,
        });

        return result;
      }

      // Unexpected response status
      log.debug('Unexpected response from Turbo', {
        id,
        status: response.status,
      });
      return undefined;
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
          return undefined;
        }

        // Item not found in Turbo
        log.debug('Item not found in Turbo (404)', { id });

        // Don't cache 404s as the item might appear later
        return NOT_FOUND;
      }

      // Other errors (network, timeout, etc.)
      log.debug('Failed to query Turbo', {
        id,
        error: error.message,
        status: error.response?.status,
      });

      throw error; // Re-throw to trigger circuit breaker
    }
  }
}
