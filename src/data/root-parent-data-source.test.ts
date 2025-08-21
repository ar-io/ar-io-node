/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { Readable } from 'node:stream';
import winston from 'winston';

import { RootParentDataSource } from './root-parent-data-source.js';
import { Ans104OffsetSource } from './ans104-offset-source.js';
import { ContiguousDataSource, DataItemRootTxIndex } from '../types.js';

describe('RootParentDataSource', () => {
  let log: winston.Logger;
  let dataSource: ContiguousDataSource;
  let dataItemRootTxIndex: DataItemRootTxIndex;
  let ans104OffsetSource: Ans104OffsetSource;
  let rootParentDataSource: RootParentDataSource;

  beforeEach(() => {
    log = winston.createLogger({
      silent: true,
    });
    dataSource = {
      getData: mock.fn(),
    };
    dataItemRootTxIndex = {
      getRootTxId: mock.fn(),
    };
    ans104OffsetSource = {
      getDataItemOffset: mock.fn(),
    } as any;
    rootParentDataSource = new RootParentDataSource({
      log,
      dataSource,
      dataItemRootTxIndex,
      ans104OffsetSource,
    });
  });

  afterEach(() => {
    mock.restoreAll();
  });

  describe('getData', () => {
    it('should successfully retrieve data using root parent resolution', async () => {
      const dataItemId = 'test-data-item-id';
      const rootTxId = 'root-tx-id';
      const dataStream = Readable.from([Buffer.from('test data')]);

      // Mock root TX lookup
      (dataItemRootTxIndex.getRootTxId as any).mock.mockImplementationOnce(
        async () => rootTxId,
      );

      // Mock offset parsing
      (ans104OffsetSource.getDataItemOffset as any).mock.mockImplementationOnce(
        async () => ({ offset: 1000, size: 500 }),
      );

      // Mock data fetch
      (dataSource.getData as any).mock.mockImplementationOnce(async () => ({
        stream: dataStream,
        size: 500,
        verified: true,
        trusted: true,
        cached: false,
      }));

      const result = await rootParentDataSource.getData({ id: dataItemId });

      assert.strictEqual(result.size, 500);
      assert.strictEqual(result.verified, true);
      assert.strictEqual(result.trusted, true);
      assert.strictEqual(result.cached, false);
      assert.strictEqual(result.stream, dataStream);

      // Verify call order
      assert.strictEqual(
        (dataItemRootTxIndex.getRootTxId as any).mock.calls.length,
        1,
      );
      assert.strictEqual(
        (dataItemRootTxIndex.getRootTxId as any).mock.calls[0].arguments[0],
        dataItemId,
      );

      assert.strictEqual(
        (ans104OffsetSource.getDataItemOffset as any).mock.calls.length,
        1,
      );
      assert.strictEqual(
        (ans104OffsetSource.getDataItemOffset as any).mock.calls[0]
          .arguments[0],
        dataItemId,
      );
      assert.strictEqual(
        (ans104OffsetSource.getDataItemOffset as any).mock.calls[0]
          .arguments[1],
        rootTxId,
      );

      assert.strictEqual((dataSource.getData as any).mock.calls.length, 1);
      const dataCall = (dataSource.getData as any).mock.calls[0].arguments[0];
      assert.strictEqual(dataCall.id, rootTxId);
      assert.deepStrictEqual(dataCall.region, { offset: 1000, size: 500 });
    });

    it('should handle requested regions correctly', async () => {
      const dataItemId = 'test-data-item-id';
      const rootTxId = 'root-tx-id';
      const dataStream = Readable.from([Buffer.from('partial data')]);

      (dataItemRootTxIndex.getRootTxId as any).mock.mockImplementationOnce(
        async () => rootTxId,
      );

      (ans104OffsetSource.getDataItemOffset as any).mock.mockImplementationOnce(
        async () => ({ offset: 1000, size: 500 }),
      );

      // Request a region within the data item
      const requestedRegion = { offset: 100, size: 200 };

      (dataSource.getData as any).mock.mockImplementationOnce(async () => ({
        stream: dataStream,
        size: 200,
        verified: false,
        trusted: false,
        cached: true,
      }));

      const result = await rootParentDataSource.getData({
        id: dataItemId,
        region: requestedRegion,
      });

      assert.strictEqual(result.size, 200);
      assert.strictEqual(result.cached, true);

      // Verify the region was calculated correctly
      const dataSourceCall = (dataSource.getData as any).mock.calls[0]
        .arguments[0];
      assert.strictEqual(dataSourceCall.region.offset, 1100); // 1000 + 100
      assert.strictEqual(dataSourceCall.region.size, 200);
    });

    it('should truncate region if it exceeds data item bounds', async () => {
      const dataItemId = 'test-data-item-id';
      const rootTxId = 'root-tx-id';
      const dataStream = Readable.from([Buffer.from('truncated')]);

      (dataItemRootTxIndex.getRootTxId as any).mock.mockImplementationOnce(
        async () => rootTxId,
      );

      (ans104OffsetSource.getDataItemOffset as any).mock.mockImplementationOnce(
        async () => ({ offset: 1000, size: 500 }),
      );

      // Request a region that extends beyond the data item
      const requestedRegion = { offset: 400, size: 200 }; // Would end at 600, but item is only 500

      (dataSource.getData as any).mock.mockImplementationOnce(async () => ({
        stream: dataStream,
        size: 100,
        verified: false,
        trusted: false,
        cached: false,
      }));

      const result = await rootParentDataSource.getData({
        id: dataItemId,
        region: requestedRegion,
      });

      assert.strictEqual(result.size, 100);

      // Verify truncation happened
      const dataSourceCall = (dataSource.getData as any).mock.calls[0]
        .arguments[0];
      assert.strictEqual(dataSourceCall.region.offset, 1400);
      assert.strictEqual(dataSourceCall.region.size, 100); // Truncated to fit
    });

    it('should pass through to underlying source when not a data item', async () => {
      const txId = 'regular-tx-id';
      const dataStream = Readable.from([Buffer.from('tx data')]);

      (dataItemRootTxIndex.getRootTxId as any).mock.mockImplementationOnce(
        async () => undefined,
      );

      (dataSource.getData as any).mock.mockImplementationOnce(async () => ({
        stream: dataStream,
        size: 100,
        verified: true,
        trusted: false,
        cached: false,
      }));

      const result = await rootParentDataSource.getData({ id: txId });

      assert.strictEqual(result.size, 100);
      assert.strictEqual(result.verified, true);
      assert.strictEqual(result.stream, dataStream);

      // Should have called getRootTxId
      assert.strictEqual(
        (dataItemRootTxIndex.getRootTxId as any).mock.calls.length,
        1,
      );
      assert.strictEqual(
        (dataItemRootTxIndex.getRootTxId as any).mock.calls[0].arguments[0],
        txId,
      );

      // Should NOT have called getDataItemOffset
      assert.strictEqual(
        (ans104OffsetSource.getDataItemOffset as any).mock.calls.length,
        0,
      );

      // Should have called getData on underlying source
      assert.strictEqual((dataSource.getData as any).mock.calls.length, 1);
      assert.strictEqual(
        (dataSource.getData as any).mock.calls[0].arguments[0].id,
        txId,
      );
    });

    it('should pass through to underlying source when ID equals root ID', async () => {
      const txId = 'root-bundle-tx-id';
      const dataStream = Readable.from([Buffer.from('bundle data')]);

      // When getRootTxId returns the same ID, it means it's already a root transaction
      (dataItemRootTxIndex.getRootTxId as any).mock.mockImplementationOnce(
        async () => txId,
      );

      (dataSource.getData as any).mock.mockImplementationOnce(async () => ({
        stream: dataStream,
        size: 500,
        verified: true,
        trusted: true,
        cached: false,
      }));

      const result = await rootParentDataSource.getData({ id: txId });

      assert.strictEqual(result.size, 500);
      assert.strictEqual(result.verified, true);
      assert.strictEqual(result.stream, dataStream);

      // Should have called getRootTxId
      assert.strictEqual(
        (dataItemRootTxIndex.getRootTxId as any).mock.calls.length,
        1,
      );

      // Should NOT have called getDataItemOffset since it's already root
      assert.strictEqual(
        (ans104OffsetSource.getDataItemOffset as any).mock.calls.length,
        0,
      );

      // Should have called getData on underlying source
      assert.strictEqual((dataSource.getData as any).mock.calls.length, 1);
      assert.strictEqual(
        (dataSource.getData as any).mock.calls[0].arguments[0].id,
        txId,
      );
    });

    it('should throw error when data item not found in bundle', async () => {
      const dataItemId = 'missing-item-id';
      const rootTxId = 'root-tx-id';

      (dataItemRootTxIndex.getRootTxId as any).mock.mockImplementationOnce(
        async () => rootTxId,
      );

      (ans104OffsetSource.getDataItemOffset as any).mock.mockImplementationOnce(
        async () => null,
      );

      await assert.rejects(
        async () => {
          await rootParentDataSource.getData({ id: dataItemId });
        },
        {
          message: `Data item ${dataItemId} not found in root bundle ${rootTxId}`,
        },
      );

      assert.strictEqual(
        (dataItemRootTxIndex.getRootTxId as any).mock.calls.length,
        1,
      );
      assert.strictEqual(
        (ans104OffsetSource.getDataItemOffset as any).mock.calls.length,
        1,
      );
      assert.strictEqual((dataSource.getData as any).mock.calls.length, 0);
    });

    it('should throw error when requested region offset exceeds data item size', async () => {
      const dataItemId = 'test-data-item-id';
      const rootTxId = 'root-tx-id';

      (dataItemRootTxIndex.getRootTxId as any).mock.mockImplementationOnce(
        async () => rootTxId,
      );

      (ans104OffsetSource.getDataItemOffset as any).mock.mockImplementationOnce(
        async () => ({ offset: 1000, size: 500 }),
      );

      // Request a region that starts beyond the data item
      const requestedRegion = { offset: 600, size: 100 };

      await assert.rejects(
        async () => {
          await rootParentDataSource.getData({
            id: dataItemId,
            region: requestedRegion,
          });
        },
        {
          message: `Requested region offset 600 exceeds data item size 500`,
        },
      );

      assert.strictEqual(
        (dataItemRootTxIndex.getRootTxId as any).mock.calls.length,
        1,
      );
      assert.strictEqual(
        (ans104OffsetSource.getDataItemOffset as any).mock.calls.length,
        1,
      );
      assert.strictEqual((dataSource.getData as any).mock.calls.length, 0);
    });

    it('should propagate errors from data source', async () => {
      const dataItemId = 'test-data-item-id';
      const rootTxId = 'root-tx-id';
      const fetchError = new Error('Failed to fetch data');

      (dataItemRootTxIndex.getRootTxId as any).mock.mockImplementationOnce(
        async () => rootTxId,
      );

      (ans104OffsetSource.getDataItemOffset as any).mock.mockImplementationOnce(
        async () => ({ offset: 1000, size: 500 }),
      );

      (dataSource.getData as any).mock.mockImplementationOnce(async () => {
        throw fetchError;
      });

      await assert.rejects(async () => {
        await rootParentDataSource.getData({ id: dataItemId });
      }, fetchError);

      assert.strictEqual(
        (dataItemRootTxIndex.getRootTxId as any).mock.calls.length,
        1,
      );
      assert.strictEqual(
        (ans104OffsetSource.getDataItemOffset as any).mock.calls.length,
        1,
      );
      assert.strictEqual((dataSource.getData as any).mock.calls.length, 1);
    });

    it('should pass through dataAttributes and requestAttributes', async () => {
      const dataItemId = 'test-data-item-id';
      const rootTxId = 'root-tx-id';
      const dataStream = Readable.from([Buffer.from('test data')]);

      const dataAttributes = {
        hash: 'test-hash',
        dataRoot: 'test-root',
        size: 500,
        offset: 0,
      };

      const requestAttributes = {
        arnsName: 'test-name',
        arnsBasename: 'test-basename',
      };

      (dataItemRootTxIndex.getRootTxId as any).mock.mockImplementationOnce(
        async () => rootTxId,
      );

      (ans104OffsetSource.getDataItemOffset as any).mock.mockImplementationOnce(
        async () => ({ offset: 1000, size: 500 }),
      );

      (dataSource.getData as any).mock.mockImplementationOnce(async () => ({
        stream: dataStream,
        size: 500,
        verified: false,
        trusted: false,
        cached: false,
      }));

      await rootParentDataSource.getData({
        id: dataItemId,
        dataAttributes,
        requestAttributes,
      });

      // Verify attributes were passed through
      const dataSourceCall = (dataSource.getData as any).mock.calls[0]
        .arguments[0];
      assert.deepStrictEqual(dataSourceCall.dataAttributes, dataAttributes);
      assert.deepStrictEqual(
        dataSourceCall.requestAttributes,
        requestAttributes,
      );
    });
  });
});
