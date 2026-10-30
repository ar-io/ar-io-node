/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it } from 'node:test';
import express from 'express';
import request from 'supertest';

import { currentGqlHops, parseGqlHops, recordGqlHops } from './gql-hops.js';

describe('GraphQL hop count', () => {
  it('parses a non-negative integer, anything else as 0', () => {
    assert.equal(parseGqlHops('2'), 2);
    assert.equal(parseGqlHops(['3', '9']), 3);
    for (const bad of [undefined, '', 'x', '-1', '0']) {
      assert.equal(parseGqlHops(bad), 0, String(bad));
    }
  });

  it('is 0 outside a request', () => {
    assert.equal(currentGqlHops(), 0);
  });

  it('survives the async work of a request, after the body parser', async () => {
    const app = express();
    app.use(express.json(), recordGqlHops, async (_req, res) => {
      await delay(5);
      await Promise.resolve();
      res.json({ hops: currentGqlHops() });
    });
    const hops = async (header?: string) => {
      const req = request(app).post('/graphql').send({ query: '{}' });
      if (header !== undefined) req.set('X-AR-IO-Hops', header);
      return (await req).body.hops;
    };
    assert.equal(await hops('1'), 1);
    assert.equal(await hops(), 0);
    assert.equal(await hops('nonsense'), 0);
    // Concurrent requests keep their own counts.
    const [a, b] = await Promise.all([hops('2'), hops('5')]);
    assert.deepEqual([a, b], [2, 5]);
  });
});
