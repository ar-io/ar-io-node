/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import request from 'supertest';

import { createTestLogger } from '../../test/test-logger.js';
import { createTxRouter } from './arweave-tx.js';
import { ResolvedDataItemMeta } from '../data/data-item-meta-resolver.js';

const log = createTestLogger({ suite: 'ArweaveTxRoute' });

const VALID_TX_ID = 'LXCrfCRLHB7YyLGAeQoio00qb7LwT3UO3a-2TSDli8Q';

const MOCK_L1_TX = {
  format: 2,
  id: VALID_TX_ID,
  last_tx: 'some-anchor',
  owner: 'owner-public-key-base64url',
  tags: [{ name: 'Q29udGVudC1UeXBl', value: 'YXBwbGljYXRpb24vanNvbg' }],
  target: '',
  quantity: '0',
  data_size: '1234',
  data_root: 'some-data-root',
  reward: '477648',
  signature: 'some-signature',
};

const MOCK_DATA_ITEM_META: ResolvedDataItemMeta = {
  id: VALID_TX_ID,
  signature: 'data-item-sig',
  signatureType: 1,
  ownerAddress: '6p817XK-yIX-hBCQ0qD5wbcP05WPQgPKFmwNYC2xtwM',
  owner: 'owner-full-pubkey',
  target: 'target-address',
  anchor: 'anchor-value',
  tags: [
    { name: 'Content-Type', value: 'application/json' },
    { name: 'App-Name', value: 'TestApp' },
  ],
  dataSize: 5678,
  contentType: 'application/json',
  parentId: 'parent-bundle-id',
  rootTransactionId: 'root-tx-id',
  isStable: true,
};

describe('ArweaveTxRoute', () => {
  let app: express.Application;
  let txStoreGetMock: ReturnType<typeof mock.fn>;
  let resolverResolveMock: ReturnType<typeof mock.fn>;
  let arweaveGetTxMock: ReturnType<typeof mock.fn>;
  let txStore: any;
  let dataItemMetaResolver: any;
  let arweaveClient: any;

  beforeEach(() => {
    txStoreGetMock = mock.fn(() => Promise.resolve(undefined));
    resolverResolveMock = mock.fn(() => Promise.resolve(undefined));
    arweaveGetTxMock = mock.fn(() => Promise.reject(new Error('Not found')));

    txStore = {
      get: txStoreGetMock,
      set: mock.fn(),
      has: mock.fn(),
      del: mock.fn(),
    };

    dataItemMetaResolver = {
      resolve: resolverResolveMock,
      resolveFromLocal: resolverResolveMock,
    };

    arweaveClient = {
      getTx: arweaveGetTxMock,
      getBlockByHeight: mock.fn(),
      getTxOffset: mock.fn(),
      getTxField: mock.fn(),
      getPendingTxIds: mock.fn(),
    };

    app = express();
    app.use(
      createTxRouter({
        log,
        txStore,
        dataItemMetaResolver,
        arweaveClient,
      }),
    );
  });

  afterEach(() => {
    mock.restoreAll();
  });

  describe('GET /tx/:id', () => {
    it('should return 400 for invalid transaction ID', async () => {
      const res = await request(app).get('/tx/invalid-id');
      assert.strictEqual(res.status, 400);
    });

    it('should return L1 transaction from txStore', async () => {
      txStoreGetMock.mock.mockImplementation(() => Promise.resolve(MOCK_L1_TX));

      const res = await request(app).get(`/tx/${VALID_TX_ID}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.format, 2);
      assert.strictEqual(res.body.id, VALID_TX_ID);
      assert.strictEqual(res.body.reward, '477648');
      assert.ok(res.headers['cache-control'].includes('immutable'));
    });

    it('should return L2 data item from resolver', async () => {
      resolverResolveMock.mock.mockImplementation(() =>
        Promise.resolve(MOCK_DATA_ITEM_META),
      );

      const res = await request(app).get(`/tx/${VALID_TX_ID}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.id, VALID_TX_ID);
      assert.strictEqual(res.body.format, 1);
      assert.strictEqual(res.body.quantity, '0');
      assert.strictEqual(res.body.reward, '0');
      assert.strictEqual(res.body.data_root, '');
      assert.strictEqual(res.body.data_size, '5678');
      assert.strictEqual(
        res.body.owner,
        '6p817XK-yIX-hBCQ0qD5wbcP05WPQgPKFmwNYC2xtwM',
      );
      assert.strictEqual(res.body.parent_id, 'parent-bundle-id');
      assert.strictEqual(res.body.root_transaction_id, 'root-tx-id');
      assert.strictEqual(res.body.signature_type, 1);
      assert.strictEqual(res.body.content_type, 'application/json');
      // Tags should be base64url encoded
      assert.ok(Array.isArray(res.body.tags));
      assert.strictEqual(res.body.tags.length, 2);
      assert.ok(res.headers['cache-control'].includes('immutable'));
    });

    it('should set short cache for unstable data items', async () => {
      const unstableMeta = { ...MOCK_DATA_ITEM_META, isStable: false };
      resolverResolveMock.mock.mockImplementation(() =>
        Promise.resolve(unstableMeta),
      );

      const res = await request(app).get(`/tx/${VALID_TX_ID}`);
      assert.strictEqual(res.status, 200);
      assert.ok(res.headers['cache-control'].includes('max-age=30'));
    });

    it('should try L1 before L2', async () => {
      txStoreGetMock.mock.mockImplementation(() => Promise.resolve(MOCK_L1_TX));
      resolverResolveMock.mock.mockImplementation(() =>
        Promise.resolve(MOCK_DATA_ITEM_META),
      );

      const res = await request(app).get(`/tx/${VALID_TX_ID}`);
      // Should return L1 (format 2), not L2 (format 1)
      assert.strictEqual(res.body.format, 2);
      // Resolver should not be called
      assert.strictEqual(resolverResolveMock.mock.callCount(), 0);
    });

    it('should fallback to Arweave node for unknown L1 tx', async () => {
      arweaveGetTxMock.mock.mockImplementation(() =>
        Promise.resolve(MOCK_L1_TX),
      );

      const res = await request(app).get(`/tx/${VALID_TX_ID}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.format, 2);
    });

    it('should return 404 and trigger background indexing when not found anywhere', async () => {
      const res = await request(app).get(`/tx/${VALID_TX_ID}`);
      assert.strictEqual(res.status, 404);
      // resolveFromLocal (miss) + resolve (background indexing)
      assert.strictEqual(resolverResolveMock.mock.calls.length, 2);
    });
  });
});
