/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import express from 'express';
import { default as request } from 'supertest';

import { createTestLogger } from '../../../test/test-logger.js';
import { RootArweaveLocationSource } from '../../data/root-arweave-location-source.js';
import { buildSignatureBase, deriveKeyId } from '../../lib/httpsig.js';
import { createHttpSigMiddleware } from '../../middleware/httpsig.js';
import {
  ContiguousDataAttributes,
  ContiguousDataSource,
  DataBlockListValidator,
  ManifestPathResolver,
  TxGeometry,
} from '../../types.js';
import { createDataHandler, createRawDataHandler } from './handlers.js';

const log = createTestLogger({ suite: 'root-arweave-headers' });

const ROOT = 'Dfi5LEHn79AoBSsdi1Oyvh8JfT1cwmu-CJ2K5C6T958';
const ITEM = 'wndEaLf1BwnhuNmpDisdl0wWLnIrsVhQnPE0W24cWM8';
const PARENT = 'LPMc8z6reldKo_KitgnV6i3RgHnFLAKnn5jDK7ar4qo';
const ROOT_END_OFFSET = 392971323892121;
const ROOT_SIZE = 3555491;
const ROOT_START = ROOT_END_OFFSET - ROOT_SIZE + 1; // 392971320336631

const START = 'x-ar-io-root-arweave-start-offset';
const SIZE = 'x-ar-io-root-arweave-data-size';

const dataSource: ContiguousDataSource = {
  getData: async () => ({
    stream: Readable.from(Buffer.from('testing...')),
    size: 10,
    verified: false,
    trusted: true,
    cached: false,
    requestAttributes: { origin: 'node-url', hops: 0, clientIps: [] },
  }),
};
const dataBlockListValidator: DataBlockListValidator = {
  isIdBlocked: async () => false,
  isHashBlocked: async () => false,
};
const manifestPathResolver: ManifestPathResolver = {
  resolveFromIndex: async (id: string) => ({
    id,
    resolvedId: id,
    complete: false,
  }),
  resolveFromData: async (id: string) => ({
    id,
    resolvedId: id,
    complete: false,
  }),
  resolveFromTrustedCache: () => undefined,
} as unknown as ManifestPathResolver;

/** Attributes for a stable item with no root or parent unless overridden. */
function attributes(
  overrides: Partial<ContiguousDataAttributes> = {},
): ContiguousDataAttributes {
  return {
    size: 10,
    contentType: 'application/octet-stream',
    isManifest: false,
    stable: true,
    verified: false,
    ...overrides,
  } as ContiguousDataAttributes;
}

/** A location source backed by `stable`: the geometry of stable transactions. */
function locations(stable: Record<string, TxGeometry>) {
  return new RootArweaveLocationSource({
    log,
    txGeometrySource: { getTxGeometry: async (id: string) => stable[id] },
  });
}

const STABLE_ROOT = {
  [ROOT]: { dataRoot: 'dr', offset: ROOT_END_OFFSET, size: ROOT_SIZE },
};

/** An app serving /raw/:id and /:id, optionally behind the HTTPSIG middleware. */
function app({
  attrs,
  locationSource,
  signer,
}: {
  attrs: ContiguousDataAttributes | undefined;
  locationSource?: RootArweaveLocationSource;
  signer?: crypto.KeyObject;
}) {
  const server = express();
  if (signer !== undefined) {
    server.use(
      createHttpSigMiddleware({
        privateKey: signer,
        keyId: deriveKeyId(crypto.createPublicKey(signer)),
        bindRequest: true,
      }),
    );
  }
  const dataAttributesSource = { getDataAttributes: async () => attrs };
  server.get(
    /^\/raw\/([a-zA-Z0-9-_]{43})\/?$/,
    createRawDataHandler({
      log,
      dataAttributesSource,
      dataSource,
      dataBlockListValidator,
      rootArweaveLocationSource: locationSource,
    }),
  );
  server.get(
    '/:id',
    createDataHandler({
      log,
      dataAttributesSource,
      dataSource,
      dataBlockListValidator,
      manifestPathResolver,
      rootArweaveLocationSource: locationSource,
    }),
  );
  return server;
}

/**
 * Rebuilds the RFC 9421 signature base from a response and verifies it with
 * `publicKey`. Returns the covered header names.
 */
function verifySignature(
  res: request.Response,
  method: string,
  path: string,
  publicKey: crypto.KeyObject,
  headerOverrides: Record<string, string> = {},
): { covered: string[]; ok: boolean } {
  const input = res.headers['signature-input'] as string | undefined;
  const signature = res.headers['signature'] as string | undefined;
  assert.ok(
    input !== undefined && signature !== undefined,
    'response is signed',
  );
  const components = (input.match(/^sig1=\(([^)]*)\)/)?.[1] ?? '')
    .split(/\s+/)
    .filter((s) => s.length > 0)
    .map((s) => s.replace(/"/g, '').replace(/;req$/, ''));
  const created = Number(input.match(/created=(\d+)/)?.[1]);
  const keyId = input.match(/keyid="([^"]+)"/)?.[1] ?? '';
  const covered = components.filter((c) => !c.startsWith('@'));
  const headers = { ...res.headers, ...headerOverrides };
  const { base } = buildSignatureBase(
    res.status,
    (n) => headers[n.toLowerCase()] as string | undefined,
    covered,
    method,
    path,
    true,
    created,
    keyId,
  );
  const sig = Buffer.from(
    signature.match(/sig1=:([^:]+):/)?.[1] ?? '',
    'base64',
  );
  return {
    covered,
    ok: crypto.verify(null, Buffer.from(base, 'latin1'), publicKey, sig),
  };
}

describe('X-AR-IO-Root-Arweave-* data response headers', () => {
  const cases: {
    name: string;
    id: string;
    attrs: ContiguousDataAttributes;
  }[] = [
    { name: 'an L1 transaction (its own root)', id: ROOT, attrs: attributes() },
    {
      name: 'a data item directly inside its root bundle',
      id: ITEM,
      attrs: attributes({ rootTransactionId: ROOT, parentId: ROOT }),
    },
    {
      name: 'a data item placed by a fetch or index (no parent)',
      id: ITEM,
      attrs: attributes({ rootTransactionId: ROOT }),
    },
  ];

  for (const { name, id, attrs } of cases) {
    for (const [route, path] of [
      ['/raw/:id', `/raw/${id}`],
      ['/:id', `/${id}`],
    ]) {
      it(`${route}: emits the root's Arweave start offset and size for ${name}, signed`, async () => {
        const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
        const res = await request(
          app({
            attrs,
            locationSource: locations(STABLE_ROOT),
            signer: privateKey,
          }),
        )
          .get(path)
          .expect(200);

        assert.equal(res.headers[START], String(ROOT_START));
        assert.equal(res.headers[SIZE], String(ROOT_SIZE));

        const { covered, ok } = verifySignature(res, 'GET', path, publicKey);
        assert.ok(covered.includes(START), `covered: ${covered.join(',')}`);
        assert.ok(covered.includes(SIZE), `covered: ${covered.join(',')}`);
        assert.equal(ok, true, 'signature verifies with the gateway key');

        // The signature binds the values: a changed offset fails verification.
        const tampered = verifySignature(res, 'GET', path, publicKey, {
          [START]: String(ROOT_START + 1),
        });
        assert.equal(tampered.ok, false, 'a tampered offset must not verify');
      });
    }
  }

  it('emits and signs them on HEAD too', async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const path = `/raw/${ITEM}`;
    const res = await request(
      app({
        attrs: attributes({ rootTransactionId: ROOT, parentId: ROOT }),
        locationSource: locations(STABLE_ROOT),
        signer: privateKey,
      }),
    )
      .head(path)
      .expect(200);

    assert.equal(res.headers[START], String(ROOT_START));
    const { covered, ok } = verifySignature(res, 'HEAD', path, publicKey);
    assert.ok(covered.includes(START) && covered.includes(SIZE));
    assert.equal(ok, true);
  });

  it('omits them for an item nested more than one level in our bundle index (#907)', async () => {
    const res = await request(
      app({
        attrs: attributes({ rootTransactionId: ROOT, parentId: PARENT }),
        locationSource: locations(STABLE_ROOT),
      }),
    )
      .get(`/raw/${ITEM}`)
      .expect(200);

    assert.equal(res.headers[START], undefined);
    assert.equal(res.headers[SIZE], undefined);
  });

  it('omits them when the root is not stable or its offset is not recorded', async () => {
    const res = await request(
      app({
        attrs: attributes({ rootTransactionId: ROOT, parentId: ROOT }),
        locationSource: locations({}),
      }),
    )
      .get(`/raw/${ITEM}`)
      .expect(200);

    assert.equal(res.headers[START], undefined);
    assert.equal(res.headers[SIZE], undefined);
    // The existing root header is unaffected.
    assert.equal(res.headers['x-ar-io-root-transaction-id'], ROOT);
  });

  it('omits them when no location source is configured', async () => {
    const res = await request(
      app({ attrs: attributes({ rootTransactionId: ROOT, parentId: ROOT }) }),
    )
      .get(`/${ITEM}`)
      .expect(200);

    assert.equal(res.headers[START], undefined);
    assert.equal(res.headers[SIZE], undefined);
  });
});
