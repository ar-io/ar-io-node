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
import winston from 'winston';
import { ContiguousDataIndex, ContiguousDataSource } from '../types.js';

import { DataVerificationWorker } from './data-verification.js';

describe('DataVerificationWorker', () => {
  let log: winston.Logger;
  let dataVerificationWorker: DataVerificationWorker;
  let contiguousDataIndex: ContiguousDataIndex;
  let incrementVerificationRetryCountMock: any;
  let contiguousDataSource: ContiguousDataSource;

  before(() => {
    log = winston.createLogger({ silent: true });

    incrementVerificationRetryCountMock = mock.fn(() => Promise.resolve());

    contiguousDataIndex = {
      getDataAttributes: async () => {
        return {
          dataRoot: 'UwpYX2u5CYy6hYJbRTWfBxIig01UDe74SY7Om3_1ftw',
        };
      },
      saveVerificationStatus: async () => {
        return true;
      },
      incrementVerificationRetryCount: incrementVerificationRetryCountMock,
    } as any;

    contiguousDataSource = {
      getData: () =>
        Promise.resolve({
          stream: Readable.from(Buffer.from('testing...')),
          size: 10,
          verified: false,
          cached: false,
        }),
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
});
