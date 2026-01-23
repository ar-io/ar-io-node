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

import { PartitionedCdb64Writer } from './partitioned-cdb64-writer.js';
import { Cdb64Reader } from './cdb64.js';
import { parseManifest, validateManifest } from './cdb64-manifest.js';

describe('PartitionedCdb64Writer', () => {
  let tempDir: string;
  let outputDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'partitioned-cdb64-test-'),
    );
    outputDir = path.join(tempDir, 'output');
  });

  afterEach(async () => {
    mock.restoreAll();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('open', () => {
    it('should create temp directory', async () => {
      const writer = new PartitionedCdb64Writer(outputDir);
      await writer.open();

      // Temp directory should exist
      const tempDirPath = `${outputDir}.tmp.${process.pid}`;
      const stats = await fs.stat(tempDirPath);
      assert.strictEqual(stats.isDirectory(), true);

      await writer.abort();
    });

    it('should throw if opened twice', async () => {
      const writer = new PartitionedCdb64Writer(outputDir);
      await writer.open();

      await assert.rejects(async () => writer.open(), /Writer already opened/);

      await writer.abort();
    });

    it('should throw if reopening after finalize', async () => {
      const writer = new PartitionedCdb64Writer(outputDir);
      await writer.open();
      await writer.finalize();

      await assert.rejects(
        async () => writer.open(),
        /Cannot reopen a finalized writer/,
      );
    });
  });

  describe('add', () => {
    it('should throw if not opened', async () => {
      const writer = new PartitionedCdb64Writer(outputDir);
      const key = Buffer.from([0x00, 0x01, 0x02]);
      const value = Buffer.from('test');

      await assert.rejects(
        async () => writer.add(key, value),
        /Writer not opened/,
      );
    });

    it('should throw for empty key', async () => {
      const writer = new PartitionedCdb64Writer(outputDir);
      await writer.open();

      await assert.rejects(
        async () => writer.add(Buffer.alloc(0), Buffer.from('test')),
        /Key must be at least 1 byte/,
      );

      await writer.abort();
    });

    it('should create partition file lazily', async () => {
      const writer = new PartitionedCdb64Writer(outputDir);
      await writer.open();

      const tempDirPath = `${outputDir}.tmp.${process.pid}`;

      // No files should exist yet
      const filesBefore = await fs.readdir(tempDirPath);
      assert.strictEqual(filesBefore.length, 0);

      // Add a record with key starting with 0xab
      const key = Buffer.from([0xab, 0x01, 0x02, 0x03]);
      await writer.add(key, Buffer.from('test'));

      // Only ab.cdb temp file should exist
      const filesAfter = await fs.readdir(tempDirPath);
      // The temp file is created by Cdb64Writer as ab.cdb.tmp.<pid>
      assert.strictEqual(
        filesAfter.some((f) => f.startsWith('ab.cdb')),
        true,
      );

      await writer.abort();
    });

    it('should route records to correct partitions', async () => {
      const writer = new PartitionedCdb64Writer(outputDir);
      await writer.open();

      // Add records to different partitions
      await writer.add(
        Buffer.from([0x00, 0x01, 0x02, 0x03]),
        Buffer.from('value-00'),
      );
      await writer.add(
        Buffer.from([0x00, 0x04, 0x05, 0x06]),
        Buffer.from('value-00-2'),
      );
      await writer.add(
        Buffer.from([0xff, 0x01, 0x02, 0x03]),
        Buffer.from('value-ff'),
      );
      await writer.add(
        Buffer.from([0xab, 0x01, 0x02, 0x03]),
        Buffer.from('value-ab'),
      );

      const stats = writer.getPartitionStats();
      assert.strictEqual(stats.length, 3); // 00, ab, ff

      const partition00 = stats.find((s) => s.prefix === '00');
      assert.strictEqual(partition00?.recordCount, 2);

      const partitionAb = stats.find((s) => s.prefix === 'ab');
      assert.strictEqual(partitionAb?.recordCount, 1);

      const partitionFf = stats.find((s) => s.prefix === 'ff');
      assert.strictEqual(partitionFf?.recordCount, 1);

      await writer.abort();
    });
  });

  describe('finalize', () => {
    it('should throw if not opened', async () => {
      const writer = new PartitionedCdb64Writer(outputDir);

      await assert.rejects(async () => writer.finalize(), /Writer not opened/);
    });

    it('should throw if already finalized', async () => {
      const writer = new PartitionedCdb64Writer(outputDir);
      await writer.open();
      await writer.finalize();

      await assert.rejects(async () => writer.finalize(), /Already finalized/);
    });

    it('should create manifest.json', async () => {
      const writer = new PartitionedCdb64Writer(outputDir);
      await writer.open();

      // Add some records
      await writer.add(
        Buffer.from([0x00, 0x01, 0x02, 0x03]),
        Buffer.from('test'),
      );

      await writer.finalize();

      // Check manifest exists
      const manifestPath = path.join(outputDir, 'manifest.json');
      const manifestJson = await fs.readFile(manifestPath, 'utf-8');
      const manifest = parseManifest(manifestJson);

      assert.strictEqual(manifest.version, 1);
      assert.strictEqual(manifest.totalRecords, 1);
      assert.strictEqual(manifest.partitions.length, 1);
    });

    it('should return valid manifest', async () => {
      const writer = new PartitionedCdb64Writer(outputDir);
      await writer.open();

      await writer.add(
        Buffer.from([0x00, 0x01, 0x02, 0x03]),
        Buffer.from('test'),
      );
      await writer.add(
        Buffer.from([0xff, 0x01, 0x02, 0x03]),
        Buffer.from('test2'),
      );

      const manifest = await writer.finalize();

      assert.strictEqual(validateManifest(manifest), true);
      assert.strictEqual(manifest.version, 1);
      assert.strictEqual(manifest.totalRecords, 2);
      assert.strictEqual(manifest.partitions.length, 2);

      // Check partition info
      const partition00 = manifest.partitions.find((p) => p.prefix === '00');
      assert.strictEqual(partition00?.recordCount, 1);
      assert.strictEqual(partition00?.location.type, 'file');
      assert.strictEqual(
        (partition00?.location as { type: 'file'; filename: string }).filename,
        '00.cdb',
      );
    });

    it('should create valid CDB64 files', async () => {
      const writer = new PartitionedCdb64Writer(outputDir);
      await writer.open();

      const key1 = Buffer.from([0xab, 0x01, 0x02, 0x03, 0x04, 0x05]);
      const value1 = Buffer.from('hello world');
      const key2 = Buffer.from([0xab, 0x11, 0x12, 0x13, 0x14, 0x15]);
      const value2 = Buffer.from('goodbye world');

      await writer.add(key1, value1);
      await writer.add(key2, value2);
      await writer.finalize();

      // Read back from the CDB file
      const cdbPath = path.join(outputDir, 'ab.cdb');
      const reader = new Cdb64Reader(cdbPath);
      await reader.open();

      const result1 = await reader.get(key1);
      assert.notStrictEqual(result1, undefined);
      assert.strictEqual(result1!.toString(), 'hello world');

      const result2 = await reader.get(key2);
      assert.notStrictEqual(result2, undefined);
      assert.strictEqual(result2!.toString(), 'goodbye world');

      await reader.close();
    });

    it('should perform atomic directory creation', async () => {
      const writer = new PartitionedCdb64Writer(outputDir);
      await writer.open();

      await writer.add(
        Buffer.from([0x00, 0x01, 0x02, 0x03]),
        Buffer.from('test'),
      );
      await writer.finalize();

      // Output directory should exist
      const stats = await fs.stat(outputDir);
      assert.strictEqual(stats.isDirectory(), true);

      // Temp directory should not exist
      const tempDirPath = `${outputDir}.tmp.${process.pid}`;
      await assert.rejects(async () => fs.stat(tempDirPath), /ENOENT/);
    });

    it('should sort partitions by prefix in manifest', async () => {
      const writer = new PartitionedCdb64Writer(outputDir);
      await writer.open();

      // Add in non-sorted order
      await writer.add(Buffer.from([0xff, 0x01]), Buffer.from('ff'));
      await writer.add(Buffer.from([0x00, 0x01]), Buffer.from('00'));
      await writer.add(Buffer.from([0x7f, 0x01]), Buffer.from('7f'));

      const manifest = await writer.finalize();

      assert.strictEqual(manifest.partitions[0].prefix, '00');
      assert.strictEqual(manifest.partitions[1].prefix, '7f');
      assert.strictEqual(manifest.partitions[2].prefix, 'ff');
    });

    it('should include metadata in manifest', async () => {
      const writer = new PartitionedCdb64Writer(outputDir, {
        metadata: { source: 'test', version: '1.0' },
      });
      await writer.open();

      await writer.add(Buffer.from([0x00, 0x01]), Buffer.from('test'));
      const manifest = await writer.finalize();

      assert.deepStrictEqual(manifest.metadata, {
        source: 'test',
        version: '1.0',
      });
    });

    it('should handle empty index (no records)', async () => {
      const writer = new PartitionedCdb64Writer(outputDir);
      await writer.open();
      const manifest = await writer.finalize();

      assert.strictEqual(manifest.totalRecords, 0);
      assert.strictEqual(manifest.partitions.length, 0);

      // manifest.json should exist
      const manifestPath = path.join(outputDir, 'manifest.json');
      const manifestJson = await fs.readFile(manifestPath, 'utf-8');
      const parsed = parseManifest(manifestJson);
      assert.strictEqual(parsed.totalRecords, 0);
    });

    it('should not create empty partition files', async () => {
      const writer = new PartitionedCdb64Writer(outputDir);
      await writer.open();

      // Only add records for one partition
      await writer.add(Buffer.from([0xab, 0x01]), Buffer.from('test'));
      await writer.finalize();

      // Only ab.cdb and manifest.json should exist
      const files = await fs.readdir(outputDir);
      files.sort();
      assert.deepStrictEqual(files, ['ab.cdb', 'manifest.json']);
    });
  });

  describe('abort', () => {
    it('should clean up temp directory', async () => {
      const writer = new PartitionedCdb64Writer(outputDir);
      await writer.open();

      await writer.add(Buffer.from([0x00, 0x01]), Buffer.from('test'));
      await writer.abort();

      // Temp directory should not exist
      const tempDirPath = `${outputDir}.tmp.${process.pid}`;
      await assert.rejects(async () => fs.stat(tempDirPath), /ENOENT/);

      // Output directory should not exist either
      await assert.rejects(async () => fs.stat(outputDir), /ENOENT/);
    });

    it('should be safe to call multiple times', async () => {
      const writer = new PartitionedCdb64Writer(outputDir);
      await writer.open();

      await writer.abort();
      await writer.abort(); // Should not throw
    });
  });

  describe('progress reporting', () => {
    it('should track total record count', async () => {
      const writer = new PartitionedCdb64Writer(outputDir);
      await writer.open();

      assert.strictEqual(writer.getTotalRecordCount(), 0);

      await writer.add(Buffer.from([0x00, 0x01]), Buffer.from('test'));
      assert.strictEqual(writer.getTotalRecordCount(), 1);

      await writer.add(Buffer.from([0x00, 0x02]), Buffer.from('test'));
      await writer.add(Buffer.from([0xff, 0x01]), Buffer.from('test'));
      assert.strictEqual(writer.getTotalRecordCount(), 3);

      await writer.abort();
    });

    it('should track partition count', async () => {
      const writer = new PartitionedCdb64Writer(outputDir);
      await writer.open();

      assert.strictEqual(writer.getPartitionCount(), 0);

      await writer.add(Buffer.from([0x00, 0x01]), Buffer.from('test'));
      assert.strictEqual(writer.getPartitionCount(), 1);

      await writer.add(Buffer.from([0x00, 0x02]), Buffer.from('test'));
      assert.strictEqual(writer.getPartitionCount(), 1); // Same partition

      await writer.add(Buffer.from([0xff, 0x01]), Buffer.from('test'));
      assert.strictEqual(writer.getPartitionCount(), 2);

      await writer.abort();
    });

    it('should report partition stats', async () => {
      const writer = new PartitionedCdb64Writer(outputDir);
      await writer.open();

      await writer.add(Buffer.from([0x00, 0x01]), Buffer.from('test'));
      await writer.add(Buffer.from([0x00, 0x02]), Buffer.from('test'));
      await writer.add(Buffer.from([0xab, 0x01]), Buffer.from('test'));

      const stats = writer.getPartitionStats();
      assert.strictEqual(stats.length, 2);

      const stat00 = stats.find((s) => s.prefix === '00');
      assert.strictEqual(stat00?.recordCount, 2);

      const statAb = stats.find((s) => s.prefix === 'ab');
      assert.strictEqual(statAb?.recordCount, 1);

      await writer.abort();
    });
  });

  describe('isOpen', () => {
    it('should return false before open', async () => {
      const writer = new PartitionedCdb64Writer(outputDir);
      assert.strictEqual(writer.isOpen(), false);
    });

    it('should return true after open', async () => {
      const writer = new PartitionedCdb64Writer(outputDir);
      await writer.open();
      assert.strictEqual(writer.isOpen(), true);
      await writer.abort();
    });

    it('should return false after finalize', async () => {
      const writer = new PartitionedCdb64Writer(outputDir);
      await writer.open();
      await writer.finalize();
      assert.strictEqual(writer.isOpen(), false);
    });

    it('should return false after abort', async () => {
      const writer = new PartitionedCdb64Writer(outputDir);
      await writer.open();
      await writer.abort();
      assert.strictEqual(writer.isOpen(), false);
    });
  });

  describe('getOutputDir', () => {
    it('should return the output directory path', async () => {
      const writer = new PartitionedCdb64Writer(outputDir);
      assert.strictEqual(writer.getOutputDir(), outputDir);
    });
  });

  describe('integration tests', () => {
    it('should handle many partitions', async () => {
      const writer = new PartitionedCdb64Writer(outputDir);
      await writer.open();

      // Add records to 16 different partitions
      for (let i = 0; i < 16; i++) {
        const prefix = i * 16; // 0x00, 0x10, 0x20, ...
        for (let j = 0; j < 10; j++) {
          const key = Buffer.alloc(32);
          key[0] = prefix;
          key[1] = j;
          await writer.add(
            key,
            Buffer.from(`value-${prefix.toString(16)}-${j}`),
          );
        }
      }

      const manifest = await writer.finalize();

      assert.strictEqual(manifest.partitions.length, 16);
      assert.strictEqual(manifest.totalRecords, 160);

      // Verify we can read from each partition
      for (const partition of manifest.partitions) {
        const cdbPath = path.join(outputDir, `${partition.prefix}.cdb`);
        const reader = new Cdb64Reader(cdbPath);
        await reader.open();

        // Read first record from this partition
        const key = Buffer.alloc(32);
        key[0] = parseInt(partition.prefix, 16);
        key[1] = 0;
        const value = await reader.get(key);
        assert.notStrictEqual(value, undefined);

        await reader.close();
      }
    });
  });
});
