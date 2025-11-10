/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import express from 'express';
import { default as request } from 'supertest';

import { createTestLogger } from '../../test/test-logger.js';
import { createRateLimitRouter } from './rate-limit.js';
import type { RateLimiter } from '../limiter/types.js';
import type {
  PaymentProcessor,
  PaymentRequirementsContext,
  PaymentPayload,
  PaymentRequirements,
} from '../payments/types.js';
import type { Request } from 'express';
import * as paymentUtils from '../payments/payment-processor-utils.js';
import * as config from '../config.js';

const log = createTestLogger({ suite: 'Rate limit routes' });

describe('Rate limit routes', () => {
  let app: express.Express;
  let rateLimiter: RateLimiter;
  let paymentProcessor: PaymentProcessor;
  // Read the actual admin key from config at runtime
  let adminKey: string;

  beforeEach(() => {
    // Use the actual ADMIN_API_KEY from config (generated at module load time)
    adminKey = config.ADMIN_API_KEY;

    app = express();

    // Mock rate limiter
    rateLimiter = {
      checkLimit: mock.fn(() =>
        Promise.resolve({
          allowed: true,
          ipTokensConsumed: 0,
          resourceTokensConsumed: 0,
        }),
      ),
      adjustTokens: mock.fn(() => Promise.resolve()),
      isAllowlisted: mock.fn(() => false),
      topOffPaidTokens: mock.fn(() => Promise.resolve()),
      getIpBucketState: mock.fn(() => Promise.resolve(null)),
      getResourceBucketState: mock.fn(() => Promise.resolve(null)),
      topOffPaidTokensForResource: mock.fn(() => Promise.resolve()),
    } as unknown as RateLimiter;

    // Mock payment processor
    paymentProcessor = {
      isBrowserRequest: mock.fn(() => false),
      calculateRequirements: mock.fn(
        (context: PaymentRequirementsContext): PaymentRequirements => ({
          amount: context.contentSize.toString(),
          currency: 'USDC',
          address: 'test-address',
          timestamp: Date.now(),
        }),
      ),
      extractPayment: mock.fn(() => undefined),
      verifyPayment: mock.fn(() =>
        Promise.resolve({
          isValid: true,
        }),
      ),
      settlePayment: mock.fn(() =>
        Promise.resolve({
          success: true,
        }),
      ),
    } as unknown as PaymentProcessor;
  });

  afterEach(() => {
    mock.restoreAll();
  });

  describe('GET /ar-io/rate-limit/ip/:ip', () => {
    it('should return bucket state for valid IP', async () => {
      const bucketState = {
        ip: '192.168.1.1',
        tokens: 100,
        paidTokens: 50,
        capacity: 500,
        refillRate: 5,
        lastRefill: Date.now(),
      };

      mock.method(rateLimiter, 'getIpBucketState', () =>
        Promise.resolve(bucketState),
      );

      const router = createRateLimitRouter({
        log,
        rateLimiter,
        paymentProcessor,
      });
      app.use(router);

      return request(app)
        .get('/ar-io/rate-limit/ip/192.168.1.1')
        .expect(200)
        .then((res: any) => {
          assert.deepEqual(res.body, bucketState);
        });
    });

    it('should return 400 for invalid IP format', async () => {
      const router = createRateLimitRouter({
        log,
        rateLimiter,
        paymentProcessor,
      });
      app.use(router);

      return request(app)
        .get('/ar-io/rate-limit/ip/not-an-ip')
        .expect(400)
        .then((res: any) => {
          assert.equal(res.body.error, 'Invalid IP address format');
        });
    });

    it('should return 404 when bucket does not exist', async () => {
      mock.method(rateLimiter, 'getIpBucketState', () => Promise.resolve(null));

      const router = createRateLimitRouter({
        log,
        rateLimiter,
        paymentProcessor,
      });
      app.use(router);

      return request(app)
        .get('/ar-io/rate-limit/ip/192.168.1.1')
        .expect(404)
        .then((res: any) => {
          assert.equal(res.body.error, 'Bucket not found');
          assert.ok(res.body.message.includes('first request'));
        });
    });

    it('should return 500 on internal error', async () => {
      mock.method(rateLimiter, 'getIpBucketState', () =>
        Promise.reject(new Error('Database error')),
      );

      const router = createRateLimitRouter({
        log,
        rateLimiter,
        paymentProcessor,
      });
      app.use(router);

      return request(app)
        .get('/ar-io/rate-limit/ip/192.168.1.1')
        .expect(500)
        .then((res: any) => {
          assert.equal(res.body.error, 'Internal server error');
        });
    });
  });

  describe('GET /ar-io/rate-limit/resource', () => {
    it('should return bucket state for valid params', async () => {
      const bucketState = {
        method: 'GET',
        host: 'example.com',
        path: '/test',
        tokens: 100,
        paidTokens: 50,
        capacity: 1000,
        refillRate: 10,
        lastRefill: Date.now(),
      };

      mock.method(rateLimiter, 'getResourceBucketState', () =>
        Promise.resolve(bucketState),
      );

      const router = createRateLimitRouter({
        log,
        rateLimiter,
        paymentProcessor,
      });
      app.use(router);

      return request(app)
        .get(
          '/ar-io/rate-limit/resource?path=/test&method=GET&host=example.com',
        )
        .expect(200)
        .then((res: any) => {
          assert.deepEqual(res.body, bucketState);
        });
    });

    it('should return 400 when path is missing', async () => {
      const router = createRateLimitRouter({
        log,
        rateLimiter,
        paymentProcessor,
      });
      app.use(router);

      return request(app)
        .get('/ar-io/rate-limit/resource')
        .expect(400)
        .then((res: any) => {
          assert.equal(res.body.error, 'Missing required parameter: path');
        });
    });

    it('should return 400 when path is empty', async () => {
      const router = createRateLimitRouter({
        log,
        rateLimiter,
        paymentProcessor,
      });
      app.use(router);

      return request(app)
        .get('/ar-io/rate-limit/resource?path=')
        .expect(400)
        .then((res: any) => {
          assert.equal(res.body.error, 'Missing required parameter: path');
        });
    });

    it('should return 400 when host is missing', async () => {
      const router = createRateLimitRouter({
        log,
        rateLimiter,
        paymentProcessor,
      });
      app.use(router);

      return request(app)
        .get('/ar-io/rate-limit/resource?path=/test')
        .set('Host', '') // Explicitly set empty host to override supertest default
        .expect(400)
        .then((res: any) => {
          assert.equal(
            res.body.error,
            'Missing host (provide in query or Host header)',
          );
        });
    });

    it('should use Host header when host query param is missing', async () => {
      const bucketState = {
        method: 'GET',
        host: 'example.com',
        path: '/test',
        tokens: 100,
        paidTokens: 50,
        capacity: 1000,
        refillRate: 10,
        lastRefill: Date.now(),
      };

      mock.method(rateLimiter, 'getResourceBucketState', () =>
        Promise.resolve(bucketState),
      );

      const router = createRateLimitRouter({
        log,
        rateLimiter,
        paymentProcessor,
      });
      app.use(router);

      return request(app)
        .get('/ar-io/rate-limit/resource?path=/test')
        .set('Host', 'example.com')
        .expect(200)
        .then((res: any) => {
          assert.deepEqual(res.body, bucketState);
        });
    });

    it('should default method to GET', async () => {
      const bucketState = {
        method: 'GET',
        host: 'example.com',
        path: '/test',
        tokens: 100,
        paidTokens: 50,
        capacity: 1000,
        refillRate: 10,
        lastRefill: Date.now(),
      };

      const getResourceBucketStateMock = mock.method(
        rateLimiter,
        'getResourceBucketState',
        () => Promise.resolve(bucketState),
      );

      const router = createRateLimitRouter({
        log,
        rateLimiter,
        paymentProcessor,
      });
      app.use(router);

      await request(app)
        .get('/ar-io/rate-limit/resource?path=/test&host=example.com')
        .expect(200);

      // Verify it was called with GET
      assert.equal(
        getResourceBucketStateMock.mock.calls[0].arguments[0],
        'GET',
      );
    });

    it('should return 400 for invalid HTTP method', async () => {
      const router = createRateLimitRouter({
        log,
        rateLimiter,
        paymentProcessor,
      });
      app.use(router);

      return request(app)
        .get(
          '/ar-io/rate-limit/resource?path=/test&method=INVALID&host=example.com',
        )
        .expect(400)
        .then((res: any) => {
          assert.equal(res.body.error, 'Invalid HTTP method');
          assert.ok(Array.isArray(res.body.validMethods));
        });
    });

    it('should return 404 when bucket does not exist', async () => {
      mock.method(rateLimiter, 'getResourceBucketState', () =>
        Promise.resolve(null),
      );

      const router = createRateLimitRouter({
        log,
        rateLimiter,
        paymentProcessor,
      });
      app.use(router);

      return request(app)
        .get('/ar-io/rate-limit/resource?path=/test&host=example.com')
        .expect(404)
        .then((res: any) => {
          assert.equal(res.body.error, 'Bucket not found');
          assert.ok(res.body.message.includes('first request'));
        });
    });

    it('should return 500 on internal error', async () => {
      mock.method(rateLimiter, 'getResourceBucketState', () =>
        Promise.reject(new Error('Database error')),
      );

      const router = createRateLimitRouter({
        log,
        rateLimiter,
        paymentProcessor,
      });
      app.use(router);

      return request(app)
        .get('/ar-io/rate-limit/resource?path=/test&host=example.com')
        .expect(500)
        .then((res: any) => {
          assert.equal(res.body.error, 'Internal server error');
        });
    });
  });

  describe('POST /ar-io/rate-limit/ip/:ip', () => {
    it('should return 400 for invalid IP format', async () => {
      const router = createRateLimitRouter({
        log,
        rateLimiter,
        paymentProcessor,
      });
      app.use(router);

      return request(app)
        .post('/ar-io/rate-limit/ip/invalid-ip-address')
        .expect(400)
        .then((res: any) => {
          assert.equal(res.body.error, 'Invalid IP address format');
        });
    });

    it('should return 401 when no payment or admin auth provided', async () => {
      const router = createRateLimitRouter({
        log,
        rateLimiter,
        paymentProcessor,
      });
      app.use(router);

      return request(app)
        .post('/ar-io/rate-limit/ip/192.168.1.1')
        .expect(401)
        .then((res: any) => {
          assert.equal(res.body.error, 'Unauthorized');
          assert.ok(res.body.message.includes('X-Payment'));
        });
    });

    it.skip('should process valid x402 payment and top up bucket', async () => {
      const bucketState = {
        ip: '192.168.1.1',
        tokens: 200,
        paidTokens: 150,
        capacity: 500,
        refillRate: 5,
        lastRefill: Date.now(),
      };

      mock.method(rateLimiter, 'getIpBucketState', () =>
        Promise.resolve(bucketState),
      );

      // Mock processPaymentAndTopUp for this test
      const processPaymentMock = mock.fn(() =>
        Promise.resolve({
          success: true,
          tokensAdded: 100,
          paymentAmount: '10',
          multiplierApplied: 10,
          responseHeader: 'settlement-response',
        }),
      );
      Object.defineProperty(paymentUtils, 'processPaymentAndTopUp', {
        value: processPaymentMock,
        writable: true,
        configurable: true,
      });

      const router = createRateLimitRouter({
        log,
        rateLimiter,
        paymentProcessor,
      });
      app.use(router);

      return request(app)
        .post('/ar-io/rate-limit/ip/192.168.1.1')
        .set('X-Payment', 'payment-token')
        .expect(200)
        .then((res: any) => {
          assert.equal(
            res.headers['x-payment-response'],
            'settlement-response',
          );
          assert.deepEqual(res.body, {
            ...bucketState,
            topUp: {
              tokensAdded: 100,
              paymentAmount: '10',
              multiplierApplied: 10,
            },
          });
        });
    });

    it.skip('should return 402 when payment verification fails', async () => {
      const processPaymentMock = mock.fn(() =>
        Promise.resolve({
          success: false,
          error: 'Insufficient payment amount',
        }),
      );
      Object.defineProperty(paymentUtils, 'processPaymentAndTopUp', {
        value: processPaymentMock,
        writable: true,
        configurable: true,
      });

      const router = createRateLimitRouter({
        log,
        rateLimiter,
        paymentProcessor,
      });
      app.use(router);

      return request(app)
        .post('/ar-io/rate-limit/ip/192.168.1.1')
        .set('X-Payment', 'payment-token')
        .expect(402)
        .then((res: any) => {
          assert.equal(res.body.error, 'Payment failed');
          assert.ok(res.body.message.includes('Insufficient'));
        });
    });

    it('should process admin top-up with valid paid tokens', async () => {
      const bucketState = {
        ip: '192.168.1.1',
        tokens: 200,
        paidTokens: 150,
        capacity: 500,
        refillRate: 5,
        lastRefill: Date.now(),
      };

      const topOffMock = mock.method(rateLimiter, 'topOffPaidTokens', () =>
        Promise.resolve(),
      );

      mock.method(rateLimiter, 'getIpBucketState', () =>
        Promise.resolve(bucketState),
      );

      const router = createRateLimitRouter({
        log,
        rateLimiter,
        paymentProcessor,
      });
      app.use(router);

      await request(app)
        .post('/ar-io/rate-limit/ip/192.168.1.1')
        .set('Authorization', `Bearer ${adminKey}`)
        .send({ tokens: 100, tokenType: 'paid' })
        .expect(200)
        .then((res: any) => {
          assert.deepEqual(res.body, {
            ...bucketState,
            topUp: {
              tokensAdded: 100,
              tokenType: 'paid',
              multiplierApplied: 1,
            },
          });
        });

      // Verify topOffPaidTokens was called with tokens / 10
      assert.equal(topOffMock.mock.calls.length, 1);
      assert.equal(topOffMock.mock.calls[0].arguments[1], 10); // 100 / 10
    });

    it('should return 400 for admin with invalid tokens value', async () => {
      const router = createRateLimitRouter({
        log,
        rateLimiter,
        paymentProcessor,
      });
      app.use(router);

      await request(app)
        .post('/ar-io/rate-limit/ip/192.168.1.1')
        .set('Authorization', `Bearer ${adminKey}`)
        .send({ tokens: -5, tokenType: 'paid' })
        .expect(400)
        .then((res: any) => {
          assert.equal(res.body.error, 'Invalid tokens value');
        });

      await request(app)
        .post('/ar-io/rate-limit/ip/192.168.1.1')
        .set('Authorization', `Bearer ${adminKey}`)
        .send({ tokens: 'not-a-number', tokenType: 'paid' })
        .expect(400)
        .then((res: any) => {
          assert.equal(res.body.error, 'Invalid tokens value');
        });
    });

    it('should return 400 for admin with invalid tokenType', async () => {
      const router = createRateLimitRouter({
        log,
        rateLimiter,
        paymentProcessor,
      });
      app.use(router);

      return request(app)
        .post('/ar-io/rate-limit/ip/192.168.1.1')
        .set('Authorization', `Bearer ${adminKey}`)
        .send({ tokens: 100, tokenType: 'invalid' })
        .expect(400)
        .then((res: any) => {
          assert.equal(res.body.error, 'Invalid tokenType');
          assert.ok(res.body.message.includes('paid'));
        });
    });

    it('should return 400 for admin with regular tokenType (not yet supported)', async () => {
      const router = createRateLimitRouter({
        log,
        rateLimiter,
        paymentProcessor,
      });
      app.use(router);

      return request(app)
        .post('/ar-io/rate-limit/ip/192.168.1.1')
        .set('Authorization', `Bearer ${adminKey}`)
        .send({ tokens: 100, tokenType: 'regular' })
        .expect(400)
        .then((res: any) => {
          assert.equal(
            res.body.error,
            'Regular token top-up not yet supported',
          );
        });
    });

    it('should return 500 on internal error', async () => {
      mock.method(rateLimiter, 'topOffPaidTokens', () =>
        Promise.reject(new Error('Redis error')),
      );

      const router = createRateLimitRouter({
        log,
        rateLimiter,
        paymentProcessor,
      });
      app.use(router);

      return request(app)
        .post('/ar-io/rate-limit/ip/192.168.1.1')
        .set('Authorization', `Bearer ${adminKey}`)
        .send({ tokens: 100, tokenType: 'paid' })
        .expect(500)
        .then((res: any) => {
          assert.equal(res.body.error, 'Internal server error');
        });
    });
  });

  describe('POST /ar-io/rate-limit/resource', () => {
    it('should return 400 when path is missing', async () => {
      const router = createRateLimitRouter({
        log,
        rateLimiter,
        paymentProcessor,
      });
      app.use(router);

      return request(app)
        .post('/ar-io/rate-limit/resource')
        .expect(400)
        .then((res: any) => {
          assert.equal(res.body.error, 'Missing required parameter: path');
        });
    });

    it('should return 400 when host is missing', async () => {
      const router = createRateLimitRouter({
        log,
        rateLimiter,
        paymentProcessor,
      });
      app.use(router);

      return request(app)
        .post('/ar-io/rate-limit/resource?path=/test')
        .set('Host', '') // Explicitly set empty host to override supertest default
        .expect(400)
        .then((res: any) => {
          assert.equal(
            res.body.error,
            'Missing host (provide in query or Host header)',
          );
        });
    });

    it('should return 400 for invalid HTTP method', async () => {
      const router = createRateLimitRouter({
        log,
        rateLimiter,
        paymentProcessor,
      });
      app.use(router);

      return request(app)
        .post(
          '/ar-io/rate-limit/resource?path=/test&method=INVALID&host=example.com',
        )
        .expect(400)
        .then((res: any) => {
          assert.equal(res.body.error, 'Invalid HTTP method');
        });
    });

    it('should return 401 when no payment or admin auth provided', async () => {
      const router = createRateLimitRouter({
        log,
        rateLimiter,
        paymentProcessor,
      });
      app.use(router);

      return request(app)
        .post('/ar-io/rate-limit/resource?path=/test&host=example.com')
        .expect(401)
        .then((res: any) => {
          assert.equal(res.body.error, 'Unauthorized');
        });
    });

    it.skip('should process valid x402 payment and top up bucket', async () => {
      const bucketState = {
        method: 'GET',
        host: 'example.com',
        path: '/test',
        tokens: 200,
        paidTokens: 150,
        capacity: 1000,
        refillRate: 10,
        lastRefill: Date.now(),
      };

      mock.method(rateLimiter, 'getResourceBucketState', () =>
        Promise.resolve(bucketState),
      );

      const processPaymentMock = mock.fn(() =>
        Promise.resolve({
          success: true,
          tokensAdded: 100,
          paymentAmount: '10',
          multiplierApplied: 10,
          responseHeader: 'settlement-response',
        }),
      );
      Object.defineProperty(paymentUtils, 'processPaymentAndTopUp', {
        value: processPaymentMock,
        writable: true,
        configurable: true,
      });

      const router = createRateLimitRouter({
        log,
        rateLimiter,
        paymentProcessor,
      });
      app.use(router);

      return request(app)
        .post('/ar-io/rate-limit/resource?path=/test&host=example.com')
        .set('X-Payment', 'payment-token')
        .expect(200)
        .then((res: any) => {
          assert.equal(
            res.headers['x-payment-response'],
            'settlement-response',
          );
          assert.deepEqual(res.body, {
            ...bucketState,
            topUp: {
              tokensAdded: 100,
              paymentAmount: '10',
              multiplierApplied: 10,
            },
          });
        });
    });

    it.skip('should return 402 when payment verification fails', async () => {
      const processPaymentMock = mock.fn(() =>
        Promise.resolve({
          success: false,
          error: 'Invalid signature',
        }),
      );
      Object.defineProperty(paymentUtils, 'processPaymentAndTopUp', {
        value: processPaymentMock,
        writable: true,
        configurable: true,
      });

      const router = createRateLimitRouter({
        log,
        rateLimiter,
        paymentProcessor,
      });
      app.use(router);

      return request(app)
        .post('/ar-io/rate-limit/resource?path=/test&host=example.com')
        .set('X-Payment', 'payment-token')
        .expect(402)
        .then((res: any) => {
          assert.equal(res.body.error, 'Payment failed');
          assert.ok(res.body.message.includes('Invalid signature'));
        });
    });

    it('should process admin top-up with valid paid tokens', async () => {
      const bucketState = {
        method: 'POST',
        host: 'example.com',
        path: '/test',
        tokens: 200,
        paidTokens: 150,
        capacity: 1000,
        refillRate: 10,
        lastRefill: Date.now(),
      };

      const topOffMock = mock.method(
        rateLimiter,
        'topOffPaidTokensForResource',
        () => Promise.resolve(),
      );

      mock.method(rateLimiter, 'getResourceBucketState', () =>
        Promise.resolve(bucketState),
      );

      const router = createRateLimitRouter({
        log,
        rateLimiter,
        paymentProcessor,
      });
      app.use(router);

      await request(app)
        .post(
          '/ar-io/rate-limit/resource?path=/test&method=POST&host=example.com',
        )
        .set('Authorization', `Bearer ${adminKey}`)
        .send({ tokens: 100, tokenType: 'paid' })
        .expect(200)
        .then((res: any) => {
          assert.deepEqual(res.body, {
            ...bucketState,
            topUp: {
              tokensAdded: 100,
              tokenType: 'paid',
              multiplierApplied: 1,
            },
          });
        });

      // Verify topOffPaidTokensForResource was called with correct params
      assert.equal(topOffMock.mock.calls.length, 1);
      assert.equal(topOffMock.mock.calls[0].arguments[0], 'POST');
      assert.equal(topOffMock.mock.calls[0].arguments[1], 'example.com');
      assert.equal(topOffMock.mock.calls[0].arguments[2], '/test');
      assert.equal(topOffMock.mock.calls[0].arguments[3], 10); // 100 / 10
    });

    it('should return 400 for admin with invalid tokens value', async () => {
      const router = createRateLimitRouter({
        log,
        rateLimiter,
        paymentProcessor,
      });
      app.use(router);

      await request(app)
        .post('/ar-io/rate-limit/resource?path=/test&host=example.com')
        .set('Authorization', `Bearer ${adminKey}`)
        .send({ tokens: 0, tokenType: 'paid' })
        .expect(400)
        .then((res: any) => {
          assert.equal(res.body.error, 'Invalid tokens value');
        });
    });

    it('should return 400 for admin with invalid tokenType', async () => {
      const router = createRateLimitRouter({
        log,
        rateLimiter,
        paymentProcessor,
      });
      app.use(router);

      return request(app)
        .post('/ar-io/rate-limit/resource?path=/test&host=example.com')
        .set('Authorization', `Bearer ${adminKey}`)
        .send({ tokens: 100, tokenType: 'unknown' })
        .expect(400)
        .then((res: any) => {
          assert.equal(res.body.error, 'Invalid tokenType');
        });
    });

    it('should return 400 for admin with regular tokenType (not yet supported)', async () => {
      const router = createRateLimitRouter({
        log,
        rateLimiter,
        paymentProcessor,
      });
      app.use(router);

      return request(app)
        .post('/ar-io/rate-limit/resource?path=/test&host=example.com')
        .set('Authorization', `Bearer ${adminKey}`)
        .send({ tokens: 100, tokenType: 'regular' })
        .expect(400)
        .then((res: any) => {
          assert.equal(
            res.body.error,
            'Regular token top-up not yet supported',
          );
        });
    });

    it('should return 500 on internal error', async () => {
      mock.method(rateLimiter, 'topOffPaidTokensForResource', () =>
        Promise.reject(new Error('Database error')),
      );

      const router = createRateLimitRouter({
        log,
        rateLimiter,
        paymentProcessor,
      });
      app.use(router);

      return request(app)
        .post('/ar-io/rate-limit/resource?path=/test&host=example.com')
        .set('Authorization', `Bearer ${adminKey}`)
        .send({ tokens: 100, tokenType: 'paid' })
        .expect(500)
        .then((res: any) => {
          assert.equal(res.body.error, 'Internal server error');
        });
    });
  });
});
