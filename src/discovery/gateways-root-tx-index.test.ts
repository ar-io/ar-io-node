/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, describe, it, mock } from 'node:test';
import { LRUCache } from 'lru-cache';
import { GatewaysRootTxIndex } from './gateways-root-tx-index.js';
import axios from 'axios';
import { createTestLogger } from '../../test/test-logger.js';

const log = createTestLogger({ suite: 'GatewaysRootTxIndex' });

describe('GatewaysRootTxIndex', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  describe('constructor', () => {
    it('should implement DataItemRootIndex interface', () => {
      const gatewaysIndex = new GatewaysRootTxIndex({
        log,
        trustedGatewaysUrls: { 'https://gateway.example.com': 1 },
        rateLimitBurstSize: 1000,
        rateLimitTokensPerInterval: 1000,
      });

      assert(typeof gatewaysIndex.getRootTx === 'function');
    });

    it('should accept cache in constructor', () => {
      const cache = new LRUCache<string, any>({
        max: 100,
        ttl: 1000 * 60 * 5,
      });

      const gatewaysIndex = new GatewaysRootTxIndex({
        log,
        trustedGatewaysUrls: { 'https://gateway.example.com': 1 },
        cache,
        rateLimitBurstSize: 1000,
        rateLimitTokensPerInterval: 1000,
      });

      assert(typeof gatewaysIndex.getRootTx === 'function');
    });

    it('should accept request configuration options', () => {
      const gatewaysIndex = new GatewaysRootTxIndex({
        log,
        trustedGatewaysUrls: { 'https://gateway.example.com': 1 },
        requestTimeoutMs: 5000,
        requestRetryCount: 5,
        rateLimitBurstSize: 1000,
        rateLimitTokensPerInterval: 1000,
      });

      assert(typeof gatewaysIndex.getRootTx === 'function');
    });

    it('should throw error if no gateways provided', () => {
      assert.throws(() => {
        new GatewaysRootTxIndex({
          log,
          trustedGatewaysUrls: {},
          rateLimitBurstSize: 1000,
          rateLimitTokensPerInterval: 1000,
        });
      }, /At least one gateway URL must be provided/);
    });

    it('should support multiple gateways with priorities', () => {
      const gatewaysIndex = new GatewaysRootTxIndex({
        log,
        trustedGatewaysUrls: {
          'https://gateway1.example.com': 1,
          'https://gateway2.example.com': 2,
          'https://gateway3.example.com': 1, // Same priority as gateway1
        },
        rateLimitBurstSize: 1000,
        rateLimitTokensPerInterval: 1000,
      });

      assert(typeof gatewaysIndex.getRootTx === 'function');
    });
  });

  describe('getRootTx', () => {
    it('should parse offset headers from HEAD response', async () => {
      const dataItemId = 'test-data-item-123';
      const rootTxId = 'root-tx-456';

      const mockAxiosInstance = {
        head: mock.fn(() =>
          Promise.resolve({
            status: 200,
            headers: {
              'x-ar-io-root-transaction-id': rootTxId,
              'x-ar-io-root-data-item-offset': '1000',
              'x-ar-io-root-data-offset': '1500',
              'content-type': 'text/plain',
              'content-length': '5000',
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

      const gatewaysIndex = new GatewaysRootTxIndex({
        log,
        trustedGatewaysUrls: { 'https://gateway.example.com': 1 },
        rateLimitBurstSize: 1000,
        rateLimitTokensPerInterval: 1000,
        rateLimitInterval: 'second',
      });

      // Prefill rate limiters for all gateways
      for (const [url, limiter] of (gatewaysIndex as any)['limiters']) {
        limiter.content = limiter.bucketSize;
      }

      const result = await gatewaysIndex.getRootTx(dataItemId);

      assert(result !== undefined);
      assert.equal(result.rootTxId, rootTxId);
      assert.equal(result.rootOffset, 1000);
      assert.equal(result.rootDataOffset, 1500);
      assert.equal(result.contentType, 'text/plain');
      // size = (rootDataOffset - rootOffset) + dataSize = (1500 - 1000) + 5000 = 5500
      assert.equal(result.size, 5500);
      assert.equal(result.dataSize, 5000);
      assert.equal(mockAxiosInstance.head.mock.calls.length, 1);
    });

    it('should handle partial offset headers', async () => {
      const dataItemId = 'test-data-item-123';
      const rootTxId = 'root-tx-456';

      const mockAxiosInstance = {
        head: mock.fn(() =>
          Promise.resolve({
            status: 200,
            headers: {
              'x-ar-io-root-transaction-id': rootTxId,
              // Missing offset headers
              'content-type': 'application/json',
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

      const gatewaysIndex = new GatewaysRootTxIndex({
        log,
        trustedGatewaysUrls: { 'https://gateway.example.com': 1 },
        rateLimitBurstSize: 1000,
        rateLimitTokensPerInterval: 1000,
        rateLimitInterval: 'second',
      });

      // Prefill rate limiters for all gateways
      for (const [url, limiter] of (gatewaysIndex as any)['limiters']) {
        limiter.content = limiter.bucketSize;
      }

      const result = await gatewaysIndex.getRootTx(dataItemId);

      assert(result !== undefined);
      assert.equal(result.rootTxId, rootTxId);
      assert.equal(result.rootOffset, undefined);
      assert.equal(result.rootDataOffset, undefined);
      assert.equal(result.contentType, 'application/json');
      assert.equal(mockAxiosInstance.head.mock.calls.length, 1);
    });

    it('should return undefined when no offset headers present', async () => {
      const dataItemId = 'test-data-item-123';

      const mockAxiosInstance = {
        head: mock.fn(() =>
          Promise.resolve({
            status: 200,
            headers: {
              // No x-ar-io-root-transaction-id header
              'content-type': 'text/plain',
              'content-length': '5000',
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

      const gatewaysIndex = new GatewaysRootTxIndex({
        log,
        trustedGatewaysUrls: { 'https://gateway.example.com': 1 },
        rateLimitBurstSize: 1000,
        rateLimitTokensPerInterval: 1000,
        rateLimitInterval: 'second',
      });

      // Prefill rate limiters for all gateways
      for (const [url, limiter] of (gatewaysIndex as any)['limiters']) {
        limiter.content = limiter.bucketSize;
      }

      const result = await gatewaysIndex.getRootTx(dataItemId);

      assert.equal(result, undefined);
      assert.equal(mockAxiosInstance.head.mock.calls.length, 1);
    });

    it('should return undefined for non-existent data item (404)', async () => {
      const nonExistentId = 'does-not-exist-123';

      const mockAxiosInstance = {
        head: mock.fn(() =>
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

      const gatewaysIndex = new GatewaysRootTxIndex({
        log,
        trustedGatewaysUrls: { 'https://gateway.example.com': 1 },
        rateLimitBurstSize: 1000,
        rateLimitTokensPerInterval: 1000,
        rateLimitInterval: 'second',
      });

      // Prefill rate limiters for all gateways
      for (const [url, limiter] of (gatewaysIndex as any)['limiters']) {
        limiter.content = limiter.bucketSize;
      }

      const result = await gatewaysIndex.getRootTx(nonExistentId);

      assert.equal(result, undefined);
      assert.equal(mockAxiosInstance.head.mock.calls.length, 1);
    });

    it('should fallback to next gateway on error', async () => {
      const dataItemId = 'test-data-item-123';
      const rootTxId = 'root-tx-456';
      const gatewaysCalled: string[] = [];

      const mockAxiosInstance = {
        head: mock.fn((url: string) => {
          if (url.includes('gateway1')) {
            gatewaysCalled.push('gateway1');
            // First gateway fails
            return Promise.reject({
              response: { status: 500 },
              message: 'Internal server error',
            });
          } else if (url.includes('gateway2')) {
            gatewaysCalled.push('gateway2');
            // Second gateway succeeds
            return Promise.resolve({
              status: 200,
              headers: {
                'x-ar-io-root-transaction-id': rootTxId,
                'x-ar-io-root-data-item-offset': '1000',
                'x-ar-io-root-data-offset': '1500',
                'content-type': 'text/plain',
              },
            });
          }
          return Promise.reject(new Error('Unexpected gateway'));
        }),
        defaults: { raxConfig: {} },
        interceptors: {
          request: { use: mock.fn(), eject: mock.fn() },
          response: { use: mock.fn(), eject: mock.fn() },
        },
      };

      mock.method(axios, 'create', () => mockAxiosInstance);

      const gatewaysIndex = new GatewaysRootTxIndex({
        log,
        trustedGatewaysUrls: {
          'https://gateway1.example.com': 1, // Higher priority (tried first)
          'https://gateway2.example.com': 2, // Lower priority (tried second)
        },
        requestRetryCount: 0, // Disable retries for this test
        rateLimitBurstSize: 1000,
        rateLimitTokensPerInterval: 1000,
        rateLimitInterval: 'second',
      });

      // Prefill rate limiters for all gateways
      for (const [url, limiter] of (gatewaysIndex as any)['limiters']) {
        limiter.content = limiter.bucketSize;
      }

      const result = await gatewaysIndex.getRootTx(dataItemId);

      assert(result !== undefined);
      assert.equal(result.rootTxId, rootTxId);
      // Should have tried both gateways
      assert(gatewaysCalled.includes('gateway1'), 'Should have tried gateway1');
      assert(gatewaysCalled.includes('gateway2'), 'Should have tried gateway2');
      assert.equal(gatewaysCalled.length, 2, 'Should have tried 2 gateways');
    });

    it('should respect gateway priority tiers', async () => {
      const dataItemId = 'test-data-item-123';
      const callOrder: string[] = [];

      const mockAxiosInstance = {
        head: mock.fn((url: string) => {
          if (url.includes('priority1')) {
            callOrder.push('priority1');
            return Promise.reject({
              response: { status: 500 },
              message: 'Error',
            });
          } else if (url.includes('priority2')) {
            callOrder.push('priority2');
            return Promise.resolve({
              status: 200,
              headers: {
                'x-ar-io-root-transaction-id': 'root-tx',
                'content-type': 'text/plain',
              },
            });
          } else if (url.includes('priority3')) {
            callOrder.push('priority3');
            return Promise.resolve({
              status: 200,
              headers: {
                'x-ar-io-root-transaction-id': 'root-tx',
                'content-type': 'text/plain',
              },
            });
          }
          return Promise.reject(new Error('Unexpected gateway'));
        }),
        defaults: { raxConfig: {} },
        interceptors: {
          request: { use: mock.fn(), eject: mock.fn() },
          response: { use: mock.fn(), eject: mock.fn() },
        },
      };

      mock.method(axios, 'create', () => mockAxiosInstance);

      const gatewaysIndex = new GatewaysRootTxIndex({
        log,
        trustedGatewaysUrls: {
          'https://priority3.example.com': 3, // Lowest priority
          'https://priority1.example.com': 1, // Highest priority
          'https://priority2.example.com': 2, // Middle priority
        },
        rateLimitBurstSize: 1000,
        rateLimitTokensPerInterval: 1000,
        rateLimitInterval: 'second',
      });

      // Prefill rate limiters for all gateways
      for (const [url, limiter] of (gatewaysIndex as any)['limiters']) {
        limiter.content = limiter.bucketSize;
      }

      const result = await gatewaysIndex.getRootTx(dataItemId);

      assert(result !== undefined);
      // Should try priority1 first, then priority2
      assert(
        callOrder[0] === 'priority1',
        `First call should be priority1, got ${callOrder[0]}`,
      );
      assert(
        callOrder[1] === 'priority2',
        `Second call should be priority2, got ${callOrder[1]}`,
      );
      // Should not reach priority3 since priority2 succeeded
      assert(!callOrder.includes('priority3'));
    });

    it('should use cache for repeated lookups', async () => {
      const dataItemId = 'cached-item-123';
      const cache = new LRUCache<string, any>({
        max: 100,
        ttl: 1000 * 60 * 5,
      });

      const mockAxiosInstance = {
        head: mock.fn(() =>
          Promise.resolve({
            status: 200,
            headers: {
              'x-ar-io-root-transaction-id': 'root-tx',
              'x-ar-io-root-data-item-offset': '1000',
              'content-type': 'text/plain',
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

      const gatewaysIndex = new GatewaysRootTxIndex({
        log,
        trustedGatewaysUrls: { 'https://gateway.example.com': 1 },
        cache,
        rateLimitBurstSize: 1000,
        rateLimitTokensPerInterval: 1000,
        rateLimitInterval: 'second',
      });

      // Prefill rate limiters for all gateways
      for (const [url, limiter] of (gatewaysIndex as any)['limiters']) {
        limiter.content = limiter.bucketSize;
      }

      // First call - should hit API
      const result1 = await gatewaysIndex.getRootTx(dataItemId);
      assert(result1 !== undefined);
      assert.equal(mockAxiosInstance.head.mock.calls.length, 1);

      // Second call - should use cache
      const result2 = await gatewaysIndex.getRootTx(dataItemId);
      assert(result2 !== undefined);
      assert.equal(mockAxiosInstance.head.mock.calls.length, 1); // Still 1 - no new API call

      assert.deepEqual(result1, result2);
    });

    it('should use per-gateway rate limiting', async () => {
      const gatewaysCalled: string[] = [];

      const mockAxiosInstance = {
        head: mock.fn((url: string) => {
          if (url.includes('gateway1')) {
            gatewaysCalled.push('gateway1');
            return Promise.resolve({
              status: 200,
              headers: {
                'x-ar-io-root-transaction-id': 'root-tx-1',
                'content-type': 'text/plain',
              },
            });
          } else if (url.includes('gateway2')) {
            gatewaysCalled.push('gateway2');
            return Promise.resolve({
              status: 200,
              headers: {
                'x-ar-io-root-transaction-id': 'root-tx-2',
                'content-type': 'text/plain',
              },
            });
          }
          return Promise.reject(new Error('Unexpected gateway'));
        }),
        defaults: { raxConfig: {} },
        interceptors: {
          request: { use: mock.fn(), eject: mock.fn() },
          response: { use: mock.fn(), eject: mock.fn() },
        },
      };

      mock.method(axios, 'create', () => mockAxiosInstance);

      // Create index with per-gateway rate limit of 1 token each
      const gatewaysIndex = new GatewaysRootTxIndex({
        log,
        trustedGatewaysUrls: {
          'https://gateway1.example.com': 1,
          'https://gateway2.example.com': 1,
        },
        rateLimitBurstSize: 1, // Only 1 token per gateway
        rateLimitTokensPerInterval: 0, // No refills
        rateLimitInterval: 'second',
      });

      // Prefill rate limiters for all gateways
      for (const [url, limiter] of (gatewaysIndex as any)['limiters']) {
        limiter.content = limiter.bucketSize;
      }

      // Make 2 requests - each gateway should be able to serve 1 request
      await gatewaysIndex.getRootTx('item-1');
      await gatewaysIndex.getRootTx('item-2');

      // Both gateways should have been called once each (per-gateway limiting)
      // With global limiting, only 1 gateway would have been called
      const gateway1Calls = gatewaysCalled.filter(
        (g) => g === 'gateway1',
      ).length;
      const gateway2Calls = gatewaysCalled.filter(
        (g) => g === 'gateway2',
      ).length;

      assert.equal(
        gateway1Calls + gateway2Calls,
        2,
        'Both requests should succeed with per-gateway limits',
      );
      assert(
        gateway1Calls >= 1 || gateway2Calls >= 1,
        'At least one gateway should be used',
      );
    });
  });
});
