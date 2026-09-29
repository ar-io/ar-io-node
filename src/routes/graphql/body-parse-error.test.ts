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

import { graphqlBodyParseError } from './body-parse-error.js';

/**
 * Real body parser over real HTTP, mounted the way `graphql/index.ts` mounts
 * it, so the error shape under test is the one body-parser actually produces.
 */
const app = () => {
  const a = express();
  a.post(
    '/graphql',
    express.json(),
    graphqlBodyParseError,
    (_req: express.Request, res: express.Response) => res.json({ ok: true }),
  );
  a.use(
    (
      _err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(500).send('terminal');
    },
  );
  return a;
};

describe('graphqlBodyParseError', () => {
  it('answers malformed JSON with a GraphQL BAD_REQUEST body and 400', async () => {
    const res = await request(app())
      .post('/graphql')
      .set('Content-Type', 'application/json')
      .send('{"query": ');

    assert.equal(res.status, 400);
    assert.match(res.headers['content-type'], /application\/json/);
    assert.equal(res.body.errors.length, 1);
    assert.equal(res.body.errors[0].extensions.code, 'BAD_REQUEST');
    assert.equal(typeof res.body.errors[0].message, 'string');
  });

  it('keeps an oversized body at its own status (413)', async () => {
    const res = await request(app())
      .post('/graphql')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ query: 'x'.repeat(200 * 1024) }));

    assert.equal(res.status, 413);
    assert.equal(res.body.errors[0].extensions.code, 'BAD_REQUEST');
  });

  it('passes a well-formed body through untouched', async () => {
    const res = await request(app())
      .post('/graphql')
      .send({ query: '{ __typename }' });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  });

  it('forwards an error that is not an exposable 4xx to the terminal handler', async () => {
    const a = express();
    a.post(
      '/graphql',
      (
        _req: express.Request,
        _res: express.Response,
        next: express.NextFunction,
      ) => next(new Error('internal')),
      graphqlBodyParseError,
    );
    a.use(
      (
        _err: unknown,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        res.status(500).send('terminal');
      },
    );

    const res = await request(a).post('/graphql').send({});
    assert.equal(res.status, 500);
    assert.equal(res.text, 'terminal');
  });
});
