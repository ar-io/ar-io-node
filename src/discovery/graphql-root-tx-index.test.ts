/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, describe, it, mock } from 'node:test';
import { LRUCache } from 'lru-cache';
import { default as axios } from 'axios';
import { GraphQLRootTxIndex } from './graphql-root-tx-index.js';
import { createTestLogger } from '../../test/test-logger.js';

const log = createTestLogger({ suite: 'GraphQLRootTxIndex' });

describe('GraphQLRootTxIndex', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  describe('constructor', () => {
    it('should implement DataItemRootIndex interface', () => {
      const graphqlIndex = new GraphQLRootTxIndex({
        log,
        trustedGatewaysUrls: {
          'https://arweave-search.goldsky.com': 1,
        },
        rateLimitBurstSize: 1000,
        rateLimitTokensPerInterval: 1000,
      });

      assert(typeof graphqlIndex.getRootTx === 'function');
    });

    it('should accept cache in constructor', () => {
      const cache = new LRUCache<
        string,
        {
          bundleId?: string;
          contentType?: string;
          size?: string;
        }
      >({
        max: 100,
        ttl: 1000 * 60 * 5,
      });

      const graphqlIndex = new GraphQLRootTxIndex({
        log,
        trustedGatewaysUrls: {
          'https://arweave-search.goldsky.com': 1,
        },
        cache,
        rateLimitBurstSize: 1000,
        rateLimitTokensPerInterval: 1000,
      });

      assert(typeof graphqlIndex.getRootTx === 'function');
    });

    it('should accept request configuration options', () => {
      const graphqlIndex = new GraphQLRootTxIndex({
        log,
        trustedGatewaysUrls: {
          'https://arweave-search.goldsky.com': 1,
        },
        requestTimeoutMs: 5000,
        requestRetryCount: 5,
        rateLimitBurstSize: 1000,
        rateLimitTokensPerInterval: 1000,
      });

      assert(typeof graphqlIndex.getRootTx === 'function');
    });

    it('should throw error when no gateways provided', () => {
      assert.throws(() => {
        new GraphQLRootTxIndex({
          log,
          trustedGatewaysUrls: {},
          rateLimitBurstSize: 1000,
          rateLimitTokensPerInterval: 1000,
        });
      }, /At least one gateway URL must be provided/);
    });

    it('should support multiple gateways with priorities', () => {
      const graphqlIndex = new GraphQLRootTxIndex({
        log,
        trustedGatewaysUrls: {
          'https://gateway1.example.com/graphql': 1,
          'https://gateway2.example.com/graphql': 2,
          'https://gateway3.example.com/graphql': 1,
        },
        rateLimitBurstSize: 1000,
        rateLimitTokensPerInterval: 1000,
      });

      assert(typeof graphqlIndex.getRootTx === 'function');
    });
  });

  describe('getRootTx', () => {
    it('should resolve single-level data item with root bundle', async () => {
      const dataItemId = 'test-data-item-123';
      const rootBundleId = 'root-bundle-456';

      const mockAxiosInstance = {
        post: mock.fn((url: string, body: any) => {
          if (body.query.includes('getMetadata')) {
            // Metadata query for data item
            return Promise.resolve({
              status: 200,
              data: {
                data: {
                  transaction: {
                    id: dataItemId,
                    data: {
                      type: 'text/plain',
                      size: '5000',
                    },
                  },
                },
              },
            });
          } else if (
            body.query.includes('getBundleParent') &&
            body.variables.id === dataItemId
          ) {
            // Query for data item - it's bundled in root
            return Promise.resolve({
              status: 200,
              data: {
                data: {
                  transaction: {
                    id: dataItemId,
                    bundledIn: {
                      id: rootBundleId,
                    },
                  },
                },
              },
            });
          } else if (
            body.query.includes('getBundleParent') &&
            body.variables.id === rootBundleId
          ) {
            // Query for root bundle - it's not bundled
            return Promise.resolve({
              status: 200,
              data: {
                data: {
                  transaction: {
                    id: rootBundleId,
                    bundledIn: null,
                  },
                },
              },
            });
          }
          return Promise.reject(new Error('Unexpected query'));
        }),
        defaults: { raxConfig: {} },
        interceptors: {
          request: { use: mock.fn(), eject: mock.fn() },
          response: { use: mock.fn(), eject: mock.fn() },
        },
      };

      mock.method(axios, 'create', () => mockAxiosInstance);

      const graphqlIndex = new GraphQLRootTxIndex({
        log,
        trustedGatewaysUrls: {
          'https://arweave-search.goldsky.com': 1,
        },
        rateLimitBurstSize: 100,
        rateLimitTokensPerInterval: 100,
        rateLimitInterval: 'second',
      });

      // Prefill rate limiter to avoid waiting for token bucket refill
      (graphqlIndex as any)['limiter'].content = (graphqlIndex as any)[
        'limiter'
      ].bucketSize;

      const result = await graphqlIndex.getRootTx(dataItemId);

      assert.notEqual(result, undefined);
      assert.equal(result?.rootTxId, rootBundleId);
      assert.equal(result?.contentType, 'text/plain');
      assert.equal(result?.dataSize, 5000);
    });

    it('should handle transaction that is already a root', async () => {
      const rootTxId = 'root-tx-123';

      const mockAxiosInstance = {
        post: mock.fn((url: string, body: any) => {
          if (body.query.includes('getBundleParent')) {
            // Transaction is not bundled - it's a root
            return Promise.resolve({
              status: 200,
              data: {
                data: {
                  transaction: {
                    id: rootTxId,
                    bundledIn: null,
                  },
                },
              },
            });
          } else if (body.query.includes('getMetadata')) {
            return Promise.resolve({
              status: 200,
              data: {
                data: {
                  transaction: {
                    id: rootTxId,
                    data: {
                      type: 'application/octet-stream',
                      size: '10000',
                    },
                  },
                },
              },
            });
          }
          return Promise.reject(new Error('Unexpected query'));
        }),
        defaults: { raxConfig: {} },
        interceptors: {
          request: { use: mock.fn(), eject: mock.fn() },
          response: { use: mock.fn(), eject: mock.fn() },
        },
      };

      mock.method(axios, 'create', () => mockAxiosInstance);

      const graphqlIndex = new GraphQLRootTxIndex({
        log,
        trustedGatewaysUrls: {
          'https://arweave-search.goldsky.com': 1,
        },
        rateLimitBurstSize: 100,
        rateLimitTokensPerInterval: 100,
        rateLimitInterval: 'second',
      });

      // Prefill rate limiter to avoid waiting for token bucket refill
      (graphqlIndex as any)['limiter'].content = (graphqlIndex as any)[
        'limiter'
      ].bucketSize;

      const result = await graphqlIndex.getRootTx(rootTxId);

      assert.notEqual(result, undefined);
      assert.equal(result?.rootTxId, rootTxId);
      assert.equal(result?.contentType, 'application/octet-stream');
      assert.equal(result?.dataSize, 10000);
    });

    it('should return undefined for transaction not found', async () => {
      const dataItemId = 'nonexistent-item';

      const mockAxiosInstance = {
        post: mock.fn(() =>
          Promise.resolve({
            status: 200,
            data: {
              data: {
                transaction: null,
              },
            },
          }),
        ),
        defaults: { raxConfig: {} },
        interceptors: {
          request: { use: mock.fn(), eject: mock.fn() },
          response: { use: mock.fn(), eject: mock.fn() },
        },
      };

      mock.method(axios, 'create', () => mockAxiosInstance);

      const graphqlIndex = new GraphQLRootTxIndex({
        log,
        trustedGatewaysUrls: {
          'https://arweave-search.goldsky.com': 1,
        },
        rateLimitBurstSize: 100,
        rateLimitTokensPerInterval: 100,
        rateLimitInterval: 'second',
      });

      // Prefill rate limiter to avoid waiting for token bucket refill
      (graphqlIndex as any)['limiter'].content = (graphqlIndex as any)[
        'limiter'
      ].bucketSize;

      const result = await graphqlIndex.getRootTx(dataItemId);

      assert.equal(result, undefined);
    });

    it('should use cache when available', async () => {
      const dataItemId = 'cached-item-123';
      const rootBundleId = 'root-bundle-456';

      const cache = new LRUCache<
        string,
        {
          bundleId?: string;
          contentType?: string;
          size?: string;
        }
      >({
        max: 100,
        ttl: 1000 * 60 * 5,
      });

      // Pre-populate cache for dataItem and rootBundle
      cache.set(dataItemId, {
        bundleId: rootBundleId,
        contentType: 'text/plain',
        size: '5000',
      });
      // Cache entry for root bundle (not bundled in anything)
      cache.set(rootBundleId, {
        bundleId: undefined,
      });

      const mockAxiosInstance = {
        post: mock.fn((url: string, body: any) => {
          // Allow metadata query but nothing else
          if (body.query.includes('getMetadata')) {
            return Promise.resolve({
              status: 200,
              data: {
                data: {
                  transaction: {
                    id: dataItemId,
                    data: {
                      type: 'text/plain',
                      size: '5000',
                    },
                  },
                },
              },
            });
          }
          // Bundle queries should use cache and not be called
          return Promise.reject(
            new Error('Should use cache for bundle lookup'),
          );
        }),
        defaults: { raxConfig: {} },
        interceptors: {
          request: { use: mock.fn(), eject: mock.fn() },
          response: { use: mock.fn(), eject: mock.fn() },
        },
      };

      mock.method(axios, 'create', () => mockAxiosInstance);

      const graphqlIndex = new GraphQLRootTxIndex({
        log,
        trustedGatewaysUrls: {
          'https://arweave-search.goldsky.com': 1,
        },
        cache,
        rateLimitBurstSize: 100,
        rateLimitTokensPerInterval: 100,
        rateLimitInterval: 'second',
      });

      // Prefill rate limiter to avoid waiting for token bucket refill
      (graphqlIndex as any)['limiter'].content = (graphqlIndex as any)[
        'limiter'
      ].bucketSize;

      const result = await graphqlIndex.getRootTx(dataItemId);

      assert.notEqual(result, undefined);
      assert.equal(result?.rootTxId, rootBundleId);
      // Should only call metadata query (1 call), bundle lookup uses cache
      assert.equal(mockAxiosInstance.post.mock.callCount(), 1);
    });
  });

  describe('non-blocking rate limiting', () => {
    it('should skip gateway when rate limited', async () => {
      const dataItemId = 'test-data-item-rate-limited';

      let callCount = 0;
      const mockAxiosInstance = {
        post: mock.fn(() => {
          callCount++;
          return Promise.resolve({
            status: 200,
            data: {
              data: {
                transaction: null,
              },
            },
          });
        }),
        defaults: { raxConfig: {} },
        interceptors: {
          request: { use: mock.fn(), eject: mock.fn() },
          response: { use: mock.fn(), eject: mock.fn() },
        },
      };

      mock.method(axios, 'create', () => mockAxiosInstance);

      // Create index with rate limiter, then consume all tokens
      const graphqlIndex = new GraphQLRootTxIndex({
        log,
        trustedGatewaysUrls: {
          'https://gateway1.example.com/graphql': 1,
          'https://gateway2.example.com/graphql': 1,
        },
        rateLimitBurstSize: 1,
        rateLimitTokensPerInterval: 1,
        rateLimitInterval: 'second',
      });

      // Wait for token to accumulate then consume it
      await new Promise((resolve) => setTimeout(resolve, 1100));
      // @ts-expect-error - accessing private property for testing
      graphqlIndex.limiter.tryRemoveTokens(1);

      const result = await graphqlIndex.getRootTx(dataItemId);

      // Should return undefined without making any requests
      assert.equal(result, undefined);
      assert.equal(
        callCount,
        0,
        'Should not make any requests when rate limited',
      );
    });

    it('should proceed when tokens are available', async () => {
      const dataItemId = 'test-data-item-with-tokens';
      const rootBundleId = 'root-bundle-456';

      const mockAxiosInstance = {
        post: mock.fn((url: string, body: any) => {
          if (body.query.includes('getMetadata')) {
            return Promise.resolve({
              status: 200,
              data: {
                data: {
                  transaction: {
                    id: dataItemId,
                    data: {
                      type: 'text/plain',
                      size: '5000',
                    },
                  },
                },
              },
            });
          } else if (
            body.query.includes('getBundleParent') &&
            body.variables.id === dataItemId
          ) {
            return Promise.resolve({
              status: 200,
              data: {
                data: {
                  transaction: {
                    id: dataItemId,
                    bundledIn: {
                      id: rootBundleId,
                    },
                  },
                },
              },
            });
          } else if (
            body.query.includes('getBundleParent') &&
            body.variables.id === rootBundleId
          ) {
            return Promise.resolve({
              status: 200,
              data: {
                data: {
                  transaction: {
                    id: rootBundleId,
                    bundledIn: null,
                  },
                },
              },
            });
          }
          return Promise.reject(new Error('Unexpected query'));
        }),
        defaults: { raxConfig: {} },
        interceptors: {
          request: { use: mock.fn(), eject: mock.fn() },
          response: { use: mock.fn(), eject: mock.fn() },
        },
      };

      mock.method(axios, 'create', () => mockAxiosInstance);

      const graphqlIndex = new GraphQLRootTxIndex({
        log,
        trustedGatewaysUrls: {
          'https://arweave-search.goldsky.com': 1,
        },
        rateLimitBurstSize: 10,
        rateLimitTokensPerInterval: 100,
        rateLimitInterval: 'second',
      });

      // Prefill rate limiter to avoid waiting for token bucket refill
      (graphqlIndex as any)['limiter'].content = (graphqlIndex as any)[
        'limiter'
      ].bucketSize;

      const result = await graphqlIndex.getRootTx(dataItemId);

      assert.notEqual(result, undefined);
      assert.equal(result?.rootTxId, rootBundleId);
    });

    it('should not block waiting for tokens', async () => {
      const dataItemId = 'test-data-item-no-block';

      const mockAxiosInstance = {
        post: mock.fn(() =>
          Promise.reject(new Error('Should not be called when rate limited')),
        ),
        defaults: { raxConfig: {} },
        interceptors: {
          request: { use: mock.fn(), eject: mock.fn() },
          response: { use: mock.fn(), eject: mock.fn() },
        },
      };

      mock.method(axios, 'create', () => mockAxiosInstance);

      const graphqlIndex = new GraphQLRootTxIndex({
        log,
        trustedGatewaysUrls: {
          'https://arweave-search.goldsky.com': 1,
        },
        rateLimitBurstSize: 1,
        rateLimitTokensPerInterval: 1,
        rateLimitInterval: 'second',
      });

      // Wait for token to accumulate then consume it
      await new Promise((resolve) => setTimeout(resolve, 1100));
      // @ts-expect-error - accessing private property for testing
      graphqlIndex.limiter.tryRemoveTokens(1);

      const start = Date.now();
      await graphqlIndex.getRootTx(dataItemId);
      const elapsed = Date.now() - start;

      // Should return immediately (< 100ms) without waiting
      assert(
        elapsed < 100,
        `Should return immediately when rate limited, took ${elapsed}ms`,
      );
    });

    it('should skip gateways when rate limit is exhausted', async () => {
      const dataItemId = 'test-data-item-multi-gateway';

      let callCount = 0;
      const mockAxiosInstance = {
        post: mock.fn(() => {
          callCount++;
          return Promise.resolve({
            status: 200,
            data: {
              data: {
                transaction: null,
              },
            },
          });
        }),
        defaults: { raxConfig: {} },
        interceptors: {
          request: { use: mock.fn(), eject: mock.fn() },
          response: { use: mock.fn(), eject: mock.fn() },
        },
      };

      mock.method(axios, 'create', () => mockAxiosInstance);

      //Create index with rate limiter, then consume all tokens
      const graphqlIndex = new GraphQLRootTxIndex({
        log,
        trustedGatewaysUrls: {
          'https://gateway1.example.com/graphql': 1,
          'https://gateway2.example.com/graphql': 1,
          'https://gateway3.example.com/graphql': 1,
        },
        rateLimitBurstSize: 1,
        rateLimitTokensPerInterval: 1,
        rateLimitInterval: 'second',
      });

      // Wait for token to accumulate then consume it
      await new Promise((resolve) => setTimeout(resolve, 1100));
      // @ts-expect-error - accessing private property for testing
      graphqlIndex.limiter.tryRemoveTokens(1);

      await graphqlIndex.getRootTx(dataItemId);

      // Should not call any gateways when no tokens available
      assert.equal(
        callCount,
        0,
        'Should not call any gateways when rate limited',
      );
    });
  });

  // Indexers do not reliably populate `data.type` for bundled data items —
  // arweave.net returns null for it on ArDrive uploads whose `Content-Type`
  // tag is present and correct. Returning no content type here is not a
  // harmless gap: the caller is resolving an item this gateway has not
  // indexed, and with nothing to report the item gets served with the content
  // type of the bundle around it. Fall back to the tag `data.type` derives
  // from.
  describe('content type resolution', () => {
    const dataItemId = 'ct-fallback-item';
    const rootBundleId = 'ct-fallback-root';

    const stubAxios = (node: Record<string, unknown>) => {
      const mockAxiosInstance = {
        post: mock.fn((_url: string, body: any) => {
          if (body.query.includes('getBundleParents')) {
            // Batched path: one query answers both parent and metadata.
            return Promise.resolve({
              status: 200,
              data: {
                data: {
                  transactions: {
                    edges: [
                      { node: { id: dataItemId, ...node, bundledIn: null } },
                    ],
                  },
                },
              },
            });
          }
          if (body.query.includes('getMetadata')) {
            return Promise.resolve({
              status: 200,
              data: { data: { transaction: { id: dataItemId, ...node } } },
            });
          }
          if (body.query.includes('getBundleParent')) {
            return Promise.resolve({
              status: 200,
              data: {
                data: {
                  transaction: {
                    id: body.variables.id,
                    bundledIn:
                      body.variables.id === dataItemId
                        ? { id: rootBundleId }
                        : null,
                  },
                },
              },
            });
          }
          return Promise.reject(new Error('Unexpected query'));
        }),
        defaults: { raxConfig: {} },
        interceptors: {
          request: { use: mock.fn(), eject: mock.fn() },
          response: { use: mock.fn(), eject: mock.fn() },
        },
      };
      mock.method(axios, 'create', () => mockAxiosInstance);
      return mockAxiosInstance;
    };

    const buildIndex = (batchEnabled: boolean) => {
      const graphqlIndex = new GraphQLRootTxIndex({
        log,
        trustedGatewaysUrls: { 'https://arweave-search.goldsky.com': 1 },
        rateLimitBurstSize: 100,
        rateLimitTokensPerInterval: 100,
        rateLimitInterval: 'second',
        batchEnabled,
      });
      // Prefill rate limiter to avoid waiting for token bucket refill
      (graphqlIndex as any)['limiter'].content = (graphqlIndex as any)[
        'limiter'
      ].bucketSize;
      return graphqlIndex;
    };

    it('falls back to the Content-Type tag when data.type is null', async () => {
      stubAxios({
        data: { type: null, size: '5357' },
        tags: [
          { name: 'Content-Type', value: 'text/html' },
          { name: 'App-Name', value: 'ArDrive-CLI' },
        ],
      });

      const result = await buildIndex(false).getRootTx(dataItemId);

      assert.equal(result?.contentType, 'text/html');
    });

    it('falls back to the Content-Type tag on the batched path', async () => {
      stubAxios({
        data: { type: null, size: '5357' },
        tags: [{ name: 'content-type', value: 'text/html' }],
      });

      const result = await buildIndex(true).getRootTx(dataItemId);

      assert.equal(result?.contentType, 'text/html');
    });

    it('prefers data.type when it is populated', async () => {
      stubAxios({
        data: { type: 'image/png', size: '5357' },
        tags: [{ name: 'Content-Type', value: 'text/html' }],
      });

      const result = await buildIndex(false).getRootTx(dataItemId);

      assert.equal(result?.contentType, 'image/png');
    });

    it('reports no content type when neither is present', async () => {
      stubAxios({ data: { type: null, size: '5357' }, tags: [] });

      const result = await buildIndex(false).getRootTx(dataItemId);

      assert.equal(result?.contentType, undefined);
    });
  });
});
