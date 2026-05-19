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

import {
  TRIGGER_HEADERS,
  CO_SIGNABLE_HEADERS,
  isSignableHeader,
  isTriggerHeader,
  loadOrGenerateKey,
  deriveKeyId,
  getPublicKeyBase64Url,
  buildSignatureBase,
  formatSignatureInput,
  getSolanaAddress,
  loadWalletJwk,
  createAttestation,
  loadOrCreateAttestation,
  saveAttestationTxId,
  jwkToArweaveAddress,
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

    it('matches retrieval-hint headers (legacy + aligned)', () => {
      // Legacy pair (kept for backwards compat, will be removed after
      // a deprecation window — see docs/glossary.md).
      assert.equal(isSignableHeader('x-ar-io-root-data-item-offset'), true);
      assert.equal(isSignableHeader('x-ar-io-root-data-offset'), true);
      // Aligned-name pair (matches request-side hint header names so
      // cache-and-replay clients can copy headers without renaming).
      assert.equal(isSignableHeader('x-ar-io-root-item-offset'), true);
      assert.equal(isSignableHeader('x-ar-io-root-item-size'), true);
      assert.equal(isSignableHeader('x-ar-io-root-path'), true);
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

  // --- Phase 2: Attestation tests ---

  // Load fixed RSA-4096 wallet fixtures rather than generating a fresh
  // keypair per test (~500 ms each on CI). Fixtures live in
  // test/mock_files/wallets/ and are committed; they're test-only,
  // never used for any signing on the live network.
  const loadTestWallet = (n: 1 | 2): crypto.JsonWebKey =>
    JSON.parse(
      fs.readFileSync(`test/mock_files/wallets/test-wallet-${n}.json`, 'utf8'),
    );

  /** Default RSA JWK fixture for tests that don't care which wallet they get. */
  const getTestRsaJwk = (): crypto.JsonWebKey => loadTestWallet(1);

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

  describe('loadWalletJwk', () => {
    it('loads a valid RSA JWK from file', () => {
      const dir = makeTmpDir();
      const walletFile = path.join(dir, 'test-wallet.json');
      const jwk = getTestRsaJwk();
      fs.writeFileSync(walletFile, JSON.stringify(jwk));

      const loaded = loadWalletJwk(walletFile);
      assert.equal(loaded.kty, 'RSA');
      assert.ok(loaded.n !== undefined);
      assert.ok(loaded.d !== undefined);
    });

    it('throws on missing file', () => {
      assert.throws(() => loadWalletJwk('/nonexistent/wallet.json'), {
        message: /not found/,
      });
    });

    it('throws on invalid JSON', () => {
      const dir = makeTmpDir();
      const walletFile = path.join(dir, 'bad.json');
      fs.writeFileSync(walletFile, 'not json');

      assert.throws(() => loadWalletJwk(walletFile), {
        message: /Invalid wallet JSON/,
      });
    });

    it('throws on missing required RSA fields', () => {
      const dir = makeTmpDir();
      const walletFile = path.join(dir, 'incomplete.json');
      fs.writeFileSync(walletFile, JSON.stringify({ kty: 'RSA', n: 'abc' }));

      assert.throws(() => loadWalletJwk(walletFile), {
        message: /missing required field/,
      });
    });
  });

  describe('jwkToArweaveAddress', () => {
    it('returns a base64url string', () => {
      const jwk = getTestRsaJwk();
      const addr = jwkToArweaveAddress(jwk);
      assert.match(addr, /^[A-Za-z0-9_-]+$/);
      assert.equal(addr.length, 43); // SHA-256 = 32 bytes = 43 base64url chars
    });

    it('is stable across calls', () => {
      const jwk = getTestRsaJwk();
      assert.equal(jwkToArweaveAddress(jwk), jwkToArweaveAddress(jwk));
    });
  });

  describe('createAttestation', () => {
    it('returns payload, signature, and rsaPublicKey', () => {
      const observerJwk = getTestRsaJwk();
      const { publicKey } = crypto.generateKeyPairSync('ed25519');

      const att = createAttestation({
        observerJwk,
        ed25519PublicKey: publicKey,
        gatewayAddress: 'test-gateway-address',
      });

      assert.ok(att.payload.length > 0);
      assert.ok(att.signature.length > 0);
      assert.ok(att.rsaPublicKey.length > 0);
    });

    it('payload is valid canonical JSON with expected fields', () => {
      const observerJwk = getTestRsaJwk();
      const { publicKey } = crypto.generateKeyPairSync('ed25519');

      const att = createAttestation({
        observerJwk,
        ed25519PublicKey: publicKey,
        gatewayAddress: 'gw-addr',
      });

      const parsed = JSON.parse(att.payload);
      assert.equal(parsed.type, 'ar-io-gateway-key-attestation');
      assert.equal(parsed.version, 1);
      assert.equal(parsed.purpose, 'http-response-signing');
      assert.equal(parsed.gatewayAddress, 'gw-addr');
      assert.equal(parsed.ed25519PublicKey, getPublicKeyBase64Url(publicKey));
      assert.equal(parsed.solanaAddress, getSolanaAddress(publicKey));
      assert.equal(parsed.keyId, deriveKeyId(publicKey));
      assert.ok(parsed.observerAddress !== undefined);
      assert.ok(parsed.issuedAt !== undefined);
    });

    it('signature is verifiable with the RSA public key', () => {
      const observerJwk = getTestRsaJwk();
      const { publicKey } = crypto.generateKeyPairSync('ed25519');

      const att = createAttestation({
        observerJwk,
        ed25519PublicKey: publicKey,
        gatewayAddress: undefined,
      });

      // Reconstruct RSA public key from exported DER
      const rsaPubKey = crypto.createPublicKey({
        key: Buffer.from(att.rsaPublicKey, 'base64url'),
        format: 'der',
        type: 'spki',
      });

      const valid = crypto.verify(
        'sha256',
        Buffer.from(att.payload, 'utf8'),
        {
          key: rsaPubKey,
          padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
          saltLength: 0,
        },
        Buffer.from(att.signature, 'base64url'),
      );

      assert.equal(valid, true);
    });

    it('observerAddress matches SHA-256 of RSA public key modulus', () => {
      const observerJwk = getTestRsaJwk();
      const { publicKey } = crypto.generateKeyPairSync('ed25519');

      const att = createAttestation({
        observerJwk,
        ed25519PublicKey: publicKey,
        gatewayAddress: undefined,
      });

      const parsed = JSON.parse(att.payload);
      const expectedAddress = jwkToArweaveAddress(observerJwk);
      assert.equal(parsed.observerAddress, expectedAddress);
    });
  });

  describe('loadOrCreateAttestation', () => {
    it('creates and caches a new attestation', () => {
      const dir = makeTmpDir();
      const observerJwk = getTestRsaJwk();
      const { publicKey } = crypto.generateKeyPairSync('ed25519');

      const result = loadOrCreateAttestation({
        keysDir: dir,
        observerJwk,
        ed25519PublicKey: publicKey,
        gatewayAddress: undefined,
      });

      assert.equal(result.cached, false);
      assert.ok(result.payload.length > 0);
      assert.ok(fs.existsSync(path.join(dir, 'httpsig-attestation.json')));
    });

    it('loads cached attestation when Ed25519 key unchanged', () => {
      const dir = makeTmpDir();
      const observerJwk = getTestRsaJwk();
      const { publicKey } = crypto.generateKeyPairSync('ed25519');

      const first = loadOrCreateAttestation({
        keysDir: dir,
        observerJwk,
        ed25519PublicKey: publicKey,
        gatewayAddress: undefined,
      });

      const second = loadOrCreateAttestation({
        keysDir: dir,
        observerJwk,
        ed25519PublicKey: publicKey,
        gatewayAddress: undefined,
      });

      assert.equal(first.cached, false);
      assert.equal(second.cached, true);
      assert.equal(first.signature, second.signature);
    });

    it('recreates attestation when Ed25519 key changes', () => {
      const dir = makeTmpDir();
      const observerJwk = getTestRsaJwk();
      const { publicKey: pub1 } = crypto.generateKeyPairSync('ed25519');
      const { publicKey: pub2 } = crypto.generateKeyPairSync('ed25519');

      const first = loadOrCreateAttestation({
        keysDir: dir,
        observerJwk,
        ed25519PublicKey: pub1,
        gatewayAddress: undefined,
      });

      const second = loadOrCreateAttestation({
        keysDir: dir,
        observerJwk,
        ed25519PublicKey: pub2,
        gatewayAddress: undefined,
      });

      assert.equal(first.cached, false);
      assert.equal(second.cached, false);
      assert.notEqual(first.signature, second.signature);
    });

    it('returns persisted txId from cache', () => {
      const dir = makeTmpDir();
      const observerJwk = getTestRsaJwk();
      const { publicKey } = crypto.generateKeyPairSync('ed25519');

      // Create attestation
      loadOrCreateAttestation({
        keysDir: dir,
        observerJwk,
        ed25519PublicKey: publicKey,
        gatewayAddress: undefined,
      });

      // Persist txId
      saveAttestationTxId(dir, 'arweave-tx-123');

      // Reload — should return the txId
      const result = loadOrCreateAttestation({
        keysDir: dir,
        observerJwk,
        ed25519PublicKey: publicKey,
        gatewayAddress: undefined,
      });

      assert.equal(result.cached, true);
      assert.equal(result.txId, 'arweave-tx-123');
    });

    it('recreates attestation when observer wallet changes', () => {
      const dir = makeTmpDir();
      // Distinct fixtures: this test verifies that a wallet change
      // invalidates the cached attestation, so jwk1 and jwk2 must differ.
      const observerJwk1 = loadTestWallet(1);
      const observerJwk2 = loadTestWallet(2);
      const { publicKey } = crypto.generateKeyPairSync('ed25519');

      const first = loadOrCreateAttestation({
        keysDir: dir,
        observerJwk: observerJwk1,
        ed25519PublicKey: publicKey,
        gatewayAddress: undefined,
      });

      const second = loadOrCreateAttestation({
        keysDir: dir,
        observerJwk: observerJwk2,
        ed25519PublicKey: publicKey,
        gatewayAddress: undefined,
      });

      assert.equal(first.cached, false);
      assert.equal(second.cached, false);
      assert.notEqual(first.signature, second.signature);
    });

    it('recreates attestation when gateway address changes', () => {
      const dir = makeTmpDir();
      const observerJwk = getTestRsaJwk();
      const { publicKey } = crypto.generateKeyPairSync('ed25519');

      const first = loadOrCreateAttestation({
        keysDir: dir,
        observerJwk,
        ed25519PublicKey: publicKey,
        gatewayAddress: 'gateway-1',
      });

      const second = loadOrCreateAttestation({
        keysDir: dir,
        observerJwk,
        ed25519PublicKey: publicKey,
        gatewayAddress: 'gateway-2',
      });

      assert.equal(first.cached, false);
      assert.equal(second.cached, false);
    });

    it('handles corrupt cache file gracefully', () => {
      const dir = makeTmpDir();
      const observerJwk = getTestRsaJwk();
      const { publicKey } = crypto.generateKeyPairSync('ed25519');

      // Write corrupt cache
      fs.writeFileSync(
        path.join(dir, 'httpsig-attestation.json'),
        'not valid json{{{',
      );

      // Should recreate without throwing
      const result = loadOrCreateAttestation({
        keysDir: dir,
        observerJwk,
        ed25519PublicKey: publicKey,
        gatewayAddress: undefined,
      });

      assert.equal(result.cached, false);
      assert.ok(result.payload.length > 0);
    });

    it('saveAttestationTxId is no-op when cache file missing', () => {
      const dir = makeTmpDir();
      // Should not throw
      saveAttestationTxId(dir, 'some-tx-id');
    });
  });
});
