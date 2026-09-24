/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it, before, after } from 'node:test';
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  getSolanaAddress,
  isSolanaAddress,
  loadSolanaKeypair,
  publicKeyFromSolanaAddress,
} from './httpsig.js';
import {
  INDEX_PUBLICATION_MAX_BYTES,
  IndexPublication,
  IndexPublicationValidationError,
  canonicalizeIndexPublication,
  manifestSha256,
  parseIndexPublication,
  serializeIndexPublication,
  signIndexPublication,
  validateIndexPublication,
  verifyIndexPublication,
  parseIndexPublicationDocument,
} from './index-publication.js';

/**
 * Build a Solana keypair file: 64 bytes, the 32-byte Ed25519 seed followed by
 * the 32-byte public key, as a JSON array. This is the shape
 * `loadSolanaKeypair` reads and what Solana tooling writes.
 */
function solanaKeypairBytes(): {
  bytes: number[];
  publicKey: crypto.KeyObject;
  privateKey: crypto.KeyObject;
} {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const seed = (
    privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer
  ).subarray(16);
  const raw = (
    publicKey.export({ type: 'spki', format: 'der' }) as Buffer
  ).subarray(12);
  return {
    bytes: [...seed, ...raw],
    publicKey,
    privateKey,
  };
}

function samplePublication(
  overrides: Partial<IndexPublication> = {},
): IndexPublication {
  return {
    version: 1,
    publisher: 'ErEgD7dq1yR9W1CnVG3pEywi3qST7jqWA9nfWtxSGeBc',
    sequence: 412,
    previousManifestSha256: null,
    issuedAt: '2026-09-22T12:00:00Z',
    expiresAt: '2026-09-23T12:00:00Z',
    indexes: [
      {
        name: 'root-tx-index',
        kind: 'cdb64-root-tx',
        bands: [
          {
            id: 'tip-20260922T1200Z',
            heightRange: [1950000, null],
            records: 13636177,
            files: [
              {
                name: '00.cdb',
                size: 7012345,
                sha256: 'a'.repeat(64),
              },
            ],
            http: { baseUrl: '/ar-io/indexes/root-tx-index/tip/' },
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('index publication', () => {
  let tempDir: string;
  let keypairPath: string;
  let publicKey: crypto.KeyObject;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'index-pub-test-'));
    keypairPath = path.join(tempDir, 'keypair.json');
    const keypair = solanaKeypairBytes();
    publicKey = keypair.publicKey;
    await fs.writeFile(keypairPath, JSON.stringify(keypair.bytes));
  });

  after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('sign and verify', () => {
    it('verifies a document signed with the matching registered key', () => {
      const privateKey = loadSolanaKeypair(keypairPath);
      const address = getSolanaAddress(publicKey);

      const signed = signIndexPublication(
        samplePublication(),
        privateKey,
        address,
      );

      assert.equal(signed.signature?.alg, 'ed25519');
      assert.equal(signed.signature?.keyId, address);

      // The verifier starts from the address alone, as a subscriber does
      // after reading the publisher's gateway record.
      const verifyingKey = publicKeyFromSolanaAddress(address);
      assert.deepEqual(verifyIndexPublication(signed, verifyingKey), {
        ok: true,
      });
    });

    it('rejects a document whose content changed after signing', () => {
      const privateKey = loadSolanaKeypair(keypairPath);
      const signed = signIndexPublication(
        samplePublication(),
        privateKey,
        getSolanaAddress(publicKey),
      );

      const tampered: IndexPublication = JSON.parse(JSON.stringify(signed));
      tampered.indexes[0].bands[0].files[0].sha256 = 'b'.repeat(64);

      const result = verifyIndexPublication(tampered, publicKey);
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.reason, 'signature mismatch');
    });

    it('rejects a document signed by a different key', () => {
      const privateKey = loadSolanaKeypair(keypairPath);
      const signed = signIndexPublication(
        samplePublication(),
        privateKey,
        getSolanaAddress(publicKey),
      );

      const other = solanaKeypairBytes();
      const result = verifyIndexPublication(signed, other.publicKey);
      assert.equal(result.ok, false);
    });

    it('reports an unsigned document rather than throwing', () => {
      const result = verifyIndexPublication(samplePublication(), publicKey);
      assert.equal(result.ok, false);
      assert.equal(
        result.ok === false && result.reason,
        'document is not signed',
      );
    });

    it('rejects a signature of the wrong length', () => {
      const signed = samplePublication({
        signature: {
          alg: 'ed25519',
          keyId: getSolanaAddress(publicKey),
          sig: Buffer.alloc(32).toString('base64'),
        },
      });
      const result = verifyIndexPublication(signed, publicKey);
      assert.equal(result.ok, false);
      assert.match(
        result.ok === false ? result.reason : '',
        /32 bytes, expected 64/,
      );
    });

    it('reports a document too deeply nested to canonicalize', () => {
      const signed = signIndexPublication(
        samplePublication(),
        loadSolanaKeypair(keypairPath),
        getSolanaAddress(publicKey),
      );
      // Unknown members are kept for the signature, and JSON.parse accepts
      // nesting far deeper than a recursive canonicalizer can walk: 200 KB
      // of brackets, well inside the document size limit.
      const depth = 100_000;
      const hostile = {
        ...signed,
        extra: JSON.parse('['.repeat(depth) + ']'.repeat(depth)),
      } as IndexPublication;

      const result = verifyIndexPublication(hostile, publicKey);
      assert.equal(result.ok, false);
      assert.match(
        result.ok === false ? result.reason : '',
        /canonicalization failed/,
      );
    });

    it('replacing an existing signature does not nest or stack them', () => {
      const privateKey = loadSolanaKeypair(keypairPath);
      const once = signIndexPublication(
        samplePublication(),
        privateKey,
        getSolanaAddress(publicKey),
      );
      const twice = signIndexPublication(
        once,
        privateKey,
        getSolanaAddress(publicKey),
      );

      assert.equal(once.signature?.sig, twice.signature?.sig);
      assert.equal(verifyIndexPublication(twice, publicKey).ok, true);
    });
  });

  describe('canonicalization', () => {
    it('is independent of property order', () => {
      const a = samplePublication();
      const reordered = JSON.parse(
        JSON.stringify({
          indexes: a.indexes,
          expiresAt: a.expiresAt,
          issuedAt: a.issuedAt,
          previousManifestSha256: a.previousManifestSha256,
          sequence: a.sequence,
          publisher: a.publisher,
          version: a.version,
        }),
      );

      assert.equal(
        canonicalizeIndexPublication(a),
        canonicalizeIndexPublication(reordered),
      );
    });

    it('ignores the signature field', () => {
      const unsigned = samplePublication();
      const signed = samplePublication({
        signature: {
          alg: 'ed25519',
          keyId: getSolanaAddress(publicKey),
          sig: Buffer.alloc(64).toString('base64'),
        },
      });

      assert.equal(
        canonicalizeIndexPublication(unsigned),
        canonicalizeIndexPublication(signed),
      );
    });

    it('treats an explicitly undefined field as absent', () => {
      const withUndefined = samplePublication();
      withUndefined.indexes[0].bands[0].torrent = undefined;

      assert.equal(
        canonicalizeIndexPublication(withUndefined),
        canonicalizeIndexPublication(samplePublication()),
      );
    });

    it('covers fields a later version added, so v1 can verify a v2 document', () => {
      // A reader built against version 1 must sign and verify over the whole
      // document, not a reconstruction of the fields it knows, or a publisher
      // that adds a field produces signatures nobody can check.
      const privateKey = loadSolanaKeypair(keypairPath);
      const future = {
        ...samplePublication(),
        unknownFutureField: { added: 'in a later version' },
      } as unknown as IndexPublication;

      const signed = signIndexPublication(
        future,
        privateKey,
        getSolanaAddress(publicKey),
      );
      assert.equal(verifyIndexPublication(signed, publicKey).ok, true);

      // Dropping the unknown field must invalidate the signature.
      const stripped: any = JSON.parse(JSON.stringify(signed));
      delete stripped.unknownFutureField;
      assert.equal(verifyIndexPublication(stripped, publicKey).ok, false);
    });

    it('verifies a parsed document that carries fields this version does not know', () => {
      // The path a subscriber takes: bytes off the wire, parsed, verified.
      // Unknown members at every level, as a later publisher might add them
      // (a per-file Merkle root, say).
      const privateKey = loadSolanaKeypair(keypairPath);
      const future: any = JSON.parse(JSON.stringify(samplePublication()));
      future.addedLater = { at: 'top' };
      future.indexes[0].addedLater = 'index';
      future.indexes[0].bands[0].addedLater = ['band'];
      future.indexes[0].bands[0].files[0].merkle = {
        'arweave-data-root': 'x'.repeat(43),
      };
      const wire = serializeIndexPublication(
        signIndexPublication(future, privateKey, getSolanaAddress(publicKey)),
      );

      const { publication, signed } = parseIndexPublicationDocument(wire);
      assert.equal(verifyIndexPublication(signed, publicKey).ok, true);
      // The validated view keeps only known fields, which is exactly why it
      // must not be what gets verified.
      assert.equal((publication as any).addedLater, undefined);
      assert.equal(verifyIndexPublication(publication, publicKey).ok, false);
    });
  });

  describe('manifest hashing', () => {
    it('hashes a publication and its serialization identically', () => {
      const publication = samplePublication();
      assert.equal(
        manifestSha256(publication),
        manifestSha256(serializeIndexPublication(publication)),
      );
    });

    it('produces a chainable digest that changes with content', () => {
      const first = samplePublication({ sequence: 1 });
      const second = samplePublication({
        sequence: 2,
        previousManifestSha256: manifestSha256(first),
      });

      assert.match(manifestSha256(first), /^[0-9a-f]{64}$/);
      assert.notEqual(manifestSha256(first), manifestSha256(second));
      assert.equal(second.previousManifestSha256, manifestSha256(first));
    });
  });

  describe('validation', () => {
    it('accepts a well-formed document and round-trips it', () => {
      const publication = samplePublication();
      const parsed = parseIndexPublication(
        serializeIndexPublication(publication),
      );
      assert.deepEqual(parsed, publication);
    });

    it('accepts a document with no indexes', () => {
      const parsed = validateIndexPublication(
        JSON.parse(JSON.stringify(samplePublication({ indexes: [] }))),
      );
      assert.deepEqual(parsed.indexes, []);
    });

    it('rejects an oversized document before parsing it', () => {
      // Deliberately not valid JSON: if the size check ran after the parse,
      // this would fail with a JSON error instead of the size error.
      const oversized = Buffer.alloc(INDEX_PUBLICATION_MAX_BYTES + 1, 0x7b);
      assert.throws(
        () => parseIndexPublication(oversized),
        (error: IndexPublicationValidationError) =>
          error instanceof IndexPublicationValidationError &&
          /over the \d+ byte limit/.test(error.message),
      );
    });

    it('reports the JSON path of the offending field', () => {
      const bad = JSON.parse(JSON.stringify(samplePublication()));
      bad.indexes[0].bands[0].files[0].sha256 = 'not-a-digest';

      assert.throws(
        () => validateIndexPublication(bad),
        (error: IndexPublicationValidationError) =>
          error instanceof IndexPublicationValidationError &&
          error.path === 'indexes[0].bands[0].files[0].sha256',
      );
    });

    const rejections: Array<[string, (doc: any) => void, string]> = [
      ['a wrong version', (d) => (d.version = 2), 'version'],
      [
        'a publisher that is not an address',
        (d) => (d.publisher = 'not-base58!'),
        'publisher',
      ],
      ['a negative sequence', (d) => (d.sequence = -1), 'sequence'],
      ['an unparseable issuedAt', (d) => (d.issuedAt = 'whenever'), 'issuedAt'],
      [
        'an expiry before issuance',
        (d) => (d.expiresAt = '2026-09-21T12:00:00Z'),
        'expiresAt',
      ],
      [
        'a file name containing a path traversal',
        (d) => (d.indexes[0].bands[0].files[0].name = '..'),
        'indexes[0].bands[0].files[0].name',
      ],
      [
        'a file name containing a separator',
        (d) => (d.indexes[0].bands[0].files[0].name = 'a/b.cdb'),
        'indexes[0].bands[0].files[0].name',
      ],
      [
        'a band id containing a traversal',
        (d) => (d.indexes[0].bands[0].id = 'a..b'),
        'indexes[0].bands[0].id',
      ],
      [
        'a band with no files',
        (d) => (d.indexes[0].bands[0].files = []),
        'indexes[0].bands[0].files',
      ],
      [
        'a duplicate file name within a band',
        (d) =>
          d.indexes[0].bands[0].files.push({
            ...d.indexes[0].bands[0].files[0],
          }),
        'indexes[0].bands[0].files[1].name',
      ],
      [
        'a duplicate band id within an index',
        (d) => d.indexes[0].bands.push({ ...d.indexes[0].bands[0] }),
        'indexes[0].bands[1].id',
      ],
      [
        'a duplicate index name',
        (d) => d.indexes.push({ ...d.indexes[0] }),
        'indexes[1].name',
      ],
      [
        'an uppercase index name',
        (d) => (d.indexes[0].name = 'Root-TX-Index'),
        'indexes[0].name',
      ],
      [
        'a negative file size',
        (d) => (d.indexes[0].bands[0].files[0].size = -1),
        'indexes[0].bands[0].files[0].size',
      ],
      [
        'an uppercase sha256',
        (d) => (d.indexes[0].bands[0].files[0].sha256 = 'A'.repeat(64)),
        'indexes[0].bands[0].files[0].sha256',
      ],
      [
        'a height range that ends before it starts',
        (d) => (d.indexes[0].bands[0].heightRange = [100, 50]),
        'indexes[0].bands[0].heightRange[1]',
      ],
      [
        'a malformed previous manifest digest',
        (d) => (d.previousManifestSha256 = 'short'),
        'previousManifestSha256',
      ],
      [
        'a signature with an unknown algorithm',
        (d) => (d.signature = { alg: 'rsa', keyId: 'x', sig: 'y' }),
        'signature.alg',
      ],
    ];

    for (const [description, mutate, expectedPath] of rejections) {
      it(`rejects ${description}`, () => {
        const doc = JSON.parse(JSON.stringify(samplePublication()));
        mutate(doc);
        assert.throws(
          () => validateIndexPublication(doc),
          (error: IndexPublicationValidationError) => {
            assert.ok(
              error instanceof IndexPublicationValidationError,
              `expected a validation error, got ${error}`,
            );
            assert.equal(error.path, expectedPath);
            return true;
          },
        );
      });
    }

    it('ignores unknown fields for forward compatibility', () => {
      const doc = JSON.parse(JSON.stringify(samplePublication()));
      doc.futureField = 'ignored';
      doc.indexes[0].bands[0].futureBandField = 'also ignored';

      const parsed = validateIndexPublication(doc);
      assert.equal(parsed.indexes[0].bands[0].id, 'tip-20260922T1200Z');
    });

    it('accepts an optional torrent block and rejects a bad infohash', () => {
      const doc = JSON.parse(JSON.stringify(samplePublication()));
      doc.indexes[0].bands[0].torrent = {
        infohashV1: 'c'.repeat(40),
        magnet: 'magnet:?xt=urn:btih:' + 'c'.repeat(40),
        torrentUrl: '/ar-io/indexes/root-tx-index/tip.torrent',
      };
      assert.equal(
        validateIndexPublication(doc).indexes[0].bands[0].torrent?.infohashV1,
        'c'.repeat(40),
      );

      doc.indexes[0].bands[0].torrent.infohashV1 = 'c'.repeat(64);
      assert.throws(
        () => validateIndexPublication(doc),
        (error: IndexPublicationValidationError) =>
          error.path === 'indexes[0].bands[0].torrent.infohashV1',
      );
    });
  });

  describe('isSolanaAddress', () => {
    it('accepts a real address and rejects near misses', () => {
      assert.equal(
        isSolanaAddress('ErEgD7dq1yR9W1CnVG3pEywi3qST7jqWA9nfWtxSGeBc'),
        true,
      );
      assert.equal(isSolanaAddress(''), false);
      assert.equal(isSolanaAddress('0Ol'), false);
      assert.equal(isSolanaAddress(42), false);
      // Valid base58, wrong length.
      assert.equal(isSolanaAddress('abc'), false);
    });
  });
});
