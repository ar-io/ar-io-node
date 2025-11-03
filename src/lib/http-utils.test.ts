/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it, mock } from 'node:test';
import {
  buildMultipartResponseParts,
  buildRangeHeader,
  calculateMultipartSize,
  calculateRangeResponseSize,
  generateBoundary,
  handleIfNoneMatch,
  parseContentLength,
  parseContentRange,
  parseNonNegativeInt,
  wouldReturn304,
} from './http-utils.js';

describe('http-utils', () => {
  describe('generateBoundary', () => {
    it('should generate 50 character boundaries', () => {
      const boundary = generateBoundary();
      assert.equal(boundary.length, 50);
    });

    it('should start with dashes', () => {
      const boundary = generateBoundary();
      assert.equal(boundary.startsWith('--------------------------'), true);
    });

    it('should generate unique boundaries', () => {
      const boundaries = new Set();
      for (let i = 0; i < 100; i++) {
        boundaries.add(generateBoundary());
      }
      // All 100 should be unique
      assert.equal(boundaries.size, 100);
    });

    it('should only contain valid characters', () => {
      const boundary = generateBoundary();
      // Should only contain dashes and hex digits (0-9a-f)
      assert.equal(/^[-0-9a-f]+$/.test(boundary), true);
    });
  });

  describe('buildRangeHeader', () => {
    it('should build closed range header', () => {
      assert.equal(buildRangeHeader(0, 999), 'bytes=0-999');
    });

    it('should build open-ended range header', () => {
      assert.equal(buildRangeHeader(100), 'bytes=100-');
    });

    it('should handle large offsets', () => {
      assert.equal(buildRangeHeader(1000000, 2000000), 'bytes=1000000-2000000');
    });

    it('should handle zero offset', () => {
      assert.equal(buildRangeHeader(0, 0), 'bytes=0-0');
    });

    it('should handle end equal to start', () => {
      assert.equal(buildRangeHeader(500, 500), 'bytes=500-500');
    });
  });

  describe('parseContentLength', () => {
    it('should parse valid content-length header', () => {
      assert.equal(parseContentLength({ 'content-length': '1234' }), 1234);
    });

    it('should handle uppercase Content-Length', () => {
      assert.equal(parseContentLength({ 'Content-Length': '5678' }), 5678);
    });

    it('should parse numeric content-length', () => {
      assert.equal(parseContentLength({ 'content-length': 9999 }), 9999);
    });

    it('should return undefined for missing header', () => {
      assert.equal(parseContentLength({}), undefined);
    });

    it('should return undefined for invalid values', () => {
      assert.equal(parseContentLength({ 'content-length': 'abc' }), undefined);
      assert.equal(parseContentLength({ 'content-length': '' }), undefined);
      assert.equal(parseContentLength({ 'content-length': '-1' }), undefined);
    });

    it('should return undefined for null/undefined values', () => {
      assert.equal(parseContentLength({ 'content-length': null }), undefined);
      assert.equal(
        parseContentLength({ 'content-length': undefined }),
        undefined,
      );
    });

    it('should handle zero content-length', () => {
      assert.equal(parseContentLength({ 'content-length': '0' }), 0);
    });
  });

  describe('parseContentRange', () => {
    it('should parse complete Content-Range header', () => {
      const result = parseContentRange('bytes 0-999/1000');
      assert.deepEqual(result, {
        start: 0,
        end: 999,
        total: 1000,
        size: 1000,
      });
    });

    it('should parse Content-Range with unknown total', () => {
      const result = parseContentRange('bytes 100-199/*');
      assert.deepEqual(result, {
        start: 100,
        end: 199,
        total: undefined,
        size: 100,
      });
    });

    it('should parse Content-Range without total field', () => {
      const result = parseContentRange('bytes 0-499');
      assert.deepEqual(result, {
        start: 0,
        end: 499,
        total: undefined,
        size: 500,
      });
    });

    it('should return undefined for missing header', () => {
      assert.equal(parseContentRange(undefined), undefined);
    });

    it('should return undefined for invalid formats', () => {
      assert.equal(parseContentRange('invalid'), undefined);
      assert.equal(parseContentRange('bytes abc-def'), undefined);
      assert.equal(parseContentRange(''), undefined);
    });

    it('should handle single byte range', () => {
      const result = parseContentRange('bytes 0-0/1');
      assert.deepEqual(result, {
        start: 0,
        end: 0,
        total: 1,
        size: 1,
      });
    });

    it('should handle large byte ranges', () => {
      const result = parseContentRange('bytes 1000000-2000000/5000000');
      assert.deepEqual(result, {
        start: 1000000,
        end: 2000000,
        total: 5000000,
        size: 1000001,
      });
    });
  });

  describe('buildMultipartResponseParts', () => {
    it('should build parts for single range', () => {
      const ranges = [{ start: 0, end: 99 }];
      const parts = buildMultipartResponseParts(
        ranges,
        1000,
        'text/plain',
        'boundary123',
      );

      // Should have: boundary, content-type, content-range, blank, data, blank, final boundary
      assert.equal(parts.length, 7);
      assert.equal(parts[0], '--boundary123\r\n');
      assert.equal(parts[1], 'Content-Type: text/plain\r\n');
      assert.equal(parts[2], 'Content-Range: bytes 0-99/1000\r\n');
      assert.equal(parts[3], '\r\n');
      assert.deepEqual(parts[4], {
        type: 'data',
        range: { start: 0, end: 99 },
      });
      assert.equal(parts[5], '\r\n');
      assert.equal(parts[6], '--boundary123--\r\n');
    });

    it('should build parts for multiple ranges', () => {
      const ranges = [
        { start: 0, end: 99 },
        { start: 200, end: 299 },
      ];
      const parts = buildMultipartResponseParts(
        ranges,
        1000,
        'application/json',
        'boundary456',
      );

      // Should have: (boundary, ct, cr, blank, data, blank) x 2 + final boundary
      assert.equal(parts.length, 13);

      // First range
      assert.equal(parts[0], '--boundary456\r\n');
      assert.equal(parts[1], 'Content-Type: application/json\r\n');
      assert.equal(parts[2], 'Content-Range: bytes 0-99/1000\r\n');
      assert.deepEqual(parts[4], {
        type: 'data',
        range: { start: 0, end: 99 },
      });

      // Second range
      assert.equal(parts[6], '--boundary456\r\n');
      assert.equal(parts[7], 'Content-Type: application/json\r\n');
      assert.equal(parts[8], 'Content-Range: bytes 200-299/1000\r\n');
      assert.deepEqual(parts[10], {
        type: 'data',
        range: { start: 200, end: 299 },
      });

      // Final boundary
      assert.equal(parts[12], '--boundary456--\r\n');
    });

    it('should use correct content type in headers', () => {
      const ranges = [{ start: 0, end: 99 }];
      const parts = buildMultipartResponseParts(
        ranges,
        1000,
        'image/png',
        'boundary',
      );

      assert.equal(parts[1], 'Content-Type: image/png\r\n');
    });
  });

  describe('calculateMultipartSize', () => {
    it('should calculate size for single range multipart', () => {
      const ranges = [{ start: 0, end: 99 }];
      const size = calculateMultipartSize(
        ranges,
        1000,
        'text/plain',
        'boundary123',
      );

      // Calculate expected size manually
      const boundary = 'boundary123';
      const partBoundary = `--${boundary}\r\n`;
      const finalBoundary = `--${boundary}--\r\n`;
      const contentTypeHeader = 'Content-Type: text/plain\r\n';
      const contentRangeHeader = 'Content-Range: bytes 0-99/1000\r\n';
      const blankLine = '\r\n';
      const dataSize = 100; // bytes 0-99

      const expected =
        Buffer.byteLength(partBoundary) +
        Buffer.byteLength(contentTypeHeader) +
        Buffer.byteLength(contentRangeHeader) +
        Buffer.byteLength(blankLine) +
        dataSize +
        Buffer.byteLength(blankLine) +
        Buffer.byteLength(finalBoundary);

      assert.equal(size, expected);
    });

    it('should calculate size for multiple ranges', () => {
      const ranges = [
        { start: 0, end: 99 },
        { start: 200, end: 299 },
      ];
      const size = calculateMultipartSize(
        ranges,
        1000,
        'application/octet-stream',
        'b',
      );

      // Each range adds: boundary, headers, data, blanks
      // Plus final boundary
      const boundary = 'b';
      const partBoundary = `--${boundary}\r\n`;
      const finalBoundary = `--${boundary}--\r\n`;
      const contentTypeHeader = 'Content-Type: application/octet-stream\r\n';
      const blankLine = '\r\n';

      let expected = 0;

      // First range
      expected += Buffer.byteLength(partBoundary);
      expected += Buffer.byteLength(contentTypeHeader);
      expected += Buffer.byteLength('Content-Range: bytes 0-99/1000\r\n');
      expected += Buffer.byteLength(blankLine);
      expected += 100; // data
      expected += Buffer.byteLength(blankLine);

      // Second range
      expected += Buffer.byteLength(partBoundary);
      expected += Buffer.byteLength(contentTypeHeader);
      expected += Buffer.byteLength('Content-Range: bytes 200-299/1000\r\n');
      expected += Buffer.byteLength(blankLine);
      expected += 100; // data
      expected += Buffer.byteLength(blankLine);

      // Final boundary
      expected += Buffer.byteLength(finalBoundary);

      assert.equal(size, expected);
    });

    it('should account for different content types', () => {
      const ranges = [{ start: 0, end: 99 }];

      const size1 = calculateMultipartSize(ranges, 1000, 'text/plain', 'b');
      const size2 = calculateMultipartSize(
        ranges,
        1000,
        'application/octet-stream',
        'b',
      );

      // application/octet-stream is longer than text/plain
      assert.equal(size2 > size1, true);
    });
  });

  describe('calculateRangeResponseSize', () => {
    const contentType = 'application/octet-stream';
    const boundary = 'test-boundary-123';

    it('should return full size when no range header', () => {
      assert.equal(
        calculateRangeResponseSize(1000, undefined, contentType),
        1000,
      );
    });

    it('should calculate single range size', () => {
      assert.equal(
        calculateRangeResponseSize(1000, 'bytes=0-499', contentType),
        500,
      );
      assert.equal(
        calculateRangeResponseSize(1000, 'bytes=100-199', contentType),
        100,
      );
    });

    it('should calculate size for single byte range', () => {
      assert.equal(
        calculateRangeResponseSize(1000, 'bytes=0-0', contentType),
        1,
      );
    });

    it('should include multipart overhead for multiple ranges', () => {
      const dataSize = 1000;
      const rangeHeader = 'bytes=0-99,200-299';

      const size = calculateRangeResponseSize(
        dataSize,
        rangeHeader,
        contentType,
        boundary,
      );

      // Size should be more than just the data (200 bytes)
      const dataOnlySize = 100 + 100;
      assert.equal(size > dataOnlySize, true);

      // Verify it matches manual calculation
      const ranges = [
        { start: 0, end: 99 },
        { start: 200, end: 299 },
      ];
      const expected = calculateMultipartSize(
        ranges,
        dataSize,
        contentType,
        boundary,
      );
      assert.equal(size, expected);
    });

    it('should return full size for malformed range header', () => {
      assert.equal(
        calculateRangeResponseSize(1000, 'invalid', contentType),
        1000,
      );
      assert.equal(
        calculateRangeResponseSize(1000, 'bytes=abc-def', contentType),
        1000,
      );
    });

    it('should return full size for unsatisfiable range', () => {
      // Range beyond data size
      assert.equal(
        calculateRangeResponseSize(1000, 'bytes=2000-3000', contentType),
        1000,
      );
    });

    it('should handle open-ended ranges', () => {
      // bytes=500- means "from 500 to end"
      assert.equal(
        calculateRangeResponseSize(1000, 'bytes=500-', contentType),
        500,
      );
    });

    it('should use provided boundary for deterministic calculation', () => {
      const size1 = calculateRangeResponseSize(
        1000,
        'bytes=0-99,200-299',
        contentType,
        'boundary1',
      );
      const size2 = calculateRangeResponseSize(
        1000,
        'bytes=0-99,200-299',
        contentType,
        'boundary1',
      );

      // Same boundary should give same size
      assert.equal(size1, size2);
    });

    it('should generate boundary if not provided for multipart', () => {
      const size1 = calculateRangeResponseSize(
        1000,
        'bytes=0-99,200-299',
        contentType,
      );
      const size2 = calculateRangeResponseSize(
        1000,
        'bytes=0-99,200-299',
        contentType,
      );

      // Sizes should be similar even with different random boundaries
      // (boundaries are all 50 chars so overhead should be same)
      assert.equal(size1, size2);
    });

    it('should account for content type in multipart size', () => {
      const size1 = calculateRangeResponseSize(
        1000,
        'bytes=0-99,200-299',
        'text/plain',
        boundary,
      );
      const size2 = calculateRangeResponseSize(
        1000,
        'bytes=0-99,200-299',
        'application/octet-stream',
        boundary,
      );

      // Different content types have different header sizes
      assert.equal(size1 !== size2, true);
    });

    it('should handle suffix range', () => {
      // bytes=-500 means "last 500 bytes"
      assert.equal(
        calculateRangeResponseSize(1000, 'bytes=-500', contentType),
        500,
      );
    });

    it('should handle multiple ranges with gaps', () => {
      const size = calculateRangeResponseSize(
        10000,
        'bytes=0-99,500-599,9000-9999',
        contentType,
        boundary,
      );

      // Should be: 100 + 100 + 1000 = 1200 bytes data + multipart overhead
      assert.equal(size > 1200, true);
    });
  });

  describe('wouldReturn304', () => {
    it('should return true for cached data with matching ETag', () => {
      const req: any = {
        get: mock.fn(() => '"abc123"'),
        method: 'GET',
      };
      assert.equal(wouldReturn304(req, 'abc123', true), true);
    });

    it('should return true for HEAD request with matching ETag', () => {
      const req: any = {
        get: mock.fn(() => '"abc123"'),
        method: 'HEAD',
      };
      assert.equal(wouldReturn304(req, 'abc123', false), true);
    });

    it('should return false for non-cached GET with matching ETag', () => {
      // ETag not set for non-cached GET requests
      const req: any = {
        get: mock.fn(() => '"abc123"'),
        method: 'GET',
      };
      assert.equal(wouldReturn304(req, 'abc123', false), false);
    });

    it('should return false when If-None-Match not provided', () => {
      const req: any = {
        get: mock.fn(() => undefined),
        method: 'GET',
      };
      assert.equal(wouldReturn304(req, 'abc123', true), false);
    });

    it('should return false when ETag not available', () => {
      const req: any = {
        get: mock.fn(() => '"abc123"'),
        method: 'GET',
      };
      assert.equal(wouldReturn304(req, undefined, true), false);
    });

    it('should return false when ETags do not match', () => {
      const req: any = {
        get: mock.fn(() => '"abc123"'),
        method: 'GET',
      };
      assert.equal(wouldReturn304(req, 'def456', true), false);
    });

    it('should handle ETag format correctly (with quotes)', () => {
      // If-None-Match comes with quotes, ETag value without
      const req1: any = {
        get: mock.fn(() => '"hash"'),
        method: 'GET',
      };
      assert.equal(wouldReturn304(req1, 'hash', true), true);

      // Mismatched formats should not match
      const req2: any = {
        get: mock.fn(() => 'hash'),
        method: 'GET',
      };
      assert.equal(wouldReturn304(req2, 'hash', true), false);
    });

    it('should return true for both cached and HEAD', () => {
      // Both conditions satisfied
      const req: any = {
        get: mock.fn(() => '"abc123"'),
        method: 'HEAD',
      };
      assert.equal(wouldReturn304(req, 'abc123', true), true);
    });
  });

  describe('handleIfNoneMatch', () => {
    it('should set 304 status when ETag matches', () => {
      const req: any = {
        get: mock.fn(() => '"abc123"'),
      };
      const res: any = {
        getHeader: mock.fn(() => '"abc123"'),
        status: mock.fn(() => res),
        removeHeader: mock.fn(),
      };

      const result = handleIfNoneMatch(req, res);

      assert.equal(result, true);
      assert.equal(res.status.mock.calls.length, 1);
      assert.equal(res.status.mock.calls[0].arguments[0], 304);
      assert.equal(res.removeHeader.mock.calls.length, 4);
    });

    it('should remove entity headers for 304', () => {
      const req: any = {
        get: mock.fn(() => '"test"'),
      };
      const res: any = {
        getHeader: mock.fn(() => '"test"'),
        status: mock.fn(() => res),
        removeHeader: mock.fn(),
      };

      handleIfNoneMatch(req, res);

      const removedHeaders = res.removeHeader.mock.calls.map(
        (call: any) => call.arguments[0],
      );
      assert.deepEqual(removedHeaders, [
        'Content-Length',
        'Content-Encoding',
        'Content-Range',
        'Content-Type',
      ]);
    });

    it('should return false when If-None-Match not provided', () => {
      const req: any = {
        get: mock.fn(() => undefined),
      };
      const res: any = {
        getHeader: mock.fn(() => '"abc123"'),
      };

      const result = handleIfNoneMatch(req, res);
      assert.equal(result, false);
    });

    it('should return false when ETag not set', () => {
      const req: any = {
        get: mock.fn(() => '"abc123"'),
      };
      const res: any = {
        getHeader: mock.fn(() => undefined),
      };

      const result = handleIfNoneMatch(req, res);
      assert.equal(result, false);
    });

    it('should return false when ETags do not match', () => {
      const req: any = {
        get: mock.fn(() => '"abc123"'),
      };
      const res: any = {
        getHeader: mock.fn(() => '"def456"'),
      };

      const result = handleIfNoneMatch(req, res);
      assert.equal(result, false);
    });
  });

  describe('parseNonNegativeInt', () => {
    it('should parse valid positive integers', () => {
      assert.equal(parseNonNegativeInt('123'), 123);
      assert.equal(parseNonNegativeInt('0'), 0);
      assert.equal(parseNonNegativeInt('999999'), 999999);
    });

    it('should handle whitespace', () => {
      assert.equal(parseNonNegativeInt('  123  '), 123);
      assert.equal(parseNonNegativeInt('\t456\n'), 456);
      assert.equal(parseNonNegativeInt('  0  '), 0);
    });

    it('should return undefined for invalid values', () => {
      assert.equal(parseNonNegativeInt('abc'), undefined);
      assert.equal(parseNonNegativeInt('NaN'), undefined);
      assert.equal(parseNonNegativeInt(''), undefined);
      assert.equal(parseNonNegativeInt('  '), undefined);
      assert.equal(parseNonNegativeInt('\t\n'), undefined);
    });

    it('should return undefined for negative numbers', () => {
      assert.equal(parseNonNegativeInt('-1'), undefined);
      assert.equal(parseNonNegativeInt('-999'), undefined);
      assert.equal(parseNonNegativeInt('  -10  '), undefined);
    });

    it('should return undefined for undefined/null', () => {
      assert.equal(parseNonNegativeInt(undefined), undefined);
    });

    it('should truncate decimals (parseInt behavior)', () => {
      assert.equal(parseNonNegativeInt('123.456'), 123);
      assert.equal(parseNonNegativeInt('0.999'), 0);
      assert.equal(parseNonNegativeInt('12.34abc'), 12);
    });

    it('should handle large numbers', () => {
      assert.equal(parseNonNegativeInt('2147483647'), 2147483647);
      assert.equal(parseNonNegativeInt('9999999999'), 9999999999);
    });

    it('should return undefined for infinity', () => {
      assert.equal(parseNonNegativeInt('Infinity'), undefined);
      assert.equal(parseNonNegativeInt('-Infinity'), undefined);
    });

    it('should handle leading zeros', () => {
      assert.equal(parseNonNegativeInt('00123'), 123);
      assert.equal(parseNonNegativeInt('0000'), 0);
    });
  });
});
