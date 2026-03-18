/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import express from 'express';
import { default as request } from 'supertest';

import { createRequestIdMiddleware } from './request-id.js';
import { requestContextStorage } from '../request-context.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('createRequestIdMiddleware', () => {
  it('sets X-Request-Id response header with a UUID when none is provided', async () => {
    const app = express();
    app.use(createRequestIdMiddleware());
    app.get('/test', (_req, res) => res.send('ok'));

    const res = await request(app).get('/test');
    assert.match(res.headers['x-request-id'], UUID_RE);
  });

  it('echoes the incoming X-Request-Id header back in the response', async () => {
    const app = express();
    app.use(createRequestIdMiddleware());
    app.get('/test', (_req, res) => res.send('ok'));

    const res = await request(app)
      .get('/test')
      .set('X-Request-Id', 'my-trace-123');
    assert.equal(res.headers['x-request-id'], 'my-trace-123');
  });

  it('populates req.id on the request object', async () => {
    const app = express();
    app.use(createRequestIdMiddleware());
    app.get('/test', (req, res) => res.send(req.id));

    const res = await request(app).get('/test');
    assert.match(res.text, UUID_RE);
  });

  it('populates req.id with the incoming X-Request-Id value', async () => {
    const app = express();
    app.use(createRequestIdMiddleware());
    app.get('/test', (req, res) => res.send(req.id));

    const res = await request(app)
      .get('/test')
      .set('X-Request-Id', 'my-trace-123');
    assert.equal(res.text, 'my-trace-123');
  });

  it('generates unique IDs across consecutive requests', async () => {
    const app = express();
    app.use(createRequestIdMiddleware());
    app.get('/test', (_req, res) => res.send('ok'));

    const [res1, res2] = await Promise.all([
      request(app).get('/test'),
      request(app).get('/test'),
    ]);
    assert.notEqual(res1.headers['x-request-id'], res2.headers['x-request-id']);
  });

  it('propagates request ID through AsyncLocalStorage', async () => {
    const app = express();
    app.use(createRequestIdMiddleware());
    app.get('/test', async (_req, res) => {
      await Promise.resolve();
      const ctx = requestContextStorage.getStore();
      res.send(ctx?.requestId ?? '');
    });

    const res = await request(app).get('/test');
    const headerId = res.headers['x-request-id'];
    assert.match(headerId, UUID_RE);
    assert.equal(res.text, headerId);
  });

  it('propagates client-provided request ID through AsyncLocalStorage', async () => {
    const app = express();
    app.use(createRequestIdMiddleware());
    app.get('/test', async (_req, res) => {
      await Promise.resolve();
      const ctx = requestContextStorage.getStore();
      res.send(ctx?.requestId ?? '');
    });

    const res = await request(app)
      .get('/test')
      .set('X-Request-Id', 'client-trace-456');
    assert.equal(res.text, 'client-trace-456');
  });

  it('rejects X-Request-Id containing invalid characters and generates a UUID', async () => {
    const app = express();
    app.use(createRequestIdMiddleware());
    app.get('/test', (_req, res) => res.send('ok'));

    // Spaces and special chars like < > are not in the allowed set
    const res = await request(app)
      .get('/test')
      .set('X-Request-Id', 'bad value <script>');
    assert.match(res.headers['x-request-id'], UUID_RE);
  });

  it('rejects X-Request-Id exceeding max length and generates a UUID', async () => {
    const app = express();
    app.use(createRequestIdMiddleware());
    app.get('/test', (_req, res) => res.send('ok'));

    const res = await request(app)
      .get('/test')
      .set('X-Request-Id', 'a'.repeat(129));
    assert.match(res.headers['x-request-id'], UUID_RE);
  });

  it('rejects empty X-Request-Id and generates a UUID', async () => {
    const app = express();
    app.use(createRequestIdMiddleware());
    app.get('/test', (_req, res) => res.send('ok'));

    const res = await request(app).get('/test').set('X-Request-Id', '   ');
    assert.match(res.headers['x-request-id'], UUID_RE);
  });
});
