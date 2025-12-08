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
});
