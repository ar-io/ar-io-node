/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Minimal ETF (Erlang Term Format) parser specifically for Arweave sync buckets.
 *
 * Arweave sync buckets are serialized as a 2-tuple: {BucketSize, Map}
 * where BucketSize is an integer and Map contains bucket indices as keys.
 *
 * We only need to extract the bucket indices (map keys), not the share values.
 */

export interface SyncBucketsData {
  bucketSize: number;
  buckets: Set<number>;
}

// ETF format constants
const ETF_VERSION = 131;
const SMALL_TUPLE_EXT = 104;
const INTEGER_EXT = 98; // 4-byte signed integer
const SMALL_BIG_EXT = 110; // small big integer (variable length)
const MAP_EXT = 116;
const SMALL_INTEGER_EXT = 97; // 1-byte unsigned integer
const NEW_FLOAT_EXT = 70; // 8-byte IEEE 754 float

export class ETFParseError extends Error {
  constructor(
    message: string,
    public readonly offset?: number,
  ) {
    super(message);
    this.name = 'ETFParseError';
  }
}

/**
 * Parse ETF sync buckets data from Arweave.
 * Only extracts bucket indices, ignoring share values for performance.
 */
export function parseETFSyncBuckets(data: ArrayBuffer): SyncBucketsData {
  const buffer = new Uint8Array(data);
  let offset = 0;

  // Check ETF version
  if (buffer.length === 0 || buffer[offset] !== ETF_VERSION) {
    throw new ETFParseError(
      `Invalid ETF version: expected ${ETF_VERSION}, got ${buffer[offset] || 'undefined'}`,
      offset,
    );
  }
  offset++;

  // Parse tuple header
  if (buffer[offset] !== SMALL_TUPLE_EXT) {
    throw new ETFParseError(
      `Expected small tuple, got tag ${buffer[offset]}`,
      offset,
    );
  }
  offset++;

  const arity = buffer[offset];
  if (arity !== 2) {
    throw new ETFParseError(`Expected tuple arity 2, got ${arity}`, offset);
  }
  offset++;

  // Parse bucket size (first tuple element)
  const bucketSize = parseInteger(buffer, offset);
  offset = bucketSize.offset;

  // Parse map (second tuple element)
  if (buffer[offset] !== MAP_EXT) {
    throw new ETFParseError(`Expected map, got tag ${buffer[offset]}`, offset);
  }
  offset++;

  // Read map size (4 bytes, big-endian)
  if (offset + 4 > buffer.length) {
    throw new ETFParseError(
      'Unexpected end of data while reading map size',
      offset,
    );
  }
  const mapSize = readUint32BE(buffer, offset);
  offset += 4;

  // Extract bucket indices (map keys)
  const buckets = new Set<number>();

  for (let i = 0; i < mapSize; i++) {
    // Parse key (bucket index)
    const key = parseInteger(buffer, offset);
    buckets.add(key.value);
    offset = key.offset;

    // Skip value (share percentage) - we don't need it
    offset = skipValue(buffer, offset);
  }

  return {
    bucketSize: bucketSize.value,
    buckets,
  };
}

/**
 * Parse an integer from ETF data
 */
function parseInteger(
  buffer: Uint8Array,
  offset: number,
): { value: number; offset: number } {
  if (offset >= buffer.length) {
    throw new ETFParseError(
      'Unexpected end of data while parsing integer',
      offset,
    );
  }

  const tag = buffer[offset];
  offset++;

  switch (tag) {
    case SMALL_INTEGER_EXT:
      if (offset >= buffer.length) {
        throw new ETFParseError(
          'Unexpected end of data while reading small integer',
          offset,
        );
      }
      return { value: buffer[offset], offset: offset + 1 };

    case INTEGER_EXT: {
      if (offset + 4 > buffer.length) {
        throw new ETFParseError(
          'Unexpected end of data while reading integer',
          offset,
        );
      }
      const intValue = readInt32BE(buffer, offset);
      return { value: intValue, offset: offset + 4 };
    }

    case SMALL_BIG_EXT: {
      // Small big integer format: length(1), sign(1), data(length bytes, little-endian)
      if (offset + 2 > buffer.length) {
        throw new ETFParseError(
          'Unexpected end of data while reading small big integer header',
          offset,
        );
      }

      const length = buffer[offset];
      const sign = buffer[offset + 1];
      offset += 2;

      if (offset + length > buffer.length) {
        throw new ETFParseError(
          'Unexpected end of data while reading small big integer data',
          offset,
        );
      }

      // Read little-endian integer
      let bigValue = 0;
      for (let i = 0; i < length; i++) {
        bigValue += buffer[offset + i] * Math.pow(256, i);
      }

      if (sign !== 0) {
        bigValue = -bigValue;
      }

      return { value: bigValue, offset: offset + length };
    }

    default:
      throw new ETFParseError(`Unsupported integer type: ${tag}`, offset - 1);
  }
}

/**
 * Skip a value without parsing it (for performance)
 */
function skipValue(buffer: Uint8Array, offset: number): number {
  if (offset >= buffer.length) {
    throw new ETFParseError(
      'Unexpected end of data while skipping value',
      offset,
    );
  }

  const tag = buffer[offset];
  offset++;

  switch (tag) {
    case SMALL_INTEGER_EXT:
      return offset + 1;

    case INTEGER_EXT:
      return offset + 4;

    case SMALL_BIG_EXT: {
      // Small big integer: length(1), sign(1), data(length bytes)
      if (offset + 2 > buffer.length) {
        throw new ETFParseError(
          'Unexpected end of data while skipping small big integer',
          offset,
        );
      }
      const length = buffer[offset];
      const dataOffset = offset + 2;
      if (dataOffset + length > buffer.length) {
        throw new ETFParseError(
          'Unexpected end of data while skipping small big integer data',
          dataOffset,
        );
      }
      return dataOffset + length; // length + sign + data
    }

    case NEW_FLOAT_EXT:
      return offset + 8;

    default:
      throw new ETFParseError(
        `Cannot skip unsupported value type: ${tag}`,
        offset - 1,
      );
  }
}

/**
 * Read a 32-bit big-endian unsigned integer
 */
function readUint32BE(buffer: Uint8Array, offset: number): number {
  return (
    (buffer[offset] << 24) |
    (buffer[offset + 1] << 16) |
    (buffer[offset + 2] << 8) |
    buffer[offset + 3]
  );
}

/**
 * Read a 32-bit big-endian signed integer
 */
function readInt32BE(buffer: Uint8Array, offset: number): number {
  const value = readUint32BE(buffer, offset);
  // Convert unsigned to signed
  return value > 0x7fffffff ? value - 0x100000000 : value;
}
