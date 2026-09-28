/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it, mock } from 'node:test';
import type { Request, Response } from 'express';

import type { RateLimiter } from '../limiter/types.js';
import type { PaymentProcessor } from '../payments/types.js';

// config.ts reads this once at load, and the limiter branch is skipped
// without it. Each test file runs in its own process, so this cannot leak.
process.env.ENABLE_RATE_LIMITER = 'true';
const { checkPaymentAndRateLimits } = await import('./data-handler-utils.js');
const { MemoryRateLimiter } = await import('../limiter/memory-rate-limiter.js');

const createRequest = (): Request => {
  const headers: Record<string, string> = { host: 'gateway.example.com' };
  return {
    method: 'GET',
    protocol: 'https',
    originalUrl: '/raw/abc',
    headers,
    header: (name: string) => headers[name.toLowerCase()],
    socket: { remoteAddress: '203.0.113.7' },
  } as unknown as Request;
};

const createResponse = () => {
  const res: any = { statusCode: 200, body: undefined };
  res.status = mock.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = mock.fn((body: unknown) => {
    res.body = body;
    return res;
  });
  return res as Response & { statusCode: number; body: any };
};

const deniedLimiter = () =>
  ({
    isAllowlisted: mock.fn(() => false),
    checkLimit: mock.fn(() =>
      Promise.resolve({ allowed: false, limitType: 'ip' }),
    ),
  }) as unknown as RateLimiter;

const processor = (calculateRequirements: () => unknown) =>
  ({
    isBrowserRequest: mock.fn(() => false),
    calculateRequirements: mock.fn(calculateRequirements),
    extractPayment: mock.fn(() => undefined),
    sendPaymentRequiredResponse: mock.fn((_req: Request, res: Response) => {
      res.status(402).json({ error: 'Payment Required' });
    }),
  }) as unknown as PaymentProcessor;

describe('checkPaymentAndRateLimits', () => {
  describe('the allowlist', () => {
    // A real limiter: one 400-token request exhausts a client's bucket.
    const limiter = () =>
      new MemoryRateLimiter({
        resourceCapacity: 1_000_000,
        resourceRefillRate: 0,
        ipCapacity: 500,
        ipRefillRate: 0,
        limitsEnabled: true,
        ipAllowlist: ['10.20.30.40'],
        capacityMultiplier: 1,
        maxBuckets: 100,
      });
    // Through nginx on the private network (trusted by default).
    const viaProxy = (forwardedFor: string): Request => {
      const req = createRequest();
      (req.headers as Record<string, string>)['x-forwarded-for'] = forwardedFor;
      (req as any).socket = { remoteAddress: '10.0.0.1' };
      return req;
    };
    const check = (rateLimiter: RateLimiter, req: Request) =>
      checkPaymentAndRateLimits({
        req,
        res: createResponse(),
        id: 'abc',
        contentSize: 400 * 1024,
        requestAttributes: { hops: 0, clientIps: [] },
        rateLimiter,
      });

    it('exempts an allowlisted client that a trusted proxy recorded', async () => {
      const rateLimiter = limiter();
      for (let i = 0; i < 3; i++) {
        assert.equal(
          (await check(rateLimiter, viaProxy('10.20.30.40'))).allowed,
          true,
        );
      }
    });

    it('does not exempt a client that only claims an allowlisted address', async () => {
      // The client wrote 10.20.30.40; nginx appended the real 198.18.0.99.
      const rateLimiter = limiter();
      const spoof = () => viaProxy('10.20.30.40, 198.18.0.99');
      assert.equal((await check(rateLimiter, spoof())).allowed, true);
      assert.equal(
        (await check(rateLimiter, spoof())).allowed,
        false,
        'limited like anyone else',
      );
    });
  });

  it('answers 402 when the limit is exceeded and a price can be quoted', async () => {
    const res = createResponse();
    const paymentProcessor = processor(() => ({ maxAmountRequired: '100' }));

    const result = await checkPaymentAndRateLimits({
      req: createRequest(),
      res,
      id: 'abc',
      contentSize: 1024,
      requestAttributes: { hops: 0, clientIps: [] },
      rateLimiter: deniedLimiter(),
      paymentProcessor,
    });

    assert.equal(result.allowed, false);
    assert.equal(res.statusCode, 402);
  });

  it('answers 429, not a free response, when the limit is exceeded and quoting fails', async () => {
    // Regression: a price that x402 rejected ("$0.000") threw out of the
    // exceeded branch into the limiter's catch-all, which allows the request.
    const res = createResponse();
    const paymentProcessor = processor(() => {
      throw new Error('Invalid price format: $0.000');
    });

    const result = await checkPaymentAndRateLimits({
      req: createRequest(),
      res,
      id: 'abc',
      contentSize: 1024,
      requestAttributes: { hops: 0, clientIps: [] },
      rateLimiter: deniedLimiter(),
      paymentProcessor,
    });

    assert.equal(result.allowed, false);
    assert.equal(res.statusCode, 429);
    assert.equal(res.body.error, 'Too Many Requests');
  });
});
