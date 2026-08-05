/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it, mock } from 'node:test';
import http from 'node:http';
import { Readable } from 'node:stream';
import express from 'express';
import { default as request } from 'supertest';

import { createTestLogger } from '../../test/test-logger.js';
import { createIpfsHandler } from './ipfs.js';
import {
  IpfsNotFoundError,
  IpfsTimeoutError,
} from '../ipfs/kubo-data-source.js';
import type { IpfsService } from '../ipfs/ipfs-service.js';
import * as metrics from '../metrics.js';

const log = createTestLogger({ suite: 'IPFS routes' });
const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

const body = (s: string) => Readable.from([Buffer.from(s)]);

function makeInfiniteStream(): Readable {
  const s = new Readable({ read() {} });
  s.push(Buffer.alloc(1024));
  const timer = setInterval(() => {
    if (!s.destroyed) s.push(Buffer.alloc(1024));
  }, 5);
  s.on('close', () => clearInterval(timer));
  return s;
}

function makeApp({
  service,
  setArns = false,
  paymentProcessor,
}: {
  service: Partial<IpfsService>;
  setArns?: boolean;
  paymentProcessor?: any;
}): express.Express {
  const app = express();
  const handler = createIpfsHandler({
    log,
    ipfsService: service as IpfsService,
    paymentProcessor,
  });
  const setCtx: express.Handler = (req, _res, next) => {
    (req as any).ipfsCid = (req.params as any).cid;
    (req as any).ipfsPath = undefined;
    if (setArns) (req as any).arns = { name: 'blog' };
    next();
  };
  app.get('/c/:cid', setCtx, handler);
  app.head('/c/:cid', setCtx, handler);
  return app;
}

async function counterValue(counter: {
  get: () => Promise<{ values: { value: number }[] }>;
}): Promise<number> {
  const m = await counter.get();
  return m.values.reduce((sum, v) => sum + v.value, 0);
}

const waitFor = async (pred: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (!pred() && Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('IPFS route handler', () => {
  const okResult = (over: Record<string, unknown> = {}) => ({
    stream: body('hello world'),
    size: 11,
    contentType: 'text/plain',
    cached: false,
    statusCode: 200,
    ...over,
  });

  describe('H2: immutable Cache-Control is guarded by ArNS binding', () => {
    it('sets immutable Cache-Control for a direct-CID trustless (format) response', async () => {
      const service = { getContent: mock.fn(async () => okResult()) };
      const res = await request(makeApp({ service }))
        .get(`/c/${CID}?format=raw`)
        .expect(200);
      assert.match(res.headers['cache-control'] ?? '', /immutable/);
    });

    it('does NOT force immutable Cache-Control when served over an ArNS name', async () => {
      const service = { getContent: mock.fn(async () => okResult()) };
      const res = await request(makeApp({ service, setArns: true }))
        .get(`/c/${CID}?format=raw`)
        .expect(200);
      assert.doesNotMatch(res.headers['cache-control'] ?? '', /immutable/);
    });

    it('does NOT force immutable Cache-Control for an ArNS UnixFS (proxy) response', async () => {
      const service = { getContent: mock.fn(async () => okResult()) };
      const res = await request(makeApp({ service, setArns: true }))
        .get(`/c/${CID}`)
        .expect(200);
      assert.doesNotMatch(res.headers['cache-control'] ?? '', /immutable/);
    });
  });

  describe('M3: Vary: Accept', () => {
    it('is set on the UnixFS proxy response', async () => {
      const service = { getContent: mock.fn(async () => okResult()) };
      const res = await request(makeApp({ service })).get(`/c/${CID}`);
      assert.equal(res.headers['vary'], 'Accept');
    });

    it('is set on the trustless (format) response', async () => {
      const service = { getContent: mock.fn(async () => okResult()) };
      const res = await request(makeApp({ service })).get(
        `/c/${CID}?format=car`,
      );
      assert.equal(res.headers['vary'], 'Accept');
    });
  });

  describe('trustless header contract', () => {
    it('marks a format response trustless with an attachment disposition', async () => {
      const service = { getContent: mock.fn(async () => okResult()) };
      const res = await request(makeApp({ service })).get(
        `/c/${CID}?format=raw`,
      );
      assert.equal(res.headers['x-ar-io-trustless'], 'true');
      assert.equal(res.headers['content-disposition'], 'attachment');
    });

    it('marks a UnixFS proxy response NOT trustless', async () => {
      const service = { getContent: mock.fn(async () => okResult()) };
      const res = await request(makeApp({ service })).get(`/c/${CID}`);
      assert.equal(res.headers['x-ar-io-trustless'], 'false');
    });
  });

  describe('HEAD releases the body stream', () => {
    it('returns headers with no body and destroys the upstream stream', async () => {
      const stream = makeInfiniteStream();
      const service = {
        getContent: mock.fn(async () => okResult({ stream, size: 0 })),
      };
      const res = await request(makeApp({ service }))
        .head(`/c/${CID}`)
        .expect(200);
      assert.equal(res.text ?? '', '');
      assert.match(res.headers['etag'] ?? '', /"/);
      await waitFor(() => stream.destroyed);
      assert.equal(stream.destroyed, true);
    });
  });

  describe('L1: route does not double-count cache hit/miss', () => {
    it('leaves the cache-hit counter untouched (the service owns it)', async () => {
      const service = {
        getContent: mock.fn(async () => okResult({ cached: true })),
      };
      const before = await counterValue(metrics.ipfsCacheHitTotal);
      await request(makeApp({ service })).get(`/c/${CID}`).expect(200);
      const after = await counterValue(metrics.ipfsCacheHitTotal);
      assert.equal(after - before, 0);
    });
  });

  describe('error mapping', () => {
    it('maps IpfsNotFoundError to a cache-dampened 404', async () => {
      const service = {
        getContent: mock.fn(async () => {
          throw new IpfsNotFoundError('absent');
        }),
      };
      const res = await request(makeApp({ service }))
        .get(`/c/${CID}`)
        .expect(404);
      assert.match(res.headers['cache-control'] ?? '', /max-age=\d+/);
    });

    it('maps IpfsTimeoutError to a 504 with retry-dampening Cache-Control', async () => {
      const service = {
        getContent: mock.fn(async () => {
          throw new IpfsTimeoutError('no provider');
        }),
      };
      const res = await request(makeApp({ service }))
        .get(`/c/${CID}`)
        .expect(504);
      assert.match(res.headers['cache-control'] ?? '', /max-age=\d+/);
    });
  });

  describe('H1: client disconnect tears down the upstream stream', () => {
    it('destroys the source stream when the client aborts mid-download', async () => {
      const source = makeInfiniteStream();
      const service = {
        getContent: mock.fn(async () => okResult({ stream: source, size: 0 })),
      };
      const server = makeApp({ service }).listen(0);
      const port = (server.address() as any).port;

      await new Promise<void>((resolve) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: `/c/${CID}`, method: 'GET' },
          (res) => {
            res.once('data', () => req.destroy());
          },
        );
        req.on('error', () => resolve());
        req.on('close', () => resolve());
        req.end();
      });

      await waitFor(() => source.destroyed);
      assert.equal(source.destroyed, true);
      await new Promise<void>((r) => server.close(() => r()));
    });
  });

  describe('local-only serve mode', () => {
    it('threads localOnly:true and nulls Range from the X-Ar-Io-Local-Only header, echoing the marker on a hit', async () => {
      const getContent = mock.fn(async () => okResult());
      const res = await request(makeApp({ service: { getContent } }))
        .get(`/c/${CID}`)
        .set('X-Ar-Io-Local-Only', 'true')
        .set('Range', 'bytes=0-9')
        .expect(200);

      const args = getContent.mock.calls[0].arguments[0] as any;
      assert.equal(args.localOnly, true);
      // Range is not honored under local-only.
      assert.equal(args.range, undefined);
      // The marker is echoed so a peer/observer can assert the mode was honored.
      assert.equal(res.headers['x-ar-io-local-only'], 'true');
    });

    it('accepts ?local=1 as a local-only trigger', async () => {
      const getContent = mock.fn(async () => okResult());
      await request(makeApp({ service: { getContent } }))
        .get(`/c/${CID}?local=1`)
        .expect(200);

      assert.equal(
        (getContent.mock.calls[0].arguments[0] as any).localOnly,
        true,
      );
    });

    it('returns 404 on a local miss with no fallback', async () => {
      const service = {
        getContent: mock.fn(async () => {
          throw new IpfsNotFoundError('not held locally');
        }),
      };
      await request(makeApp({ service }))
        .get(`/c/${CID}`)
        .set('X-Ar-Io-Local-Only', 'true')
        .expect(404);
    });

    it('does not set localOnly or echo the marker for a normal request', async () => {
      const getContent = mock.fn(async () => okResult());
      const res = await request(makeApp({ service: { getContent } }))
        .get(`/c/${CID}`)
        .expect(200);

      assert.equal(
        (getContent.mock.calls[0].arguments[0] as any).localOnly,
        false,
      );
      assert.equal(res.headers['x-ar-io-local-only'], undefined);
    });

    it('bypasses payment for local-only but still consults it for a normal request', async () => {
      const paymentProcessor = {
        isBrowserRequest: mock.fn(() => false),
        calculateRequirements: mock.fn(() => ({ maxAmountRequired: '0' })),
        extractPayment: mock.fn(() => undefined),
      };

      // Normal request: the payment processor IS consulted.
      await request(
        makeApp({
          service: { getContent: mock.fn(async () => okResult()) },
          paymentProcessor,
        }),
      )
        .get(`/c/${CID}`)
        .expect(200);
      assert.ok(paymentProcessor.calculateRequirements.mock.calls.length >= 1);

      // Local-only request: the processor is passed undefined, so it is bypassed.
      paymentProcessor.calculateRequirements.mock.resetCalls();
      await request(
        makeApp({
          service: { getContent: mock.fn(async () => okResult()) },
          paymentProcessor,
        }),
      )
        .get(`/c/${CID}`)
        .set('X-Ar-Io-Local-Only', 'true')
        .expect(200);
      assert.equal(paymentProcessor.calculateRequirements.mock.calls.length, 0);
    });
  });
});
