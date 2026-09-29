/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import express, { Request, Response, RequestHandler } from 'express';
import { default as request } from 'supertest';

import { createErrorHandlerMiddleware } from './error-handler.js';
import { createTestLogger } from '../../test/test-logger.js';

const log = createTestLogger();

// Build an app whose single route triggers the supplied handler, with the
// terminal error handler registered last (as in app.ts).
function buildApp(routeHandler: RequestHandler): express.Express {
  const app = express();
  app.get('/test', routeHandler);
  app.use(createErrorHandlerMiddleware({ log }));
  return app;
}

describe('createErrorHandlerMiddleware', () => {
  it('maps a synchronously-thrown error to 500 with a generic body', async () => {
    const app = buildApp(() => {
      throw new Error('boom');
    });

    const res = await request(app).get('/test');
    assert.equal(res.status, 500);
    assert.equal(res.text, 'Internal server error');
  });

  it('maps an error forwarded via next() to 500', async () => {
    const app = buildApp((_req, _res, next) =>
      next(new Error('downstream failure')),
    );

    const res = await request(app).get('/test');
    assert.equal(res.status, 500);
  });

  it('maps a client disconnect (aborted req.signal) to 499, not 500', async () => {
    const app = buildApp((req, _res, next) => {
      const controller = new AbortController();
      controller.abort();
      req.signal = controller.signal;
      // A disconnect can surface downstream as any error shape, e.g. the
      // chunk source's generic "all peers failed".
      next(
        new Error('Failed to fetch chunk from AR.IO peers after 3 attempts'),
      );
    });

    const res = await request(app).get('/test');
    assert.equal(res.status, 499);
  });

  it('maps an AbortError (by name) to 499 even without an aborted signal', async () => {
    const app = buildApp((_req, _res, next) =>
      next(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    );

    const res = await request(app).get('/test');
    assert.equal(res.status, 499);
  });

  it('maps a malformed JSON body to 400, not 500', async () => {
    // Real body-parser, so the error shape is the one production sees.
    const app = express();
    app.post('/test', express.json(), (_req, res) => res.json({ ok: true }));
    app.use(createErrorHandlerMiddleware({ log }));

    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/json')
      .send('{"query": ');
    assert.equal(res.status, 400);
  });

  it('keeps a 4xx error that is not marked exposable as a 500', async () => {
    // Only http-errors' `expose: true` is trusted; an arbitrary error that
    // happens to carry a status must not leak its message to the client.
    const app = buildApp((_req, _res, next) =>
      next(Object.assign(new Error('internal detail'), { status: 404 })),
    );

    const res = await request(app).get('/test');
    assert.equal(res.status, 500);
    assert.equal(res.text, 'Internal server error');
  });

  it('delegates to the default handler when headers are already sent', () => {
    const handler = createErrorHandlerMiddleware({ log });
    let forwarded: unknown;
    let statusCalled = false;

    const res = {
      headersSent: true,
      status() {
        statusCalled = true;
        return this;
      },
      send() {
        return this;
      },
      end() {
        return this;
      },
    } as unknown as Response;
    const req = { method: 'GET', originalUrl: '/test' } as Request;

    handler(new Error('boom'), req, res, (err?: unknown) => {
      forwarded = err;
    });

    // We must not try to (re)write a response that's already underway.
    assert.equal(statusCalled, false);
    assert.equal((forwarded as Error)?.message, 'boom');
  });
});
