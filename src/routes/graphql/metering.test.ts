/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Exercised over real HTTP, with a real body parser and the in-memory rate
 * limiter, so the batch arrives as an array and the buckets are the real ones.
 * The shared limiter helper is gated on ENABLE_RATE_LIMITER, read when config
 * first loads, so it is set before the modules are imported; each test file
 * runs in its own process.
 */
import { strict as assert } from 'node:assert';
import { before, describe, it } from 'node:test';
import express from 'express';
import request from 'supertest';

process.env.ENABLE_RATE_LIMITER = 'true';

describe('GraphQL metering', () => {
  let createGraphqlMeter: typeof import('./metering.js').createGraphqlMeter;
  let MemoryRateLimiter: typeof import('../../limiter/memory-rate-limiter.js').MemoryRateLimiter;

  before(async () => {
    ({ createGraphqlMeter } = await import('./metering.js'));
    ({ MemoryRateLimiter } = await import(
      '../../limiter/memory-rate-limiter.js'
    ));
  });

  /**
   * An app whose IP bucket holds `ipCapacity` tokens and never refills during
   * a test, with each operation costing 10 tokens.
   */
  function app({
    ipCapacity = 30,
    resourceCapacity = 1_000_000,
    ipAllowlist = [] as string[],
  } = {}) {
    let reachedApollo = 0;
    const rateLimiter = new MemoryRateLimiter({
      resourceCapacity,
      resourceRefillRate: 0,
      ipCapacity,
      ipRefillRate: 0,
      limitsEnabled: true,
      ipAllowlist,
      capacityMultiplier: 10,
      maxBuckets: 1000,
    });
    const server = express();
    server.use(
      '/graphql',
      express.json(),
      createGraphqlMeter({ rateLimiter, operationCostBytes: 10240 }),
      (_req, res) => {
        reachedApollo++;
        res.json({ data: {} });
      },
    );
    return { server, rateLimiter, reached: () => reachedApollo };
  }

  const query = { query: '{ blocks(first: 1) { edges { node { id } } } }' };
  // A fixed Host: the resource bucket is keyed by it, and supertest's Host
  // carries a port that changes with every request.
  const from = (ip: string) => ({
    Host: 'gateway.example',
    'X-Forwarded-For': ip,
  });

  it('charges each operation and refuses once the IP bucket is spent', async () => {
    const { server, reached } = app();
    for (let i = 0; i < 3; i++) {
      await request(server).post('/graphql').send(query).expect(200);
    }
    const refused = await request(server).post('/graphql').send(query);
    assert.equal(refused.status, 429);
    assert.equal(reached(), 3, 'a refused query never reaches Apollo');
  });

  it('charges a batch per operation, so batching does not multiply the allowance', async () => {
    const { server, reached } = app();
    await request(server)
      .post('/graphql')
      .send([query, query, query])
      .expect(200);
    await request(server).post('/graphql').send(query).expect(429);
    // A batch bigger than the whole bucket is refused outright.
    const big = app();
    await request(big.server)
      .post('/graphql')
      .send([query, query, query, query])
      .expect(429);
    assert.equal(reached(), 1);
  });

  it('charges only the IP bucket: one client cannot spend the allowance of others', async () => {
    // A resource bucket smaller than one client's spend. If GraphQL were
    // charged to it, the first client would lock every other one out.
    const { server } = app({ resourceCapacity: 15 });
    for (let i = 0; i < 3; i++) {
      await request(server)
        .post('/graphql')
        .set(from('203.0.113.1'))
        .send(query)
        .expect(200);
    }
    await request(server)
      .post('/graphql')
      .set(from('203.0.113.1'))
      .send(query)
      .expect(429);
    await request(server)
      .post('/graphql')
      .set(from('203.0.113.2'))
      .send(query)
      .expect(200);
  });

  it('does not charge the Sandbox page or a preflight, and charges a GET query', async () => {
    const { server } = app({ ipCapacity: 10 });
    for (let i = 0; i < 5; i++) {
      await request(server).get('/graphql').expect(200);
      await request(server).options('/graphql').expect(200);
    }
    await request(server)
      .get('/graphql')
      .query({ query: query.query })
      .expect(200);
    await request(server)
      .get('/graphql')
      .query({ query: query.query })
      .expect(429);
  });

  it('charges a GET query that padding hides from Express but not from Apollo', async () => {
    // Express stops parsing the query string after 1,000 parameters; Apollo
    // reads all of it. Padding must not make a query free.
    const { server } = app({ ipCapacity: 10 });
    const padding = Array.from({ length: 1000 }, (_, i) => `p${i}=1`).join('&');
    const url = `/graphql?${padding}&query=${encodeURIComponent(query.query)}`;
    await request(server).get(url).expect(200);
    await request(server).get(url).expect(429);
  });

  it('does not charge a browser GET that Apollo answers with the Sandbox page', async () => {
    const { server } = app({ ipCapacity: 10 });
    const html = 'text/html,application/xhtml+xml,*/*;q=0.8';
    for (let i = 0; i < 3; i++) {
      await request(server)
        .get('/graphql')
        .query({ query: query.query })
        .set('Accept', html)
        .expect(200);
    }
    // A client asking for JSON gets the query run, and pays for it.
    await request(server)
      .get('/graphql')
      .query({ query: query.query })
      .set('Accept', 'application/json')
      .expect(200);
    await request(server)
      .get('/graphql')
      .query({ query: query.query })
      .set('Accept', 'application/json')
      .expect(429);
  });

  it('lets an allowlisted client through without charge', async () => {
    const { server } = app({ ipCapacity: 10, ipAllowlist: ['203.0.113.9'] });
    for (let i = 0; i < 5; i++) {
      await request(server)
        .post('/graphql')
        .set(from('203.0.113.9'))
        .send(query)
        .expect(200);
    }
  });

  // The meter decides from the request alone whether Apollo will run the
  // query or show its Sandbox page. If the two ever disagree, a query runs
  // free. So ask Apollo itself, for a spread of Accept headers.
  it('charges a GET exactly when Apollo runs the query (Accept negotiation)', async () => {
    const { ApolloServer } = await import('@apollo/server');
    const { expressMiddleware } = await import('@as-integrations/express4');
    const { ApolloServerPluginLandingPageLocalDefault } = await import(
      '@apollo/server/plugin/landingPage/default'
    );
    const apollo = new ApolloServer({
      typeDefs: 'type Query { ok: Int }',
      resolvers: { Query: { ok: () => 1 } },
      plugins: [ApolloServerPluginLandingPageLocalDefault({ embed: true })],
    });
    await apollo.start();
    try {
      for (const accept of [
        'application/json',
        'application/json; charset=utf-8, text/html;q=0.9',
        'text/html,application/xhtml+xml,*/*;q=0.8',
        'text/html',
        'application/graphql-response+json',
        'text/html;q=0.5, application/json;q=0.6',
        'text/html, application/json',
        '*/*',
        'multipart/mixed',
      ]) {
        let charged = 0;
        const limiter = new MemoryRateLimiter({
          resourceCapacity: 1_000_000,
          resourceRefillRate: 0,
          ipCapacity: 1_000_000,
          ipRefillRate: 0,
          limitsEnabled: true,
          ipAllowlist: [],
          capacityMultiplier: 10,
          maxBuckets: 1000,
        });
        const counting = new Proxy(limiter, {
          get(target, prop, receiver) {
            if (prop === 'checkLimit') {
              return (...args: unknown[]) => {
                charged++;
                return (target as any).checkLimit(...args);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
        const server = express();
        server.use(
          '/graphql',
          express.json(),
          createGraphqlMeter({
            rateLimiter: counting,
            operationCostBytes: 10240,
          }),
          expressMiddleware(apollo),
        );
        const res = await request(server)
          .get('/graphql')
          .query({ query: '{ ok }' })
          .set('Accept', accept)
          // Apollo refuses a GET without this, as CSRF prevention.
          .set('apollo-require-preflight', 'true');
        const ran = /json/.test(res.headers['content-type'] ?? '');
        assert.equal(
          charged > 0,
          ran,
          `Accept: ${accept} -> ${res.headers['content-type']}, charged ${charged}`,
        );
      }
    } finally {
      await apollo.stop();
    }
  });
});
