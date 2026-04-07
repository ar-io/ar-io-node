/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { beforeEach, describe, it, mock } from 'node:test';

import { resolveTransactionQuery } from './transaction-resolver.js';

const TEST_ID = 'LXCrfCRLHB7YyLGAeQoio00qb7LwT3UO3a-2TSDli8Q';
const GQL_TX = { id: TEST_ID, ownerAddress: 'owner' };

describe('resolveTransactionQuery', () => {
  let db: { getGqlTransaction: ReturnType<typeof mock.fn> };
  let txMetadataResolver: { resolve: ReturnType<typeof mock.fn> };
  let onDemandSemaphore: {
    tryAcquire: ReturnType<typeof mock.fn>;
    release: ReturnType<typeof mock.fn>;
  };
  let log: {
    info: ReturnType<typeof mock.fn>;
    debug: ReturnType<typeof mock.fn>;
    warn: ReturnType<typeof mock.fn>;
  };

  beforeEach(() => {
    db = {
      getGqlTransaction: mock.fn(() => Promise.resolve(null)),
    };
    txMetadataResolver = {
      resolve: mock.fn(() => Promise.resolve({ id: TEST_ID })),
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
    db.getGqlTransaction = mock.fn(async ({ id }: { id: string }) => {
      dbLookupCount += 1;
      return dbLookupCount === 1 ? null : { ...GQL_TX, id };
    });

    const result = await resolveTransactionQuery(
      { id: TEST_ID },
      {
        db,
        txMetadataResolver,
        onDemandResolutionEnabled: true,
        onDemandResolutionTimeoutMs: 100,
        onDemandSemaphore,
        log,
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
      },
    );

    assert.equal(result, null);
    assert.equal(txMetadataResolver.resolve.mock.callCount(), 0);
    assert.equal(onDemandSemaphore.tryAcquire.mock.callCount(), 0);
    assert.equal(onDemandSemaphore.release.mock.callCount(), 0);
  });

  it('should return null on timeout and release the semaphore for a follow-up request', async () => {
    let releaseResolve!: () => void;
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
      },
    );

    assert.equal(firstResult, null);
    assert.equal(onDemandSemaphore.release.mock.callCount(), 1);

    releaseResolve();
    let followUpLookupCount = 0;
    db.getGqlTransaction = mock.fn(async ({ id }: { id: string }) => {
      followUpLookupCount += 1;
      return followUpLookupCount === 1 ? null : { ...GQL_TX, id };
    });
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
      },
    );

    assert.deepEqual(secondResult, GQL_TX);
    assert.equal(onDemandSemaphore.release.mock.callCount(), 2);
  });
});
