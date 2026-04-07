/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import { createTestLogger } from '../../test/test-logger.js';
import { TxMetadataResolver } from './tx-metadata-resolver.js';

const TEST_ID = 'LXCrfCRLHB7YyLGAeQoio00qb7LwT3UO3a-2TSDli8Q';
const TEST_ID_2 = 'abc123def456abc123def456abc123def456abc123abc';
const ROOT_TX_ID = 'rootTx000000000000000000000000000000000000000';

const MOCK_GQL_TX = {
  id: TEST_ID,
  signature: 'test-sig',
  signatureType: 1,
  ownerAddress: 'test-owner-address',
  ownerKey: 'test-owner-key',
  recipient: 'test-target',
  anchor: 'test-anchor',
  tags: [{ name: 'Content-Type', value: 'text/plain' }],
  dataSize: '100',
  contentType: 'text/plain',
  parentId: null,
  height: 1000,
  blockIndepHash: 'block-hash',
  blockTimestamp: 1234567890,
  blockPreviousBlock: 'prev-block',
  fee: '0',
  quantity: '0',
  ownerOffset: null,
  ownerSize: null,
  signatureOffset: null,
  signatureSize: null,
};

const MOCK_DATA_ITEM_META = {
  id: TEST_ID,
  signatureType: 1,
  signature: 'data-item-sig',
  signatureOffset: 2,
  signatureSize: 512,
  owner: 'data-item-owner',
  ownerAddress: 'data-item-owner-address',
  ownerOffset: 514,
  ownerSize: 512,
  target: '',
  anchor: 'data-item-anchor',
  tags: [{ name: 'App-Name', value: 'TestApp' }],
  headerSize: 1200,
  payloadSize: 500,
  contentType: 'application/json',
};

const MOCK_OFFSET_RESULT = {
  itemOffset: 100,
  dataOffset: 1300,
  itemSize: 1700,
  dataSize: 500,
};

describe('TxMetadataResolver', () => {
  let log: ReturnType<typeof createTestLogger>;
  let gqlQueryable: any;
  let rootTxIndex: any;
  let offsetSource: any;
  let dataItemIndexWriter: any;

  before(() => {
    log = createTestLogger({ suite: 'TxMetadataResolver' });
  });

  beforeEach(() => {
    gqlQueryable = {
      getGqlTransaction: mock.fn(() => Promise.resolve(null)),
    };
    rootTxIndex = {
      getRootTx: mock.fn(() =>
        Promise.resolve({ rootTxId: ROOT_TX_ID, path: undefined }),
      ),
    };
    offsetSource = {
      getDataItemOffset: mock.fn(() => Promise.resolve(MOCK_OFFSET_RESULT)),
      getDataItemOffsetWithPath: mock.fn(() =>
        Promise.resolve(MOCK_OFFSET_RESULT),
      ),
      extractDataItemMeta: mock.fn(() => Promise.resolve(MOCK_DATA_ITEM_META)),
    };
    dataItemIndexWriter = {
      saveDataItem: mock.fn(() => Promise.resolve()),
    };
  });

  afterEach(() => {
    mock.restoreAll();
  });

  describe('resolve — local fast path', () => {
    it('should return result from GQL DB when cache misses', async () => {
      gqlQueryable.getGqlTransaction = mock.fn(() =>
        Promise.resolve(MOCK_GQL_TX),
      );
      const resolver = new TxMetadataResolver({
        log,
        gqlQueryable,
        rootTxIndex,
        ans104OffsetSources: [offsetSource],
      });

      const result = await resolver.resolve(TEST_ID);

      assert.notEqual(result, undefined);
      assert.equal(result!.id, TEST_ID);
      assert.equal(result!.signature, 'test-sig');
      assert.equal(rootTxIndex.getRootTx.mock.callCount(), 0);
    });

    it('should cache results and return from cache on second call', async () => {
      gqlQueryable.getGqlTransaction = mock.fn(() =>
        Promise.resolve(MOCK_GQL_TX),
      );
      const resolver = new TxMetadataResolver({
        log,
        gqlQueryable,
        rootTxIndex,
        ans104OffsetSources: [offsetSource],
      });

      await resolver.resolve(TEST_ID);
      const result = await resolver.resolve(TEST_ID);

      assert.notEqual(result, undefined);
      // GQL should only be called once — second call served from cache
      assert.equal(gqlQueryable.getGqlTransaction.mock.callCount(), 1);
    });
  });

  describe('resolve — semaphore only gates remote path', () => {
    it('should serve locally-available IDs even when semaphore is exhausted', async () => {
      // First call for GQL returns the tx for TEST_ID_2 only
      gqlQueryable.getGqlTransaction = mock.fn((args: { id: string }) => {
        if (args.id === TEST_ID_2) {
          return Promise.resolve({ ...MOCK_GQL_TX, id: TEST_ID_2 });
        }
        return Promise.resolve(null);
      });

      let enterRemote!: () => void;
      const remoteEntered = new Promise<void>((resolve) => {
        enterRemote = resolve;
      });
      let releaseRemote!: () => void;
      const remoteBlocked = new Promise<void>((resolve) => {
        releaseRemote = resolve;
      });
      rootTxIndex.getRootTx = mock.fn(async () => {
        enterRemote();
        await remoteBlocked;
        return { rootTxId: ROOT_TX_ID, path: undefined };
      });

      const resolver = new TxMetadataResolver({
        log,
        gqlQueryable,
        rootTxIndex,
        ans104OffsetSources: [offsetSource],
        resolveConcurrency: 1,
      });

      // Start a slow remote resolve for TEST_ID (takes the semaphore)
      const slowPromise = resolver.resolve(TEST_ID);
      await remoteEntered;

      // TEST_ID_2 is locally available — should still resolve
      const localResult = await resolver.resolve(TEST_ID_2);
      assert.notEqual(localResult, undefined);
      assert.equal(localResult!.id, TEST_ID_2);

      // Let slow resolve finish
      releaseRemote();
      await slowPromise;
    });

    it('should return undefined for remote IDs when semaphore is exhausted', async () => {
      let enterRemote!: () => void;
      const remoteEntered = new Promise<void>((resolve) => {
        enterRemote = resolve;
      });
      let releaseRemote!: () => void;
      const remoteBlocked = new Promise<void>((resolve) => {
        releaseRemote = resolve;
      });
      rootTxIndex.getRootTx = mock.fn(async () => {
        enterRemote();
        await remoteBlocked;
        return { rootTxId: ROOT_TX_ID, path: undefined };
      });

      const resolver = new TxMetadataResolver({
        log,
        gqlQueryable,
        rootTxIndex,
        ans104OffsetSources: [offsetSource],
        resolveConcurrency: 1,
      });

      // Start a slow remote resolve (takes the semaphore)
      const slowPromise = resolver.resolve(TEST_ID);
      await remoteEntered;

      // Second remote resolve should be rejected
      const result = await resolver.resolve(TEST_ID_2);
      assert.equal(result, undefined);

      releaseRemote();
      await slowPromise;
    });
  });

  describe('resolve — deduplication', () => {
    it('should coalesce concurrent requests for the same ID', async () => {
      let resolveCount = 0;
      rootTxIndex.getRootTx = mock.fn(() => {
        resolveCount++;
        return new Promise((resolve) =>
          setTimeout(
            () => resolve({ rootTxId: ROOT_TX_ID, path: undefined }),
            50,
          ),
        );
      });

      const resolver = new TxMetadataResolver({
        log,
        gqlQueryable,
        rootTxIndex,
        ans104OffsetSources: [offsetSource],
        dataItemIndexWriter,
      });

      const [result1, result2, result3] = await Promise.all([
        resolver.resolve(TEST_ID),
        resolver.resolve(TEST_ID),
        resolver.resolve(TEST_ID),
      ]);

      // All should get the same result
      assert.deepEqual(result1, result2);
      assert.deepEqual(result2, result3);
      // Only one actual resolution should have occurred
      assert.equal(resolveCount, 1);
    });
  });

  describe('resolve — persistence', () => {
    it('should complete saveDataItem before resolve returns', async () => {
      let saveCompleted = false;
      dataItemIndexWriter.saveDataItem = mock.fn(async () => {
        // Simulate async write delay
        await new Promise((resolve) => setTimeout(resolve, 50));
        saveCompleted = true;
      });

      const resolver = new TxMetadataResolver({
        log,
        gqlQueryable,
        rootTxIndex,
        ans104OffsetSources: [offsetSource],
        dataItemIndexWriter,
      });

      await resolver.resolve(TEST_ID);

      assert.equal(saveCompleted, true);
      assert.equal(dataItemIndexWriter.saveDataItem.mock.callCount(), 1);
    });

    it('should return resolved metadata even if saveDataItem throws', async () => {
      dataItemIndexWriter.saveDataItem = mock.fn(() =>
        Promise.reject(new Error('DB write failed')),
      );

      const resolver = new TxMetadataResolver({
        log,
        gqlQueryable,
        rootTxIndex,
        ans104OffsetSources: [offsetSource],
        dataItemIndexWriter,
      });

      const result = await resolver.resolve(TEST_ID);

      assert.notEqual(result, undefined);
      assert.equal(result!.id, TEST_ID);
      assert.equal(dataItemIndexWriter.saveDataItem.mock.callCount(), 1);
    });
  });
});
