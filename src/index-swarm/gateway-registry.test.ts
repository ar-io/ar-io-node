/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';

import { createTestLogger } from '../../test/test-logger.js';
import { CoreGatewayRegistry } from './gateway-registry.js';

const log = createTestLogger({ suite: 'CoreGatewayRegistry' });

/** What a current gateway's /ar-io/peers returns, trimmed to two peers. */
const PEERS = {
  gateways: {
    'a.example:443': {
      url: 'https://a.example',
      dataWeight: 50,
      chunkWeight: 50,
      wallet: 'wallet-a',
      observerAddress: 'observer-a',
      operatorStake: 10_000,
      status: 'joined',
    },
    'b.example:8443': {
      url: 'https://b.example:8443',
      dataWeight: 50,
      chunkWeight: 50,
      wallet: 'wallet-b',
      observerAddress: 'observer-b',
      status: 'leaving',
    },
  },
  arweaveNodes: {},
};

describe('CoreGatewayRegistry', () => {
  let server: http.Server;
  let url: string;
  let body: unknown;
  let status: number;
  let requests: number;
  let clock: number;

  beforeEach(async () => {
    body = PEERS;
    status = 200;
    requests = 0;
    clock = 0;
    server = http.createServer((req, res) => {
      requests++;
      if (req.url !== '/ar-io/peers') {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const registry = () =>
    new CoreGatewayRegistry({
      log,
      coreUrl: url,
      ttlMs: 60_000,
      now: () => clock,
    });

  it('reads every gateway, with its registry fields, from the gateway’s peer list', async () => {
    const all = await registry().list();
    assert.deepEqual(all, [
      {
        wallet: 'wallet-a',
        observerAddress: 'observer-a',
        url: 'https://a.example',
        fqdn: 'a.example',
        status: 'joined',
        operatorStake: 10_000,
      },
      {
        wallet: 'wallet-b',
        observerAddress: 'observer-b',
        url: 'https://b.example:8443',
        fqdn: 'b.example',
        status: 'leaving',
        operatorStake: 0,
      },
    ]);
  });

  it('resolves a publisher by wallet, and nothing for one it does not know', async () => {
    const r = registry();
    assert.deepEqual(await r.lookup('wallet-a'), {
      wallet: 'wallet-a',
      observerAddress: 'observer-a',
      url: 'https://a.example',
      status: 'joined',
    });
    assert.equal(await r.lookup('nobody'), undefined);
  });

  it('reads the peer list once per TTL, however many lookups ask', async () => {
    const r = registry();
    await Promise.all([r.lookup('wallet-a'), r.lookup('wallet-b'), r.list()]);
    await r.lookup('wallet-a');
    assert.equal(requests, 1);
    clock += 60_001;
    await r.lookup('wallet-a');
    assert.equal(requests, 2);
  });

  it('keeps the last good read while the gateway is unreachable', async () => {
    const r = registry();
    await r.list();
    status = 503;
    clock += 60_001;
    assert.equal((await r.list()).length, 2);
    assert.equal((await r.lookup('wallet-a'))?.observerAddress, 'observer-a');
  });

  it('resolves nothing, rather than throwing, before any good read', async () => {
    status = 503;
    assert.equal(await registry().lookup('wallet-a'), undefined);
    await assert.rejects(registry().list());
  });

  it('skips peers without registry fields, as an older gateway reports them', async () => {
    body = {
      gateways: {
        'old.example:443': {
          url: 'https://old.example',
          dataWeight: 1,
          chunkWeight: 1,
        },
      },
    };
    assert.deepEqual(await registry().list(), []);
  });
});
