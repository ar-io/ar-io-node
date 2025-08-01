/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mock } from 'node:test';
import { gzipSync } from 'node:zlib';
import winston from 'winston';

import { TurboDynamoDbDataSource } from './turbo-dynamodb-data-source.js';

// Table names that match the actual implementation
const CACHE_TABLE = 'upload-service-cache-local';
const OFFSETS_TABLE = 'upload-service-offsets-local';

const testDataId = 'UavUNnE2MGZgnkZ_lZor361AX2jBhcRUi3gEbHvPrFQ'; // Valid base64url
const testParentId = 'ParentDataIdForTesting123456789AbCdEfGhI'; // Valid base64url

let log: winston.Logger;
let turboDynamoDbDataSource: TurboDynamoDbDataSource;
let mockDynamoClient: any;

before(async () => {
  log = winston.createLogger({ silent: true });
});

beforeEach(async () => {
  // Create mock DynamoDB client
  mockDynamoClient = {
    send: mock.fn(async () => ({ Item: null })),
  };

  // Create instance with injected DynamoDB mock
  turboDynamoDbDataSource = new TurboDynamoDbDataSource({
    dynamoClient: mockDynamoClient as any,
    log,
  });
});

describe('TurboDynamoDbDataSource', () => {
  describe('constructor', () => {
    it('should create instance with provided DynamoDB client', () => {
      const dataSource = new TurboDynamoDbDataSource({
        dynamoClient: mockDynamoClient as any,
        log,
      });
      // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
      assert.ok(dataSource);
    });

    it('should create instance with region configuration', () => {
      const dataSource = new TurboDynamoDbDataSource({
        region: 'us-east-1',
        log,
      });
      // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
      assert.ok(dataSource);
    });

    it('should throw error when neither client nor region provided', () => {
      assert.throws(() => {
        new TurboDynamoDbDataSource({ log });
      }, /TurboDynamoDbDataSource requires either a DynamoDBClient instance or region configuration/);
    });

    it('should throw error when region is empty string', () => {
      assert.throws(() => {
        new TurboDynamoDbDataSource({ region: '', log });
      }, /TurboDynamoDbDataSource requires either a DynamoDBClient instance or region configuration/);
    });
  });

  describe('getDataItem', () => {
    it('should return data item when found in the cache table', async () => {
      mockDynamoClient.send = mock.fn(async (command: any) => {
        const tableName = command.input.TableName;
        if (tableName === CACHE_TABLE) {
          return {
            Item: {
              D: { B: gzipSync(Buffer.from('test data')) },
              P: { N: '0' },
              C: { S: 'image/png' },
            },
          };
        }
        return { Item: null };
      });

      const result = await (turboDynamoDbDataSource as any).getDataItem(
        testDataId,
      );
      assert.ok(result);
      assert.equal(result.buffer.toString(), 'test data');
      assert.equal(result.info.payloadDataStart, 0);
      assert.equal(result.info.payloadContentType, 'image/png');
    });

    it('should return undefined when item not found', async () => {
      const result = await (turboDynamoDbDataSource as any).getDataItem(
        testDataId,
      );
      assert.equal(result, undefined);
    });

    it('should return undefined when payload start missing', async () => {
      mockDynamoClient.send = mock.fn(async (command: any) => {
        const tableName = command.input.TableName;
        if (tableName === CACHE_TABLE) {
          return {
            Item: {
              D: { B: gzipSync(Buffer.from('test data')) },
              // Missing P field
              C: { S: 'image/png' },
            },
          };
        }
        return { Item: null };
      });

      const result = await (turboDynamoDbDataSource as any).getDataItem(
        testDataId,
      );
      assert.equal(result, undefined);
    });

    it('should return data with default content type when content type is missing', async () => {
      mockDynamoClient.send = mock.fn(async (command: any) => {
        const tableName = command.input.TableName;
        if (tableName === CACHE_TABLE) {
          return {
            Item: {
              D: { B: gzipSync(Buffer.from('test data')) },
              P: { N: '0' },
              // Missing C field
            },
          };
        }
        return { Item: null };
      });

      const result = await (turboDynamoDbDataSource as any).getDataItem(
        testDataId,
      );
      // Should still return result with default content type
      assert.ok(result);
      assert.equal(result.buffer.toString(), 'test data');
      assert.equal(result.info.payloadDataStart, 0);
      assert.equal(result.info.payloadContentType, 'application/octet-stream');
    });

    it('should handle parent data item that contains nested data', async () => {
      // Simulate a parent data item that contains nested child data
      const parentData = 'prefix-data|nested-child-data|suffix-data';
      mockDynamoClient.send = mock.fn(async (command: any) => {
        const tableName = command.input.TableName;
        if (tableName === CACHE_TABLE) {
          return {
            Item: {
              D: { B: gzipSync(Buffer.from(parentData)) },
              P: { N: '12' }, // payload starts after 'prefix-data|'
              C: { S: 'application/octet-stream' },
            },
          };
        }
        return { Item: null };
      });

      const result = await (turboDynamoDbDataSource as any).getDataItem(
        testParentId,
      );
      assert.ok(result);
      assert.equal(result.buffer.toString(), parentData);
      assert.equal(result.info.payloadDataStart, 12);
      assert.equal(result.info.payloadContentType, 'application/octet-stream');
    });

    it('should handle large binary data with various content types', async () => {
      const binaryData = Buffer.alloc(1024, 0xab); // 1KB of binary data
      mockDynamoClient.send = mock.fn(async (command: any) => {
        const tableName = command.input.TableName;
        if (tableName === CACHE_TABLE) {
          return {
            Item: {
              D: { B: gzipSync(binaryData) },
              P: { N: '100' }, // payload starts at offset 100
              C: { S: 'application/wasm' },
            },
          };
        }
        return { Item: null };
      });

      const result = await (turboDynamoDbDataSource as any).getDataItem(
        testDataId,
      );
      assert.ok(result);
      assert.equal(result.buffer.length, 1024);
      assert.equal(result.buffer[0], 0xab);
      assert.equal(result.info.payloadDataStart, 100);
      assert.equal(result.info.payloadContentType, 'application/wasm');
    });

    it('should handle DynamoDB client errors gracefully', async () => {
      mockDynamoClient.send = mock.fn(async () => {
        throw new Error('DynamoDB connection timeout');
      });

      const result = await (turboDynamoDbDataSource as any).getDataItem(
        testDataId,
      );
      assert.equal(result, undefined);
    });
  });

  describe('getOffsetsInfo', () => {
    it('should return offsets info when found in offsets table', async () => {
      mockDynamoClient.send = mock.fn(async (command: any) => {
        const tableName = command.input.TableName;
        if (tableName === OFFSETS_TABLE) {
          return {
            Item: {
              PId: { B: Buffer.from(testParentId, 'base64url') },
              SP: { N: '1024' }, // startOffsetInParentPayload
              S: { N: '2048' }, // rawContentLength
              C: { S: 'application/json' }, // payloadContentType
              P: { N: '0' }, // payloadDataStart
            },
          };
        }
        return { Item: null };
      });

      const result = await (turboDynamoDbDataSource as any).getOffsetsInfo(
        testDataId,
      );
      assert.ok(result);
      assert.equal(result.dataItemId, testDataId);
      assert.ok(result.parentInfo);
      assert.equal(result.parentInfo.parentDataItemId, testParentId);
      assert.equal(result.parentInfo.startOffsetInParentPayload, 1024);
      assert.equal(result.rawContentLength, 2048);
      assert.equal(result.payloadContentType, 'application/json');
      assert.equal(result.payloadDataStart, 0);
    });

    it('should return undefined when offsets not found', async () => {
      const result = await (turboDynamoDbDataSource as any).getOffsetsInfo(
        testDataId,
      );
      assert.equal(result, undefined);
    });

    it('should handle offsets info without parent info', async () => {
      mockDynamoClient.send = mock.fn(async (command: any) => {
        const tableName = command.input.TableName;
        if (tableName === OFFSETS_TABLE) {
          return {
            Item: {
              // Missing PId and SP (parent info)
              S: { N: '1024' }, // rawContentLength
              C: { S: 'text/plain' }, // payloadContentType
              P: { N: '10' }, // payloadDataStart
            },
          };
        }
        return { Item: null };
      });

      const result = await (turboDynamoDbDataSource as any).getOffsetsInfo(
        testDataId,
      );
      assert.ok(result);
      assert.equal(result.dataItemId, testDataId);
      assert.equal(result.parentInfo, undefined);
      assert.equal(result.rawContentLength, 1024);
      assert.equal(result.payloadContentType, 'text/plain');
      assert.equal(result.payloadDataStart, 10);
    });

    it('should handle DynamoDB errors gracefully', async () => {
      mockDynamoClient.send = mock.fn(async () => {
        throw new Error('DynamoDB timeout');
      });

      const result = await (turboDynamoDbDataSource as any).getOffsetsInfo(
        testDataId,
      );
      assert.equal(result, undefined);
    });
  });

  describe('getData', () => {
    it('should return data from nested item using both offsets and cache tables', async () => {
      // Setup parent data in cache table
      const parentData = 'header-data__nested-json-payload__footer-data';
      const nestedJsonData = 'nested-json-payload';

      mockDynamoClient.send = mock.fn(async (command: any) => {
        const tableName = command.input.TableName;

        // When getting offsets for nested item
        if (
          tableName === OFFSETS_TABLE &&
          Buffer.from(command.input.Key.Id.B).toString('base64url') ===
            testDataId
        ) {
          return {
            Item: {
              PId: { B: Buffer.from(testParentId, 'base64url') },
              SP: { N: '13' }, // offset to start of nested data in parent
              S: { N: '19' }, // total length of nested item
              C: { S: 'application/json' },
              P: { N: '0' }, // payload starts at beginning of nested data
            },
          };
        }

        // When getting parent data from cache table
        if (
          tableName === CACHE_TABLE &&
          Buffer.from(command.input.Key.Id.B).toString('base64url') ===
            testParentId
        ) {
          return {
            Item: {
              D: { B: gzipSync(Buffer.from(parentData)) },
              P: { N: '0' },
              C: { S: 'application/octet-stream' },
            },
          };
        }

        return { Item: null };
      });

      const result = await turboDynamoDbDataSource.getData({ id: testDataId });

      // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
      assert.ok(result);
      assert.equal(result.sourceContentType, 'application/json');
      assert.equal(result.size, 19); // size of nested data

      // Verify stream content contains the nested data
      let streamData = '';
      for await (const chunk of result.stream) {
        streamData += chunk;
      }
      assert.equal(streamData, nestedJsonData);
    });

    it('should throw error when nested item offsets reference missing parent', async () => {
      // Nested item exists in offsets table but parent is missing from cache table
      mockDynamoClient.send = mock.fn(async (command: any) => {
        const tableName = command.input.TableName;

        // When getting offsets for nested item - return valid offsets
        if (
          tableName === OFFSETS_TABLE &&
          Buffer.from(command.input.Key.Id.B).toString('base64url') ===
            testDataId
        ) {
          return {
            Item: {
              PId: { B: Buffer.from(testParentId, 'base64url') },
              SP: { N: '10' },
              S: { N: '100' },
              C: { S: 'text/plain' },
              P: { N: '0' },
            },
          };
        }

        // Parent not found in cache table
        return { Item: null };
      });

      await assert.rejects(
        turboDynamoDbDataSource.getData({ id: testDataId }),
        /Data item .* not found in DynamoDB/,
      );
    });

    it('should throw error when data not found', async () => {
      await assert.rejects(
        turboDynamoDbDataSource.getData({ id: testDataId }),
        /Data item .* not found in DynamoDB/,
      );
    });

    it('should return data from raw item when no offsets available', async () => {
      mockDynamoClient.send = mock.fn(async (command: any) => {
        const tableName = command.input.TableName;
        if (tableName === CACHE_TABLE) {
          return {
            Item: {
              D: { B: gzipSync(Buffer.from('test data')) },
              P: { N: '0' },
              C: { S: 'image/png' },
            },
          };
        }
        return { Item: null };
      });

      const result = await turboDynamoDbDataSource.getData({ id: testDataId });
      // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
      assert.ok(result);
      assert.equal(result.sourceContentType, 'image/png');
      assert.equal(result.size, 9); // "test data".length
    });

    it('should handle region offset and size', async () => {
      const testPayload = 'test payload data for region';
      mockDynamoClient.send = mock.fn(async (command: any) => {
        const tableName = command.input.TableName;
        if (tableName === CACHE_TABLE) {
          return {
            Item: {
              D: { B: gzipSync(Buffer.from(testPayload)) },
              P: { N: '5' }, // payloadStartOffset
              C: { S: 'text/plain' },
            },
          };
        }
        return { Item: null };
      });

      const result = await turboDynamoDbDataSource.getData({
        id: testDataId,
        region: { offset: 2, size: 7 },
      });

      // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
      assert.ok(result);
      assert.equal(result.size, 7);
      assert.equal(result.sourceContentType, 'text/plain');

      // Verify stream content with region
      // The test payload is 'test payload data for region'
      // With payloadStartOffset=5, the payload starts at 'payload data for region'
      // With region offset=2, size=7, we get 'yload d'
      let streamData = '';
      for await (const chunk of result.stream) {
        streamData += chunk;
      }
      assert.equal(streamData, 'yload d');
    });

    it('should include request attributes', async () => {
      mockDynamoClient.send = mock.fn(async (command: any) => {
        const tableName = command.input.TableName;
        if (tableName === CACHE_TABLE) {
          return {
            Item: {
              D: { B: gzipSync(Buffer.from('test data')) },
              P: { N: '0' },
              C: { S: 'text/plain' },
            },
          };
        }
        return { Item: null };
      });

      const result = await turboDynamoDbDataSource.getData({
        id: testDataId,
        requestAttributes: { hops: 1, origin: 'test-origin' },
      });

      // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
      assert.ok(result);
      assert.deepEqual(result.requestAttributes, {
        hops: 2,
        origin: 'test-origin',
      });
    });

    it('should handle payload start offset without region', async () => {
      const testBuffer = 'test payload data';
      mockDynamoClient.send = mock.fn(async (command: any) => {
        const tableName = command.input.TableName;
        if (tableName === CACHE_TABLE) {
          return {
            Item: {
              D: { B: gzipSync(Buffer.from(testBuffer)) },
              P: { N: '5' }, // payloadStartOffset
              C: { S: 'text/plain' },
            },
          };
        }
        return { Item: null };
      });

      const result = await turboDynamoDbDataSource.getData({ id: testDataId });

      // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
      assert.ok(result);
      assert.equal(result.sourceContentType, 'text/plain');
      assert.equal(result.size, 12); // "payload data".length

      // Verify stream content starts at offset 5
      let streamData = '';
      for await (const chunk of result.stream) {
        streamData += chunk;
      }
      assert.equal(streamData, 'payload data');
    });

    it('should throw error when data not found even with region specified', async () => {
      await assert.rejects(
        turboDynamoDbDataSource.getData({
          id: testDataId,
          region: { offset: 0, size: 5 },
        }),
        /Data item .* not found in DynamoDB/,
      );
    });
  });
});
