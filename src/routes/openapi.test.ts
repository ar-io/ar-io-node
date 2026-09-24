/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import express from 'express';
import request from 'supertest';

import { openApiRouter } from './openapi.js';
import { release } from '../version.js';

describe('openApiRouter', () => {
  const app = express();
  app.use(openApiRouter);

  it('serves the spec with this gateway release as its version', async () => {
    // Gateways upgrade independently; a client reading the spec should see
    // the release it is talking to, not the number last typed into the file.
    const res = await request(app).get('/openapi.json').expect(200);
    assert.equal(res.body.info.version, release);
    assert.equal(res.body.info.title, 'ar.io Gateway API');
  });

  it('points "Try it out" at the gateway serving the page', async () => {
    const res = await request(app).get('/openapi.json').expect(200);
    assert.deepEqual(
      res.body.servers.map((s: { url: string }) => s.url),
      ['/'],
    );
  });
});
