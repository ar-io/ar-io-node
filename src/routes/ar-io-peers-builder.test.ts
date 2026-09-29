/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { buildGatewayPeers } from './ar-io-peers-builder.js';

describe('buildGatewayPeers', () => {
  it('maps each peer’s weights and registry fields into the response entry', () => {
    const peers = buildGatewayPeers({
      'a.com:443': {
        url: 'https://a.com',
        weights: { data: 50, chunk: 20 },
        wallet: 'walletA',
        observerAddress: 'observerA',
        operatorStake: 123_000_000,
        status: 'joined',
      },
      'b.com:443': {
        url: 'https://b.com',
        weights: { data: 1, chunk: 2 },
        wallet: 'walletB',
        observerAddress: 'observerB',
        operatorStake: 5,
        status: 'leaving',
      },
    });

    assert.deepEqual(peers, {
      'a.com:443': {
        url: 'https://a.com',
        dataWeight: 50,
        chunkWeight: 20,
        wallet: 'walletA',
        observerAddress: 'observerA',
        operatorStake: 123_000_000,
        status: 'joined',
      },
      'b.com:443': {
        url: 'https://b.com',
        dataWeight: 1,
        chunkWeight: 2,
        wallet: 'walletB',
        observerAddress: 'observerB',
        operatorStake: 5,
        status: 'leaving',
      },
    });
  });

  it('omits registry fields the peer manager has no value for', () => {
    const peers = buildGatewayPeers({
      'c.com:443': { url: 'https://c.com', weights: { data: 7, chunk: 3 } },
    });
    assert.deepEqual(peers, {
      'c.com:443': { url: 'https://c.com', dataWeight: 7, chunkWeight: 3 },
    });
    assert.equal('wallet' in peers['c.com:443'], false);
  });
});
