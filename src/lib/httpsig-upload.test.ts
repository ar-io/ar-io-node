/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { buildAttestationTags } from './httpsig-upload.js';

describe('httpsig-upload', () => {
  describe('buildAttestationTags', () => {
    it('includes all required tags', () => {
      const tags = buildAttestationTags({
        gatewayAddress: 'gw-addr',
        observerAddress: 'obs-addr',
        ed25519PublicKey: 'pubkey-b64url',
        keyId: 'ed25519:pubkey-b64url',
      });

      const names = tags.map((t) => t.name);
      assert.ok(names.includes('App-Name'));
      assert.ok(names.includes('Type'));
      assert.ok(names.includes('Content-Type'));
      assert.ok(names.includes('Gateway-Address'));
      assert.ok(names.includes('Observer-Address'));
      assert.ok(names.includes('Ed25519-Public-Key'));
      assert.ok(names.includes('Key-Id'));
    });

    it('sets correct values', () => {
      const tags = buildAttestationTags({
        gatewayAddress: 'gw-addr',
        observerAddress: 'obs-addr',
        ed25519PublicKey: 'pubkey',
        keyId: 'ed25519:pubkey',
      });

      const find = (name: string) => tags.find((t) => t.name === name)?.value;
      assert.equal(find('App-Name'), 'AR-IO-Gateway');
      assert.equal(find('Type'), 'HTTPSIG-Key-Attestation');
      assert.equal(find('Content-Type'), 'application/json');
      assert.equal(find('Gateway-Address'), 'gw-addr');
      assert.equal(find('Observer-Address'), 'obs-addr');
      assert.equal(find('Ed25519-Public-Key'), 'pubkey');
      assert.equal(find('Key-Id'), 'ed25519:pubkey');
    });

    it('omits Gateway-Address when undefined', () => {
      const tags = buildAttestationTags({
        gatewayAddress: undefined,
        observerAddress: 'obs-addr',
        ed25519PublicKey: 'pubkey',
        keyId: 'ed25519:pubkey',
      });

      const names = tags.map((t) => t.name);
      assert.ok(!names.includes('Gateway-Address'));
      // Other required tags still present
      assert.ok(names.includes('App-Name'));
      assert.ok(names.includes('Observer-Address'));
    });
  });
});
