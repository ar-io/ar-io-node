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

import { cdb64Hash, Cdb64Writer, Cdb64Reader } from './cdb64.js';

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

  describe('CLI round-trip', () => {
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

      // Create input CSV (complete format - with offsets)
      const inputData = [
        'IX5lt26pAoko02PrP8Zith9UiJWidZLxxHEDfGK91jg,LWWgC-YmKVG4sH8PXq7JtqAkDqPfpLmRsC0K76xRF88,1024,2048',
        '7sDOjWxJ7sD6MhQYDwlcKb5wh95NkmFy67QnfF_K3Ts,qKkz3UNz_RhF4M5c0dVJLHg5sKPwJzKpPmHRRNbXUdI,4096,8192',
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
