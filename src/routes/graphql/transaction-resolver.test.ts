/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { beforeEach, describe, it, Mock, mock } from 'node:test';

import { GqlQueryable, GqlTransaction } from '../../types.js';
import { resolveTransactionQuery } from './transaction-resolver.js';

const TEST_ID = 'LXCrfCRLHB7YyLGAeQoio00qb7LwT3UO3a-2TSDli8Q';
const GQL_TX: GqlTransaction = {
  id: TEST_ID,
  anchor: null,
  signature: null,
  signatureType: null,
  signatureSize: null,
  signatureOffset: null,
  recipient: null,
  ownerAddress: 'owner',
  ownerKey: null,
  ownerSize: null,
  ownerOffset: null,
  fee: '0',
  quantity: '0',
  dataSize: '0',
  contentType: null,
  blockIndepHash: null,
  blockTimestamp: null,
  height: null,
  blockPreviousBlock: null,
  parentId: null,
  blockTransactionIndex: 0,
  dataItemId: null,
  tags: [],
  indexedAt: 0,
  isDataItem: false,
};

const unexpectedCall = () =>
  Promise.reject(new Error('unexpected call in transaction resolver test'));

describe('resolveTransactionQuery', () => {
  let db: GqlQueryable & {
    getGqlTransaction: Mock<GqlQueryable['getGqlTransaction']>;
  };
  let txMetadataResolver: {
    resolve: Mock<(id: string) => Promise<unknown | undefined>>;
  };
  let onDemandSemaphore: {
    tryAcquire: Mock<() => boolean>;
    release: Mock<() => void>;
  };
  let log: {
    info: Mock<(message: string, meta?: Record<string, unknown>) => void>;
    debug: Mock<(message: string, meta?: Record<string, unknown>) => void>;
    warn: Mock<(message: string, meta?: Record<string, unknown>) => void>;
  };

  beforeEach(() => {
    db = {
      getGqlTransaction: mock.fn<GqlQueryable['getGqlTransaction']>(() =>
        Promise.resolve(null),
      ),
      getGqlTransactions: unexpectedCall,
      getGqlBlock: unexpectedCall,
      getGqlBlocks: unexpectedCall,
    };
    txMetadataResolver = {
      resolve: mock.fn<(id: string) => Promise<unknown | undefined>>(() =>
        Promise.resolve({ id: TEST_ID }),
      ),
    };
    onDemandSemaphore = {
      tryAcquire: mock.fn(() => true),
      release: mock.fn(() => undefined),
    };
    log = {
      info: mock.fn(() => undefined),
      debug: mock.fn(() => undefined),
      warn: mock.fn(() => undefined),
    };
  });

  it('should return the transaction after on-demand resolution persists it', async () => {
    let dbLookupCount = 0;
    db.getGqlTransaction = mock.fn<GqlQueryable['getGqlTransaction']>(
      async ({ id }) => {
        dbLookupCount += 1;
        return dbLookupCount === 1 ? null : { ...GQL_TX, id };
      },
    );

    const result = await resolveTransactionQuery(
      { id: TEST_ID },
      {
        db,
        txMetadataResolver,
        onDemandResolutionEnabled: true,
        onDemandResolutionTimeoutMs: 100,
        onDemandSemaphore,
        log,
        warnings: [],
      },
    );

    assert.deepEqual(result, GQL_TX);
    assert.equal(db.getGqlTransaction.mock.callCount(), 2);
    assert.equal(txMetadataResolver.resolve.mock.callCount(), 1);
    assert.equal(onDemandSemaphore.release.mock.callCount(), 1);
  });

  it('should skip on-demand resolution when disabled', async () => {
    const result = await resolveTransactionQuery(
      { id: TEST_ID },
      {
        db,
        txMetadataResolver,
        onDemandResolutionEnabled: false,
        onDemandResolutionTimeoutMs: 100,
        onDemandSemaphore,
        log,
        warnings: [],
      },
    );

    assert.equal(result, null);
    assert.equal(txMetadataResolver.resolve.mock.callCount(), 0);
    assert.equal(onDemandSemaphore.tryAcquire.mock.callCount(), 0);
    assert.equal(onDemandSemaphore.release.mock.callCount(), 0);
  });

  it('should return null on timeout and release the semaphore for a follow-up request', async () => {
    let releaseResolve!: (value: undefined) => void;
    const blockedResolve = new Promise<undefined>((resolve) => {
      releaseResolve = resolve;
    });
    txMetadataResolver.resolve = mock.fn(() => blockedResolve);

    const firstResult = await resolveTransactionQuery(
      { id: TEST_ID },
      {
        db,
        txMetadataResolver,
        onDemandResolutionEnabled: true,
        onDemandResolutionTimeoutMs: 1,
        onDemandSemaphore,
        log,
        warnings: [],
      },
    );

    assert.equal(firstResult, null);
    assert.equal(onDemandSemaphore.release.mock.callCount(), 1);

    releaseResolve(undefined);
    let followUpLookupCount = 0;
    db.getGqlTransaction = mock.fn<GqlQueryable['getGqlTransaction']>(
      async ({ id }) => {
        followUpLookupCount += 1;
        return followUpLookupCount === 1 ? null : { ...GQL_TX, id };
      },
    );
    txMetadataResolver.resolve = mock.fn(() =>
      Promise.resolve({ id: TEST_ID }),
    );

    const secondResult = await resolveTransactionQuery(
      { id: TEST_ID },
      {
        db,
        txMetadataResolver,
        onDemandResolutionEnabled: true,
        onDemandResolutionTimeoutMs: 100,
        onDemandSemaphore,
        log,
        warnings: [],
      },
    );

    assert.deepEqual(secondResult, GQL_TX);
    assert.equal(onDemandSemaphore.release.mock.callCount(), 2);
  });
});
