/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import express from 'express';
import { default as request } from 'supertest';

import { createHttpSigMiddleware } from './httpsig.js';
import { buildSignatureBase, isSignableHeader } from '../lib/httpsig.js';

/** Generate a fresh Ed25519 keypair for test isolation. */
function generateTestKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const raw = spkiDer.subarray(12);
  const keyId = `ed25519:${raw.toString('base64url')}`;
  return { privateKey, publicKey, keyId };
}

describe('createHttpSigMiddleware', () => {
  it('signs response when signable headers are present', async () => {
    const { privateKey, keyId } = generateTestKeyPair();

    const app = express();
    app.use(createHttpSigMiddleware({ privateKey, keyId, bindRequest: false }));
    app.get('/test', (_req, res) => {
      res.header('X-AR-IO-Data-Id', 'abc123');
      res.header('X-AR-IO-Verified', 'true');
      res.send('ok');
    });

    const res = await request(app).get('/test');
    assert.ok(res.headers['signature'] !== undefined);
    assert.ok(res.headers['signature-input'] !== undefined);
  });

  it('Signature-Input lists correct covered components', async () => {
    const { privateKey, keyId } = generateTestKeyPair();

    const app = express();
    app.use(createHttpSigMiddleware({ privateKey, keyId, bindRequest: false }));
    app.get('/test', (_req, res) => {
      res.header('Content-Type', 'text/plain');
      res.header('X-AR-IO-Data-Id', 'abc123');
      res.send('ok');
    });

    const res = await request(app).get('/test');
    const input = res.headers['signature-input'] as string;
    assert.ok(input.includes('"@status"'));
    assert.ok(input.includes('"content-type"'));
    assert.ok(input.includes('"x-ar-io-data-id"'));
    assert.ok(input.includes(`keyid="${keyId}"`));
    assert.ok(input.includes('alg="ed25519"'));
  });

  it('skips signing when no signable headers are present', async () => {
    const { privateKey, keyId } = generateTestKeyPair();

    const app = express();
    app.use(createHttpSigMiddleware({ privateKey, keyId, bindRequest: false }));
    app.get('/test', (_req, res) => {
      // Send raw bytes without setting any AR.IO/ArNS/chunk headers.
      // Express sets content-type automatically via res.json/res.send, and
      // content-type IS signable, so use writeHead + end directly.
      res.writeHead(200);
      res.end();
    });

    const res = await request(app).get('/test');
    assert.equal(res.headers['signature'], undefined);
    assert.equal(res.headers['signature-input'], undefined);
  });

  it('strips upstream Signature/Signature-Input before re-signing', async () => {
    const { privateKey, keyId } = generateTestKeyPair();

    const app = express();
    app.use(createHttpSigMiddleware({ privateKey, keyId, bindRequest: false }));
    app.get('/test', (_req, res) => {
      // Simulate upstream gateway headers that should be stripped
      res.header('Signature', 'sig1=:upstreamsig:');
      res.header('Signature-Input', 'sig1=("@status");keyid="upstream"');
      res.header('X-AR-IO-Data-Id', 'abc123');
      res.send('ok');
    });

    const res = await request(app).get('/test');
    const input = res.headers['signature-input'] as string;
    // Should have our keyId, not the upstream one
    assert.ok(input.includes(`keyid="${keyId}"`));
    assert.ok(!input.includes('upstream'));
  });

  it('signs x-arweave-tag-* headers via prefix match', async () => {
    const { privateKey, keyId } = generateTestKeyPair();

    const app = express();
    app.use(createHttpSigMiddleware({ privateKey, keyId, bindRequest: false }));
    app.get('/test', (_req, res) => {
      res.header('X-AR-IO-Data-Id', 'abc123');
      res.header('X-Arweave-Tag-Content-Type', 'image/png');
      res.header('X-Arweave-Tag-App-Name', 'ArDrive');
      res.send('ok');
    });

    const res = await request(app).get('/test');
    const input = res.headers['signature-input'] as string;
    assert.ok(input.includes('"x-arweave-tag-content-type"'));
    assert.ok(input.includes('"x-arweave-tag-app-name"'));
  });

  it('signs x-arweave-tags-truncated header', async () => {
    const { privateKey, keyId } = generateTestKeyPair();

    const app = express();
    app.use(createHttpSigMiddleware({ privateKey, keyId, bindRequest: false }));
    app.get('/test', (_req, res) => {
      res.header('X-AR-IO-Data-Id', 'abc123');
      res.header('X-Arweave-Tags-Truncated', 'true');
      res.send('ok');
    });

    const res = await request(app).get('/test');
    const input = res.headers['signature-input'] as string;
    assert.ok(input.includes('"x-arweave-tags-truncated"'));
  });

  it('includes @method;req and @path;req when bindRequest is true', async () => {
    const { privateKey, keyId } = generateTestKeyPair();

    const app = express();
    app.use(createHttpSigMiddleware({ privateKey, keyId, bindRequest: true }));
    app.get('/raw/:id', (_req, res) => {
      res.header('X-AR-IO-Data-Id', 'abc123');
      res.send('ok');
    });

    const res = await request(app).get('/raw/abc123');
    const input = res.headers['signature-input'] as string;
    assert.ok(input.includes('"@method";req'));
    assert.ok(input.includes('"@path";req'));
  });

  it('omits request-bound components when bindRequest is false', async () => {
    const { privateKey, keyId } = generateTestKeyPair();

    const app = express();
    app.use(createHttpSigMiddleware({ privateKey, keyId, bindRequest: false }));
    app.get('/test', (_req, res) => {
      res.header('X-AR-IO-Data-Id', 'abc123');
      res.send('ok');
    });

    const res = await request(app).get('/test');
    const input = res.headers['signature-input'] as string;
    assert.ok(!input.includes('@method'));
    assert.ok(!input.includes('@path'));
  });

  it('produces a valid Ed25519 signature that can be verified', async () => {
    const { privateKey, publicKey, keyId } = generateTestKeyPair();

    const app = express();
    app.use(createHttpSigMiddleware({ privateKey, keyId, bindRequest: true }));
    app.get('/raw/:id', (_req, res) => {
      res.header('X-AR-IO-Data-Id', 'testid');
      res.header('X-AR-IO-Verified', 'true');
      res.send('data');
    });

    const res = await request(app).get('/raw/testid');
    const sigHeader = res.headers['signature'] as string;
    const inputHeader = res.headers['signature-input'] as string;

    // Extract signature bytes from "sig1=:base64:"
    const sigMatch = sigHeader.match(/^sig1=:(.+):$/);
    assert.ok(sigMatch !== null);
    const sigBytes = Buffer.from(sigMatch[1], 'base64');

    // Parse the created timestamp from input header
    const createdMatch = inputHeader.match(/created=(\d+)/);
    assert.ok(createdMatch !== null);
    const created = parseInt(createdMatch[1], 10);

    // Reconstruct covered headers from the response
    const allHeaders = Object.keys(res.headers);
    const coveredHeaders = allHeaders.filter(
      (h) =>
        isSignableHeader(h) && h !== 'signature' && h !== 'signature-input',
    );

    // Rebuild the signature base
    const signatureBase = buildSignatureBase(
      res.status,
      (name) => res.headers[name.toLowerCase()] as string,
      coveredHeaders,
      'GET',
      '/raw/testid',
      true,
      created,
      keyId,
    );

    // Verify the signature
    const valid = crypto.verify(
      null,
      Buffer.from(signatureBase, 'ascii'),
      publicKey,
      sigBytes,
    );

    assert.equal(valid, true);
  });

  it('does not sign when middleware is not registered', async () => {
    const app = express();
    app.get('/test', (_req, res) => {
      res.header('X-AR-IO-Data-Id', 'abc123');
      res.send('ok');
    });

    const res = await request(app).get('/test');
    assert.equal(res.headers['signature'], undefined);
    assert.equal(res.headers['signature-input'], undefined);
  });
});
