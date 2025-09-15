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
import {
  ContiguousDataSource,
  ContiguousDataAttributesStore,
  DataItemRootTxIndex,
} from '../types.js';

describe('RootParentDataSource', () => {
  let log: winston.Logger;
  let dataSource: ContiguousDataSource;
  let dataAttributesSource: ContiguousDataAttributesStore;
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
    dataAttributesSource = {
      getDataAttributes: mock.fn(),
      setDataAttributes: mock.fn(),
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
      dataAttributesSource,
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

      // Mock attributes to return null (fallback to legacy)
      (dataAttributesSource.getDataAttributes as any).mock.mockImplementation(
        async () => null,
      );

      // Mock root TX lookup
      (dataItemRootTxIndex.getRootTxId as any).mock.mockImplementation(
        async () => rootTxId,
      );

      // Mock offset parsing
      (ans104OffsetSource.getDataItemOffset as any).mock.mockImplementation(
        async () => ({ offset: 1000, size: 500 }),
      );

      // Mock data fetch
      (dataSource.getData as any).mock.mockImplementation(async () => ({
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

      // Mock attributes to return null (fallback to legacy)
      (dataAttributesSource.getDataAttributes as any).mock.mockImplementation(
        async () => null,
      );

      (dataItemRootTxIndex.getRootTxId as any).mock.mockImplementation(
        async () => rootTxId,
      );

      (ans104OffsetSource.getDataItemOffset as any).mock.mockImplementation(
        async () => ({ offset: 1000, size: 500 }),
      );

      // Request a region within the data item
      const requestedRegion = { offset: 100, size: 200 };

      (dataSource.getData as any).mock.mockImplementation(async () => ({
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

      // Mock attributes to return null (fallback to legacy)
      (dataAttributesSource.getDataAttributes as any).mock.mockImplementation(
        async () => null,
      );

      (dataItemRootTxIndex.getRootTxId as any).mock.mockImplementation(
        async () => rootTxId,
      );

      (ans104OffsetSource.getDataItemOffset as any).mock.mockImplementation(
        async () => ({ offset: 1000, size: 500 }),
      );

      // Request a region that extends beyond the data item
      const requestedRegion = { offset: 400, size: 200 }; // Would end at 600, but item is only 500

      (dataSource.getData as any).mock.mockImplementation(async () => ({
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

      // Mock attributes to return null (fallback to legacy)
      (dataAttributesSource.getDataAttributes as any).mock.mockImplementation(
        async () => null,
      );

      (dataItemRootTxIndex.getRootTxId as any).mock.mockImplementation(
        async () => undefined,
      );

      (dataSource.getData as any).mock.mockImplementation(async () => ({
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

      // Mock attributes to return null (fallback to legacy)
      (dataAttributesSource.getDataAttributes as any).mock.mockImplementation(
        async () => null,
      );

      // When getRootTxId returns the same ID, it means it's already a root transaction
      (dataItemRootTxIndex.getRootTxId as any).mock.mockImplementation(
        async () => txId,
      );

      (dataSource.getData as any).mock.mockImplementation(async () => ({
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

      // Mock attributes to return null (fallback to legacy)
      (dataAttributesSource.getDataAttributes as any).mock.mockImplementation(
        async () => null,
      );

      (dataItemRootTxIndex.getRootTxId as any).mock.mockImplementation(
        async () => rootTxId,
      );

      (ans104OffsetSource.getDataItemOffset as any).mock.mockImplementation(
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

      // Mock attributes to return null (fallback to legacy)
      (dataAttributesSource.getDataAttributes as any).mock.mockImplementation(
        async () => null,
      );

      (dataItemRootTxIndex.getRootTxId as any).mock.mockImplementation(
        async () => rootTxId,
      );

      (ans104OffsetSource.getDataItemOffset as any).mock.mockImplementation(
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

      // Mock attributes to return null (fallback to legacy)
      (dataAttributesSource.getDataAttributes as any).mock.mockImplementation(
        async () => null,
      );

      (dataItemRootTxIndex.getRootTxId as any).mock.mockImplementation(
        async () => rootTxId,
      );

      (ans104OffsetSource.getDataItemOffset as any).mock.mockImplementation(
        async () => ({ offset: 1000, size: 500 }),
      );

      (dataSource.getData as any).mock.mockImplementation(async () => {
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

    it('should pass through requestAttributes to underlying data source', async () => {
      const dataItemId = 'test-data-item-id';
      const rootTxId = 'root-tx-id';
      const dataStream = Readable.from([Buffer.from('test data')]);

      const requestAttributes = {
        arnsName: 'test-name',
        arnsBasename: 'test-basename',
      };

      // Mock attributes to return null (fallback to legacy)
      (dataAttributesSource.getDataAttributes as any).mock.mockImplementation(
        async () => null,
      );

      (dataItemRootTxIndex.getRootTxId as any).mock.mockImplementation(
        async () => rootTxId,
      );

      (ans104OffsetSource.getDataItemOffset as any).mock.mockImplementation(
        async () => ({ offset: 1000, size: 500 }),
      );

      (dataSource.getData as any).mock.mockImplementation(async () => ({
        stream: dataStream,
        size: 500,
        verified: false,
        trusted: false,
        cached: false,
      }));

      await rootParentDataSource.getData({
        id: dataItemId,
        requestAttributes,
      });

      // Verify requestAttributes were passed through (but not dataAttributes, as they are now handled internally)
      const dataSourceCall = (dataSource.getData as any).mock.calls[0]
        .arguments[0];
      assert.deepStrictEqual(
        dataSourceCall.requestAttributes,
        requestAttributes,
      );
      // dataAttributes should not be passed since they are now handled by DataAttributesSource
      assert.strictEqual(dataSourceCall.dataAttributes, undefined);
    });
  });

  describe('attributes-based traversal', () => {
    it('should successfully traverse single-level parent chain', async () => {
      const dataItemId = 'child-item';
      const parentId = 'parent-item';
      const dataStream = Readable.from([Buffer.from('test data')]);

      // Mock attributes for child (has parent)
      (dataAttributesSource.getDataAttributes as any).mock.mockImplementation(
        async (id: string) => {
          if (id === dataItemId) {
            return {
              size: 500,
              offset: 100,
              parentId: parentId,
            };
          }
          if (id === parentId) {
            return {
              size: 2000,
              offset: 0,
              // No parentId = root
            };
          }
          return null;
        },
      );

      // Mock data fetch from parent
      (dataSource.getData as any).mock.mockImplementation(async () => ({
        stream: dataStream,
        size: 500,
        verified: true,
        trusted: true,
        cached: false,
      }));

      const result = await rootParentDataSource.getData({ id: dataItemId });

      assert.strictEqual(result.size, 500);
      assert.strictEqual(result.stream, dataStream);

      // Verify we called getDataAttributes for the original item + both items during traversal
      assert.strictEqual(
        (dataAttributesSource.getDataAttributes as any).mock.calls.length,
        3,
      );
      assert.strictEqual(
        (dataAttributesSource.getDataAttributes as any).mock.calls[0]
          .arguments[0],
        dataItemId,
      );
      assert.strictEqual(
        (dataAttributesSource.getDataAttributes as any).mock.calls[1]
          .arguments[0],
        dataItemId,
      );
      assert.strictEqual(
        (dataAttributesSource.getDataAttributes as any).mock.calls[2]
          .arguments[0],
        parentId,
      );

      // Verify data was fetched from parent with correct offset
      const dataCall = (dataSource.getData as any).mock.calls[0].arguments[0];
      assert.strictEqual(dataCall.id, parentId);
      assert.strictEqual(dataCall.region.offset, 100); // child's offset in parent
      assert.strictEqual(dataCall.region.size, 500); // child's size

      // Should not use legacy methods
      assert.strictEqual(
        (dataItemRootTxIndex.getRootTxId as any).mock.calls.length,
        0,
      );
      assert.strictEqual(
        (ans104OffsetSource.getDataItemOffset as any).mock.calls.length,
        0,
      );
    });

    it('should traverse multi-level parent chain', async () => {
      const dataItemId = 'grandchild';
      const childId = 'child';
      const parentId = 'parent';
      const dataStream = Readable.from([Buffer.from('nested data')]);

      // Mock attributes for three-level chain
      (dataAttributesSource.getDataAttributes as any).mock.mockImplementation(
        async (id: string) => {
          if (id === dataItemId) {
            return {
              size: 200,
              offset: 50, // offset in child
              parentId: childId,
            };
          }
          if (id === childId) {
            return {
              size: 800,
              offset: 300, // offset in parent
              parentId: parentId,
              dataOffset: 20, // payload start
            };
          }
          if (id === parentId) {
            return {
              size: 5000,
              offset: 0,
              // No parentId = root
            };
          }
          return null;
        },
      );

      (dataSource.getData as any).mock.mockImplementation(async () => ({
        stream: dataStream,
        size: 200,
        verified: false,
        trusted: true,
        cached: true,
      }));

      const result = await rootParentDataSource.getData({ id: dataItemId });

      assert.strictEqual(result.size, 200);

      // Verify total offset calculation: 50 (grandchild in child) + 300 (child in parent) + 20 (dataOffset) = 370
      const dataCall = (dataSource.getData as any).mock.calls[0].arguments[0];
      assert.strictEqual(dataCall.id, parentId);
      assert.strictEqual(dataCall.region.offset, 370);
      assert.strictEqual(dataCall.region.size, 200);

      // Should not use legacy methods
      assert.strictEqual(
        (dataItemRootTxIndex.getRootTxId as any).mock.calls.length,
        0,
      );
    });

    it('should handle self-referential root (parentId equals current id)', async () => {
      const rootId = 'root-transaction';
      const dataStream = Readable.from([Buffer.from('root data')]);

      // Mock attributes for root that references itself
      (dataAttributesSource.getDataAttributes as any).mock.mockImplementation(
        async (id: string) => {
          if (id === rootId) {
            return {
              size: 1000,
              offset: 0,
              parentId: rootId, // Self-referential
            };
          }
          return null;
        },
      );

      (dataSource.getData as any).mock.mockImplementation(async () => ({
        stream: dataStream,
        size: 1000,
        verified: true,
        trusted: false,
        cached: false,
      }));

      const result = await rootParentDataSource.getData({ id: rootId });

      assert.strictEqual(result.size, 1000);

      // Should fetch data with offset 0
      const dataCall = (dataSource.getData as any).mock.calls[0].arguments[0];
      assert.strictEqual(dataCall.id, rootId);
      assert.strictEqual(dataCall.region.offset, 0);
    });

    it('should detect cycles in parent chain', async () => {
      const itemA = 'item-a';
      const itemB = 'item-b';

      // Create circular reference: A -> B -> A
      (dataAttributesSource.getDataAttributes as any).mock.mockImplementation(
        async (id: string) => {
          if (id === itemA) {
            return {
              size: 500,
              offset: 100,
              parentId: itemB,
            };
          }
          if (id === itemB) {
            return {
              size: 800,
              offset: 200,
              parentId: itemA, // Cycle!
            };
          }
          return null;
        },
      );

      // Should fallback to legacy when cycle detected
      (dataItemRootTxIndex.getRootTxId as any).mock.mockImplementation(
        async () => 'fallback-root',
      );
      (ans104OffsetSource.getDataItemOffset as any).mock.mockImplementation(
        async () => ({ offset: 1000, size: 500 }),
      );
      (dataSource.getData as any).mock.mockImplementation(async () => ({
        stream: Readable.from([Buffer.from('fallback data')]),
        size: 500,
        verified: true,
        trusted: true,
        cached: false,
      }));

      const result = await rootParentDataSource.getData({ id: itemA });

      // Should succeed using fallback
      assert.strictEqual(result.size, 500);

      // Should have attempted attributes lookup (once at start + once for each item in cycle)
      assert.strictEqual(
        (dataAttributesSource.getDataAttributes as any).mock.calls.length,
        3,
      );

      // Should have fallen back to legacy methods
      assert.strictEqual(
        (dataItemRootTxIndex.getRootTxId as any).mock.calls.length,
        1,
      );
      assert.strictEqual(
        (ans104OffsetSource.getDataItemOffset as any).mock.calls.length,
        1,
      );
    });

    it('should fallback to legacy when attributes missing', async () => {
      const dataItemId = 'test-item';
      const rootTxId = 'root-tx-id';
      const dataStream = Readable.from([Buffer.from('fallback data')]);

      // Mock missing attributes
      (dataAttributesSource.getDataAttributes as any).mock.mockImplementation(
        async () => null,
      );

      // Mock legacy methods
      (dataItemRootTxIndex.getRootTxId as any).mock.mockImplementation(
        async () => rootTxId,
      );
      (ans104OffsetSource.getDataItemOffset as any).mock.mockImplementation(
        async () => ({ offset: 2000, size: 800 }),
      );
      (dataSource.getData as any).mock.mockImplementation(async () => ({
        stream: dataStream,
        size: 800,
        verified: false,
        trusted: true,
        cached: false,
      }));

      const result = await rootParentDataSource.getData({ id: dataItemId });

      assert.strictEqual(result.size, 800);
      assert.strictEqual(result.stream, dataStream);

      // Should have tried attributes (once at start + once during traversal attempt)
      assert.strictEqual(
        (dataAttributesSource.getDataAttributes as any).mock.calls.length,
        2,
      );

      // Should have fallen back to legacy
      assert.strictEqual(
        (dataItemRootTxIndex.getRootTxId as any).mock.calls.length,
        1,
      );
      assert.strictEqual(
        (ans104OffsetSource.getDataItemOffset as any).mock.calls.length,
        1,
      );
    });

    it('should throw error when fallback disabled and attributes incomplete', async () => {
      const dataItemId = 'test-item';

      // Create instance with fallback disabled
      const noFallbackSource = new RootParentDataSource({
        log,
        dataSource,
        dataAttributesSource,
        dataItemRootTxIndex,
        ans104OffsetSource,
        fallbackToLegacyTraversal: false,
      });

      // Mock missing attributes
      (dataAttributesSource.getDataAttributes as any).mock.mockImplementation(
        async () => null,
      );

      // Should throw error
      await assert.rejects(
        async () => noFallbackSource.getData({ id: dataItemId }),
        /Unable to traverse parent chain.*attributes incomplete and fallback disabled/,
      );

      // Should have tried attributes (once at start + once during traversal attempt)
      assert.strictEqual(
        (dataAttributesSource.getDataAttributes as any).mock.calls.length,
        2,
      );

      // Should NOT have tried legacy methods
      assert.strictEqual(
        (dataItemRootTxIndex.getRootTxId as any).mock.calls.length,
        0,
      );
      assert.strictEqual(
        (ans104OffsetSource.getDataItemOffset as any).mock.calls.length,
        0,
      );
    });

    it('should handle requested regions with attributes traversal', async () => {
      const dataItemId = 'child-item';
      const parentId = 'parent-item';
      const dataStream = Readable.from([Buffer.from('partial data')]);

      // Mock attributes
      (dataAttributesSource.getDataAttributes as any).mock.mockImplementation(
        async (id: string) => {
          if (id === dataItemId) {
            return {
              size: 500,
              offset: 100, // child offset in parent
              parentId: parentId,
            };
          }
          if (id === parentId) {
            return {
              size: 2000,
              offset: 0,
              // root
            };
          }
          return null;
        },
      );

      (dataSource.getData as any).mock.mockImplementation(async () => ({
        stream: dataStream,
        size: 200, // requested region size
        verified: true,
        trusted: false,
        cached: true,
      }));

      // Request region within the data item: offset 50, size 200
      const result = await rootParentDataSource.getData({
        id: dataItemId,
        region: { offset: 50, size: 200 },
      });

      assert.strictEqual(result.size, 200);

      // Should request data from parent with combined offset: 100 (child offset) + 50 (region offset) = 150
      const dataCall = (dataSource.getData as any).mock.calls[0].arguments[0];
      assert.strictEqual(dataCall.id, parentId);
      assert.strictEqual(dataCall.region.offset, 150);
      assert.strictEqual(dataCall.region.size, 200);
    });
  });
});
