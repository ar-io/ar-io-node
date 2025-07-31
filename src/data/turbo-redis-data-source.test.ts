/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  it,
  mock,
} from 'node:test';
import { Readable } from 'node:stream';
import * as winston from 'winston';

import { TurboRedisDataSource } from './turbo-redis-data-source.js';
import { RequestAttributes } from '../types.js';

let log: winston.Logger;
let turboRedisDataSource: TurboRedisDataSource;
let mockRedis: any;
let mockCircuitBreaker: any;

const testDataId = 'test-data-id';
const testParentId = 'test-parent-id';

before(async () => {
  log = winston.createLogger({ silent: true });
});

beforeEach(async () => {
  // Create mock Redis cluster
  mockRedis = {
    status: 'ready',
    get: mock.fn(async () => null),
    getBuffer: mock.fn(async () => null),
    on: mock.fn(),
  };

  // Create mock circuit breaker
  mockCircuitBreaker = {
    fire: mock.fn(async (task: any) => task()),
    opened: false,
    on: mock.fn(),
    removeAllListeners: mock.fn(),
  };

  // Create instance with injected Redis mock
  turboRedisDataSource = new TurboRedisDataSource({
    redis: mockRedis as any,
    log,
  });

  // Replace the circuit breaker with our mock after construction
  (turboRedisDataSource as any).circuitBreaker = mockCircuitBreaker;
});

after(async () => {
  // Clean up any remaining mock state
  mock.restoreAll();
});

afterEach(async () => {
  mock.restoreAll();
});

describe('TurboRedisDataSource', () => {
  describe('redisIsAvailable', () => {
    for (const opened of [false, true]) {
      it(`should return ${!opened} when circuit breaker is ${opened ? 'open' : 'closed'}`, () => {
        mockCircuitBreaker.opened = opened;
        assert.equal(turboRedisDataSource.redisIsAvailable(), !opened);
      });
    }
  });

  describe('getCachedTurboMetadata', () => {
    it('should return parsed metadata when found', async () => {
      const metadataString = 'image/png;1024';
      mockRedis.get = mock.fn(async () => metadataString);

      const result =
        await turboRedisDataSource.getCachedTurboMetadata(testDataId);

      assert.deepEqual(result, {
        payloadContentType: 'image/png',
        payloadStartOffset: 1024,
      });
      assert.equal((mockRedis.get as any).mock.callCount(), 1);
      assert.equal(
        (mockRedis.get as any).mock.calls[0].arguments[0],
        `metadata_{${testDataId}}`,
      );
    });

    it('should return undefined when metadata not found', async () => {
      mockRedis.get = mock.fn(async () => null);

      const result =
        await turboRedisDataSource.getCachedTurboMetadata(testDataId);

      assert.equal(result, undefined);
    });

    it('should return undefined when metadata format is invalid', async () => {
      mockRedis.get = mock.fn(async () => 'invalid-format');

      const result =
        await turboRedisDataSource.getCachedTurboMetadata(testDataId);

      assert.equal(result, undefined);
    });

    it('should return undefined when payload start offset is not a number', async () => {
      mockRedis.get = mock.fn(async () => 'image/png;not-a-number');

      const result =
        await turboRedisDataSource.getCachedTurboMetadata(testDataId);

      assert.equal(result, undefined);
    });

    it('should handle Redis errors gracefully', async () => {
      mockRedis.get = mock.fn(async () => {
        throw new Error('Redis error');
      });

      const result =
        await turboRedisDataSource.getCachedTurboMetadata(testDataId);

      assert.equal(result, undefined);
    });
  });

  describe('getCachedTurboOffsetsInfo', () => {
    it('should return expanded offsets info when found', async () => {
      const minifiedOffsets = {
        pid: testParentId,
        ppds: 512,
        sorp: 1024,
        rcl: 2048,
        pct: 'application/json',
        pds: 256,
      };
      mockRedis.get = mock.fn(async () => JSON.stringify(minifiedOffsets));

      const result =
        await turboRedisDataSource.getCachedTurboOffsetsInfo(testDataId);

      assert.deepEqual(result, {
        parentDataItemId: testParentId,
        parentPayloadDataStart: 512,
        startOffsetInRawParent: 1024,
        rawContentLength: 2048,
        payloadContentType: 'application/json',
        payloadDataStart: 256,
      });
      assert.equal(
        (mockRedis.get as any).mock.calls[0].arguments[0],
        `offsets_{${testDataId}}`,
      );
    });

    it('should return undefined when offsets not found', async () => {
      mockRedis.get = mock.fn(async () => null);

      const result =
        await turboRedisDataSource.getCachedTurboOffsetsInfo(testDataId);

      assert.equal(result, undefined);
    });

    it('should return undefined when JSON parsing fails', async () => {
      mockRedis.get = mock.fn(async () => 'invalid-json');

      const result =
        await turboRedisDataSource.getCachedTurboOffsetsInfo(testDataId);

      assert.equal(result, undefined);
    });

    it('should handle Redis errors gracefully', async () => {
      mockRedis.get = mock.fn(async () => {
        throw new Error('Redis error');
      });

      const result =
        await turboRedisDataSource.getCachedTurboOffsetsInfo(testDataId);

      assert.equal(result, undefined);
    });
  });

  describe('getCachedTurboPayloadDataStreamFromMetadata', () => {
    it('should return data stream from cached buffer', async () => {
      const testBuffer = Buffer.from('test payload data');
      mockRedis.getBuffer = mock.fn(async () => testBuffer);
      const expectedStreamData = 'payload data';

      const result =
        await turboRedisDataSource.getCachedTurboPayloadDataStreamFromMetadata({
          dataItemId: testDataId,
          payloadContentType: 'text/plain',
          payloadStartOffset: 5,
        });

      assert.ok(result.stream instanceof Readable);
      assert.equal(result.sourceContentType, 'text/plain');
      assert.equal(result.size, expectedStreamData.length);
      assert.equal(result.cached, false);
      assert.equal(result.trusted, true);
      assert.equal(result.verified, false);

      assert.equal(
        (mockRedis.getBuffer as any).mock.calls[0].arguments[0],
        `raw_{${testDataId}}`,
      );

      // Verify stream content
      let streamData = '';
      for await (const chunk of result.stream) {
        streamData += chunk;
      }
      assert.equal(streamData, expectedStreamData);
    });

    it('should handle region offset and size', async () => {
      const testBuffer = Buffer.from('test payload data for region');
      mockRedis.getBuffer = mock.fn(async () => testBuffer);

      const result =
        await turboRedisDataSource.getCachedTurboPayloadDataStreamFromMetadata({
          dataItemId: testDataId,
          payloadContentType: 'text/plain',
          payloadStartOffset: 5,
          region: { offset: 2, size: 7 },
        });

      assert.equal(result.size, 7);

      // Verify stream content with region
      let streamData = '';
      for await (const chunk of result.stream) {
        streamData += chunk;
      }
      assert.equal(streamData, 'yload d');
    });

    it('should include request attributes', async () => {
      const testBuffer = Buffer.from('test data');
      mockRedis.getBuffer = mock.fn(async () => testBuffer);

      const result =
        await turboRedisDataSource.getCachedTurboPayloadDataStreamFromMetadata({
          dataItemId: testDataId,
          payloadContentType: 'text/plain',
          payloadStartOffset: 0,
          requestAttributes: { hops: 1, origin: 'test-origin' },
        });

      assert.deepEqual(result.requestAttributes, {
        hops: 2,
        origin: 'test-origin',
      });
    });

    it('should throw error when raw data not found', async () => {
      mockRedis.getBuffer = mock.fn(async () => null);

      await assert.rejects(
        turboRedisDataSource.getCachedTurboPayloadDataStreamFromMetadata({
          dataItemId: testDataId,
          payloadContentType: 'text/plain',
          payloadStartOffset: 0,
        }),
        /Raw data for .* not found in Redis!/,
      );
    });

    it('should handle Redis errors', async () => {
      mockRedis.getBuffer = mock.fn(async () => {
        throw new Error('Redis connection error');
      });

      await assert.rejects(
        turboRedisDataSource.getCachedTurboPayloadDataStreamFromMetadata({
          dataItemId: testDataId,
          payloadContentType: 'text/plain',
          payloadStartOffset: 0,
        }),
        /Raw data for .* not found in Redis!/,
      );
    });
  });

  describe('getData', () => {
    it('should return data from metadata when available', async () => {
      const testBuffer = Buffer.from('test metadata payload data');

      mockRedis.get = mock.fn(async (key: string) => {
        if (key === `offsets_{${testDataId}}`) {
          return null; // No offsets
        }
        if (key === `metadata_{${testDataId}}`) {
          return 'text/plain;5';
        }
        return null;
      });

      mockRedis.getBuffer = mock.fn(async () => testBuffer);

      const expectedData = 'metadata payload data';
      const result = await turboRedisDataSource.getData({ id: testDataId });

      assert.ok(result.stream instanceof Readable);
      assert.equal(result.sourceContentType, 'text/plain');
      assert.equal(result.size, expectedData.length);
      assert.equal(result.verified, false);
      assert.equal(result.trusted, true);
      assert.equal(result.cached, false);

      // Verify stream content
      let streamData = '';
      for await (const chunk of result.stream) {
        streamData += chunk;
      }
      assert.equal(streamData, expectedData);
    });

    it('should handle region parameters', async () => {
      const testBuffer = Buffer.from('test data with region handling');

      mockRedis.get = mock.fn(async (key: string) => {
        if (key === `metadata_{${testDataId}}`) {
          return 'text/plain;5';
        }
        return null;
      });

      mockRedis.getBuffer = mock.fn(async () => testBuffer);

      const region = { offset: 2, size: 10 };
      const result = await turboRedisDataSource.getData({
        id: testDataId,
        region,
      });

      assert.equal(result.size, 10);
    });

    it('should include request attributes in response', async () => {
      const testBuffer = Buffer.from('test data');

      mockRedis.get = mock.fn(async (key: string) => {
        if (key === `metadata_{${testDataId}}`) {
          return 'text/plain;0';
        }
        return null;
      });

      mockRedis.getBuffer = mock.fn(async () => testBuffer);

      const requestAttributes: RequestAttributes = {
        hops: 0,
        origin: 'test-origin',
      };
      const result = await turboRedisDataSource.getData({
        id: testDataId,
        requestAttributes,
      });

      assert.deepEqual(result.requestAttributes, {
        hops: 1,
        origin: 'test-origin',
      });
    });

    it('should throw error when data not found', async () => {
      mockRedis.get = mock.fn(async () => null);

      await assert.rejects(
        turboRedisDataSource.getData({ id: testDataId }),
        /Data item .* not found in Redis/,
      );
    });

    it('should treat circuit breaker failures as cache misses', async () => {
      mockCircuitBreaker.fire = mock.fn(async () => {
        throw new Error('Redis connection failed');
      });

      await assert.rejects(
        turboRedisDataSource.getData({ id: testDataId }),
        /Data item .* not found in Redis/,
      );
    });
  });

  describe('circuit breaker integration', () => {
    it('should use circuit breaker for Redis operations through public methods', async () => {
      mockRedis.get = mock.fn(async () => 'image/png;1024');

      await turboRedisDataSource.getCachedTurboMetadata(testDataId);

      assert.equal((mockCircuitBreaker.fire as any).mock.callCount(), 1);
    });

    it('should treat circuit breaker failures as cache misses through getData method', async () => {
      mockCircuitBreaker.fire = mock.fn(async () => {
        throw new Error('Circuit breaker is open');
      });

      await assert.rejects(
        turboRedisDataSource.getData({ id: testDataId }),
        /Data item .* not found in Redis/,
      );
    });
  });
});
