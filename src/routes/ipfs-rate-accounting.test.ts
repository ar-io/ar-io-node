/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
process.env.ENABLE_RATE_LIMITER = 'true';
process.env.RATE_LIMITER_TYPE = 'memory';

import { strict as assert } from 'node:assert';
import { describe, it, mock } from 'node:test';
import { Readable } from 'node:stream';
import express from 'express';
import { default as request } from 'supertest';

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

// Load app modules only after the env above is set.
const { createTestLogger } = await import('../../test/test-logger.js');
const { createIpfsHandler } = await import('./ipfs.js');
const config = await import('../config.js');
const log = createTestLogger({ suite: 'IPFS rate accounting' });

const waitFor = async (pred: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (!pred() && Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('IPFS route rate-limit accounting (H3)', () => {
  it('confirms the rate limiter is enabled in this process', () => {
    assert.equal(config.ENABLE_RATE_LIMITER, true);
  });

  it('charges the rate limiter for the actual streamed bytes, not the reserve', async () => {
    // A 3-chunk body totalling 30 000 bytes. Crucially size:0 (unknown length),
    // so the reserve is the 256 KB placeholder — the pre-fix code would charge
    // that placeholder instead of the real 30 000.
    const payload = Buffer.alloc(30_000, 0x61);
    const service = {
      getContent: mock.fn(async () => ({
        stream: Readable.from([
          payload.subarray(0, 10_000),
          payload.subarray(10_000, 20_000),
          payload.subarray(20_000),
        ]),
        size: 0,
        contentType: 'application/octet-stream',
        cached: false,
        statusCode: 200,
      })),
    };

    const adjustTokens = mock.fn(async () => {});
    const rateLimiter = {
      isAllowlisted: mock.fn(() => false),
      checkLimit: mock.fn(async () => ({
        allowed: true,
        ipTokensConsumed: 1,
        ipPaidTokensConsumed: 0,
        ipRegularTokensConsumed: 1,
        resourceTokensConsumed: 0,
        resourcePaidTokensConsumed: 0,
        resourceRegularTokensConsumed: 0,
      })),
      adjustTokens,
      topOffPaidTokens: mock.fn(async () => {}),
      getIpBucketState: mock.fn(async () => null),
      getResourceBucketState: mock.fn(async () => null),
      topOffPaidTokensForResource: mock.fn(async () => {}),
    } as any;

    const app = express();
    const handler = createIpfsHandler({
      log,
      ipfsService: service as any,
      rateLimiter,
    });
    app.get(
      '/c/:cid',
      (req, _res, next) => {
        (req as any).ipfsCid = (req.params as any).cid;
        (req as any).ipfsPath = undefined;
        next();
      },
      handler,
    );

    const res = await request(app).get(`/c/${CID}`).expect(200);
    assert.equal(res.body.length ?? res.text.length, 30_000);

    await waitFor(() => adjustTokens.mock.calls.length > 0);
    assert.equal(adjustTokens.mock.calls.length, 1);
    const ctx = (adjustTokens.mock.calls[0].arguments as any[])[1] as {
      responseSize: number;
    };
    assert.equal(
      ctx.responseSize,
      30_000,
      `expected the real 30000 streamed bytes, got ${ctx.responseSize} ` +
        `(reserve was ${config.IPFS_RATE_LIMIT_UNKNOWN_SIZE_BYTES})`,
    );
  });
});
