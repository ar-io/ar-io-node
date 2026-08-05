/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import axios from 'axios';

import {
  BASE_AGENT_OPTIONS,
  createAgentPair,
  instrumentAgent,
} from './http-agent.js';
import * as config from '../config.js';
import { createTestLogger } from '../../test/test-logger.js';

const log = createTestLogger({ suite: 'http-agent' });

describe('BASE_AGENT_OPTIONS', () => {
  it('enables keep-alive', () => {
    assert.equal(BASE_AGENT_OPTIONS.keepAlive, true);
  });

  // The invariant that makes pooling safe: if the client held idle sockets at
  // least as long as the peer's server keep-alive, it would reuse a socket the
  // peer is concurrently FIN-closing and stall until the teardown resolves.
  it('retires idle sockets strictly before a peer server would', () => {
    assert.ok(
      BASE_AGENT_OPTIONS.timeout < config.HTTP_KEEP_ALIVE_TIMEOUT_MS,
      `agent idle timeout (${BASE_AGENT_OPTIONS.timeout}ms) must be < server ` +
        `keep-alive (${config.HTTP_KEEP_ALIVE_TIMEOUT_MS}ms)`,
    );
  });
});

describe('createAgentPair', () => {
  it('returns keep-alive agents for both schemes', () => {
    const { httpAgent, httpsAgent } = createAgentPair({
      client: 'TestClient',
      log,
    });

    assert.equal((httpAgent as any).keepAlive, true);
    assert.equal((httpsAgent as any).keepAlive, true);
  });

  it('applies per-origin socket caps', () => {
    const { httpAgent, httpsAgent } = createAgentPair({
      client: 'TestClient',
      log,
      options: { maxSockets: 3, maxFreeSockets: 2 },
    });

    assert.equal(httpAgent.maxSockets, 3);
    assert.equal(httpAgent.maxFreeSockets, 2);
    assert.equal(httpsAgent.maxSockets, 3);
    assert.equal(httpsAgent.maxFreeSockets, 2);
  });

  it('shapes into an axios config without clobbering other options', () => {
    const instance = axios.create({
      timeout: 1234,
      ...createAgentPair({ client: 'TestClient', log }),
    });

    assert.equal(instance.defaults.timeout, 1234);
    assert.ok(instance.defaults.httpAgent !== undefined);
    assert.ok(instance.defaults.httpsAgent !== undefined);
  });
});

describe('connection reuse', () => {
  let server: http.Server;
  let baseUrl: string;
  // Distinct remote ports prove the socket was reopened; a single entry across
  // several requests proves the pool is being reused.
  const remotePorts = new Set<number>();

  before(async () => {
    server = http.createServer((req, res) => {
      remotePorts.add(req.socket.remotePort ?? 0);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  });

  it('reuses one socket across sequential requests', async () => {
    const { httpAgent, httpsAgent } = createAgentPair({
      client: 'ReuseTest',
      log,
    });
    const instance = axios.create({ timeout: 5000, httpAgent, httpsAgent });

    for (let i = 0; i < 4; i++) {
      const res = await instance.get(`${baseUrl}/`);
      assert.equal(res.status, 200);
    }

    assert.equal(
      remotePorts.size,
      1,
      `expected one pooled socket, saw ${remotePorts.size} distinct remote ports`,
    );

    httpAgent.destroy();
    httpsAgent.destroy();
  });
});

describe('instrumentAgent', () => {
  it('reports acquisition and marks the first socket as not reused', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

    const samples: { reused: boolean; connectSeconds?: number }[] = [];
    const agent = new http.Agent({ keepAlive: true });
    instrumentAgent({
      agent,
      isTls: false,
      observe: (s) => samples.push(s),
    });

    await axios.get(url, { httpAgent: agent, timeout: 5000 });

    // First request over a cold pool: one acquisition sample (reused=false)
    // plus one connect sample for the newly opened socket.
    assert.ok(samples.length >= 1);
    assert.equal(samples[0].reused, false);
    assert.equal(samples[0].connectSeconds, undefined);

    agent.destroy();
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  });
});
