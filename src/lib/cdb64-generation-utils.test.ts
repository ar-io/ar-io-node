/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

// The CSV parsers live with the CDB64 tools; tests sit under src so they run
// in the unit suite.
import {
  parseDataItemSize,
  parseOffset,
} from '../../tools/lib/cdb64-generation-utils.js';

describe('cdb64 CSV parsing', () => {
  describe('parseOffset', () => {
    it('should parse decimal digits, ignoring surrounding whitespace', () => {
      assert.equal(parseOffset(' 3072 ', 'root_data_offset'), 3072);
      assert.equal(parseOffset('0', 'root_data_offset'), 0);
    });

    for (const value of [
      '3072bytes',
      '3072.5',
      '-1',
      '+5',
      '0x10',
      '1e3',
      '',
    ]) {
      it(`should reject "${value}"`, () => {
        assert.throws(
          () => parseOffset(value, 'root_data_offset'),
          /Invalid root_data_offset: expected non-negative integer/,
        );
      });
    }

    it('should reject values above the maximum safe integer', () => {
      assert.throws(
        () => parseOffset('9007199254740993', 'root_data_offset'),
        /exceeds maximum safe integer/,
      );
    });
  });

  describe('parseDataItemSize', () => {
    const row = (size: string) => ['id', 'root', '', '1024', '2048', size];

    it('should return undefined for five-column rows and empty sizes', () => {
      assert.equal(
        parseDataItemSize(['id', 'root', '', '1024', '2048'], true),
        undefined,
      );
      assert.equal(parseDataItemSize(row(' '), true), undefined);
    });

    it('should parse a size', () => {
      assert.equal(parseDataItemSize(row('3072'), true), 3072);
    });

    it('should reject a malformed size', () => {
      for (const value of ['3072bytes', '3072.5']) {
        assert.throws(
          () => parseDataItemSize(row(value), true),
          /Invalid data_item_size: expected non-negative integer/,
        );
      }
    });

    it('should reject a size without offsets', () => {
      assert.throws(
        () => parseDataItemSize(row('3072'), false),
        /data_item_size requires both/,
      );
    });
  });
});
