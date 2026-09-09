/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { classifyResolvedTarget } from './resolved-target.js';

const ARWEAVE_ID = 'M2tMZzF3XAcXvyg9DR6U07Cj5HY-JLgT6tCPujdkKZ0'; // 43-char base64url
const CID_V1 = 'bafybeifx7yeb55armcsxwwitkymga5xf53dxiarykms3ygqic223w5sk3m';
const CID_V0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';

describe('classifyResolvedTarget', () => {
  describe('Arweave targets', () => {
    it('classifies a 43-char Arweave id as arweave when targetProtocol is 0', () => {
      assert.equal(classifyResolvedTarget(ARWEAVE_ID, 0), 'arweave');
    });

    it('defaults to arweave when targetProtocol is undefined (older ANT)', () => {
      assert.equal(classifyResolvedTarget(ARWEAVE_ID, undefined), 'arweave');
    });

    it('rejects an unknown protocol number rather than mis-serving as arweave', () => {
      assert.throws(
        () => classifyResolvedTarget(ARWEAVE_ID, 2),
        /Unsupported targetProtocol/,
      );
    });

    it('rejects a non-Arweave id under an Arweave protocol', () => {
      assert.throws(
        () => classifyResolvedTarget(CID_V1, 0),
        /Invalid resolved data ID/,
      );
    });
  });

  describe('IPFS targets', () => {
    it('classifies a CIDv1 as ipfs when targetProtocol is 1', () => {
      assert.equal(classifyResolvedTarget(CID_V1, 1), 'ipfs');
    });

    it('accepts a CIDv0 under the IPFS protocol', () => {
      assert.equal(classifyResolvedTarget(CID_V0, 1), 'ipfs');
    });

    it('rejects an Arweave id under the IPFS protocol', () => {
      assert.throws(
        () => classifyResolvedTarget(ARWEAVE_ID, 1),
        /Invalid resolved IPFS CID/,
      );
    });

    it('rejects garbage under the IPFS protocol', () => {
      assert.throws(
        () => classifyResolvedTarget('not-a-cid', 1),
        /Invalid resolved IPFS CID/,
      );
    });
  });
});
