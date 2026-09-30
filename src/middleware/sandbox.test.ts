/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import express from 'express';
import { base32 } from 'rfc4648';
import { default as request } from 'supertest';

import type { DataBlockListValidator } from '../types.js';

// config.ts reads this once at load, and the sandbox middleware is a no-op
// without it. Each test file runs in its own process, so this cannot leak.
process.env.ARNS_ROOT_HOST = 'example.com';
const { createSandboxMiddleware, idFromSandbox } = await import('./sandbox.js');
const { toB64Url } = await import('../lib/encoding.js');

const ID_BYTES = Buffer.from(
  Array.from({ length: 32 }, (_, i) => (i * 37 + 11) % 256),
);
const ID = toB64Url(ID_BYTES);
const SANDBOX = base32.stringify(ID_BYTES, { pad: false }).toLowerCase();

const validator = (
  isIdBlocked: (id: string | undefined) => Promise<boolean>,
): DataBlockListValidator => ({
  isIdBlocked,
  isHashBlocked: async () => false,
});

const createApp = (dataBlockListValidator: DataBlockListValidator) => {
  const app = express();
  app.use(createSandboxMiddleware({ dataBlockListValidator }));
  // Stand-in for everything mounted after the sandbox middleware, including
  // rootRouter's `GET /` -> /ar-io/info.
  app.all('*', (_req, res) => {
    res.status(200).send('downstream');
  });
  return app;
};

const notBlocked = validator(async () => false);

describe('idFromSandbox', () => {
  it('decodes a canonical sandbox label to its ID', () => {
    assert.equal(SANDBOX.length, 52);
    assert.equal(idFromSandbox(SANDBOX), ID);
  });

  it('rejects labels that are not 52 base32 characters', () => {
    assert.equal(idFromSandbox(SANDBOX.slice(0, 51)), undefined);
    assert.equal(idFromSandbox(`${SANDBOX}a`), undefined);
    assert.equal(idFromSandbox(`${SANDBOX.slice(0, 51)}1`), undefined);
    assert.equal(idFromSandbox(`${SANDBOX.slice(0, 51)}_`), undefined);
    assert.equal(idFromSandbox('www'), undefined);
  });

  it('rejects a non-canonical label (non-zero trailing bits)', () => {
    // 52 chars carry 260 bits for 256, so the last character must encode a
    // multiple of 16: only 'a' or 'q'.
    const last = SANDBOX[51];
    assert.ok(last === 'a' || last === 'q');
    const nonCanonical = `${SANDBOX.slice(0, 51)}${last === 'a' ? 'b' : 'r'}`;
    assert.equal(idFromSandbox(nonCanonical), undefined);
  });
});

describe('createSandboxMiddleware', () => {
  describe('bare sandbox root', () => {
    it('answers 404 when the encoded ID is not blocked', async () => {
      const res = await request(createApp(notBlocked))
        .get('/')
        .set('Host', `${SANDBOX}.example.com`);
      assert.equal(res.status, 404);
      assert.equal(res.text, 'Not found');
      assert.match(res.headers['cache-control'], /must-revalidate/);
    });

    it('answers 451 with a short TTL when the encoded ID is blocked', async () => {
      let checked: string | undefined;
      const app = createApp(
        validator(async (id) => {
          checked = id;
          return true;
        }),
      );
      const res = await request(app)
        .get('/')
        .set('Host', `${SANDBOX}.example.com`);
      assert.equal(checked, ID);
      assert.equal(res.status, 451);
      assert.match(res.text, new RegExp(`Blocked ID: ${ID}$`));
      assert.match(res.headers['cache-control'], /must-revalidate/);
      assert.doesNotMatch(res.headers['cache-control'], /immutable/);
    });

    it('treats HEAD like GET', async () => {
      const res = await request(createApp(notBlocked))
        .head('/')
        .set('Host', `${SANDBOX}.example.com`);
      assert.equal(res.status, 404);
    });

    it('answers 404 when the block list check fails', async () => {
      const app = createApp(
        validator(async () => {
          throw new Error('moderation db unavailable');
        }),
      );
      const res = await request(app)
        .get('/')
        .set('Host', `${SANDBOX}.example.com`);
      assert.equal(res.status, 404);
    });
  });

  describe('unchanged behavior', () => {
    const passesThrough = async (host: string, path = '/', method = 'get') => {
      const res = await (request(createApp(notBlocked)) as any)
        [method](path)
        .set('Host', host);
      assert.equal(res.status, 200, `${method} ${host}${path}`);
      assert.equal(res.text, 'downstream');
    };

    it('passes other paths on a sandbox host through', async () => {
      await passesThrough(`${SANDBOX}.example.com`, '/graphql');
      await passesThrough(`${SANDBOX}.example.com`, '/ar-io/info');
    });

    it('passes non-GET requests to the bare sandbox root through', async () => {
      await passesThrough(`${SANDBOX}.example.com`, '/', 'post');
    });

    it('passes the apex and non-sandbox subdomains through', async () => {
      await passesThrough('example.com');
      await passesThrough('www.example.com');
      await passesThrough(`${SANDBOX.slice(0, 51)}.example.com`);
      await passesThrough('undername_name.example.com');
    });

    it('passes hosts outside the ArNS root through', async () => {
      await passesThrough(`${SANDBOX}.other.test`);
    });

    it('still serves /<id> on its own sandbox', async () => {
      await passesThrough(`${SANDBOX}.example.com`, `/${ID}`);
    });

    it('still redirects /<id> from the apex to its sandbox', async () => {
      const res = await request(createApp(notBlocked))
        .get(`/${ID}`)
        .set('Host', 'example.com');
      assert.equal(res.status, 302);
      assert.equal(
        res.headers.location,
        `https://${SANDBOX}.example.com/${ID}?`,
      );
    });
  });
});
