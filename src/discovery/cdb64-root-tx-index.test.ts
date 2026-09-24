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
import { PartitionedCdb64Writer } from '../lib/partitioned-cdb64-writer.js';
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
      assert.equal(result.size, undefined);
      assert.equal(result.dataSize, undefined);

      await index.close();
    });

    it('should return the recorded item size as size, without dataSize', async () => {
      const cdbPath = path.join(tempDir, 'complete-with-size.cdb');
      const dataItemId = createTxId(3);
      const rootTxId = createTxId(210);

      const writer = new Cdb64Writer(cdbPath);
      await writer.open();
      await writer.add(
        dataItemId,
        encodeCdb64Value({
          rootTxId,
          rootDataItemOffset: 12345,
          rootDataOffset: 13000,
          dataItemSize: 2000,
        }),
      );
      await writer.finalize();

      const index = new Cdb64RootTxIndex({ log, sources: [cdbPath] });
      const result = await index.getRootTx(toB64Url(dataItemId));

      assert(result !== undefined);
      assert.equal(result.rootOffset, 12345);
      assert.equal(result.rootDataOffset, 13000);
      assert.equal(result.size, 2000);
      // Left unset on purpose: a result with dataSize is served without an
      // item-header read, which is the only way to recover the content type.
      assert.equal(result.dataSize, undefined);

      await index.close();
    });

    it('should return the recorded item size for path-complete values', async () => {
      const cdbPath = path.join(tempDir, 'path-complete-with-size.cdb');
      const dataItemId = createTxId(4);
      const rootTxId = createTxId(220);
      const parentId = createTxId(230);

      const writer = new Cdb64Writer(cdbPath);
      await writer.open();
      await writer.add(
        dataItemId,
        encodeCdb64Value({
          path: [rootTxId, parentId],
          rootDataItemOffset: 5000,
          rootDataOffset: 5512,
          dataItemSize: 9000,
        }),
      );
      await writer.finalize();

      const index = new Cdb64RootTxIndex({ log, sources: [cdbPath] });
      const result = await index.getRootTx(toB64Url(dataItemId));

      assert(result !== undefined);
      assert.equal(result.rootTxId, toB64Url(rootTxId));
      assert.deepEqual(result.path, [toB64Url(rootTxId), toB64Url(parentId)]);
      assert.equal(result.rootOffset, 5000);
      assert.equal(result.rootDataOffset, 5512);
      assert.equal(result.size, 9000);
      assert.equal(result.dataSize, undefined);

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

  describe('partitioned directory support', () => {
    // Helper to create a partitioned index
    const createPartitionedIndex = async (
      indexDir: string,
      entries: Array<{
        dataItemId: Buffer;
        rootTxId: Buffer;
        rootDataItemOffset?: number;
        rootDataOffset?: number;
      }>,
    ): Promise<void> => {
      const writer = new PartitionedCdb64Writer(indexDir);
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

    it('should load partitioned directory with manifest.json', async () => {
      const indexDir = path.join(tempDir, 'partitioned');
      const dataItemId = createTxId(1);
      const rootTxId = createTxId(100);

      await createPartitionedIndex(indexDir, [{ dataItemId, rootTxId }]);

      const index = new Cdb64RootTxIndex({ log, sources: [indexDir] });
      const result = await index.getRootTx(toB64Url(dataItemId));

      assert(result !== undefined);
      assert.equal(result.rootTxId, toB64Url(rootTxId));

      await index.close();
    });

    it('should return undefined for missing key in partitioned index', async () => {
      const indexDir = path.join(tempDir, 'partitioned-missing');
      const existingId = createTxId(1);
      const missingId = createTxId(999);

      await createPartitionedIndex(indexDir, [
        { dataItemId: existingId, rootTxId: createTxId(100) },
      ]);

      const index = new Cdb64RootTxIndex({ log, sources: [indexDir] });
      const result = await index.getRootTx(toB64Url(missingId));

      assert.equal(result, undefined);

      await index.close();
    });

    it('should return complete format with offsets', async () => {
      const indexDir = path.join(tempDir, 'partitioned-complete');
      const dataItemId = createTxId(2);
      const rootTxId = createTxId(200);
      const rootDataItemOffset = 12345;
      const rootDataOffset = 67890;

      await createPartitionedIndex(indexDir, [
        { dataItemId, rootTxId, rootDataItemOffset, rootDataOffset },
      ]);

      const index = new Cdb64RootTxIndex({ log, sources: [indexDir] });
      const result = await index.getRootTx(toB64Url(dataItemId));

      assert(result !== undefined);
      assert.equal(result.rootTxId, toB64Url(rootTxId));
      assert.equal(result.rootOffset, rootDataItemOffset);
      assert.equal(result.rootDataOffset, rootDataOffset);

      await index.close();
    });

    it('should handle entries across multiple partitions', async () => {
      const indexDir = path.join(tempDir, 'partitioned-multi');

      // Create entries that will go to different partitions (different first bytes)
      const entries = [
        { dataItemId: Buffer.alloc(32, 0x00), rootTxId: createTxId(100) }, // partition 00
        { dataItemId: Buffer.alloc(32, 0x7f), rootTxId: createTxId(200) }, // partition 7f
        { dataItemId: Buffer.alloc(32, 0xff), rootTxId: createTxId(300) }, // partition ff
      ];
      // Set unique second bytes so keys differ
      entries[0].dataItemId[1] = 0x01;
      entries[1].dataItemId[1] = 0x02;
      entries[2].dataItemId[1] = 0x03;

      await createPartitionedIndex(indexDir, entries);

      const index = new Cdb64RootTxIndex({ log, sources: [indexDir] });

      for (const entry of entries) {
        const result = await index.getRootTx(toB64Url(entry.dataItemId));
        assert(result !== undefined);
        assert.equal(result.rootTxId, toB64Url(entry.rootTxId));
      }

      await index.close();
    });

    it('should return undefined for key in non-existent partition', async () => {
      const indexDir = path.join(tempDir, 'partitioned-sparse');

      // Create entry that goes to partition 0x00
      const existingId = Buffer.alloc(32, 0x00);
      existingId[1] = 0x01;

      await createPartitionedIndex(indexDir, [
        { dataItemId: existingId, rootTxId: createTxId(100) },
      ]);

      const index = new Cdb64RootTxIndex({ log, sources: [indexDir] });

      // Query for key in partition 0xff (which doesn't exist)
      const missingId = Buffer.alloc(32, 0xff);
      missingId[1] = 0x01;
      const result = await index.getRootTx(toB64Url(missingId));

      assert.equal(result, undefined);

      await index.close();
    });

    it('should prefer manifest.json over loose .cdb files', async () => {
      const indexDir = path.join(tempDir, 'manifest-priority');
      await fs.mkdir(indexDir);

      const dataItemId = createTxId(1);

      // Create a loose .cdb file first
      await createTestCdb(path.join(indexDir, 'loose.cdb'), [
        { dataItemId, rootTxId: createTxId(999) }, // This should be ignored
      ]);

      // Create partitioned index (creates manifest.json)
      const partitionedDir = path.join(tempDir, 'partitioned-temp');
      await createPartitionedIndex(partitionedDir, [
        { dataItemId, rootTxId: createTxId(100) }, // This should be used
      ]);

      // Copy manifest and partition to indexDir
      await fs.copyFile(
        path.join(partitionedDir, 'manifest.json'),
        path.join(indexDir, 'manifest.json'),
      );
      const partitionFiles = await fs.readdir(partitionedDir);
      for (const file of partitionFiles) {
        if (file.endsWith('.cdb')) {
          await fs.copyFile(
            path.join(partitionedDir, file),
            path.join(indexDir, file),
          );
        }
      }

      const index = new Cdb64RootTxIndex({ log, sources: [indexDir] });
      const result = await index.getRootTx(toB64Url(dataItemId));

      // Should get value from partitioned index, not loose.cdb
      assert(result !== undefined);
      assert.equal(result.rootTxId, toB64Url(createTxId(100)));

      await index.close();
    });

    it('should support mixed sources (partitioned + single file)', async () => {
      const partitionedDir = path.join(tempDir, 'mixed-partitioned');
      const singleCdb = path.join(tempDir, 'single.cdb');

      const partitionedId = createTxId(1);
      const singleFileId = createTxId(2);

      // Create partitioned index
      await createPartitionedIndex(partitionedDir, [
        { dataItemId: partitionedId, rootTxId: createTxId(100) },
      ]);

      // Create single CDB file
      await createTestCdb(singleCdb, [
        { dataItemId: singleFileId, rootTxId: createTxId(200) },
      ]);

      const index = new Cdb64RootTxIndex({
        log,
        sources: [partitionedDir, singleCdb],
      });

      // Should find entry from partitioned index
      const result1 = await index.getRootTx(toB64Url(partitionedId));
      assert(result1 !== undefined);
      assert.equal(result1.rootTxId, toB64Url(createTxId(100)));

      // Should find entry from single file
      const result2 = await index.getRootTx(toB64Url(singleFileId));
      assert(result2 !== undefined);
      assert.equal(result2.rootTxId, toB64Url(createTxId(200)));

      await index.close();
    });

    it('should handle empty partitioned index', async () => {
      const indexDir = path.join(tempDir, 'partitioned-empty');
      await createPartitionedIndex(indexDir, []);

      const index = new Cdb64RootTxIndex({ log, sources: [indexDir] });
      const result = await index.getRootTx(toB64Url(createTxId(1)));

      assert.equal(result, undefined);

      await index.close();
    });

    describe('manifest file watching', () => {
      const waitForWatcher = (ms: number) =>
        new Promise((resolve) => setTimeout(resolve, ms));

      it('should detect manifest.json changes', async () => {
        const indexDir = path.join(tempDir, 'watch-manifest');

        // Create initial partitioned index with one entry
        const initialId = Buffer.alloc(32, 0xab);
        initialId[1] = 0x01;
        await createPartitionedIndex(indexDir, [
          { dataItemId: initialId, rootTxId: createTxId(100) },
        ]);

        const index = new Cdb64RootTxIndex({
          log,
          sources: [indexDir],
          watch: true,
        });

        // Trigger initialization
        const result1 = await index.getRootTx(toB64Url(initialId));
        assert(result1 !== undefined);

        // New entry should not exist yet
        const newId = Buffer.alloc(32, 0xcd);
        newId[1] = 0x02;
        const beforeUpdate = await index.getRootTx(toB64Url(newId));
        assert.equal(beforeUpdate, undefined);

        // Create a new partitioned index in a temp location
        const tempIndexDir = path.join(tempDir, 'watch-manifest-temp');
        await createPartitionedIndex(tempIndexDir, [
          { dataItemId: initialId, rootTxId: createTxId(100) },
          { dataItemId: newId, rootTxId: createTxId(200) },
        ]);

        // Copy new partition files over existing ones (update in place)
        const newFiles = await fs.readdir(tempIndexDir);
        for (const file of newFiles) {
          await fs.copyFile(
            path.join(tempIndexDir, file),
            path.join(indexDir, file),
          );
        }

        // Wait for watcher to detect the manifest.json change
        await waitForWatcher(1500);

        // Should now find the new entry
        const afterUpdate = await index.getRootTx(toB64Url(newId));
        assert(afterUpdate !== undefined);
        assert.equal(afterUpdate.rootTxId, toB64Url(createTxId(200)));

        await index.close();
      });

      it('keeps answering throughout a reload under steady lookups', async () => {
        const indexDir = path.join(tempDir, 'watch-manifest-steady');
        const id = Buffer.alloc(32, 0xab);
        id[1] = 0x03;
        await createPartitionedIndex(indexDir, [
          { dataItemId: id, rootTxId: createTxId(300) },
        ]);

        // Short enough for a test, long enough that a reader still in the
        // lookup list would be closed with lookups in flight.
        const drainKey = 'READER_DRAIN_TIMEOUT_MS';
        const original = (Cdb64RootTxIndex as any)[drainKey];
        (Cdb64RootTxIndex as any)[drainKey] = 400;

        const index = new Cdb64RootTxIndex({
          log,
          sources: [indexDir],
          watch: true,
        });
        assert((await index.getRootTx(toB64Url(id))) !== undefined);

        let running = true;
        let misses = 0;
        let lookups = 0;
        // Several loops at once, so some lookup is nearly always in flight.
        const loops = Array.from({ length: 8 }, async () => {
          while (running) {
            const result = await index.getRootTx(toB64Url(id));
            lookups++;
            if (result === undefined) misses++;
          }
        });

        try {
          // Rebuild the band in place with the same record plus another.
          const rebuilt = path.join(tempDir, 'watch-manifest-steady-temp');
          const other = Buffer.alloc(32, 0xcd);
          other[1] = 0x04;
          await createPartitionedIndex(rebuilt, [
            { dataItemId: id, rootTxId: createTxId(300) },
            { dataItemId: other, rootTxId: createTxId(400) },
          ]);
          // Replace each file by rename, as an installer does, so the old
          // reader keeps its own bytes; the manifest goes last.
          const files = (await fs.readdir(rebuilt)).sort((x, y) =>
            x === 'manifest.json' ? 1 : y === 'manifest.json' ? -1 : 0,
          );
          for (const file of files) {
            await fs.rename(
              path.join(rebuilt, file),
              path.join(indexDir, file),
            );
          }
          // Until the new record is visible, then past the drain deadline.
          for (let i = 0; i < 60; i++) {
            if ((await index.getRootTx(toB64Url(other))) !== undefined) break;
            await waitForWatcher(50);
          }
          assert(
            (await index.getRootTx(toB64Url(other))) !== undefined,
            'the rebuilt band was loaded',
          );
          await waitForWatcher(600);
        } finally {
          running = false;
          await Promise.all(loops);
          (Cdb64RootTxIndex as any)[drainKey] = original;
          await index.close();
        }

        assert.ok(lookups > 100, `ran ${lookups} lookups`);
        assert.equal(misses, 0, 'a record in both versions never misses');
      });
    });
  });

  describe('collection directories', () => {
    /**
     * A collection is a directory whose immediate subdirectories are each a
     * partitioned index. Index bands published by another gateway are
     * installed and retired underneath one of these while the node runs, so
     * the readers have to follow without a restart.
     */
    const createBand = async (
      bandDir: string,
      entries: Array<{ dataItemId: Buffer; rootTxId: Buffer }>,
    ): Promise<void> => {
      const writer = new PartitionedCdb64Writer(bandDir);
      await writer.open();
      for (const entry of entries) {
        await writer.add(
          entry.dataItemId,
          encodeCdb64Value({ rootTxId: entry.rootTxId }),
        );
      }
      await writer.finalize();
    };

    /** Poll until a condition holds, so the tests do not race the watcher. */
    const waitFor = async (
      predicate: () => Promise<boolean>,
      timeoutMs = 8000,
    ): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    };

    /**
     * Install a band the way a subscriber does: build it elsewhere, then
     * rename it into place so the directory never exists half-written.
     */
    const installBand = async (
      collectionDir: string,
      stagingDir: string,
      bandName: string,
      entries: Array<{ dataItemId: Buffer; rootTxId: Buffer }>,
    ): Promise<void> => {
      await createBand(stagingDir, entries);
      await fs.rename(stagingDir, path.join(collectionDir, bandName));
    };

    it('loads every band in a collection directory', async () => {
      const collectionDir = path.join(tempDir, 'collection');
      await fs.mkdir(collectionDir, { recursive: true });

      const idA = createTxId(11);
      const idB = createTxId(22);
      await createBand(path.join(collectionDir, 'band-a'), [
        { dataItemId: idA, rootTxId: createTxId(101) },
      ]);
      await createBand(path.join(collectionDir, 'band-b'), [
        { dataItemId: idB, rootTxId: createTxId(102) },
      ]);

      const index = new Cdb64RootTxIndex({
        log,
        sources: [collectionDir],
        watch: false,
      });

      const resultA = await index.getRootTx(toB64Url(idA));
      const resultB = await index.getRootTx(toB64Url(idB));
      assert.equal(resultA?.rootTxId, toB64Url(createTxId(101)));
      assert.equal(resultB?.rootTxId, toB64Url(createTxId(102)));

      await index.close();
    });

    it('picks up a band installed while running, with no restart', async () => {
      const collectionDir = path.join(tempDir, 'collection-add');
      await fs.mkdir(collectionDir, { recursive: true });

      const existingId = createTxId(31);
      await createBand(path.join(collectionDir, 'band-existing'), [
        { dataItemId: existingId, rootTxId: createTxId(201) },
      ]);

      const index = new Cdb64RootTxIndex({
        log,
        sources: [collectionDir],
        watch: true,
      });

      // Initialize, and confirm the new band's key is not resolvable yet.
      assert(
        (await index.getRootTx(toB64Url(existingId))) !== undefined,
        'existing band should resolve',
      );
      const newId = createTxId(32);
      assert.equal(await index.getRootTx(toB64Url(newId)), undefined);

      await installBand(
        collectionDir,
        path.join(tempDir, 'staging-new'),
        'band-new',
        [{ dataItemId: newId, rootTxId: createTxId(202) }],
      );

      const found = await waitFor(
        async () => (await index.getRootTx(toB64Url(newId))) !== undefined,
      );
      assert(found, 'band installed at runtime should become resolvable');

      const result = await index.getRootTx(toB64Url(newId));
      assert.equal(result?.rootTxId, toB64Url(createTxId(202)));

      // The band that was already there is untouched.
      assert(
        (await index.getRootTx(toB64Url(existingId))) !== undefined,
        'existing band should still resolve',
      );

      await index.close();
    });

    it('reloads a band rebuilt in place, answering throughout', async () => {
      const collectionDir = path.join(tempDir, 'collection-rebuild');
      await fs.mkdir(collectionDir, { recursive: true });
      const bandDir = path.join(collectionDir, 'band-tip');
      const kept = createTxId(41);
      const added = createTxId(42);
      await createBand(bandDir, [
        { dataItemId: kept, rootTxId: createTxId(401) },
      ]);

      const drainKey = 'READER_DRAIN_TIMEOUT_MS';
      const original = (Cdb64RootTxIndex as any)[drainKey];
      (Cdb64RootTxIndex as any)[drainKey] = 400;
      const index = new Cdb64RootTxIndex({
        log,
        sources: [collectionDir],
        watch: true,
      });
      assert((await index.getRootTx(toB64Url(kept))) !== undefined);

      let running = true;
      let misses = 0;
      const loops = Array.from({ length: 8 }, async () => {
        while (running) {
          if ((await index.getRootTx(toB64Url(kept))) === undefined) misses++;
        }
      });
      try {
        // Rebuild the same band id in place: new files renamed over the
        // old ones, the manifest last, which the watcher sees as a change.
        const staging = path.join(tempDir, 'collection-rebuild-staging');
        await createBand(staging, [
          { dataItemId: kept, rootTxId: createTxId(401) },
          { dataItemId: added, rootTxId: createTxId(402) },
        ]);
        const files = (await fs.readdir(staging)).sort((x, y) =>
          x === 'manifest.json' ? 1 : y === 'manifest.json' ? -1 : 0,
        );
        for (const file of files) {
          await fs.rename(path.join(staging, file), path.join(bandDir, file));
        }
        assert(
          await waitFor(
            async () => (await index.getRootTx(toB64Url(added))) !== undefined,
          ),
          'the rebuilt band is loaded without a restart',
        );
        await new Promise((resolve) => setTimeout(resolve, 600));
      } finally {
        running = false;
        await Promise.all(loops);
        (Cdb64RootTxIndex as any)[drainKey] = original;
        await index.close();
      }
      assert.equal(misses, 0, 'a record in both versions never misses');
    });

    it('drops a band when it is retired', async () => {
      const collectionDir = path.join(tempDir, 'collection-remove');
      await fs.mkdir(collectionDir, { recursive: true });

      const keptId = createTxId(41);
      const goingId = createTxId(42);
      await createBand(path.join(collectionDir, 'band-kept'), [
        { dataItemId: keptId, rootTxId: createTxId(301) },
      ]);
      const goingDir = path.join(collectionDir, 'band-going');
      await createBand(goingDir, [
        { dataItemId: goingId, rootTxId: createTxId(302) },
      ]);

      const index = new Cdb64RootTxIndex({
        log,
        sources: [collectionDir],
        watch: true,
      });

      assert(
        (await index.getRootTx(toB64Url(goingId))) !== undefined,
        'band should resolve before removal',
      );

      await fs.rm(goingDir, { recursive: true, force: true });

      const dropped = await waitFor(
        async () => (await index.getRootTx(toB64Url(goingId))) === undefined,
      );
      assert(dropped, 'retired band should stop resolving');

      // Retiring one band must not disturb the others.
      const kept = await index.getRootTx(toB64Url(keptId));
      assert.equal(kept?.rootTxId, toB64Url(createTxId(301)));

      await index.close();
    });

    it('ignores a band directory that is still being written', async () => {
      const collectionDir = path.join(tempDir, 'collection-tmp');
      await fs.mkdir(collectionDir, { recursive: true });

      const readyId = createTxId(51);
      const partialId = createTxId(52);
      await createBand(path.join(collectionDir, 'band-ready'), [
        { dataItemId: readyId, rootTxId: createTxId(401) },
      ]);
      // A `.tmp` suffix marks a band mid-install; it must not be loaded even
      // though it already has a valid manifest.
      await createBand(path.join(collectionDir, 'band-partial.tmp'), [
        { dataItemId: partialId, rootTxId: createTxId(402) },
      ]);

      const index = new Cdb64RootTxIndex({
        log,
        sources: [collectionDir],
        watch: false,
      });

      assert(
        (await index.getRootTx(toB64Url(readyId))) !== undefined,
        'finished band should resolve',
      );
      assert.equal(
        await index.getRootTx(toB64Url(partialId)),
        undefined,
        'band still being written should be ignored',
      );

      await index.close();
    });

    it('serves a flat directory and a collection in the same source', async () => {
      // A directory may hold loose .cdb files, band subdirectories, or both.
      // Supporting both keeps an existing flat directory working unchanged.
      const mixedDir = path.join(tempDir, 'mixed');
      await fs.mkdir(mixedDir, { recursive: true });

      const looseId = createTxId(61);
      const bandId = createTxId(62);
      await createTestCdb(path.join(mixedDir, 'loose.cdb'), [
        { dataItemId: looseId, rootTxId: createTxId(501) },
      ]);
      await createBand(path.join(mixedDir, 'band-one'), [
        { dataItemId: bandId, rootTxId: createTxId(502) },
      ]);

      const index = new Cdb64RootTxIndex({
        log,
        sources: [mixedDir],
        watch: false,
      });

      assert.equal(
        (await index.getRootTx(toB64Url(looseId)))?.rootTxId,
        toB64Url(createTxId(501)),
      );
      assert.equal(
        (await index.getRootTx(toB64Url(bandId)))?.rootTxId,
        toB64Url(createTxId(502)),
      );

      await index.close();
    });

    it('watches every configured directory, not only the first', async () => {
      // Previously a single shared watcher meant the second and later
      // directory sources were never watched, and files added to them were
      // silently missed until the next restart.
      const firstDir = path.join(tempDir, 'watch-first');
      const secondDir = path.join(tempDir, 'watch-second');
      await fs.mkdir(firstDir, { recursive: true });
      await fs.mkdir(secondDir, { recursive: true });

      const firstId = createTxId(71);
      await createTestCdb(path.join(firstDir, 'first.cdb'), [
        { dataItemId: firstId, rootTxId: createTxId(601) },
      ]);
      const secondId = createTxId(72);
      await createTestCdb(path.join(secondDir, 'second.cdb'), [
        { dataItemId: secondId, rootTxId: createTxId(602) },
      ]);

      const index = new Cdb64RootTxIndex({
        log,
        sources: [firstDir, secondDir],
        watch: true,
      });

      assert(
        (await index.getRootTx(toB64Url(firstId))) !== undefined,
        'first directory should resolve',
      );

      // Add a file to the SECOND directory, the one that used to go unwatched.
      const lateId = createTxId(73);
      const stagedPath = path.join(tempDir, 'late-staged.cdb');
      await createTestCdb(stagedPath, [
        { dataItemId: lateId, rootTxId: createTxId(603) },
      ]);
      await fs.rename(stagedPath, path.join(secondDir, 'late.cdb'));

      const found = await waitFor(
        async () => (await index.getRootTx(toB64Url(lateId))) !== undefined,
      );
      assert(
        found,
        'a file added to a later directory source should be picked up',
      );

      await index.close();
    });

    describe('a directory source that does not exist yet', () => {
      /**
       * A subscriber's gateway usually starts before the sidecar has created
       * the install directory. The source has to be picked up when it
       * appears, not written off as a missing file.
       */
      const originalPollMs = Cdb64RootTxIndex.PENDING_DIRECTORY_POLL_MS;
      beforeEach(() => {
        Cdb64RootTxIndex.PENDING_DIRECTORY_POLL_MS = 50;
      });
      afterEach(() => {
        Cdb64RootTxIndex.PENDING_DIRECTORY_POLL_MS = originalPollMs;
      });

      it('loads it, and bands installed into it, once it appears', async () => {
        // Missing two levels deep, as installed/<index> is on a fresh volume.
        const collectionDir = path.join(tempDir, 'indexes', 'installed', 'x');
        const index = new Cdb64RootTxIndex({
          log,
          sources: [collectionDir],
          watch: true,
        });
        const firstId = createTxId(41);
        assert.equal(await index.getRootTx(toB64Url(firstId)), undefined);

        await fs.mkdir(collectionDir, { recursive: true });
        await installBand(
          collectionDir,
          path.join(tempDir, 'staging-first'),
          'band-first',
          [{ dataItemId: firstId, rootTxId: createTxId(211) }],
        );
        assert(
          await waitFor(
            async () =>
              (await index.getRootTx(toB64Url(firstId))) !== undefined,
          ),
          'band in a directory that appeared later should resolve',
        );

        // And the collection watcher is live from then on.
        const secondId = createTxId(42);
        await installBand(
          collectionDir,
          path.join(tempDir, 'staging-second'),
          'band-second',
          [{ dataItemId: secondId, rootTxId: createTxId(212) }],
        );
        assert(
          await waitFor(
            async () =>
              (await index.getRootTx(toB64Url(secondId))) !== undefined,
          ),
          'band installed after the directory appeared should resolve',
        );

        await index.close();
      });

      it('keeps configured order when the late source loads', async () => {
        const lateDir = path.join(tempDir, 'late');
        const presentDir = path.join(tempDir, 'present');
        const id = createTxId(43);
        await createBand(path.join(presentDir, 'band'), [
          { dataItemId: id, rootTxId: createTxId(221) },
        ]);

        // The late source is configured first, so once it loads it must win.
        const index = new Cdb64RootTxIndex({
          log,
          sources: [lateDir, presentDir],
          watch: true,
        });
        const before = await index.getRootTx(toB64Url(id));
        assert.equal(before?.rootTxId, toB64Url(createTxId(221)));

        await fs.mkdir(lateDir, { recursive: true });
        await installBand(lateDir, path.join(tempDir, 'staging-late'), 'band', [
          { dataItemId: id, rootTxId: createTxId(222) },
        ]);
        assert(
          await waitFor(
            async () =>
              (await index.getRootTx(toB64Url(id)))?.rootTxId ===
              toB64Url(createTxId(222)),
          ),
          'the earlier-configured source should take precedence once loaded',
        );

        await index.close();
      });

      it('stops waiting when closed', async () => {
        const collectionDir = path.join(tempDir, 'never');
        const index = new Cdb64RootTxIndex({
          log,
          sources: [collectionDir],
          watch: true,
        });
        await index.getRootTx(toB64Url(createTxId(44)));
        assert.equal((index as any).pendingDirectories.size, 1);

        await index.close();
        assert.equal((index as any).pendingDirectories.size, 0);

        // Appearing after close loads nothing and starts no watcher.
        await fs.mkdir(collectionDir, { recursive: true });
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal((index as any).watchers.size, 0);
      });

      it('does not wait for a missing file named like one', async () => {
        const index = new Cdb64RootTxIndex({
          log,
          sources: [path.join(tempDir, 'missing.cdb')],
          watch: true,
        });
        await index.getRootTx(toB64Url(createTxId(45)));
        assert.equal((index as any).pendingDirectories.size, 0);
        await index.close();
      });

      it('does not wait when watching is off', async () => {
        const index = new Cdb64RootTxIndex({
          log,
          sources: [path.join(tempDir, 'absent')],
          watch: false,
        });
        await index.getRootTx(toB64Url(createTxId(46)));
        assert.equal((index as any).pendingDirectories.size, 0);
        await index.close();
      });
    });
  });
});
