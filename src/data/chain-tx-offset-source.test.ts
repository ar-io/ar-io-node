/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { ChainTxOffsetSource } from './chain-tx-offset-source.js';
import { TxOffsetResult } from '../types.js';
import log from '../log.js';

describe('ChainTxOffsetSource', () => {
  let chainTxOffsetSource: ChainTxOffsetSource;
  let mockArweaveClient: any;

  const validTxData = {
    data_root: 'abc123',
    data_size: '256',
  };

  const chainFindResult = {
    txId: 'tx123',
    txOffset: 1000,
  };

  const expectedResult: TxOffsetResult = {
    data_root: 'abc123',
    id: 'tx123',
    offset: 1000,
    data_size: 256,
  };

  beforeEach(() => {
    mockArweaveClient = {
      findTxByOffset: mock.fn(() => Promise.resolve(chainFindResult)),
      getTx: mock.fn(() => Promise.resolve(validTxData)),
    };

    chainTxOffsetSource = new ChainTxOffsetSource({
      log,
      arweaveClient: mockArweaveClient,
    });
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it('should return valid result when chain data is complete', async () => {
    const result = await chainTxOffsetSource.getTxByOffset(1000);

    assert.deepStrictEqual(result, expectedResult);
    assert.strictEqual(mockArweaveClient.findTxByOffset.mock.callCount(), 1);
    assert.strictEqual(mockArweaveClient.getTx.mock.callCount(), 1);
    assert.deepStrictEqual(
      mockArweaveClient.findTxByOffset.mock.calls[0].arguments,
      [1000],
    );
    assert.deepStrictEqual(mockArweaveClient.getTx.mock.calls[0].arguments, [
      { txId: 'tx123' },
    ]);
  });

  it('should return undefined values when findTxByOffset returns null', async () => {
    mockArweaveClient.findTxByOffset = mock.fn(() => Promise.resolve(null));

    const result = await chainTxOffsetSource.getTxByOffset(1000);

    const expectedUndefinedResult: TxOffsetResult = {
      data_root: undefined,
      id: undefined,
      offset: undefined,
      data_size: undefined,
    };

    assert.deepStrictEqual(result, expectedUndefinedResult);
    assert.strictEqual(mockArweaveClient.getTx.mock.callCount(), 0);
  });

  it('should return undefined values when getTx returns undefined', async () => {
    mockArweaveClient.getTx = mock.fn(() => Promise.resolve(undefined));

    const result = await chainTxOffsetSource.getTxByOffset(1000);

    const expectedUndefinedResult: TxOffsetResult = {
      data_root: undefined,
      id: undefined,
      offset: undefined,
      data_size: undefined,
    };

    assert.deepStrictEqual(result, expectedUndefinedResult);
  });

  it('should return undefined values when getTx returns null', async () => {
    mockArweaveClient.getTx = mock.fn(() => Promise.resolve(null));

    const result = await chainTxOffsetSource.getTxByOffset(1000);

    const expectedUndefinedResult: TxOffsetResult = {
      data_root: undefined,
      id: undefined,
      offset: undefined,
      data_size: undefined,
    };

    assert.deepStrictEqual(result, expectedUndefinedResult);
  });

  it('should return undefined values when transaction data is incomplete', async () => {
    mockArweaveClient.getTx = mock.fn(() =>
      Promise.resolve({
        data_root: 'abc123',
        // Missing data_size
      }),
    );

    const result = await chainTxOffsetSource.getTxByOffset(1000);

    const expectedUndefinedResult: TxOffsetResult = {
      data_root: undefined,
      id: undefined,
      offset: undefined,
      data_size: undefined,
    };

    assert.deepStrictEqual(result, expectedUndefinedResult);
  });

  it('should return undefined values when findTxByOffset throws error', async () => {
    mockArweaveClient.findTxByOffset = mock.fn(() =>
      Promise.reject(new Error('Network error')),
    );

    const result = await chainTxOffsetSource.getTxByOffset(1000);

    const expectedUndefinedResult: TxOffsetResult = {
      data_root: undefined,
      id: undefined,
      offset: undefined,
      data_size: undefined,
    };

    assert.deepStrictEqual(result, expectedUndefinedResult);
    assert.strictEqual(mockArweaveClient.getTx.mock.callCount(), 0);
  });

  it('should return undefined values when getTx throws error', async () => {
    mockArweaveClient.getTx = mock.fn(() =>
      Promise.reject(new Error('Chain error')),
    );

    const result = await chainTxOffsetSource.getTxByOffset(1000);

    const expectedUndefinedResult: TxOffsetResult = {
      data_root: undefined,
      id: undefined,
      offset: undefined,
      data_size: undefined,
    };

    assert.deepStrictEqual(result, expectedUndefinedResult);
  });

  it('should parse data_size as integer', async () => {
    mockArweaveClient.getTx = mock.fn(() =>
      Promise.resolve({
        data_root: 'abc123',
        data_size: '1024', // String value
      }),
    );

    const result = await chainTxOffsetSource.getTxByOffset(1000);

    const expectedParsedResult: TxOffsetResult = {
      data_root: 'abc123',
      id: 'tx123',
      offset: 1000,
      data_size: 1024, // Should be parsed as integer
    };

    assert.deepStrictEqual(result, expectedParsedResult);
  });
});
