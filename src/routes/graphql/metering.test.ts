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
});
