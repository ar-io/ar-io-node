/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ARIORead } from '@ar.io/sdk';
import { type Rpc, type SolanaRpcApi } from '@solana/kit';

import { createArNSResolver } from './resolvers.js';
import { ARNS_RESOLVER_PRIORITY_ORDER } from '../config.js';
import { KvArNSRegistryStore } from '../store/kv-arns-base-name-store.js';
import { KvArNSResolutionStore } from '../store/kv-arns-name-resolution-store.js';
import { createTestLogger } from '../../test/test-logger.js';

const log = createTestLogger({ suite: 'createArNSResolver' });

// CompositeArNSResolver eagerly constructs an ArNSNamesCache, which hydrates
// itself on construction by paginating the registry. An empty first page ends
// that walk immediately and keeps these tests off the network.
const networkProcess = {
  getArNSRecords: async () => ({ items: [], nextCursor: undefined }),
} as unknown as ARIORead;

const kvStub = {
  get: async () => undefined,
  set: async () => undefined,
  del: async () => undefined,
  has: async () => false,
  close: async () => undefined,
};
const resolutionCache = kvStub as unknown as KvArNSResolutionStore;
const registryCache = kvStub as unknown as KvArNSRegistryStore;

// OnDemandArNSResolver only stores the client at construction time, so a bare
// stub is enough to observe chain ordering without touching Solana.
const solanaRpc = {} as Rpc<SolanaRpcApi>;

const TRUSTED_GATEWAY_URL = 'https://example.com';

function chainFor(
  resolutionOrder: string[],
  // Options object rather than a defaulted positional: passing `undefined`
  // positionally would re-trigger the default and never exercise the
  // "no trusted gateway configured" branch.
  { trustedGatewayUrl }: { trustedGatewayUrl?: string } = {
    trustedGatewayUrl: TRUSTED_GATEWAY_URL,
  },
): string[] {
  const resolver = createArNSResolver({
    log,
    resolutionCache,
    registryCache,
    resolutionOrder,
    trustedGatewayUrl,
    networkProcess,
    solanaRpc,
  });

  // `resolvers` is private on CompositeArNSResolver; the constructed order is
  // the behavior under test, so read it directly rather than inferring it from
  // resolution attempts against stubbed resolvers.
  return (resolver as unknown as { resolvers: unknown[] }).resolvers.map(
    (r) => (r as object).constructor.name,
  );
}

describe('createArNSResolver', () => {
  it('builds the resolver chain in the configured order', () => {
    assert.deepEqual(chainFor(['on-demand', 'gateway']), [
      'OnDemandArNSResolver',
      'TrustedGatewayArNSResolver',
    ]);
  });

  it('reverses the chain when the configured order is reversed', () => {
    assert.deepEqual(chainFor(['gateway', 'on-demand']), [
      'TrustedGatewayArNSResolver',
      'OnDemandArNSResolver',
    ]);
  });

  it('ignores unsupported resolver types without dropping supported ones', () => {
    assert.deepEqual(chainFor(['nonsense', 'on-demand', '', 'gateway']), [
      'OnDemandArNSResolver',
      'TrustedGatewayArNSResolver',
    ]);
  });

  it('omits the gateway resolver when no trusted gateway URL is configured', () => {
    assert.deepEqual(chainFor(['on-demand', 'gateway'], {}), [
      'OnDemandArNSResolver',
    ]);
  });
});

describe('ARNS_RESOLVER_PRIORITY_ORDER default', () => {
  it('resolves on-demand before falling back to a trusted gateway', (t) => {
    // An operator override in the ambient environment makes the shipped default
    // unobservable; skip rather than assert against the override.
    if (process.env.ARNS_RESOLVER_PRIORITY_ORDER !== undefined) {
      t.skip('ARNS_RESOLVER_PRIORITY_ORDER is set in the environment');
      return;
    }

    assert.deepEqual(ARNS_RESOLVER_PRIORITY_ORDER, ['on-demand', 'gateway']);
  });
});
