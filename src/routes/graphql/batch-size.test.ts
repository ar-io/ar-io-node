/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, it } from 'node:test';

import * as metrics from '../../metrics.js';
import { recordGraphqlBatchSize } from './batch-size.js';

/**
 * Exercised over real HTTP with a real body parser rather than a synthetic
 * `req` object, because the thing most likely to break this is the body not
 * being parsed into an array by the time the middleware runs — which a
 * hand-built fake would paper over.
 */
const appWithMiddleware = () => {
  const app = express();
  app.use(express.json());
  app.use(recordGraphqlBatchSize);
  app.post('/graphql', (_req, res) => res.json({ ok: true }));
  return app;
};

const histogram = async () => {
  const out = await metrics.graphqlHttpBatchSize.get();
  const count = out.values.find((v) => v.metricName?.endsWith('_count'));
  const sum = out.values.find((v) => v.metricName?.endsWith('_sum'));
  return { count: count?.value ?? 0, sum: sum?.value ?? 0 };
};

describe('recordGraphqlBatchSize', () => {
  beforeEach(() => {
    metrics.graphqlHttpBatchSize.reset();
  });

  it('records 1 for an ordinary single-operation request', async () => {
    await request(appWithMiddleware())
      .post('/graphql')
      .send({ query: '{ __typename }' });

    assert.deepEqual(await histogram(), { count: 1, sum: 1 });
  });

  it('records the array length for a batched request', async () => {
    await request(appWithMiddleware())
      .post('/graphql')
      .send([
        { query: '{ __typename }' },
        { query: '{ __typename }' },
        { query: '{ __typename }' },
      ]);

    // One HTTP request, three operations: the gap between _sum and _count is
    // exactly the amplification the rate limiter cannot currently see.
    assert.deepEqual(await histogram(), { count: 1, sum: 3 });
  });

  it('counts a body-less request as a single operation', async () => {
    await request(appWithMiddleware()).post('/graphql');

    assert.deepEqual(await histogram(), { count: 1, sum: 1 });
  });

  it('accumulates across mixed traffic so _sum/_count reads as amplification', async () => {
    const app = appWithMiddleware();
    await request(app).post('/graphql').send({ query: '{ __typename }' });
    await request(app)
      .post('/graphql')
      .send([{ query: '{ __typename }' }, { query: '{ __typename }' }]);

    // 2 HTTP requests carrying 3 operations.
    assert.deepEqual(await histogram(), { count: 2, sum: 3 });
  });
});
