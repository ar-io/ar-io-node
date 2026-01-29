/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { PartitionedCdb64Reader } from './partitioned-cdb64-reader.js';
import { PartitionedCdb64Writer } from './partitioned-cdb64-writer.js';
import { Cdb64Manifest, parseManifest } from './cdb64-manifest.js';

describe('PartitionedCdb64Reader', () => {
  let tempDir: string;
  let indexDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'partitioned-reader-test-'),
    );
    indexDir = path.join(tempDir, 'index');
  });

  afterEach(async () => {
    mock.restoreAll();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // Helper to create a test index
  async function createTestIndex(
    records: { key: Buffer; value: Buffer }[],
  ): Promise<Cdb64Manifest> {
    const writer = new PartitionedCdb64Writer(indexDir);
    await writer.open();
    for (const { key, value } of records) {
      await writer.add(key, value);
    }
    return writer.finalize();
  }

  describe('open', () => {
    it('should open successfully', async () => {
      const manifest = await createTestIndex([]);
      const reader = new PartitionedCdb64Reader({
        manifest,
        baseDir: indexDir,
      });

      await reader.open();
      assert.strictEqual(reader.isOpen(), true);
      await reader.close();
    });
  });

  describe('get', () => {
    it('should throw if not opened', async () => {
      const manifest = await createTestIndex([]);
      const reader = new PartitionedCdb64Reader({
        manifest,
        baseDir: indexDir,
      });

      await assert.rejects(
        async () => reader.get(Buffer.from([0x00, 0x01, 0x02])),
        /Reader not opened/,
      );
    });

    it('should throw for empty key', async () => {
      const manifest = await createTestIndex([]);
      const reader = new PartitionedCdb64Reader({
        manifest,
        baseDir: indexDir,
      });
      await reader.open();

      await assert.rejects(
        async () => reader.get(Buffer.alloc(0)),
        /Key must be at least 1 byte/,
      );

      await reader.close();
    });

    it('should return undefined for missing partition', async () => {
      // Create index with only partition 0x00
      const manifest = await createTestIndex([
        {
          key: Buffer.from([0x00, 0x01, 0x02, 0x03]),
          value: Buffer.from('test'),
        },
      ]);

      const reader = new PartitionedCdb64Reader({
        manifest,
        baseDir: indexDir,
      });
      await reader.open();

      // Query for key in non-existent partition 0xff
      const result = await reader.get(Buffer.from([0xff, 0x01, 0x02, 0x03]));
      assert.strictEqual(result, undefined);

      await reader.close();
    });

    it('should return undefined for missing key in existing partition', async () => {
      const manifest = await createTestIndex([
        {
          key: Buffer.from([0x00, 0x01, 0x02, 0x03]),
          value: Buffer.from('test'),
        },
      ]);

      const reader = new PartitionedCdb64Reader({
        manifest,
        baseDir: indexDir,
      });
      await reader.open();

      // Query for different key in same partition
      const result = await reader.get(Buffer.from([0x00, 0xff, 0xff, 0xff]));
      assert.strictEqual(result, undefined);

      await reader.close();
    });

    it('should find existing key', async () => {
      const key = Buffer.from([0xab, 0x01, 0x02, 0x03, 0x04, 0x05]);
      const value = Buffer.from('hello world');

      const manifest = await createTestIndex([{ key, value }]);

      const reader = new PartitionedCdb64Reader({
        manifest,
        baseDir: indexDir,
      });
      await reader.open();

      const result = await reader.get(key);
      assert.notStrictEqual(result, undefined);
      assert.strictEqual(result!.toString(), 'hello world');

      await reader.close();
    });

    it('should handle multiple partitions', async () => {
      const records = [
        {
          key: Buffer.from([0x00, 0x01, 0x02, 0x03]),
          value: Buffer.from('value-00'),
        },
        {
          key: Buffer.from([0x7f, 0x01, 0x02, 0x03]),
          value: Buffer.from('value-7f'),
        },
        {
          key: Buffer.from([0xff, 0x01, 0x02, 0x03]),
          value: Buffer.from('value-ff'),
        },
      ];

      const manifest = await createTestIndex(records);

      const reader = new PartitionedCdb64Reader({
        manifest,
        baseDir: indexDir,
      });
      await reader.open();

      for (const { key, value } of records) {
        const result = await reader.get(key);
        assert.notStrictEqual(result, undefined);
        assert.strictEqual(result!.toString(), value.toString());
      }

      await reader.close();
    });

    it('should lazily open partitions', async () => {
      const records = [
        {
          key: Buffer.from([0x00, 0x01, 0x02, 0x03]),
          value: Buffer.from('value-00'),
        },
        {
          key: Buffer.from([0xff, 0x01, 0x02, 0x03]),
          value: Buffer.from('value-ff'),
        },
      ];

      const manifest = await createTestIndex(records);

      const reader = new PartitionedCdb64Reader({
        manifest,
        baseDir: indexDir,
      });
      await reader.open();

      // No partitions opened yet
      assert.strictEqual(reader.getOpenPartitionCount(), 0);

      // Access partition 0x00
      await reader.get(Buffer.from([0x00, 0x01, 0x02, 0x03]));
      assert.strictEqual(reader.getOpenPartitionCount(), 1);

      // Access partition 0xff
      await reader.get(Buffer.from([0xff, 0x01, 0x02, 0x03]));
      assert.strictEqual(reader.getOpenPartitionCount(), 2);

      // Access same partition again - should not increase count
      await reader.get(Buffer.from([0x00, 0x04, 0x05, 0x06]));
      assert.strictEqual(reader.getOpenPartitionCount(), 2);

      await reader.close();
    });

    it('should handle multiple keys in same partition', async () => {
      const records = [
        {
          key: Buffer.from([0xab, 0x01, 0x02, 0x03]),
          value: Buffer.from('first'),
        },
        {
          key: Buffer.from([0xab, 0x04, 0x05, 0x06]),
          value: Buffer.from('second'),
        },
        {
          key: Buffer.from([0xab, 0x07, 0x08, 0x09]),
          value: Buffer.from('third'),
        },
      ];

      const manifest = await createTestIndex(records);

      const reader = new PartitionedCdb64Reader({
        manifest,
        baseDir: indexDir,
      });
      await reader.open();

      for (const { key, value } of records) {
        const result = await reader.get(key);
        assert.notStrictEqual(result, undefined);
        assert.strictEqual(result!.toString(), value.toString());
      }

      // Still only one partition opened
      assert.strictEqual(reader.getOpenPartitionCount(), 1);

      await reader.close();
    });
  });

  describe('close', () => {
    it('should close all partitions', async () => {
      const records = [
        {
          key: Buffer.from([0x00, 0x01, 0x02, 0x03]),
          value: Buffer.from('value-00'),
        },
        {
          key: Buffer.from([0xff, 0x01, 0x02, 0x03]),
          value: Buffer.from('value-ff'),
        },
      ];

      const manifest = await createTestIndex(records);

      const reader = new PartitionedCdb64Reader({
        manifest,
        baseDir: indexDir,
      });
      await reader.open();

      // Open both partitions
      await reader.get(Buffer.from([0x00, 0x01, 0x02, 0x03]));
      await reader.get(Buffer.from([0xff, 0x01, 0x02, 0x03]));
      assert.strictEqual(reader.getOpenPartitionCount(), 2);

      await reader.close();
      assert.strictEqual(reader.isOpen(), false);
      assert.strictEqual(reader.getOpenPartitionCount(), 0);
    });

    it('should allow reopening after close', async () => {
      const key = Buffer.from([0xab, 0x01, 0x02, 0x03]);
      const value = Buffer.from('hello');

      const manifest = await createTestIndex([{ key, value }]);

      const reader = new PartitionedCdb64Reader({
        manifest,
        baseDir: indexDir,
      });

      await reader.open();
      const result1 = await reader.get(key);
      assert.strictEqual(result1!.toString(), 'hello');
      await reader.close();

      await reader.open();
      const result2 = await reader.get(key);
      assert.strictEqual(result2!.toString(), 'hello');
      await reader.close();
    });
  });

  describe('getManifest', () => {
    it('should return the manifest', async () => {
      const manifest = await createTestIndex([]);
      const reader = new PartitionedCdb64Reader({
        manifest,
        baseDir: indexDir,
      });

      assert.strictEqual(reader.getManifest(), manifest);
    });
  });

  describe('getTotalPartitionCount', () => {
    it('should return total partitions from manifest', async () => {
      const records = [
        { key: Buffer.from([0x00, 0x01, 0x02, 0x03]), value: Buffer.from('a') },
        { key: Buffer.from([0x55, 0x01, 0x02, 0x03]), value: Buffer.from('b') },
        { key: Buffer.from([0xaa, 0x01, 0x02, 0x03]), value: Buffer.from('c') },
      ];

      const manifest = await createTestIndex(records);
      const reader = new PartitionedCdb64Reader({
        manifest,
        baseDir: indexDir,
      });

      assert.strictEqual(reader.getTotalPartitionCount(), 3);
    });
  });

  describe('error handling', () => {
    it('should handle missing partition file gracefully', async () => {
      // Create index then delete a partition file
      const records = [
        {
          key: Buffer.from([0x00, 0x01, 0x02, 0x03]),
          value: Buffer.from('test'),
        },
        {
          key: Buffer.from([0xff, 0x01, 0x02, 0x03]),
          value: Buffer.from('test'),
        },
      ];
      const manifest = await createTestIndex(records);

      // Delete one partition file
      await fs.unlink(path.join(indexDir, 'ff.cdb'));

      const reader = new PartitionedCdb64Reader({
        manifest,
        baseDir: indexDir,
      });
      await reader.open();

      // Should return undefined instead of throwing
      const result = await reader.get(Buffer.from([0xff, 0x01, 0x02, 0x03]));
      assert.strictEqual(result, undefined);

      // Other partition should still work
      const result2 = await reader.get(Buffer.from([0x00, 0x01, 0x02, 0x03]));
      assert.strictEqual(result2!.toString(), 'test');

      await reader.close();
    });

    it('should throw if baseDir not provided for file locations', async () => {
      const manifest: Cdb64Manifest = {
        version: 1,
        createdAt: new Date().toISOString(),
        totalRecords: 1,
        partitions: [
          {
            prefix: '00',
            location: { type: 'file', filename: '00.cdb' },
            recordCount: 1,
            size: 4096,
          },
        ],
      };

      const reader = new PartitionedCdb64Reader({ manifest });
      await reader.open();

      await assert.rejects(
        async () => reader.get(Buffer.from([0x00, 0x01, 0x02])),
        /baseDir is required for file partition locations/,
      );

      await reader.close();
    });

    it('should throw if contiguousDataSource not provided for arweave locations', async () => {
      const manifest: Cdb64Manifest = {
        version: 1,
        createdAt: new Date().toISOString(),
        totalRecords: 1,
        partitions: [
          {
            prefix: '00',
            location: { type: 'arweave-id', id: 'someTxId123' },
            recordCount: 1,
            size: 4096,
          },
        ],
      };

      const reader = new PartitionedCdb64Reader({ manifest });
      await reader.open();

      await assert.rejects(
        async () => reader.get(Buffer.from([0x00, 0x01, 0x02])),
        /contiguousDataSource is required for arweave-id partition locations/,
      );

      await reader.close();
    });
  });

  describe('integration tests', () => {
    it('should handle large index with many partitions', async () => {
      const records: { key: Buffer; value: Buffer }[] = [];

      // Create records across 32 different partitions
      for (let prefix = 0; prefix < 256; prefix += 8) {
        for (let i = 0; i < 5; i++) {
          const key = Buffer.alloc(32);
          key[0] = prefix;
          key[1] = i;
          records.push({
            key,
            value: Buffer.from(`value-${prefix.toString(16)}-${i}`),
          });
        }
      }

      const manifest = await createTestIndex(records);

      const reader = new PartitionedCdb64Reader({
        manifest,
        baseDir: indexDir,
      });
      await reader.open();

      // Verify random lookups
      for (let i = 0; i < 20; i++) {
        const record = records[Math.floor(Math.random() * records.length)];
        const result = await reader.get(record.key);
        assert.notStrictEqual(result, undefined);
        assert.strictEqual(result!.toString(), record.value.toString());
      }

      await reader.close();
    });

    it('should read manifest from file', async () => {
      const records = [
        {
          key: Buffer.from([0xab, 0x01, 0x02, 0x03]),
          value: Buffer.from('test'),
        },
      ];
      await createTestIndex(records);

      // Read manifest from file
      const manifestJson = await fs.readFile(
        path.join(indexDir, 'manifest.json'),
        'utf-8',
      );
      const manifest = parseManifest(manifestJson);

      const reader = new PartitionedCdb64Reader({
        manifest,
        baseDir: indexDir,
      });
      await reader.open();

      const result = await reader.get(Buffer.from([0xab, 0x01, 0x02, 0x03]));
      assert.strictEqual(result!.toString(), 'test');

      await reader.close();
    });
  });
});
