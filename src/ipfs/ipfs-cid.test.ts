/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  parseCid,
  isValidCid,
  isCidV0,
  cidToV1Base32,
  cidToString,
} from '../lib/ipfs-cid.js';

describe('ipfs-cid utilities', () => {
  // Known CIDv1 base32 (dag-pb, sha2-256)
  const CIDV1_BASE32 =
    'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

  // Known CIDv0 (Qm prefix, base58btc)
  const CIDV0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';

  describe('parseCid', () => {
    it('parses a valid CIDv1 base32 string', () => {
      const cid = parseCid(CIDV1_BASE32);
      assert.notEqual(cid, null);
      assert.equal(cid!.version, 1);
    });

    it('parses a valid CIDv0 string', () => {
      const cid = parseCid(CIDV0);
      assert.notEqual(cid, null);
      assert.equal(cid!.version, 0);
    });

    it('returns null for invalid strings', () => {
      assert.equal(parseCid('not-a-cid'), null);
      assert.equal(parseCid(''), null);
      assert.equal(parseCid('abc123'), null);
    });

    it('returns null for Arweave TX IDs (43-char base64url)', () => {
      // A typical Arweave TX ID — not a valid CID
      assert.equal(
        parseCid('TB2wJyKrPnkAW79DAwlJYwpgdHKpijEJWQfcwX715Co'),
        null,
      );
    });
  });

  describe('isValidCid', () => {
    it('returns true for valid CIDs', () => {
      assert.equal(isValidCid(CIDV1_BASE32), true);
      assert.equal(isValidCid(CIDV0), true);
    });

    it('returns false for invalid strings', () => {
      assert.equal(isValidCid('not-a-cid'), false);
      assert.equal(isValidCid(''), false);
    });
  });

  describe('isCidV0', () => {
    it('returns true for CIDv0', () => {
      const cid = parseCid(CIDV0)!;
      assert.equal(isCidV0(cid), true);
    });

    it('returns false for CIDv1', () => {
      const cid = parseCid(CIDV1_BASE32)!;
      assert.equal(isCidV0(cid), false);
    });
  });

  describe('cidToV1Base32', () => {
    it('converts CIDv0 to CIDv1 base32', () => {
      const result = cidToV1Base32(CIDV0);
      // Result should start with 'bafy' (dag-pb, sha2-256)
      assert.match(result, /^bafy/);
      // Should be all lowercase (DNS-safe)
      assert.equal(result, result.toLowerCase());
    });

    it('returns CIDv1 base32 unchanged', () => {
      const result = cidToV1Base32(CIDV1_BASE32);
      assert.equal(result, CIDV1_BASE32);
    });

    it('throws for invalid CID strings', () => {
      assert.throws(() => cidToV1Base32('not-a-cid'));
    });
  });

  describe('cidToString', () => {
    it('returns base58btc for CIDv0', () => {
      const cid = parseCid(CIDV0)!;
      const result = cidToString(cid);
      assert.match(result, /^Qm/);
    });

    it('returns base32 for CIDv1', () => {
      const cid = parseCid(CIDV1_BASE32)!;
      const result = cidToString(cid);
      assert.match(result, /^bafy/);
    });
  });
});
