/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it, before, after, beforeEach } from 'node:test';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import winston from 'winston';

import { GatewaysDataSource } from './gateways-data-source.js';
import { GatewayThrottle } from './gateway-throttle.js';
import { ContiguousData } from '../types.js';

/**
 * A gateway that answers 429 must be skipped until its Retry-After has passed.
 *
 * Seen on turbo-gateway.com: arweave.net (priority 2, untrusted) answered
 * gw2's cold-item requests with `429` and `retry-after: 299` about 24,000
 * times a day. Every request still went to it first, waited for one of its
 * 48 sockets until the 3 s connection timeout, then fell through, so cold
 * items took ~3 s on that node against ~0.1 s on its sibling without the
 * fallback. These tests use real HTTP servers and the real axios, since the
 * status of a 429 arrives on axios's rejection, not on a resolved response.
 */
describe('GatewaysDataSource and throttling gateways', () => {
  const ID = 'fZMMYJWN-kn5nk2mNpDKR1hh3hwpBljKvPvtWLQVVa0';
  const body = Buffer.from('the data');
  const servers: http.Server[] = [];
  const hits = { throttling: 0, missing: 0, backstop: 0 };
  let throttlingUrl: string;
  let missingUrl: string;
  let backstopUrl: string;

  const serve = async (
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  ) => {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    servers.push(server);
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  before(async () => {
    throttlingUrl = await serve((_req, res) => {
      hits.throttling++;
      res.writeHead(429, { 'Retry-After': '120' });
      res.end();
    });
    missingUrl = await serve((_req, res) => {
      hits.missing++;
      res.writeHead(404);
      res.end();
    });
    backstopUrl = await serve((_req, res) => {
      hits.backstop++;
      res.writeHead(200, { 'Content-Length': body.length });
      res.end(body);
    });
  });

  after(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  beforeEach(() => {
    hits.throttling = hits.missing = hits.backstop = 0;
  });

  /** A logger whose entries can be read back, to check levels. */
  const capturingLogger = () => {
    const entries: { level: string; message: string }[] = [];
    const log = winston.createLogger({
      level: 'debug',
      format: winston.format.json(),
      transports: [
        new winston.transports.Stream({
          stream: new Writable({
            write(chunk, _enc, done) {
              entries.push(JSON.parse(chunk.toString()));
              done();
            },
          }),
        }),
      ],
    });
    return { log, entries };
  };

  const readAll = async (data: ContiguousData) => {
    const chunks: Buffer[] = [];
    for await (const chunk of data.stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  };

  const make = ({
    first,
    clock,
    enabled = true,
    throttle,
    fallbackToBasePath = false,
    log = capturingLogger().log,
  }: {
    first: string;
    clock: { t: number };
    enabled?: boolean;
    throttle?: GatewayThrottle;
    fallbackToBasePath?: boolean;
    log?: winston.Logger;
  }) =>
    new GatewaysDataSource({
      log,
      trustedGatewaysUrls: {
        [first]: { priority: 1, trusted: false },
        [backstopUrl]: { priority: 2, trusted: true },
      },
      fallbackToBasePath,
      throttle:
        throttle ??
        new GatewayThrottle({
          log,
          enabled,
          defaultMs: 30_000,
          maxMs: 300_000,
          now: () => clock.t,
        }),
    });

  const get = async (ds: GatewaysDataSource) =>
    readAll(
      await ds.getData({ id: ID, requestAttributes: { hops: 0 } as any }),
    );

  it('skips a gateway that answered 429 until its Retry-After has passed', async () => {
    const clock = { t: 0 };
    const ds = make({ first: throttlingUrl, clock });

    assert.deepEqual(await get(ds), body);
    assert.equal(hits.throttling, 1);

    // Within the 120 s it asked for: straight to the next tier.
    clock.t += 60_000;
    assert.deepEqual(await get(ds), body);
    assert.deepEqual(await get(ds), body);
    assert.equal(hits.throttling, 1, 'not asked again while cooling down');
    assert.equal(hits.backstop, 3);

    // After it: tried again.
    clock.t += 60_000;
    assert.deepEqual(await get(ds), body);
    assert.equal(hits.throttling, 2);
  });

  it('asks a throttling gateway once per item, not once per path', async () => {
    const ds = make({
      first: throttlingUrl,
      clock: { t: 0 },
      fallbackToBasePath: true,
    });

    await get(ds);

    assert.equal(hits.throttling, 1, 'no second request to /<id>');
  });

  it('keeps asking a gateway that only lacks the data', async () => {
    const ds = make({ first: missingUrl, clock: { t: 0 } });

    await get(ds);
    await get(ds);

    assert.equal(hits.missing, 2, 'a 404 is not throttling');
  });

  it('shares cooldowns between data sources given the same throttle', async () => {
    const clock = { t: 0 };
    const { log } = capturingLogger();
    const throttle = new GatewayThrottle({ log, now: () => clock.t });
    const first = make({ first: throttlingUrl, clock, throttle });
    const second = make({
      first: throttlingUrl,
      clock,
      throttle,
      fallbackToBasePath: true,
    });

    await get(first);
    await get(second);

    assert.equal(hits.throttling, 1);
  });

  it('asks every time when backoff is disabled', async () => {
    const ds = make({ first: throttlingUrl, clock: { t: 0 }, enabled: false });

    await get(ds);
    await get(ds);

    assert.equal(hits.throttling, 2);
  });

  it('logs a 429 or 404 from a gateway at debug, not as a warning', async () => {
    for (const first of [throttlingUrl, missingUrl]) {
      const { log, entries } = capturingLogger();
      const ds = make({ first, clock: { t: 0 }, log });

      await get(ds);

      const failures = entries.filter(
        (e) => e.message === 'Failed to fetch from gateway',
      );
      assert.equal(failures.length, 1, first);
      assert.equal(failures[0].level, 'debug', first);
    }
  });
});
