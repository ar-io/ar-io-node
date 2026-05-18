/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import express from 'express';
import { default as request } from 'supertest';

import { headerNames } from '../../constants.js';
import { createTestLogger } from '../../../test/test-logger.js';
import { sendBodyWithOptionalDigest } from './buffered-digest.js';
import { createHttpSigMiddleware } from '../../middleware/httpsig.js';
import {
  buildSignatureBase,
  isSignableHeader,
  isTriggerHeader,
} from '../../lib/httpsig.js';
import { ContiguousData } from '../../types.js';

const log = createTestLogger({ suite: 'buffered-digest-signing' });

function generateTestKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const raw = spkiDer.subarray(12);
  const keyId = `ed25519:${raw.toString('base64url')}`;
  return { privateKey, publicKey, keyId };
}

function makeData(bytes: Buffer): ContiguousData {
  return {
    stream: Readable.from(bytes, { objectMode: false }),
    size: bytes.length,
    sourceContentType: 'application/octet-stream',
    verified: false,
    trusted: true,
    cached: false,
  } as unknown as ContiguousData;
}

function parseAsBuffer(
  res: any,
  callback: (err: Error | null, body: Buffer) => void,
) {
  res.setEncoding('binary');
  let data = '';
  res.on('data', (chunk: string) => {
    data += chunk;
  });
  res.on('end', () => callback(null, Buffer.from(data, 'binary')));
}

/**
 * Parse a Signature-Input value of the form
 *   sig1=("@status" "x" "y");created=N;keyid="…";alg="ed25519"
 * back into the components and `created` so we can rebuild the base.
 */
function parseSignatureInput(value: string): {
  components: string[];
  created: number;
  keyid: string;
} {
  // Strip "sig1="
  const eq = value.indexOf('=');
  const dictBody = value.slice(eq + 1);
  const componentsMatch = dictBody.match(/^\(([^)]*)\)/);
  if (componentsMatch === null) {
    throw new Error(`unparseable Signature-Input: ${value}`);
  }
  const components = componentsMatch[1]
    .split(/\s+/)
    .filter((s) => s.length > 0)
    .map((s) => s.replace(/"/g, ''));
  const createdMatch = dictBody.match(/created=(\d+)/);
  const keyidMatch = dictBody.match(/keyid="([^"]+)"/);
  if (createdMatch === null || keyidMatch === null) {
    throw new Error(`missing created/keyid in Signature-Input: ${value}`);
  }
  return {
    components,
    created: parseInt(createdMatch[1], 10),
    keyid: keyidMatch[1],
  };
}

describe('buffered-digest + httpsig signing integration', () => {
  it('Content-Digest from buffered-digest is signed by the middleware', async () => {
    const { privateKey, publicKey, keyId } = generateTestKeyPair();
    const body = Buffer.from(
      'integration test body — this should be hashed and bound',
    );

    const app = express();
    app.use(createHttpSigMiddleware({ privateKey, keyId, bindRequest: true }));
    app.get('/data/:id', async (req, res) => {
      // Simulate the data handler: emit a trigger header so the middleware
      // signs, then run the buffered-digest helper which sets Content-Digest.
      res.setHeader(headerNames.dataId, req.params.id);
      res.setHeader(headerNames.trusted, 'true');
      res.setHeader('Content-Type', 'application/octet-stream');
      await sendBodyWithOptionalDigest({
        req,
        res,
        data: makeData(body),
        log,
        dataId: req.params.id,
        maxBytes: 1024 * 1024,
      });
    });

    const res = await request(app)
      .get('/data/test-id-1')
      .buffer(true)
      .parse(parseAsBuffer);

    assert.equal(res.status, 200);

    // 1. Content-Digest is present and matches the body bytes.
    const expectedHashB64 = crypto
      .createHash('sha256')
      .update(body)
      .digest('base64');
    const expectedContentDigest = `sha-256=:${expectedHashB64}:`;
    assert.equal(
      res.headers[headerNames.contentDigest.toLowerCase()],
      expectedContentDigest,
      'Content-Digest header should match body hash',
    );

    // 2. Signature-Input lists content-digest as a covered component.
    const sigInput = res.headers['signature-input'] as string;
    assert.ok(sigInput !== undefined, 'Signature-Input header must exist');
    const parsed = parseSignatureInput(sigInput);
    assert.ok(
      parsed.components.includes('content-digest'),
      `content-digest must be in covered components, got: ${parsed.components.join(',')}`,
    );
    assert.equal(parsed.keyid, keyId, 'keyid must match');

    // 3. Recompute the signature base and verify the Ed25519 signature
    //    against our own public key — proving the bytes-on-the-wire are
    //    cryptographically bound by something we can independently verify.
    //
    // buildSignatureBase already prepends "@status" and (when bindRequest)
    // appends "@method";req and "@path";req — strip those from the parsed
    // components so we don't double-count.
    const headersOnly = parsed.components.filter(
      (c) => c !== '@status' && !c.startsWith('@'),
    );
    void isTriggerHeader; // referenced to keep import valid in case we expand
    void isSignableHeader;

    const { base } = buildSignatureBase(
      res.status,
      (n) => res.headers[n.toLowerCase()] as string | undefined,
      headersOnly,
      'GET',
      '/data/test-id-1',
      true, // bindRequest
      parsed.created,
      parsed.keyid,
    );

    const sigHeader = res.headers['signature'] as string;
    const sigMatch = sigHeader.match(/sig1=:([^:]+):/);
    if (sigMatch === null) {
      throw new Error(`unparseable Signature header: ${sigHeader}`);
    }
    const sigBytes = Buffer.from(sigMatch[1], 'base64');

    const ok = crypto.verify(
      null,
      Buffer.from(base, 'latin1'),
      publicKey,
      sigBytes,
    );

    assert.equal(
      ok,
      true,
      'Ed25519 verification of the recomputed base must succeed — ' +
        'this proves Content-Digest is genuinely covered by the signature',
    );

    // 4. Tampering with the body should invalidate the signature.
    // Recompute with a fake digest to confirm the test would catch a bad chain.
    const tamperedHeaders = { ...res.headers };
    tamperedHeaders[headerNames.contentDigest.toLowerCase()] =
      'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:';
    const { base: tamperedBase } = buildSignatureBase(
      res.status,
      (n) => tamperedHeaders[n.toLowerCase()] as string | undefined,
      headersOnly,
      'GET',
      '/data/test-id-1',
      true,
      parsed.created,
      parsed.keyid,
    );
    const tamperedOk = crypto.verify(
      null,
      Buffer.from(tamperedBase, 'latin1'),
      publicKey,
      sigBytes,
    );
    assert.equal(
      tamperedOk,
      false,
      'verification with tampered Content-Digest must fail',
    );
  });
});
