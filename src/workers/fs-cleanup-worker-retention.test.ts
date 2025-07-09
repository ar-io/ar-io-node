/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it, before, afterEach, mock } from 'node:test';
import winston from 'winston';
import { FsCleanupWorker } from './fs-cleanup-worker.js';
import fs from 'node:fs';
import path from 'node:path';

describe('FsCleanupWorker with retention policies', () => {
  let log: winston.Logger;
  const testBasePath = './test-cleanup-data';

  before(() => {
    log = winston.createLogger({ silent: true });
    // Create test directory
    if (!fs.existsSync(testBasePath)) {
      fs.mkdirSync(testBasePath, { recursive: true });
    }
  });

  afterEach(() => {
    mock.restoreAll();
    // Clean up test files
    if (fs.existsSync(testBasePath)) {
      fs.rmSync(testBasePath, { recursive: true, force: true });
      fs.mkdirSync(testBasePath, { recursive: true });
    }
  });

  describe('shouldDelete callback with retention policies', () => {
    it('should not delete files with active retention policy', async () => {
      const mockShouldDelete = mock.fn(async (path: string) => {
        const hash = path.split('/').pop();
        // Simulate a file with 7-year retention
        if (hash === 'retained-file') {
          return false; // Has active retention
        }
        return true; // No retention
      });

      const deleteCallback = mock.fn();

      const worker = new FsCleanupWorker({
        log,
        basePath: testBasePath,
        dataType: 'test',
        shouldDelete: mockShouldDelete,
        deleteCallback,
        batchSize: 10,
        pauseDuration: 0,
      });

      // Create test files
      const retainedFile = path.join(testBasePath, 'retained-file');
      const normalFile = path.join(testBasePath, 'normal-file');
      fs.writeFileSync(retainedFile, 'data');
      fs.writeFileSync(normalFile, 'data');

      // Process one batch
      await worker.processBatch();

      // Verify shouldDelete was called for both files
      assert.equal(mockShouldDelete.mock.calls.length, 2);

      // Verify only the normal file was deleted
      assert.equal(deleteCallback.mock.calls.length, 1);
      assert.ok(
        deleteCallback.mock.calls[0].arguments[0].includes('normal-file'),
      );
    });

    it('should delete files with expired retention policy', async () => {
      const now = Date.now();
      const mockShouldDelete = mock.fn(async (path: string) => {
        const hash = path.split('/').pop();

        // Simulate checking retention in database
        if (hash === 'expired-retention') {
          // Policy expired yesterday
          return true;
        } else if (hash === 'active-retention') {
          // Policy expires tomorrow
          return false;
        }
        return true;
      });

      const deleteCallback = mock.fn();

      const worker = new FsCleanupWorker({
        log,
        basePath: testBasePath,
        dataType: 'test',
        shouldDelete: mockShouldDelete,
        deleteCallback,
        batchSize: 10,
        pauseDuration: 0,
      });

      // Create test files
      fs.writeFileSync(path.join(testBasePath, 'expired-retention'), 'data');
      fs.writeFileSync(path.join(testBasePath, 'active-retention'), 'data');
      fs.writeFileSync(path.join(testBasePath, 'no-retention'), 'data');

      await worker.processBatch();

      // Should delete expired and no-retention files
      assert.equal(deleteCallback.mock.calls.length, 2);
      const deletedFiles = deleteCallback.mock.calls.map((call) =>
        path.basename(call.arguments[0]),
      );
      assert.ok(deletedFiles.includes('expired-retention'));
      assert.ok(deletedFiles.includes('no-retention'));
      assert.ok(!deletedFiles.includes('active-retention'));
    });

    it('should handle errors in retention check gracefully', async () => {
      const mockShouldDelete = mock.fn(async (path: string) => {
        const hash = path.split('/').pop();

        if (hash === 'error-file') {
          throw new Error('Database error');
        }
        return true;
      });

      const deleteCallback = mock.fn();

      const worker = new FsCleanupWorker({
        log,
        basePath: testBasePath,
        dataType: 'test',
        shouldDelete: mockShouldDelete,
        deleteCallback,
        batchSize: 10,
        pauseDuration: 0,
      });

      // Create test files
      fs.writeFileSync(path.join(testBasePath, 'error-file'), 'data');
      fs.writeFileSync(path.join(testBasePath, 'normal-file'), 'data');

      await worker.processBatch();

      // Should continue processing despite error
      assert.equal(deleteCallback.mock.calls.length, 1);
      assert.ok(
        deleteCallback.mock.calls[0].arguments[0].includes('normal-file'),
      );
    });

    it('should respect both retention policy and access time', async () => {
      const mockShouldDelete = mock.fn(async (path: string) => {
        const hash = path.split('/').pop();
        const stats = await fs.promises.stat(path);

        // Check retention first
        if (hash === 'retained-old-file') {
          // Has retention policy, ignore access time
          return false;
        }

        // No retention, check access time (older than 1 hour)
        const oneHourAgo = Date.now() - 60 * 60 * 1000;
        return stats.atime.getTime() < oneHourAgo;
      });

      const deleteCallback = mock.fn();

      const worker = new FsCleanupWorker({
        log,
        basePath: testBasePath,
        dataType: 'test',
        shouldDelete: mockShouldDelete,
        deleteCallback,
        batchSize: 10,
        pauseDuration: 0,
      });

      // Create test files
      const retainedOld = path.join(testBasePath, 'retained-old-file');
      const recentFile = path.join(testBasePath, 'recent-file');
      const oldFile = path.join(testBasePath, 'old-file');

      fs.writeFileSync(retainedOld, 'data');
      fs.writeFileSync(recentFile, 'data');
      fs.writeFileSync(oldFile, 'data');

      // Make old files have old access time
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      fs.utimesSync(retainedOld, twoHoursAgo, twoHoursAgo);
      fs.utimesSync(oldFile, twoHoursAgo, twoHoursAgo);

      await worker.processBatch();

      // Should only delete the old file without retention
      assert.equal(deleteCallback.mock.calls.length, 1);
      assert.ok(deleteCallback.mock.calls[0].arguments[0].includes('old-file'));
    });
  });

  describe('metrics tracking with retention', () => {
    it('should correctly track kept files with retention policies', async () => {
      const keptCount = 0;
      const keptSize = 0;

      const mockShouldDelete = mock.fn(async (path: string) => {
        const hash = path.split('/').pop();
        // Keep files with 'keep' in name (simulating retention)
        return !hash?.includes('keep');
      });

      const worker = new FsCleanupWorker({
        log,
        basePath: testBasePath,
        dataType: 'test',
        shouldDelete: mockShouldDelete,
        deleteCallback: mock.fn(),
        batchSize: 10,
        pauseDuration: 0,
      });

      // Create test files
      fs.writeFileSync(path.join(testBasePath, 'keep-1'), 'retained data 1');
      fs.writeFileSync(path.join(testBasePath, 'keep-2'), 'retained data 22');
      fs.writeFileSync(path.join(testBasePath, 'delete-1'), 'delete me');

      const result = await worker['getBatch'](testBasePath, null);

      // Should track the kept files
      assert.equal(result.keptFileCount, 2);
      assert.equal(result.keptFileSize, 15 + 16); // sizes of kept files
      assert.equal(result.batch.length, 1); // files to delete
    });
  });
});
