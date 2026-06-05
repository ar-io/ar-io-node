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
import { shuffleArray } from '../lib/random.js';
import { parseNonNegativeInt } from '../lib/http-utils.js';
import * as config from '../config.js';
import * as metrics from '../metrics.js';
import { MAX_BUNDLE_NESTING_DEPTH } from '../arweave/constants.js';
import {
  GraphQLRootTxBatcher,
  BatchEndpoint,
  LeafResult,
  NOT_FOUND,
} from './graphql-root-tx-batcher.js';

type CachedParentBundle = LeafResult;

// Query for bundle parent traversal - minimal fields for performance
const GRAPHQL_BUNDLE_QUERY = `
  query getBundleParent($id: ID!) {
    transaction(id: $id) {
      id
      bundledIn {
        id
      }
    }
  }
`;

// Query for metadata retrieval - only used for the original item
const GRAPHQL_METADATA_QUERY = `
  query getMetadata($id: ID!) {
    transaction(id: $id) {
      id
      data {
        type
        size
      }
    }
  }
`;

// Batched query combining bundle-parent + metadata for many IDs at once. Used
// only on the batching code path (GRAPHQL_ROOT_TX_BATCH_ENABLED). `first` is
// set to the batch size at call time; Arweave GraphQL caps it at 100.
const GRAPHQL_BATCH_QUERY = `
  query getBundleParents($ids: [ID!]!, $first: Int!) {
    transactions(ids: $ids, first: $first) {
      edges {
        node {
          id
          bundledIn { id }
          data { type size }
        }
      }
    }
  }
`;

const DEFAULT_REQUEST_RETRY_COUNT = 3;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class GraphQLRootTxIndex implements DataItemRootIndex {
  private log: winston.Logger;
  private trustedGateways: Map<number, string[]>;
  private readonly axiosInstance: AxiosInstance;
  private readonly cache?: LRUCache<string, CachedParentBundle>;
  private readonly limiter: TokenBucket;
  private readonly batcher?: GraphQLRootTxBatcher;
  private readonly tokenMaxWaitMs: number;

  constructor({
    log,
    trustedGatewaysUrls,
    requestTimeoutMs = config.TRUSTED_GATEWAYS_REQUEST_TIMEOUT_MS,
    requestRetryCount = DEFAULT_REQUEST_RETRY_COUNT,
    rateLimitBurstSize = config.GRAPHQL_ROOT_TX_RATE_LIMIT_BURST_SIZE,
    rateLimitTokensPerInterval = config.GRAPHQL_ROOT_TX_RATE_LIMIT_TOKENS_PER_INTERVAL,
    rateLimitInterval = config.GRAPHQL_ROOT_TX_RATE_LIMIT_INTERVAL,
    cache,
    batchEnabled = config.GRAPHQL_ROOT_TX_BATCH_ENABLED,
    batchWindowMs = config.GRAPHQL_ROOT_TX_BATCH_WINDOW_MS,
    batchMaxSize = config.GRAPHQL_ROOT_TX_BATCH_MAX_SIZE,
    batchMaxSizeByUrl = config.GRAPHQL_ROOT_TX_BATCH_MAX_SIZE_BY_URL,
    batchMaxQueueDepth = config.GRAPHQL_ROOT_TX_BATCH_MAX_QUEUE_DEPTH,
    batchTokenMaxWaitMs = config.GRAPHQL_ROOT_TX_BATCH_TOKEN_MAX_WAIT_MS,
  }: {
    log: winston.Logger;
    trustedGatewaysUrls: Record<string, number>;
    requestTimeoutMs?: number;
    requestRetryCount?: number;
    rateLimitBurstSize?: number;
    rateLimitTokensPerInterval?: number;
    rateLimitInterval?: 'second' | 'minute' | 'hour' | 'day';
    cache?: LRUCache<string, CachedParentBundle>;
    batchEnabled?: boolean;
    batchWindowMs?: number;
    batchMaxSize?: number;
    batchMaxSizeByUrl?: Record<string, number>;
    batchMaxQueueDepth?: number;
    batchTokenMaxWaitMs?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.cache = cache;
    this.tokenMaxWaitMs = batchTokenMaxWaitMs;

    // Initialize rate limiter
    this.limiter = new TokenBucket({
      bucketSize: rateLimitBurstSize,
      tokensPerInterval: rateLimitTokensPerInterval,
      interval: rateLimitInterval,
    });

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

    if (batchEnabled) {
      const endpoints: BatchEndpoint[] = Object.entries(
        trustedGatewaysUrls,
      ).map(([url, priority]) => ({
        url,
        priority,
        maxBatchSize: batchMaxSizeByUrl[url] ?? batchMaxSize,
      }));

      this.batcher = new GraphQLRootTxBatcher({
        log: this.log,
        endpoints,
        cache,
        windowMs: batchWindowMs,
        maxBatchSize: batchMaxSize,
        maxQueueDepth: batchMaxQueueDepth,
        fetchBatch: (url, ids) => this.fetchBatch(url, ids),
        acquireToken: () => this.acquireToken(),
        metrics: {
          batchesIssued: (endpoint, size) => {
            metrics.graphqlRootTxBatchesTotal.inc({ endpoint });
            metrics.graphqlRootTxBatchSize.observe(size);
          },
          shed: () => metrics.graphqlRootTxBatchShedTotal.inc(),
          tokenWaitTimeout: (endpoint) =>
            metrics.graphqlRootTxBatchTokenWaitTimeoutTotal.inc({ endpoint }),
        },
      });

      this.log.info('GraphQL root TX request batching enabled', {
        windowMs: batchWindowMs,
        maxBatchSize: batchMaxSize,
        maxQueueDepth: batchMaxQueueDepth,
      });
    }
  }

  // Acquire one rate-limiter token, polling tryRemoveTokens (leak-free, unlike
  // racing removeTokens against a timeout) until success or the configured cap.
  private async acquireToken(): Promise<boolean> {
    const deadline = Date.now() + this.tokenMaxWaitMs;
    while (!this.limiter.tryRemoveTokens(1)) {
      if (Date.now() >= deadline) return false;
      await sleep(25);
    }
    return true;
  }

  // Issue one batched query and return only the IDs that were found. Throws on
  // transport error (the batcher carries those IDs to the next endpoint).
  private async fetchBatch(
    gatewayUrl: string,
    ids: string[],
  ): Promise<Map<string, LeafResult>> {
    const response = await this.axiosInstance.post(`${gatewayUrl}/graphql`, {
      query: GRAPHQL_BATCH_QUERY,
      variables: { ids, first: ids.length },
    });

    const out = new Map<string, LeafResult>();
    const edges = response.data?.data?.transactions?.edges;
    if (Array.isArray(edges)) {
      for (const edge of edges) {
        const node = edge?.node;
        if (node?.id == null) continue;
        out.set(node.id, {
          bundleId: node.bundledIn?.id,
          contentType: node.data?.type,
          size: node.data?.size,
        });
      }
    }
    return out;
  }

  async getRootTx(id: string): Promise<
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
  > {
    const log = this.log.child({ method: 'getRootTx', id });

    if (this.batcher !== undefined) {
      return this.getRootTxViaBatcher(id, log);
    }

    // First get the metadata for the original item
    const originalMetadata = await this.queryItemMetadata(id, log);
    if (originalMetadata === NOT_FOUND) {
      log.debug('Item not found in GraphQL', { id });
      return undefined;
    }

    // Keep track of visited IDs to prevent infinite loops
    const visited = new Set<string>();
    // Collect the traversal path from data item to root
    // Will be reversed at the end to get [root, ..., parent]
    const traversalPath: string[] = [];
    let currentId = id;
    let depth = 0;

    while (
      currentId &&
      !visited.has(currentId) &&
      depth < MAX_BUNDLE_NESTING_DEPTH
    ) {
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
        // If we traversed any bundles, build the path [root, ..., parent]
        const path =
          traversalPath.length > 0
            ? [currentId, ...traversalPath.reverse()]
            : undefined;

        log.debug('Found root transaction', {
          originalId: id,
          rootTxId: currentId,
          depth: depth - 1,
          pathLength: path?.length,
        });
        return {
          rootTxId: currentId,
          path,
          contentType: originalMetadata?.contentType,
          dataSize: parseNonNegativeInt(originalMetadata?.size),
        };
      }

      // queryResult is the parent bundle ID
      // Add current bundle to path (skip first iteration where currentId is data item)
      if (depth > 1) {
        traversalPath.push(currentId);
      }
      currentId = queryResult;
    }

    // Check if loop exited due to abort conditions
    if (depth >= MAX_BUNDLE_NESTING_DEPTH) {
      log.warn('Maximum nesting depth reached - aborting traversal', {
        id,
        depth,
        visited: Array.from(visited),
      });
      return undefined;
    }

    if (visited.has(currentId)) {
      log.warn(
        'Circular reference detected in bundle chain - aborting traversal',
        {
          id,
          circularId: currentId,
          visited: Array.from(visited),
        },
      );
      return undefined;
    }

    // If we get here, currentId should be falsy (loop exited normally)
    // This is a fallback case that shouldn't normally be reached
    return undefined;
  }

  // Batched traversal: identical walk to the legacy getRootTx, but each level's
  // GraphQL lookup goes through the coalescing batcher, and the original item's
  // metadata is taken from its (combined) first-level result rather than a
  // separate query.
  private async getRootTxViaBatcher(
    id: string,
    log: winston.Logger,
  ): Promise<
    | {
        rootTxId: string;
        path?: string[];
        contentType?: string;
        size?: number;
        dataSize?: number;
      }
    | undefined
  > {
    const batcher = this.batcher as GraphQLRootTxBatcher;
    const visited = new Set<string>();
    const traversalPath: string[] = [];
    let currentId = id;
    let depth = 0;
    let originalMetadata: LeafResult | undefined;

    while (
      currentId &&
      !visited.has(currentId) &&
      depth < MAX_BUNDLE_NESTING_DEPTH
    ) {
      visited.add(currentId);
      depth++;

      const leaf = await batcher.lookup(currentId);
      if (leaf === NOT_FOUND) {
        log.debug('Item not found in GraphQL', { id: currentId });
        return undefined;
      }

      // Metadata is only meaningful for the original item (first iteration).
      if (depth === 1) {
        originalMetadata = leaf;
      }

      if (leaf.bundleId === undefined) {
        // Root transaction (not bundled).
        const path =
          traversalPath.length > 0
            ? [currentId, ...traversalPath.reverse()]
            : undefined;
        log.debug('Found root transaction', {
          originalId: id,
          rootTxId: currentId,
          depth: depth - 1,
          pathLength: path?.length,
        });
        return {
          rootTxId: currentId,
          path,
          contentType: originalMetadata?.contentType,
          dataSize: parseNonNegativeInt(originalMetadata?.size),
        };
      }

      if (depth > 1) {
        traversalPath.push(currentId);
      }
      currentId = leaf.bundleId;
    }

    if (depth >= MAX_BUNDLE_NESTING_DEPTH) {
      log.warn('Maximum nesting depth reached - aborting traversal', {
        id,
        depth,
        visited: Array.from(visited),
      });
      return undefined;
    }

    if (visited.has(currentId)) {
      log.warn(
        'Circular reference detected in bundle chain - aborting traversal',
        { id, circularId: currentId, visited: Array.from(visited) },
      );
      return undefined;
    }

    return undefined;
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
            // Apply rate limiting before making request
            if (!this.limiter.tryRemoveTokens(1)) {
              log.debug('Rate limit exceeded - skipping gateway', {
                id,
                gateway: gatewayUrl,
                tokensAvailable: this.limiter.content,
              });
              continue;
            }

            const response = await this.axiosInstance.post(
              `${gatewayUrl}/graphql`,
              {
                query: GRAPHQL_BUNDLE_QUERY,
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

  private async queryItemMetadata(
    id: string,
    log: winston.Logger,
  ): Promise<
    | {
        contentType?: string;
        size?: string;
      }
    | typeof NOT_FOUND
  > {
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
            // Apply rate limiting before making request
            if (!this.limiter.tryRemoveTokens(1)) {
              log.debug('Rate limit exceeded - skipping gateway for metadata', {
                id,
                gateway: gatewayUrl,
                tokensAvailable: this.limiter.content,
              });
              continue;
            }

            const response = await this.axiosInstance.post(
              `${gatewayUrl}/graphql`,
              {
                query: GRAPHQL_METADATA_QUERY,
                variables: { id },
              },
            );

            if (response.data?.data?.transaction) {
              const transaction = response.data.data.transaction;

              return {
                contentType: transaction.data?.type,
                size: transaction.data?.size,
              };
            }

            // Transaction not found in this gateway - try next
            log.debug('Transaction not found for metadata', {
              id,
              gateway: gatewayUrl,
            });
            // Continue to next gateway instead of returning
          } catch (error: any) {
            lastError = error;
            log.debug('Failed to query gateway for metadata', {
              gateway: gatewayUrl,
              error: error.message,
            });
            // Continue to next gateway
          }
        }
      }
    }

    // All gateways failed
    log.warn('Failed to query transaction metadata from all gateways', {
      id,
      error: lastError?.message,
    });

    return NOT_FOUND;
  }
}
