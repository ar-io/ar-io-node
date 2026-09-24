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

  it('skips signing when no trigger headers are present', async () => {
    const { privateKey, keyId } = generateTestKeyPair();

    const app = express();
    app.use(createHttpSigMiddleware({ privateKey, keyId, bindRequest: false }));
    app.get('/test', (_req, res) => {
      // No AR.IO/ArNS/chunk headers set. Express auto-sets content-type,
      // but content-type alone is not a trigger.
      res.json({ status: 'ok' });
    });

    const res = await request(app).get('/test');
    assert.equal(res.headers['signature'], undefined);
    assert.equal(res.headers['signature-input'], undefined);
  });

  it('skips signing when only content-type is present (e.g., /ar-io/info)', async () => {
    const { privateKey, keyId } = generateTestKeyPair();

    const app = express();
    app.use(createHttpSigMiddleware({ privateKey, keyId, bindRequest: false }));
    app.get('/info', (_req, res) => {
      // Simulates /ar-io/info: JSON response with Content-Type but no
      // trust-relevant AR.IO headers.
      res.setHeader('Content-Type', 'application/json');
      res.send('{"release":"test"}');
    });

    const res = await request(app).get('/info');
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

  it('strips upstream Signature/Signature-Input even when not signing', async () => {
    const { privateKey, keyId } = generateTestKeyPair();

    const app = express();
    app.use(createHttpSigMiddleware({ privateKey, keyId, bindRequest: false }));
    app.get('/info', (_req, res) => {
      // Simulate an upstream gateway's signature headers on a response that
      // has no trust-trigger header. Our middleware must still strip them so
      // they don't leak to the client as if signed by us.
      res.header('Signature', 'sig1=:upstreamsig:');
      res.header('Signature-Input', 'sig1=("@status");keyid="upstream"');
      res.setHeader('Content-Type', 'application/json');
      res.send('{"ok":true}');
    });

    const res = await request(app).get('/info');
    assert.equal(res.headers['signature'], undefined);
    assert.equal(res.headers['signature-input'], undefined);
  });

  it('covers every X-ArNS-* header on an ArNS response', async () => {
    const { privateKey, keyId } = generateTestKeyPair();

    const app = express();
    app.use(createHttpSigMiddleware({ privateKey, keyId, bindRequest: false }));
    app.get('/test', (_req, res) => {
      // Exactly what the ArNS middleware sets on a resolved name.
      res.header('X-ArNS-Name', 'docs_ardrive');
      res.header('X-ArNS-Basename', 'ardrive');
      res.header('X-ArNS-Record', 'docs');
      res.header('X-ArNS-Resolved-Id', 'a'.repeat(43));
      res.header('X-ArNS-TTL-Seconds', '900');
      res.header('X-ArNS-Ant-Id', 'b'.repeat(43));
      res.header('X-ArNS-Ant-Program-Id', 'c'.repeat(43));
      res.header('X-ArNS-Resolved-At', '1790208021000');
      res.header('X-ArNS-Undername-Limit', '10');
      res.header('X-ArNS-Record-Index', '3');
      res.send('ok');
    });

    const res = await request(app).get('/test');
    const input = res.headers['signature-input'] as string;
    for (const header of [
      'x-arns-name',
      'x-arns-basename',
      'x-arns-record',
      'x-arns-resolved-id',
      'x-arns-ttl-seconds',
      'x-arns-ant-id',
      'x-arns-ant-program-id',
      'x-arns-resolved-at',
      'x-arns-undername-limit',
      'x-arns-record-index',
    ]) {
      assert.ok(input.includes(`"${header}"`), `${header} is signed`);
    }
  });

  // Rebuilds the signature base from the response as a client would, and
  // checks it, optionally after changing one header.
  const verifies = (
    res: request.Response,
    publicKey: crypto.KeyObject,
    keyId: string,
    path: string,
    tamper?: { header: string; value: string },
  ): boolean => {
    const sig = /^sig1=:(.+):$/.exec(res.headers['signature'] as string);
    const created = /created=(\d+)/.exec(
      res.headers['signature-input'] as string,
    );
    assert.ok(sig !== null && created !== null, 'the response is signed');
    const covered = Object.keys(res.headers).filter(
      (h) =>
        isSignableHeader(h) && h !== 'signature' && h !== 'signature-input',
    );
    const { base } = buildSignatureBase(
      res.status,
      (name) =>
        tamper !== undefined && name === tamper.header
          ? tamper.value
          : (res.headers[name] as string),
      covered,
      'GET',
      path,
      true,
      parseInt(created[1], 10),
      keyId,
    );
    return crypto.verify(
      null,
      Buffer.from(base, 'latin1'),
      publicKey,
      Buffer.from(sig[1], 'base64'),
    );
  };

  // What the ArNS middleware sets on a resolved undername.
  const arnsHeaders: Record<string, string> = {
    'X-ArNS-Name': 'docs_ardrive',
    'X-ArNS-Basename': 'ardrive',
    'X-ArNS-Record': 'docs',
    'X-ArNS-Resolved-Id': 'a'.repeat(43),
    'X-ArNS-TTL-Seconds': '900',
    'X-ArNS-Ant-Id': 'b'.repeat(43),
    'X-ArNS-Ant-Program-Id': 'c'.repeat(43),
    'X-ArNS-Resolved-At': '1790208021000',
    'X-ArNS-Undername-Limit': '10',
    'X-ArNS-Record-Index': '3',
  };

  for (const status of [200, 402]) {
    it(`binds every X-ArNS-* header into a signature that verifies (${status})`, async () => {
      // 402 is the undername-limit shape: headers set, then payment required.
      const { privateKey, publicKey, keyId } = generateTestKeyPair();
      const app = express();
      app.use(
        createHttpSigMiddleware({ privateKey, keyId, bindRequest: true }),
      );
      app.get('/test', (_req, res) => {
        for (const [k, v] of Object.entries(arnsHeaders)) res.header(k, v);
        res.status(status).send('ok');
      });

      const res = await request(app).get('/test');
      assert.equal(res.status, status);
      assert.equal(verifies(res, publicKey, keyId, '/test'), true);
      // Changing any one of them, as an intermediary rewriting the resolved
      // record or its limit would, must break the signature.
      for (const name of Object.keys(arnsHeaders).map((h) => h.toLowerCase())) {
        assert.equal(
          verifies(res, publicKey, keyId, '/test', {
            header: name,
            value: '9',
          }),
          false,
          `${name} is bound`,
        );
      }
    });
  }

  it('does not sign a response carrying only the ArNS co-signable headers', async () => {
    const { privateKey, keyId } = generateTestKeyPair();

    const app = express();
    app.use(createHttpSigMiddleware({ privateKey, keyId, bindRequest: false }));
    app.get('/test', (_req, res) => {
      // Co-signable, not triggers: alone they must not start a signature.
      res.header('X-ArNS-Undername-Limit', '10');
      res.header('X-ArNS-Record-Index', '3');
      res.send('ok');
    });

    const res = await request(app).get('/test');
    assert.equal(res.headers['signature'], undefined);
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
    const { base } = buildSignatureBase(
      res.status,
      (name) => res.headers[name] as string,
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
      Buffer.from(base, 'latin1'),
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

  it('falls through unsigned when signing fails (invalid key)', async () => {
    // Pass a public key (not private) to trigger a signing error
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const { keyId } = generateTestKeyPair();

    const app = express();
    app.use(
      createHttpSigMiddleware({
        privateKey: publicKey as any,
        keyId,
        bindRequest: false,
      }),
    );
    app.get('/test', (_req, res) => {
      res.header('X-AR-IO-Data-Id', 'abc123');
      res.send('ok');
    });

    // Should still return 200 — signing error caught, response sent unsigned
    const res = await request(app).get('/test');
    assert.equal(res.status, 200);
    assert.equal(res.headers['signature'], undefined);
    assert.equal(res.headers['signature-input'], undefined);
  });
});
