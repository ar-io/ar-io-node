/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { ChunkHeaderMetadata } from '../types.js';

type RawHeaders = Record<string, string | string[] | undefined>;

function firstValue(headers: RawHeaders, name: string): string | undefined {
  const v = headers[name];
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

function parseBigIntHeader(raw: string | undefined): bigint | undefined {
  if (raw === undefined || raw === '') return undefined;
  try {
    const v = BigInt(raw);
    if (v < 0n) return undefined;
    return v;
  } catch {
    return undefined;
  }
}

/**
 * Parse a peer's `/chunk/{offset}/data` HEAD response headers into a
 * structured {@link ChunkHeaderMetadata} or `null` if any required
 * header is missing or malformed. The result is **untrusted** —
 * callers MUST cross-check the values against the chain before they
 * feed merkle proof validation. See `chunk-metadata-anchor.ts`.
 *
 * Numeric headers are parsed as `bigint` so weave-scale offsets
 * (well past `Number.MAX_SAFE_INTEGER`) round-trip without precision
 * loss. Conversion to `number` happens after the chain cross-check
 * and is bounded there via `safeBigIntToNumber`.
 */
export function parseChunkHeaderMetadata(
  headers: RawHeaders,
): ChunkHeaderMetadata | null {
  const txId = firstValue(headers, 'x-arweave-chunk-tx-id');
  const dataRoot = firstValue(headers, 'x-arweave-chunk-data-root');
  const dataPath = firstValue(headers, 'x-arweave-chunk-data-path');
  const txPath = firstValue(headers, 'x-arweave-chunk-tx-path');
  const txStartOffset = parseBigIntHeader(
    firstValue(headers, 'x-arweave-chunk-tx-start-offset'),
  );
  const txDataSize = parseBigIntHeader(
    firstValue(headers, 'x-arweave-chunk-tx-data-size'),
  );
  const chunkStartOffset = parseBigIntHeader(
    firstValue(headers, 'x-arweave-chunk-start-offset'),
  );
  const chunkRelativeStartOffset = parseBigIntHeader(
    firstValue(headers, 'x-arweave-chunk-relative-start-offset'),
  );

  if (
    txId === undefined ||
    txId === '' ||
    dataRoot === undefined ||
    dataRoot === '' ||
    dataPath === undefined ||
    dataPath === '' ||
    txPath === undefined ||
    txPath === '' ||
    txStartOffset === undefined ||
    txDataSize === undefined ||
    chunkStartOffset === undefined ||
    chunkRelativeStartOffset === undefined
  ) {
    return null;
  }

  return {
    txId,
    dataRoot,
    dataPath,
    txPath,
    txStartOffset,
    txDataSize,
    chunkStartOffset,
    chunkRelativeStartOffset,
  };
}
