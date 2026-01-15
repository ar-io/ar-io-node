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
  isPathValue,
  isPathCompleteValue,
  getRootTxId,
  getPath,
  hasOffsets,
  Cdb64RootTxValue,
  Cdb64RootTxValueSimple,
  Cdb64RootTxValueComplete,
  Cdb64RootTxValuePath,
  Cdb64RootTxValuePathComplete,
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
        assert.equal(isPathValue(decoded), false);
        const simpleDecoded = decoded as Cdb64RootTxValueSimple;
        assert(simpleDecoded.rootTxId.equals(original.rootTxId));
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

    describe('path format', () => {
      it('should round-trip path-only value', () => {
        const original: Cdb64RootTxValuePath = {
          path: [createTestTxId(1), createTestTxId(2), createTestTxId(3)],
        };

        const encoded = encodeCdb64Value(original);
        const decoded = decodeCdb64Value(encoded);

        assert(isPathValue(decoded));
        assert(!isPathCompleteValue(decoded));
        assert.equal(decoded.path.length, 3);
        assert(decoded.path[0].equals(original.path[0]));
        assert(decoded.path[1].equals(original.path[1]));
        assert(decoded.path[2].equals(original.path[2]));
      });

      it('should round-trip path-complete value', () => {
        const original: Cdb64RootTxValuePathComplete = {
          path: [createTestTxId(10), createTestTxId(20)],
          rootDataItemOffset: 5000,
          rootDataOffset: 6000,
        };

        const encoded = encodeCdb64Value(original);
        const decoded = decodeCdb64Value(encoded);

        assert(isPathValue(decoded));
        assert(isPathCompleteValue(decoded));
        assert.equal(decoded.path.length, 2);
        assert(decoded.path[0].equals(original.path[0]));
        assert(decoded.path[1].equals(original.path[1]));
        assert.equal(decoded.rootDataItemOffset, original.rootDataItemOffset);
        assert.equal(decoded.rootDataOffset, original.rootDataOffset);
      });

      it('should handle single-element path (data item directly in root)', () => {
        const original: Cdb64RootTxValuePath = {
          path: [createTestTxId(99)],
        };

        const encoded = encodeCdb64Value(original);
        const decoded = decodeCdb64Value(encoded);

        assert(isPathValue(decoded));
        assert.equal(decoded.path.length, 1);
        assert(decoded.path[0].equals(original.path[0]));
      });

      it('should throw error for empty path', () => {
        const value: Cdb64RootTxValuePath = {
          path: [],
        };

        assert.throws(
          () => encodeCdb64Value(value),
          /path must be a non-empty array/,
        );
      });

      it('should throw error for path with wrong-sized element', () => {
        const value = {
          path: [createTestTxId(1), Buffer.alloc(16)], // Second element wrong size
        } as Cdb64RootTxValuePath;

        assert.throws(
          () => encodeCdb64Value(value),
          /Each path element must be a 32-byte Buffer/,
        );
      });

      it('should accept path with exactly MAX_BUNDLE_NESTING_DEPTH elements', () => {
        const value: Cdb64RootTxValuePath = {
          path: Array.from({ length: 10 }, (_, i) => createTestTxId(i)),
        };

        // Should not throw - 10 elements is the maximum allowed
        const encoded = encodeCdb64Value(value);
        const decoded = decodeCdb64Value(encoded);

        assert.ok(isPathValue(decoded));
        assert.equal(decoded.path.length, 10);
      });

      it('should throw error for path exceeding MAX_BUNDLE_NESTING_DEPTH', () => {
        const value: Cdb64RootTxValuePath = {
          path: Array.from({ length: 11 }, (_, i) => createTestTxId(i)),
        };

        assert.throws(() => encodeCdb64Value(value), /exceeds maximum depth/);
      });
    });

    describe('path decode validation', () => {
      it('should throw error for empty path in encoded value', () => {
        const encoded = toMsgpack({ p: [] });

        assert.throws(
          () => decodeCdb64Value(encoded),
          /path must be a non-empty array/,
        );
      });

      it('should throw error for path with wrong-sized element in encoded value', () => {
        const encoded = toMsgpack({
          p: [createTestTxId(1), Buffer.alloc(16)],
        });

        assert.throws(
          () => decodeCdb64Value(encoded),
          /each path element must be a 32-byte Buffer/,
        );
      });
    });
  });

  describe('isPathValue', () => {
    it('should return true for path-only values', () => {
      const value: Cdb64RootTxValuePath = {
        path: [createTestTxId()],
      };
      assert.equal(isPathValue(value), true);
    });

    it('should return true for path-complete values', () => {
      const value: Cdb64RootTxValuePathComplete = {
        path: [createTestTxId()],
        rootDataItemOffset: 100,
        rootDataOffset: 200,
      };
      assert.equal(isPathValue(value), true);
    });

    it('should return false for simple values', () => {
      const value: Cdb64RootTxValueSimple = {
        rootTxId: createTestTxId(),
      };
      assert.equal(isPathValue(value), false);
    });

    it('should return false for complete values', () => {
      const value: Cdb64RootTxValueComplete = {
        rootTxId: createTestTxId(),
        rootDataItemOffset: 100,
        rootDataOffset: 200,
      };
      assert.equal(isPathValue(value), false);
    });
  });

  describe('isPathCompleteValue', () => {
    it('should return true for path-complete values', () => {
      const value: Cdb64RootTxValuePathComplete = {
        path: [createTestTxId()],
        rootDataItemOffset: 100,
        rootDataOffset: 200,
      };
      assert.equal(isPathCompleteValue(value), true);
    });

    it('should return false for path-only values', () => {
      const value: Cdb64RootTxValuePath = {
        path: [createTestTxId()],
      };
      assert.equal(isPathCompleteValue(value), false);
    });

    it('should return false for legacy complete values', () => {
      const value: Cdb64RootTxValueComplete = {
        rootTxId: createTestTxId(),
        rootDataItemOffset: 100,
        rootDataOffset: 200,
      };
      assert.equal(isPathCompleteValue(value), false);
    });
  });

  describe('getRootTxId', () => {
    it('should return rootTxId from simple value', () => {
      const txId = createTestTxId(42);
      const value: Cdb64RootTxValueSimple = { rootTxId: txId };
      assert(getRootTxId(value).equals(txId));
    });

    it('should return rootTxId from complete value', () => {
      const txId = createTestTxId(42);
      const value: Cdb64RootTxValueComplete = {
        rootTxId: txId,
        rootDataItemOffset: 100,
        rootDataOffset: 200,
      };
      assert(getRootTxId(value).equals(txId));
    });

    it('should return path[0] from path value', () => {
      const rootTxId = createTestTxId(1);
      const value: Cdb64RootTxValuePath = {
        path: [rootTxId, createTestTxId(2), createTestTxId(3)],
      };
      assert(getRootTxId(value).equals(rootTxId));
    });

    it('should return path[0] from path-complete value', () => {
      const rootTxId = createTestTxId(1);
      const value: Cdb64RootTxValuePathComplete = {
        path: [rootTxId, createTestTxId(2)],
        rootDataItemOffset: 100,
        rootDataOffset: 200,
      };
      assert(getRootTxId(value).equals(rootTxId));
    });
  });

  describe('getPath', () => {
    it('should return undefined for simple value', () => {
      const value: Cdb64RootTxValueSimple = { rootTxId: createTestTxId() };
      assert.equal(getPath(value), undefined);
    });

    it('should return undefined for complete value', () => {
      const value: Cdb64RootTxValueComplete = {
        rootTxId: createTestTxId(),
        rootDataItemOffset: 100,
        rootDataOffset: 200,
      };
      assert.equal(getPath(value), undefined);
    });

    it('should return path from path value', () => {
      const path = [createTestTxId(1), createTestTxId(2)];
      const value: Cdb64RootTxValuePath = { path };
      const result = getPath(value);
      assert(result !== undefined);
      assert.equal(result.length, 2);
      assert(result[0].equals(path[0]));
      assert(result[1].equals(path[1]));
    });

    it('should return path from path-complete value', () => {
      const path = [createTestTxId(1)];
      const value: Cdb64RootTxValuePathComplete = {
        path,
        rootDataItemOffset: 100,
        rootDataOffset: 200,
      };
      const result = getPath(value);
      assert(result !== undefined);
      assert.equal(result.length, 1);
    });
  });

  describe('hasOffsets', () => {
    it('should return true for complete value', () => {
      const value: Cdb64RootTxValueComplete = {
        rootTxId: createTestTxId(),
        rootDataItemOffset: 100,
        rootDataOffset: 200,
      };
      assert.equal(hasOffsets(value), true);
    });

    it('should return true for path-complete value', () => {
      const value: Cdb64RootTxValuePathComplete = {
        path: [createTestTxId()],
        rootDataItemOffset: 100,
        rootDataOffset: 200,
      };
      assert.equal(hasOffsets(value), true);
    });

    it('should return false for simple value', () => {
      const value: Cdb64RootTxValueSimple = { rootTxId: createTestTxId() };
      assert.equal(hasOffsets(value), false);
    });

    it('should return false for path-only value', () => {
      const value: Cdb64RootTxValuePath = { path: [createTestTxId()] };
      assert.equal(hasOffsets(value), false);
    });
  });

  describe('backward compatibility', () => {
    it('should decode legacy simple format { r } values', () => {
      // Simulate a legacy-encoded simple value
      const rootTxId = createTestTxId(50);
      const encoded = toMsgpack({ r: rootTxId });
      const decoded = decodeCdb64Value(encoded);

      assert(!isPathValue(decoded));
      assert(!isCompleteValue(decoded));
      const simpleDecoded = decoded as Cdb64RootTxValueSimple;
      assert(simpleDecoded.rootTxId.equals(rootTxId));
    });

    it('should decode legacy complete format { r, i, d } values', () => {
      // Simulate a legacy-encoded complete value
      const rootTxId = createTestTxId(60);
      const encoded = toMsgpack({ r: rootTxId, i: 1000, d: 2000 });
      const decoded = decodeCdb64Value(encoded);

      assert(!isPathValue(decoded));
      assert(isCompleteValue(decoded));
      const completeDecoded = decoded as Cdb64RootTxValueComplete;
      assert(completeDecoded.rootTxId.equals(rootTxId));
      assert.equal(completeDecoded.rootDataItemOffset, 1000);
      assert.equal(completeDecoded.rootDataOffset, 2000);
    });
  });
});
