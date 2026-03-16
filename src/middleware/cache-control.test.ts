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

import { createDefaultCacheControlMiddleware } from './cache-control.js';

describe('createDefaultCacheControlMiddleware', () => {
  it('sets default Cache-Control when no handler sets one', async () => {
    const app = express();
    app.use(createDefaultCacheControlMiddleware(30));
    app.get('/test', (_req, res) => {
      res.send('ok');
    });

    const res = await request(app).get('/test');
    assert.equal(res.headers['cache-control'], 'public, max-age=30');
  });

  it('does not override when a handler sets Cache-Control explicitly', async () => {
    const app = express();
    app.use(createDefaultCacheControlMiddleware(30));
    app.get('/test', (_req, res) => {
      res.header('Cache-Control', 'private, max-age=3600');
      res.send('ok');
    });

    const res = await request(app).get('/test');
    assert.equal(res.headers['cache-control'], 'private, max-age=3600');
  });

  it('does not apply default Cache-Control to POST requests', async () => {
    const app = express();
    app.use(createDefaultCacheControlMiddleware(30));
    app.post('/test', (_req, res) => {
      res.send('ok');
    });

    const res = await request(app).post('/test');
    assert.equal(res.headers['cache-control'], undefined);
  });

  it('does not apply default Cache-Control to non-success responses', async () => {
    const app = express();
    app.use(createDefaultCacheControlMiddleware(30));
    app.get('/test', (_req, res) => {
      res.status(404).send('missing');
    });

    const res = await request(app).get('/test');
    assert.equal(res.headers['cache-control'], undefined);
  });

  it('does not apply default Cache-Control to excluded control-plane routes', async () => {
    const app = express();
    app.use(createDefaultCacheControlMiddleware(30));
    app.get('/ar-io/admin/test', (_req, res) => {
      res.send('ok');
    });

    const res = await request(app).get('/ar-io/admin/test');
    assert.equal(res.headers['cache-control'], undefined);
  });

  it('respects configurable max-age value', async () => {
    const app = express();
    app.use(createDefaultCacheControlMiddleware(120));
    app.get('/test', (_req, res) => {
      res.send('ok');
    });

    const res = await request(app).get('/test');
    assert.equal(res.headers['cache-control'], 'public, max-age=120');
  });
});
