/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@as-integrations/express4';
import express from 'express';
import request from 'supertest';

import { createTestLogger } from '../../../test/test-logger.js';
import { createErrorHandlerMiddleware } from '../../middleware/error-handler.js';
import {
  GRAPHIQL_CSP,
  graphiqlAssets,
  graphiqlCsp,
  graphqlLandingPage,
} from './landing-page.js';

/**
 * A real Apollo Server behind the same `/graphql` chain `graphql/index.ts`
 * builds, pointed at a stand-in for `dist/graphiql`, and ending in the
 * gateway's own terminal error handler, so the page, headers and error
 * statuses under test are what a browser actually receives. Express's default
 * handler is laxer than the gateway's, and hid a 500 on missing files.
 */
const app = async (assetsDir: string) => {
  const server = new ApolloServer({
    typeDefs: 'type Query { ok: Boolean }',
    resolvers: { Query: { ok: () => true } },
    plugins: [graphqlLandingPage(assetsDir)],
    stopOnTerminationSignals: false,
  });
  await server.start();
  const a = express();
  a.use(
    '/graphql',
    graphiqlAssets(assetsDir),
    graphiqlCsp,
    express.json(),
    expressMiddleware(server),
  );
  a.use(
    createErrorHandlerMiddleware({
      log: createTestLogger({ suite: 'GraphiQL landing page' }),
    }),
  );
  return { a, server };
};

describe('GraphiQL landing page', () => {
  let assetsDir: string;

  before(async () => {
    assetsDir = await mkdtemp(path.join(os.tmpdir(), 'graphiql-'));
    await writeFile(
      path.join(assetsDir, 'manifest.json'),
      JSON.stringify({ js: 'index-ABC123.js', css: 'index-DEF456.css' }),
    );
    await writeFile(path.join(assetsDir, 'index-ABC123.js'), 'export {};');
    await writeFile(path.join(assetsDir, 'index-DEF456.css'), 'body{}');
  });

  after(async () => {
    await rm(assetsDir, { recursive: true, force: true });
  });

  it('serves the self-hosted page with a same-origin-only CSP', async () => {
    const { a, server } = await app(assetsDir);
    try {
      const res = await request(a).get('/graphql').set('Accept', 'text/html');

      assert.equal(res.status, 200);
      assert.match(res.headers['content-type'], /text\/html/);
      assert.equal(res.headers['content-security-policy'], GRAPHIQL_CSP);
      assert.match(
        res.text,
        /<script type="module" src="\/graphql\/graphiql\/index-ABC123\.js">/,
      );
      assert.match(res.text, /href="\/graphql\/graphiql\/index-DEF456\.css"/);
      // Nothing on the page may come from, or report to, a third party.
      assert.doesNotMatch(res.text, /(src|href)="(https?:)?\/\//);
      assert.doesNotMatch(res.text, /apollographql|runTelemetry/);
    } finally {
      await server.stop();
    }
  });

  it('sends the CSP wherever Apollo serves the page, nested paths included', async () => {
    const { a, server } = await app(assetsDir);
    try {
      // Apollo answers every path under its mount, so `/graphql/anything`
      // gets the landing page too, and must carry the same policy.
      for (const url of ['/graphql/', '/graphql/nested/path']) {
        const res = await request(a).get(url).set('Accept', 'text/html');

        assert.equal(res.status, 200, url);
        assert.match(res.text, /id="graphiql"/, url);
        assert.equal(res.headers['content-security-policy'], GRAPHIQL_CSP, url);
      }
    } finally {
      await server.stop();
    }
  });

  it('serves the bundled files as immutable', async () => {
    const { a, server } = await app(assetsDir);
    try {
      const res = await request(a).get('/graphql/graphiql/index-ABC123.js');

      assert.equal(res.status, 200);
      assert.match(res.headers['content-type'], /javascript/);
      assert.match(res.headers['cache-control'], /max-age=31536000/);
      assert.match(res.headers['cache-control'], /immutable/);
    } finally {
      await server.stop();
    }
  });

  it('answers an unknown file with 404, not the landing page', async () => {
    const { a, server } = await app(assetsDir);
    try {
      const res = await request(a)
        .get('/graphql/graphiql/missing.js')
        .set('Accept', 'text/html');

      assert.equal(res.status, 404);
      assert.doesNotMatch(res.text, /id="graphiql"/);
    } finally {
      await server.stop();
    }
  });

  it('leaves GraphQL requests alone', async () => {
    const { a, server } = await app(assetsDir);
    try {
      const res = await request(a).post('/graphql').send({ query: '{ ok }' });

      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { data: { ok: true } });
      assert.equal(res.headers['content-security-policy'], undefined);
    } finally {
      await server.stop();
    }
  });

  it('explains how to build the page when it has not been built', async () => {
    const empty = await mkdtemp(path.join(os.tmpdir(), 'graphiql-empty-'));
    const { a, server } = await app(empty);
    try {
      const res = await request(a).get('/graphql').set('Accept', 'text/html');

      assert.equal(res.status, 200);
      assert.match(res.text, /yarn build:graphiql/);
      assert.doesNotMatch(res.text, /<script/);
    } finally {
      await server.stop();
      await rm(empty, { recursive: true, force: true });
    }
  });
});
