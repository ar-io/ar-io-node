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
  DataItemRootIndex,
} from '../types.js';

describe('RootParentDataSource', () => {
  let log: winston.Logger;
  let dataSource: ContiguousDataSource;
  let dataAttributesStore: ContiguousDataAttributesStore;
  let dataItemRootTxIndex: DataItemRootIndex;
  let ans104OffsetSource: Ans104OffsetSource;
  let rootParentDataSource: RootParentDataSource;

  beforeEach(() => {
    log = winston.createLogger({
      silent: true,
    });
    dataSource = {
      getData: mock.fn(),
    };
    dataAttributesStore = {
      getDataAttributes: mock.fn(),
      setDataAttributes: mock.fn(),
    };
    dataItemRootTxIndex = {
      getRootTx: mock.fn(),
    };
    ans104OffsetSource = {
      getDataItemOffset: mock.fn(),
    } as any;
    rootParentDataSource = new RootParentDataSource({
      log,
      dataSource,
      dataAttributesStore: dataAttributesStore,
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
      (dataAttributesStore.getDataAttributes as any).mock.mockImplementation(
        async () => null,
      );

      // Mock root TX lookup
      (dataItemRootTxIndex.getRootTx as any).mock.mockImplementation(
        async () => ({ rootTxId }),
      );

      // Mock offset parsing
      (ans104OffsetSource.getDataItemOffset as any).mock.mockImplementation(
        async () => ({
          itemOffset: 900,
          dataOffset: 1000,
          itemSize: 600,
          dataSize: 500,
          contentType: 'text/plain',
        }),
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
        (dataItemRootTxIndex.getRootTx as any).mock.calls.length,
        1,
      );
      assert.strictEqual(
        (dataItemRootTxIndex.getRootTx as any).mock.calls[0].arguments[0],
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
      (dataAttributesStore.getDataAttributes as any).mock.mockImplementation(
        async () => null,
      );

      (dataItemRootTxIndex.getRootTx as any).mock.mockImplementation(
        async () => ({ rootTxId }),
      );

      (ans104OffsetSource.getDataItemOffset as any).mock.mockImplementation(
        async () => ({
          itemOffset: 900,
          dataOffset: 1000,
          itemSize: 600,
          dataSize: 500,
          contentType: 'text/plain',
        }),
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
      (dataAttributesStore.getDataAttributes as any).mock.mockImplementation(
        async () => null,
      );

      (dataItemRootTxIndex.getRootTx as any).mock.mockImplementation(
        async () => ({ rootTxId }),
      );

      (ans104OffsetSource.getDataItemOffset as any).mock.mockImplementation(
        async () => ({
          itemOffset: 900,
          dataOffset: 1000,
          itemSize: 600,
          dataSize: 500,
          contentType: 'text/plain',
        }),
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
      (dataAttributesStore.getDataAttributes as any).mock.mockImplementation(
        async () => null,
      );

      (dataItemRootTxIndex.getRootTx as any).mock.mockImplementation(
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

      // Should have called getRootTx
      assert.strictEqual(
        (dataItemRootTxIndex.getRootTx as any).mock.calls.length,
        1,
      );
      assert.strictEqual(
        (dataItemRootTxIndex.getRootTx as any).mock.calls[0].arguments[0],
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
      (dataAttributesStore.getDataAttributes as any).mock.mockImplementation(
        async () => null,
      );

      // When getRootTx returns the same ID, it means it's already a root transaction
      (dataItemRootTxIndex.getRootTx as any).mock.mockImplementation(
        async () => ({ rootTxId: txId }),
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

      // Should have called getRootTx
      assert.strictEqual(
        (dataItemRootTxIndex.getRootTx as any).mock.calls.length,
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
      (dataAttributesStore.getDataAttributes as any).mock.mockImplementation(
        async () => null,
      );

      (dataItemRootTxIndex.getRootTx as any).mock.mockImplementation(
        async () => ({ rootTxId }),
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
        (dataItemRootTxIndex.getRootTx as any).mock.calls.length,
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
      (dataAttributesStore.getDataAttributes as any).mock.mockImplementation(
        async () => null,
      );

      (dataItemRootTxIndex.getRootTx as any).mock.mockImplementation(
        async () => ({ rootTxId }),
      );

      (ans104OffsetSource.getDataItemOffset as any).mock.mockImplementation(
        async () => ({
          itemOffset: 900,
          dataOffset: 1000,
          itemSize: 600,
          dataSize: 500,
          contentType: 'text/plain',
        }),
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
        (dataItemRootTxIndex.getRootTx as any).mock.calls.length,
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
      (dataAttributesStore.getDataAttributes as any).mock.mockImplementation(
        async () => null,
      );

      (dataItemRootTxIndex.getRootTx as any).mock.mockImplementation(
        async () => ({ rootTxId }),
      );

      (ans104OffsetSource.getDataItemOffset as any).mock.mockImplementation(
        async () => ({
          itemOffset: 900,
          dataOffset: 1000,
          itemSize: 600,
          dataSize: 500,
          contentType: 'text/plain',
        }),
      );

      (dataSource.getData as any).mock.mockImplementation(async () => {
        throw fetchError;
      });

      await assert.rejects(async () => {
        await rootParentDataSource.getData({ id: dataItemId });
      }, fetchError);

      assert.strictEqual(
        (dataItemRootTxIndex.getRootTx as any).mock.calls.length,
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
      (dataAttributesStore.getDataAttributes as any).mock.mockImplementation(
        async () => null,
      );

      (dataItemRootTxIndex.getRootTx as any).mock.mockImplementation(
        async () => ({ rootTxId }),
      );

      (ans104OffsetSource.getDataItemOffset as any).mock.mockImplementation(
        async () => ({
          itemOffset: 900,
          dataOffset: 1000,
          itemSize: 600,
          dataSize: 500,
          contentType: 'text/plain',
        }),
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
      (dataAttributesStore.getDataAttributes as any).mock.mockImplementation(
        async (id: string) => {
          if (id === dataItemId) {
            return {
              size: 500,
              offset: 100,
              dataOffset: 150, // offset + header size (assume 50 byte header)
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
        (dataAttributesStore.getDataAttributes as any).mock.calls.length,
        3,
      );
      assert.strictEqual(
        (dataAttributesStore.getDataAttributes as any).mock.calls[0]
          .arguments[0],
        dataItemId,
      );
      assert.strictEqual(
        (dataAttributesStore.getDataAttributes as any).mock.calls[1]
          .arguments[0],
        dataItemId,
      );
      assert.strictEqual(
        (dataAttributesStore.getDataAttributes as any).mock.calls[2]
          .arguments[0],
        parentId,
      );

      // Verify data was fetched from parent with correct offset
      const dataCall = (dataSource.getData as any).mock.calls[0].arguments[0];
      assert.strictEqual(dataCall.id, parentId);
      assert.strictEqual(dataCall.region.offset, 150); // child's dataOffset (payload start)
      assert.strictEqual(dataCall.region.size, 500); // child's size

      // Should not use legacy methods
      assert.strictEqual(
        (dataItemRootTxIndex.getRootTx as any).mock.calls.length,
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
      (dataAttributesStore.getDataAttributes as any).mock.mockImplementation(
        async (id: string) => {
          if (id === dataItemId) {
            return {
              size: 200,
              offset: 50, // offset in child
              dataOffset: 50, // payload start (absolute: 50 + 0, no header for contiguous data)
              parentId: childId,
            };
          }
          if (id === childId) {
            return {
              size: 800,
              offset: 300, // offset in parent
              parentId: parentId,
              dataOffset: 320, // payload start (absolute: 300 + 20)
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

      // Verify: child payload at 320 in parent, grandchild payload at 50 in child = 320 + 50 = 370
      const dataCall = (dataSource.getData as any).mock.calls[0].arguments[0];
      assert.strictEqual(dataCall.id, parentId);
      assert.strictEqual(dataCall.region.offset, 370);
      assert.strictEqual(dataCall.region.size, 200);

      // Should not use legacy methods
      assert.strictEqual(
        (dataItemRootTxIndex.getRootTx as any).mock.calls.length,
        0,
      );
    });

    it('should handle self-referential root (parentId equals current id)', async () => {
      const rootId = 'root-transaction';
      const dataStream = Readable.from([Buffer.from('root data')]);

      // Mock attributes for root that references itself
      (dataAttributesStore.getDataAttributes as any).mock.mockImplementation(
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

      // Should pass through to underlying data source without region
      const dataCall = (dataSource.getData as any).mock.calls[0].arguments[0];
      assert.strictEqual(dataCall.id, rootId);
      assert.strictEqual(dataCall.region, undefined);
    });

    it('should use pre-computed root offsets when available', async () => {
      const dataItemId = 'test-item';
      const rootTxId = 'root-bundle-id';
      const dataStream = Readable.from([Buffer.from('test data')]);

      // Mock attributes with pre-computed root offsets
      (dataAttributesStore.getDataAttributes as any).mock.mockImplementation(
        async (id: string) => {
          if (id === dataItemId) {
            return {
              size: 500,
              offset: 100,
              parentId: 'parent-id',
              contentType: 'text/plain',
              // Pre-computed absolute offsets
              rootTransactionId: rootTxId,
              rootDataItemOffset: 1234,
              rootDataOffset: 1334,
            };
          }
          return null;
        },
      );

      (dataSource.getData as any).mock.mockImplementation(async () => ({
        stream: dataStream,
        size: 500,
        verified: true,
        trusted: false,
        cached: false,
      }));

      const result = await rootParentDataSource.getData({ id: dataItemId });

      assert.strictEqual(result.size, 500);
      assert.strictEqual(result.stream, dataStream);

      // Should have called getDataAttributes twice:
      // 1. getData for content type
      // 2. traverseToRootUsingAttributes early check (finds pre-computed offsets)
      assert.strictEqual(
        (dataAttributesStore.getDataAttributes as any).mock.calls.length,
        2,
      );

      // Should NOT have traversed parents (optimization worked!)
      // Only the initial attributes fetch, no parent chain traversal

      // Should have fetched from root using pre-computed offsets
      const dataCall = (dataSource.getData as any).mock.calls[0].arguments[0];
      assert.strictEqual(dataCall.id, rootTxId);
      assert.deepStrictEqual(dataCall.region, {
        offset: 1334, // rootDataOffset (where payload starts, skipping headers)
        size: 500, // payload size
      });
    });

    it('should detect cycles in parent chain', async () => {
      const itemA = 'item-a';
      const itemB = 'item-b';

      // Create circular reference: A -> B -> A
      (dataAttributesStore.getDataAttributes as any).mock.mockImplementation(
        async (id: string) => {
          if (id === itemA) {
            return {
              size: 500,
              offset: 100,
              dataOffset: 150, // offset + header size
              parentId: itemB,
            };
          }
          if (id === itemB) {
            return {
              size: 800,
              offset: 200,
              dataOffset: 250, // offset + header size
              parentId: itemA, // Cycle!
            };
          }
          return null;
        },
      );

      // Should fallback to legacy when cycle detected
      (dataItemRootTxIndex.getRootTx as any).mock.mockImplementation(
        async () => ({ rootTxId: 'fallback-root' }),
      );
      (ans104OffsetSource.getDataItemOffset as any).mock.mockImplementation(
        async () => ({
          itemOffset: 900,
          dataOffset: 1000,
          itemSize: 600,
          dataSize: 500,
          contentType: 'text/plain',
        }),
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

      // Should have attempted attributes lookup:
      // 1. getData for content type
      // 2. traverseToRootUsingAttributes initial check
      // 3. Traverse to itemB
      // 4. Traverse back to itemA (cycle detected on next iteration)
      assert.strictEqual(
        (dataAttributesStore.getDataAttributes as any).mock.calls.length,
        4,
      );

      // Should have fallen back to legacy methods
      assert.strictEqual(
        (dataItemRootTxIndex.getRootTx as any).mock.calls.length,
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
      (dataAttributesStore.getDataAttributes as any).mock.mockImplementation(
        async () => null,
      );

      // Mock legacy methods
      (dataItemRootTxIndex.getRootTx as any).mock.mockImplementation(
        async () => ({ rootTxId }),
      );
      (ans104OffsetSource.getDataItemOffset as any).mock.mockImplementation(
        async () => ({
          itemOffset: 1900,
          dataOffset: 2000,
          itemSize: 900,
          dataSize: 800,
        }),
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
        (dataAttributesStore.getDataAttributes as any).mock.calls.length,
        2,
      );

      // Should have fallen back to legacy
      assert.strictEqual(
        (dataItemRootTxIndex.getRootTx as any).mock.calls.length,
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
        dataAttributesStore: dataAttributesStore,
        dataItemRootTxIndex,
        ans104OffsetSource,
        fallbackToLegacyTraversal: false,
      });

      // Mock missing attributes
      (dataAttributesStore.getDataAttributes as any).mock.mockImplementation(
        async () => null,
      );

      // Should throw error
      await assert.rejects(
        async () => noFallbackSource.getData({ id: dataItemId }),
        /Unable to traverse parent chain.*attributes incomplete and fallback disabled/,
      );

      // Should have tried attributes (once at start + once during traversal attempt)
      assert.strictEqual(
        (dataAttributesStore.getDataAttributes as any).mock.calls.length,
        2,
      );

      // Should NOT have tried legacy methods
      assert.strictEqual(
        (dataItemRootTxIndex.getRootTx as any).mock.calls.length,
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
      (dataAttributesStore.getDataAttributes as any).mock.mockImplementation(
        async (id: string) => {
          if (id === dataItemId) {
            return {
              size: 500,
              offset: 100, // child offset in parent
              dataOffset: 150, // payload start (offset + header size)
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

      // Should request data from parent with combined offset: 150 (child dataOffset) + 50 (region offset) = 200
      const dataCall = (dataSource.getData as any).mock.calls[0].arguments[0];
      assert.strictEqual(dataCall.id, parentId);
      assert.strictEqual(dataCall.region.offset, 200);
      assert.strictEqual(dataCall.region.size, 200);
    });

    it('should correctly handle dataOffset for target item (not double-count)', async () => {
      const dataItemId = 'child-item';
      const parentId = 'parent-item';
      const dataStream = Readable.from([Buffer.from('test data')]);

      // Mock attributes where TARGET item has a dataOffset
      (dataAttributesStore.getDataAttributes as any).mock.mockImplementation(
        async (id: string) => {
          if (id === dataItemId) {
            return {
              size: 500, // payload size
              offset: 100, // item offset in parent
              dataOffset: 150, // payload position in parent (absolute: 100 + 50)
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
        size: 500,
        verified: true,
        trusted: true,
        cached: false,
      }));

      const result = await rootParentDataSource.getData({ id: dataItemId });

      assert.strictEqual(result.size, 500);

      // Critical test: dataOffset should only be added ONCE (not during traversal AND at end)
      // Correct: target's dataOffset is 150 (absolute), added once at end = 0 + 150 = 150
      // Bug would double-count by adding during traversal too = 0 + 150 + 150 = 300
      const dataCall = (dataSource.getData as any).mock.calls[0].arguments[0];
      assert.strictEqual(dataCall.id, parentId);
      assert.strictEqual(dataCall.region.offset, 150); // NOT 300!
      assert.strictEqual(dataCall.region.size, 500);
    });
  });

  describe('rootDataItemOffset storage verification', () => {
    it('should store correct rootDataItemOffset for single-level nesting', async () => {
      const dataItemId = 'child-item';
      const rootId = 'root-tx';
      const dataStream = Readable.from([Buffer.from('test data')]);

      // Mock attributes: child has 50-byte header (offset=100, dataOffset=150)
      (dataAttributesStore.getDataAttributes as any).mock.mockImplementation(
        async (id: string) => {
          if (id === dataItemId) {
            return {
              size: 500, // payload size
              offset: 100, // item starts at byte 100 in root
              dataOffset: 150, // payload starts at byte 150 in root (100 + 50 header)
              parentId: rootId,
              contentType: 'text/plain',
            };
          }
          if (id === rootId) {
            return {
              size: 10000,
              offset: 0,
              // No parentId = root transaction
            };
          }
          return null;
        },
      );

      (dataSource.getData as any).mock.mockImplementation(async () => ({
        stream: dataStream,
        size: 500,
        verified: true,
        trusted: true,
        cached: false,
      }));

      await rootParentDataSource.getData({ id: dataItemId });

      // Verify setDataAttributes was called to store root offsets
      const setAttrCalls = (dataAttributesStore.setDataAttributes as any).mock
        .calls;
      assert.ok(setAttrCalls.length > 0, 'setDataAttributes should be called');

      // Find the call that stored root offsets
      const rootOffsetCall = setAttrCalls.find(
        (call: any) =>
          call.arguments[0] === dataItemId &&
          call.arguments[1].rootDataItemOffset !== undefined,
      );
      assert.ok(rootOffsetCall, 'Should store root offsets');

      const storedAttrs = rootOffsetCall.arguments[1];
      assert.strictEqual(
        storedAttrs.rootTransactionId,
        rootId,
        'Should store root transaction ID',
      );
      assert.strictEqual(
        storedAttrs.rootDataItemOffset,
        100,
        'rootDataItemOffset should point to item header start',
      );
      assert.strictEqual(
        storedAttrs.rootDataOffset,
        150,
        'rootDataOffset should point to payload start',
      );
      assert.strictEqual(storedAttrs.size, 500, 'Should store payload size');

      // Verify header size calculation
      const headerSize =
        storedAttrs.rootDataOffset - storedAttrs.rootDataItemOffset;
      assert.strictEqual(
        headerSize,
        50,
        'Header size should be 50 bytes (dataOffset - offset)',
      );
    });

    it('should store correct rootDataItemOffset for two-level nesting', async () => {
      const dataItemId = 'grandchild';
      const parentId = 'parent';
      const rootId = 'root-tx';
      const dataStream = Readable.from([Buffer.from('nested data')]);

      // Mock attributes for two-level nesting
      (dataAttributesStore.getDataAttributes as any).mock.mockImplementation(
        async (id: string) => {
          if (id === dataItemId) {
            return {
              size: 500,
              offset: 50, // item starts at byte 50 in parent's payload
              dataOffset: 120, // payload starts at byte 120 in parent's payload (50 + 70 header)
              parentId: parentId,
              contentType: 'application/json',
            };
          }
          if (id === parentId) {
            return {
              size: 2000,
              offset: 1000, // parent starts at byte 1000 in root
              dataOffset: 1100, // parent's payload starts at byte 1100 (1000 + 100 header)
              parentId: rootId,
            };
          }
          if (id === rootId) {
            return {
              size: 50000,
              offset: 0,
              // No parentId = root
            };
          }
          return null;
        },
      );

      (dataSource.getData as any).mock.mockImplementation(async () => ({
        stream: dataStream,
        size: 500,
        verified: true,
        trusted: true,
        cached: false,
      }));

      await rootParentDataSource.getData({ id: dataItemId });

      // Verify stored offsets
      const setAttrCalls = (dataAttributesStore.setDataAttributes as any).mock
        .calls;
      const rootOffsetCall = setAttrCalls.find(
        (call: any) =>
          call.arguments[0] === dataItemId &&
          call.arguments[1].rootDataItemOffset !== undefined,
      );
      assert.ok(rootOffsetCall, 'Should store root offsets');

      const storedAttrs = rootOffsetCall.arguments[1];

      // CRITICAL TEST: Verify our fix is working
      // rootDataItemOffset = parent's dataOffset + child's offset
      // = 1100 + 50 = 1150 (where child's header starts in root)
      assert.strictEqual(
        storedAttrs.rootDataItemOffset,
        1150,
        'rootDataItemOffset should be parent.dataOffset (1100) + child.offset (50)',
      );

      // rootDataOffset = parent's dataOffset + child's dataOffset
      // = 1100 + 120 = 1220 (where child's payload starts in root)
      assert.strictEqual(
        storedAttrs.rootDataOffset,
        1220,
        'rootDataOffset should be parent.dataOffset (1100) + child.dataOffset (120)',
      );

      // Verify header size
      const headerSize =
        storedAttrs.rootDataOffset - storedAttrs.rootDataItemOffset;
      assert.strictEqual(
        headerSize,
        70,
        'Header size should be 70 bytes (child header)',
      );
    });

    it('should store correct rootDataItemOffset for three-level nesting', async () => {
      const dataItemId = 'level3';
      const level2Id = 'level2';
      const level1Id = 'level1';
      const rootId = 'root-tx';
      const dataStream = Readable.from([Buffer.from('deeply nested')]);

      // Mock three-level nesting chain
      (dataAttributesStore.getDataAttributes as any).mock.mockImplementation(
        async (id: string) => {
          if (id === dataItemId) {
            return {
              size: 300,
              offset: 25, // in level2's payload
              dataOffset: 75, // payload in level2's payload (25 + 50 header)
              parentId: level2Id,
            };
          }
          if (id === level2Id) {
            return {
              size: 600,
              offset: 50, // in level1's payload
              dataOffset: 150, // payload in level1's payload (50 + 100 header)
              parentId: level1Id,
            };
          }
          if (id === level1Id) {
            return {
              size: 1500,
              offset: 100, // in root
              dataOffset: 200, // payload in root (100 + 100 header)
              parentId: rootId,
            };
          }
          if (id === rootId) {
            return {
              size: 100000,
              offset: 0,
            };
          }
          return null;
        },
      );

      (dataSource.getData as any).mock.mockImplementation(async () => ({
        stream: dataStream,
        size: 300,
        verified: true,
        trusted: true,
        cached: false,
      }));

      await rootParentDataSource.getData({ id: dataItemId });

      const setAttrCalls = (dataAttributesStore.setDataAttributes as any).mock
        .calls;
      const rootOffsetCall = setAttrCalls.find(
        (call: any) =>
          call.arguments[0] === dataItemId &&
          call.arguments[1].rootDataItemOffset !== undefined,
      );
      assert.ok(rootOffsetCall, 'Should store root offsets');

      const storedAttrs = rootOffsetCall.arguments[1];

      // Calculation:
      // level1.dataOffset (200) + level2.dataOffset (150) + level3.offset (25) = 375
      assert.strictEqual(
        storedAttrs.rootDataItemOffset,
        375,
        'rootDataItemOffset should accumulate: 200 + 150 + 25',
      );

      // level1.dataOffset (200) + level2.dataOffset (150) + level3.dataOffset (75) = 425
      assert.strictEqual(
        storedAttrs.rootDataOffset,
        425,
        'rootDataOffset should accumulate: 200 + 150 + 75',
      );

      // Verify header size
      const headerSize =
        storedAttrs.rootDataOffset - storedAttrs.rootDataItemOffset;
      assert.strictEqual(
        headerSize,
        50,
        'Header size should be 50 bytes (level3 header)',
      );
    });

    it('should correctly calculate header size from stored offsets', async () => {
      const testCases = [
        {
          itemId: 'item-small-header',
          offset: 0,
          dataOffset: 50,
          expectedHeader: 50,
        },
        {
          itemId: 'item-medium-header',
          offset: 100,
          dataOffset: 200,
          expectedHeader: 100,
        },
        {
          itemId: 'item-rsa-header',
          offset: 500,
          dataOffset: 1585,
          expectedHeader: 1085,
        }, // Typical RSA signature
      ];

      for (const testCase of testCases) {
        // Reset mocks for each test case
        mock.restoreAll();
        dataSource = { getData: mock.fn() };
        dataAttributesStore = {
          getDataAttributes: mock.fn(),
          setDataAttributes: mock.fn(),
        };
        rootParentDataSource = new RootParentDataSource({
          log,
          dataSource,
          dataAttributesStore: dataAttributesStore,
          dataItemRootTxIndex,
          ans104OffsetSource,
        });

        const rootId = 'root-tx';
        const dataStream = Readable.from([Buffer.from('data')]);

        (dataAttributesStore.getDataAttributes as any).mock.mockImplementation(
          async (id: string) => {
            if (id === testCase.itemId) {
              return {
                size: 1000,
                offset: testCase.offset,
                dataOffset: testCase.dataOffset,
                parentId: rootId,
              };
            }
            if (id === rootId) {
              return { size: 10000, offset: 0 };
            }
            return null;
          },
        );

        (dataSource.getData as any).mock.mockImplementation(async () => ({
          stream: dataStream,
          size: 1000,
          verified: true,
          trusted: true,
          cached: false,
        }));

        await rootParentDataSource.getData({ id: testCase.itemId });

        const setAttrCalls = (dataAttributesStore.setDataAttributes as any).mock
          .calls;
        const rootOffsetCall = setAttrCalls.find(
          (call: any) =>
            call.arguments[0] === testCase.itemId &&
            call.arguments[1].rootDataItemOffset !== undefined,
        );

        assert.ok(
          rootOffsetCall,
          `Should store offsets for ${testCase.itemId}`,
        );

        const storedAttrs = rootOffsetCall.arguments[1];
        const actualHeaderSize =
          storedAttrs.rootDataOffset - storedAttrs.rootDataItemOffset;

        assert.strictEqual(
          actualHeaderSize,
          testCase.expectedHeader,
          `Header size for ${testCase.itemId} should be ${testCase.expectedHeader} bytes`,
        );
        assert.strictEqual(
          storedAttrs.rootDataItemOffset,
          testCase.offset,
          `rootDataItemOffset should match item offset for ${testCase.itemId}`,
        );
        assert.strictEqual(
          storedAttrs.rootDataOffset,
          testCase.dataOffset,
          `rootDataOffset should match item dataOffset for ${testCase.itemId}`,
        );
      }
    });

    it('should handle zero-offset items correctly', async () => {
      const dataItemId = 'zero-offset-item';
      const rootId = 'root-tx';
      const dataStream = Readable.from([Buffer.from('data at offset 0')]);

      // Item starts at offset 0 in root (first item in bundle)
      (dataAttributesStore.getDataAttributes as any).mock.mockImplementation(
        async (id: string) => {
          if (id === dataItemId) {
            return {
              size: 800,
              offset: 0, // Zero offset - first item in bundle
              dataOffset: 75, // Payload starts at 75 (0 + 75 header)
              parentId: rootId,
            };
          }
          if (id === rootId) {
            return {
              size: 50000,
              offset: 0,
            };
          }
          return null;
        },
      );

      (dataSource.getData as any).mock.mockImplementation(async () => ({
        stream: dataStream,
        size: 800,
        verified: true,
        trusted: true,
        cached: false,
      }));

      await rootParentDataSource.getData({ id: dataItemId });

      const setAttrCalls = (dataAttributesStore.setDataAttributes as any).mock
        .calls;
      const rootOffsetCall = setAttrCalls.find(
        (call: any) =>
          call.arguments[0] === dataItemId &&
          call.arguments[1].rootDataItemOffset !== undefined,
      );
      assert.ok(rootOffsetCall, 'Should store root offsets');

      const storedAttrs = rootOffsetCall.arguments[1];

      // Critical: zero offset should be stored, not skipped
      assert.strictEqual(
        storedAttrs.rootDataItemOffset,
        0,
        'rootDataItemOffset should be 0 (not undefined or skipped)',
      );
      assert.strictEqual(
        storedAttrs.rootDataOffset,
        75,
        'rootDataOffset should be 75',
      );
      assert.strictEqual(
        storedAttrs.rootDataOffset - storedAttrs.rootDataItemOffset,
        75,
        'Header size should be 75 bytes',
      );
    });

    it('should match Turbo offset format from legacy bundle parsing', async () => {
      const dataItemId = 'test-item';
      const rootId = 'root-tx';
      const dataStream = Readable.from([Buffer.from('test data')]);

      // First, test legacy path (no attributes)
      (dataAttributesStore.getDataAttributes as any).mock.mockImplementation(
        async () => null,
      );

      (dataItemRootTxIndex.getRootTx as any).mock.mockImplementation(
        async () => ({
          rootTxId: rootId,
          rootOffset: 5000, // itemOffset from Turbo/bundle parsing
          rootDataOffset: 5150, // dataOffset from Turbo/bundle parsing
          size: 600, // itemSize
          dataSize: 500, // payload size
        }),
      );

      (ans104OffsetSource.getDataItemOffset as any).mock.mockImplementation(
        async () => ({
          itemOffset: 5000,
          dataOffset: 5150,
          itemSize: 600,
          dataSize: 500,
        }),
      );

      (dataSource.getData as any).mock.mockImplementation(async () => ({
        stream: dataStream,
        size: 500,
        verified: true,
        trusted: true,
        cached: false,
      }));

      await rootParentDataSource.getData({ id: dataItemId });

      // Get what was stored from legacy path
      const legacySetCalls = (dataAttributesStore.setDataAttributes as any).mock
        .calls;
      const legacyCall = legacySetCalls.find(
        (call: any) =>
          call.arguments[0] === dataItemId &&
          call.arguments[1].rootDataItemOffset !== undefined,
      );
      assert.ok(legacyCall, 'Legacy path should store offsets');
      const legacyAttrs = legacyCall.arguments[1];

      // Now reset and test attributes path
      mock.restoreAll();
      dataSource = { getData: mock.fn() };
      dataAttributesStore = {
        getDataAttributes: mock.fn(),
        setDataAttributes: mock.fn(),
      };
      dataItemRootTxIndex = { getRootTx: mock.fn() };
      ans104OffsetSource = { getDataItemOffset: mock.fn() } as any;
      rootParentDataSource = new RootParentDataSource({
        log,
        dataSource,
        dataAttributesStore: dataAttributesStore,
        dataItemRootTxIndex,
        ans104OffsetSource,
      });

      // Mock attributes matching the legacy data
      (dataAttributesStore.getDataAttributes as any).mock.mockImplementation(
        async (id: string) => {
          if (id === dataItemId) {
            return {
              size: 500,
              offset: 5000, // Same as legacy itemOffset
              dataOffset: 5150, // Same as legacy dataOffset
              parentId: rootId,
            };
          }
          if (id === rootId) {
            return { size: 100000, offset: 0 };
          }
          return null;
        },
      );

      (dataSource.getData as any).mock.mockImplementation(async () => ({
        stream: dataStream,
        size: 500,
        verified: true,
        trusted: true,
        cached: false,
      }));

      await rootParentDataSource.getData({ id: dataItemId });

      const attrSetCalls = (dataAttributesStore.setDataAttributes as any).mock
        .calls;
      const attrCall = attrSetCalls.find(
        (call: any) =>
          call.arguments[0] === dataItemId &&
          call.arguments[1].rootDataItemOffset !== undefined,
      );
      assert.ok(attrCall, 'Attributes path should store offsets');
      const attrAttrs = attrCall.arguments[1];

      // Both paths should produce identical stored values
      assert.strictEqual(
        attrAttrs.rootDataItemOffset,
        legacyAttrs.rootDataItemOffset,
        'rootDataItemOffset should match between paths',
      );
      assert.strictEqual(
        attrAttrs.rootDataOffset,
        legacyAttrs.rootDataOffset,
        'rootDataOffset should match between paths',
      );
      assert.strictEqual(
        attrAttrs.size,
        legacyAttrs.size,
        'size should match between paths',
      );
    });

    it('should store offsets from attributes traversal for later retrieval', async () => {
      const dataItemId = 'cached-item';
      const parentId = 'parent';
      const rootId = 'root-tx';
      const dataStream = Readable.from([Buffer.from('cached data')]);

      // Track whether offsets have been computed yet
      let offsetsComputed = false;

      (dataAttributesStore.getDataAttributes as any).mock.mockImplementation(
        async (id: string) => {
          if (id === dataItemId) {
            // After first getData completes, return pre-computed offsets
            if (offsetsComputed) {
              return {
                size: 400,
                offset: 200,
                dataOffset: 300,
                parentId: parentId,
                rootTransactionId: rootId,
                rootDataItemOffset: 1200, // stored from first traversal
                rootDataOffset: 1300, // stored from first traversal
              };
            } else {
              // First time: no pre-computed offsets
              return {
                size: 400,
                offset: 200,
                dataOffset: 300,
                parentId: parentId,
              };
            }
          }
          if (id === parentId) {
            return {
              size: 3000,
              offset: 1000,
              dataOffset: 1000,
              parentId: rootId,
            };
          }
          if (id === rootId) {
            return { size: 50000, offset: 0 };
          }
          return null;
        },
      );

      (dataSource.getData as any).mock.mockImplementation(async () => ({
        stream: Readable.from([Buffer.from('data')]),
        size: 400,
        verified: true,
        trusted: true,
        cached: false,
      }));

      // First getData: should traverse parent chain
      const firstGetAttrCallsBefore = (
        dataAttributesStore.getDataAttributes as any
      ).mock.calls.length;
      await rootParentDataSource.getData({ id: dataItemId });
      const firstGetAttrCallsAfter = (
        dataAttributesStore.getDataAttributes as any
      ).mock.calls.length;

      const firstCallAttrCount =
        firstGetAttrCallsAfter - firstGetAttrCallsBefore;
      assert.ok(
        firstCallAttrCount >= 3,
        'First call should traverse parent chain',
      );

      // Verify offsets were stored
      const setAttrCalls = (dataAttributesStore.setDataAttributes as any).mock
        .calls;
      const storedCall = setAttrCalls.find(
        (call: any) =>
          call.arguments[0] === dataItemId &&
          call.arguments[1].rootDataItemOffset !== undefined,
      );
      assert.ok(storedCall, 'Should store offsets after first traversal');

      const storedAttrs = storedCall.arguments[1];
      assert.strictEqual(
        storedAttrs.rootDataItemOffset,
        1200,
        'Should store correct rootDataItemOffset',
      );
      assert.strictEqual(
        storedAttrs.rootDataOffset,
        1300,
        'Should store correct rootDataOffset',
      );

      // Mark offsets as computed for second call
      offsetsComputed = true;

      // Second getData: should use pre-computed offsets (no parent traversal)
      const secondGetAttrCallsBefore = (
        dataAttributesStore.getDataAttributes as any
      ).mock.calls.length;
      await rootParentDataSource.getData({ id: dataItemId });
      const secondGetAttrCallsAfter = (
        dataAttributesStore.getDataAttributes as any
      ).mock.calls.length;

      const secondCallAttrCount =
        secondGetAttrCallsAfter - secondGetAttrCallsBefore;

      // Should only call getDataAttributes for:
      // 1. Initial content type lookup
      // 2. Check for pre-computed offsets (finds them!)
      // No parent traversal needed
      assert.ok(
        secondCallAttrCount <= 2,
        `Second call should use pre-computed offsets without traversal (got ${secondCallAttrCount} calls)`,
      );

      // Verify data was fetched using stored offsets
      const dataSourceCalls = (dataSource.getData as any).mock.calls;
      const lastDataCall =
        dataSourceCalls[dataSourceCalls.length - 1].arguments[0];
      assert.strictEqual(
        lastDataCall.id,
        rootId,
        'Should fetch from root using stored offsets',
      );
      assert.strictEqual(
        lastDataCall.region.offset,
        1300,
        'Should use stored rootDataOffset',
      );
    });
  });
});
