/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  CachedGatewayRegistry,
  GatewayReader,
  gatewayUrl,
} from './gateway-registry.js';
import { createTestLogger } from '../../test/test-logger.js';

const log = createTestLogger({ suite: 'gateway registry' });

describe('gatewayUrl', () => {
  it('omits the port when it is the default for the protocol', () => {
    assert.equal(
      gatewayUrl({ protocol: 'https', fqdn: 'example.com', port: 443 }),
      'https://example.com',
    );
    assert.equal(
      gatewayUrl({ protocol: 'http', fqdn: 'example.com', port: 80 }),
      'http://example.com',
    );
  });

  it('keeps a non-default port', () => {
    assert.equal(
      gatewayUrl({ protocol: 'https', fqdn: 'example.com', port: 8443 }),
      'https://example.com:8443',
    );
  });

  it('defaults to https and rejects a record with no hostname', () => {
    assert.equal(gatewayUrl({ fqdn: 'example.com' }), 'https://example.com');
    assert.equal(gatewayUrl({ fqdn: '' }), undefined);
    assert.equal(gatewayUrl({}), undefined);
  });
});

describe('CachedGatewayRegistry', () => {
  const record = {
    settings: { protocol: 'https', fqdn: 'gw.example', port: 443 },
    observerAddress: 'ObserverAddress',
    status: 'joined' as const,
  };

  const readerCounting = (
    impl: () => Promise<typeof record | undefined>,
  ): { reader: GatewayReader; calls: () => number } => {
    let calls = 0;
    return {
      reader: {
        getGateway: async () => {
          calls++;
          return impl();
        },
      },
      calls: () => calls,
    };
  };

  it('resolves a wallet to its URL and signing key', async () => {
    const { reader } = readerCounting(async () => record);
    const registry = new CachedGatewayRegistry({ log, reader, ttlMs: 1000 });

    assert.deepEqual(await registry.lookup('wallet'), {
      wallet: 'wallet',
      observerAddress: 'ObserverAddress',
      url: 'https://gw.example',
      status: 'joined',
    });
  });

  it('serves repeats from cache until the TTL expires', async () => {
    const { reader, calls } = readerCounting(async () => record);
    let now = 0;
    const registry = new CachedGatewayRegistry({
      log,
      reader,
      ttlMs: 1000,
      now: () => now,
    });

    await registry.lookup('wallet');
    await registry.lookup('wallet');
    assert.equal(
      calls(),
      1,
      'the RPC is shared and rate limited; do not spam it',
    );

    now = 1001;
    await registry.lookup('wallet');
    assert.equal(calls(), 2);
  });

  it('collapses concurrent lookups of the same wallet onto one call', async () => {
    const { reader, calls } = readerCounting(
      () => new Promise((resolve) => setTimeout(() => resolve(record), 10)),
    );
    const registry = new CachedGatewayRegistry({ log, reader, ttlMs: 1000 });

    await Promise.all(
      Array.from({ length: 10 }, () => registry.lookup('wallet')),
    );
    assert.equal(calls(), 1);
  });

  it('caches a read failure only briefly, so a flap does not become a storm', async () => {
    let fail = true;
    const { reader, calls } = readerCounting(async () => {
      if (fail) throw new Error('rpc down');
      return record;
    });
    let now = 0;
    const registry = new CachedGatewayRegistry({
      log,
      reader,
      ttlMs: 600_000,
      now: () => now,
    });

    assert.equal(await registry.lookup('wallet'), undefined);
    assert.equal(await registry.lookup('wallet'), undefined);
    assert.equal(calls(), 1, 'the failure is cached');

    // A failure is held far more briefly than a success, so recovery is fast.
    fail = false;
    now = 30_001;
    assert.notEqual(await registry.lookup('wallet'), undefined);
  });

  it('returns undefined for a wallet that is not a registered gateway', async () => {
    const { reader } = readerCounting(async () => undefined);
    const registry = new CachedGatewayRegistry({ log, reader, ttlMs: 1000 });
    assert.equal(await registry.lookup('nobody'), undefined);
  });
});
