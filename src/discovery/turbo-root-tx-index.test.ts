/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, describe, it, mock } from 'node:test';
import winston from 'winston';
import { LRUCache } from 'lru-cache';
import { TurboRootTxIndex } from './turbo-root-tx-index.js';
import axios from 'axios';

const log = winston.createLogger({ silent: true });

describe('TurboRootTxIndex', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  describe('constructor', () => {
    it('should implement DataItemRootIndex interface', () => {
      const turboIndex = new TurboRootTxIndex({
        log,
        turboEndpoint: 'https://turbo.example.com',
        rateLimitBurstSize: 1000,
        rateLimitTokensPerInterval: 1000,
      });

      assert(typeof turboIndex.getRootTx === 'function');
    });

    it('should accept cache in constructor', () => {
      const cache = new LRUCache<
        string,
        {
          parentDataItemId?: string;
          rootBundleId?: string;
          startOffsetInParentDataItemPayload?: number;
          startOffsetInRootBundle?: number;
          rawContentLength: number;
          payloadContentType: string;
          payloadDataStart: number;
          payloadContentLength: number;
        }
      >({
        max: 100,
        ttl: 1000 * 60 * 5,
      });

      const turboIndex = new TurboRootTxIndex({
        log,
        turboEndpoint: 'https://turbo.example.com',
        cache,
        rateLimitBurstSize: 1000,
        rateLimitTokensPerInterval: 1000,
      });

      assert(typeof turboIndex.getRootTx === 'function');
    });

    it('should use default endpoint when not provided', () => {
      const turboIndex = new TurboRootTxIndex({
        log,
        rateLimitBurstSize: 1000,
        rateLimitTokensPerInterval: 1000,
      });

      assert(typeof turboIndex.getRootTx === 'function');
    });

    it('should accept request configuration options', () => {
      const turboIndex = new TurboRootTxIndex({
        log,
        turboEndpoint: 'https://turbo.example.com',
        requestTimeoutMs: 5000,
        requestRetryCount: 5,
        rateLimitBurstSize: 1000,
        rateLimitTokensPerInterval: 1000,
      });

      assert(typeof turboIndex.getRootTx === 'function');
    });
  });

  describe('getRootTx', () => {
    it('should resolve single-level data item with root bundle', async () => {
      const dataItemId = 'test-data-item-123';
      const rootBundleId = 'root-bundle-456';

      const mockAxiosInstance = {
        get: mock.fn(() =>
          Promise.resolve({
            status: 200,
            data: {
              rootBundleId,
              startOffsetInRootBundle: 1000,
              rawContentLength: 5000,
              payloadContentType: 'text/plain',
              payloadDataStart: 100,
              payloadContentLength: 4900,
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

      const turboIndex = new TurboRootTxIndex({
        log,
        turboEndpoint: 'https://turbo.example.com',
        rateLimitBurstSize: 1000,
        rateLimitTokensPerInterval: 1000,
        rateLimitInterval: 'second',
      });

      // Prefill rate limiter to avoid waiting for token bucket refill
      (turboIndex as any)['limiter'].content = (turboIndex as any)[
        'limiter'
      ].bucketSize;

      const result = await turboIndex.getRootTx(dataItemId);

      assert(result !== undefined);
      assert.equal(result.rootTxId, rootBundleId);
      assert.equal(result.rootOffset, 1000);
      assert.equal(result.rootDataOffset, 1100); // 1000 + 100
      assert.equal(result.contentType, 'text/plain');
      assert.equal(result.size, 5000);
      assert.equal(result.dataSize, 4900);
      assert.equal(mockAxiosInstance.get.mock.calls.length, 1);
    });

    it('should resolve multi-level nested data items with parent traversal', async () => {
      const childId = 'child-123';
      const parentId = 'parent-456';
      const rootBundleId = 'root-789';

      // Mock responses for child → parent → root chain
      const mockAxiosInstance = {
        get: mock.fn((url: string) => {
          if (url.includes(childId)) {
            return Promise.resolve({
              status: 200,
              data: {
                parentDataItemId: parentId,
                startOffsetInParentDataItemPayload: 96,
                rawContentLength: 6205,
                payloadContentType: 'text/plain; charset=utf-8',
                payloadDataStart: 1085,
                payloadContentLength: 5120,
              },
            });
          } else if (url.includes(parentId)) {
            return Promise.resolve({
              status: 200,
              data: {
                rootBundleId,
                startOffsetInRootBundle: 3731704,
                rawContentLength: 7427,
                payloadContentType: 'application/octet-stream',
                payloadDataStart: 1126,
                payloadContentLength: 6301,
              },
            });
          }
          return Promise.reject(new Error('Unexpected ID'));
        }),
        defaults: { raxConfig: {} },
        interceptors: {
          request: { use: mock.fn(), eject: mock.fn() },
          response: { use: mock.fn(), eject: mock.fn() },
        },
      };

      mock.method(axios, 'create', () => mockAxiosInstance);

      const turboIndex = new TurboRootTxIndex({
        log,
        turboEndpoint: 'https://turbo.example.com',
        rateLimitBurstSize: 1000,
        rateLimitTokensPerInterval: 1000,
        rateLimitInterval: 'second',
      });

      // Prefill rate limiter to avoid waiting for token bucket refill
      (turboIndex as any)['limiter'].content = (turboIndex as any)[
        'limiter'
      ].bucketSize;

      const result = await turboIndex.getRootTx(childId);

      assert(result !== undefined);
      assert.equal(result.rootTxId, rootBundleId);
      // rootOffset = 3731704 (root) + 1126 (parent payload start) + 96 (child in parent)
      assert.equal(result.rootOffset, 3732926);
      // rootDataOffset = rootOffset + child payload start
      assert.equal(result.rootDataOffset, 3734011); // 3732926 + 1085
      assert.equal(result.contentType, 'text/plain; charset=utf-8');
      assert.equal(result.size, 6205);
      assert.equal(result.dataSize, 5120);
      assert.equal(mockAxiosInstance.get.mock.calls.length, 2);
    });

    it('should detect L1 transaction (no parent, no root)', async () => {
      const l1TxId = 'l1-transaction-abc';

      const mockAxiosInstance = {
        get: mock.fn(() =>
          Promise.resolve({
            status: 200,
            data: {
              // No parentDataItemId, no rootBundleId = L1 transaction
              rawContentLength: 10000,
              payloadContentType: 'application/octet-stream',
              payloadDataStart: 500,
              payloadContentLength: 9500,
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

      const turboIndex = new TurboRootTxIndex({
        log,
        turboEndpoint: 'https://turbo.example.com',
        rateLimitBurstSize: 1000,
        rateLimitTokensPerInterval: 1000,
        rateLimitInterval: 'second',
      });

      // Prefill rate limiter to avoid waiting for token bucket refill
      (turboIndex as any)['limiter'].content = (turboIndex as any)[
        'limiter'
      ].bucketSize;

      const result = await turboIndex.getRootTx(l1TxId);

      assert(result !== undefined);
      assert.equal(result.rootTxId, l1TxId);
      assert.equal(result.rootOffset, undefined);
      assert.equal(result.rootDataOffset, undefined);
      assert.equal(result.contentType, 'application/octet-stream');
      assert.equal(result.size, 10000);
      assert.equal(result.dataSize, 9500);
      assert.equal(mockAxiosInstance.get.mock.calls.length, 1);
    });

    it('should return undefined for non-existent data item (404)', async () => {
      const nonExistentId = 'does-not-exist-123';

      const mockAxiosInstance = {
        get: mock.fn(() =>
          Promise.reject({
            response: { status: 404 },
            message: 'Not found',
          }),
        ),
        defaults: { raxConfig: {} },
        interceptors: {
          request: { use: mock.fn(), eject: mock.fn() },
          response: { use: mock.fn(), eject: mock.fn() },
        },
      };

      mock.method(axios, 'create', () => mockAxiosInstance);

      const turboIndex = new TurboRootTxIndex({
        log,
        turboEndpoint: 'https://turbo.example.com',
        rateLimitBurstSize: 1000,
        rateLimitTokensPerInterval: 1000,
        rateLimitInterval: 'second',
      });

      // Prefill rate limiter to avoid waiting for token bucket refill
      (turboIndex as any)['limiter'].content = (turboIndex as any)[
        'limiter'
      ].bucketSize;

      const result = await turboIndex.getRootTx(nonExistentId);

      assert.equal(result, undefined);
      assert.equal(mockAxiosInstance.get.mock.calls.length, 1);
    });

    it('should detect and handle circular references', async () => {
      const id1 = 'circular-1';
      const id2 = 'circular-2';

      // Create circular reference: id1 → id2 → id1
      const mockAxiosInstance = {
        get: mock.fn((url: string) => {
          if (url.includes(id1)) {
            return Promise.resolve({
              status: 200,
              data: {
                parentDataItemId: id2,
                startOffsetInParentDataItemPayload: 100,
                rawContentLength: 1000,
                payloadContentType: 'text/plain',
                payloadDataStart: 50,
                payloadContentLength: 950,
              },
            });
          } else if (url.includes(id2)) {
            return Promise.resolve({
              status: 200,
              data: {
                parentDataItemId: id1, // Circular reference back to id1
                startOffsetInParentDataItemPayload: 200,
                rawContentLength: 2000,
                payloadContentType: 'text/plain',
                payloadDataStart: 60,
                payloadContentLength: 1940,
              },
            });
          }
          return Promise.reject(new Error('Unexpected ID'));
        }),
        defaults: { raxConfig: {} },
        interceptors: {
          request: { use: mock.fn(), eject: mock.fn() },
          response: { use: mock.fn(), eject: mock.fn() },
        },
      };

      mock.method(axios, 'create', () => mockAxiosInstance);

      const turboIndex = new TurboRootTxIndex({
        log,
        turboEndpoint: 'https://turbo.example.com',
        rateLimitBurstSize: 1000,
        rateLimitTokensPerInterval: 1000,
        rateLimitInterval: 'second',
      });

      // Prefill rate limiter to avoid waiting for token bucket refill
      (turboIndex as any)['limiter'].content = (turboIndex as any)[
        'limiter'
      ].bucketSize;

      const result = await turboIndex.getRootTx(id1);

      // Should detect cycle and return undefined
      assert.equal(result, undefined);
      assert.equal(mockAxiosInstance.get.mock.calls.length, 2);
    });

    it('should respect max depth limit', async () => {
      // Create a chain longer than MAX_DEPTH (10)
      const depth = 15;
      const ids = Array.from({ length: depth + 1 }, (_, i) => `level-${i}`);

      const mockAxiosInstance = {
        get: mock.fn((url: string) => {
          for (let i = 0; i < ids.length; i++) {
            if (url.includes(ids[i])) {
              if (i === ids.length - 1) {
                // Last item in chain - should be root
                return Promise.resolve({
                  status: 200,
                  data: {
                    rootBundleId: 'root-bundle',
                    startOffsetInRootBundle: 1000,
                    rawContentLength: 500,
                    payloadContentType: 'text/plain',
                    payloadDataStart: 50,
                    payloadContentLength: 450,
                  },
                });
              } else {
                // Point to next in chain
                return Promise.resolve({
                  status: 200,
                  data: {
                    parentDataItemId: ids[i + 1],
                    startOffsetInParentDataItemPayload: 100,
                    rawContentLength: 500,
                    payloadContentType: 'text/plain',
                    payloadDataStart: 50,
                    payloadContentLength: 450,
                  },
                });
              }
            }
          }
          return Promise.reject(new Error('Unexpected ID'));
        }),
        defaults: { raxConfig: {} },
        interceptors: {
          request: { use: mock.fn(), eject: mock.fn() },
          response: { use: mock.fn(), eject: mock.fn() },
        },
      };

      mock.method(axios, 'create', () => mockAxiosInstance);

      const turboIndex = new TurboRootTxIndex({
        log,
        turboEndpoint: 'https://turbo.example.com',
        rateLimitBurstSize: 1000,
        rateLimitTokensPerInterval: 1000,
        rateLimitInterval: 'second',
      });

      // Prefill rate limiter to avoid waiting for token bucket refill
      (turboIndex as any)['limiter'].content = (turboIndex as any)[
        'limiter'
      ].bucketSize;

      const result = await turboIndex.getRootTx('level-0');

      // Should abort at max depth and return undefined
      assert.equal(result, undefined);
      assert.equal(mockAxiosInstance.get.mock.calls.length, 10); // MAX_DEPTH
    });

    it('should use cache for repeated lookups', async () => {
      const dataItemId = 'cached-item-123';
      const cache = new LRUCache<string, any>({
        max: 100,
        ttl: 1000 * 60 * 5,
      });

      const mockAxiosInstance = {
        get: mock.fn(() =>
          Promise.resolve({
            status: 200,
            data: {
              rootBundleId: 'root-bundle',
              startOffsetInRootBundle: 1000,
              rawContentLength: 5000,
              payloadContentType: 'text/plain',
              payloadDataStart: 100,
              payloadContentLength: 4900,
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

      const turboIndex = new TurboRootTxIndex({
        log,
        turboEndpoint: 'https://turbo.example.com',
        cache,
        rateLimitBurstSize: 1000,
        rateLimitTokensPerInterval: 1000,
        rateLimitInterval: 'second',
      });

      // Prefill rate limiter to avoid waiting for token bucket refill
      (turboIndex as any)['limiter'].content = (turboIndex as any)[
        'limiter'
      ].bucketSize;

      // First call - should hit API
      const result1 = await turboIndex.getRootTx(dataItemId);
      assert(result1 !== undefined);
      assert.equal(mockAxiosInstance.get.mock.calls.length, 1);

      // Second call - should use cache
      const result2 = await turboIndex.getRootTx(dataItemId);
      assert(result2 !== undefined);
      assert.equal(mockAxiosInstance.get.mock.calls.length, 1); // Still 1 - no new API call

      assert.deepEqual(result1, result2);
    });

    it('should calculate correct offsets for 3-level nesting', async () => {
      const level1Id = 'level1';
      const level2Id = 'level2';
      const level3Id = 'level3';
      const rootId = 'root';

      // Create 3-level chain: level1 → level2 → level3 → root
      const mockAxiosInstance = {
        get: mock.fn((url: string) => {
          if (url.includes(level1Id)) {
            return Promise.resolve({
              status: 200,
              data: {
                parentDataItemId: level2Id,
                startOffsetInParentDataItemPayload: 10,
                rawContentLength: 100,
                payloadContentType: 'text/plain',
                payloadDataStart: 5,
                payloadContentLength: 95,
              },
            });
          } else if (url.includes(level2Id)) {
            return Promise.resolve({
              status: 200,
              data: {
                parentDataItemId: level3Id,
                startOffsetInParentDataItemPayload: 20,
                rawContentLength: 200,
                payloadContentType: 'text/plain',
                payloadDataStart: 10,
                payloadContentLength: 190,
              },
            });
          } else if (url.includes(level3Id)) {
            return Promise.resolve({
              status: 200,
              data: {
                rootBundleId: rootId,
                startOffsetInRootBundle: 1000,
                rawContentLength: 300,
                payloadContentType: 'text/plain',
                payloadDataStart: 15,
                payloadContentLength: 285,
              },
            });
          }
          return Promise.reject(new Error('Unexpected ID'));
        }),
        defaults: { raxConfig: {} },
        interceptors: {
          request: { use: mock.fn(), eject: mock.fn() },
          response: { use: mock.fn(), eject: mock.fn() },
        },
      };

      mock.method(axios, 'create', () => mockAxiosInstance);

      const turboIndex = new TurboRootTxIndex({
        log,
        turboEndpoint: 'https://turbo.example.com',
        rateLimitBurstSize: 1000,
        rateLimitTokensPerInterval: 1000,
        rateLimitInterval: 'second',
      });

      // Prefill rate limiter to avoid waiting for token bucket refill
      (turboIndex as any)['limiter'].content = (turboIndex as any)[
        'limiter'
      ].bucketSize;

      const result = await turboIndex.getRootTx(level1Id);

      assert(result !== undefined);
      assert.equal(result.rootTxId, rootId);
      // Calculation:
      // Start: 1000 (level3 in root)
      // + 15 (level3 payload start)
      // + 20 (level2 in level3 payload)
      // + 10 (level2 payload start)
      // + 10 (level1 in level2 payload)
      // = 1055
      assert.equal(result.rootOffset, 1055);
      // rootDataOffset = rootOffset + level1 payload start
      assert.equal(result.rootDataOffset, 1060); // 1055 + 5
      assert.equal(result.size, 100);
      assert.equal(result.dataSize, 95);
      assert.equal(mockAxiosInstance.get.mock.calls.length, 3);
    });

    it('should return undefined when rate limited (non-blocking)', async () => {
      const dataItemId = 'rate-limited-item';
      let callCount = 0;

      const mockAxiosInstance = {
        get: mock.fn(() => {
          callCount++;
          return Promise.resolve({
            status: 200,
            data: {
              rootBundleId: 'root',
              startOffsetInRootBundle: 1000,
              rawContentLength: 5000,
              payloadContentType: 'text/plain',
              payloadDataStart: 100,
              payloadContentLength: 4900,
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

      // Create index with restrictive rate limit
      const turboIndex = new TurboRootTxIndex({
        log,
        turboEndpoint: 'https://turbo.example.com',
        rateLimitBurstSize: 2, // Only 2 tokens available
        rateLimitTokensPerInterval: 2, // Refill 2 tokens per second
        rateLimitInterval: 'second',
      });

      // Prefill rate limiter to avoid waiting for token bucket refill
      (turboIndex as any)['limiter'].content = (turboIndex as any)[
        'limiter'
      ].bucketSize;

      // First two requests should succeed (using 2 tokens)
      const result1 = await turboIndex.getRootTx(`${dataItemId}-1`);
      assert(result1 !== undefined, 'First request should succeed');

      const result2 = await turboIndex.getRootTx(`${dataItemId}-2`);
      assert(result2 !== undefined, 'Second request should succeed');

      // Third request should be rate limited and return undefined immediately
      const start = Date.now();
      const result3 = await turboIndex.getRootTx(`${dataItemId}-3`);
      const elapsed = Date.now() - start;

      assert.equal(
        result3,
        undefined,
        'Third request should return undefined when rate limited',
      );
      assert(elapsed < 100, `Should return immediately, took ${elapsed}ms`);
      assert.equal(
        callCount,
        2,
        'Should have made only 2 API calls (third was rate limited)',
      );
    });
  });
});
