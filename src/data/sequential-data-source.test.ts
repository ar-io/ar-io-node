/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { Readable } from 'node:stream';
import { SequentialDataSource } from './sequential-data-source.js';
import { ContiguousData, ContiguousDataSource } from '../types.js';
import { createTestLogger } from '../../test/test-logger.js';

let log: ReturnType<typeof createTestLogger>;
let sequentialDataSource: SequentialDataSource;
let mockSource1: { getData: ReturnType<typeof mock.fn> };
let mockSource2: { getData: ReturnType<typeof mock.fn> };

before(async () => {
  log = createTestLogger({ suite: 'SequentialDataSource' });
});

beforeEach(async () => {
  mockSource1 = {
    getData: mock.fn(
      async (): Promise<ContiguousData> => ({
        stream: Readable.from(['data from source 1']),
        size: 18,
        verified: false,
        trusted: true,
        cached: false,
      }),
    ),
  };

  mockSource2 = {
    getData: mock.fn(
      async (): Promise<ContiguousData> => ({
        stream: Readable.from(['data from source 2']),
        size: 18,
        verified: false,
        trusted: true,
        cached: false,
      }),
    ),
  };

  sequentialDataSource = new SequentialDataSource({
    log,
    dataSources: [
      mockSource1 as unknown as ContiguousDataSource,
      mockSource2 as unknown as ContiguousDataSource,
    ],
  });
});

afterEach(async () => {
  mock.restoreAll();
});

describe('SequentialDataSource', () => {
  describe('getData', () => {
    it('should return data from the first successful source', async () => {
      const result = await sequentialDataSource.getData({ id: 'test-id' });

      assert.equal(result.size, 18);
      assert.equal(mockSource1.getData.mock.callCount(), 1);
      assert.equal(mockSource2.getData.mock.callCount(), 0);

      let receivedData = '';
      for await (const chunk of result.stream) {
        receivedData += chunk;
      }
      assert.equal(receivedData, 'data from source 1');
    });

    it('should try next source when first fails', async () => {
      mockSource1.getData = mock.fn(async () => {
        throw new Error('Source 1 failed');
      });

      const result = await sequentialDataSource.getData({ id: 'test-id' });

      assert.equal(result.size, 18);
      assert.equal(mockSource1.getData.mock.callCount(), 1);
      assert.equal(mockSource2.getData.mock.callCount(), 1);

      let receivedData = '';
      for await (const chunk of result.stream) {
        receivedData += chunk;
      }
      assert.equal(receivedData, 'data from source 2');
    });

    it('should throw when all sources fail', async () => {
      mockSource1.getData = mock.fn(async () => {
        throw new Error('Source 1 failed');
      });
      mockSource2.getData = mock.fn(async () => {
        throw new Error('Source 2 failed');
      });

      await assert.rejects(sequentialDataSource.getData({ id: 'test-id' }), {
        message: 'Unable to fetch data from any data source',
      });

      assert.equal(mockSource1.getData.mock.callCount(), 1);
      assert.equal(mockSource2.getData.mock.callCount(), 1);
    });

    it('should pass signal to downstream data sources', async () => {
      const controller = new AbortController();

      await sequentialDataSource.getData({
        id: 'test-id',
        signal: controller.signal,
      });

      assert.equal(mockSource1.getData.mock.callCount(), 1);
      const callArgs = mockSource1.getData.mock.calls[0].arguments[0] as {
        signal?: AbortSignal;
      };
      assert.strictEqual(callArgs.signal, controller.signal);
    });
  });

  describe('abort signal handling', () => {
    it('should throw immediately when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      await assert.rejects(
        sequentialDataSource.getData({
          id: 'test-id',
          signal: controller.signal,
        }),
        { name: 'AbortError' },
      );

      // Verify no sources were tried
      assert.equal(mockSource1.getData.mock.callCount(), 0);
      assert.equal(mockSource2.getData.mock.callCount(), 0);
    });

    it('should not try next source when AbortError is thrown', async () => {
      mockSource1.getData = mock.fn(async () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      });

      await assert.rejects(sequentialDataSource.getData({ id: 'test-id' }), {
        name: 'AbortError',
      });

      // Verify second source was never tried
      assert.equal(mockSource1.getData.mock.callCount(), 1);
      assert.equal(mockSource2.getData.mock.callCount(), 0);
    });

    it('should check abort before each source attempt', async () => {
      const controller = new AbortController();

      // First source fails with regular error
      mockSource1.getData = mock.fn(async () => {
        // Abort after first source is tried
        controller.abort();
        throw new Error('Source 1 failed');
      });

      await assert.rejects(
        sequentialDataSource.getData({
          id: 'test-id',
          signal: controller.signal,
        }),
        { name: 'AbortError' },
      );

      // First source tried, but second should be skipped due to abort
      assert.equal(mockSource1.getData.mock.callCount(), 1);
      assert.equal(mockSource2.getData.mock.callCount(), 0);
    });
  });
});
