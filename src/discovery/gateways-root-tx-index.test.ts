/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
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

    it('should handle invalid numeric header values', async () => {
      const dataItemId = 'test-data-item-123';
      const rootTxId = 'root-tx-456';

      const mockAxiosInstance = {
        head: mock.fn(() =>
          Promise.resolve({
            status: 200,
            headers: {
              'x-ar-io-root-transaction-id': rootTxId,
              'x-ar-io-root-data-item-offset': 'invalid', // Invalid offset
              'x-ar-io-root-data-offset': '  ', // Whitespace only
              'content-length': 'NaN', // Invalid length
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
      // All numeric fields should be undefined (not NaN) when headers are invalid
      assert.equal(result.rootOffset, undefined);
      assert.equal(result.rootDataOffset, undefined);
      assert.equal(result.dataSize, undefined);
      assert.equal(result.size, undefined);
      assert.equal(result.contentType, 'text/plain');
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

    describe('HEAD→range-GET fallback', () => {
      it('falls back to range-GET when HEAD returns 405 Method Not Allowed', async () => {
        // Some peers (especially behind CDNs/proxies) reject HEAD on
        // /raw/:id even when the upstream gateway would handle it.
        const dataItemId = 'test-data-item-123';
        const rootTxId = 'root-tx-456';

        const mockAxiosInstance = {
          head: mock.fn(() =>
            Promise.reject({
              response: { status: 405 },
              message: 'Method Not Allowed',
            }),
          ),
          // What a server really sends for `Range: bytes=0-0`: the length of
          // the one returned byte, with the payload size only in the total.
          get: mock.fn(() =>
            Promise.resolve({
              status: 206,
              headers: {
                'x-ar-io-root-transaction-id': rootTxId,
                'x-ar-io-root-data-item-offset': '1000',
                'x-ar-io-root-data-offset': '1500',
                'content-type': 'text/plain',
                'content-length': '1',
                'content-range': 'bytes 0-0/5000',
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
        for (const [, limiter] of (gatewaysIndex as any)['limiters']) {
          limiter.content = limiter.bucketSize;
        }

        const result = await gatewaysIndex.getRootTx(dataItemId);

        assert(result !== undefined);
        assert.equal(result.rootTxId, rootTxId);
        assert.equal(mockAxiosInstance.head.mock.calls.length, 1);
        assert.equal(mockAxiosInstance.get.mock.calls.length, 1);
        // GET must request the smallest legal range so we get headers
        // back without pulling the body.
        const getCall = mockAxiosInstance.get.mock.calls[0];
        assert.deepEqual((getCall.arguments[1] as any).headers, {
          Range: 'bytes=0-0',
        });
        // Sizes come from the Content-Range total, not the 1-byte
        // Content-Length of the range response.
        assert.equal(result.dataSize, 5000);
        assert.equal(result.size, 500 + 5000);
        assert.equal(result.contentType, 'text/plain');
      });

      /** Builds an index whose only gateway rejects HEAD and answers `get`. */
      const indexWithRangeFallback = (getResponse: {
        status: number;
        headers: Record<string, string>;
      }) => {
        const mockAxiosInstance = {
          head: mock.fn(() =>
            Promise.reject({
              response: { status: 405 },
              message: 'Method Not Allowed',
            }),
          ),
          get: mock.fn(() => Promise.resolve(getResponse)),
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
        for (const [, limiter] of (gatewaysIndex as any)['limiters']) {
          limiter.content = limiter.bucketSize;
        }
        return gatewaysIndex;
      };

      it('leaves sizes unknown when a range response has no total', async () => {
        // `bytes 0-0/*` (or no Content-Range at all) says nothing about the
        // payload size. Reporting the 1-byte Content-Length instead would make
        // callers serve and record a single byte as the whole item.
        const gatewaysIndex = indexWithRangeFallback({
          status: 206,
          headers: {
            'x-ar-io-root-transaction-id': 'root-tx-456',
            'x-ar-io-root-data-item-offset': '1000',
            'x-ar-io-root-data-offset': '1500',
            'content-length': '1',
            'content-range': 'bytes 0-0/*',
          },
        });

        const result = await gatewaysIndex.getRootTx('test-data-item-123');

        assert(result !== undefined);
        assert.equal(result.rootTxId, 'root-tx-456');
        assert.equal(result.rootOffset, 1000);
        assert.equal(result.rootDataOffset, 1500);
        assert.equal(result.dataSize, undefined);
        assert.equal(result.size, undefined);
      });

      it('keeps an explicit item size on the range fallback', async () => {
        const gatewaysIndex = indexWithRangeFallback({
          status: 206,
          headers: {
            'x-ar-io-root-transaction-id': 'root-tx-456',
            'x-ar-io-root-item-offset': '1000',
            'x-ar-io-root-data-offset': '1500',
            'x-ar-io-root-item-size': '5500',
            'content-length': '1',
            'content-range': 'bytes 0-0/5000',
          },
        });

        const result = await gatewaysIndex.getRootTx('test-data-item-123');

        assert(result !== undefined);
        assert.equal(result.size, 5500);
        assert.equal(result.dataSize, 5000);
      });

      it('falls back to range-GET when HEAD throws a network error', async () => {
        const dataItemId = 'test-data-item-123';
        const rootTxId = 'root-tx-456';

        const mockAxiosInstance = {
          head: mock.fn(() =>
            Promise.reject(
              Object.assign(new Error('connect ECONNREFUSED'), {
                code: 'ECONNREFUSED',
              }),
            ),
          ),
          get: mock.fn(() =>
            Promise.resolve({
              status: 206,
              headers: {
                'x-ar-io-root-transaction-id': rootTxId,
                'x-ar-io-root-data-item-offset': '1000',
                'x-ar-io-root-data-offset': '1500',
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
        for (const [, limiter] of (gatewaysIndex as any)['limiters']) {
          limiter.content = limiter.bucketSize;
        }

        const result = await gatewaysIndex.getRootTx(dataItemId);

        assert(result !== undefined);
        assert.equal(result.rootTxId, rootTxId);
        assert.equal(mockAxiosInstance.get.mock.calls.length, 1);
      });

      it('does NOT fall back to GET on 404 (peer says item does not exist)', async () => {
        // 404 is a definitive answer; falling back to GET would just
        // hit the same 404 (or worse, mask a real not-found case).
        const dataItemId = 'does-not-exist-123';

        const mockAxiosInstance = {
          head: mock.fn(() =>
            Promise.reject({
              response: { status: 404 },
              message: 'Not found',
            }),
          ),
          get: mock.fn(() => {
            throw new Error('GET should not be called for 404');
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
          trustedGatewaysUrls: { 'https://gateway.example.com': 1 },
          rateLimitBurstSize: 1000,
          rateLimitTokensPerInterval: 1000,
          rateLimitInterval: 'second',
        });
        for (const [, limiter] of (gatewaysIndex as any)['limiters']) {
          limiter.content = limiter.bucketSize;
        }

        const result = await gatewaysIndex.getRootTx(dataItemId);

        assert.equal(result, undefined);
        assert.equal(mockAxiosInstance.head.mock.calls.length, 1);
        assert.equal(mockAxiosInstance.get.mock.calls.length, 0);
      });
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

  describe('range-GET fallback against a real server', () => {
    const ROOT_HEADERS = {
      'X-AR-IO-Root-Transaction-Id': 'root-tx-456',
      'X-AR-IO-Root-Data-Item-Offset': '1000',
      'X-AR-IO-Root-Data-Offset': '1500',
    };

    /**
     * A /raw server that rejects HEAD, as some peers behind CDNs do, so every
     * lookup takes the range-GET fallback. Records each request's client port
     * so tests can tell whether connections were reused.
     */
    const startServer = async (onGet: (res: http.ServerResponse) => void) => {
      const clientPorts: number[] = [];
      const server = http.createServer((req, res) => {
        clientPorts.push(req.socket.remotePort ?? -1);
        if (req.method === 'HEAD') {
          res.writeHead(405, { 'Content-Length': '0' });
          res.end();
          return;
        }
        onGet(res);
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const { port } = server.address() as AddressInfo;
      return {
        url: `http://127.0.0.1:${port}`,
        clientPorts,
        close: async () => {
          server.closeAllConnections();
          await new Promise((resolve) => server.close(resolve));
        },
      };
    };

    /**
     * Streams `total` bytes with backpressure and reports how much the client
     * actually accepted before hanging up.
     */
    const streamLargeBody = (
      res: http.ServerResponse,
      status: number,
      total: number,
      headers: Record<string, string>,
    ) => {
      const progress = { written: 0, finished: false };
      res.writeHead(status, { 'Content-Length': String(total), ...headers });
      const chunk = Buffer.alloc(64 * 1024);
      const write = () => {
        while (progress.written < total) {
          progress.written += chunk.length;
          if (!res.write(chunk)) {
            res.once('drain', write);
            return;
          }
        }
        res.end();
        progress.finished = true;
      };
      write();
      return progress;
    };

    const makeIndex = (url: string) => {
      const index = new GatewaysRootTxIndex({
        log,
        trustedGatewaysUrls: { [url]: 1 },
        requestTimeoutMs: 5000,
        rateLimitBurstSize: 1000,
        rateLimitTokensPerInterval: 1000,
        rateLimitInterval: 'second',
      });
      for (const [, limiter] of (index as any)['limiters']) {
        limiter.content = limiter.bucketSize;
      }
      return index;
    };

    const TOTAL = 64 * 1024 * 1024;

    it('does not download the whole item when the peer ignores the range', async () => {
      let progress = { written: 0, finished: false };
      const server = await startServer((res) => {
        progress = streamLargeBody(res, 200, TOTAL, ROOT_HEADERS);
      });
      try {
        const result = await makeIndex(server.url).getRootTx('item-a');

        assert(result !== undefined);
        assert.equal(result.rootTxId, 'root-tx-456');
        // A 200 carries the whole payload, so Content-Length is its size.
        assert.equal(result.dataSize, TOTAL);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(progress.finished, false);
        assert.ok(
          progress.written < TOTAL / 2,
          `peer sent ${progress.written} of ${TOTAL} bytes`,
        );
      } finally {
        await server.close();
      }
    });

    it('does not download a large error body either', async () => {
      let progress = { written: 0, finished: false };
      const server = await startServer((res) => {
        progress = streamLargeBody(res, 500, TOTAL, {});
      });
      try {
        const result = await makeIndex(server.url).getRootTx('item-a');

        assert.equal(result, undefined);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(progress.finished, false);
        assert.ok(
          progress.written < TOTAL / 2,
          `peer sent ${progress.written} of ${TOTAL} bytes`,
        );
      } finally {
        await server.close();
      }
    });

    it('keeps reusing the connection when the peer honours the range', async () => {
      const server = await startServer((res) => {
        res.writeHead(206, {
          'Content-Length': '1',
          'Content-Range': 'bytes 0-0/5000',
          ...ROOT_HEADERS,
        });
        res.end(Buffer.from('x'));
      });
      try {
        const index = makeIndex(server.url);
        const first = await index.getRootTx('item-a');
        const second = await index.getRootTx('item-b');

        assert.equal(first?.dataSize, 5000);
        assert.equal(second?.dataSize, 5000);
        // HEAD and GET for each lookup, all over one keep-alive connection.
        assert.equal(server.clientPorts.length, 4);
        assert.equal(new Set(server.clientPorts).size, 1);
      } finally {
        await server.close();
      }
    });
  });
});
