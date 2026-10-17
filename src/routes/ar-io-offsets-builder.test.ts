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
import { deriveKeyId } from '../lib/httpsig.js';
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
