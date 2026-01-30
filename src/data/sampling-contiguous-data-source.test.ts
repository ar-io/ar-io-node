/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { Readable } from 'node:stream';

import { SamplingContiguousDataSource } from './sampling-contiguous-data-source.js';
import { ContiguousDataSource, RequestAttributes } from '../types.js';
import { createTestLogger } from '../../test/test-logger.js';

let log: ReturnType<typeof createTestLogger>;
let mockDataSource: ContiguousDataSource;

const mockContiguousData = {
  stream: Readable.from(['test data']),
  size: 9,
  verified: false,
  trusted: true,
  sourceContentType: 'text/plain',
  cached: false,
  requestAttributes: {
    hops: 1,
    origin: 'test-origin',
    clientIps: ['192.168.1.1'],
  },
};

before(async () => {
  log = createTestLogger({ suite: 'SamplingContiguousDataSource' });
});

beforeEach(async () => {
  mockDataSource = {
    getData: mock.fn(() => Promise.resolve(mockContiguousData)),
  };
});

afterEach(async () => {
  mock.restoreAll();
});

describe('SamplingContiguousDataSource', () => {
  describe('Constructor validation', () => {
    it('should throw for sampling rate below 0', () => {
      assert.throws(
        () =>
          new SamplingContiguousDataSource({
            log,
            dataSource: mockDataSource,
            sourceName: 'test-source',
            samplingRate: -0.1,
          }),
        /samplingRate must be between 0 and 1/,
      );
    });

    it('should throw for sampling rate above 1', () => {
      assert.throws(
        () =>
          new SamplingContiguousDataSource({
            log,
            dataSource: mockDataSource,
            sourceName: 'test-source',
            samplingRate: 1.5,
          }),
        /samplingRate must be between 0 and 1/,
      );
    });

    it('should throw for NaN sampling rate', () => {
      assert.throws(
        () =>
          new SamplingContiguousDataSource({
            log,
            dataSource: mockDataSource,
            sourceName: 'test-source',
            samplingRate: NaN,
          }),
        /samplingRate must be between 0 and 1/,
      );
    });

    it('should throw for Infinity sampling rate', () => {
      assert.throws(
        () =>
          new SamplingContiguousDataSource({
            log,
            dataSource: mockDataSource,
            sourceName: 'test-source',
            samplingRate: Infinity,
          }),
        /samplingRate must be between 0 and 1/,
      );
    });

    it('should accept sampling rate of 0', () => {
      const source = new SamplingContiguousDataSource({
        log,
        dataSource: mockDataSource,
        sourceName: 'test-source',
        samplingRate: 0,
      });
      assert.notEqual(source, null);
    });

    it('should accept sampling rate of 1', () => {
      const source = new SamplingContiguousDataSource({
        log,
        dataSource: mockDataSource,
        sourceName: 'test-source',
        samplingRate: 1,
      });
      assert.notEqual(source, null);
    });

    it('should default to random strategy', () => {
      const source = new SamplingContiguousDataSource({
        log,
        dataSource: mockDataSource,
        sourceName: 'test-source',
        samplingRate: 0.5,
      });
      assert.notEqual(source, null);
    });
  });

  describe('Random strategy', () => {
    it('should never sample with rate=0', async () => {
      const samplingSource = new SamplingContiguousDataSource({
        log,
        dataSource: mockDataSource,
        sourceName: 'test-source',
        samplingRate: 0,
        strategy: 'random',
      });

      // Try multiple times to ensure it never samples
      for (let i = 0; i < 10; i++) {
        await assert.rejects(
          samplingSource.getData({ id: `test-id-${i}` }),
          /Request not sampled/,
        );
      }

      assert.equal((mockDataSource.getData as any).mock.callCount(), 0);
    });

    it('should always sample with rate=1', async () => {
      const samplingSource = new SamplingContiguousDataSource({
        log,
        dataSource: mockDataSource,
        sourceName: 'test-source',
        samplingRate: 1,
        strategy: 'random',
      });

      // Try multiple times to ensure it always samples
      for (let i = 0; i < 10; i++) {
        const data = await samplingSource.getData({ id: `test-id-${i}` });
        assert.deepEqual(data, mockContiguousData);
      }

      assert.equal((mockDataSource.getData as any).mock.callCount(), 10);
    });
  });

  describe('Deterministic strategy', () => {
    it('should produce consistent decisions for the same ID', async () => {
      const samplingSource = new SamplingContiguousDataSource({
        log,
        dataSource: mockDataSource,
        sourceName: 'test-source',
        samplingRate: 0.5,
        strategy: 'deterministic',
      });

      const testId = 'test-id-consistent';

      // Get the result of the first call
      let firstResult: 'sampled' | 'not-sampled';
      try {
        await samplingSource.getData({ id: testId });
        firstResult = 'sampled';
      } catch {
        firstResult = 'not-sampled';
      }

      // Reset mock call count
      (mockDataSource.getData as any).mock.resetCalls();

      // Verify subsequent calls produce the same result
      for (let i = 0; i < 5; i++) {
        try {
          await samplingSource.getData({ id: testId });
          assert.equal(
            firstResult,
            'sampled',
            'Should be sampled on subsequent calls',
          );
        } catch {
          assert.equal(
            firstResult,
            'not-sampled',
            'Should not be sampled on subsequent calls',
          );
        }
      }
    });

    it('should produce different decisions for different IDs', async () => {
      // Using rate 0.5, statistically we should get a mix of sampled/not-sampled
      const samplingSource = new SamplingContiguousDataSource({
        log,
        dataSource: mockDataSource,
        sourceName: 'test-source',
        samplingRate: 0.5,
        strategy: 'deterministic',
      });

      let sampledCount = 0;
      let notSampledCount = 0;

      // Test with many different IDs to get statistical significance
      for (let i = 0; i < 100; i++) {
        try {
          await samplingSource.getData({ id: `unique-id-${i}` });
          sampledCount++;
        } catch {
          notSampledCount++;
        }
      }

      // With 100 samples at 50% rate, we should have a mix
      // Allow for some variance but expect at least 20% in each bucket
      assert.ok(
        sampledCount > 20,
        `Expected more sampled requests, got ${sampledCount}`,
      );
      assert.ok(
        notSampledCount > 20,
        `Expected more not-sampled requests, got ${notSampledCount}`,
      );
    });

    it('should never sample with rate=0', async () => {
      const samplingSource = new SamplingContiguousDataSource({
        log,
        dataSource: mockDataSource,
        sourceName: 'test-source',
        samplingRate: 0,
        strategy: 'deterministic',
      });

      for (let i = 0; i < 10; i++) {
        await assert.rejects(
          samplingSource.getData({ id: `test-id-${i}` }),
          /Request not sampled/,
        );
      }

      assert.equal((mockDataSource.getData as any).mock.callCount(), 0);
    });

    it('should always sample with rate=1', async () => {
      const samplingSource = new SamplingContiguousDataSource({
        log,
        dataSource: mockDataSource,
        sourceName: 'test-source',
        samplingRate: 1,
        strategy: 'deterministic',
      });

      for (let i = 0; i < 10; i++) {
        const data = await samplingSource.getData({ id: `test-id-${i}` });
        assert.deepEqual(data, mockContiguousData);
      }

      assert.equal((mockDataSource.getData as any).mock.callCount(), 10);
    });
  });

  describe('Sampled requests', () => {
    it('should call inner source and return data', async () => {
      const samplingSource = new SamplingContiguousDataSource({
        log,
        dataSource: mockDataSource,
        sourceName: 'test-source',
        samplingRate: 1, // Always sample
        strategy: 'random',
      });

      const data = await samplingSource.getData({ id: 'test-id' });

      assert.deepEqual(data, mockContiguousData);
      assert.equal((mockDataSource.getData as any).mock.callCount(), 1);
    });

    it('should pass all parameters to inner source', async () => {
      const samplingSource = new SamplingContiguousDataSource({
        log,
        dataSource: mockDataSource,
        sourceName: 'test-source',
        samplingRate: 1,
        strategy: 'random',
      });

      const requestAttributes: RequestAttributes = {
        hops: 2,
        origin: 'test-origin',
        clientIp: '192.168.1.1',
        clientIps: ['192.168.1.1'],
        arnsName: 'test-name',
        arnsBasename: 'test-basename',
      };

      const region = { offset: 100, size: 200 };

      await samplingSource.getData({
        id: 'test-id-123',
        requestAttributes,
        region,
      });

      const mockCall = (mockDataSource.getData as any).mock.calls[0];
      assert.equal(mockCall.arguments[0].id, 'test-id-123');
      assert.deepEqual(
        mockCall.arguments[0].requestAttributes,
        requestAttributes,
      );
      assert.deepEqual(mockCall.arguments[0].region, region);
    });

    it('should pass signal to inner source', async () => {
      const samplingSource = new SamplingContiguousDataSource({
        log,
        dataSource: mockDataSource,
        sourceName: 'test-source',
        samplingRate: 1,
        strategy: 'random',
      });

      const controller = new AbortController();

      await samplingSource.getData({
        id: 'test-id',
        signal: controller.signal,
      });

      const mockCall = (mockDataSource.getData as any).mock.calls[0];
      assert.equal(mockCall.arguments[0].signal, controller.signal);
    });
  });

  describe('Not sampled requests', () => {
    it('should throw without calling inner source', async () => {
      const samplingSource = new SamplingContiguousDataSource({
        log,
        dataSource: mockDataSource,
        sourceName: 'test-source',
        samplingRate: 0, // Never sample
        strategy: 'random',
      });

      await assert.rejects(
        samplingSource.getData({ id: 'test-id' }),
        /Request not sampled for source: test-source/,
      );

      assert.equal((mockDataSource.getData as any).mock.callCount(), 0);
    });
  });

  describe('Error handling', () => {
    it('should re-throw AbortError immediately', async () => {
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';

      mockDataSource = {
        getData: mock.fn(() => Promise.reject(abortError)),
      };

      const samplingSource = new SamplingContiguousDataSource({
        log,
        dataSource: mockDataSource,
        sourceName: 'test-source',
        samplingRate: 1,
        strategy: 'random',
      });

      await assert.rejects(samplingSource.getData({ id: 'test-id' }), {
        name: 'AbortError',
      });
    });

    it('should throw when signal is already aborted', async () => {
      const samplingSource = new SamplingContiguousDataSource({
        log,
        dataSource: mockDataSource,
        sourceName: 'test-source',
        samplingRate: 1,
        strategy: 'random',
      });

      const controller = new AbortController();
      controller.abort();

      await assert.rejects(
        samplingSource.getData({
          id: 'test-id',
          signal: controller.signal,
        }),
        /aborted/i,
      );

      // Inner source should not have been called
      assert.equal((mockDataSource.getData as any).mock.callCount(), 0);
    });

    it('should propagate other errors from inner source', async () => {
      const testError = new Error('Inner source failed');

      mockDataSource = {
        getData: mock.fn(() => Promise.reject(testError)),
      };

      const samplingSource = new SamplingContiguousDataSource({
        log,
        dataSource: mockDataSource,
        sourceName: 'test-source',
        samplingRate: 1,
        strategy: 'random',
      });

      await assert.rejects(samplingSource.getData({ id: 'test-id' }), {
        message: 'Inner source failed',
      });
    });
  });

  describe('Source name in errors', () => {
    it('should include source name in not-sampled error', async () => {
      const samplingSource = new SamplingContiguousDataSource({
        log,
        dataSource: mockDataSource,
        sourceName: 'my-experimental-source',
        samplingRate: 0,
        strategy: 'random',
      });

      await assert.rejects(
        samplingSource.getData({ id: 'test-id' }),
        /Request not sampled for source: my-experimental-source/,
      );
    });
  });
});
