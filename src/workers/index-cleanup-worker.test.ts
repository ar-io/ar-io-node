/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, describe, it, mock } from 'node:test';

import { IndexCleanupWorker } from './index-cleanup-worker.js';
import { toB64Url } from '../lib/encoding.js';
import { createTestLogger } from '../../test/test-logger.js';

const testLog = createTestLogger({ suite: 'IndexCleanupWorker' });

function createMockDb() {
  return {
    getIndexCleanupCandidateIds: mock.fn(async () => ({
      ids: [],
      hasMore: false,
    })),
    countIndexCleanupCandidates: mock.fn(async () => 0),
    deleteIndexCleanupBundlesBatch: mock.fn(async () => ({
      stableDataItemTagsDeleted: 0,
      stableDataItemsDeleted: 0,
      newDataItemTagsDeleted: 0,
      newDataItemsDeleted: 0,
    })),
    deleteIndexCleanupDataBatch: mock.fn(async () => ({
      contiguousDataIdParentsDeleted: 0,
      contiguousDataIdsDeleted: 0,
    })),
  };
}

describe('IndexCleanupWorker', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('should call countIndexCleanupCandidates in dry-run mode', async () => {
    const mockDb = createMockDb();
    mockDb.countIndexCleanupCandidates.mock.mockImplementation(async () => 42);

    const worker = new IndexCleanupWorker({
      log: testLog,
      db: mockDb,
      filter: { owners: ['test-owner'] },
      intervalMs: 60000,
      batchSize: 100,
      dryRun: true,
      minAgeSeconds: 86400,
    });

    await worker.cleanup();

    assert.equal(mockDb.countIndexCleanupCandidates.mock.callCount(), 1);
    assert.equal(mockDb.getIndexCleanupCandidateIds.mock.callCount(), 0);
    assert.equal(mockDb.deleteIndexCleanupBundlesBatch.mock.callCount(), 0);
  });

  it('should iterate multiple batches and delete in non-dry-run mode', async () => {
    const mockDb = createMockDb();
    const id1 = Buffer.from('id1');
    const id2 = Buffer.from('id2');
    const id3 = Buffer.from('id3');
    let callCount = 0;

    // Return two non-empty batches then empty to verify multi-batch iteration
    mockDb.getIndexCleanupCandidateIds.mock.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ids: [id1, id2], hasMore: true };
      }
      if (callCount === 2) {
        return { ids: [id3], hasMore: false };
      }
      return { ids: [], hasMore: false };
    });
    mockDb.deleteIndexCleanupBundlesBatch.mock.mockImplementation(
      async (ids: Buffer[]) => ({
        stableDataItemTagsDeleted: ids.length,
        stableDataItemsDeleted: ids.length,
        newDataItemTagsDeleted: 0,
        newDataItemsDeleted: 0,
      }),
    );

    const worker = new IndexCleanupWorker({
      log: testLog,
      db: mockDb,
      filter: { owners: ['test-owner'] },
      intervalMs: 60000,
      batchSize: 100,
      dryRun: false,
      minAgeSeconds: 86400,
    });

    await worker.cleanup();

    // Two non-empty batches fetched, plus one empty to end the loop
    assert.equal(mockDb.getIndexCleanupCandidateIds.mock.callCount(), 2);
    // Delete called once per non-empty batch
    assert.equal(mockDb.deleteIndexCleanupBundlesBatch.mock.callCount(), 2);
    assert.equal(mockDb.deleteIndexCleanupDataBatch.mock.callCount(), 2);
  });

  it('should compute maxIndexedAt from minAgeSeconds', async () => {
    const mockDb = createMockDb();

    const worker = new IndexCleanupWorker({
      log: testLog,
      db: mockDb,
      filter: { owners: ['test-owner'] },
      intervalMs: 60000,
      batchSize: 100,
      dryRun: true,
      minAgeSeconds: 86400,
    });

    await worker.cleanup();

    const filter =
      mockDb.countIndexCleanupCandidates.mock.calls[0].arguments[0];
    assert.ok(filter.maxIndexedAt !== undefined);
    assert.ok(filter.maxIndexedAt > 0);
    // Should be approximately now - 86400 seconds
    const expectedApprox = Math.floor(Date.now() / 1000) - 86400;
    assert.ok(Math.abs(filter.maxIndexedAt - expectedApprox) < 5);
  });

  it('should skip if cleanup is already running', async () => {
    const mockDb = createMockDb();
    // Simulate a long-running count
    let resolveCount: () => void;
    const countPromise = new Promise<void>((resolve) => {
      resolveCount = resolve;
    });
    mockDb.countIndexCleanupCandidates.mock.mockImplementation(async () => {
      await countPromise;
      return 0;
    });

    const worker = new IndexCleanupWorker({
      log: testLog,
      db: mockDb,
      filter: { owners: ['test-owner'] },
      intervalMs: 60000,
      batchSize: 100,
      dryRun: true,
      minAgeSeconds: 86400,
    });

    // Start first cleanup (will block on count)
    const firstCleanup = worker.cleanup();
    // Try to start second cleanup while first is running
    await worker.cleanup();
    // Second call should have been skipped - count still called only once
    assert.equal(mockDb.countIndexCleanupCandidates.mock.callCount(), 1);

    // Unblock first cleanup
    resolveCount!();
    await firstCleanup;
  });

  it('should call ClickHouse cleanup when configured', async () => {
    const mockDb = createMockDb();
    const id1 = Buffer.from('id1');
    let callCount = 0;

    mockDb.getIndexCleanupCandidateIds.mock.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ids: [id1], hasMore: false };
      }
      return { ids: [], hasMore: false };
    });
    mockDb.deleteIndexCleanupBundlesBatch.mock.mockImplementation(async () => ({
      stableDataItemTagsDeleted: 1,
      stableDataItemsDeleted: 1,
      newDataItemTagsDeleted: 0,
      newDataItemsDeleted: 0,
    }));

    const mockClickHouse = {
      deleteDataItemsByIds: mock.fn(async () => {}),
    };

    const worker = new IndexCleanupWorker({
      log: testLog,
      db: mockDb,
      clickHouseCleanup: mockClickHouse,
      filter: { owners: ['test-owner'] },
      intervalMs: 60000,
      batchSize: 100,
      dryRun: false,
      minAgeSeconds: 86400,
    });

    await worker.cleanup();

    assert.equal(mockClickHouse.deleteDataItemsByIds.mock.callCount(), 1);
    const passedIds =
      mockClickHouse.deleteDataItemsByIds.mock.calls[0].arguments[0];
    assert.equal(passedIds.length, 1);
    assert.equal(passedIds[0], toB64Url(id1));
  });

  it('should handle errors without crashing', async () => {
    const mockDb = createMockDb();
    mockDb.countIndexCleanupCandidates.mock.mockImplementation(async () => {
      throw new Error('Database error');
    });

    const worker = new IndexCleanupWorker({
      log: testLog,
      db: mockDb,
      filter: { owners: ['test-owner'] },
      intervalMs: 60000,
      batchSize: 100,
      dryRun: true,
      minAgeSeconds: 86400,
    });

    // Should not throw
    await worker.cleanup();
  });

  it('should start and stop cleanly', () => {
    const mockDb = createMockDb();

    const worker = new IndexCleanupWorker({
      log: testLog,
      db: mockDb,
      filter: { owners: ['test-owner'] },
      intervalMs: 60000,
      batchSize: 100,
      dryRun: true,
      minAgeSeconds: 86400,
    });

    worker.start();
    worker.stop();
  });
});
