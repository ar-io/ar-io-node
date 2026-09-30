/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@as-integrations/express4';
import express from 'express';
import request from 'supertest';

import { graphqlLandingPage } from './landing-page.js';

/**
 * A real Apollo Server with only the landing-page plugin, mounted the way
 * `graphql/index.ts` mounts it, so the page under test is the HTML a browser
 * actually receives from `GET /graphql`.
 */
const app = async () => {
  const server = new ApolloServer({
    typeDefs: 'type Query { ok: Boolean }',
    plugins: [graphqlLandingPage()],
    stopOnTerminationSignals: false,
  });
  await server.start();
  const a = express();
  a.use('/graphql', express.json(), expressMiddleware(server));
  return { a, server };
};

describe('graphqlLandingPage', () => {
  it('serves the embedded Sandbox with its browser telemetry off', async () => {
    const { a, server } = await app();
    try {
      const res = await request(a).get('/graphql').set('Accept', 'text/html');

      assert.equal(res.status, 200);
      assert.match(res.headers['content-type'], /text\/html/);
      assert.match(res.text, /embeddableSandbox/);
      // The embed config is serialized into the page as JSON. Asserting the
      // pair, not just the key, is what catches a default of `true`.
      assert.match(res.text, /"runTelemetry":false/);
      assert.doesNotMatch(res.text, /"runTelemetry":true/);
    } finally {
      await server.stop();
    }
  });
});
