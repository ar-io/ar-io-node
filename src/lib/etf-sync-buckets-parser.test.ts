/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import {
  parseETFSyncBuckets,
  ETFParseError,
} from './etf-sync-buckets-parser.js';

describe('ETF Sync Buckets Parser', () => {
  describe('parseETFSyncBuckets', () => {
    it('should parse a simple sync buckets structure', () => {
      // Create a minimal ETF structure: {10737418240, #{0 => 0.5, 1 => 1.0}}
      // ETF bytes for: {10737418240, #{0 => 0.5, 1 => 1.0}}
      const etfData = new Uint8Array([
        131, // ETF version
        104,
        2, // small tuple with 2 elements
        110,
        5,
        0, // small big integer: 5 bytes, positive
        0,
        0,
        0,
        128,
        2, // 10737418240 (10GB) in little-endian
        116, // map tag
        0,
        0,
        0,
        2, // map size: 2 entries
        // First entry: 0 => 0.5
        97,
        0, // small integer: 0
        70, // new float
        63,
        224,
        0,
        0,
        0,
        0,
        0,
        0, // 0.5 as IEEE 754 double
        // Second entry: 1 => 1.0
        97,
        1, // small integer: 1
        70, // new float
        63,
        240,
        0,
        0,
        0,
        0,
        0,
        0, // 1.0 as IEEE 754 double
      ]);

      const result = parseETFSyncBuckets(etfData.buffer);

      assert.strictEqual(result.bucketSize, 10737418240);
      assert.strictEqual(result.buckets.size, 2);
      assert.ok(result.buckets.has(0));
      assert.ok(result.buckets.has(1));
    });

    it('should parse sync buckets with larger integers', () => {
      // Create ETF structure with larger bucket indices
      const etfData = new Uint8Array([
        131, // ETF version
        104,
        2, // small tuple with 2 elements
        110,
        5,
        0, // small big integer: 5 bytes, positive
        0,
        0,
        0,
        128,
        2, // 10737418240 (10GB) in little-endian
        116, // map tag
        0,
        0,
        0,
        1, // map size: 1 entry
        // Entry: 1000 => 0.8
        110,
        2,
        0, // small big integer: 2 bytes, positive
        232,
        3, // 1000 in little-endian (232 + 3*256 = 1000)
        70, // new float
        63,
        230,
        102,
        102,
        102,
        102,
        102,
        102, // 0.8 as IEEE 754 double
      ]);

      const result = parseETFSyncBuckets(etfData.buffer);

      assert.strictEqual(result.bucketSize, 10737418240);
      assert.strictEqual(result.buckets.size, 1);
      assert.ok(result.buckets.has(1000));
    });

    it('should handle empty map', () => {
      // ETF for {10737418240, #{}}
      const etfData = new Uint8Array([
        131, // ETF version
        104,
        2, // small tuple with 2 elements
        110,
        5,
        0, // small big integer: 5 bytes, positive
        0,
        0,
        0,
        128,
        2, // 10737418240 (10GB) in little-endian
        116, // map tag
        0,
        0,
        0,
        0, // map size: 0 entries
      ]);

      const result = parseETFSyncBuckets(etfData.buffer);

      assert.strictEqual(result.bucketSize, 10737418240);
      assert.strictEqual(result.buckets.size, 0);
    });

    it('should throw on invalid ETF version', () => {
      const etfData = new Uint8Array([130]); // Wrong version

      assert.throws(
        () => parseETFSyncBuckets(etfData.buffer),
        ETFParseError,
        'Should throw ETFParseError for invalid version',
      );
    });

    it('should throw on non-tuple structure', () => {
      const etfData = new Uint8Array([
        131, // ETF version
        97,
        42, // small integer instead of tuple
      ]);

      assert.throws(
        () => parseETFSyncBuckets(etfData.buffer),
        ETFParseError,
        'Should throw ETFParseError for non-tuple',
      );
    });

    it('should throw on wrong tuple arity', () => {
      const etfData = new Uint8Array([
        131, // ETF version
        104,
        3, // small tuple with 3 elements (should be 2)
      ]);

      assert.throws(
        () => parseETFSyncBuckets(etfData.buffer),
        ETFParseError,
        'Should throw ETFParseError for wrong arity',
      );
    });

    it('should throw on non-map second element', () => {
      const etfData = new Uint8Array([
        131, // ETF version
        104,
        2, // small tuple with 2 elements
        110,
        5,
        0, // small big integer: 5 bytes, positive
        0,
        0,
        0,
        128,
        2, // 10737418240 (10GB) in little-endian
        97,
        42, // small integer instead of map
      ]);

      assert.throws(
        () => parseETFSyncBuckets(etfData.buffer),
        ETFParseError,
        'Should throw ETFParseError for non-map',
      );
    });

    it('should throw on truncated data', () => {
      const etfData = new Uint8Array([
        131, // ETF version
        104,
        2, // small tuple with 2 elements
        110,
        5,
        0, // small big integer: 5 bytes, positive
        // Missing bucket size bytes
      ]);

      assert.throws(
        () => parseETFSyncBuckets(etfData.buffer),
        ETFParseError,
        'Should throw ETFParseError for truncated data',
      );
    });

    it('should handle small integer bucket indices', () => {
      // ETF for {10737418240, #{5 => 0.3}}
      const etfData = new Uint8Array([
        131, // ETF version
        104,
        2, // small tuple with 2 elements
        110,
        5,
        0, // small big integer: 5 bytes, positive
        0,
        0,
        0,
        128,
        2, // 10737418240 (10GB) in little-endian
        116, // map tag
        0,
        0,
        0,
        1, // map size: 1 entry
        // Entry: 5 => 0.3
        97,
        5, // small integer: 5
        70, // new float
        63,
        211,
        51,
        51,
        51,
        51,
        51,
        51, // 0.3 as IEEE 754 double
      ]);

      const result = parseETFSyncBuckets(etfData.buffer);

      assert.strictEqual(result.bucketSize, 10737418240);
      assert.strictEqual(result.buckets.size, 1);
      assert.ok(result.buckets.has(5));
    });
  });
});
