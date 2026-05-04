/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import express from 'express';
import { default as request } from 'supertest';

import { headerNames } from '../../constants.js';

// supertest doesn't parse binary by default — pass this to .parse() so we
// get a Buffer back in res.body for arbitrary-bytes responses.
function parseAsBuffer(res: any, callback: (err: Error | null, body: Buffer) => void) {
  res.setEncoding('binary');
  let data = '';
  res.on('data', (chunk: string) => { data += chunk; });
  res.on('end', () => callback(null, Buffer.from(data, 'binary')));
}
import { createTestLogger } from '../../../test/test-logger.js';
import { sendBodyWithOptionalDigest } from './buffered-digest.js';
import { formatContentDigest } from '../../lib/digest.js';
import {
  ContiguousData,
  ContiguousDataAttributes,
} from '../../types.js';

const log = createTestLogger({ suite: 'buffered-digest' });

const FIVE_MIB = 5 * 1024 * 1024;
const ONE_MIB = 1024 * 1024;

function makeData({
  bytes,
  size,
  cached = false,
}: {
  bytes: Buffer;
  size?: number;
  cached?: boolean;
}): ContiguousData {
  return {
    stream: Readable.from(bytes, { objectMode: false }),
    size: size === undefined ? bytes.length : size,
    sourceContentType: 'application/octet-stream',
    verified: false,
    trusted: true,
    cached,
  } as unknown as ContiguousData;
}

function expectedDigest(bytes: Buffer): {
  base64url: string;
  contentDigest: string;
} {
  const base64url = crypto
    .createHash('sha256')
    .update(bytes)
    .digest('base64url');
  return { base64url, contentDigest: formatContentDigest(base64url) };
}

/**
 * Mounts a tiny express app whose only route invokes sendBodyWithOptionalDigest
 * with caller-controlled `data`, `dataAttributes`, and `maxBytes`. Returns a
 * supertest agent for the app — same shape as handlers.test.ts uses.
 */
function makeApp({
  data,
  dataAttributes,
  maxBytes,
}: {
  data: ContiguousData;
  dataAttributes?: ContiguousDataAttributes;
  maxBytes?: number;
}) {
  const app = express();
  app.get('/data', async (req, res) => {
    await sendBodyWithOptionalDigest({
      req,
      res,
      data,
      dataAttributes,
      log,
      dataId: 'test-id',
      maxBytes,
    });
  });
  return app;
}

describe('sendBodyWithOptionalDigest', () => {
  it('emits Content-Digest matching the body for a small uncached response (golden)', async () => {
    const body = Buffer.from('hello, ar.io');
    const { base64url, contentDigest } = expectedDigest(body);

    const app = makeApp({
      data: makeData({ bytes: body, cached: false }),
      maxBytes: ONE_MIB,
    });

    const res = await request(app).get('/data').buffer(true).parse(parseAsBuffer);

    assert.equal(res.status, 200);
    assert.equal(res.headers[headerNames.contentDigest.toLowerCase()],
      contentDigest);
    assert.equal(res.headers[headerNames.digest.toLowerCase()], base64url);
    assert.equal(res.headers['etag'], `"${base64url}"`);
    assert.equal(res.headers['content-length'], String(body.length));
    assert.deepEqual(res.body, body);
  });

  it('does not buffer when size exceeds threshold', async () => {
    const body = Buffer.alloc(2048, 0x41); // 2 KB
    const app = makeApp({
      data: makeData({ bytes: body, cached: false }),
      maxBytes: 1024, // 1 KB threshold — body is over
    });

    const res = await request(app).get('/data').buffer(true).parse(parseAsBuffer);

    assert.equal(res.status, 200);
    assert.equal(res.headers[headerNames.contentDigest.toLowerCase()],
      undefined);
    // Body still streamed correctly
    assert.equal(res.body.length, body.length);
  });

  it('does not buffer when size is unknown', async () => {
    const body = Buffer.from('payload');
    // Synthesize a data object with size=undefined
    const data = {
      ...makeData({ bytes: body, cached: false }),
      size: undefined,
    } as unknown as ContiguousData;

    const app = makeApp({ data, maxBytes: ONE_MIB });

    const res = await request(app).get('/data').buffer(true).parse(parseAsBuffer);

    assert.equal(res.status, 200);
    assert.equal(res.headers[headerNames.contentDigest.toLowerCase()],
      undefined);
  });

  it('does nothing special when threshold is 0 (feature disabled)', async () => {
    const body = Buffer.from('disabled');
    const app = makeApp({
      data: makeData({ bytes: body, cached: false }),
      maxBytes: 0,
    });

    const res = await request(app).get('/data').buffer(true).parse(parseAsBuffer);

    assert.equal(res.status, 200);
    assert.equal(res.headers[headerNames.contentDigest.toLowerCase()],
      undefined);
  });

  it('size lie: source declares small but streams over threshold — falls back, no Content-Digest', async () => {
    // Source claims 16 bytes but the stream actually emits 2048.
    const realBody = Buffer.alloc(2048, 0x42);
    const data = {
      ...makeData({ bytes: realBody, cached: false }),
      size: 16, // declared (lying)
    } as unknown as ContiguousData;

    const app = makeApp({ data, maxBytes: 1024 });

    const res = await request(app).get('/data').buffer(true).parse(parseAsBuffer);

    // The 16-byte declared size is below the 1024 threshold, so we'd try to
    // buffer; partway through the stream we discover it's actually 2048 and
    // bail to streaming with no Content-Digest set.
    assert.equal(res.status, 200);
    assert.equal(res.headers[headerNames.contentDigest.toLowerCase()],
      undefined);
    assert.equal(res.body.length, realBody.length);
  });

  it('passes through (no Content-Digest set by helper) when cache_hit header was already set upstream', async () => {
    const body = Buffer.from('cached body');
    // Pre-set Content-Digest like setDigestStableVerifiedHeaders would.
    const cachedDigest = 'sha-256=:already-set:';
    const app = express();
    app.get('/data', async (req, res) => {
      res.setHeader(headerNames.contentDigest, cachedDigest);
      await sendBodyWithOptionalDigest({
        req,
        res,
        data: makeData({ bytes: body, cached: true }),
        dataAttributes: undefined,
        log,
        dataId: 'cached-test',
        maxBytes: ONE_MIB,
      });
    });

    const res = await request(app).get('/data').buffer(true).parse(parseAsBuffer);

    assert.equal(res.status, 200);
    // The pre-set digest is what stays; helper does not overwrite.
    assert.equal(res.headers[headerNames.contentDigest.toLowerCase()],
      cachedDigest);
  });

  it('boundary: body exactly at the threshold size IS buffered', async () => {
    const body = Buffer.alloc(1024, 0x43); // exactly 1 KB
    const { contentDigest } = expectedDigest(body);

    const app = makeApp({
      data: makeData({ bytes: body, cached: false }),
      maxBytes: 1024,
    });

    const res = await request(app).get('/data').buffer(true).parse(parseAsBuffer);

    assert.equal(res.status, 200);
    assert.equal(res.headers[headerNames.contentDigest.toLowerCase()],
      contentDigest);
  });

  it('property-style: random byte sequences hash correctly across multiple sizes', async () => {
    const sizes = [1, 256, 1024, 64 * 1024, ONE_MIB];
    for (const size of sizes) {
      const body = crypto.randomBytes(size);
      const { contentDigest } = expectedDigest(body);

      const app = makeApp({
        data: makeData({ bytes: body, cached: false }),
        maxBytes: FIVE_MIB,
      });

      const res = await request(app).get('/data').buffer(true).parse(parseAsBuffer);

      assert.equal(res.status, 200, `size=${size} failed status check`);
      assert.equal(
        res.headers[headerNames.contentDigest.toLowerCase()],
        contentDigest,
        `size=${size} digest mismatch`,
      );
    }
  });
});
