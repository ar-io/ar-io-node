/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * CDB64 Value Encoding - MessagePack serialization for root TX index values.
 *
 * See docs/cdb64-format.md for the complete format specification.
 *
 * ## Value Formats
 *
 * Values are MessagePack-encoded objects with short single-character keys
 * for compactness. Four formats are supported:
 *
 * ### Simple Format (Legacy)
 * Used when only the root transaction ID is known:
 * ```
 * { r: <Buffer 32 bytes> }
 * ```
 *
 * ### Complete Format (Legacy)
 * Used when offset information is available:
 * ```
 * { r: <Buffer 32 bytes>, i: <integer>, d: <integer>, s?: <integer> }
 * ```
 *
 * ### Path Format
 * Used when the bundle traversal path is known but offsets are not:
 * ```
 * { p: [<Buffer 32 bytes>, ...] }
 * ```
 *
 * ### Path Complete Format
 * Used when both path and offset information are available:
 * ```
 * { p: [<Buffer 32 bytes>, ...], i: <integer>, d: <integer>, s?: <integer> }
 * ```
 *
 * ## Key Mapping
 *
 * | Key | Full Name            | Description                              |
 * |-----|----------------------|------------------------------------------|
 * | r   | rootTxId             | 32-byte root transaction ID (binary)     |
 * | p   | path                 | Array of 32-byte TX IDs [root, ..., parent] |
 * | i   | rootDataItemOffset   | Byte offset of data item header          |
 * | d   | rootDataOffset       | Byte offset of data payload              |
 * | s   | dataItemSize         | Total data item size (header + payload), optional |
 *
 * The offsets correspond to HTTP headers:
 * - `i` → `X-AR-IO-Root-Data-Item-Offset`
 * - `d` → `X-AR-IO-Root-Data-Offset`
 * - `s` → `X-AR-IO-Data-Item-Size`
 *
 * `s` is only meaningful alongside `i` and `d`. It is optional so that values
 * written before it existed still decode, and readers that predate it ignore
 * the extra key, so indexes that carry it remain readable by older gateways.
 * Without it a reader knows where the item starts but not where it ends, and
 * must search the bundle header for the item's size.
 *
 * ## Path Structure
 *
 * The path array contains TX IDs from root to immediate parent:
 * - `path[0]` is always the L1 root transaction ID
 * - `path[path.length - 1]` is the immediate parent bundle
 * - The data item ID itself is NOT included in the path
 *
 * When path is present, rootTxId is derived from `path[0]`, eliminating
 * redundancy (no separate `r` field needed).
 */

import { toMsgpack, fromMsgpack } from './encoding.js';
import { MAX_BUNDLE_NESTING_DEPTH } from '../arweave/constants.js';

/**
 * Simple value format containing only the root transaction ID.
 * Used when offset information is not available (e.g., legacy exports).
 */
export interface Cdb64RootTxValueSimple {
  /** 32-byte root transaction ID */
  rootTxId: Buffer;
}

/**
 * Complete value format with root TX ID and offset information.
 * Used when full offset data is available (e.g., Turbo exports).
 *
 * The offsets match the HTTP headers returned by the gateway:
 * - rootDataItemOffset → X-AR-IO-Root-Data-Item-Offset
 * - rootDataOffset → X-AR-IO-Root-Data-Offset
 * - dataItemSize → X-AR-IO-Data-Item-Size
 */
export interface Cdb64RootTxValueComplete {
  /** 32-byte root transaction ID */
  rootTxId: Buffer;
  /** Byte offset of data item header within root TX data */
  rootDataItemOffset: number;
  /** Byte offset of data payload within root TX data */
  rootDataOffset: number;
  /**
   * Total data item size in bytes (header + payload), when known. Lets a
   * reader locate the item without searching the bundle header for its size.
   */
  dataItemSize?: number;
}

/**
 * Path format containing the traversal path from root to parent bundle.
 * Used when the bundle hierarchy is known but offset information is not.
 *
 * Path structure: [rootTxId, nestedBundle1, nestedBundle2, ..., parentBundle]
 * - First element (path[0]) is always the L1 root transaction ID
 * - Last element is the immediate parent bundle containing the data item
 * - The data item ID itself is NOT included in the path
 */
export interface Cdb64RootTxValuePath {
  /** Array of 32-byte bundle IDs from root to immediate parent */
  path: Buffer[];
}

/**
 * Path complete format with both traversal path and offset information.
 * Used when full path and offset data are available.
 *
 * Combines the navigation benefits of the path with direct offset access.
 */
export interface Cdb64RootTxValuePathComplete {
  /** Array of 32-byte bundle IDs from root to immediate parent */
  path: Buffer[];
  /** Byte offset of data item header within root TX data */
  rootDataItemOffset: number;
  /** Byte offset of data payload within root TX data */
  rootDataOffset: number;
  /**
   * Total data item size in bytes (header + payload), when known. Lets a
   * reader locate the item without searching the bundle header for its size.
   */
  dataItemSize?: number;
}

/**
 * Union type for CDB64 root TX values.
 * Supports both legacy formats (simple/complete) and new path-based formats.
 */
export type Cdb64RootTxValue =
  | Cdb64RootTxValueSimple
  | Cdb64RootTxValueComplete
  | Cdb64RootTxValuePath
  | Cdb64RootTxValuePathComplete;

/**
 * Type guard to check if a value has complete offset information (legacy format).
 * Note: This checks for legacy complete format with rootTxId, not path-based.
 */
export function isCompleteValue(
  value: Cdb64RootTxValue,
): value is Cdb64RootTxValueComplete {
  return (
    'rootTxId' in value &&
    'rootDataItemOffset' in value &&
    'rootDataOffset' in value &&
    typeof value.rootDataItemOffset === 'number' &&
    typeof value.rootDataOffset === 'number'
  );
}

/**
 * Type guard to check if a value uses the path-based format.
 */
export function isPathValue(
  value: Cdb64RootTxValue,
): value is Cdb64RootTxValuePath | Cdb64RootTxValuePathComplete {
  return 'path' in value && Array.isArray(value.path);
}

/**
 * Type guard to check if a value has both path and offset information.
 */
export function isPathCompleteValue(
  value: Cdb64RootTxValue,
): value is Cdb64RootTxValuePathComplete {
  return (
    isPathValue(value) &&
    'rootDataItemOffset' in value &&
    'rootDataOffset' in value &&
    typeof value.rootDataItemOffset === 'number' &&
    typeof value.rootDataOffset === 'number'
  );
}

/**
 * Checks that an item size is consistent with its offsets: a non-negative
 * integer no smaller than the header, which spans from the item offset to the
 * payload offset. The item's end offset must also be a safe integer, so a huge
 * size can't frame a payload range beyond what the gateway can address.
 */
function isValidDataItemSize(
  dataItemSize: unknown,
  rootDataItemOffset: number,
  rootDataOffset: number,
): dataItemSize is number {
  return (
    typeof dataItemSize === 'number' &&
    Number.isSafeInteger(dataItemSize) &&
    Number.isSafeInteger(rootDataItemOffset + dataItemSize) &&
    rootDataOffset >= rootDataItemOffset &&
    dataItemSize >= rootDataOffset - rootDataItemOffset
  );
}

/**
 * Validates that offsets are non-negative integers and, when an item size is
 * given, that it is consistent with them.
 */
function validateOffsets(
  rootDataItemOffset: number,
  rootDataOffset: number,
  dataItemSize?: number,
): void {
  if (!Number.isInteger(rootDataItemOffset) || rootDataItemOffset < 0) {
    throw new Error('rootDataItemOffset must be a non-negative integer');
  }
  if (!Number.isInteger(rootDataOffset) || rootDataOffset < 0) {
    throw new Error('rootDataOffset must be a non-negative integer');
  }
  if (
    dataItemSize !== undefined &&
    !isValidDataItemSize(dataItemSize, rootDataItemOffset, rootDataOffset)
  ) {
    throw new Error(
      'dataItemSize must be a safe integer no smaller than the header size (rootDataOffset - rootDataItemOffset)',
    );
  }
}

/**
 * Validates that a path array is valid.
 */
function validatePath(path: Buffer[]): void {
  if (!Array.isArray(path) || path.length === 0) {
    throw new Error('path must be a non-empty array');
  }
  if (path.length > MAX_BUNDLE_NESTING_DEPTH) {
    throw new Error(
      `path exceeds maximum depth of ${MAX_BUNDLE_NESTING_DEPTH}`,
    );
  }
  for (const id of path) {
    if (!Buffer.isBuffer(id) || id.length !== 32) {
      throw new Error('Each path element must be a 32-byte Buffer');
    }
  }
}

/**
 * Encodes a root TX value to MessagePack format for storage in CDB64.
 *
 * @param value - The value to encode (simple, complete, path, or path-complete format)
 * @returns MessagePack-encoded buffer
 */
export function encodeCdb64Value(value: Cdb64RootTxValue): Buffer {
  // Handle path-based formats first
  if (isPathValue(value)) {
    validatePath(value.path);

    if (isPathCompleteValue(value)) {
      validateOffsets(
        value.rootDataItemOffset,
        value.rootDataOffset,
        value.dataItemSize,
      );
      return toMsgpack({
        p: value.path,
        i: value.rootDataItemOffset,
        d: value.rootDataOffset,
        ...(value.dataItemSize !== undefined ? { s: value.dataItemSize } : {}),
      });
    }

    // Path-only format
    return toMsgpack({ p: value.path });
  }

  // Handle legacy formats with rootTxId
  const legacyValue = value as
    | Cdb64RootTxValueSimple
    | Cdb64RootTxValueComplete;

  if (
    !Buffer.isBuffer(legacyValue.rootTxId) ||
    legacyValue.rootTxId.length !== 32
  ) {
    throw new Error('rootTxId must be a 32-byte Buffer');
  }

  if (isCompleteValue(value)) {
    validateOffsets(
      value.rootDataItemOffset,
      value.rootDataOffset,
      value.dataItemSize,
    );
    return toMsgpack({
      r: value.rootTxId,
      i: value.rootDataItemOffset,
      d: value.rootDataOffset,
      ...(value.dataItemSize !== undefined ? { s: value.dataItemSize } : {}),
    });
  }

  // Simple format - just the root TX ID
  return toMsgpack({
    r: legacyValue.rootTxId,
  });
}

/**
 * Validates decoded offset fields and returns them if valid.
 *
 * `s` (item size) is read only when both offsets are present; on its own it
 * carries no location and is ignored.
 */
function decodeOffsets(decoded: { i?: unknown; d?: unknown; s?: unknown }):
  | {
      rootDataItemOffset: number;
      rootDataOffset: number;
      dataItemSize?: number;
    }
  | undefined {
  if (!('i' in decoded) || !('d' in decoded)) {
    return undefined;
  }

  const rootDataItemOffset = decoded.i;
  const rootDataOffset = decoded.d;

  if (
    typeof rootDataItemOffset !== 'number' ||
    !Number.isInteger(rootDataItemOffset) ||
    rootDataItemOffset < 0
  ) {
    throw new Error('Invalid CDB64 value: invalid rootDataItemOffset');
  }

  if (
    typeof rootDataOffset !== 'number' ||
    !Number.isInteger(rootDataOffset) ||
    rootDataOffset < 0
  ) {
    throw new Error('Invalid CDB64 value: invalid rootDataOffset');
  }

  if (!('s' in decoded) || decoded.s === undefined) {
    return { rootDataItemOffset, rootDataOffset };
  }

  if (!isValidDataItemSize(decoded.s, rootDataItemOffset, rootDataOffset)) {
    throw new Error('Invalid CDB64 value: invalid dataItemSize');
  }

  return { rootDataItemOffset, rootDataOffset, dataItemSize: decoded.s };
}

/**
 * Decodes a MessagePack-encoded value from CDB64 storage.
 *
 * @param buffer - MessagePack-encoded buffer
 * @returns Decoded value (simple, complete, path, or path-complete format)
 * @throws Error if the buffer is invalid or missing required fields
 */
export function decodeCdb64Value(buffer: Buffer): Cdb64RootTxValue {
  const decoded = fromMsgpack(buffer);

  if (!decoded || typeof decoded !== 'object') {
    throw new Error('Invalid CDB64 value: not an object');
  }

  // Check for path-based format first (stored as 'p')
  if ('p' in decoded) {
    const path = decoded.p;

    if (!Array.isArray(path) || path.length === 0) {
      throw new Error('Invalid CDB64 value: path must be a non-empty array');
    }

    if (path.length > MAX_BUNDLE_NESTING_DEPTH) {
      throw new Error(
        `Invalid CDB64 value: path exceeds maximum depth of ${MAX_BUNDLE_NESTING_DEPTH}`,
      );
    }

    for (const id of path) {
      if (!Buffer.isBuffer(id) || id.length !== 32) {
        throw new Error(
          'Invalid CDB64 value: each path element must be a 32-byte Buffer',
        );
      }
    }

    // Check for offsets
    const offsets = decodeOffsets(decoded);
    if (offsets !== undefined) {
      return { path, ...offsets };
    }

    // Path-only format
    return { path };
  }

  // Legacy format with rootTxId (stored as 'r')
  if (!Buffer.isBuffer(decoded.r)) {
    throw new Error('Invalid CDB64 value: missing or invalid rootTxId');
  }

  if (decoded.r.length !== 32) {
    throw new Error('Invalid CDB64 value: rootTxId must be 32 bytes');
  }

  // Check for offsets
  const offsets = decodeOffsets(decoded);
  if (offsets !== undefined) {
    return { rootTxId: decoded.r, ...offsets };
  }

  // Simple format
  return {
    rootTxId: decoded.r,
  };
}

/**
 * Extracts the root TX ID from any CDB64 value format.
 *
 * For path-based formats, the root TX ID is path[0].
 * For legacy formats, it's the rootTxId field.
 *
 * @param value - The decoded CDB64 value
 * @returns The root TX ID as a 32-byte Buffer
 */
export function getRootTxId(value: Cdb64RootTxValue): Buffer {
  if (isPathValue(value)) {
    return value.path[0];
  }
  return (value as Cdb64RootTxValueSimple | Cdb64RootTxValueComplete).rootTxId;
}

/**
 * Extracts the path from a CDB64 value if present.
 *
 * @param value - The decoded CDB64 value
 * @returns The path as an array of 32-byte Buffers, or undefined if not present
 */
export function getPath(value: Cdb64RootTxValue): Buffer[] | undefined {
  if (isPathValue(value)) {
    return value.path;
  }
  return undefined;
}

/**
 * Checks if a value has offset information (either legacy complete or path complete).
 */
export function hasOffsets(
  value: Cdb64RootTxValue,
): value is Cdb64RootTxValueComplete | Cdb64RootTxValuePathComplete {
  return isCompleteValue(value) || isPathCompleteValue(value);
}

/**
 * Extracts the total data item size (header + payload) from a CDB64 value, if
 * the value carries it.
 *
 * @param value - The decoded CDB64 value
 * @returns The item size in bytes, or undefined when not recorded
 */
export function getDataItemSize(value: Cdb64RootTxValue): number | undefined {
  return hasOffsets(value) ? value.dataItemSize : undefined;
}
