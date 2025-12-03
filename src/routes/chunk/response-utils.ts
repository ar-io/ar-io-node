/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Response } from 'express';
import { Span } from '@opentelemetry/api';

import { headerNames } from '../../constants.js';
import { toB64Url } from '../../lib/encoding.js';
import { Chunk } from '../../types.js';

/**
 * Result from setting common chunk headers, containing values needed
 * for conditional request handling.
 */
export interface CommonChunkHeadersResult {
  /** Cache status: 'HIT' or 'MISS' */
  cacheStatus: 'HIT' | 'MISS';
  /** Base64url-encoded hash of the chunk (if available) */
  hashString?: string;
}

/**
 * Sets common chunk response headers that are shared between JSON and binary
 * chunk endpoints:
 * - X-AR-IO-Chunk-Source-Type: Source of the chunk (cache, peer, gateway, etc.)
 * - X-AR-IO-Chunk-Host: Host that served the chunk
 * - X-Cache: HIT or MISS based on whether chunk was served from cache
 *
 * @param response - Express response object
 * @param chunk - The chunk being returned
 * @param span - Optional span for tracing attributes
 * @returns Object containing cache status and hash string for further processing
 */
export function setCommonChunkHeaders(
  response: Response,
  chunk: Chunk,
  span?: Span,
): CommonChunkHeadersResult {
  // Source tracking headers
  if (chunk.source !== undefined && chunk.source !== '') {
    response.setHeader(headerNames.chunkSourceType, chunk.source);
  }
  if (chunk.sourceHost !== undefined && chunk.sourceHost !== '') {
    response.setHeader(headerNames.chunkHost, chunk.sourceHost);
  }

  // Cache status header
  const cacheStatus: 'HIT' | 'MISS' = chunk.source === 'cache' ? 'HIT' : 'MISS';
  response.setHeader(headerNames.cache, cacheStatus);

  // Set span attributes if provided
  if (span) {
    if (chunk.source !== undefined) {
      span.setAttribute('chunk.source', chunk.source);
    }
    if (chunk.sourceHost !== undefined) {
      span.setAttribute('chunk.source_host', chunk.sourceHost);
    }
    span.setAttribute('chunk.cache_status', cacheStatus);
  }

  // Prepare hash string if available
  let hashString: string | undefined;
  if (chunk.hash !== undefined) {
    hashString = toB64Url(chunk.hash);
    if (span) {
      span.setAttribute('chunk.hash', hashString);
    }
  }

  return {
    cacheStatus,
    hashString,
  };
}

/**
 * Sets ETag header for chunk response.
 * Should only be called when it's safe to set ETag (cache hits or HEAD requests).
 *
 * @param response - Express response object
 * @param hashString - Base64url-encoded hash string
 */
export function setChunkETag(response: Response, hashString: string): void {
  response.setHeader('ETag', `"${hashString}"`);
}
