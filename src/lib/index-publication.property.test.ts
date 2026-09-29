/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import crypto from 'node:crypto';
import fc from 'fast-check';

import { getSolanaAddress, publicKeyFromSolanaAddress } from './httpsig.js';
import {
  IndexPublication,
  canonicalizeIndexPublication,
  manifestSha256,
  parseIndexPublication,
  serializeIndexPublication,
  signIndexPublication,
  validateIndexPublication,
  verifyIndexPublication,
} from './index-publication.js';

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const address = getSolanaAddress(publicKey);

const pathSegment = fc
  .stringMatching(/^[A-Za-z0-9._-]{1,32}$/)
  // Object.prototype members are refused: they would key state maps.
  .filter((segment) => !(segment in Object.prototype))
  .filter((s) => !s.includes('..') && s !== '.');

const sha256Hex = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((bytes) => Buffer.from(bytes).toString('hex'));

const bandFile = fc.record({
  name: pathSegment,
  size: fc.nat({ max: 2 ** 40 }),
  sha256: sha256Hex,
});

const band = fc.record(
  {
    id: pathSegment,
    files: fc
      .uniqueArray(bandFile, {
        minLength: 1,
        maxLength: 4,
        selector: (f) => f.name,
      })
      .map((files) => files),
    records: fc.option(fc.nat(), { nil: undefined }),
    http: fc.option(
      fc.record({ baseUrl: fc.stringMatching(/^\/[a-z/-]{1,24}$/) }),
      { nil: undefined },
    ),
  },
  { requiredKeys: ['id', 'files'] },
);

const indexEntry = fc.record(
  {
    name: fc
      .stringMatching(/^[a-z0-9-]{1,24}$/)
      .filter((name) => !(name in Object.prototype)),
    kind: fc.stringMatching(/^[a-z0-9-]{1,24}$/),
    bands: fc.uniqueArray(band, {
      minLength: 0,
      maxLength: 3,
      selector: (b) => b.id,
    }),
  },
  { requiredKeys: ['name', 'kind', 'bands'] },
);

const publication: fc.Arbitrary<IndexPublication> = fc
  .record({
    sequence: fc.nat({ max: 2 ** 31 }),
    indexes: fc.uniqueArray(indexEntry, {
      minLength: 0,
      maxLength: 3,
      selector: (e) => e.name,
    }),
    previousManifestSha256: fc.option(sha256Hex, { nil: null }),
    offsetMs: fc.nat({ max: 10 ** 11 }),
    ttlMs: fc.nat({ max: 10 ** 9 }),
  })
  .map(({ sequence, indexes, previousManifestSha256, offsetMs, ttlMs }) => {
    const issued = new Date(offsetMs);
    return {
      version: 1 as const,
      publisher: address,
      sequence,
      previousManifestSha256,
      issuedAt: issued.toISOString(),
      expiresAt: new Date(offsetMs + ttlMs).toISOString(),
      indexes,
    };
  });

describe('index publication property tests', () => {
  it('signs and verifies any valid publication', () => {
    fc.assert(
      fc.property(publication, (p) => {
        const signed = signIndexPublication(p, privateKey, address);
        const result = verifyIndexPublication(
          signed,
          publicKeyFromSolanaAddress(address),
        );
        assert.equal(result.ok, true);
      }),
      { numRuns: 200 },
    );
  });

  it('canonicalizes identically regardless of property order', () => {
    fc.assert(
      fc.property(publication, (p) => {
        // Round-tripping through a shuffled object must not move the bytes
        // a signature covers.
        const shuffled = JSON.parse(
          JSON.stringify(
            Object.fromEntries(
              Object.entries(p as unknown as Record<string, unknown>).reverse(),
            ),
          ),
        );
        assert.equal(
          canonicalizeIndexPublication(p),
          canonicalizeIndexPublication(shuffled),
        );
      }),
      { numRuns: 200 },
    );
  });

  it('canonicalization is idempotent through a serialize/parse cycle', () => {
    fc.assert(
      fc.property(publication, (p) => {
        const once = canonicalizeIndexPublication(p);
        const reparsed = parseIndexPublication(serializeIndexPublication(p));
        assert.equal(canonicalizeIndexPublication(reparsed), once);
      }),
      { numRuns: 200 },
    );
  });

  it('validates every publication it serializes, unchanged', () => {
    fc.assert(
      fc.property(publication, (p) => {
        const parsed = validateIndexPublication(
          JSON.parse(serializeIndexPublication(p)),
        );
        // Compare wire forms rather than the objects: fast-check builds
        // records with a null prototype, and a strict deepEqual compares
        // prototypes, so structurally identical documents would differ.
        // Canonical equality is also the claim that matters here, namely
        // that validation neither drops nor rewrites any field.
        assert.equal(
          serializeIndexPublication(parsed),
          serializeIndexPublication(p),
        );
        assert.deepEqual(parsed, JSON.parse(serializeIndexPublication(p)));
      }),
      { numRuns: 200 },
    );
  });

  it('hashes a publication and its serialization identically', () => {
    fc.assert(
      fc.property(publication, (p) => {
        assert.equal(
          manifestSha256(p),
          manifestSha256(serializeIndexPublication(p)),
        );
      }),
      { numRuns: 200 },
    );
  });

  it('rejects the signature after any single-field mutation', () => {
    fc.assert(
      fc.property(publication, fc.nat({ max: 2 ** 31 }), (p, delta) => {
        fc.pre(delta !== 0);
        const signed = signIndexPublication(p, privateKey, address);
        const tampered: IndexPublication = JSON.parse(JSON.stringify(signed));
        tampered.sequence = p.sequence + delta;
        assert.equal(verifyIndexPublication(tampered, publicKey).ok, false);
      }),
      { numRuns: 200 },
    );
  });
});
