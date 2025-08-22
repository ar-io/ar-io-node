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

import { Ans104OffsetSource } from './ans104-offset-source.js';
import { ContiguousDataSource } from '../types.js';

describe('Ans104OffsetSource', () => {
  let log: winston.Logger;
  let dataSource: ContiguousDataSource;
  let ans104OffsetSource: Ans104OffsetSource;
  let getDataMock: any;

  beforeEach(() => {
    log = winston.createLogger({
      silent: true,
    });
    getDataMock = mock.fn();
    dataSource = {
      getData: getDataMock,
    };
    ans104OffsetSource = new Ans104OffsetSource({
      log,
      dataSource,
    });
  });

  afterEach(() => {
    mock.restoreAll();
  });

  describe('getDataItemOffset', () => {
    it('should find data item in root bundle', async () => {
      // Use a 32-byte buffer that we'll convert to base64url
      const itemIdBuffer = Buffer.alloc(32);
      itemIdBuffer.write('test-item-id'); // Will fill first bytes with string
      const dataItemId = itemIdBuffer.toString('base64url');
      const rootBundleId = 'root-bundle-id';

      // Create a mock bundle with one item
      const itemCount = Buffer.alloc(32);
      itemCount.writeBigInt64LE(1n, 0); // 1 item

      const itemSize = Buffer.alloc(32);
      itemSize.writeBigInt64LE(2000n, 0); // 2000 bytes total (includes envelope)

      // Use the same buffer as the ID
      const paddedItemId = itemIdBuffer;

      const bundleHeader = Buffer.concat([itemCount, itemSize, paddedItemId]);

      // Mock data source calls
      getDataMock.mock.mockImplementation(async (args: any) => {
        if (
          args.id === rootBundleId &&
          args.region?.offset === 0 &&
          args.region?.size === 32
        ) {
          return {
            stream: Readable.from([itemCount]),
            size: 32,
            verified: false,
            trusted: false,
            cached: false,
          };
        }
        if (
          args.id === rootBundleId &&
          args.region?.offset === 0 &&
          args.region?.size === 96
        ) {
          return {
            stream: Readable.from([bundleHeader]),
            size: 96,
            verified: false,
            trusted: false,
            cached: false,
          };
        }
        // This is the parseDataItemHeader check - return a data item header
        if (
          args.id === rootBundleId &&
          args.region?.offset === 96 &&
          args.region?.size <= 2000
        ) {
          // Create a minimal data item header
          const dataItemHeader = Buffer.concat([
            Buffer.from([0x01, 0x00]), // Signature type 1 (Arweave)
            Buffer.alloc(512), // Signature
            Buffer.alloc(512), // Owner
            Buffer.from([0]), // No target
            Buffer.from([0]), // No anchor
            Buffer.alloc(16), // No tags (0 count, 0 bytes)
            Buffer.from('test data'), // The actual data
          ]);
          return {
            stream: Readable.from([dataItemHeader]),
            size: dataItemHeader.length,
            verified: false,
            trusted: false,
            cached: false,
          };
        }
        throw new Error('Unexpected call');
      });

      const result = await ans104OffsetSource.getDataItemOffset(
        dataItemId,
        rootBundleId,
      );

      assert.notStrictEqual(result, null);
      // The offset should be: bundle header (96) + data item envelope header (1044)
      assert.strictEqual(result?.offset, 96 + 1044);
      // The size should be the total data item size (2000) minus the envelope header (1044)
      assert.strictEqual(result?.size, 2000 - 1044);
    });

    it('should find data item in nested bundle', async () => {
      // Create proper base64url IDs from 32-byte buffers
      const dataItemIdBuffer = Buffer.alloc(32);
      dataItemIdBuffer.write('nested-item-id');
      const dataItemId = dataItemIdBuffer.toString('base64url');

      const nestedBundleIdBuffer = Buffer.alloc(32);
      nestedBundleIdBuffer.write('nested-bundle-id');
      const nestedBundleId = nestedBundleIdBuffer.toString('base64url');

      const rootBundleId = 'root-bundle-id';

      // Root bundle with one item (the nested bundle)
      const rootItemCount = Buffer.alloc(32);
      rootItemCount.writeBigInt64LE(1n, 0);

      const nestedBundleSize = Buffer.alloc(32);
      nestedBundleSize.writeBigInt64LE(5000n, 0);

      // Use the pre-created buffer
      const paddedNestedId = nestedBundleIdBuffer;

      const rootBundleHeader = Buffer.concat([
        rootItemCount,
        nestedBundleSize,
        paddedNestedId,
      ]);

      // Nested bundle with the target item
      const nestedItemCount = Buffer.alloc(32);
      nestedItemCount.writeBigInt64LE(1n, 0);

      const targetItemSize = Buffer.alloc(32);
      targetItemSize.writeBigInt64LE(1500n, 0); // Must be larger than header (1042 bytes)

      // Use the pre-created buffer
      const paddedTargetId = dataItemIdBuffer;

      const nestedBundleHeader = Buffer.concat([
        nestedItemCount,
        targetItemSize,
        paddedTargetId,
      ]);

      // Bundle check data - create proper ANS-104 bundle tags
      const bundleFormatTag = Buffer.concat([
        Buffer.from([13, 0, 0, 0]), // "Bundle-Format" length (13)
        Buffer.from('Bundle-Format'),
        Buffer.from([6, 0, 0, 0]), // "binary" length (6)
        Buffer.from('binary'),
      ]);

      const bundleVersionTag = Buffer.concat([
        Buffer.from([14, 0, 0, 0]), // "Bundle-Version" length (14)
        Buffer.from('Bundle-Version'),
        Buffer.from([5, 0, 0, 0]), // "2.0.0" length (5)
        Buffer.from('2.0.0'),
      ]);

      const tagsData = Buffer.concat([bundleFormatTag, bundleVersionTag]);

      const tagsCount = Buffer.alloc(8);
      tagsCount.writeBigInt64LE(2n, 0); // 2 tags
      const tagsBytesLength = Buffer.alloc(8);
      tagsBytesLength.writeBigInt64LE(BigInt(tagsData.length), 0);

      const bundleCheckData = Buffer.concat([
        Buffer.from([0x01, 0x00]), // Signature type 1 (Arweave) - little endian
        Buffer.alloc(512), // Signature
        Buffer.alloc(512), // Owner
        Buffer.from([0]), // No target
        Buffer.from([0]), // No anchor
        tagsCount,
        tagsBytesLength,
        tagsData,
      ]);

      // Create data item header for parsing
      const dataItemHeader = Buffer.concat([
        Buffer.from([0x01, 0x00]), // Signature type 1 (Arweave)
        Buffer.alloc(512), // Signature
        Buffer.alloc(512), // Owner
        Buffer.from([0]), // No target
        Buffer.from([0]), // No anchor
        Buffer.alloc(16), // No tags (0 count, 0 bytes)
        Buffer.from('nested item data'), // The actual data
      ]);

      // Mock all calls
      getDataMock.mock.mockImplementation(async (args: any) => {
        // Root bundle header
        if (
          args.id === rootBundleId &&
          args.region?.offset === 0 &&
          args.region?.size === 32
        ) {
          return {
            stream: Readable.from([rootItemCount]),
            size: 32,
            verified: false,
            trusted: false,
            cached: false,
          };
        }
        if (
          args.id === rootBundleId &&
          args.region?.offset === 0 &&
          args.region?.size === 96
        ) {
          return {
            stream: Readable.from([rootBundleHeader]),
            size: 96,
            verified: false,
            trusted: false,
            cached: false,
          };
        }
        // Nested bundle check - checking if the nested item is a bundle (MIN_BINARY_SIZE check)
        if (
          args.id === rootBundleId &&
          args.region?.offset === 96 &&
          args.region?.size === 2048
        ) {
          return {
            stream: Readable.from([bundleCheckData]),
            size: bundleCheckData.length,
            verified: false,
            trusted: false,
            cached: false,
          };
        }
        // Nested bundle header
        if (
          args.id === nestedBundleId &&
          args.region?.offset === 0 &&
          args.region?.size === 32
        ) {
          return {
            stream: Readable.from([nestedItemCount]),
            size: 32,
            verified: false,
            trusted: false,
            cached: false,
          };
        }
        if (
          args.id === nestedBundleId &&
          args.region?.offset === 0 &&
          args.region?.size === 96
        ) {
          return {
            stream: Readable.from([nestedBundleHeader]),
            size: 96,
            verified: false,
            trusted: false,
            cached: false,
          };
        }
        // Parse data item header in nested bundle
        if (
          args.id === nestedBundleId &&
          args.region?.offset === 96 &&
          args.region?.size <= 1500
        ) {
          return {
            stream: Readable.from([dataItemHeader]),
            size: dataItemHeader.length,
            verified: false,
            trusted: false,
            cached: false,
          };
        }
        throw new Error('Unexpected call');
      });

      const result = await ans104OffsetSource.getDataItemOffset(
        dataItemId,
        rootBundleId,
      );

      assert.notStrictEqual(result, null);
      assert.strictEqual(result?.offset, 96 + 96 + 1044); // Root header + nested header + data item header
      assert.strictEqual(result?.size, 1500 - 1044); // Total size minus header
    });

    it('should return null when item not found', async () => {
      const dataItemId = 'not-found-id';
      const rootBundleId = 'root-bundle-id';

      // Create a mock bundle with one different item
      const itemCount = Buffer.alloc(32);
      itemCount.writeBigInt64LE(1n, 0);

      const itemSize = Buffer.alloc(32);
      itemSize.writeBigInt64LE(1000n, 0);

      const differentId = Buffer.from('different-id', 'base64url');
      const paddedItemId = Buffer.concat([
        differentId,
        Buffer.alloc(32 - differentId.length),
      ]);

      const bundleHeader = Buffer.concat([itemCount, itemSize, paddedItemId]);

      // Mock item check (not a bundle)
      const itemCheckData = Buffer.concat([
        Buffer.from([0, 1]), // Signature type
        Buffer.alloc(512), // Signature
        Buffer.alloc(512), // Owner
        Buffer.from([0]), // No target
        Buffer.from([0]), // No anchor
        Buffer.alloc(16), // No tags
      ]);

      getDataMock.mock.mockImplementation(async (args: any) => {
        if (
          args.id === rootBundleId &&
          args.region?.offset === 0 &&
          args.region?.size === 32
        ) {
          return {
            stream: Readable.from([itemCount]),
            size: 32,
            verified: false,
            trusted: false,
            cached: false,
          };
        }
        if (
          args.id === rootBundleId &&
          args.region?.offset === 0 &&
          args.region?.size === 96
        ) {
          return {
            stream: Readable.from([bundleHeader]),
            size: 96,
            verified: false,
            trusted: false,
            cached: false,
          };
        }
        if (
          args.id === rootBundleId &&
          args.region?.offset === 96 &&
          args.region?.size === 1000
        ) {
          return {
            stream: Readable.from([itemCheckData]),
            size: itemCheckData.length,
            verified: false,
            trusted: false,
            cached: false,
          };
        }
        throw new Error('Unexpected call');
      });

      const result = await ans104OffsetSource.getDataItemOffset(
        dataItemId,
        rootBundleId,
      );

      assert.strictEqual(result, null);
    });

    it('should handle empty bundles', async () => {
      const dataItemId = 'test-item-id';
      const rootBundleId = 'root-bundle-id';

      // Create a mock bundle with zero items
      const itemCount = Buffer.alloc(32);
      itemCount.writeBigInt64LE(0n, 0); // 0 items

      getDataMock.mock.mockImplementation(async (args: any) => {
        if (
          args.id === rootBundleId &&
          args.region?.offset === 0 &&
          args.region?.size === 32
        ) {
          return {
            stream: Readable.from([itemCount]),
            size: 32,
            verified: false,
            trusted: false,
            cached: false,
          };
        }
        throw new Error('Unexpected call');
      });

      const result = await ans104OffsetSource.getDataItemOffset(
        dataItemId,
        rootBundleId,
      );

      assert.strictEqual(result, null);
    });

    it('should detect and handle cycles', async () => {
      const dataItemId = 'test-item-id';
      const bundleA = 'bundle-a';
      const bundleB = 'bundle-b';

      // Bundle A contains Bundle B
      const bundleAItemCount = Buffer.alloc(32);
      bundleAItemCount.writeBigInt64LE(1n, 0);

      const bundleBSize = Buffer.alloc(32);
      bundleBSize.writeBigInt64LE(5000n, 0);

      const bundleBIdBuffer = Buffer.from(bundleB, 'base64url');
      const paddedBundleBId = Buffer.concat([
        bundleBIdBuffer,
        Buffer.alloc(32 - bundleBIdBuffer.length),
      ]);

      const bundleAHeader = Buffer.concat([
        bundleAItemCount,
        bundleBSize,
        paddedBundleBId,
      ]);

      // Bundle B contains Bundle A (cycle)
      const bundleBItemCount = Buffer.alloc(32);
      bundleBItemCount.writeBigInt64LE(1n, 0);

      const bundleASize = Buffer.alloc(32);
      bundleASize.writeBigInt64LE(5000n, 0);

      const bundleAIdBuffer = Buffer.from(bundleA, 'base64url');
      const paddedBundleAId = Buffer.concat([
        bundleAIdBuffer,
        Buffer.alloc(32 - bundleAIdBuffer.length),
      ]);

      const bundleBHeader = Buffer.concat([
        bundleBItemCount,
        bundleASize,
        paddedBundleAId,
      ]);

      // Bundle check data
      const bundleCheckData = Buffer.concat([
        Buffer.from([0, 1]), // Signature type
        Buffer.alloc(512), // Signature
        Buffer.alloc(512), // Owner
        Buffer.from([0]), // No target
        Buffer.from([0]), // No anchor
        Buffer.alloc(8), // Tags count
        Buffer.from([100, 0, 0, 0, 0, 0, 0, 0]), // Tags bytes length
        // Bundle tags
        Buffer.from([
          13,
          0,
          0,
          0, // "Bundle-Format" length
          66,
          117,
          110,
          100,
          108,
          101,
          45,
          70,
          111,
          114,
          109,
          97,
          116, // "Bundle-Format"
          6,
          0,
          0,
          0, // "binary" length
          98,
          105,
          110,
          97,
          114,
          121, // "binary"
          14,
          0,
          0,
          0, // "Bundle-Version" length
          66,
          117,
          110,
          100,
          108,
          101,
          45,
          86,
          101,
          114,
          115,
          105,
          111,
          110, // "Bundle-Version"
          5,
          0,
          0,
          0, // "2.0.0" length
          50,
          46,
          48,
          46,
          48, // "2.0.0"
        ]),
      ]);

      getDataMock.mock.mockImplementation(async (args: any) => {
        // Bundle A header
        if (
          args.id === bundleA &&
          args.region?.offset === 0 &&
          args.region?.size === 32
        ) {
          return {
            stream: Readable.from([bundleAItemCount]),
            size: 32,
            verified: false,
            trusted: false,
            cached: false,
          };
        }
        if (
          args.id === bundleA &&
          args.region?.offset === 0 &&
          args.region?.size === 96
        ) {
          return {
            stream: Readable.from([bundleAHeader]),
            size: 96,
            verified: false,
            trusted: false,
            cached: false,
          };
        }
        // Bundle B header
        if (
          args.id === bundleB &&
          args.region?.offset === 0 &&
          args.region?.size === 32
        ) {
          return {
            stream: Readable.from([bundleBItemCount]),
            size: 32,
            verified: false,
            trusted: false,
            cached: false,
          };
        }
        if (
          args.id === bundleB &&
          args.region?.offset === 0 &&
          args.region?.size === 96
        ) {
          return {
            stream: Readable.from([bundleBHeader]),
            size: 96,
            verified: false,
            trusted: false,
            cached: false,
          };
        }
        // Bundle checks
        if (
          (args.id === bundleA || args.id === bundleB) &&
          args.region?.offset === 96
        ) {
          return {
            stream: Readable.from([bundleCheckData]),
            size: bundleCheckData.length,
            verified: false,
            trusted: false,
            cached: false,
          };
        }
        throw new Error('Unexpected call');
      });

      const result = await ans104OffsetSource.getDataItemOffset(
        dataItemId,
        bundleA,
      );

      // Should return null without infinite loop
      assert.strictEqual(result, null);
    });
  });
});
