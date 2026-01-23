/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert';

import {
  Cdb64Manifest,
  parseManifest,
  serializeManifest,
  validateManifest,
  getPartitionPrefix,
  getPartitionIndex,
  indexToPrefix,
  prefixToIndex,
  createEmptyManifest,
} from './cdb64-manifest.js';

describe('cdb64-manifest', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  describe('validateManifest', () => {
    it('should validate a minimal valid manifest', () => {
      const manifest = {
        version: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        totalRecords: 0,
        partitions: [],
      };
      assert.strictEqual(validateManifest(manifest), true);
    });

    it('should validate a manifest with file partitions', () => {
      const manifest = {
        version: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        totalRecords: 1000,
        partitions: [
          {
            prefix: '00',
            location: { type: 'file', filename: '00.cdb' },
            recordCount: 500,
            size: 102400,
          },
          {
            prefix: 'ff',
            location: { type: 'file', filename: 'ff.cdb' },
            recordCount: 500,
            size: 102400,
          },
        ],
      };
      assert.strictEqual(validateManifest(manifest), true);
    });

    it('should validate a manifest with http partitions', () => {
      const manifest = {
        version: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        totalRecords: 100,
        partitions: [
          {
            prefix: 'ab',
            location: { type: 'http', url: 'https://example.com/ab.cdb' },
            recordCount: 100,
            size: 10240,
          },
        ],
      };
      assert.strictEqual(validateManifest(manifest), true);
    });

    it('should validate a manifest with arweave-tx partitions', () => {
      const manifest = {
        version: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        totalRecords: 100,
        partitions: [
          {
            prefix: 'cd',
            location: {
              type: 'arweave-tx',
              txId: 'ABC123def456ghi789jkl012mno345pqr678stu9',
            },
            recordCount: 100,
            size: 10240,
          },
        ],
      };
      assert.strictEqual(validateManifest(manifest), true);
    });

    it('should validate a manifest with arweave-bundle-item partitions', () => {
      const manifest = {
        version: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        totalRecords: 100,
        partitions: [
          {
            prefix: 'ef',
            location: {
              type: 'arweave-bundle-item',
              txId: 'ABC123def456ghi789jkl012mno345pqr678stu9',
              offset: 1024,
              size: 10240,
            },
            recordCount: 100,
            size: 10240,
          },
        ],
      };
      assert.strictEqual(validateManifest(manifest), true);
    });

    it('should validate a manifest with optional sha256 hashes', () => {
      const manifest = {
        version: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        totalRecords: 100,
        partitions: [
          {
            prefix: '00',
            location: { type: 'file', filename: '00.cdb' },
            recordCount: 100,
            size: 10240,
            sha256:
              'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          },
        ],
      };
      assert.strictEqual(validateManifest(manifest), true);
    });

    it('should validate a manifest with optional metadata', () => {
      const manifest = {
        version: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        totalRecords: 0,
        partitions: [],
        metadata: {
          source: 'ar-io-node',
          customField: 123,
        },
      };
      assert.strictEqual(validateManifest(manifest), true);
    });

    it('should ignore unknown fields (forward compatibility)', () => {
      const manifest = {
        version: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        totalRecords: 0,
        partitions: [],
        unknownField: 'should be ignored',
        anotherUnknown: { nested: 'value' },
      };
      assert.strictEqual(validateManifest(manifest), true);
    });

    it('should reject null input', () => {
      assert.strictEqual(validateManifest(null), false);
    });

    it('should reject non-object input', () => {
      assert.strictEqual(validateManifest('string'), false);
      assert.strictEqual(validateManifest(123), false);
      assert.strictEqual(validateManifest(true), false);
      assert.strictEqual(validateManifest([]), false);
    });

    it('should reject invalid version', () => {
      const manifest = {
        version: 2,
        createdAt: '2024-01-01T00:00:00.000Z',
        totalRecords: 0,
        partitions: [],
      };
      assert.strictEqual(validateManifest(manifest), false);
    });

    it('should reject missing version', () => {
      const manifest = {
        createdAt: '2024-01-01T00:00:00.000Z',
        totalRecords: 0,
        partitions: [],
      };
      assert.strictEqual(validateManifest(manifest), false);
    });

    it('should reject invalid createdAt', () => {
      const manifest = {
        version: 1,
        createdAt: '',
        totalRecords: 0,
        partitions: [],
      };
      assert.strictEqual(validateManifest(manifest), false);
    });

    it('should reject non-string createdAt', () => {
      const manifest = {
        version: 1,
        createdAt: 12345,
        totalRecords: 0,
        partitions: [],
      };
      assert.strictEqual(validateManifest(manifest), false);
    });

    it('should reject negative totalRecords', () => {
      const manifest = {
        version: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        totalRecords: -1,
        partitions: [],
      };
      assert.strictEqual(validateManifest(manifest), false);
    });

    it('should reject non-integer totalRecords', () => {
      const manifest = {
        version: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        totalRecords: 1.5,
        partitions: [],
      };
      assert.strictEqual(validateManifest(manifest), false);
    });

    it('should reject non-array partitions', () => {
      const manifest = {
        version: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        totalRecords: 0,
        partitions: 'not an array',
      };
      assert.strictEqual(validateManifest(manifest), false);
    });

    it('should reject invalid prefix format (uppercase)', () => {
      const manifest = {
        version: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        totalRecords: 100,
        partitions: [
          {
            prefix: 'AB', // Should be lowercase
            location: { type: 'file', filename: 'ab.cdb' },
            recordCount: 100,
            size: 10240,
          },
        ],
      };
      assert.strictEqual(validateManifest(manifest), false);
    });

    it('should reject invalid prefix format (single char)', () => {
      const manifest = {
        version: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        totalRecords: 100,
        partitions: [
          {
            prefix: 'a',
            location: { type: 'file', filename: 'a.cdb' },
            recordCount: 100,
            size: 10240,
          },
        ],
      };
      assert.strictEqual(validateManifest(manifest), false);
    });

    it('should reject invalid prefix format (non-hex)', () => {
      const manifest = {
        version: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        totalRecords: 100,
        partitions: [
          {
            prefix: 'gg',
            location: { type: 'file', filename: 'gg.cdb' },
            recordCount: 100,
            size: 10240,
          },
        ],
      };
      assert.strictEqual(validateManifest(manifest), false);
    });

    it('should reject duplicate prefixes', () => {
      const manifest = {
        version: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        totalRecords: 200,
        partitions: [
          {
            prefix: '00',
            location: { type: 'file', filename: '00.cdb' },
            recordCount: 100,
            size: 10240,
          },
          {
            prefix: '00', // Duplicate
            location: { type: 'file', filename: '00-copy.cdb' },
            recordCount: 100,
            size: 10240,
          },
        ],
      };
      assert.strictEqual(validateManifest(manifest), false);
    });

    it('should reject invalid location type', () => {
      const manifest = {
        version: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        totalRecords: 100,
        partitions: [
          {
            prefix: '00',
            location: { type: 'invalid', path: '/some/path' },
            recordCount: 100,
            size: 10240,
          },
        ],
      };
      assert.strictEqual(validateManifest(manifest), false);
    });

    it('should reject file location with missing filename', () => {
      const manifest = {
        version: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        totalRecords: 100,
        partitions: [
          {
            prefix: '00',
            location: { type: 'file' },
            recordCount: 100,
            size: 10240,
          },
        ],
      };
      assert.strictEqual(validateManifest(manifest), false);
    });

    it('should reject http location with missing url', () => {
      const manifest = {
        version: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        totalRecords: 100,
        partitions: [
          {
            prefix: '00',
            location: { type: 'http' },
            recordCount: 100,
            size: 10240,
          },
        ],
      };
      assert.strictEqual(validateManifest(manifest), false);
    });

    it('should reject arweave-bundle-item with negative offset', () => {
      const manifest = {
        version: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        totalRecords: 100,
        partitions: [
          {
            prefix: '00',
            location: {
              type: 'arweave-bundle-item',
              txId: 'ABC123',
              offset: -1,
              size: 10240,
            },
            recordCount: 100,
            size: 10240,
          },
        ],
      };
      assert.strictEqual(validateManifest(manifest), false);
    });

    it('should reject arweave-bundle-item with zero size', () => {
      const manifest = {
        version: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        totalRecords: 100,
        partitions: [
          {
            prefix: '00',
            location: {
              type: 'arweave-bundle-item',
              txId: 'ABC123',
              offset: 0,
              size: 0,
            },
            recordCount: 100,
            size: 10240,
          },
        ],
      };
      assert.strictEqual(validateManifest(manifest), false);
    });

    it('should reject negative recordCount', () => {
      const manifest = {
        version: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        totalRecords: 100,
        partitions: [
          {
            prefix: '00',
            location: { type: 'file', filename: '00.cdb' },
            recordCount: -1,
            size: 10240,
          },
        ],
      };
      assert.strictEqual(validateManifest(manifest), false);
    });

    it('should reject zero size', () => {
      const manifest = {
        version: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        totalRecords: 100,
        partitions: [
          {
            prefix: '00',
            location: { type: 'file', filename: '00.cdb' },
            recordCount: 100,
            size: 0,
          },
        ],
      };
      assert.strictEqual(validateManifest(manifest), false);
    });

    it('should reject negative size', () => {
      const manifest = {
        version: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        totalRecords: 100,
        partitions: [
          {
            prefix: '00',
            location: { type: 'file', filename: '00.cdb' },
            recordCount: 100,
            size: -1,
          },
        ],
      };
      assert.strictEqual(validateManifest(manifest), false);
    });

    it('should reject non-string sha256', () => {
      const manifest = {
        version: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        totalRecords: 100,
        partitions: [
          {
            prefix: '00',
            location: { type: 'file', filename: '00.cdb' },
            recordCount: 100,
            size: 10240,
            sha256: 12345,
          },
        ],
      };
      assert.strictEqual(validateManifest(manifest), false);
    });

    it('should reject non-object metadata', () => {
      const manifest = {
        version: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        totalRecords: 0,
        partitions: [],
        metadata: 'not an object',
      };
      assert.strictEqual(validateManifest(manifest), false);
    });
  });

  describe('parseManifest', () => {
    it('should parse a valid manifest JSON', () => {
      const json = JSON.stringify({
        version: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        totalRecords: 100,
        partitions: [
          {
            prefix: '00',
            location: { type: 'file', filename: '00.cdb' },
            recordCount: 100,
            size: 10240,
          },
        ],
      });

      const manifest = parseManifest(json);
      assert.strictEqual(manifest.version, 1);
      assert.strictEqual(manifest.createdAt, '2024-01-01T00:00:00.000Z');
      assert.strictEqual(manifest.totalRecords, 100);
      assert.strictEqual(manifest.partitions.length, 1);
      assert.strictEqual(manifest.partitions[0].prefix, '00');
    });

    it('should strip unknown fields when parsing', () => {
      const json = JSON.stringify({
        version: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        totalRecords: 0,
        partitions: [],
        unknownField: 'should be stripped',
      });

      const manifest = parseManifest(json);
      assert.strictEqual('unknownField' in manifest, false);
    });

    it('should preserve optional sha256 hash', () => {
      const json = JSON.stringify({
        version: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        totalRecords: 100,
        partitions: [
          {
            prefix: '00',
            location: { type: 'file', filename: '00.cdb' },
            recordCount: 100,
            size: 10240,
            sha256: 'abc123',
          },
        ],
      });

      const manifest = parseManifest(json);
      assert.strictEqual(manifest.partitions[0].sha256, 'abc123');
    });

    it('should preserve optional metadata', () => {
      const json = JSON.stringify({
        version: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        totalRecords: 0,
        partitions: [],
        metadata: { source: 'test' },
      });

      const manifest = parseManifest(json);
      assert.deepStrictEqual(manifest.metadata, { source: 'test' });
    });

    it('should throw on invalid JSON', () => {
      assert.throws(
        () => parseManifest('not valid json'),
        /Invalid manifest JSON/,
      );
    });

    it('should throw on invalid manifest schema', () => {
      const json = JSON.stringify({
        version: 2, // Invalid version
        createdAt: '2024-01-01T00:00:00.000Z',
        totalRecords: 0,
        partitions: [],
      });

      assert.throws(
        () => parseManifest(json),
        /Invalid manifest: schema validation failed/,
      );
    });
  });

  describe('serializeManifest', () => {
    it('should serialize a manifest to JSON', () => {
      const manifest: Cdb64Manifest = {
        version: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        totalRecords: 100,
        partitions: [
          {
            prefix: '00',
            location: { type: 'file', filename: '00.cdb' },
            recordCount: 100,
            size: 10240,
          },
        ],
      };

      const json = serializeManifest(manifest);
      const parsed = JSON.parse(json);
      assert.strictEqual(parsed.version, 1);
      assert.strictEqual(parsed.partitions.length, 1);
    });

    it('should use 2-space indentation', () => {
      const manifest: Cdb64Manifest = {
        version: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        totalRecords: 0,
        partitions: [],
      };

      const json = serializeManifest(manifest);
      assert.strictEqual(json.includes('  "version"'), true);
    });

    it('should throw on invalid manifest', () => {
      const invalidManifest = {
        version: 2, // Invalid
        createdAt: '2024-01-01T00:00:00.000Z',
        totalRecords: 0,
        partitions: [],
      } as unknown as Cdb64Manifest;

      assert.throws(
        () => serializeManifest(invalidManifest),
        /Invalid manifest: cannot serialize invalid manifest/,
      );
    });
  });

  describe('parseManifest/serializeManifest round-trip', () => {
    it('should round-trip a complex manifest', () => {
      const original: Cdb64Manifest = {
        version: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        totalRecords: 500,
        partitions: [
          {
            prefix: '00',
            location: { type: 'file', filename: '00.cdb' },
            recordCount: 100,
            size: 10240,
            sha256: 'hash1',
          },
          {
            prefix: 'ab',
            location: { type: 'http', url: 'https://example.com/ab.cdb' },
            recordCount: 150,
            size: 15360,
          },
          {
            prefix: 'cd',
            location: { type: 'arweave-tx', txId: 'txid123' },
            recordCount: 100,
            size: 10240,
          },
          {
            prefix: 'ef',
            location: {
              type: 'arweave-bundle-item',
              txId: 'txid456',
              offset: 1024,
              size: 10240,
            },
            recordCount: 150,
            size: 15360,
          },
        ],
        metadata: { source: 'test', version: '1.0' },
      };

      const json = serializeManifest(original);
      const parsed = parseManifest(json);

      assert.deepStrictEqual(parsed, original);
    });
  });

  describe('getPartitionPrefix', () => {
    it('should return 00 for key starting with 0x00', () => {
      const key = Buffer.from([0x00, 0x11, 0x22]);
      assert.strictEqual(getPartitionPrefix(key), '00');
    });

    it('should return ff for key starting with 0xff', () => {
      const key = Buffer.from([0xff, 0x11, 0x22]);
      assert.strictEqual(getPartitionPrefix(key), 'ff');
    });

    it('should return lowercase hex', () => {
      const key = Buffer.from([0xab, 0x11, 0x22]);
      assert.strictEqual(getPartitionPrefix(key), 'ab');
    });

    it('should pad single digit with leading zero', () => {
      const key = Buffer.from([0x0a, 0x11, 0x22]);
      assert.strictEqual(getPartitionPrefix(key), '0a');
    });

    it('should throw for empty key', () => {
      assert.throws(
        () => getPartitionPrefix(Buffer.alloc(0)),
        /Key must be at least 1 byte/,
      );
    });
  });

  describe('getPartitionIndex', () => {
    it('should return 0 for key starting with 0x00', () => {
      const key = Buffer.from([0x00, 0x11, 0x22]);
      assert.strictEqual(getPartitionIndex(key), 0);
    });

    it('should return 255 for key starting with 0xff', () => {
      const key = Buffer.from([0xff, 0x11, 0x22]);
      assert.strictEqual(getPartitionIndex(key), 255);
    });

    it('should return the first byte value', () => {
      const key = Buffer.from([0x7f, 0x11, 0x22]);
      assert.strictEqual(getPartitionIndex(key), 127);
    });

    it('should throw for empty key', () => {
      assert.throws(
        () => getPartitionIndex(Buffer.alloc(0)),
        /Key must be at least 1 byte/,
      );
    });
  });

  describe('indexToPrefix', () => {
    it('should convert 0 to 00', () => {
      assert.strictEqual(indexToPrefix(0), '00');
    });

    it('should convert 255 to ff', () => {
      assert.strictEqual(indexToPrefix(255), 'ff');
    });

    it('should convert 10 to 0a', () => {
      assert.strictEqual(indexToPrefix(10), '0a');
    });

    it('should convert 171 to ab', () => {
      assert.strictEqual(indexToPrefix(171), 'ab');
    });

    it('should throw for negative index', () => {
      assert.throws(
        () => indexToPrefix(-1),
        /Index must be an integer between 0 and 255/,
      );
    });

    it('should throw for index > 255', () => {
      assert.throws(
        () => indexToPrefix(256),
        /Index must be an integer between 0 and 255/,
      );
    });

    it('should throw for non-integer', () => {
      assert.throws(
        () => indexToPrefix(1.5),
        /Index must be an integer between 0 and 255/,
      );
    });
  });

  describe('prefixToIndex', () => {
    it('should convert 00 to 0', () => {
      assert.strictEqual(prefixToIndex('00'), 0);
    });

    it('should convert ff to 255', () => {
      assert.strictEqual(prefixToIndex('ff'), 255);
    });

    it('should convert 0a to 10', () => {
      assert.strictEqual(prefixToIndex('0a'), 10);
    });

    it('should convert ab to 171', () => {
      assert.strictEqual(prefixToIndex('ab'), 171);
    });

    it('should throw for uppercase prefix', () => {
      assert.throws(
        () => prefixToIndex('AB'),
        /Prefix must be a 2-character lowercase hex string/,
      );
    });

    it('should throw for single char prefix', () => {
      assert.throws(
        () => prefixToIndex('a'),
        /Prefix must be a 2-character lowercase hex string/,
      );
    });

    it('should throw for non-hex prefix', () => {
      assert.throws(
        () => prefixToIndex('gg'),
        /Prefix must be a 2-character lowercase hex string/,
      );
    });
  });

  describe('indexToPrefix/prefixToIndex round-trip', () => {
    it('should round-trip all values 0-255', () => {
      for (let i = 0; i <= 255; i++) {
        const prefix = indexToPrefix(i);
        const index = prefixToIndex(prefix);
        assert.strictEqual(index, i, `Round-trip failed for index ${i}`);
      }
    });
  });

  describe('createEmptyManifest', () => {
    it('should create a manifest with zero records and no partitions', () => {
      const manifest = createEmptyManifest();
      assert.strictEqual(manifest.version, 1);
      assert.strictEqual(manifest.totalRecords, 0);
      assert.strictEqual(manifest.partitions.length, 0);
      assert.strictEqual(manifest.metadata, undefined);
    });

    it('should create a manifest with current timestamp', () => {
      const before = new Date().toISOString();
      const manifest = createEmptyManifest();
      const after = new Date().toISOString();

      assert.strictEqual(manifest.createdAt >= before, true);
      assert.strictEqual(manifest.createdAt <= after, true);
    });

    it('should include metadata if provided', () => {
      const metadata = { source: 'test', version: '1.0' };
      const manifest = createEmptyManifest(metadata);
      assert.deepStrictEqual(manifest.metadata, metadata);
    });

    it('should create a valid manifest', () => {
      const manifest = createEmptyManifest({ source: 'test' });
      assert.strictEqual(validateManifest(manifest), true);
    });
  });
});
