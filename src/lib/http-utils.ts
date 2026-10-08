/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
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
 * Normalizes an upstream `Content-Encoding` response header for use as the
 * encoding of the bytes received.
 *
 * Returns `undefined` for a missing or empty header and for `identity`, which
 * means the bytes are not encoded. Otherwise returns the lowercased, trimmed
 * value (a list such as `gzip, br` is kept as sent: it describes the bytes as
 * a whole).
 *
 * @example
 * parseContentEncoding('gzip') // 'gzip'
 * parseContentEncoding(' GZIP ') // 'gzip'
 * parseContentEncoding('identity') // undefined
 * parseContentEncoding(undefined) // undefined
 */
export function parseContentEncoding(
  contentEncoding: string | string[] | undefined,
): string | undefined {
  const value = Array.isArray(contentEncoding)
    ? contentEncoding.join(', ')
    : contentEncoding;
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === undefined ||
    normalized === '' ||
    normalized === 'identity'
  ) {
    return undefined;
  }
  return normalized;
}

/**
 * Content codings the gateway will name in a `Content-Encoding` response
 * header. Browsers decode all of these; anything else, including a list of
 * stacked codings such as `gzip, br`, is served without the header, as
 * before, rather than with one a client may not decode.
 */
export const HONOURED_CONTENT_ENCODINGS: ReadonlySet<string> = new Set([
  'gzip',
  'br',
  'deflate',
  'zstd',
]);

/**
 * The `Content-Encoding` to send for an item, or `undefined` for none: the
 * normalized value if it is a single honoured coding (see
 * {@link HONOURED_CONTENT_ENCODINGS}), else `undefined`.
 *
 * @example
 * honouredContentEncoding('GZIP') // 'gzip'
 * honouredContentEncoding('gzip, br') // undefined
 * honouredContentEncoding('x-custom') // undefined
 */
export function honouredContentEncoding(
  contentEncoding: string | undefined,
): string | undefined {
  const normalized = parseContentEncoding(contentEncoding);
  return normalized !== undefined && HONOURED_CONTENT_ENCODINGS.has(normalized)
    ? normalized
    : undefined;
}

/**
 * The coding an upstream's `X-Arweave-Tag-Content-Encoding` header names when
 * the response itself carries no `Content-Encoding`, or `undefined` when the
 * two agree.
 *
 * A gateway that serves an item stored encoded sends `Content-Encoding` for
 * every honoured coding its tag names (see {@link honouredContentEncoding}).
 * A tag naming one with no header means the bytes were decoded somewhere
 * upstream. Gateways older than ar-io-node #964 did this: they decoded the
 * gzip body and cut it at the encoded length, so the bytes are both decoded
 * and truncated, and must not be served or cached.
 *
 * Only the first `Content-Encoding` tag counts, as when indexing (#966).
 *
 * @example
 * undeclaredTaggedEncoding({ contentEncoding: undefined, tags: [{ name: 'Content-Encoding', value: 'gzip' }] }) // 'gzip'
 * undeclaredTaggedEncoding({ contentEncoding: 'gzip', tags: [{ name: 'Content-Encoding', value: 'gzip' }] }) // undefined
 * undeclaredTaggedEncoding({ contentEncoding: undefined, tags: [{ name: 'Content-Encoding', value: 'x-custom' }] }) // undefined
 */
export function undeclaredTaggedEncoding({
  contentEncoding,
  tags,
}: {
  contentEncoding: string | string[] | undefined;
  tags: { name: string; value: string }[] | undefined;
}): string | undefined {
  if (parseContentEncoding(contentEncoding) !== undefined) {
    return undefined;
  }
  const tag = tags?.find(
    (candidate) => candidate.name.toLowerCase() === 'content-encoding',
  );
  return honouredContentEncoding(tag?.value);
}

/**
 * Leading bytes every body in a content coding starts with, for the codings
 * that have them (`br` and raw `deflate` do not).
 */
const CONTENT_ENCODING_MAGIC: ReadonlyMap<string, Buffer> = new Map([
  ['gzip', Buffer.from([0x1f, 0x8b])],
  ['zstd', Buffer.from([0x28, 0xb5, 0x2f, 0xfd])],
]);

/**
 * Whether a response declaring `contentEncoding` can be checked against its
 * first bytes with {@link contradictsContentEncoding}.
 */
export function hasContentEncodingMagic(
  contentEncoding: string | string[] | undefined,
): boolean {
  const normalized = parseContentEncoding(contentEncoding);
  return normalized !== undefined && CONTENT_ENCODING_MAGIC.has(normalized);
}

/**
 * True when a body's first bytes rule out the coding its `Content-Encoding`
 * declares: a `gzip` body that does not start `1f 8b`, or a `zstd` body that
 * does not start `28 b5 2f fd`.
 *
 * Gateways older than ar-io-node #964 can serve a gzip-tagged item already
 * decompressed while still declaring `Content-Encoding: gzip`, so clients
 * fail to decode it. A coding with no fixed magic, or an empty `head`, is
 * never contradicted; a `head` shorter than the magic is compared as far as
 * it goes.
 *
 * @example
 * contradictsContentEncoding(Buffer.from('{"a"'), 'gzip') // true
 * contradictsContentEncoding(Buffer.from([0x1f, 0x8b, 8]), 'gzip') // false
 * contradictsContentEncoding(Buffer.from('{"a"'), 'br') // false
 */
export function contradictsContentEncoding(
  head: Buffer,
  contentEncoding: string | string[] | undefined,
): boolean {
  const normalized = parseContentEncoding(contentEncoding);
  const magic =
    normalized !== undefined
      ? CONTENT_ENCODING_MAGIC.get(normalized)
      : undefined;
  if (magic === undefined || head.length === 0) {
    return false;
  }
  const length = Math.min(head.length, magic.length);
  return !head.subarray(0, length).equals(magic.subarray(0, length));
}

/**
 * `{ sourceContentEncoding }` for an upstream `Content-Encoding` header that
 * names an encoding, or `{}` when the bytes are not encoded; for spreading into
 * a `ContiguousData` result.
 */
export function contentEncodingOf(
  contentEncoding: string | string[] | undefined,
): { sourceContentEncoding?: string } {
  const sourceContentEncoding = parseContentEncoding(contentEncoding);
  return sourceContentEncoding !== undefined ? { sourceContentEncoding } : {};
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

/**
 * Normalizes Axios CanceledError to a standard AbortError. Axios wraps all
 * AbortSignal-induced cancellations as CanceledError (code ERR_CANCELED),
 * but the rest of the codebase checks error.name === 'AbortError'.
 */
export function normalizeAbortError(error: any): any {
  if (error?.code === 'ERR_CANCELED') {
    const abortError = new Error(error.message);
    abortError.name = 'AbortError';
    abortError.stack = error.stack;
    return abortError;
  }
  return error;
}

/** Largest response body {@link discardResponseBody} reads to the end. */
export const DISCARDED_BODY_MAX_BYTES = 64 * 1024;

/**
 * Discards a response body that was requested as a stream only for its
 * headers, such as the `Range: bytes=0-0` GET used when a peer rejects HEAD.
 *
 * A body of up to `maxBytes` is read to the end, so a keep-alive socket goes
 * back to its pool exactly as it would after a buffered read. A larger body (a
 * peer that ignored the range and is sending the whole item), a body still
 * arriving after `timeoutMs`, or a stream that fails is destroyed instead,
 * which closes the connection rather than downloading the rest.
 *
 * Never rejects. Values that aren't readable streams are ignored.
 */
export async function discardResponseBody(
  body: unknown,
  {
    maxBytes = DISCARDED_BODY_MAX_BYTES,
    timeoutMs,
  }: { maxBytes?: number; timeoutMs: number },
): Promise<void> {
  if (!(body instanceof Readable)) {
    return;
  }
  const stream: Readable = body;

  // A stream failing after we stop listening must not raise an unhandled
  // 'error' event. This goes before the checks below: `destroy(error)` marks
  // the stream destroyed at once but emits 'error' on a later tick, so a
  // stream can already be destroyed with its error still pending.
  stream.on('error', () => {});
  if (stream.destroyed || stream.readableEnded) {
    return;
  }

  await new Promise<void>((resolve) => {
    let received = 0;
    // Created before any listener, so every callback below can clear it.
    const timer = setTimeout(() => finish(true), timeoutMs);

    function finish(destroy: boolean): void {
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('end', onDone);
      stream.off('close', onDone);
      stream.off('error', onError);
      if (destroy && !stream.destroyed) {
        stream.destroy();
      }
      resolve();
    }
    function onData(chunk: Buffer): void {
      received += chunk.length;
      if (received > maxBytes) {
        finish(true);
      }
    }
    function onDone(): void {
      finish(false);
    }
    function onError(): void {
      finish(true);
    }

    stream.on('data', onData);
    stream.once('end', onDone);
    stream.once('close', onDone);
    stream.once('error', onError);
  });
}
