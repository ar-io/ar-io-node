/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { Cdb64RootTxIndex } from './cdb64-root-tx-index.js';
import { Cdb64Writer } from '../lib/cdb64.js';
import { encodeCdb64Value } from '../lib/cdb64-encoding.js';
import { toB64Url } from '../lib/encoding.js';
import { createTestLogger } from '../../test/test-logger.js';

const log = createTestLogger({ suite: 'Cdb64RootTxIndex' });

describe('Cdb64RootTxIndex', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cdb64-index-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // Helper to create a 32-byte buffer from a seed
  const createTxId = (seed: number): Buffer => {
    const buf = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) {
      buf[i] = (seed + i) % 256;
    }
    return buf;
  };

  // Helper to create a test CDB64 file with given entries
  const createTestCdb = async (
    cdbPath: string,
    entries: Array<{
      dataItemId: Buffer;
      rootTxId: Buffer;
      rootDataItemOffset?: number;
      rootDataOffset?: number;
    }>,
  ): Promise<void> => {
    const writer = new Cdb64Writer(cdbPath);
    await writer.open();

    for (const entry of entries) {
      const value =
        entry.rootDataItemOffset !== undefined &&
        entry.rootDataOffset !== undefined
          ? {
              rootTxId: entry.rootTxId,
              rootDataItemOffset: entry.rootDataItemOffset,
              rootDataOffset: entry.rootDataOffset,
            }
          : { rootTxId: entry.rootTxId };

      await writer.add(entry.dataItemId, encodeCdb64Value(value));
    }

    await writer.finalize();
  };

  describe('constructor', () => {
    it('should implement DataItemRootIndex interface', async () => {
      const cdbPath = path.join(tempDir, 'test.cdb');
      await createTestCdb(cdbPath, []);

      const index = new Cdb64RootTxIndex({ log, sources: [cdbPath] });
      assert(typeof index.getRootTx === 'function');
      await index.close();
    });
  });

  describe('getRootTx', () => {
    it('should return root TX info for existing data item (simple format)', async () => {
      const cdbPath = path.join(tempDir, 'simple.cdb');
      const dataItemId = createTxId(1);
      const rootTxId = createTxId(100);

      await createTestCdb(cdbPath, [{ dataItemId, rootTxId }]);

      const index = new Cdb64RootTxIndex({ log, sources: [cdbPath] });
      const result = await index.getRootTx(toB64Url(dataItemId));

      assert(result !== undefined);
      assert.equal(result.rootTxId, toB64Url(rootTxId));
      assert.equal(result.rootOffset, undefined);
      assert.equal(result.rootDataOffset, undefined);

      await index.close();
    });

    it('should return root TX info with offsets (complete format)', async () => {
      const cdbPath = path.join(tempDir, 'complete.cdb');
      const dataItemId = createTxId(2);
      const rootTxId = createTxId(200);
      const rootDataItemOffset = 12345;
      const rootDataOffset = 67890;

      await createTestCdb(cdbPath, [
        { dataItemId, rootTxId, rootDataItemOffset, rootDataOffset },
      ]);

      const index = new Cdb64RootTxIndex({ log, sources: [cdbPath] });
      const result = await index.getRootTx(toB64Url(dataItemId));

      assert(result !== undefined);
      assert.equal(result.rootTxId, toB64Url(rootTxId));
      assert.equal(result.rootOffset, rootDataItemOffset);
      assert.equal(result.rootDataOffset, rootDataOffset);

      await index.close();
    });

    it('should return undefined for missing data item', async () => {
      const cdbPath = path.join(tempDir, 'missing.cdb');
      const existingId = createTxId(1);
      const missingId = createTxId(999);

      await createTestCdb(cdbPath, [
        { dataItemId: existingId, rootTxId: createTxId(100) },
      ]);

      const index = new Cdb64RootTxIndex({ log, sources: [cdbPath] });
      const result = await index.getRootTx(toB64Url(missingId));

      assert.equal(result, undefined);

      await index.close();
    });

    it('should handle multiple lookups', async () => {
      const cdbPath = path.join(tempDir, 'multiple.cdb');
      const entries = [
        { dataItemId: createTxId(1), rootTxId: createTxId(100) },
        {
          dataItemId: createTxId(2),
          rootTxId: createTxId(200),
          rootDataItemOffset: 1000,
          rootDataOffset: 2000,
        },
        { dataItemId: createTxId(3), rootTxId: createTxId(300) },
      ];

      await createTestCdb(cdbPath, entries);

      const index = new Cdb64RootTxIndex({ log, sources: [cdbPath] });

      // Test all entries
      for (const entry of entries) {
        const result = await index.getRootTx(toB64Url(entry.dataItemId));
        assert(result !== undefined);
        assert.equal(result.rootTxId, toB64Url(entry.rootTxId));
      }

      // Test missing entry
      const missingResult = await index.getRootTx(toB64Url(createTxId(999)));
      assert.equal(missingResult, undefined);

      await index.close();
    });

    it('should return undefined when CDB file does not exist', async () => {
      const cdbPath = path.join(tempDir, 'nonexistent.cdb');

      const index = new Cdb64RootTxIndex({ log, sources: [cdbPath] });
      try {
        const result = await index.getRootTx(toB64Url(createTxId(1)));
        assert.equal(result, undefined);
      } finally {
        await index.close();
      }
    });

    it('should return undefined for invalid ID length', async () => {
      const cdbPath = path.join(tempDir, 'valid.cdb');
      await createTestCdb(cdbPath, [
        { dataItemId: createTxId(1), rootTxId: createTxId(100) },
      ]);

      const index = new Cdb64RootTxIndex({ log, sources: [cdbPath] });

      // Use a short ID (not 32 bytes when decoded)
      const shortId = toB64Url(Buffer.from('short'));
      const result = await index.getRootTx(shortId);

      assert.equal(result, undefined);

      await index.close();
    });

    it('should initialize lazily on first lookup', async () => {
      const cdbPath = path.join(tempDir, 'lazy.cdb');
      const dataItemId = createTxId(1);
      const rootTxId = createTxId(100);

      await createTestCdb(cdbPath, [{ dataItemId, rootTxId }]);

      const index = new Cdb64RootTxIndex({ log, sources: [cdbPath] });

      // First lookup should trigger initialization
      const result1 = await index.getRootTx(toB64Url(dataItemId));
      assert(result1 !== undefined);

      // Second lookup should use already-initialized reader
      const result2 = await index.getRootTx(toB64Url(dataItemId));
      assert(result2 !== undefined);
      assert.equal(result1.rootTxId, result2.rootTxId);

      await index.close();
    });
  });

  describe('close', () => {
    it('should close without error when initialized', async () => {
      const cdbPath = path.join(tempDir, 'close.cdb');
      await createTestCdb(cdbPath, [
        { dataItemId: createTxId(1), rootTxId: createTxId(100) },
      ]);

      const index = new Cdb64RootTxIndex({ log, sources: [cdbPath] });

      // Trigger initialization
      await index.getRootTx(toB64Url(createTxId(1)));

      // Close should succeed
      await index.close();
    });

    it('should close without error when not initialized', async () => {
      const cdbPath = path.join(tempDir, 'uninitialized.cdb');

      const index = new Cdb64RootTxIndex({ log, sources: [cdbPath] });

      // Close without ever calling getRootTx
      await index.close();
    });
  });

  describe('directory support', () => {
    it('should load all .cdb files from a directory', async () => {
      const cdbDir = path.join(tempDir, 'multi');
      await fs.mkdir(cdbDir);

      // Create two CDB files with different entries
      await createTestCdb(path.join(cdbDir, 'a.cdb'), [
        { dataItemId: createTxId(1), rootTxId: createTxId(100) },
      ]);
      await createTestCdb(path.join(cdbDir, 'b.cdb'), [
        { dataItemId: createTxId(2), rootTxId: createTxId(200) },
      ]);

      const index = new Cdb64RootTxIndex({ log, sources: [cdbDir] });

      // Should find entries from both files
      const result1 = await index.getRootTx(toB64Url(createTxId(1)));
      assert(result1 !== undefined);
      assert.equal(result1.rootTxId, toB64Url(createTxId(100)));

      const result2 = await index.getRootTx(toB64Url(createTxId(2)));
      assert(result2 !== undefined);
      assert.equal(result2.rootTxId, toB64Url(createTxId(200)));

      // Should return undefined for missing
      const result3 = await index.getRootTx(toB64Url(createTxId(999)));
      assert.equal(result3, undefined);

      await index.close();
    });

    it('should use first match when key exists in multiple files', async () => {
      const cdbDir = path.join(tempDir, 'overlap');
      await fs.mkdir(cdbDir);

      const dataItemId = createTxId(1);

      // Create two CDB files with same key but different values
      // Files are searched in alphabetical order, so a.cdb should win
      await createTestCdb(path.join(cdbDir, 'a.cdb'), [
        { dataItemId, rootTxId: createTxId(100) }, // This should be returned
      ]);
      await createTestCdb(path.join(cdbDir, 'b.cdb'), [
        { dataItemId, rootTxId: createTxId(200) }, // This should be ignored
      ]);

      const index = new Cdb64RootTxIndex({ log, sources: [cdbDir] });
      const result = await index.getRootTx(toB64Url(dataItemId));

      assert(result !== undefined);
      assert.equal(result.rootTxId, toB64Url(createTxId(100)));

      await index.close();
    });

    it('should search files in alphabetical order', async () => {
      const cdbDir = path.join(tempDir, 'order');
      await fs.mkdir(cdbDir);

      const dataItemId = createTxId(1);

      // Create files in reverse alphabetical order to verify sorting
      await createTestCdb(path.join(cdbDir, 'z.cdb'), [
        { dataItemId, rootTxId: createTxId(300) },
      ]);
      await createTestCdb(path.join(cdbDir, 'm.cdb'), [
        { dataItemId, rootTxId: createTxId(200) },
      ]);
      await createTestCdb(path.join(cdbDir, 'a.cdb'), [
        { dataItemId, rootTxId: createTxId(100) }, // First alphabetically
      ]);

      const index = new Cdb64RootTxIndex({ log, sources: [cdbDir] });
      const result = await index.getRootTx(toB64Url(dataItemId));

      // Should get result from a.cdb (first alphabetically)
      assert(result !== undefined);
      assert.equal(result.rootTxId, toB64Url(createTxId(100)));

      await index.close();
    });

    it('should handle empty directory', async () => {
      const cdbDir = path.join(tempDir, 'empty');
      await fs.mkdir(cdbDir);

      const index = new Cdb64RootTxIndex({ log, sources: [cdbDir] });
      const result = await index.getRootTx(toB64Url(createTxId(1)));

      assert.equal(result, undefined);

      await index.close();
    });

    it('should ignore non-.cdb files in directory', async () => {
      const cdbDir = path.join(tempDir, 'mixed');
      await fs.mkdir(cdbDir);

      // Create a valid CDB file
      await createTestCdb(path.join(cdbDir, 'valid.cdb'), [
        { dataItemId: createTxId(1), rootTxId: createTxId(100) },
      ]);

      // Create some non-CDB files
      await fs.writeFile(path.join(cdbDir, 'readme.txt'), 'test');
      await fs.writeFile(path.join(cdbDir, 'data.json'), '{}');

      const index = new Cdb64RootTxIndex({ log, sources: [cdbDir] });
      const result = await index.getRootTx(toB64Url(createTxId(1)));

      assert(result !== undefined);
      assert.equal(result.rootTxId, toB64Url(createTxId(100)));

      await index.close();
    });

    it('should maintain backward compatibility with single file path', async () => {
      const cdbPath = path.join(tempDir, 'single.cdb');
      await createTestCdb(cdbPath, [
        { dataItemId: createTxId(1), rootTxId: createTxId(100) },
      ]);

      const index = new Cdb64RootTxIndex({ log, sources: [cdbPath] });
      const result = await index.getRootTx(toB64Url(createTxId(1)));

      assert(result !== undefined);
      assert.equal(result.rootTxId, toB64Url(createTxId(100)));

      await index.close();
    });
  });

  describe('file watching', () => {
    // Helper to wait for watcher events to be processed
    const waitForWatcher = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));

    it('should detect new .cdb files added at runtime', async () => {
      const cdbDir = path.join(tempDir, 'watch-add');
      await fs.mkdir(cdbDir);

      // Create initial CDB file
      await createTestCdb(path.join(cdbDir, 'initial.cdb'), [
        { dataItemId: createTxId(1), rootTxId: createTxId(100) },
      ]);

      const index = new Cdb64RootTxIndex({
        log,
        sources: [cdbDir],
        watch: true,
      });

      // Trigger initialization
      const result1 = await index.getRootTx(toB64Url(createTxId(1)));
      assert(result1 !== undefined);

      // Entry from new file should not exist yet
      const beforeAdd = await index.getRootTx(toB64Url(createTxId(2)));
      assert.equal(beforeAdd, undefined);

      // Add a new CDB file at runtime
      await createTestCdb(path.join(cdbDir, 'added.cdb'), [
        { dataItemId: createTxId(2), rootTxId: createTxId(200) },
      ]);

      // Wait for watcher to detect and process the new file
      // awaitWriteFinish has 1000ms stability threshold + some processing time
      await waitForWatcher(1500);

      // Should now find the new entry
      const afterAdd = await index.getRootTx(toB64Url(createTxId(2)));
      assert(afterAdd !== undefined);
      assert.equal(afterAdd.rootTxId, toB64Url(createTxId(200)));

      await index.close();
    });

    it('should detect .cdb files removed at runtime', async () => {
      const cdbDir = path.join(tempDir, 'watch-remove');
      await fs.mkdir(cdbDir);

      const removablePath = path.join(cdbDir, 'removable.cdb');

      // Create initial CDB files
      await createTestCdb(path.join(cdbDir, 'permanent.cdb'), [
        { dataItemId: createTxId(1), rootTxId: createTxId(100) },
      ]);
      await createTestCdb(removablePath, [
        { dataItemId: createTxId(2), rootTxId: createTxId(200) },
      ]);

      const index = new Cdb64RootTxIndex({
        log,
        sources: [cdbDir],
        watch: true,
      });

      // Trigger initialization and verify both entries exist
      const result1 = await index.getRootTx(toB64Url(createTxId(1)));
      assert(result1 !== undefined);

      const result2 = await index.getRootTx(toB64Url(createTxId(2)));
      assert(result2 !== undefined);

      // Remove one CDB file
      await fs.unlink(removablePath);

      // Wait for watcher to detect the removal
      await waitForWatcher(1500);

      // Entry from removed file should no longer be found
      const afterRemove = await index.getRootTx(toB64Url(createTxId(2)));
      assert.equal(afterRemove, undefined);

      // Entry from remaining file should still work
      const stillExists = await index.getRootTx(toB64Url(createTxId(1)));
      assert(stillExists !== undefined);

      await index.close();
    });

    it('should not watch when watch option is false', async () => {
      const cdbDir = path.join(tempDir, 'watch-disabled');
      await fs.mkdir(cdbDir);

      // Create initial CDB file
      await createTestCdb(path.join(cdbDir, 'initial.cdb'), [
        { dataItemId: createTxId(1), rootTxId: createTxId(100) },
      ]);

      const index = new Cdb64RootTxIndex({
        log,
        sources: [cdbDir],
        watch: false,
      });

      // Trigger initialization
      await index.getRootTx(toB64Url(createTxId(1)));

      // Add a new CDB file
      await createTestCdb(path.join(cdbDir, 'added.cdb'), [
        { dataItemId: createTxId(2), rootTxId: createTxId(200) },
      ]);

      // Wait a bit
      await waitForWatcher(1500);

      // New file should NOT be detected since watching is disabled
      const result = await index.getRootTx(toB64Url(createTxId(2)));
      assert.equal(result, undefined);

      await index.close();
    });

    it('should not watch when path is a single file', async () => {
      const cdbPath = path.join(tempDir, 'single-file.cdb');
      await createTestCdb(cdbPath, [
        { dataItemId: createTxId(1), rootTxId: createTxId(100) },
      ]);

      // Even with watch: true, single file paths should not start a watcher
      const index = new Cdb64RootTxIndex({
        log,
        sources: [cdbPath],
        watch: true,
      });

      // Trigger initialization
      const result = await index.getRootTx(toB64Url(createTxId(1)));
      assert(result !== undefined);

      // Close should succeed without watcher cleanup issues
      await index.close();
    });

    it('should properly close watcher on shutdown', async () => {
      const cdbDir = path.join(tempDir, 'watch-close');
      await fs.mkdir(cdbDir);

      await createTestCdb(path.join(cdbDir, 'test.cdb'), [
        { dataItemId: createTxId(1), rootTxId: createTxId(100) },
      ]);

      const index = new Cdb64RootTxIndex({
        log,
        sources: [cdbDir],
        watch: true,
      });

      // Trigger initialization to start watcher
      await index.getRootTx(toB64Url(createTxId(1)));

      // Close should properly clean up the watcher
      await index.close();

      // Adding a file after close should not cause any issues
      await createTestCdb(path.join(cdbDir, 'after-close.cdb'), [
        { dataItemId: createTxId(2), rootTxId: createTxId(200) },
      ]);

      // Wait to ensure no watcher callbacks fire
      await waitForWatcher(1500);
    });

    it('should maintain alphabetical order when files are added', async () => {
      const cdbDir = path.join(tempDir, 'watch-order');
      await fs.mkdir(cdbDir);

      const dataItemId = createTxId(1);

      // Create initial file 'c.cdb' with the key
      await createTestCdb(path.join(cdbDir, 'c.cdb'), [
        { dataItemId, rootTxId: createTxId(300) },
      ]);

      const index = new Cdb64RootTxIndex({
        log,
        sources: [cdbDir],
        watch: true,
      });

      // Should get value from c.cdb
      let result = await index.getRootTx(toB64Url(dataItemId));
      assert(result !== undefined);
      assert.equal(result.rootTxId, toB64Url(createTxId(300)));

      // Add 'a.cdb' with same key but different value (should win alphabetically)
      await createTestCdb(path.join(cdbDir, 'a.cdb'), [
        { dataItemId, rootTxId: createTxId(100) },
      ]);

      await waitForWatcher(1500);

      // Should now get value from a.cdb (first alphabetically)
      result = await index.getRootTx(toB64Url(dataItemId));
      assert(result !== undefined);
      assert.equal(result.rootTxId, toB64Url(createTxId(100)));

      await index.close();
    });
  });
});
