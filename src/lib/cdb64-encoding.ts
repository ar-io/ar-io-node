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
 * for compactness. Two formats are supported:
 *
 * ### Simple Format
 * Used when only the root transaction ID is known:
 * ```
 * { r: <Buffer 32 bytes> }
 * ```
 *
 * ### Complete Format
 * Used when offset information is available:
 * ```
 * { r: <Buffer 32 bytes>, i: <integer>, d: <integer> }
 * ```
 *
 * ## Key Mapping
 *
 * | Key | Full Name            | Description                              |
 * |-----|----------------------|------------------------------------------|
 * | r   | rootTxId             | 32-byte root transaction ID (binary)     |
 * | i   | rootDataItemOffset   | Byte offset of data item header          |
 * | d   | rootDataOffset       | Byte offset of data payload              |
 *
 * The offsets correspond to HTTP headers:
 * - `i` → `X-AR-IO-Root-Data-Item-Offset`
 * - `d` → `X-AR-IO-Root-Data-Offset`
 */

import { toMsgpack, fromMsgpack } from './encoding.js';

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
 */
export interface Cdb64RootTxValueComplete {
  /** 32-byte root transaction ID */
  rootTxId: Buffer;
  /** Byte offset of data item header within root TX data */
  rootDataItemOffset: number;
  /** Byte offset of data payload within root TX data */
  rootDataOffset: number;
}

/**
 * Union type for CDB64 root TX values.
 */
export type Cdb64RootTxValue =
  | Cdb64RootTxValueSimple
  | Cdb64RootTxValueComplete;

/**
 * Type guard to check if a value has complete offset information.
 */
export function isCompleteValue(
  value: Cdb64RootTxValue,
): value is Cdb64RootTxValueComplete {
  return (
    'rootDataItemOffset' in value &&
    'rootDataOffset' in value &&
    typeof value.rootDataItemOffset === 'number' &&
    typeof value.rootDataOffset === 'number'
  );
}

/**
 * Encodes a root TX value to MessagePack format for storage in CDB64.
 *
 * @param value - The value to encode (simple or complete format)
 * @returns MessagePack-encoded buffer
 */
export function encodeCdb64Value(value: Cdb64RootTxValue): Buffer {
  // Validate rootTxId is a 32-byte buffer
  if (!Buffer.isBuffer(value.rootTxId) || value.rootTxId.length !== 32) {
    throw new Error('rootTxId must be a 32-byte Buffer');
  }

  if (isCompleteValue(value)) {
    // Validate offsets are non-negative integers
    if (
      !Number.isInteger(value.rootDataItemOffset) ||
      value.rootDataItemOffset < 0
    ) {
      throw new Error('rootDataItemOffset must be a non-negative integer');
    }
    if (!Number.isInteger(value.rootDataOffset) || value.rootDataOffset < 0) {
      throw new Error('rootDataOffset must be a non-negative integer');
    }

    return toMsgpack({
      r: value.rootTxId,
      i: value.rootDataItemOffset,
      d: value.rootDataOffset,
    });
  }

  // Simple format - just the root TX ID
  return toMsgpack({
    r: value.rootTxId,
  });
}

/**
 * Decodes a MessagePack-encoded value from CDB64 storage.
 *
 * @param buffer - MessagePack-encoded buffer
 * @returns Decoded value (simple or complete format)
 * @throws Error if the buffer is invalid or missing required fields
 */
export function decodeCdb64Value(buffer: Buffer): Cdb64RootTxValue {
  const decoded = fromMsgpack(buffer);

  if (!decoded || typeof decoded !== 'object') {
    throw new Error('Invalid CDB64 value: not an object');
  }

  // Check for required rootTxId field (stored as 'r')
  if (!Buffer.isBuffer(decoded.r)) {
    throw new Error('Invalid CDB64 value: missing or invalid rootTxId');
  }

  if (decoded.r.length !== 32) {
    throw new Error('Invalid CDB64 value: rootTxId must be 32 bytes');
  }

  // Check if complete format (has offset fields)
  if ('i' in decoded && 'd' in decoded) {
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

    return {
      rootTxId: decoded.r,
      rootDataItemOffset,
      rootDataOffset,
    };
  }

  // Simple format
  return {
    rootTxId: decoded.r,
  };
}
