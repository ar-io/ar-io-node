/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { strict as assert } from 'node:assert';
import { Readable } from 'node:stream';
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  it,
  mock,
} from 'node:test';
import { ContiguousDataIndex, ContiguousDataSource } from '../types.js';

import { DataVerificationWorker } from './data-verification.js';
import { createTestLogger } from '../../test/test-logger.js';

describe('DataVerificationWorker', () => {
  let log: ReturnType<typeof createTestLogger>;
  let dataVerificationWorker: DataVerificationWorker;
  let contiguousDataIndex: ContiguousDataIndex;
  let incrementVerificationRetryCountMock: any;
  let saveVerificationStatusMock: any;
  let getDataMock: any;
  let contiguousDataSource: ContiguousDataSource;

  // Matching data root for the 'testing...' fixture below. A stable root tx
  // (past fork depth) is the default fixture — the serving guard only withholds
  // verification for not-yet-stable txs, which the dedicated guard tests set
  // explicitly.
  const MATCHING_DATA_ROOT = 'UwpYX2u5CYy6hYJbRTWfBxIig01UDe74SY7Om3_1ftw';
  const stableMatchingAttributes = async () => ({
    dataRoot: MATCHING_DATA_ROOT,
    stable: true,
  });

  before(() => {
    log = createTestLogger({ suite: 'DataVerificationWorker' });

    incrementVerificationRetryCountMock = mock.fn(() => Promise.resolve());
    saveVerificationStatusMock = mock.fn(() => Promise.resolve(true));

    contiguousDataIndex = {
      getDataAttributes: stableMatchingAttributes,
      saveVerificationStatus: saveVerificationStatusMock,
      incrementVerificationRetryCount: incrementVerificationRetryCountMock,
    } as any;

    // Spy on getData so tests can assert whether the data root was computed
    // (computeDataRoot streams the data via getData).
    getDataMock = mock.fn(() =>
      Promise.resolve({
        stream: Readable.from(Buffer.from('testing...')),
        size: 10,
        verified: false,
        cached: false,
      }),
    );
    contiguousDataSource = {
      getData: getDataMock,
    };

    dataVerificationWorker = new DataVerificationWorker({
      log,
      contiguousDataIndex,
      dataItemRootTxIndex: contiguousDataIndex,
      contiguousDataSource,
    });
  });

  afterEach(async () => {
    mock.restoreAll();
    incrementVerificationRetryCountMock.mock.resetCalls();
    saveVerificationStatusMock.mock.resetCalls();
    getDataMock.mock.resetCalls();
    // Restore the default fixture so tests that reassign getDataAttributes
    // (e.g. the mismatch cases) do not leak into subsequent tests.
    (contiguousDataIndex as any).getDataAttributes = stableMatchingAttributes;
  });

  after(async () => {
    await dataVerificationWorker.stop();
  });

  it('should verify data root correctly', async () => {
    assert.equal(
      await dataVerificationWorker.verifyDataRoot({
        rootTxId: '',
        dataIds: [''],
      }),
      true,
    );
  });

  it('should fail verification when they dont match', async () => {
    (contiguousDataIndex as any).getDataAttributes = async () => {
      return {
        // stable so it passes the serving guard and reaches the genuine
        // mismatch path (where a real verification failure burns a retry).
        stable: true,
        dataRoot: 'nomatch',
      };
    };

    assert.equal(
      await dataVerificationWorker.verifyDataRoot({
        rootTxId: '',
        dataIds: [''],
      }),
      false,
    );
  });

  it('should increment retry count on verification failure', async () => {
    (contiguousDataIndex as any).getDataAttributes = async () => {
      return {
        // stable so it passes the serving guard and reaches the genuine
        // mismatch path (where a real verification failure burns a retry).
        stable: true,
        dataRoot: 'nomatch',
      };
    };

    await dataVerificationWorker.verifyDataRoot({
      rootTxId: 'test-id',
      dataIds: ['test-id'],
    });

    assert.equal(incrementVerificationRetryCountMock.mock.calls.length, 1);
    assert.equal(
      incrementVerificationRetryCountMock.mock.calls[0].arguments[0],
      'test-id',
    );
  });

  it('should increment retry count for all associated data IDs', async () => {
    (contiguousDataIndex as any).getDataAttributes = async () => {
      return {
        // stable so it passes the serving guard and reaches the genuine
        // mismatch path (where a real verification failure burns a retry).
        stable: true,
        dataRoot: 'nomatch',
      };
    };

    const rootTxId = 'root-tx-id';
    const dataIds = ['data-id-1', 'data-id-2', 'data-id-3'];

    await dataVerificationWorker.verifyDataRoot({ rootTxId, dataIds });

    // Should increment retry count for all data IDs
    assert.equal(incrementVerificationRetryCountMock.mock.calls.length, 3);
    assert.equal(
      incrementVerificationRetryCountMock.mock.calls[0].arguments[0],
      'data-id-1',
    );
    assert.equal(
      incrementVerificationRetryCountMock.mock.calls[1].arguments[0],
      'data-id-2',
    );
    assert.equal(
      incrementVerificationRetryCountMock.mock.calls[2].arguments[0],
      'data-id-3',
    );
  });

  // Serving guard (optimistic L1 tx indexing / corner C): even when the indexed
  // and computed data roots MATCH, an optimistically-indexed (not-yet-stable)
  // root tx must never be promoted to `verified` — merkle self-consistency is
  // not permanence. The gateway can never serve not-yet-permanent data as
  // permanent.
  it('should NOT verify when data roots match but the root tx is not stable', async () => {
    (contiguousDataIndex as any).getDataAttributes = async () => ({
      dataRoot: MATCHING_DATA_ROOT,
      stable: false, // optimistic / not yet past fork depth
    });

    const verified = await dataVerificationWorker.verifyDataRoot({
      rootTxId: 'optimistic-tx',
      dataIds: ['optimistic-tx'],
    });

    assert.equal(verified, false);
    // The verified stamp must be withheld...
    assert.equal(saveVerificationStatusMock.mock.calls.length, 0);
    // ...and it must NOT burn the retry budget — withholding is "try again once
    // it stabilizes", not a verification failure. Otherwise a legitimately
    // pending tx could exhaust its retries before it confirms.
    assert.equal(incrementVerificationRetryCountMock.mock.calls.length, 0);
    // ...and crucially the data root must NOT be computed (the expensive step):
    // the guard short-circuits before computeDataRoot so a not-yet-stable item
    // is skipped cheaply instead of recomputed every sweep.
    assert.equal(getDataMock.mock.calls.length, 0);
  });

  it('should verify and stamp when the root tx is stable', async () => {
    (contiguousDataIndex as any).getDataAttributes = async () => ({
      dataRoot: MATCHING_DATA_ROOT,
      stable: true,
    });

    const verified = await dataVerificationWorker.verifyDataRoot({
      rootTxId: 'stable-tx',
      dataIds: ['stable-tx'],
    });

    assert.equal(verified, true);
    assert.equal(saveVerificationStatusMock.mock.calls.length, 1);
    // A stable item IS verified, so the data root was computed.
    assert.ok(getDataMock.mock.calls.length >= 1);
  });
});
