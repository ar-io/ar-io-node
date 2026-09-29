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

import {
  cdb64Hash,
  Cdb64Writer,
  Cdb64Reader,
  verifyCdb64File,
} from './cdb64.js';
import { ByteRangeSource, FileByteRangeSource } from './byte-range-source.js';

// CLI tools require the native cdb64 module - check availability for skip
let hasNativeCdb64 = false;
try {
  await import('cdb64/node/index.js');
  hasNativeCdb64 = true;
} catch {
  // Native cdb64 module not available - CLI tests will be skipped
}

describe('CDB64', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cdb64-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('cdb64Hash', () => {
    it('should return consistent hash for same input', () => {
      const key = Buffer.from('test-key');
      const hash1 = cdb64Hash(key);
      const hash2 = cdb64Hash(key);
      assert.equal(hash1, hash2);
    });

    it('should return different hashes for different inputs', () => {
      const key1 = Buffer.from('key1');
      const key2 = Buffer.from('key2');
      const hash1 = cdb64Hash(key1);
      const hash2 = cdb64Hash(key2);
      assert.notEqual(hash1, hash2);
    });

    it('should return unsigned 64-bit bigint', () => {
      const key = Buffer.from('test');
      const hash = cdb64Hash(key);
      assert(typeof hash === 'bigint');
      assert(hash >= 0n);
      assert(hash <= 0xffffffffffffffffn);
    });

    it('should handle empty buffer', () => {
      const key = Buffer.alloc(0);
      const hash = cdb64Hash(key);
      assert.equal(hash, 5381n); // Initial hash value with no XOR operations
    });

    it('should produce known hash value', () => {
      // DJB hash of "a" (ASCII 97) starting with 5381:
      // h = ((5381 << 5) + 5381) ^ 97
      // h = (172192 + 5381) ^ 97
      // h = 177573 ^ 97 = 177604
      const key = Buffer.from('a');
      const hash = cdb64Hash(key);
      assert.equal(hash, 177604n);
    });
  });

  describe('Cdb64Writer and Cdb64Reader', () => {
    it('should write and read a single key-value pair', async () => {
      const cdbPath = path.join(tempDir, 'single.cdb');
      const key = Buffer.from('test-key');
      const value = Buffer.from('test-value');

      // Write
      const writer = new Cdb64Writer(cdbPath);
      await writer.open();
      await writer.add(key, value);
      await writer.finalize();

      // Read
      const reader = new Cdb64Reader(cdbPath);
      await reader.open();
      const result = await reader.get(key);
      await reader.close();

      assert(result !== undefined);
      assert(result.equals(value));
    });

    it('should write and read multiple key-value pairs', async () => {
      const cdbPath = path.join(tempDir, 'multiple.cdb');
      const pairs = [
        { key: Buffer.from('key1'), value: Buffer.from('value1') },
        { key: Buffer.from('key2'), value: Buffer.from('value2') },
        { key: Buffer.from('key3'), value: Buffer.from('value3') },
      ];

      // Write
      const writer = new Cdb64Writer(cdbPath);
      await writer.open();
      for (const pair of pairs) {
        await writer.add(pair.key, pair.value);
      }
      await writer.finalize();

      // Read
      const reader = new Cdb64Reader(cdbPath);
      await reader.open();

      for (const pair of pairs) {
        const result = await reader.get(pair.key);
        assert(result !== undefined, `Key ${pair.key.toString()} not found`);
        assert(result.equals(pair.value));
      }

      await reader.close();
    });

    it('should return undefined for missing key', async () => {
      const cdbPath = path.join(tempDir, 'missing.cdb');
      const key = Buffer.from('existing-key');
      const value = Buffer.from('existing-value');

      // Write
      const writer = new Cdb64Writer(cdbPath);
      await writer.open();
      await writer.add(key, value);
      await writer.finalize();

      // Read
      const reader = new Cdb64Reader(cdbPath);
      await reader.open();

      const result = await reader.get(Buffer.from('missing-key'));
      await reader.close();

      assert.equal(result, undefined);
    });

    it('should handle binary keys and values', async () => {
      const cdbPath = path.join(tempDir, 'binary.cdb');

      // 32-byte key (like a transaction ID)
      const key = Buffer.alloc(32);
      for (let i = 0; i < 32; i++) {
        key[i] = i;
      }

      // Binary value with various byte values
      const value = Buffer.alloc(64);
      for (let i = 0; i < 64; i++) {
        value[i] = (i * 7) % 256;
      }

      // Write
      const writer = new Cdb64Writer(cdbPath);
      await writer.open();
      await writer.add(key, value);
      await writer.finalize();

      // Read
      const reader = new Cdb64Reader(cdbPath);
      await reader.open();
      const result = await reader.get(key);
      await reader.close();

      assert(result !== undefined);
      assert(result.equals(value));
    });

    it('should handle many records with hash collisions', async () => {
      const cdbPath = path.join(tempDir, 'collisions.cdb');
      const numRecords = 1000;
      const pairs: { key: Buffer; value: Buffer }[] = [];

      // Generate records - some will have same hash table index
      for (let i = 0; i < numRecords; i++) {
        pairs.push({
          key: Buffer.from(`key-${i.toString().padStart(6, '0')}`),
          value: Buffer.from(`value-${i}`),
        });
      }

      // Write
      const writer = new Cdb64Writer(cdbPath);
      await writer.open();
      for (const pair of pairs) {
        await writer.add(pair.key, pair.value);
      }
      await writer.finalize();

      // Read all back
      const reader = new Cdb64Reader(cdbPath);
      await reader.open();

      for (const pair of pairs) {
        const result = await reader.get(pair.key);
        assert(result !== undefined, `Key ${pair.key.toString()} not found`);
        assert(
          result.equals(pair.value),
          `Value mismatch for key ${pair.key.toString()}`,
        );
      }

      await reader.close();
    });

    it('should handle empty database', async () => {
      const cdbPath = path.join(tempDir, 'empty.cdb');

      // Write empty database
      const writer = new Cdb64Writer(cdbPath);
      await writer.open();
      await writer.finalize();

      // Read
      const reader = new Cdb64Reader(cdbPath);
      await reader.open();
      const result = await reader.get(Buffer.from('any-key'));
      await reader.close();

      assert.equal(result, undefined);
    });

    it('should handle large values', async () => {
      const cdbPath = path.join(tempDir, 'large.cdb');
      const key = Buffer.from('large-key');
      const value = Buffer.alloc(1024 * 1024); // 1MB value
      for (let i = 0; i < value.length; i++) {
        value[i] = i % 256;
      }

      // Write
      const writer = new Cdb64Writer(cdbPath);
      await writer.open();
      await writer.add(key, value);
      await writer.finalize();

      // Read
      const reader = new Cdb64Reader(cdbPath);
      await reader.open();
      const result = await reader.get(key);
      await reader.close();

      assert(result !== undefined);
      assert.equal(result.length, value.length);
      assert(result.equals(value));
    });

    it('should create nested directories if needed', async () => {
      const cdbPath = path.join(tempDir, 'nested', 'dir', 'test.cdb');
      const key = Buffer.from('key');
      const value = Buffer.from('value');

      const writer = new Cdb64Writer(cdbPath);
      await writer.open();
      await writer.add(key, value);
      await writer.finalize();

      // Verify file exists
      const stat = await fs.stat(cdbPath);
      assert(stat.isFile());
    });

    it('should throw error when adding after finalize', async () => {
      const cdbPath = path.join(tempDir, 'finalized.cdb');

      const writer = new Cdb64Writer(cdbPath);
      await writer.open();
      await writer.add(Buffer.from('key'), Buffer.from('value'));
      await writer.finalize();

      await assert.rejects(
        async () => writer.add(Buffer.from('key2'), Buffer.from('value2')),
        /Cannot add records after finalization/,
      );
    });

    it('should throw error when finalizing twice', async () => {
      const cdbPath = path.join(tempDir, 'double-finalize.cdb');

      const writer = new Cdb64Writer(cdbPath);
      await writer.open();
      await writer.finalize();

      await assert.rejects(async () => writer.finalize(), /Already finalized/);
    });

    it('should throw error when reading without opening', async () => {
      const reader = new Cdb64Reader('/nonexistent.cdb');

      await assert.rejects(
        async () => reader.get(Buffer.from('key')),
        /Reader not opened/,
      );
    });

    it('should throw error when writing without opening', async () => {
      const cdbPath = path.join(tempDir, 'not-opened.cdb');
      const writer = new Cdb64Writer(cdbPath);

      await assert.rejects(
        async () => writer.add(Buffer.from('key'), Buffer.from('value')),
        /Writer not opened/,
      );
    });

    it('should report open status correctly', async () => {
      const cdbPath = path.join(tempDir, 'status.cdb');
      const writer = new Cdb64Writer(cdbPath);
      await writer.open();
      await writer.finalize();

      const reader = new Cdb64Reader(cdbPath);

      assert.equal(reader.isOpen(), false);
      await reader.open();
      assert.equal(reader.isOpen(), true);
      await reader.close();
      assert.equal(reader.isOpen(), false);
    });

    it('should clean up temp file on abort', async () => {
      const cdbPath = path.join(tempDir, 'abort.cdb');

      const writer = new Cdb64Writer(cdbPath);
      await writer.open();
      await writer.add(Buffer.from('key'), Buffer.from('value'));
      await writer.abort();

      // Neither temp file nor final file should exist
      await assert.rejects(async () => fs.stat(cdbPath), /ENOENT/);
    });
  });

  describe('Cdb64Reader.entries()', () => {
    it('should return no entries for empty database', async () => {
      const cdbPath = path.join(tempDir, 'empty-entries.cdb');

      // Write empty database
      const writer = new Cdb64Writer(cdbPath);
      await writer.open();
      await writer.finalize();

      // Iterate
      const reader = new Cdb64Reader(cdbPath);
      await reader.open();

      const entries: { key: Buffer; value: Buffer }[] = [];
      for await (const entry of reader.entries()) {
        entries.push(entry);
      }

      await reader.close();

      assert.equal(entries.length, 0);
    });

    it('should return single entry', async () => {
      const cdbPath = path.join(tempDir, 'single-entry.cdb');
      const key = Buffer.from('test-key');
      const value = Buffer.from('test-value');

      // Write
      const writer = new Cdb64Writer(cdbPath);
      await writer.open();
      await writer.add(key, value);
      await writer.finalize();

      // Iterate
      const reader = new Cdb64Reader(cdbPath);
      await reader.open();

      const entries: { key: Buffer; value: Buffer }[] = [];
      for await (const entry of reader.entries()) {
        entries.push(entry);
      }

      await reader.close();

      assert.equal(entries.length, 1);
      assert(entries[0].key.equals(key));
      assert(entries[0].value.equals(value));
    });

    it('should return all entries in write order', async () => {
      const cdbPath = path.join(tempDir, 'multi-entry.cdb');
      const pairs = [
        { key: Buffer.from('key1'), value: Buffer.from('value1') },
        { key: Buffer.from('key2'), value: Buffer.from('value2') },
        { key: Buffer.from('key3'), value: Buffer.from('value3') },
      ];

      // Write
      const writer = new Cdb64Writer(cdbPath);
      await writer.open();
      for (const pair of pairs) {
        await writer.add(pair.key, pair.value);
      }
      await writer.finalize();

      // Iterate
      const reader = new Cdb64Reader(cdbPath);
      await reader.open();

      const entries: { key: Buffer; value: Buffer }[] = [];
      for await (const entry of reader.entries()) {
        entries.push(entry);
      }

      await reader.close();

      assert.equal(entries.length, pairs.length);
      for (let i = 0; i < pairs.length; i++) {
        assert(
          entries[i].key.equals(pairs[i].key),
          `Key mismatch at index ${i}`,
        );
        assert(
          entries[i].value.equals(pairs[i].value),
          `Value mismatch at index ${i}`,
        );
      }
    });

    it('should handle many records', async () => {
      const cdbPath = path.join(tempDir, 'many-entries.cdb');
      const numRecords = 500;
      const pairs: { key: Buffer; value: Buffer }[] = [];

      for (let i = 0; i < numRecords; i++) {
        pairs.push({
          key: Buffer.from(`key-${i.toString().padStart(6, '0')}`),
          value: Buffer.from(`value-${i}`),
        });
      }

      // Write
      const writer = new Cdb64Writer(cdbPath);
      await writer.open();
      for (const pair of pairs) {
        await writer.add(pair.key, pair.value);
      }
      await writer.finalize();

      // Iterate
      const reader = new Cdb64Reader(cdbPath);
      await reader.open();

      const entries: { key: Buffer; value: Buffer }[] = [];
      for await (const entry of reader.entries()) {
        entries.push(entry);
      }

      await reader.close();

      assert.equal(entries.length, numRecords);

      // Verify all entries match (in write order)
      for (let i = 0; i < pairs.length; i++) {
        assert(entries[i].key.equals(pairs[i].key));
        assert(entries[i].value.equals(pairs[i].value));
      }
    });

    it('should handle binary keys and values', async () => {
      const cdbPath = path.join(tempDir, 'binary-entries.cdb');

      // 32-byte keys (like transaction IDs)
      const pairs = [];
      for (let i = 0; i < 10; i++) {
        const key = Buffer.alloc(32);
        for (let j = 0; j < 32; j++) {
          key[j] = (i * 32 + j) % 256;
        }
        const value = Buffer.alloc(64);
        for (let j = 0; j < 64; j++) {
          value[j] = (i * 64 + j * 7) % 256;
        }
        pairs.push({ key, value });
      }

      // Write
      const writer = new Cdb64Writer(cdbPath);
      await writer.open();
      for (const pair of pairs) {
        await writer.add(pair.key, pair.value);
      }
      await writer.finalize();

      // Iterate
      const reader = new Cdb64Reader(cdbPath);
      await reader.open();

      const entries: { key: Buffer; value: Buffer }[] = [];
      for await (const entry of reader.entries()) {
        entries.push(entry);
      }

      await reader.close();

      assert.equal(entries.length, pairs.length);
      for (let i = 0; i < pairs.length; i++) {
        assert(entries[i].key.equals(pairs[i].key));
        assert(entries[i].value.equals(pairs[i].value));
      }
    });

    it('should throw error when iterating without opening', async () => {
      const reader = new Cdb64Reader('/nonexistent.cdb');

      await assert.rejects(async () => {
        for await (const _ of reader.entries()) {
          // Should not reach here
        }
      }, /Reader not opened/);
    });
  });

  describe('CLI round-trip', { skip: !hasNativeCdb64 }, () => {
    const runTool = async (
      tool: string,
      args: string[],
    ): Promise<{ stdout: string; stderr: string }> => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);

      const toolPath = path.join(process.cwd(), 'tools', tool);
      const result = await execFileAsync(toolPath, args, {
        cwd: process.cwd(),
        env: { ...process.env },
      });

      return { stdout: result.stdout, stderr: result.stderr };
    };

    it('should round-trip simple format CSV through CDB', async () => {
      const inputCsv = path.join(tempDir, 'input.csv');
      const cdbFile = path.join(tempDir, 'index.cdb');
      const outputCsv = path.join(tempDir, 'output.csv');

      // Create input CSV (simple format - no offsets)
      // IDs must be valid base64url-encoded 32-byte values for round-trip
      const inputData = [
        'IX5lt26pAoko02PrP8Zith9UiJWidZLxxHEDfGK91jg,LWWgC-YmKVG4sH8PXq7JtqAkDqPfpLmRsC0K76xRF88',
        '7sDOjWxJ7sD6MhQYDwlcKb5wh95NkmFy67QnfF_K3Ts,qKkz3UNz_RhF4M5c0dVJLHg5sKPwJzKpPmHRRNbXUdI',
        '0ZsbZUgy0f1xb-tvP6KjW-6VQVsYZqY65cXSV-2FdCo,r8V682gQbEsOn-pI_912xV9Ht1En2OO3vmwj3H2s3MU',
      ];
      await fs.writeFile(inputCsv, inputData.join('\n') + '\n');

      // Generate CDB
      await runTool('generate-cdb64-root-tx-index', [
        '--input',
        inputCsv,
        '--output',
        cdbFile,
      ]);

      // Export back to CSV
      await runTool('export-cdb64-root-tx-index', [
        '--input',
        cdbFile,
        '--output',
        outputCsv,
        '--no-header',
      ]);

      // Read output and compare
      const outputContent = await fs.readFile(outputCsv, 'utf-8');
      const outputLines = outputContent.trim().split('\n');

      assert.equal(outputLines.length, inputData.length);

      // Parse and compare (order may differ due to hash table placement)
      const inputPairs = new Set(
        inputData.map((line) => line.split(',').slice(0, 2).join(',')),
      );
      const outputPairs = new Set(
        outputLines.map((line) => line.split(',').slice(0, 2).join(',')),
      );

      assert.deepEqual(inputPairs, outputPairs);
    });

    it('should round-trip complete format CSV through CDB', async () => {
      const inputCsv = path.join(tempDir, 'input-complete.csv');
      const cdbFile = path.join(tempDir, 'complete.cdb');
      const outputCsv = path.join(tempDir, 'output-complete.csv');

      // Create input CSV (complete format - with offsets, empty path column).
      // The exporter always writes the data_item_size column, so the input
      // carries it too: one row with a size and one without.
      // Format: data_item_id,root_tx_id,path,root_data_item_offset,root_data_offset,data_item_size
      const inputData = [
        'IX5lt26pAoko02PrP8Zith9UiJWidZLxxHEDfGK91jg,LWWgC-YmKVG4sH8PXq7JtqAkDqPfpLmRsC0K76xRF88,,1024,2048,3072',
        '7sDOjWxJ7sD6MhQYDwlcKb5wh95NkmFy67QnfF_K3Ts,qKkz3UNz_RhF4M5c0dVJLHg5sKPwJzKpPmHRRNbXUdI,,4096,8192,',
      ];
      await fs.writeFile(inputCsv, inputData.join('\n') + '\n');

      // Generate CDB
      await runTool('generate-cdb64-root-tx-index', [
        '--input',
        inputCsv,
        '--output',
        cdbFile,
      ]);

      // Export back to CSV
      await runTool('export-cdb64-root-tx-index', [
        '--input',
        cdbFile,
        '--output',
        outputCsv,
        '--no-header',
      ]);

      // Read output and compare
      const outputContent = await fs.readFile(outputCsv, 'utf-8');
      const outputLines = outputContent.trim().split('\n');

      assert.equal(outputLines.length, inputData.length);

      // Parse and compare all fields including offsets
      const inputPairs = new Set(inputData);
      const outputPairs = new Set(outputLines);

      assert.deepEqual(inputPairs, outputPairs);
    });

    it('should handle CSV with header row', async () => {
      const inputCsv = path.join(tempDir, 'input-header.csv');
      const cdbFile = path.join(tempDir, 'header.cdb');
      const outputCsv = path.join(tempDir, 'output-header.csv');

      // Create input CSV with header
      const header = 'data_item_id,root_tx_id';
      const inputData = [
        'IX5lt26pAoko02PrP8Zith9UiJWidZLxxHEDfGK91jg,LWWgC-YmKVG4sH8PXq7JtqAkDqPfpLmRsC0K76xRF88',
      ];
      await fs.writeFile(inputCsv, header + '\n' + inputData.join('\n') + '\n');

      // Generate CDB (should auto-detect header)
      await runTool('generate-cdb64-root-tx-index', [
        '--input',
        inputCsv,
        '--output',
        cdbFile,
      ]);

      // Export back to CSV without header
      await runTool('export-cdb64-root-tx-index', [
        '--input',
        cdbFile,
        '--output',
        outputCsv,
        '--no-header',
      ]);

      // Read output and compare
      const outputContent = await fs.readFile(outputCsv, 'utf-8');
      const outputLines = outputContent.trim().split('\n');

      // Should have only 1 record (header was skipped)
      assert.equal(outputLines.length, 1);

      const outputPair = outputLines[0].split(',').slice(0, 2).join(',');
      assert.equal(outputPair, inputData[0]);
    });

    it('should export to stdout', async () => {
      const inputCsv = path.join(tempDir, 'input-stdout.csv');
      const cdbFile = path.join(tempDir, 'stdout.cdb');

      // Create input CSV
      const inputData = [
        'IX5lt26pAoko02PrP8Zith9UiJWidZLxxHEDfGK91jg,LWWgC-YmKVG4sH8PXq7JtqAkDqPfpLmRsC0K76xRF88',
      ];
      await fs.writeFile(inputCsv, inputData.join('\n') + '\n');

      // Generate CDB
      await runTool('generate-cdb64-root-tx-index', [
        '--input',
        inputCsv,
        '--output',
        cdbFile,
      ]);

      // Export to stdout
      const result = await runTool('export-cdb64-root-tx-index', [
        '--input',
        cdbFile,
        '--output',
        '-',
        '--no-header',
      ]);

      const outputLines = result.stdout.trim().split('\n');
      assert.equal(outputLines.length, 1);

      const outputPair = outputLines[0].split(',').slice(0, 2).join(',');
      assert.equal(outputPair, inputData[0]);
    });
  });
});

/**
 * Hand-built files whose structure lies about itself.
 *
 * Index files can come from a remote publisher, so every offset and length
 * in them is attacker-chosen. Each file here is a few kilobytes and passes
 * the header-only record-count check; the reader must answer a lookup with
 * undefined rather than trusting what the bytes claim.
 */
describe('CDB64 hostile input', () => {
  let tempDir: string;
  const key = Buffer.alloc(32, 7);
  const hash = cdb64Hash(key);
  const tableIndex = Number(hash % 256n);
  const tableLength = 2;
  const startSlot = Number((hash / 256n) % BigInt(tableLength));

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cdb64-hostile-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /**
   * One record at 4096 declaring the given lengths (followed by the real
   * key and a short value), then one two-slot table whose probe slot has
   * `key`'s hash and points at that record.
   */
  const craft = async ({
    keyLength = BigInt(key.length),
    valueLength = 4n,
    tablePosition,
    tableSlots = BigInt(tableLength),
    recordPosition = 4096n,
    name = 'hostile.cdb',
  }: {
    keyLength?: bigint;
    valueLength?: bigint;
    tablePosition?: bigint;
    tableSlots?: bigint;
    recordPosition?: bigint;
    name?: string;
  } = {}): Promise<string> => {
    const record = Buffer.alloc(16 + key.length + 4);
    record.writeBigUInt64LE(keyLength, 0);
    record.writeBigUInt64LE(valueLength, 8);
    key.copy(record, 16);
    const realTablePosition = 4096 + record.length;

    const table = Buffer.alloc(tableLength * 16);
    table.writeBigUInt64LE(hash, startSlot * 16);
    table.writeBigUInt64LE(recordPosition, startSlot * 16 + 8);

    const header = Buffer.alloc(4096);
    // Unused tables point at the table region with zero slots, as the
    // writer leaves them.
    for (let i = 0; i < 256; i++) {
      header.writeBigUInt64LE(BigInt(realTablePosition), i * 16);
    }
    header.writeBigUInt64LE(
      tablePosition ?? BigInt(realTablePosition),
      tableIndex * 16,
    );
    header.writeBigUInt64LE(tableSlots, tableIndex * 16 + 8);

    const filePath = path.join(tempDir, name);
    await fs.writeFile(filePath, Buffer.concat([header, record, table]));
    return filePath;
  };

  /** Wraps a source and records the largest read anyone asked it for. */
  class RecordingSource implements ByteRangeSource {
    largestRead = 0;
    constructor(private inner: FileByteRangeSource) {}
    async open(): Promise<void> {
      await this.inner.open();
    }
    async read(offset: number, size: number): Promise<Buffer> {
      this.largestRead = Math.max(this.largestRead, size);
      return this.inner.read(offset, size);
    }
    async getSize(): Promise<number | undefined> {
      return this.inner.getSize();
    }
    async close(): Promise<void> {
      await this.inner.close();
    }
    isOpen(): boolean {
      return this.inner.isOpen();
    }
  }

  const lookup = async (
    filePath: string,
  ): Promise<{ value: Buffer | undefined; reader: Cdb64Reader }> => {
    const reader = new Cdb64Reader(filePath);
    await reader.open();
    try {
      return { value: await reader.get(key), reader };
    } finally {
      await reader.close();
    }
  };

  it('sanity: the crafted layout is a readable, well-formed file', async () => {
    const filePath = await craft();
    const { value } = await lookup(filePath);
    assert.deepEqual(value, Buffer.alloc(4));
    assert.deepEqual(await verifyCdb64File(filePath), { records: 1 });
  });

  it('returns undefined for a key length of 2^31 instead of aborting the process', async () => {
    // Before the fix this reached fs read with a length of 2^31 and Node
    // aborted on an assertion (SIGABRT), taking this test process with it.
    const filePath = await craft({ keyLength: 2n ** 31n });
    const { value } = await lookup(filePath);
    assert.equal(value, undefined);
  });

  it('returns undefined for key lengths past 2^53', async () => {
    const filePath = await craft({ keyLength: 2n ** 63n });
    const { value } = await lookup(filePath);
    assert.equal(value, undefined);
  });

  it('returns undefined for a huge value length without asking for the bytes', async () => {
    const filePath = await craft({ valueLength: 2n ** 30n });
    const source = new RecordingSource(new FileByteRangeSource(filePath));
    const reader = Cdb64Reader.fromSource(source);
    await reader.open();
    const value = await reader.get(key);
    await reader.close();

    assert.equal(value, undefined);
    assert.equal(reader.getCorruptRecordCount(), 1);
    // Header, slots and record headers only: nothing near the claimed size.
    assert.ok(
      source.largestRead <= 4096,
      `largest read was ${source.largestRead} bytes`,
    );
  });

  it('returns undefined for a value length under the cap that runs past the file', async () => {
    const filePath = await craft({ valueLength: 512n * 1024n });
    const { value, reader } = await lookup(filePath);
    assert.equal(value, undefined);
    assert.equal(reader.getCorruptRecordCount(), 1);
  });

  it('honors a tighter maxValueLength', async () => {
    const filePath = await craft();
    const reader = new Cdb64Reader(filePath, true, { maxValueLength: 3 });
    await reader.open();
    assert.equal(await reader.get(key), undefined);
    await reader.close();
  });

  it('returns undefined for a table pointer past the end of the file', async () => {
    const filePath = await craft({ tablePosition: 2n ** 40n });
    const { value, reader } = await lookup(filePath);
    assert.equal(value, undefined);
    assert.equal(reader.getCorruptRecordCount(), 1);
  });

  it('returns undefined for a table whose slots run past the end of the file', async () => {
    // Same record count on paper would need 2^62 records; the point is the
    // table cannot fit.
    const filePath = await craft({ tableSlots: 2n ** 62n });
    const { value } = await lookup(filePath);
    assert.equal(value, undefined);
  });

  it('returns undefined for a table pointer inside the header', async () => {
    const filePath = await craft({ tablePosition: 16n });
    const { value } = await lookup(filePath);
    assert.equal(value, undefined);
  });

  it('returns undefined for a slot pointing past the record region', async () => {
    const filePath = await craft({ recordPosition: 2n ** 40n });
    const { value, reader } = await lookup(filePath);
    assert.equal(value, undefined);
    assert.equal(reader.getCorruptRecordCount(), 1);
  });

  it('refuses to iterate a record with an out-of-bounds length', async () => {
    const filePath = await craft({ keyLength: 2n ** 31n });
    const reader = new Cdb64Reader(filePath);
    await reader.open();
    await assert.rejects(async () => {
      for await (const _entry of reader.entries()) {
        // drain
      }
    }, /Invalid record at position 4096/);
    await reader.close();
  });

  describe('verifyCdb64File', () => {
    it('accepts files from Cdb64Writer, reading in tiny chunks', async () => {
      const filePath = path.join(tempDir, 'real.cdb');
      const writer = new Cdb64Writer(filePath);
      await writer.open();
      for (let i = 0; i < 500; i++) {
        await writer.add(
          Buffer.from(`key-${i}`),
          Buffer.alloc(i % 50, i % 256),
        );
      }
      await writer.finalize();

      // Chunk sizes that split record headers and slots across reads.
      for (const readChunkSize of [16, 48, 1024, 1024 * 1024]) {
        assert.deepEqual(await verifyCdb64File(filePath, { readChunkSize }), {
          records: 500,
        });
      }
    });

    it('accepts an empty database', async () => {
      const filePath = path.join(tempDir, 'empty.cdb');
      const writer = new Cdb64Writer(filePath);
      await writer.open();
      await writer.finalize();
      assert.deepEqual(await verifyCdb64File(filePath), { records: 0 });
    });

    const rejects = async (
      filePath: string,
      pattern: RegExp,
      options = {},
    ): Promise<void> => {
      await assert.rejects(() => verifyCdb64File(filePath, options), pattern);
    };

    it('rejects a key length past the bound', async () => {
      await rejects(await craft({ keyLength: 2n ** 31n }), /key length/);
    });

    it('rejects a value length past the bound', async () => {
      await rejects(await craft({ valueLength: 2n ** 30n }), /value length/);
      await rejects(await craft({ name: 'v.cdb' }), /value length/, {
        maxValueLength: 3,
      });
    });

    it('rejects a record that runs into the hash tables', async () => {
      await rejects(await craft({ valueLength: 100n }), /past the hash tables/);
    });

    it('rejects a walk that stops short of the tables', async () => {
      // A record 6 bytes too short leaves a 6-byte tail: no room for a
      // header, so the walk cannot end exactly on the table region.
      await rejects(
        await craft({ valueLength: 0n, keyLength: 30n }),
        /would overlap the hash tables/,
      );
    });

    it('rejects table pointers outside the file or inside the header', async () => {
      await rejects(
        await craft({ tablePosition: 2n ** 40n }),
        /does not fit in the/,
      );
      await rejects(
        await craft({ tableSlots: 2n ** 62n, name: 'b.cdb' }),
        /does not fit in the/,
      );
      await rejects(
        await craft({ tablePosition: 16n, name: 'c.cdb' }),
        /does not fit in the/,
      );
    });

    it('rejects a slot pointing outside the record region', async () => {
      await rejects(
        await craft({ recordPosition: 2n ** 40n }),
        /is not a valid entry/,
      );
    });

    it('rejects overlapping tables', async () => {
      const filePath = await craft();
      const bytes = await fs.readFile(filePath);
      const other = (tableIndex + 1) % 256;
      bytes.writeBigUInt64LE(BigInt(4096 + 16 + key.length + 4), other * 16);
      bytes.writeBigUInt64LE(2n, other * 16 + 8);
      await fs.writeFile(filePath, bytes);
      await rejects(filePath, /overlap/);
    });

    it('rejects a file whose slots and records disagree', async () => {
      // One record walked, but its table's slots are both empty.
      await rejects(
        await craft({ recordPosition: 0n }),
        /hash tables index 0 records, but the file holds 1/,
      );
    });

    it('rejects a table whose occupied run is longer than allowed', async () => {
      const filePath = path.join(tempDir, 'dense.cdb');
      const writer = new Cdb64Writer(filePath);
      await writer.open();
      for (let i = 0; i < 2000; i++) {
        await writer.add(Buffer.from(`key-${i}`), Buffer.from('v'));
      }
      await writer.finalize();
      await rejects(filePath, /occupied slots, more than the 1 allowed/, {
        maxProbeRun: 1,
      });
    });

    it('rejects a file shorter than the header', async () => {
      const filePath = path.join(tempDir, 'short.cdb');
      await fs.writeFile(filePath, Buffer.alloc(100));
      await rejects(filePath, /shorter than the 4096-byte header/);
    });
  });
});
