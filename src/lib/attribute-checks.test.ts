/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';

import { ownerMatchesAddress, signatureMatchesId } from './attribute-checks.js';

const b64 = (b: Buffer) => b.toString('base64url');
const sha = (b: Buffer) => b64(crypto.createHash('sha256').update(b).digest());

describe('attribute checks', () => {
  it('accepts a signature whose SHA-256 is the id, and nothing else', () => {
    const signature = crypto.randomBytes(512);
    assert.equal(signatureMatchesId(b64(signature), sha(signature)), true);
    const other = Buffer.from(signature);
    other[0] ^= 1;
    assert.equal(signatureMatchesId(b64(other), sha(signature)), false);
  });

  it('accepts an owner key whose SHA-256 is the address, whatever its type', () => {
    // An RSA modulus, an Ethereum key (65 bytes), a compressed secp256k1 key.
    for (const size of [512, 65, 33]) {
      const owner = crypto.randomBytes(size);
      assert.equal(ownerMatchesAddress(b64(owner), sha(owner)), true);
      assert.equal(
        ownerMatchesAddress(b64(owner.subarray(1)), sha(owner)),
        false,
      );
    }
  });
});
