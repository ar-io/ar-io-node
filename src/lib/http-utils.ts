/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { randomBytes } from 'node:crypto';
import rangeParser from 'range-parser';
import { Request, Response } from 'express';

/**
 * Generate a random multipart boundary string.
 * Uses same algorithm as Firefox - 50 character boundary optimized for boyer-moore parsing.
 * RFC 2046 recommends unique and unpredictable boundaries to prevent injection attacks.
 *
 * @see https://github.com/rexxars/byte-range-stream/blob/98a8e06e46193afc45219b63bc2dc5d9c7f77459/src/index.js#L115-L124
 * @returns 50 character boundary string starting with dashes
 */
export function generateBoundary(): string {
  // 26 dashes + 24 hex chars = 50 chars total
  return '--------------------------' + randomBytes(12).toString('hex');
}

/**
 * Build a Range header value for HTTP requests.
 *
 * @param start - Starting byte offset (inclusive)
 * @param end - Ending byte offset (inclusive), or undefined for open-ended range
 * @returns Range header value in format "bytes=start-end" or "bytes=start-"
 *
 * @example
 * buildRangeHeader(0, 999) // "bytes=0-999"
 * buildRangeHeader(100) // "bytes=100-"
 */
export function buildRangeHeader(start: number, end?: number): string {
  if (end !== undefined) {
    return `bytes=${start}-${end}`;
  }
  return `bytes=${start}-`;
}

/**
 * Parse Content-Length header from HTTP headers object.
 *
 * @param headers - HTTP headers object (case-insensitive)
 * @returns Parsed content length as number, or undefined if invalid/missing
 *
 * @example
 * parseContentLength({'content-length': '1234'}) // 1234
 * parseContentLength({'Content-Length': 'abc'}) // undefined
 */
export function parseContentLength(
  headers: Record<string, any>,
): number | undefined {
  const contentLength = headers['content-length'] ?? headers['Content-Length'];

  if (contentLength === undefined || contentLength === null) {
    return undefined;
  }

  const parsed = parseInt(String(contentLength), 10);
  if (isNaN(parsed) || parsed < 0) {
    return undefined;
  }

  return parsed;
}

/**
 * Parse Content-Range response header.
 * Expected format: "bytes start-end/total" or "bytes start-end/*"
 *
 * @param contentRange - Content-Range header value
 * @returns Parsed range info, or undefined if invalid/missing
 *
 * @example
 * parseContentRange('bytes 0-999/1000') // {start: 0, end: 999, total: 1000, size: 1000}
 * parseContentRange('bytes 100-199/*') // {start: 100, end: 199, total: undefined, size: 100}
 * parseContentRange('invalid') // undefined
 */
export function parseContentRange(
  contentRange: string | undefined,
):
  | { start: number; end: number; total: number | undefined; size: number }
  | undefined {
  if (contentRange === undefined || contentRange === '') {
    return undefined;
  }

  const match = contentRange.match(/^bytes\s+(\d+)-(\d+)(?:\/(\d+|\*))?$/);
  if (!match) {
    return undefined;
  }

  const start = parseInt(match[1], 10);
  const end = parseInt(match[2], 10);
  const totalStr = match[3];

  if (isNaN(start) || isNaN(end) || end < start) {
    return undefined;
  }

  const total =
    totalStr !== undefined && totalStr !== '*'
      ? parseInt(totalStr, 10)
      : undefined;

  if (total !== undefined && (isNaN(total) || total <= end)) {
    return undefined;
  }

  return {
    start,
    end,
    total,
    size: end - start + 1,
  };
}

/**
 * Safely parse a string value to a non-negative integer.
 * Trims whitespace, validates the result is finite and non-negative.
 *
 * @param value - String value to parse (can be undefined)
 * @returns Parsed non-negative integer, or undefined if invalid/missing
 *
 * @example
 * parseNonNegativeInt('123') // 123
 * parseNonNegativeInt('  456  ') // 456
 * parseNonNegativeInt('abc') // undefined
 * parseNonNegativeInt('') // undefined
 * parseNonNegativeInt('-1') // undefined
 * parseNonNegativeInt(undefined) // undefined
 */
export function parseNonNegativeInt(
  value: string | undefined,
): number | undefined {
  if (value === undefined || value === '') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const parsed = parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Response part for multipart byterange responses.
 * Either a string (boundary/header) or a data placeholder with range info.
 */
export type ResponsePart = string | { type: 'data'; range: rangeParser.Range };

/**
 * Build multipart response parts array for streaming.
 * Generates all boundary strings and headers needed for multipart/byteranges response.
 *
 * @param ranges - Array of byte ranges to include
 * @param dataSize - Total size of the data being ranged
 * @param contentType - MIME type of the content
 * @param boundary - Multipart boundary string
 * @returns Array of response parts (strings and data placeholders)
 */
export function buildMultipartResponseParts(
  ranges: rangeParser.Range[],
  dataSize: number,
  contentType: string,
  boundary: string,
): ResponsePart[] {
  const partBoundary = `--${boundary}\r\n`;
  const finalBoundary = `--${boundary}--\r\n`;
  const contentTypeHeader = `Content-Type: ${contentType}\r\n`;
  const blankLine = '\r\n';

  const responseParts: ResponsePart[] = [];

  for (const range of ranges) {
    responseParts.push(partBoundary);
    responseParts.push(contentTypeHeader);
    responseParts.push(
      `Content-Range: bytes ${range.start}-${range.end}/${dataSize}\r\n`,
    );
    responseParts.push(blankLine);
    responseParts.push({ type: 'data', range });
    responseParts.push(blankLine);
  }

  responseParts.push(finalBoundary);

  return responseParts;
}

/**
 * Calculate the exact total size of a multipart response including all overhead.
 * Accounts for boundaries, headers, and data portions.
 *
 * @param ranges - Array of byte ranges
 * @param dataSize - Total size of the data
 * @param contentType - MIME type (affects header size)
 * @param boundary - Multipart boundary string
 * @returns Total response size in bytes
 */
export function calculateMultipartSize(
  ranges: rangeParser.Range[],
  dataSize: number,
  contentType: string,
  boundary: string,
): number {
  const parts = buildMultipartResponseParts(
    ranges,
    dataSize,
    contentType,
    boundary,
  );

  let totalLength = 0;
  for (const part of parts) {
    if (typeof part === 'string') {
      totalLength += Buffer.byteLength(part);
    } else if (part.type === 'data') {
      totalLength += part.range.end - part.range.start + 1;
    }
  }

  return totalLength;
}

/**
 * Calculate the exact response size for a range request.
 * Handles single ranges, multiple ranges (with multipart overhead), and full content.
 *
 * For billing/rate limiting purposes:
 * - Malformed or unsatisfiable ranges: charge for full content
 * - Single range: charge for requested byte range only
 * - Multiple ranges: charge for data + multipart overhead (boundaries, headers)
 *
 * @param dataSize - Total size of the data
 * @param rangeHeader - Range header value from request (undefined for full content)
 * @param contentType - Actual content type that will be used in response
 * @param boundary - Multipart boundary to use (generated if not provided)
 * @returns Exact response size in bytes
 *
 * @example
 * // Full content
 * calculateRangeResponseSize(1000, undefined, 'text/plain') // 1000
 *
 * // Single range
 * calculateRangeResponseSize(1000, 'bytes=0-499', 'text/plain') // 500
 *
 * // Multiple ranges (includes multipart overhead)
 * calculateRangeResponseSize(1000, 'bytes=0-99,200-299', 'text/plain', boundary) // ~300 + overhead
 */
export function calculateRangeResponseSize(
  dataSize: number,
  rangeHeader: string | undefined,
  contentType: string,
  boundary?: string,
): number {
  // No range header - full content
  if (rangeHeader === undefined) {
    return dataSize;
  }

  const ranges = rangeParser(dataSize, rangeHeader);

  // Malformed or unsatisfiable range - charge for full content
  if (ranges === -1 || ranges === -2 || ranges.type !== 'bytes') {
    return dataSize;
  }

  // Single range: just the range size
  if (ranges.length === 1) {
    return ranges[0].end - ranges[0].start + 1;
  }

  // Multiple ranges: calculate total including boundaries and headers
  const actualBoundary = boundary ?? generateBoundary();
  return calculateMultipartSize(ranges, dataSize, contentType, actualBoundary);
}

/**
 * Check if a request would result in a 304 Not Modified response.
 * Used for rate limiting/payment pre-checks to avoid charging for 304 responses.
 *
 * ETags are only set when:
 * - Data is cached locally (verified hash), OR
 * - Request is a HEAD request (hash from DB is authoritative)
 *
 * @param req - Express request object
 * @param etag - ETag that will be set in response (hash from data attributes)
 * @param cached - Whether data is cached locally
 * @returns true if 304 would be returned, false otherwise
 *
 * @example
 * wouldReturn304(req, 'abc123', true) // true if req has matching If-None-Match and data is cached
 * wouldReturn304(headReq, 'abc123', false) // true if HEAD request with matching If-None-Match
 * wouldReturn304(getReq, 'abc123', false) // false - not cached and not HEAD
 * wouldReturn304(req, undefined, true) // false - no ETag available
 */
export function wouldReturn304(
  req: Request,
  etag: string | undefined,
  cached: boolean,
): boolean {
  const ifNoneMatch = req.get('if-none-match');
  const isHeadRequest = req.method === 'HEAD';

  // ETag only set when data is cached OR it's a HEAD request
  if (etag === undefined || (!cached && !isHeadRequest)) {
    return false;
  }

  // Check if If-None-Match matches the ETag (with quotes)
  if (ifNoneMatch !== undefined && ifNoneMatch === `"${etag}"`) {
    return true;
  }

  return false;
}

/**
 * Handle If-None-Match conditional request.
 * Sets 304 status and removes entity headers per RFC 7232 Section 4.1.
 *
 * @param req - Express request
 * @param res - Express response
 * @returns true if 304 was set, false otherwise
 *
 * @example
 * // In handler after setting ETag header
 * res.setHeader('ETag', '"abc123"');
 * if (handleIfNoneMatch(req, res)) {
 *   res.end();
 *   return;
 * }
 */
export function handleIfNoneMatch(req: Request, res: Response): boolean {
  const ifNoneMatch = req.get('if-none-match');
  const etag = res.getHeader('etag');

  if (ifNoneMatch !== undefined && etag !== undefined && ifNoneMatch === etag) {
    res.status(304);
    // Remove entity headers per RFC 7232 Section 4.1
    res.removeHeader('Content-Length');
    res.removeHeader('Content-Encoding');
    res.removeHeader('Content-Range');
    res.removeHeader('Content-Type');
    return true;
  }
  return false;
}
