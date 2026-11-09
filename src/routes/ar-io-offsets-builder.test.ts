/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import express from 'express';
import request from 'supertest';

import {
  buildRootTxOffsets,
  resolveRootTxOffsets,
  sendRootTxOffsets,
} from './ar-io-offsets-builder.js';
import { createHttpSigMiddleware } from '../middleware/httpsig.js';
import { buildSignatureBase, deriveKeyId } from '../lib/httpsig.js';
import { formatContentDigest } from '../lib/digest.js';
import { ContiguousDataAttributes, RootTxLookupResult } from '../types.js';

const ROOT_TX_ID = 'MOXw-sA3FeiSRCfXlohVkwKKoUioYYIFmSawV3UzgSg';
const PARENT_ID = 'LPMc8z6reldKo_KitgnV6i3RgHnFLAKnn5jDK7ar4qo';

function attributes(
  overrides: Partial<ContiguousDataAttributes> = {},
): ContiguousDataAttributes {
  return {
    size: 17,
    offset: 0,
    verified: false,
    rootTransactionId: ROOT_TX_ID,
    rootDataItemOffset: 19512,
    rootDataOffset: 20788,
    itemSize: 1293,
    contentType: 'application/json',
    ...overrides,
  } as ContiguousDataAttributes;
}

describe('buildRootTxOffsets', () => {
  it('projects indexed attributes into the offsets response', () => {
    const result = buildRootTxOffsets(attributes({ parentId: PARENT_ID }));

    assert.deepEqual(result, {
      rootTxId: ROOT_TX_ID,
      path: undefined,
      rootOffset: 19512,
      rootDataOffset: 20788,
      contentType: 'application/json',
      size: 1293,
      dataSize: 17,
    });
  });

  it('returns undefined when the ID is unknown to this node', () => {
    assert.equal(buildRootTxOffsets(undefined), undefined);
  });

  it('returns undefined when no root transaction is indexed', () => {
    assert.equal(
      buildRootTxOffsets(attributes({ rootTransactionId: undefined })),
      undefined,
    );
  });

  it('derives a traversal path when the parent is the root bundle', () => {
    const result = buildRootTxOffsets(attributes({ parentId: ROOT_TX_ID }));

    assert.deepEqual(result?.path, [ROOT_TX_ID]);
  });

  it('omits the path for multi-level nesting it cannot walk', () => {
    const result = buildRootTxOffsets(attributes({ parentId: PARENT_ID }));

    assert.equal(result?.path, undefined);
  });

  it('omits the path when no parent is recorded', () => {
    const result = buildRootTxOffsets(attributes({ parentId: undefined }));

    assert.equal(result?.path, undefined);
  });

  // The whole point of the endpoint: an item that has been unbundled and
  // indexed resolves even when none of its bytes are cached locally, so no
  // field here may depend on cache-side state.
  it('resolves offsets without any cached data present', () => {
    const result = buildRootTxOffsets(
      attributes({ hash: undefined, parentId: PARENT_ID }),
    );

    assert.equal(result?.rootTxId, ROOT_TX_ID);
    assert.equal(result?.rootOffset, 19512);
    assert.equal(result?.rootDataOffset, 20788);
  });

  it('passes through partial offsets rather than dropping the result', () => {
    const result = buildRootTxOffsets(
      attributes({ rootDataItemOffset: undefined, rootDataOffset: undefined }),
    );

    assert.equal(result?.rootTxId, ROOT_TX_ID);
    assert.equal(result?.rootOffset, undefined);
    assert.equal(result?.rootDataOffset, undefined);
  });
});

describe('resolveRootTxOffsets', () => {
  const OTHER_ROOT_ID = 'Lz3uy5iGnJd8kC8y2oYhmo0eW-yH8D1VYt0Iw6yqdq4';
  const fromCdb64: RootTxLookupResult = {
    rootTxId: ROOT_TX_ID,
    path: [ROOT_TX_ID, PARENT_ID],
    rootOffset: 500,
    rootDataOffset: 600,
    size: 900,
  };
  const lookup = (result: RootTxLookupResult | undefined) => {
    const calls: number[] = [];
    return {
      calls,
      lookupLocalCdb64: async () => {
        calls.push(1);
        return result;
      },
    };
  };

  it('answers from the local index without asking CDB64 when it has offsets', async () => {
    const { calls, lookupLocalCdb64 } = lookup(fromCdb64);
    const result = await resolveRootTxOffsets({
      attributes: attributes({ parentId: PARENT_ID }),
      lookupLocalCdb64,
    });

    assert.equal(result?.source, 'db');
    assert.deepEqual(
      result?.offsets,
      buildRootTxOffsets(attributes({ parentId: PARENT_ID })),
    );
    assert.equal(calls.length, 0);
  });

  it('answers from CDB64 when the local index cannot place the item', async () => {
    const result = await resolveRootTxOffsets({
      attributes: undefined,
      lookupLocalCdb64: lookup(fromCdb64).lookupLocalCdb64,
    });

    assert.equal(result?.source, 'cdb64');
    assert.deepEqual(result?.offsets, fromCdb64);
  });

  it('never passes on dataSize or contentType from a CDB64 answer', async () => {
    const result = await resolveRootTxOffsets({
      attributes: undefined,
      lookupLocalCdb64: lookup({
        ...fromCdb64,
        dataSize: 400,
        contentType: 'text/html',
      }).lookupLocalCdb64,
    });

    assert.equal(result?.source, 'cdb64');
    assert.equal(result?.offsets.dataSize, undefined);
    assert.equal(result?.offsets.contentType, undefined);
  });

  it('returns a root-only CDB64 answer when the local index has nothing', async () => {
    const result = await resolveRootTxOffsets({
      attributes: undefined,
      lookupLocalCdb64: lookup({ rootTxId: ROOT_TX_ID }).lookupLocalCdb64,
    });

    assert.equal(result?.source, 'cdb64');
    assert.equal(result?.offsets.rootTxId, ROOT_TX_ID);
    assert.equal(result?.offsets.rootOffset, undefined);
  });

  it('replaces an offset-less local answer with CDB64 offsets for the same root', async () => {
    const result = await resolveRootTxOffsets({
      attributes: attributes({
        rootDataItemOffset: undefined,
        rootDataOffset: undefined,
      }),
      lookupLocalCdb64: lookup(fromCdb64).lookupLocalCdb64,
    });

    assert.equal(result?.source, 'cdb64');
    assert.equal(result?.offsets.rootOffset, 500);
    assert.equal(result?.offsets.dataSize, undefined);
  });

  it('keeps the local answer when CDB64 names a different root', async () => {
    const local = attributes({
      rootDataItemOffset: undefined,
      rootDataOffset: undefined,
    });
    const result = await resolveRootTxOffsets({
      attributes: local,
      lookupLocalCdb64: lookup({ ...fromCdb64, rootTxId: OTHER_ROOT_ID })
        .lookupLocalCdb64,
    });

    assert.equal(result?.source, 'db');
    assert.deepEqual(result?.offsets, buildRootTxOffsets(local));
  });

  it('keeps the local answer when CDB64 adds no offsets', async () => {
    const local = attributes({
      rootDataItemOffset: undefined,
      rootDataOffset: undefined,
    });
    const result = await resolveRootTxOffsets({
      attributes: local,
      lookupLocalCdb64: lookup({ rootTxId: ROOT_TX_ID }).lookupLocalCdb64,
    });

    assert.equal(result?.source, 'db');
  });

  it('is undefined when neither can place the item', async () => {
    assert.equal(
      await resolveRootTxOffsets({
        attributes: undefined,
        lookupLocalCdb64: lookup(undefined).lookupLocalCdb64,
      }),
      undefined,
    );
  });

  it('treats a CDB64 lookup that throws as a miss', async () => {
    const local = attributes({
      rootDataItemOffset: undefined,
      rootDataOffset: undefined,
    });
    const failing = async () => {
      throw new Error('disk error');
    };

    assert.equal(
      await resolveRootTxOffsets({
        attributes: undefined,
        lookupLocalCdb64: failing,
      }),
      undefined,
    );
    assert.equal(
      (
        await resolveRootTxOffsets({
          attributes: local,
          lookupLocalCdb64: failing,
        })
      )?.source,
      'db',
    );
  });
});

describe('sendRootTxOffsets', () => {
  const offsets = {
    rootTxId: ROOT_TX_ID,
    rootOffset: 500,
    rootDataOffset: 600,
    size: 900,
  };

  const app = (signed: boolean) => {
    const server = express();
    if (signed) {
      const { privateKey } = crypto.generateKeyPairSync('ed25519');
      server.use(
        createHttpSigMiddleware({
          privateKey,
          keyId: deriveKeyId(crypto.createPublicKey(privateKey)),
          bindRequest: false,
        }),
      );
    }
    server.get('/offsets', (_req, res) => sendRootTxOffsets(res, offsets, 30));
    return server;
  };

  it('sends the offsets with a Content-Digest of the exact body', async () => {
    const res = await request(app(false)).get('/offsets').expect(200);

    assert.deepEqual(res.body, offsets);
    assert.equal(res.headers['cache-control'], 'public, max-age=30');
    assert.equal(res.headers['x-ar-io-root-transaction-id'], ROOT_TX_ID);
    assert.equal(
      res.headers['content-digest'],
      formatContentDigest(
        crypto.createHash('sha256').update(res.text).digest('base64url'),
      ),
    );
  });

  it('is signed by the HTTPSIG middleware, covering the digest', async () => {
    const res = await request(app(true)).get('/offsets').expect(200);
    const covered = res.headers['signature-input'] ?? '';

    assert.ok(res.headers.signature !== undefined, 'the answer is signed');
    assert.match(covered, /"x-ar-io-root-transaction-id"/);
    assert.match(covered, /"content-digest"/);
  });
});

describe('resolveRootTxOffsets with absolute Arweave offsets', () => {
  const ITEM_ID = 'wndEaLf1BwnhuNmpDisdl0wWLnIrsVhQnPE0W24cWM8';
  const ROOT_START = 392971320336631;
  const ROOT_SIZE = 3555491;
  /** A location lookup that knows `ids` as stable roots, recording calls. */
  const stableRoots = (ids: string[]) => {
    const calls: string[] = [];
    return {
      calls,
      getRootArweaveLocation: async (txId: string) => {
        calls.push(txId);
        return ids.includes(txId)
          ? { startOffset: ROOT_START, dataSize: ROOT_SIZE }
          : undefined;
      },
    };
  };
  /** A local CDB64 lookup with no answer. */
  const noCdb64 = async () => undefined;

  it('adds the root location and the derived item/payload starts for a data item', async () => {
    const result = await resolveRootTxOffsets({
      id: ITEM_ID,
      attributes: attributes({ parentId: ROOT_TX_ID }),
      lookupLocalCdb64: noCdb64,
      ...stableRoots([ROOT_TX_ID]),
    });

    assert.equal(result?.source, 'db');
    assert.equal(result?.offsets.rootTxId, ROOT_TX_ID);
    assert.equal(result?.offsets.rootOffset, 19512);
    assert.equal(result?.offsets.rootArweaveStartOffset, ROOT_START);
    assert.equal(result?.offsets.rootArweaveDataSize, ROOT_SIZE);
    assert.equal(result?.offsets.itemArweaveStartOffset, ROOT_START + 19512);
    assert.equal(result?.offsets.dataArweaveStartOffset, ROOT_START + 20788);
  });

  it('adds nothing for an item nested more than one level in our index (#907)', async () => {
    const roots = stableRoots([ROOT_TX_ID]);
    const result = await resolveRootTxOffsets({
      id: ITEM_ID,
      attributes: attributes({ parentId: PARENT_ID }),
      lookupLocalCdb64: noCdb64,
      ...roots,
    });

    assert.equal(result?.offsets.rootOffset, 19512, 'relative answer kept');
    assert.equal(result?.offsets.rootArweaveStartOffset, undefined);
    assert.equal(result?.offsets.itemArweaveStartOffset, undefined);
    assert.deepEqual(roots.calls, [], 'no location lookup');
  });

  it('adds nothing when the root is not stable with a recorded offset', async () => {
    const result = await resolveRootTxOffsets({
      id: ITEM_ID,
      attributes: attributes({ parentId: ROOT_TX_ID }),
      lookupLocalCdb64: noCdb64,
      ...stableRoots([]),
    });

    assert.equal(result?.source, 'db');
    assert.equal(result?.offsets.rootArweaveStartOffset, undefined);
    assert.equal(result?.offsets.dataArweaveStartOffset, undefined);
  });

  it('adds the root location to a CDB64 answer', async () => {
    const result = await resolveRootTxOffsets({
      id: ITEM_ID,
      attributes: undefined,
      lookupLocalCdb64: async () => ({
        rootTxId: ROOT_TX_ID,
        rootOffset: 500,
        rootDataOffset: 600,
      }),
      ...stableRoots([ROOT_TX_ID]),
    });

    assert.equal(result?.source, 'cdb64');
    assert.equal(result?.offsets.itemArweaveStartOffset, ROOT_START + 500);
    assert.equal(result?.offsets.dataArweaveStartOffset, ROOT_START + 600);
  });

  it('answers a stable L1 transaction as its own root, without item offsets', async () => {
    const result = await resolveRootTxOffsets({
      id: ROOT_TX_ID,
      attributes: attributes({
        rootTransactionId: undefined,
        rootDataItemOffset: undefined,
        rootDataOffset: undefined,
        itemSize: undefined,
        size: ROOT_SIZE,
        contentType: 'application/octet-stream',
      }),
      lookupLocalCdb64: noCdb64,
      ...stableRoots([ROOT_TX_ID]),
    });

    assert.equal(result?.source, 'l1');
    assert.deepEqual(result?.offsets, {
      rootTxId: ROOT_TX_ID,
      contentType: 'application/octet-stream',
      dataSize: ROOT_SIZE,
      rootArweaveStartOffset: ROOT_START,
      rootArweaveDataSize: ROOT_SIZE,
      itemArweaveStartOffset: ROOT_START,
      dataArweaveStartOffset: ROOT_START,
    });
  });

  it('declines an L1 transaction that is not stable with a recorded offset', async () => {
    const result = await resolveRootTxOffsets({
      id: ROOT_TX_ID,
      attributes: attributes({ rootTransactionId: undefined }),
      lookupLocalCdb64: noCdb64,
      ...stableRoots([]),
    });

    assert.equal(result, undefined);
  });

  it('does not take an ID with a parent but no root for an L1 transaction', async () => {
    const roots = stableRoots([ITEM_ID]);
    const result = await resolveRootTxOffsets({
      id: ITEM_ID,
      attributes: attributes({
        rootTransactionId: undefined,
        parentId: PARENT_ID,
      }),
      lookupLocalCdb64: noCdb64,
      ...roots,
    });

    assert.equal(result, undefined);
    assert.deepEqual(roots.calls, []);
  });

  it('keeps the previous behaviour when no location lookup is given', async () => {
    const result = await resolveRootTxOffsets({
      id: ROOT_TX_ID,
      attributes: attributes({ rootTransactionId: undefined }),
      lookupLocalCdb64: noCdb64,
    });

    assert.equal(result, undefined, 'L1 IDs are still declined');
  });
});

describe('signed /ar-io/offsets answers with Arweave offsets', () => {
  const ROOT_START = 392971320336631;
  const ROOT_SIZE = 3555491;
  const ITEM_ID = 'wndEaLf1BwnhuNmpDisdl0wWLnIrsVhQnPE0W24cWM8';

  /** The route's flow (resolve, then send) behind the HTTPSIG middleware. */
  const signedApp = (
    privateKey: crypto.KeyObject,
    attrs: ContiguousDataAttributes,
  ) => {
    const server = express();
    server.use(
      createHttpSigMiddleware({
        privateKey,
        keyId: deriveKeyId(crypto.createPublicKey(privateKey)),
        bindRequest: false,
      }),
    );
    server.get('/ar-io/offsets/:id', async (req, res) => {
      const resolved = await resolveRootTxOffsets({
        id: req.params.id,
        attributes: attrs,
        lookupLocalCdb64: async () => undefined,
        getRootArweaveLocation: async (txId) =>
          txId === ROOT_TX_ID
            ? { startOffset: ROOT_START, dataSize: ROOT_SIZE }
            : undefined,
      });
      if (resolved === undefined) {
        res.status(404).send('Offsets not found');
        return;
      }
      sendRootTxOffsets(res, resolved.offsets, 30);
    });
    return server;
  };

  /** Rebuilds the RFC 9421 base from the response and verifies it with `publicKey`. */
  const verify = (res: request.Response, publicKey: crypto.KeyObject) => {
    const input = res.headers['signature-input'] as string;
    const components = (input.match(/^sig1=\(([^)]*)\)/)?.[1] ?? '')
      .split(/\s+/)
      .filter((s) => s.length > 0)
      .map((s) => s.replace(/"/g, ''))
      .filter((c) => !c.startsWith('@'));
    const created = Number(input.match(/created=(\d+)/)?.[1]);
    const keyId = input.match(/keyid="([^"]+)"/)?.[1] ?? '';
    const { base } = buildSignatureBase(
      res.status,
      (n) => res.headers[n.toLowerCase()] as string | undefined,
      components,
      'GET',
      '',
      false,
      created,
      keyId,
    );
    const sig = Buffer.from(
      (res.headers['signature'] as string).match(/sig1=:([^:]+):/)?.[1] ?? '',
      'base64',
    );
    return {
      components,
      ok: crypto.verify(null, Buffer.from(base, 'latin1'), publicKey, sig),
    };
  };

  for (const [name, id, attrs] of [
    [
      'an L1 transaction',
      ROOT_TX_ID,
      attributes({ rootTransactionId: undefined, size: ROOT_SIZE }),
    ],
    ['a data item', ITEM_ID, attributes({ parentId: ROOT_TX_ID })],
  ] as const) {
    it(`signs the answer for ${name}: trigger set, digest covers the body, signature verifies`, async () => {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
      const res = await request(signedApp(privateKey, attrs))
        .get(`/ar-io/offsets/${id}`)
        .expect(200);

      // The trigger is set, so the answer is never sent unsigned.
      assert.equal(res.headers['x-ar-io-root-transaction-id'], ROOT_TX_ID);
      assert.equal(res.body.rootArweaveStartOffset, ROOT_START);
      // Content-Digest is the hash of the exact body bytes.
      assert.equal(
        res.headers['content-digest'],
        formatContentDigest(
          crypto.createHash('sha256').update(res.text).digest('base64url'),
        ),
      );
      const { components, ok } = verify(res, publicKey);
      assert.ok(components.includes('content-digest'));
      assert.ok(components.includes('x-ar-io-root-transaction-id'));
      assert.equal(ok, true, 'signature verifies with the gateway key');
    });
  }
});
