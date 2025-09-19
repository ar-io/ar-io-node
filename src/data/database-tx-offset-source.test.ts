/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { DatabaseTxOffsetSource } from './database-tx-offset-source.js';
import { TxOffsetResult } from '../types.js';
import log from '../log.js';

describe('DatabaseTxOffsetSource', () => {
  let databaseTxOffsetSource: DatabaseTxOffsetSource;
  let mockDb: any;

  const validResult: TxOffsetResult = {
    data_root: 'abc123',
    id: 'tx123',
    offset: 1000,
    data_size: 256,
  };

  beforeEach(() => {
    mockDb = {
      getTxByOffset: mock.fn(() => Promise.resolve(validResult)),
    };

    databaseTxOffsetSource = new DatabaseTxOffsetSource({
      log,
      db: mockDb,
    });
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it('should return result from database', async () => {
    const result = await databaseTxOffsetSource.getTxByOffset(1000);

    assert.deepStrictEqual(result, validResult);
    assert.strictEqual(mockDb.getTxByOffset.mock.callCount(), 1);
    assert.deepStrictEqual(mockDb.getTxByOffset.mock.calls[0].arguments, [
      1000,
    ]);
  });

  it('should propagate database errors', async () => {
    const testError = new Error('Database connection failed');
    mockDb.getTxByOffset = mock.fn(() => Promise.reject(testError));

    await assert.rejects(
      () => databaseTxOffsetSource.getTxByOffset(1000),
      testError,
    );
  });

  it('should return undefined values when database returns them', async () => {
    const undefinedResult: TxOffsetResult = {
      data_root: undefined,
      id: undefined,
      offset: undefined,
      data_size: undefined,
    };
    mockDb.getTxByOffset = mock.fn(() => Promise.resolve(undefinedResult));

    const result = await databaseTxOffsetSource.getTxByOffset(1000);

    assert.deepStrictEqual(result, undefinedResult);
  });
});
