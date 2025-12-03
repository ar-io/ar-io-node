/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTestLogger } from '../../test/test-logger.js';
import {
  BlockOffsetMapping,
  OffsetBlockMapping,
} from './block-offset-mapping.js';

describe('BlockOffsetMapping', () => {
  const log = createTestLogger({ suite: 'BlockOffsetMapping' });
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'block-offset-mapping-test-'),
    );
  });

  function writeMappingFile(mapping: OffsetBlockMapping): string {
    const filePath = path.join(tempDir, 'test-mapping.json');
    fs.writeFileSync(filePath, JSON.stringify(mapping, null, 2));
    return filePath;
  }

  function createValidMapping(): OffsetBlockMapping {
    return {
      version: '1.0',
      generatedAt: '2025-01-15T00:00:00Z',
      currentHeight: 1800000,
      currentWeaveSize: 374000000000000,
      intervalBytes: 5497558138880,
      intervals: [
        { offset: 0, blockHeight: 0 },
        { offset: 5497558138880, blockHeight: 642449 },
        { offset: 10995116277760, blockHeight: 731523 },
        { offset: 16492674416640, blockHeight: 779014 },
        { offset: 21990232555520, blockHeight: 807172 },
      ],
    };
  }

  describe('loading', () => {
    it('should load valid mapping file', () => {
      const mapping = createValidMapping();
      const filePath = writeMappingFile(mapping);

      const blockMapping = new BlockOffsetMapping({ log, filePath });

      assert.equal(blockMapping.isLoaded(), true);
      const loadedMapping = blockMapping.getMapping();
      assert.equal(loadedMapping?.version, '1.0');
      assert.equal(loadedMapping?.intervals.length, 5);
    });

    it('should handle missing file gracefully', () => {
      const blockMapping = new BlockOffsetMapping({
        log,
        filePath: '/nonexistent/path/mapping.json',
      });

      assert.equal(blockMapping.isLoaded(), false);
      assert.equal(blockMapping.getSearchBounds(1000, 1800000), undefined);
    });

    it('should handle invalid JSON gracefully', () => {
      const filePath = path.join(tempDir, 'invalid.json');
      fs.writeFileSync(filePath, 'not valid json{{{');

      const blockMapping = new BlockOffsetMapping({ log, filePath });

      assert.equal(blockMapping.isLoaded(), false);
    });

    it('should handle missing required fields gracefully', () => {
      const filePath = path.join(tempDir, 'incomplete.json');
      fs.writeFileSync(filePath, JSON.stringify({ version: '1.0' }));

      const blockMapping = new BlockOffsetMapping({ log, filePath });

      assert.equal(blockMapping.isLoaded(), false);
    });

    it('should handle empty intervals array gracefully', () => {
      const mapping = createValidMapping();
      mapping.intervals = [];
      const filePath = writeMappingFile(mapping);

      const blockMapping = new BlockOffsetMapping({ log, filePath });

      assert.equal(blockMapping.isLoaded(), false);
    });

    it('should handle single interval gracefully', () => {
      const mapping = createValidMapping();
      mapping.intervals = [{ offset: 0, blockHeight: 0 }];
      const filePath = writeMappingFile(mapping);

      const blockMapping = new BlockOffsetMapping({ log, filePath });

      assert.equal(blockMapping.isLoaded(), false);
    });

    it('should reject non-monotonic offsets', () => {
      const mapping = createValidMapping();
      mapping.intervals = [
        { offset: 0, blockHeight: 0 },
        { offset: 10000, blockHeight: 100 },
        { offset: 5000, blockHeight: 200 }, // Not monotonic
      ];
      const filePath = writeMappingFile(mapping);

      const blockMapping = new BlockOffsetMapping({ log, filePath });

      assert.equal(blockMapping.isLoaded(), false);
    });

    it('should reject non-monotonic block heights', () => {
      const mapping = createValidMapping();
      mapping.intervals = [
        { offset: 0, blockHeight: 0 },
        { offset: 10000, blockHeight: 200 },
        { offset: 20000, blockHeight: 100 }, // Not monotonic
      ];
      const filePath = writeMappingFile(mapping);

      const blockMapping = new BlockOffsetMapping({ log, filePath });

      assert.equal(blockMapping.isLoaded(), false);
    });

    it('should handle no filePath provided', () => {
      const blockMapping = new BlockOffsetMapping({ log });

      assert.equal(blockMapping.isLoaded(), false);
      assert.equal(blockMapping.getSearchBounds(1000, 1800000), undefined);
    });
  });

  describe('getSearchBounds', () => {
    it('should return undefined when not loaded', () => {
      const blockMapping = new BlockOffsetMapping({ log });

      const bounds = blockMapping.getSearchBounds(1000000, 1800000);

      assert.equal(bounds, undefined);
    });

    it('should narrow bounds for offset in first interval', () => {
      const mapping = createValidMapping();
      const filePath = writeMappingFile(mapping);
      const blockMapping = new BlockOffsetMapping({ log, filePath });

      // Target offset between genesis (0) and first interval (5TB)
      const bounds = blockMapping.getSearchBounds(1000000000000, 1800000);

      assert.notEqual(bounds, undefined);
      assert.equal(bounds?.lowHeight, 0);
      assert.equal(bounds?.highHeight, 642449);
    });

    it('should narrow bounds for offset in middle interval', () => {
      const mapping = createValidMapping();
      const filePath = writeMappingFile(mapping);
      const blockMapping = new BlockOffsetMapping({ log, filePath });

      // Target offset between second (5TB) and third (10TB) intervals
      const bounds = blockMapping.getSearchBounds(7000000000000, 1800000);

      assert.notEqual(bounds, undefined);
      assert.equal(bounds?.lowHeight, 642449);
      assert.equal(bounds?.highHeight, 731523);
    });

    it('should narrow bounds for offset in last interval', () => {
      const mapping = createValidMapping();
      const filePath = writeMappingFile(mapping);
      const blockMapping = new BlockOffsetMapping({ log, filePath });

      // Target offset between fourth and fifth intervals
      const bounds = blockMapping.getSearchBounds(19000000000000, 1800000);

      assert.notEqual(bounds, undefined);
      assert.equal(bounds?.lowHeight, 779014);
      assert.equal(bounds?.highHeight, 807172);
    });

    it('should handle offset beyond last interval', () => {
      const mapping = createValidMapping();
      const filePath = writeMappingFile(mapping);
      const blockMapping = new BlockOffsetMapping({ log, filePath });

      // Target offset beyond all mapped intervals
      const bounds = blockMapping.getSearchBounds(50000000000000, 1800000);

      assert.notEqual(bounds, undefined);
      assert.equal(bounds?.lowHeight, 807172);
      assert.equal(bounds?.highHeight, 1800000);
    });

    it('should handle offset at exact interval boundary', () => {
      const mapping = createValidMapping();
      const filePath = writeMappingFile(mapping);
      const blockMapping = new BlockOffsetMapping({ log, filePath });

      // Target offset exactly at second interval
      const bounds = blockMapping.getSearchBounds(5497558138880, 1800000);

      assert.notEqual(bounds, undefined);
      // At exact boundary, should use this interval as lowHeight
      assert.equal(bounds?.lowHeight, 642449);
    });

    it('should handle offset before first interval', () => {
      const mapping = createValidMapping();
      // Make first interval non-zero for this test
      mapping.intervals[0].offset = 1000;
      const filePath = writeMappingFile(mapping);
      const blockMapping = new BlockOffsetMapping({ log, filePath });

      const bounds = blockMapping.getSearchBounds(500, 1800000);

      assert.notEqual(bounds, undefined);
      assert.equal(bounds?.lowHeight, 0);
      assert.equal(bounds?.highHeight, 0);
    });

    it('should respect currentHeight parameter', () => {
      const mapping = createValidMapping();
      const filePath = writeMappingFile(mapping);
      const blockMapping = new BlockOffsetMapping({ log, filePath });

      // Pass a currentHeight different from mapping's
      const bounds = blockMapping.getSearchBounds(50000000000000, 2000000);

      assert.notEqual(bounds, undefined);
      assert.equal(bounds?.lowHeight, 807172);
      assert.equal(bounds?.highHeight, 2000000); // Uses passed currentHeight
    });

    it('should use binary search for efficient interval lookup', () => {
      // Create a mapping with many intervals
      const mapping = createValidMapping();
      mapping.intervals = [];
      for (let i = 0; i < 100; i++) {
        mapping.intervals.push({
          offset: i * 1000000000000,
          blockHeight: i * 10000,
        });
      }
      const filePath = writeMappingFile(mapping);
      const blockMapping = new BlockOffsetMapping({ log, filePath });

      // Target offset in the middle (should be found efficiently)
      const bounds = blockMapping.getSearchBounds(50500000000000, 1800000);

      assert.notEqual(bounds, undefined);
      assert.equal(bounds?.lowHeight, 500000); // 50 * 10000
      assert.equal(bounds?.highHeight, 510000); // 51 * 10000
    });
  });
});
