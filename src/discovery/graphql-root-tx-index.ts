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
import { shuffleArray } from '../lib/random.js';
import * as config from '../config.js';

type CachedParentBundle = { bundleId?: string };

// Special symbol to indicate item was not found (vs being a root tx)
const NOT_FOUND = Symbol('NOT_FOUND');

const GRAPHQL_QUERY = `
  query getRootTxId($id: ID!) {
    transaction(id: $id) {
      id
      bundledIn {
        id
      }
    }
  }
`;

const DEFAULT_REQUEST_RETRY_COUNT = 3;

export class GraphQLRootTxIndex implements DataItemRootTxIndex {
  private log: winston.Logger;
  private trustedGateways: Map<number, string[]>;
  private readonly axiosInstance: AxiosInstance;
  private readonly cache?: LRUCache<string, CachedParentBundle>;

  constructor({
    log,
    trustedGatewaysUrls,
    requestTimeoutMs = config.TRUSTED_GATEWAYS_REQUEST_TIMEOUT_MS,
    requestRetryCount = DEFAULT_REQUEST_RETRY_COUNT,
    cache,
  }: {
    log: winston.Logger;
    trustedGatewaysUrls: Record<string, number>;
    requestTimeoutMs?: number;
    requestRetryCount?: number;
    cache?: LRUCache<string, CachedParentBundle>;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.cache = cache;

    if (Object.keys(trustedGatewaysUrls).length === 0) {
      throw new Error('At least one gateway URL must be provided');
    }

    // lower number = higher priority
    this.trustedGateways = new Map();
    for (const [url, priority] of Object.entries(trustedGatewaysUrls)) {
      if (!this.trustedGateways.has(priority)) {
        this.trustedGateways.set(priority, []);
      }
      this.trustedGateways.get(priority)?.push(url);
    }

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

        log.debug('Retrying GraphQL request', {
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

      const queryResult = await this.queryBundleId(currentId, log);

      // queryResult can be:
      // - undefined: item is a root transaction (not bundled)
      // - string: the bundle ID that contains this item
      // - NOT_FOUND: item not found

      if (queryResult === NOT_FOUND) {
        // Item not found
        log.debug('Item not found in GraphQL', { id: currentId });
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
    log: winston.Logger,
  ): Promise<string | undefined | typeof NOT_FOUND> {
    // Check cache first
    if (this.cache?.has(id)) {
      const cached = this.cache.get(id);
      log.debug('Cache hit for GraphQL lookup', {
        id,
        bundleId: cached?.bundleId,
      });
      return cached?.bundleId;
    }

    // lower number = higher priority
    const priorities = Array.from(this.trustedGateways.keys()).sort(
      (a, b) => a - b,
    );

    let lastError: Error | null = null;

    for (const priority of priorities) {
      const gatewaysInTier = this.trustedGateways.get(priority);

      if (gatewaysInTier) {
        const shuffledGateways = shuffleArray([...gatewaysInTier]);

        for (const gatewayUrl of shuffledGateways) {
          try {
            const response = await this.axiosInstance.post(
              `${gatewayUrl}/graphql`,
              {
                query: GRAPHQL_QUERY,
                variables: { id },
              },
            );

            if (response.data?.data?.transaction) {
              const transaction = response.data.data.transaction;

              // Return the bundle ID if exists, undefined if not bundled
              const bundleId = transaction.bundledIn?.id;

              // Cache the result
              if (this.cache) {
                this.cache.set(id, { bundleId });
                log.debug('Cached GraphQL lookup result', { id, bundleId });
              }

              log.debug('Transaction query result', {
                id,
                bundledIn: bundleId,
                gateway: gatewayUrl,
              });

              return bundleId;
            }

            // Transaction not found in this gateway - don't cache and try next
            log.debug('Transaction not found', {
              id,
              gateway: gatewayUrl,
            });
            // Continue to next gateway instead of returning
          } catch (error: any) {
            lastError = error;
            log.debug('Failed to query gateway', {
              gateway: gatewayUrl,
              error: error.message,
            });
            // Continue to next gateway
          }
        }
      }
    }

    // All gateways failed - return NOT_FOUND to indicate item wasn't found
    log.warn('Failed to query transaction from all gateways', {
      id,
      error: lastError?.message,
    });

    return NOT_FOUND;
  }
}
