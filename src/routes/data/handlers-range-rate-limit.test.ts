/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The single-range fast path for uncached items must charge the rate limiter
 * what the full-object path charges: the range, not the whole item. The
 * shared limiter helper is gated on ENABLE_RATE_LIMITER, read when config
 * first loads, so it is set before the modules are imported. The test runner
 * gives each file its own process, which keeps this from leaking into any
 * other suite.
 */
import { strict as assert } from 'node:assert';
import { before, beforeEach, describe, it } from 'node:test';
import { Readable } from 'node:stream';
import express from 'express';
import request from 'supertest';

process.env.ENABLE_RATE_LIMITER = 'true';

describe('Data routes: rate limiting a single range of an uncached item', () => {
  const size = 64 * 1024;
  const body = Buffer.alloc(size, 7);
  let createDataHandler: typeof import('./handlers.js').createDataHandler;
  let log: ReturnType<
    typeof import('../../../test/test-logger.js').createTestLogger
  >;
  let calls: any[];
  let streams: Readable[];
  let predictedTokens: number[];
  let allowed: boolean;
  let app: express.Express;

  before(async () => {
    ({ createDataHandler } = await import('./handlers.js'));
    const { createTestLogger } = await import('../../../test/test-logger.js');
    log = createTestLogger({ suite: 'Data routes range rate limit' });
  });

  beforeEach(() => {
    calls = [];
    streams = [];
    predictedTokens = [];
    allowed = true;

    const rateLimiter = {
      checkLimit: async (_req: unknown, _res: unknown, tokens: number) => {
        predictedTokens.push(tokens);
        return allowed
          ? { allowed: true, ipTokensConsumed: tokens }
          : { allowed: false, limitType: 'ip' as const };
      },
      adjustTokens: async () => undefined,
      isAllowlisted: () => false,
      topOffPaidTokens: async () => undefined,
      getIpBucketState: async () => null,
      getResourceBucketState: async () => null,
      topOffPaidTokensForResource: async () => undefined,
    };

    app = express();
    app.get(
      '/:id',
      createDataHandler({
        log,
        dataAttributesSource: {
          getDataAttributes: async () => ({
            size,
            contentType: 'application/octet-stream',
            isManifest: false,
            stable: false,
            verified: false,
            signature: null,
            offset: 0,
          }),
        },
        dataSource: {
          getData: async (params: any) => {
            calls.push(params);
            const bytes =
              params.region !== undefined
                ? body.subarray(
                    params.region.offset,
                    params.region.offset + params.region.size,
                  )
                : body;
            const stream = Readable.from(bytes);
            streams.push(stream);
            return {
              stream,
              size: bytes.length,
              verified: false,
              trusted: true,
              cached: false,
            };
          },
        },
        dataBlockListValidator: {
          isIdBlocked: async () => false,
          isHashBlocked: async () => false,
        },
        manifestPathResolver: {
          resolveFromIndex: async () => ({ id: 'x', complete: false }),
          resolveFromData: async () => ({ id: 'x', complete: false }),
          resolveFromTrustedCache: () => undefined,
        } as any,
        rateLimiter,
      }),
    );
  });

  it('charges the size of the range', async () => {
    await request(app)
      .get('/not-a-real-id')
      .set('Range', 'bytes=0-1023')
      .expect(206);

    assert.equal(calls.length, 1);
    assert.notEqual(calls[0].region, undefined);
    // 1 KiB, not the 64 KiB item.
    assert.deepEqual(predictedTokens, [1]);
  });

  it('charges the same as the full-object path for the whole item', async () => {
    await request(app).get('/not-a-real-id').expect(200);

    assert.deepEqual(predictedTokens, [64]);
  });

  it('refuses without sending the bytes, and releases the ranged stream', async () => {
    allowed = false;

    await request(app)
      .get('/not-a-real-id')
      .set('Range', 'bytes=0-1023')
      .expect(429);

    assert.equal(calls.length, 1);
    assert.notEqual(calls[0].region, undefined);
    assert.ok(streams[0].destroyed);
  });
});
