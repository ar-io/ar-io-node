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
import fc from 'fast-check';

import { cdb64Hash, Cdb64Writer, Cdb64Reader } from './cdb64.js';

describe('CDB64 property tests', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cdb64-prop-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('cdb64Hash properties', () => {
    it('should be deterministic - same input always gives same output', () => {
      fc.assert(
        fc.property(
          fc.uint8Array({ minLength: 0, maxLength: 1000 }),
          (bytes) => {
            const key = Buffer.from(bytes);
            const hash1 = cdb64Hash(key);
            const hash2 = cdb64Hash(key);
            assert.equal(hash1, hash2);
          },
        ),
        { numRuns: 500 },
      );
    });

    it('should always return a non-negative 64-bit bigint', () => {
      fc.assert(
        fc.property(
          fc.uint8Array({ minLength: 0, maxLength: 1000 }),
          (bytes) => {
            const key = Buffer.from(bytes);
            const hash = cdb64Hash(key);
            assert(typeof hash === 'bigint');
            assert(hash >= 0n);
            assert(hash <= 0xffffffffffffffffn);
          },
        ),
        { numRuns: 500 },
      );
    });

    it('should produce different hashes for different inputs (collision resistance)', () => {
      fc.assert(
        fc.property(
          fc.uint8Array({ minLength: 1, maxLength: 100 }),
          fc.uint8Array({ minLength: 1, maxLength: 100 }),
          (bytes1, bytes2) => {
            // Skip if inputs are identical
            const key1 = Buffer.from(bytes1);
            const key2 = Buffer.from(bytes2);
            if (key1.equals(key2)) return true;

            const hash1 = cdb64Hash(key1);
            const hash2 = cdb64Hash(key2);
            // Most different inputs should have different hashes
            // Note: This isn't guaranteed (collisions exist), but should be rare
            return hash1 !== hash2;
          },
        ),
        { numRuns: 500 },
      );
    });

    it('should distribute table indices evenly across 256 buckets', () => {
      // Generate many keys and check distribution
      const buckets = new Array(256).fill(0);
      const numKeys = 10000;

      for (let i = 0; i < numKeys; i++) {
        const key = Buffer.from(`key-${i}-${Math.random()}`);
        const hash = cdb64Hash(key);
        const tableIndex = Number(hash % 256n);
        buckets[tableIndex]++;
      }

      // Check that no bucket is severely over or under represented
      // With 10000 keys across 256 buckets, expect ~39 per bucket
      // Allow 3x deviation (13-117 range)
      const minExpected = numKeys / 256 / 3;
      const maxExpected = (numKeys / 256) * 3;

      for (let i = 0; i < 256; i++) {
        assert(
          buckets[i] >= minExpected,
          `Bucket ${i} has too few entries: ${buckets[i]}`,
        );
        assert(
          buckets[i] <= maxExpected,
          `Bucket ${i} has too many entries: ${buckets[i]}`,
        );
      }
    });
  });

  describe('round-trip properties', () => {
    it('should round-trip any key-value pair', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uint8Array({ minLength: 1, maxLength: 100 }),
          fc.uint8Array({ minLength: 0, maxLength: 1000 }),
          async (keyBytes, valueBytes) => {
            const cdbPath = path.join(
              tempDir,
              `rt-${Date.now()}-${Math.random()}.cdb`,
            );
            const key = Buffer.from(keyBytes);
            const value = Buffer.from(valueBytes);

            const writer = new Cdb64Writer(cdbPath);
            await writer.open();
            await writer.add(key, value);
            await writer.finalize();

            const reader = new Cdb64Reader(cdbPath);
            await reader.open();
            const result = await reader.get(key);
            await reader.close();

            assert(result !== undefined, 'Key should be found');
            assert(result.equals(value), 'Value should match');
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should round-trip multiple key-value pairs', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.tuple(
              fc.uint8Array({ minLength: 1, maxLength: 50 }),
              fc.uint8Array({ minLength: 0, maxLength: 200 }),
            ),
            { minLength: 1, maxLength: 100 },
          ),
          async (pairs) => {
            const cdbPath = path.join(
              tempDir,
              `multi-${Date.now()}-${Math.random()}.cdb`,
            );

            // Deduplicate keys (last value wins)
            const keyMap = new Map<string, Buffer>();
            for (const [keyBytes, valueBytes] of pairs) {
              const key = Buffer.from(keyBytes);
              const value = Buffer.from(valueBytes);
              keyMap.set(key.toString('hex'), value);
            }

            const writer = new Cdb64Writer(cdbPath);
            await writer.open();
            for (const [keyHex, value] of keyMap) {
              await writer.add(Buffer.from(keyHex, 'hex'), value);
            }
            await writer.finalize();

            const reader = new Cdb64Reader(cdbPath);
            await reader.open();

            for (const [keyHex, expectedValue] of keyMap) {
              const key = Buffer.from(keyHex, 'hex');
              const result = await reader.get(key);
              assert(result !== undefined, `Key ${keyHex} should be found`);
              assert(
                result.equals(expectedValue),
                `Value for ${keyHex} should match`,
              );
            }

            await reader.close();
          },
        ),
        { numRuns: 50 },
      );
    });

    it('should return undefined for keys not in database', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.tuple(
              fc.uint8Array({ minLength: 1, maxLength: 50 }),
              fc.uint8Array({ minLength: 0, maxLength: 100 }),
            ),
            { minLength: 1, maxLength: 50 },
          ),
          fc.uint8Array({ minLength: 1, maxLength: 50 }),
          async (pairs, missingKeyBytes) => {
            const cdbPath = path.join(
              tempDir,
              `missing-${Date.now()}-${Math.random()}.cdb`,
            );
            const missingKey = Buffer.from(missingKeyBytes);

            // Check if missing key is actually in pairs
            const existingKeys = new Set(
              pairs.map(([k]) => Buffer.from(k).toString('hex')),
            );
            if (existingKeys.has(missingKey.toString('hex'))) {
              return true; // Skip this case
            }

            const writer = new Cdb64Writer(cdbPath);
            await writer.open();
            for (const [keyBytes, valueBytes] of pairs) {
              await writer.add(Buffer.from(keyBytes), Buffer.from(valueBytes));
            }
            await writer.finalize();

            const reader = new Cdb64Reader(cdbPath);
            await reader.open();
            const result = await reader.get(missingKey);
            await reader.close();

            assert.equal(
              result,
              undefined,
              'Missing key should return undefined',
            );
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  describe('32-byte key properties (transaction ID size)', () => {
    it('should handle 32-byte keys correctly', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uint8Array({ minLength: 32, maxLength: 32 }),
          fc.uint8Array({ minLength: 32, maxLength: 64 }),
          async (keyBytes, valueBytes) => {
            const cdbPath = path.join(
              tempDir,
              `txid-${Date.now()}-${Math.random()}.cdb`,
            );
            const key = Buffer.from(keyBytes);
            const value = Buffer.from(valueBytes);

            const writer = new Cdb64Writer(cdbPath);
            await writer.open();
            await writer.add(key, value);
            await writer.finalize();

            const reader = new Cdb64Reader(cdbPath);
            await reader.open();
            const result = await reader.get(key);
            await reader.close();

            assert(result !== undefined);
            assert(result.equals(value));
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should handle many 32-byte keys with potential hash collisions', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.uint8Array({ minLength: 32, maxLength: 32 }), {
            minLength: 100,
            maxLength: 500,
          }),
          async (keyArrays) => {
            const cdbPath = path.join(
              tempDir,
              `collision-${Date.now()}-${Math.random()}.cdb`,
            );

            // Deduplicate and create key-value map
            const keyMap = new Map<string, Buffer>();
            for (const keyBytes of keyArrays) {
              const key = Buffer.from(keyBytes);
              const value = Buffer.from(
                `value-for-${key.toString('hex').slice(0, 8)}`,
              );
              keyMap.set(key.toString('hex'), value);
            }

            const writer = new Cdb64Writer(cdbPath);
            await writer.open();
            for (const [keyHex, value] of keyMap) {
              await writer.add(Buffer.from(keyHex, 'hex'), value);
            }
            await writer.finalize();

            const reader = new Cdb64Reader(cdbPath);
            await reader.open();

            for (const [keyHex, expectedValue] of keyMap) {
              const key = Buffer.from(keyHex, 'hex');
              const result = await reader.get(key);
              assert(
                result !== undefined,
                `Key ${keyHex.slice(0, 16)}... should be found`,
              );
              assert(result.equals(expectedValue));
            }

            await reader.close();
          },
        ),
        { numRuns: 20 },
      );
    });
  });

  describe('edge case properties', () => {
    it('should handle empty values', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uint8Array({ minLength: 1, maxLength: 50 }),
          async (keyBytes) => {
            const cdbPath = path.join(
              tempDir,
              `empty-val-${Date.now()}-${Math.random()}.cdb`,
            );
            const key = Buffer.from(keyBytes);
            const value = Buffer.alloc(0);

            const writer = new Cdb64Writer(cdbPath);
            await writer.open();
            await writer.add(key, value);
            await writer.finalize();

            const reader = new Cdb64Reader(cdbPath);
            await reader.open();
            const result = await reader.get(key);
            await reader.close();

            assert(result !== undefined);
            assert.equal(result.length, 0);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('should handle single-byte keys', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 255 }),
          fc.uint8Array({ minLength: 1, maxLength: 100 }),
          async (keyByte, valueBytes) => {
            const cdbPath = path.join(
              tempDir,
              `single-${Date.now()}-${Math.random()}.cdb`,
            );
            const key = Buffer.from([keyByte]);
            const value = Buffer.from(valueBytes);

            const writer = new Cdb64Writer(cdbPath);
            await writer.open();
            await writer.add(key, value);
            await writer.finalize();

            const reader = new Cdb64Reader(cdbPath);
            await reader.open();
            const result = await reader.get(key);
            await reader.close();

            assert(result !== undefined);
            assert(result.equals(value));
          },
        ),
        { numRuns: 50 },
      );
    });

    it('should handle keys with same hash table index', async () => {
      // Force keys into same bucket by controlling hash % 256
      const cdbPath = path.join(tempDir, `same-bucket-${Date.now()}.cdb`);
      const pairs: { key: Buffer; value: Buffer }[] = [];

      // Find keys that hash to the same table
      const targetBucket = 42;
      let found = 0;
      for (let i = 0; found < 20 && i < 100000; i++) {
        const key = Buffer.from(`key-${i}`);
        const hash = cdb64Hash(key);
        if (Number(hash % 256n) === targetBucket) {
          pairs.push({
            key,
            value: Buffer.from(`value-${i}`),
          });
          found++;
        }
      }

      assert(pairs.length >= 10, 'Should find at least 10 keys in same bucket');

      const writer = new Cdb64Writer(cdbPath);
      await writer.open();
      for (const { key, value } of pairs) {
        await writer.add(key, value);
      }
      await writer.finalize();

      const reader = new Cdb64Reader(cdbPath);
      await reader.open();

      for (const { key, value } of pairs) {
        const result = await reader.get(key);
        assert(result !== undefined, `Key ${key.toString()} should be found`);
        assert(result.equals(value));
      }

      await reader.close();
    });
  });
});
