/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { afterEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import bs58 from 'bs58';

import {
  TRIGGER_HEADERS,
  CO_SIGNABLE_HEADERS,
  isSignableHeader,
  isTriggerHeader,
  loadOrGenerateKey,
  loadSolanaKeypair,
  loadSolanaKeypairFromBase58,
  deriveKeyId,
  getPublicKeyBase64Url,
  buildSignatureBase,
  formatSignatureInput,
  getSolanaAddress,
  initHttpSig,
} from './httpsig.js';

describe('httpsig lib', () => {
  // Temp directory for key file tests
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir !== undefined) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function makeTmpDir(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'httpsig-test-'));
    return tmpDir;
  }

  describe('isSignableHeader', () => {
    it('matches trigger headers', () => {
      assert.equal(isSignableHeader('x-ar-io-data-id'), true);
      assert.equal(isSignableHeader('x-ar-io-verified'), true);
      assert.equal(isSignableHeader('x-arns-name'), true);
      assert.equal(isSignableHeader('x-arweave-chunk-data-root'), true);
    });

    it('matches co-signable headers', () => {
      assert.equal(isSignableHeader('content-type'), true);
      assert.equal(isSignableHeader('content-digest'), true);
    });

    it('matches x-arweave-tag-* prefix', () => {
      assert.equal(isSignableHeader('x-arweave-tag-content-type'), true);
      assert.equal(isSignableHeader('x-arweave-tag-app-name'), true);
      assert.equal(isSignableHeader('x-arweave-tag-'), true);
    });

    it('rejects non-signable headers', () => {
      assert.equal(isSignableHeader('cache-control'), false);
      assert.equal(isSignableHeader('x-request-id'), false);
      assert.equal(isSignableHeader('x-ar-io-hops'), false);
      assert.equal(isSignableHeader('x-ar-io-via'), false);
    });

    it('is case-insensitive', () => {
      assert.equal(isSignableHeader('X-AR-IO-Data-Id'), true);
      assert.equal(isSignableHeader('X-Arweave-Tag-App-Name'), true);
    });

    it('has consistent sets', () => {
      assert.ok(TRIGGER_HEADERS.size > 0);
      assert.ok(CO_SIGNABLE_HEADERS.size > 0);
    });
  });

  describe('isTriggerHeader', () => {
    it('returns true for trust-relevant headers', () => {
      assert.equal(isTriggerHeader('x-ar-io-data-id'), true);
      assert.equal(isTriggerHeader('x-arns-name'), true);
      assert.equal(isTriggerHeader('x-arweave-chunk-data-root'), true);
    });

    it('returns false for content-type (not a trigger, only co-signable)', () => {
      assert.equal(isTriggerHeader('content-type'), false);
      assert.equal(isTriggerHeader('content-digest'), false);
    });

    it('returns false for operational headers', () => {
      assert.equal(isTriggerHeader('cache-control'), false);
      assert.equal(isTriggerHeader('x-request-id'), false);
    });

    it('returns false for tag headers (co-signable via prefix, not trigger)', () => {
      assert.equal(isTriggerHeader('x-arweave-tag-content-type'), false);
    });

    it('is case-insensitive', () => {
      assert.equal(isTriggerHeader('X-AR-IO-Data-Id'), true);
    });
  });

  describe('loadOrGenerateKey', () => {
    it('generates a new Ed25519 key when file does not exist', () => {
      const dir = makeTmpDir();
      const keyFile = path.join(dir, 'subdir', 'test.pem');

      const key = loadOrGenerateKey(keyFile);

      assert.equal(key.type, 'private');
      assert.equal(key.asymmetricKeyType, 'ed25519');
      assert.ok(fs.existsSync(keyFile));
    });

    it('loads an existing key from PEM file', () => {
      const dir = makeTmpDir();
      const keyFile = path.join(dir, 'test.pem');

      // Generate and save
      const key1 = loadOrGenerateKey(keyFile);
      const pub1 = crypto.createPublicKey(key1);
      const id1 = deriveKeyId(pub1);

      // Load existing
      const key2 = loadOrGenerateKey(keyFile);
      const pub2 = crypto.createPublicKey(key2);
      const id2 = deriveKeyId(pub2);

      assert.equal(id1, id2);
    });

    it('creates parent directories recursively', () => {
      const dir = makeTmpDir();
      const keyFile = path.join(dir, 'a', 'b', 'c', 'test.pem');

      loadOrGenerateKey(keyFile);

      assert.ok(fs.existsSync(keyFile));
    });
  });

  describe('loadSolanaKeypair', () => {
    /** Write a Solana-format keypair file (64-byte JSON array). */
    function writeSolanaKeypair(dir: string): {
      filePath: string;
      publicKey: Buffer;
    } {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
      const seed = privateKey
        .export({ type: 'pkcs8', format: 'der' })
        .subarray(16); // 16-byte PKCS8 prefix
      const rawPub = publicKey
        .export({ type: 'spki', format: 'der' })
        .subarray(12); // 12-byte SPKI prefix
      const bytes = Buffer.concat([seed, rawPub]);
      const filePath = path.join(dir, 'keypair.json');
      fs.writeFileSync(filePath, JSON.stringify(Array.from(bytes)));
      return { filePath, publicKey: rawPub };
    }

    it('loads a valid Solana keypair and returns Ed25519 private key', () => {
      const dir = makeTmpDir();
      const { filePath } = writeSolanaKeypair(dir);

      const key = loadSolanaKeypair(filePath);

      assert.equal(key.type, 'private');
      assert.equal(key.asymmetricKeyType, 'ed25519');
    });

    it('produces the correct public key', () => {
      const dir = makeTmpDir();
      const { filePath, publicKey: expectedPub } = writeSolanaKeypair(dir);

      const key = loadSolanaKeypair(filePath);
      const pub = crypto.createPublicKey(key);
      const actualPub = getPublicKeyBase64Url(pub);
      const expectedB64 = expectedPub.toString('base64url');

      assert.equal(actualPub, expectedB64);
    });

    it('can sign and verify', () => {
      const dir = makeTmpDir();
      const { filePath } = writeSolanaKeypair(dir);

      const privateKey = loadSolanaKeypair(filePath);
      const publicKey = crypto.createPublicKey(privateKey);
      const data = Buffer.from('test message');

      const sig = crypto.sign(null, data, privateKey);
      const valid = crypto.verify(null, data, publicKey, sig);
      assert.equal(valid, true);
    });

    it('throws on missing file', () => {
      assert.throws(() => loadSolanaKeypair('/nonexistent/keypair.json'), {
        message: /not found/,
      });
    });

    it('throws on invalid JSON', () => {
      const dir = makeTmpDir();
      const filePath = path.join(dir, 'bad.json');
      fs.writeFileSync(filePath, 'not json');

      assert.throws(() => loadSolanaKeypair(filePath), {
        message: /Invalid Solana keypair JSON/,
      });
    });

    it('throws on wrong byte length', () => {
      const dir = makeTmpDir();
      const filePath = path.join(dir, 'short.json');
      fs.writeFileSync(filePath, JSON.stringify([1, 2, 3]));

      assert.throws(() => loadSolanaKeypair(filePath), {
        message: /expected 64 bytes/,
      });
    });
  });

  describe('deriveKeyId', () => {
    it('produces a self-contained ed25519:<base64url> key ID', () => {
      const { publicKey } = crypto.generateKeyPairSync('ed25519');

      const id = deriveKeyId(publicKey);

      assert.ok(id.startsWith('ed25519:'));
      // "ed25519:" (8 chars) + 43-char base64url = 51 chars
      assert.equal(id.length, 51);
      assert.match(id, /^ed25519:[A-Za-z0-9_-]{43}$/);
    });

    it('is stable across calls', () => {
      const { publicKey } = crypto.generateKeyPairSync('ed25519');

      assert.equal(deriveKeyId(publicKey), deriveKeyId(publicKey));
    });

    it('produces different IDs for different keys', () => {
      const { publicKey: pub1 } = crypto.generateKeyPairSync('ed25519');
      const { publicKey: pub2 } = crypto.generateKeyPairSync('ed25519');

      assert.notEqual(deriveKeyId(pub1), deriveKeyId(pub2));
    });

    it('contains the same key as getPublicKeyBase64Url', () => {
      const { publicKey } = crypto.generateKeyPairSync('ed25519');

      const keyId = deriveKeyId(publicKey);
      const pubB64 = getPublicKeyBase64Url(publicKey);

      assert.equal(keyId, `ed25519:${pubB64}`);
    });
  });

  describe('getPublicKeyBase64Url', () => {
    it('returns a 43-char base64url string for 32-byte key', () => {
      const { publicKey } = crypto.generateKeyPairSync('ed25519');

      const b64 = getPublicKeyBase64Url(publicKey);

      assert.equal(b64.length, 43);
      assert.match(b64, /^[A-Za-z0-9_-]+$/);
    });
  });

  describe('getSolanaAddress', () => {
    it('returns a base58 string', () => {
      const { publicKey } = crypto.generateKeyPairSync('ed25519');
      const addr = getSolanaAddress(publicKey);

      // Solana addresses are 32-44 chars base58
      assert.ok(addr.length >= 32 && addr.length <= 44);
      assert.match(addr, /^[1-9A-HJ-NP-Za-km-z]+$/);
    });

    it('is stable across calls', () => {
      const { publicKey } = crypto.generateKeyPairSync('ed25519');
      assert.equal(getSolanaAddress(publicKey), getSolanaAddress(publicKey));
    });
  });

  describe('formatSignatureInput', () => {
    it('produces correct structured field syntax', () => {
      const result = formatSignatureInput(
        ['content-type', 'x-ar-io-data-id'],
        1712505600,
        'testkey1',
        false,
      );

      assert.equal(
        result,
        '("@status" "content-type" "x-ar-io-data-id");created=1712505600;keyid="testkey1";alg="ed25519"',
      );
    });

    it('includes request-bound components when bindRequest is true', () => {
      const result = formatSignatureInput([], 1000, 'k1', true);

      assert.ok(result.includes('"@method";req'));
      assert.ok(result.includes('"@path";req'));
    });

    it('omits request-bound components when bindRequest is false', () => {
      const result = formatSignatureInput([], 1000, 'k1', false);

      assert.ok(!result.includes('@method'));
      assert.ok(!result.includes('@path'));
    });
  });

  describe('buildSignatureBase', () => {
    it('produces correct RFC 9421 signature base format', () => {
      const headers: Record<string, string> = {
        'content-type': 'application/octet-stream',
        'x-ar-io-data-id': 'abc123',
      };

      const { base } = buildSignatureBase(
        200,
        (name) => headers[name],
        ['content-type', 'x-ar-io-data-id'],
        'GET',
        '/raw/abc123',
        false,
        1712505600,
        'testkey1',
      );

      const lines = base.split('\n');
      assert.equal(lines[0], '"@status": 200');
      assert.equal(lines[1], '"content-type": application/octet-stream');
      assert.equal(lines[2], '"x-ar-io-data-id": abc123');
      assert.ok(lines[3].startsWith('"@signature-params":'));
    });

    it('includes request-bound components when bindRequest is true', () => {
      const { base } = buildSignatureBase(
        200,
        () => 'value',
        ['content-type'],
        'GET',
        '/raw/abc123',
        true,
        1000,
        'k1',
      );

      assert.ok(base.includes('"@method";req: GET'));
      assert.ok(base.includes('"@path";req: /raw/abc123'));
    });

    it('omits request-bound components when bindRequest is false', () => {
      const { base } = buildSignatureBase(
        200,
        () => 'value',
        ['content-type'],
        'GET',
        '/raw/abc123',
        false,
        1000,
        'k1',
      );

      assert.ok(!base.includes('@method'));
      assert.ok(!base.includes('@path'));
    });

    it('only includes provided covered headers', () => {
      const headers: Record<string, string> = {
        'x-ar-io-data-id': 'abc',
      };

      const { base } = buildSignatureBase(
        200,
        (name) => headers[name],
        ['x-ar-io-data-id'],
        'GET',
        '/',
        false,
        1000,
        'k1',
      );

      const lines = base.split('\n');
      // @status + one header + @signature-params = 3 lines
      assert.equal(lines.length, 3);
    });

    it('serializes multi-value (array) headers with comma separation', () => {
      const headers: Record<string, string | string[]> = {
        'x-arweave-tag-content-type': ['image/png', 'text/html'],
        'x-ar-io-data-id': 'abc',
      };

      const { base } = buildSignatureBase(
        200,
        (name) => headers[name],
        ['x-arweave-tag-content-type', 'x-ar-io-data-id'],
        'GET',
        '/',
        false,
        1000,
        'k1',
      );

      assert.ok(
        base.includes('"x-arweave-tag-content-type": image/png, text/html'),
      );
    });

    it('has no trailing newline', () => {
      const { base } = buildSignatureBase(
        200,
        () => 'v',
        ['content-type'],
        'GET',
        '/',
        false,
        1000,
        'k1',
      );

      assert.ok(!base.endsWith('\n'));
    });

    it('returns paramStr matching formatSignatureInput output', () => {
      const { paramStr } = buildSignatureBase(
        200,
        () => 'v',
        ['content-type'],
        'GET',
        '/',
        false,
        1712505600,
        'k1',
      );

      assert.equal(
        paramStr,
        formatSignatureInput(['content-type'], 1712505600, 'k1', false),
      );
    });

    it('canonicalizes covered header names to lowercase', () => {
      const headers: Record<string, string> = {
        'content-type': 'application/octet-stream',
        'x-ar-io-data-id': 'abc123',
      };

      const { base, paramStr } = buildSignatureBase(
        200,
        (name) => headers[name.toLowerCase()],
        ['Content-Type', 'X-AR-IO-Data-Id'],
        'GET',
        '/raw/abc123',
        false,
        1712505600,
        'testkey1',
      );

      assert.ok(base.includes('"content-type": application/octet-stream'));
      assert.ok(base.includes('"x-ar-io-data-id": abc123'));
      assert.ok(paramStr.includes('"content-type"'));
      assert.ok(paramStr.includes('"x-ar-io-data-id"'));
    });

    it('produces a signable base that can be verified end-to-end', () => {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
      const keyId = deriveKeyId(publicKey);

      const headers: Record<string, string> = {
        'content-type': 'text/plain',
        'x-ar-io-verified': 'true',
      };

      const { base } = buildSignatureBase(
        200,
        (name) => headers[name],
        ['content-type', 'x-ar-io-verified'],
        'GET',
        '/test',
        true,
        1712505600,
        keyId,
      );

      const sig = crypto.sign(null, Buffer.from(base, 'latin1'), privateKey);
      const valid = crypto.verify(
        null,
        Buffer.from(base, 'latin1'),
        publicKey,
        sig,
      );

      assert.equal(valid, true);
    });
  });

  describe('initHttpSig', () => {
    const noopLog = {
      info: () => {},
      warn: () => {},
    };

    it('falls back to auto-generated PEM when no keypair path', () => {
      const dir = makeTmpDir();
      const keyFile = path.join(dir, 'httpsig.pem');

      const signer = initHttpSig({
        keyFile,
        observerKeypairPath: undefined,
        observerPrivateKey: undefined,
        log: noopLog,
      });

      assert.ok(signer.keyId.startsWith('ed25519:'));
      assert.ok(signer.solanaAddress.length >= 32);
      assert.ok(fs.existsSync(keyFile));
    });

    it('propagates errors when keyFile path is unwritable', () => {
      // dirname(keyFile) points at a regular file, so mkdirSync fails with
      // ENOTDIR. This mirrors the EACCES failure from a root-owned data/keys/
      // dir — both surface as a throw out of loadOrGenerateKey, which is what
      // config.ts's `initializeHttpSig` catches.
      const dir = makeTmpDir();
      const blockingFile = path.join(dir, 'not-a-dir');
      fs.writeFileSync(blockingFile, 'blocking');

      assert.throws(() =>
        initHttpSig({
          keyFile: path.join(blockingFile, 'httpsig.pem'),
          observerKeypairPath: undefined,
          observerPrivateKey: undefined,
          log: noopLog,
        }),
      );
    });

    it('uses Solana keypair when path is provided', () => {
      const dir = makeTmpDir();

      // Generate a Solana keypair file
      const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
      const seed = privateKey
        .export({ type: 'pkcs8', format: 'der' })
        .subarray(16);
      const rawPub = publicKey
        .export({ type: 'spki', format: 'der' })
        .subarray(12);
      const keypairPath = path.join(dir, 'observer.json');
      fs.writeFileSync(
        keypairPath,
        JSON.stringify(Array.from(Buffer.concat([seed, rawPub]))),
      );

      const signer = initHttpSig({
        keyFile: path.join(dir, 'httpsig.pem'),
        observerKeypairPath: keypairPath,
        observerPrivateKey: undefined,
        log: noopLog,
      });

      // Should use the Solana keypair, not generate a PEM
      assert.ok(!fs.existsSync(path.join(dir, 'httpsig.pem')));
      assert.equal(signer.publicKeyB64Url, getPublicKeyBase64Url(publicKey));
    });

    it('uses OBSERVER_PRIVATE_KEY (base58) and skips file I/O', () => {
      // No keypair file on disk; key flows in via the env-string path.
      const dir = makeTmpDir();
      const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
      const seed = privateKey
        .export({ type: 'pkcs8', format: 'der' })
        .subarray(16);
      const rawPub = publicKey
        .export({ type: 'spki', format: 'der' })
        .subarray(12);
      const base58Secret = bs58.encode(Buffer.concat([seed, rawPub]));

      const signer = initHttpSig({
        keyFile: path.join(dir, 'httpsig.pem'),
        observerKeypairPath: undefined,
        observerPrivateKey: base58Secret,
        log: noopLog,
      });

      // Same identity as the path-based loader for the same bytes.
      assert.equal(signer.publicKeyB64Url, getPublicKeyBase64Url(publicKey));
      // No PEM auto-generated.
      assert.ok(!fs.existsSync(path.join(dir, 'httpsig.pem')));
    });

    it('rejects setting both OBSERVER_KEYPAIR_PATH and OBSERVER_PRIVATE_KEY', () => {
      const dir = makeTmpDir();
      const { privateKey } = crypto.generateKeyPairSync('ed25519');
      const seed = privateKey
        .export({ type: 'pkcs8', format: 'der' })
        .subarray(16);
      // We don't need a real keypair file on disk — the ambiguity check
      // throws before any loader runs.
      const fakePath = path.join(dir, 'observer.json');
      fs.writeFileSync(fakePath, '[]');

      assert.throws(
        () =>
          initHttpSig({
            keyFile: path.join(dir, 'httpsig.pem'),
            observerKeypairPath: fakePath,
            observerPrivateKey: bs58.encode(
              Buffer.concat([seed, Buffer.alloc(32)]),
            ),
            log: noopLog,
          }),
        {
          message:
            /Set exactly one of OBSERVER_KEYPAIR_PATH or OBSERVER_PRIVATE_KEY/,
        },
      );
    });

    it('treats empty-string envs as unset (falls through to PEM auto-gen)', () => {
      // Some env loaders surface unset values as '' rather than undefined.
      const dir = makeTmpDir();
      const keyFile = path.join(dir, 'httpsig.pem');

      const signer = initHttpSig({
        keyFile,
        observerKeypairPath: '',
        observerPrivateKey: '',
        log: noopLog,
      });

      assert.ok(signer.keyId.startsWith('ed25519:'));
      assert.ok(fs.existsSync(keyFile));
    });
  });

  describe('loadSolanaKeypairFromBase58', () => {
    /** Build a valid 64-byte base58 secret-key payload for tests. */
    function freshBase58Secret(): { base58: string; pub: Buffer } {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
      const seed = privateKey
        .export({ type: 'pkcs8', format: 'der' })
        .subarray(16);
      const pub = publicKey
        .export({ type: 'spki', format: 'der' })
        .subarray(12);
      return { base58: bs58.encode(Buffer.concat([seed, pub])), pub };
    }

    it('decodes a valid 64-byte base58 secret into the matching public key', () => {
      const { base58, pub } = freshBase58Secret();

      const key = loadSolanaKeypairFromBase58(base58, 'OBSERVER_PRIVATE_KEY');

      assert.equal(key.type, 'private');
      assert.equal(key.asymmetricKeyType, 'ed25519');
      const derivedPub = crypto.createPublicKey(key);
      assert.equal(
        getPublicKeyBase64Url(derivedPub),
        pub.toString('base64url'),
      );
    });

    it('throws on a 32-byte (secret-only) payload with the env name in the message', () => {
      const secretOnly = bs58.encode(Buffer.alloc(32));
      assert.throws(
        () => loadSolanaKeypairFromBase58(secretOnly, 'OBSERVER_PRIVATE_KEY'),
        {
          message: /OBSERVER_PRIVATE_KEY.*decoded 32 bytes.*expected 64/,
        },
      );
    });

    it('throws on non-base58 input with a friendly error', () => {
      // `0` is not a base58 character — bs58.decode rejects it.
      assert.throws(
        () =>
          loadSolanaKeypairFromBase58(
            '0xdeadbeefdeadbeef',
            'OBSERVER_PRIVATE_KEY',
          ),
        {
          message: /OBSERVER_PRIVATE_KEY.*not a valid base58/,
        },
      );
    });
  });
});
