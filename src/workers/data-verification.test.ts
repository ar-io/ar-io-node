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
  let extraWorkers: DataVerificationWorker[] = [];

  // Build a worker with an explicit optimistic-indexing setting, registered for
  // teardown in afterEach.
  const workerWithOptimisticIndexing = (enabled: boolean) => {
    const worker = new DataVerificationWorker({
      log,
      contiguousDataIndex,
      dataItemRootTxIndex: contiguousDataIndex,
      contiguousDataSource,
      optimisticTxIndexingEnabled: enabled,
    });
    extraWorkers.push(worker);
    return worker;
  };

  // Matching data root for the 'testing...' fixture below. A mined root tx
  // (height set) is the default fixture — the serving guard only withholds
  // verification for unmined (NULL-height) txs, which the dedicated guard tests
  // set explicitly.
  const MATCHING_DATA_ROOT = 'UwpYX2u5CYy6hYJbRTWfBxIig01UDe74SY7Om3_1ftw';
  const minedMatchingAttributes = async () => ({
    dataRoot: MATCHING_DATA_ROOT,
    height: 100,
  });

  before(() => {
    log = createTestLogger({ suite: 'DataVerificationWorker' });

    incrementVerificationRetryCountMock = mock.fn(() => Promise.resolve());
    saveVerificationStatusMock = mock.fn(() => Promise.resolve(true));

    contiguousDataIndex = {
      getDataAttributes: minedMatchingAttributes,
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
    // Each worker owns a DataRootComputer, which spawns worker threads. Any
    // worker built inside a test must be stopped or the test process never
    // exits.
    await Promise.all(extraWorkers.map((worker) => worker.stop()));
    extraWorkers = [];
    mock.restoreAll();
    incrementVerificationRetryCountMock.mock.resetCalls();
    saveVerificationStatusMock.mock.resetCalls();
    getDataMock.mock.resetCalls();
    // Restore the default fixture so tests that reassign getDataAttributes
    // (e.g. the mismatch cases) do not leak into subsequent tests.
    (contiguousDataIndex as any).getDataAttributes = minedMatchingAttributes;
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
        // mined (height set) so it passes the serving guard and reaches the
        // genuine mismatch path (where a real verification failure burns a retry).
        height: 100,
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
        // mined (height set) so it passes the serving guard and reaches the
        // genuine mismatch path (where a real verification failure burns a retry).
        height: 100,
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
        // mined (height set) so it passes the serving guard and reaches the
        // genuine mismatch path (where a real verification failure burns a retry).
        height: 100,
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
  // and computed data roots MATCH, an optimistically-indexed (not-yet-mined)
  // root tx must never be promoted to `verified` — it has no on-chain block yet.
  // Scoped to unmined data: normal mined data is unaffected.
  it('should NOT verify when data roots match but the root tx is not mined', async () => {
    (contiguousDataIndex as any).getDataAttributes = async () => ({
      dataRoot: MATCHING_DATA_ROOT,
      // no height → unmined / optimistic (new_transactions row with NULL height)
    });

    // The guard only applies when optimistic indexing is the thing creating
    // NULL-height rows.
    const verified = await workerWithOptimisticIndexing(true).verifyDataRoot({
      rootTxId: 'optimistic-tx',
      dataIds: ['optimistic-tx'],
    });

    assert.equal(verified, false);
    // The verified stamp must be withheld...
    assert.equal(saveVerificationStatusMock.mock.calls.length, 0);
    // ...and it must NOT burn the retry budget — withholding is "try again once
    // it mines", not a verification failure. Otherwise a legitimately pending tx
    // could exhaust its retries before it mines.
    assert.equal(incrementVerificationRetryCountMock.mock.calls.length, 0);
    // ...and crucially the data root must NOT be computed (the expensive step):
    // the guard short-circuits before computeDataRoot so an unmined item is
    // skipped cheaply instead of recomputed every sweep.
    assert.equal(getDataMock.mock.calls.length, 0);
  });

  // With optimistic indexing off, a NULL height means only that this gateway
  // has not imported the tx's block — routine for txs indexed via
  // admin/queue-tx, backfills, or a selectively synced deployment. Withholding
  // there strands long-mined data forever: withholding burns no retry, so the
  // item never ages out, and the guard's log is debug-level, so nothing
  // surfaces. Verification must proceed on the data root alone.
  it('should verify an unmined-looking root tx when optimistic indexing is disabled', async () => {
    (contiguousDataIndex as any).getDataAttributes = async () => ({
      dataRoot: MATCHING_DATA_ROOT,
      // no height, and no optimistic indexing to explain it
    });

    const verified = await workerWithOptimisticIndexing(false).verifyDataRoot({
      rootTxId: 'queued-tx',
      dataIds: ['queued-tx'],
    });

    assert.equal(verified, true);
    assert.equal(saveVerificationStatusMock.mock.calls.length, 1);
    // The data root WAS computed — the guard did not short-circuit.
    assert.ok(getDataMock.mock.calls.length >= 1);
  });

  it('should verify and stamp when the root tx is mined', async () => {
    (contiguousDataIndex as any).getDataAttributes = async () => ({
      dataRoot: MATCHING_DATA_ROOT,
      height: 100,
    });

    const verified = await dataVerificationWorker.verifyDataRoot({
      rootTxId: 'mined-tx',
      dataIds: ['mined-tx'],
    });

    assert.equal(verified, true);
    assert.equal(saveVerificationStatusMock.mock.calls.length, 1);
    // A mined item IS verified, so the data root was computed.
    assert.ok(getDataMock.mock.calls.length >= 1);
  });

  // A lookup-miss (getDataAttributes returns undefined — the root tx isn't in
  // the index at all) is NOT the optimistic-unmined case. It must fall through
  // to the normal path and burn a retry, not be withheld unpenalized — otherwise
  // a perpetually-missing root would spin forever at retry_count=0.
  it('should retry (not withhold) when the root tx has no attributes at all', async () => {
    (contiguousDataIndex as any).getDataAttributes = async () => undefined;

    const verified = await dataVerificationWorker.verifyDataRoot({
      rootTxId: 'missing-tx',
      dataIds: ['missing-tx'],
    });

    assert.equal(verified, false);
    // Penalized like a normal failure, NOT withheld.
    assert.equal(incrementVerificationRetryCountMock.mock.calls.length, 1);
    // No data root computed (indexedDataRoot is undefined).
    assert.equal(getDataMock.mock.calls.length, 0);
  });
});
