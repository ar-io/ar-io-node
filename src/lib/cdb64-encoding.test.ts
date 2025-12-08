/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  encodeCdb64Value,
  decodeCdb64Value,
  isCompleteValue,
  Cdb64RootTxValue,
  Cdb64RootTxValueSimple,
  Cdb64RootTxValueComplete,
} from './cdb64-encoding.js';
import { toMsgpack } from './encoding.js';

describe('CDB64 Encoding', () => {
  // Generate a 32-byte test buffer that looks like a transaction ID
  const createTestTxId = (seed: number = 0): Buffer => {
    const buf = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) {
      buf[i] = (seed + i) % 256;
    }
    return buf;
  };

  describe('isCompleteValue', () => {
    it('should return true for complete values', () => {
      const value: Cdb64RootTxValueComplete = {
        rootTxId: createTestTxId(),
        rootDataItemOffset: 100,
        rootDataOffset: 200,
      };
      assert.equal(isCompleteValue(value), true);
    });

    it('should return false for simple values', () => {
      const value: Cdb64RootTxValueSimple = {
        rootTxId: createTestTxId(),
      };
      assert.equal(isCompleteValue(value), false);
    });

    it('should return false when only rootDataItemOffset is present', () => {
      const value = {
        rootTxId: createTestTxId(),
        rootDataItemOffset: 100,
      } as Cdb64RootTxValue;
      assert.equal(isCompleteValue(value), false);
    });

    it('should return false when only rootDataOffset is present', () => {
      const value = {
        rootTxId: createTestTxId(),
        rootDataOffset: 200,
      } as Cdb64RootTxValue;
      assert.equal(isCompleteValue(value), false);
    });
  });

  describe('encodeCdb64Value and decodeCdb64Value', () => {
    describe('simple format', () => {
      it('should round-trip simple value', () => {
        const original: Cdb64RootTxValueSimple = {
          rootTxId: createTestTxId(42),
        };

        const encoded = encodeCdb64Value(original);
        const decoded = decodeCdb64Value(encoded);

        assert.equal(isCompleteValue(decoded), false);
        assert(decoded.rootTxId.equals(original.rootTxId));
      });

      it('should encode simple value to compact representation', () => {
        const value: Cdb64RootTxValueSimple = {
          rootTxId: createTestTxId(),
        };

        const encoded = encodeCdb64Value(value);

        // Simple format should be relatively compact
        // 32-byte buffer + MessagePack overhead (key 'r' + type info)
        assert(
          encoded.length < 40,
          `Encoded size ${encoded.length} should be < 40 bytes`,
        );
      });
    });

    describe('complete format', () => {
      it('should round-trip complete value', () => {
        const original: Cdb64RootTxValueComplete = {
          rootTxId: createTestTxId(123),
          rootDataItemOffset: 12345,
          rootDataOffset: 67890,
        };

        const encoded = encodeCdb64Value(original);
        const decoded = decodeCdb64Value(encoded);

        assert(isCompleteValue(decoded));
        assert(decoded.rootTxId.equals(original.rootTxId));
        assert.equal(decoded.rootDataItemOffset, original.rootDataItemOffset);
        assert.equal(decoded.rootDataOffset, original.rootDataOffset);
      });

      it('should handle zero offsets', () => {
        const original: Cdb64RootTxValueComplete = {
          rootTxId: createTestTxId(),
          rootDataItemOffset: 0,
          rootDataOffset: 0,
        };

        const encoded = encodeCdb64Value(original);
        const decoded = decodeCdb64Value(encoded);

        assert(isCompleteValue(decoded));
        assert.equal(decoded.rootDataItemOffset, 0);
        assert.equal(decoded.rootDataOffset, 0);
      });

      it('should handle large offsets', () => {
        const original: Cdb64RootTxValueComplete = {
          rootTxId: createTestTxId(),
          rootDataItemOffset: 2 ** 40, // 1TB offset
          rootDataOffset: 2 ** 40 + 1000,
        };

        const encoded = encodeCdb64Value(original);
        const decoded = decodeCdb64Value(encoded);

        assert(isCompleteValue(decoded));
        assert.equal(decoded.rootDataItemOffset, original.rootDataItemOffset);
        assert.equal(decoded.rootDataOffset, original.rootDataOffset);
      });
    });

    describe('validation', () => {
      it('should throw error for non-32-byte rootTxId', () => {
        const value = {
          rootTxId: Buffer.alloc(16), // Wrong size
        };

        assert.throws(
          () => encodeCdb64Value(value as Cdb64RootTxValue),
          /rootTxId must be a 32-byte Buffer/,
        );
      });

      it('should throw error for non-Buffer rootTxId', () => {
        const value = {
          rootTxId: 'not-a-buffer',
        };

        assert.throws(
          () => encodeCdb64Value(value as unknown as Cdb64RootTxValue),
          /rootTxId must be a 32-byte Buffer/,
        );
      });

      it('should throw error for negative rootDataItemOffset', () => {
        const value: Cdb64RootTxValueComplete = {
          rootTxId: createTestTxId(),
          rootDataItemOffset: -1,
          rootDataOffset: 100,
        };

        assert.throws(
          () => encodeCdb64Value(value),
          /rootDataItemOffset must be a non-negative integer/,
        );
      });

      it('should throw error for negative rootDataOffset', () => {
        const value: Cdb64RootTxValueComplete = {
          rootTxId: createTestTxId(),
          rootDataItemOffset: 100,
          rootDataOffset: -1,
        };

        assert.throws(
          () => encodeCdb64Value(value),
          /rootDataOffset must be a non-negative integer/,
        );
      });

      it('should throw error for non-integer rootDataItemOffset', () => {
        const value: Cdb64RootTxValueComplete = {
          rootTxId: createTestTxId(),
          rootDataItemOffset: 100.5,
          rootDataOffset: 200,
        };

        assert.throws(
          () => encodeCdb64Value(value),
          /rootDataItemOffset must be a non-negative integer/,
        );
      });

      it('should throw error for non-integer rootDataOffset', () => {
        const value: Cdb64RootTxValueComplete = {
          rootTxId: createTestTxId(),
          rootDataItemOffset: 100,
          rootDataOffset: 200.5,
        };

        assert.throws(
          () => encodeCdb64Value(value),
          /rootDataOffset must be a non-negative integer/,
        );
      });
    });

    describe('decode validation', () => {
      it('should throw error for invalid buffer', () => {
        assert.throws(
          () => decodeCdb64Value(Buffer.from([0x00])),
          /Invalid CDB64 value/,
        );
      });

      it('should throw error for missing rootTxId', () => {
        // Create a valid MessagePack object without the 'r' field
        const encoded = toMsgpack({ x: 123 });

        assert.throws(
          () => decodeCdb64Value(encoded),
          /missing or invalid rootTxId/,
        );
      });

      it('should throw error for wrong size rootTxId', () => {
        const encoded = toMsgpack({ r: Buffer.alloc(16) });

        assert.throws(
          () => decodeCdb64Value(encoded),
          /rootTxId must be 32 bytes/,
        );
      });
    });
  });
});
