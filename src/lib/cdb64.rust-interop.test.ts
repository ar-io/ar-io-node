/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * CDB64 Rust Interoperability Tests
 *
 * These tests verify that the TypeScript CDB64 implementation produces files
 * that are binary-compatible with the Rust cdb64-rs implementation.
 *
 * The tests require the optional 'cdb64' dependency (from cdb64-rs) which
 * needs a Rust toolchain to compile. If the dependency is not available,
 * all tests in this file will be skipped.
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { Cdb64Writer, Cdb64Reader } from './cdb64.js';
import { Packr } from 'msgpackr';
import fc from 'fast-check';

// MessagePack encoder matching the cdb64-encoding module configuration
const packr = new Packr({
  useRecords: false,
  variableMapSize: true,
});

// Conditionally load Rust bindings
// The cdb64 package is an optionalDependency that requires Rust to compile.
// Import path: 'cdb64/node/index.js' matches the cdb64-rs package structure
// (see https://github.com/ever0de/cdb64-rs). If the package structure changes,
// this path may need to be updated. The test is skipped if import fails.
let rustCdb64: typeof import('cdb64/node/index.js') | undefined;
try {
  rustCdb64 = await import('cdb64/node/index.js');
} catch {
  // Rust bindings not available - tests will be skipped
}

describe('CDB64 Rust Interoperability', { skip: !rustCdb64 }, () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cdb64-rust-interop-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('TypeScript writes, Rust reads', () => {
    it('should read single key-value pair written by TypeScript', async () => {
      const cdbPath = path.join(tempDir, 'ts-single.cdb');
      const key = Buffer.from('test-key');
      const value = Buffer.from('test-value');

      // Write with TypeScript
      const writer = new Cdb64Writer(cdbPath);
      await writer.open();
      await writer.add(key, value);
      await writer.finalize();

      // Read with Rust
      const rustReader = rustCdb64!.Cdb.open(cdbPath);
      const result = rustReader.get(key);

      assert(result !== null, 'Rust should find the key');
      assert(result.equals(value), 'Value should match');
    });

    it('should read multiple key-value pairs written by TypeScript', async () => {
      const cdbPath = path.join(tempDir, 'ts-multiple.cdb');
      const pairs = [
        { key: Buffer.from('key1'), value: Buffer.from('value1') },
        { key: Buffer.from('key2'), value: Buffer.from('value2') },
        { key: Buffer.from('key3'), value: Buffer.from('value3') },
      ];

      // Write with TypeScript
      const writer = new Cdb64Writer(cdbPath);
      await writer.open();
      for (const pair of pairs) {
        await writer.add(pair.key, pair.value);
      }
      await writer.finalize();

      // Read with Rust
      const rustReader = rustCdb64!.Cdb.open(cdbPath);

      for (const pair of pairs) {
        const result = rustReader.get(pair.key);
        assert(result !== null, `Rust should find key ${pair.key.toString()}`);
        assert(result.equals(pair.value), 'Value should match');
      }
    });

    it('should read binary keys (32-byte IDs) written by TypeScript', async () => {
      const cdbPath = path.join(tempDir, 'ts-binary.cdb');

      // 32-byte key (like a transaction ID)
      const key = Buffer.alloc(32);
      for (let i = 0; i < 32; i++) {
        key[i] = i;
      }

      // Binary value
      const value = Buffer.alloc(64);
      for (let i = 0; i < 64; i++) {
        value[i] = (i * 7) % 256;
      }

      // Write with TypeScript
      const writer = new Cdb64Writer(cdbPath);
      await writer.open();
      await writer.add(key, value);
      await writer.finalize();

      // Read with Rust
      const rustReader = rustCdb64!.Cdb.open(cdbPath);
      const result = rustReader.get(key);

      assert(result !== null, 'Rust should find the binary key');
      assert(result.equals(value), 'Binary value should match');
    });

    it('should read large values written by TypeScript', async () => {
      const cdbPath = path.join(tempDir, 'ts-large.cdb');
      const key = Buffer.from('large-value-key');

      // 1MB value
      const value = Buffer.alloc(1024 * 1024);
      for (let i = 0; i < value.length; i++) {
        value[i] = i % 256;
      }

      // Write with TypeScript
      const writer = new Cdb64Writer(cdbPath);
      await writer.open();
      await writer.add(key, value);
      await writer.finalize();

      // Read with Rust
      const rustReader = rustCdb64!.Cdb.open(cdbPath);
      const result = rustReader.get(key);

      assert(result !== null, 'Rust should find the key');
      assert(result.equals(value), 'Large value should match');
    });

    it('should handle many records written by TypeScript', async () => {
      const cdbPath = path.join(tempDir, 'ts-many.cdb');
      const numRecords = 1000;
      const pairs: { key: Buffer; value: Buffer }[] = [];

      for (let i = 0; i < numRecords; i++) {
        pairs.push({
          key: Buffer.from(`key-${i.toString().padStart(6, '0')}`),
          value: Buffer.from(`value-${i}`),
        });
      }

      // Write with TypeScript
      const writer = new Cdb64Writer(cdbPath);
      await writer.open();
      for (const pair of pairs) {
        await writer.add(pair.key, pair.value);
      }
      await writer.finalize();

      // Read with Rust
      const rustReader = rustCdb64!.Cdb.open(cdbPath);

      for (const pair of pairs) {
        const result = rustReader.get(pair.key);
        assert(result !== null, `Rust should find key ${pair.key.toString()}`);
        assert(result.equals(pair.value), 'Value should match');
      }
    });

    it('should return null for missing keys', async () => {
      const cdbPath = path.join(tempDir, 'ts-missing.cdb');
      const key = Buffer.from('existing-key');
      const value = Buffer.from('existing-value');

      // Write with TypeScript
      const writer = new Cdb64Writer(cdbPath);
      await writer.open();
      await writer.add(key, value);
      await writer.finalize();

      // Read with Rust
      const rustReader = rustCdb64!.Cdb.open(cdbPath);
      const result = rustReader.get(Buffer.from('missing-key'));

      assert(result === null, 'Rust should return null for missing key');
    });
  });

  describe('Rust writes, TypeScript reads', () => {
    it('should read single key-value pair written by Rust', async () => {
      const cdbPath = path.join(tempDir, 'rust-single.cdb');
      const key = Buffer.from('test-key');
      const value = Buffer.from('test-value');

      // Write with Rust
      const rustWriter = new rustCdb64!.CdbWriter(cdbPath);
      rustWriter.put(key, value);
      rustWriter.finalize();

      // Read with TypeScript
      const reader = new Cdb64Reader(cdbPath);
      await reader.open();
      const result = await reader.get(key);
      await reader.close();

      assert(result !== undefined, 'TypeScript should find the key');
      assert(result.equals(value), 'Value should match');
    });

    it('should read multiple key-value pairs written by Rust', async () => {
      const cdbPath = path.join(tempDir, 'rust-multiple.cdb');
      const pairs = [
        { key: Buffer.from('key1'), value: Buffer.from('value1') },
        { key: Buffer.from('key2'), value: Buffer.from('value2') },
        { key: Buffer.from('key3'), value: Buffer.from('value3') },
      ];

      // Write with Rust
      const rustWriter = new rustCdb64!.CdbWriter(cdbPath);
      for (const pair of pairs) {
        rustWriter.put(pair.key, pair.value);
      }
      rustWriter.finalize();

      // Read with TypeScript
      const reader = new Cdb64Reader(cdbPath);
      await reader.open();

      for (const pair of pairs) {
        const result = await reader.get(pair.key);
        assert(
          result !== undefined,
          `TypeScript should find key ${pair.key.toString()}`,
        );
        assert(result.equals(pair.value), 'Value should match');
      }

      await reader.close();
    });

    it('should read binary keys (32-byte IDs) written by Rust', async () => {
      const cdbPath = path.join(tempDir, 'rust-binary.cdb');

      // 32-byte key (like a transaction ID)
      const key = Buffer.alloc(32);
      for (let i = 0; i < 32; i++) {
        key[i] = i;
      }

      // Binary value
      const value = Buffer.alloc(64);
      for (let i = 0; i < 64; i++) {
        value[i] = (i * 7) % 256;
      }

      // Write with Rust
      const rustWriter = new rustCdb64!.CdbWriter(cdbPath);
      rustWriter.put(key, value);
      rustWriter.finalize();

      // Read with TypeScript
      const reader = new Cdb64Reader(cdbPath);
      await reader.open();
      const result = await reader.get(key);
      await reader.close();

      assert(result !== undefined, 'TypeScript should find the binary key');
      assert(result.equals(value), 'Binary value should match');
    });

    it('should read large values written by Rust', async () => {
      const cdbPath = path.join(tempDir, 'rust-large.cdb');
      const key = Buffer.from('large-value-key');

      // 1MB value
      const value = Buffer.alloc(1024 * 1024);
      for (let i = 0; i < value.length; i++) {
        value[i] = i % 256;
      }

      // Write with Rust
      const rustWriter = new rustCdb64!.CdbWriter(cdbPath);
      rustWriter.put(key, value);
      rustWriter.finalize();

      // Read with TypeScript
      const reader = new Cdb64Reader(cdbPath);
      await reader.open();
      const result = await reader.get(key);
      await reader.close();

      assert(result !== undefined, 'TypeScript should find the key');
      assert(result.equals(value), 'Large value should match');
    });

    it('should handle many records written by Rust', async () => {
      const cdbPath = path.join(tempDir, 'rust-many.cdb');
      const numRecords = 1000;
      const pairs: { key: Buffer; value: Buffer }[] = [];

      for (let i = 0; i < numRecords; i++) {
        pairs.push({
          key: Buffer.from(`key-${i.toString().padStart(6, '0')}`),
          value: Buffer.from(`value-${i}`),
        });
      }

      // Write with Rust
      const rustWriter = new rustCdb64!.CdbWriter(cdbPath);
      for (const pair of pairs) {
        rustWriter.put(pair.key, pair.value);
      }
      rustWriter.finalize();

      // Read with TypeScript
      const reader = new Cdb64Reader(cdbPath);
      await reader.open();

      for (const pair of pairs) {
        const result = await reader.get(pair.key);
        assert(
          result !== undefined,
          `TypeScript should find key ${pair.key.toString()}`,
        );
        assert(result.equals(pair.value), 'Value should match');
      }

      await reader.close();
    });

    it('should return undefined for missing keys', async () => {
      const cdbPath = path.join(tempDir, 'rust-missing.cdb');
      const key = Buffer.from('existing-key');
      const value = Buffer.from('existing-value');

      // Write with Rust
      const rustWriter = new rustCdb64!.CdbWriter(cdbPath);
      rustWriter.put(key, value);
      rustWriter.finalize();

      // Read with TypeScript
      const reader = new Cdb64Reader(cdbPath);
      await reader.open();
      const result = await reader.get(Buffer.from('missing-key'));
      await reader.close();

      assert(result === undefined, 'TypeScript should return undefined');
    });
  });

  describe('Iteration comparison', () => {
    it('should iterate same entries from TypeScript-written file', async () => {
      const cdbPath = path.join(tempDir, 'ts-iter.cdb');
      const pairs = [
        { key: Buffer.from('alpha'), value: Buffer.from('value-a') },
        { key: Buffer.from('beta'), value: Buffer.from('value-b') },
        { key: Buffer.from('gamma'), value: Buffer.from('value-c') },
      ];

      // Write with TypeScript
      const writer = new Cdb64Writer(cdbPath);
      await writer.open();
      for (const pair of pairs) {
        await writer.add(pair.key, pair.value);
      }
      await writer.finalize();

      // Iterate with Rust
      const rustReader = rustCdb64!.Cdb.open(cdbPath);
      const rustEntries = rustReader.iter();

      // Iterate with TypeScript
      const reader = new Cdb64Reader(cdbPath);
      await reader.open();
      const tsEntries: { key: Buffer; value: Buffer }[] = [];
      for await (const entry of reader.entries()) {
        tsEntries.push(entry);
      }
      await reader.close();

      // Compare entry counts
      assert.equal(
        rustEntries.length,
        tsEntries.length,
        'Both should have same number of entries',
      );
      assert.equal(
        rustEntries.length,
        pairs.length,
        'Should have all original entries',
      );

      // Convert to sets of key-value strings for comparison
      // (order may differ between implementations)
      const rustSet = new Set(
        rustEntries.map(
          (e: { key: Buffer; value: Buffer }) =>
            `${e.key.toString('hex')}:${e.value.toString('hex')}`,
        ),
      );
      const tsSet = new Set(
        tsEntries.map(
          (e) => `${e.key.toString('hex')}:${e.value.toString('hex')}`,
        ),
      );

      assert.deepEqual(rustSet, tsSet, 'Entry sets should be identical');
    });

    it('should iterate same entries from Rust-written file', async () => {
      const cdbPath = path.join(tempDir, 'rust-iter.cdb');
      const pairs = [
        { key: Buffer.from('alpha'), value: Buffer.from('value-a') },
        { key: Buffer.from('beta'), value: Buffer.from('value-b') },
        { key: Buffer.from('gamma'), value: Buffer.from('value-c') },
      ];

      // Write with Rust
      const rustWriter = new rustCdb64!.CdbWriter(cdbPath);
      for (const pair of pairs) {
        rustWriter.put(pair.key, pair.value);
      }
      rustWriter.finalize();

      // Iterate with Rust
      const rustReader = rustCdb64!.Cdb.open(cdbPath);
      const rustEntries = rustReader.iter();

      // Iterate with TypeScript
      const reader = new Cdb64Reader(cdbPath);
      await reader.open();
      const tsEntries: { key: Buffer; value: Buffer }[] = [];
      for await (const entry of reader.entries()) {
        tsEntries.push(entry);
      }
      await reader.close();

      // Compare entry counts
      assert.equal(
        rustEntries.length,
        tsEntries.length,
        'Both should have same number of entries',
      );
      assert.equal(
        rustEntries.length,
        pairs.length,
        'Should have all original entries',
      );

      // Convert to sets for comparison
      const rustSet = new Set(
        rustEntries.map(
          (e: { key: Buffer; value: Buffer }) =>
            `${e.key.toString('hex')}:${e.value.toString('hex')}`,
        ),
      );
      const tsSet = new Set(
        tsEntries.map(
          (e) => `${e.key.toString('hex')}:${e.value.toString('hex')}`,
        ),
      );

      assert.deepEqual(rustSet, tsSet, 'Entry sets should be identical');
    });
  });

  describe('Edge cases', () => {
    describe('Empty database', () => {
      it('should handle empty database written by TypeScript', async () => {
        const cdbPath = path.join(tempDir, 'ts-empty.cdb');

        // Write empty database with TypeScript
        const writer = new Cdb64Writer(cdbPath);
        await writer.open();
        await writer.finalize();

        // Read with Rust
        const rustReader = rustCdb64!.Cdb.open(cdbPath);
        const entries = rustReader.iter();

        assert.equal(entries.length, 0, 'Rust should see empty database');
        assert(
          rustReader.get(Buffer.from('any-key')) === null,
          'Rust should return null for any key',
        );
      });

      it('should handle empty database written by Rust', async () => {
        const cdbPath = path.join(tempDir, 'rust-empty.cdb');

        // Write empty database with Rust
        const rustWriter = new rustCdb64!.CdbWriter(cdbPath);
        rustWriter.finalize();

        // Read with TypeScript
        const reader = new Cdb64Reader(cdbPath);
        await reader.open();
        const entries: { key: Buffer; value: Buffer }[] = [];
        for await (const entry of reader.entries()) {
          entries.push(entry);
        }
        const result = await reader.get(Buffer.from('any-key'));
        await reader.close();

        assert.equal(entries.length, 0, 'TypeScript should see empty database');
        assert(
          result === undefined,
          'TypeScript should return undefined for any key',
        );
      });
    });

    describe('Empty keys and values', () => {
      it('should handle empty key written by TypeScript', async () => {
        const cdbPath = path.join(tempDir, 'ts-empty-key.cdb');
        const key = Buffer.alloc(0);
        const value = Buffer.from('value-for-empty-key');

        // Write with TypeScript
        const writer = new Cdb64Writer(cdbPath);
        await writer.open();
        await writer.add(key, value);
        await writer.finalize();

        // Read with Rust
        const rustReader = rustCdb64!.Cdb.open(cdbPath);
        const result = rustReader.get(key);

        assert(result !== null, 'Rust should find empty key');
        assert(result.equals(value), 'Value should match');
      });

      it('should handle empty key written by Rust', async () => {
        const cdbPath = path.join(tempDir, 'rust-empty-key.cdb');
        const key = Buffer.alloc(0);
        const value = Buffer.from('value-for-empty-key');

        // Write with Rust
        const rustWriter = new rustCdb64!.CdbWriter(cdbPath);
        rustWriter.put(key, value);
        rustWriter.finalize();

        // Read with TypeScript
        const reader = new Cdb64Reader(cdbPath);
        await reader.open();
        const result = await reader.get(key);
        await reader.close();

        assert(result !== undefined, 'TypeScript should find empty key');
        assert(result.equals(value), 'Value should match');
      });

      it('should handle empty value written by TypeScript', async () => {
        const cdbPath = path.join(tempDir, 'ts-empty-value.cdb');
        const key = Buffer.from('key-with-empty-value');
        const value = Buffer.alloc(0);

        // Write with TypeScript
        const writer = new Cdb64Writer(cdbPath);
        await writer.open();
        await writer.add(key, value);
        await writer.finalize();

        // Read with Rust
        const rustReader = rustCdb64!.Cdb.open(cdbPath);
        const result = rustReader.get(key);

        assert(result !== null, 'Rust should find the key');
        assert(result.equals(value), 'Empty value should match');
        assert.equal(result.length, 0, 'Value should be zero-length');
      });

      it('should handle empty value written by Rust', async () => {
        const cdbPath = path.join(tempDir, 'rust-empty-value.cdb');
        const key = Buffer.from('key-with-empty-value');
        const value = Buffer.alloc(0);

        // Write with Rust
        const rustWriter = new rustCdb64!.CdbWriter(cdbPath);
        rustWriter.put(key, value);
        rustWriter.finalize();

        // Read with TypeScript
        const reader = new Cdb64Reader(cdbPath);
        await reader.open();
        const result = await reader.get(key);
        await reader.close();

        assert(result !== undefined, 'TypeScript should find the key');
        assert(result.equals(value), 'Empty value should match');
        assert.equal(result.length, 0, 'Value should be zero-length');
      });
    });

    describe('Duplicate keys', () => {
      it('should handle duplicate keys written by TypeScript', async () => {
        const cdbPath = path.join(tempDir, 'ts-duplicates.cdb');
        const key = Buffer.from('duplicate-key');
        const value1 = Buffer.from('first-value');
        const value2 = Buffer.from('second-value');
        const value3 = Buffer.from('third-value');

        // Write duplicate keys with TypeScript
        const writer = new Cdb64Writer(cdbPath);
        await writer.open();
        await writer.add(key, value1);
        await writer.add(key, value2);
        await writer.add(key, value3);
        await writer.finalize();

        // Read with Rust - CDB returns first match
        const rustReader = rustCdb64!.Cdb.open(cdbPath);
        const result = rustReader.get(key);

        assert(result !== null, 'Rust should find the key');
        // CDB spec says first value should be returned
        assert(result.equals(value1), 'Should return first value');

        // Verify all values are in iteration
        const entries = rustReader.iter();
        const valuesForKey = entries
          .filter((e: { key: Buffer; value: Buffer }) => e.key.equals(key))
          .map((e: { key: Buffer; value: Buffer }) => e.value.toString());

        assert.equal(valuesForKey.length, 3, 'Should have 3 entries for key');
        assert(valuesForKey.includes('first-value'));
        assert(valuesForKey.includes('second-value'));
        assert(valuesForKey.includes('third-value'));
      });

      it('should handle duplicate keys written by Rust', async () => {
        const cdbPath = path.join(tempDir, 'rust-duplicates.cdb');
        const key = Buffer.from('duplicate-key');
        const value1 = Buffer.from('first-value');
        const value2 = Buffer.from('second-value');
        const value3 = Buffer.from('third-value');

        // Write duplicate keys with Rust
        const rustWriter = new rustCdb64!.CdbWriter(cdbPath);
        rustWriter.put(key, value1);
        rustWriter.put(key, value2);
        rustWriter.put(key, value3);
        rustWriter.finalize();

        // Read with TypeScript - CDB returns first match
        const reader = new Cdb64Reader(cdbPath);
        await reader.open();
        const result = await reader.get(key);

        assert(result !== undefined, 'TypeScript should find the key');
        // CDB spec says first value should be returned
        assert(result.equals(value1), 'Should return first value');

        // Verify all values are in iteration
        const entries: { key: Buffer; value: Buffer }[] = [];
        for await (const entry of reader.entries()) {
          entries.push(entry);
        }
        await reader.close();

        const valuesForKey = entries
          .filter((e) => e.key.equals(key))
          .map((e) => e.value.toString());

        assert.equal(valuesForKey.length, 3, 'Should have 3 entries for key');
        assert(valuesForKey.includes('first-value'));
        assert(valuesForKey.includes('second-value'));
        assert(valuesForKey.includes('third-value'));
      });
    });

    describe('Keys with null bytes', () => {
      it('should handle keys with embedded null bytes written by TypeScript', async () => {
        const cdbPath = path.join(tempDir, 'ts-null-bytes.cdb');

        // Key with null bytes in the middle
        const key = Buffer.from([0x01, 0x00, 0x02, 0x00, 0x03]);
        const value = Buffer.from('value-for-null-key');

        // Write with TypeScript
        const writer = new Cdb64Writer(cdbPath);
        await writer.open();
        await writer.add(key, value);
        await writer.finalize();

        // Read with Rust
        const rustReader = rustCdb64!.Cdb.open(cdbPath);
        const result = rustReader.get(key);

        assert(result !== null, 'Rust should find key with null bytes');
        assert(result.equals(value), 'Value should match');
      });

      it('should handle keys with embedded null bytes written by Rust', async () => {
        const cdbPath = path.join(tempDir, 'rust-null-bytes.cdb');

        // Key with null bytes in the middle
        const key = Buffer.from([0x01, 0x00, 0x02, 0x00, 0x03]);
        const value = Buffer.from('value-for-null-key');

        // Write with Rust
        const rustWriter = new rustCdb64!.CdbWriter(cdbPath);
        rustWriter.put(key, value);
        rustWriter.finalize();

        // Read with TypeScript
        const reader = new Cdb64Reader(cdbPath);
        await reader.open();
        const result = await reader.get(key);
        await reader.close();

        assert(
          result !== undefined,
          'TypeScript should find key with null bytes',
        );
        assert(result.equals(value), 'Value should match');
      });

      it('should distinguish keys that differ only in null byte positions', async () => {
        const cdbPath = path.join(tempDir, 'ts-null-positions.cdb');

        // Two keys that would be equal if nulls were string terminators
        const key1 = Buffer.from([0x41, 0x00, 0x42]); // A\0B
        const key2 = Buffer.from([0x41, 0x42, 0x00]); // AB\0
        const value1 = Buffer.from('value1');
        const value2 = Buffer.from('value2');

        // Write with TypeScript
        const writer = new Cdb64Writer(cdbPath);
        await writer.open();
        await writer.add(key1, value1);
        await writer.add(key2, value2);
        await writer.finalize();

        // Read with Rust
        const rustReader = rustCdb64!.Cdb.open(cdbPath);
        const result1 = rustReader.get(key1);
        const result2 = rustReader.get(key2);

        assert(
          result1 !== null && result1.equals(value1),
          'Key1 should map to value1',
        );
        assert(
          result2 !== null && result2.equals(value2),
          'Key2 should map to value2',
        );
      });
    });

    describe('Real-world format (32-byte keys with MessagePack values)', () => {
      it('should handle root TX index format written by TypeScript', async () => {
        const cdbPath = path.join(tempDir, 'ts-root-tx-format.cdb');

        // Simulate real data item IDs (32 bytes each)
        const dataItemId1 = Buffer.alloc(32);
        const dataItemId2 = Buffer.alloc(32);
        for (let i = 0; i < 32; i++) {
          dataItemId1[i] = i;
          dataItemId2[i] = 255 - i;
        }

        // Simulate root TX IDs (32 bytes each)
        const rootTxId1 = Buffer.alloc(32);
        const rootTxId2 = Buffer.alloc(32);
        for (let i = 0; i < 32; i++) {
          rootTxId1[i] = (i * 3) % 256;
          rootTxId2[i] = (i * 7) % 256;
        }

        // Simple format: { r: rootTxId }
        const value1 = packr.pack({ r: rootTxId1 });

        // Complete format: { r: rootTxId, i: offset, d: offset }
        const value2 = packr.pack({ r: rootTxId2, i: 1024, d: 2048 });

        // Write with TypeScript
        const writer = new Cdb64Writer(cdbPath);
        await writer.open();
        await writer.add(dataItemId1, value1);
        await writer.add(dataItemId2, value2);
        await writer.finalize();

        // Read with Rust and verify MessagePack values
        const rustReader = rustCdb64!.Cdb.open(cdbPath);

        const result1 = rustReader.get(dataItemId1);
        assert(result1 !== null, 'Rust should find dataItemId1');
        const decoded1 = packr.unpack(result1) as { r: Buffer };
        assert(decoded1.r.equals(rootTxId1), 'rootTxId1 should match');

        const result2 = rustReader.get(dataItemId2);
        assert(result2 !== null, 'Rust should find dataItemId2');
        const decoded2 = packr.unpack(result2) as {
          r: Buffer;
          i: number;
          d: number;
        };
        assert(decoded2.r.equals(rootTxId2), 'rootTxId2 should match');
        assert.equal(decoded2.i, 1024, 'rootDataItemOffset should match');
        assert.equal(decoded2.d, 2048, 'rootDataOffset should match');
      });

      it('should handle root TX index format written by Rust', async () => {
        const cdbPath = path.join(tempDir, 'rust-root-tx-format.cdb');

        // Simulate real data item IDs (32 bytes each)
        const dataItemId1 = Buffer.alloc(32);
        const dataItemId2 = Buffer.alloc(32);
        for (let i = 0; i < 32; i++) {
          dataItemId1[i] = i;
          dataItemId2[i] = 255 - i;
        }

        // Simulate root TX IDs (32 bytes each)
        const rootTxId1 = Buffer.alloc(32);
        const rootTxId2 = Buffer.alloc(32);
        for (let i = 0; i < 32; i++) {
          rootTxId1[i] = (i * 3) % 256;
          rootTxId2[i] = (i * 7) % 256;
        }

        // Simple format: { r: rootTxId }
        const value1 = packr.pack({ r: rootTxId1 });

        // Complete format: { r: rootTxId, i: offset, d: offset }
        const value2 = packr.pack({ r: rootTxId2, i: 1024, d: 2048 });

        // Write with Rust
        const rustWriter = new rustCdb64!.CdbWriter(cdbPath);
        rustWriter.put(dataItemId1, value1);
        rustWriter.put(dataItemId2, value2);
        rustWriter.finalize();

        // Read with TypeScript and verify MessagePack values
        const reader = new Cdb64Reader(cdbPath);
        await reader.open();

        const result1 = await reader.get(dataItemId1);
        assert(result1 !== undefined, 'TypeScript should find dataItemId1');
        const decoded1 = packr.unpack(result1) as { r: Buffer };
        assert(decoded1.r.equals(rootTxId1), 'rootTxId1 should match');

        const result2 = await reader.get(dataItemId2);
        assert(result2 !== undefined, 'TypeScript should find dataItemId2');
        const decoded2 = packr.unpack(result2) as {
          r: Buffer;
          i: number;
          d: number;
        };
        assert(decoded2.r.equals(rootTxId2), 'rootTxId2 should match');
        assert.equal(decoded2.i, 1024, 'rootDataItemOffset should match');
        assert.equal(decoded2.d, 2048, 'rootDataOffset should match');

        await reader.close();
      });

      it('should handle many root TX entries round-trip', async () => {
        const cdbPath = path.join(tempDir, 'many-root-tx.cdb');
        const numEntries = 500;
        const entries: {
          dataItemId: Buffer;
          rootTxId: Buffer;
          offset: number;
        }[] = [];

        // Generate realistic entries with unique keys
        for (let i = 0; i < numEntries; i++) {
          const dataItemId = Buffer.alloc(32);
          const rootTxId = Buffer.alloc(32);
          // Use deterministic patterns that guarantee unique 32-byte keys
          // Store i in first 2 bytes (little-endian) to ensure uniqueness
          dataItemId[0] = i & 0xff;
          dataItemId[1] = (i >> 8) & 0xff;
          for (let j = 2; j < 32; j++) {
            dataItemId[j] = (i * 17 + j * 13) % 256;
            rootTxId[j] = (i * 7 + j * 11) % 256;
          }
          entries.push({ dataItemId, rootTxId, offset: i * 100 });
        }

        // Write with TypeScript
        const writer = new Cdb64Writer(cdbPath);
        await writer.open();
        for (const entry of entries) {
          const value = packr.pack({
            r: entry.rootTxId,
            i: entry.offset,
            d: entry.offset + 50,
          });
          await writer.add(entry.dataItemId, value);
        }
        await writer.finalize();

        // Read with Rust and verify all entries
        const rustReader = rustCdb64!.Cdb.open(cdbPath);
        for (const entry of entries) {
          const result = rustReader.get(entry.dataItemId);
          assert(result !== null, 'Rust should find entry');
          const decoded = packr.unpack(result) as {
            r: Buffer;
            i: number;
            d: number;
          };
          assert(decoded.r.equals(entry.rootTxId), 'rootTxId should match');
          assert.equal(decoded.i, entry.offset, 'offset i should match');
          assert.equal(decoded.d, entry.offset + 50, 'offset d should match');
        }
      });
    });
  });

  describe('Property-based round-trip tests', () => {
    it('TypeScript write → Rust read: arbitrary key-value pairs', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.tuple(
              fc.uint8Array({ minLength: 1, maxLength: 64 }),
              fc.uint8Array({ minLength: 0, maxLength: 256 }),
            ),
            { minLength: 1, maxLength: 100 },
          ),
          async (pairs) => {
            const cdbPath = path.join(
              tempDir,
              `ts-rust-prop-${Date.now()}-${Math.random()}.cdb`,
            );

            // Deduplicate keys using a Map
            const keyMap = new Map<string, Buffer>();
            for (const [keyBytes, valueBytes] of pairs) {
              const key = Buffer.from(keyBytes);
              const value = Buffer.from(valueBytes);
              keyMap.set(key.toString('hex'), value);
            }

            // Write with TypeScript
            const writer = new Cdb64Writer(cdbPath);
            await writer.open();
            for (const [keyHex, value] of keyMap) {
              await writer.add(Buffer.from(keyHex, 'hex'), value);
            }
            await writer.finalize();

            // Read with Rust
            const rustReader = rustCdb64!.Cdb.open(cdbPath);
            for (const [keyHex, expectedValue] of keyMap) {
              const key = Buffer.from(keyHex, 'hex');
              const result = rustReader.get(key);
              assert(result !== null, `Rust should find key ${keyHex}`);
              assert(
                result.equals(expectedValue),
                `Value mismatch for key ${keyHex}`,
              );
            }

            // Cleanup
            await fs.unlink(cdbPath);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('Rust write → TypeScript read: arbitrary key-value pairs', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.tuple(
              fc.uint8Array({ minLength: 1, maxLength: 64 }),
              fc.uint8Array({ minLength: 0, maxLength: 256 }),
            ),
            { minLength: 1, maxLength: 100 },
          ),
          async (pairs) => {
            const cdbPath = path.join(
              tempDir,
              `rust-ts-prop-${Date.now()}-${Math.random()}.cdb`,
            );

            // Deduplicate keys using a Map
            const keyMap = new Map<string, Buffer>();
            for (const [keyBytes, valueBytes] of pairs) {
              const key = Buffer.from(keyBytes);
              const value = Buffer.from(valueBytes);
              keyMap.set(key.toString('hex'), value);
            }

            // Write with Rust
            const rustWriter = new rustCdb64!.CdbWriter(cdbPath);
            for (const [keyHex, value] of keyMap) {
              rustWriter.put(Buffer.from(keyHex, 'hex'), value);
            }
            rustWriter.finalize();

            // Read with TypeScript
            const reader = new Cdb64Reader(cdbPath);
            await reader.open();
            for (const [keyHex, expectedValue] of keyMap) {
              const key = Buffer.from(keyHex, 'hex');
              const result = await reader.get(key);
              assert(
                result !== undefined,
                `TypeScript should find key ${keyHex}`,
              );
              assert(
                result.equals(expectedValue),
                `Value mismatch for key ${keyHex}`,
              );
            }
            await reader.close();

            // Cleanup
            await fs.unlink(cdbPath);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('Round-trip: 32-byte keys with MessagePack values (real-world format)', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.tuple(
              fc.uint8Array({ minLength: 32, maxLength: 32 }), // data item ID
              fc.uint8Array({ minLength: 32, maxLength: 32 }), // root TX ID
              fc.nat(1000000), // offset
            ),
            { minLength: 1, maxLength: 100 },
          ),
          async (entries) => {
            const cdbPath = path.join(
              tempDir,
              `msgpack-prop-${Date.now()}-${Math.random()}.cdb`,
            );

            // Deduplicate by data item ID
            const entryMap = new Map<
              string,
              { rootTxId: Buffer; offset: number }
            >();
            for (const [dataItemIdBytes, rootTxIdBytes, offset] of entries) {
              const dataItemId = Buffer.from(dataItemIdBytes);
              const rootTxId = Buffer.from(rootTxIdBytes);
              entryMap.set(dataItemId.toString('hex'), { rootTxId, offset });
            }

            // Write with TypeScript using MessagePack values
            const writer = new Cdb64Writer(cdbPath);
            await writer.open();
            for (const [keyHex, { rootTxId, offset }] of entryMap) {
              const value = packr.pack({
                r: rootTxId,
                i: offset,
                d: offset + 100,
              });
              await writer.add(Buffer.from(keyHex, 'hex'), value);
            }
            await writer.finalize();

            // Read with Rust and decode MessagePack
            const rustReader = rustCdb64!.Cdb.open(cdbPath);
            for (const [keyHex, { rootTxId, offset }] of entryMap) {
              const key = Buffer.from(keyHex, 'hex');
              const result = rustReader.get(key);
              assert(result !== null, `Rust should find key ${keyHex}`);

              const decoded = packr.unpack(result) as {
                r: Buffer;
                i: number;
                d: number;
              };
              assert(
                decoded.r.equals(rootTxId),
                `rootTxId mismatch for key ${keyHex}`,
              );
              assert.equal(
                decoded.i,
                offset,
                `offset i mismatch for key ${keyHex}`,
              );
              assert.equal(
                decoded.d,
                offset + 100,
                `offset d mismatch for key ${keyHex}`,
              );
            }

            // Cleanup
            await fs.unlink(cdbPath);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('Iteration consistency: both implementations see same entries', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.tuple(
              fc.uint8Array({ minLength: 1, maxLength: 32 }),
              fc.uint8Array({ minLength: 1, maxLength: 64 }),
            ),
            { minLength: 1, maxLength: 50 },
          ),
          async (pairs) => {
            const cdbPath = path.join(
              tempDir,
              `iter-prop-${Date.now()}-${Math.random()}.cdb`,
            );

            // Deduplicate keys
            const keyMap = new Map<string, Buffer>();
            for (const [keyBytes, valueBytes] of pairs) {
              const key = Buffer.from(keyBytes);
              const value = Buffer.from(valueBytes);
              keyMap.set(key.toString('hex'), value);
            }

            // Write with TypeScript
            const writer = new Cdb64Writer(cdbPath);
            await writer.open();
            for (const [keyHex, value] of keyMap) {
              await writer.add(Buffer.from(keyHex, 'hex'), value);
            }
            await writer.finalize();

            // Iterate with Rust
            const rustReader = rustCdb64!.Cdb.open(cdbPath);
            const rustEntries = rustReader.iter();
            const rustSet = new Set(
              rustEntries.map(
                (e: { key: Buffer; value: Buffer }) =>
                  `${e.key.toString('hex')}:${e.value.toString('hex')}`,
              ),
            );

            // Iterate with TypeScript
            const reader = new Cdb64Reader(cdbPath);
            await reader.open();
            const tsSet = new Set<string>();
            for await (const entry of reader.entries()) {
              tsSet.add(
                `${entry.key.toString('hex')}:${entry.value.toString('hex')}`,
              );
            }
            await reader.close();

            // Both should have same entries
            assert.equal(
              rustSet.size,
              keyMap.size,
              'Rust should see all entries',
            );
            assert.equal(
              tsSet.size,
              keyMap.size,
              'TypeScript should see all entries',
            );
            assert.deepEqual(rustSet, tsSet, 'Entry sets should be identical');

            // Cleanup
            await fs.unlink(cdbPath);
          },
        ),
        { numRuns: 50 },
      );
    });
  });
});
