/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * CDB64 Manifest - Types and utilities for partitioned CDB64 indexes.
 *
 * A partitioned CDB64 index splits records across up to 256 files (00.cdb - ff.cdb)
 * based on the first byte of the 32-byte key. This enables manageable file sizes
 * while maintaining O(1) lookup performance.
 */

// Partition location types - where partition data can be found
export type PartitionFileLocation = {
  type: 'file';
  filename: string;
};

export type PartitionHttpLocation = {
  type: 'http';
  url: string;
};

export type PartitionArweaveTxLocation = {
  type: 'arweave-tx';
  txId: string;
};

export type PartitionArweaveBundleItemLocation = {
  type: 'arweave-bundle-item';
  txId: string;
  offset: number;
  size: number;
};

export type PartitionLocation =
  | PartitionFileLocation
  | PartitionHttpLocation
  | PartitionArweaveTxLocation
  | PartitionArweaveBundleItemLocation;

// Partition info - metadata about a single partition
export interface PartitionInfo {
  /** Two-character hex prefix (00-ff) representing the first byte of keys */
  prefix: string;
  /** Where to find the partition data */
  location: PartitionLocation;
  /** Number of records in this partition */
  recordCount: number;
  /** Size of the partition file in bytes */
  size: number;
  /** Optional SHA-256 hash for integrity verification */
  sha256?: string;
}

// Root manifest - describes the complete partitioned index
export interface Cdb64Manifest {
  /** Schema version (currently always 1) */
  version: 1;
  /** ISO 8601 timestamp of when the manifest was created */
  createdAt: string;
  /** Total number of records across all partitions */
  totalRecords: number;
  /** List of partition information */
  partitions: PartitionInfo[];
  /** Optional arbitrary metadata */
  metadata?: Record<string, unknown>;
}

// Hex prefix pattern: exactly two lowercase hex characters
const HEX_PREFIX_PATTERN = /^[0-9a-f]{2}$/;

// Valid location types
const VALID_LOCATION_TYPES = [
  'file',
  'http',
  'arweave-tx',
  'arweave-bundle-item',
];

/**
 * Validates that a value is a valid hex prefix (00-ff).
 */
function isValidHexPrefix(value: unknown): value is string {
  return typeof value === 'string' && HEX_PREFIX_PATTERN.test(value);
}

/**
 * Validates that a value is a valid partition location.
 */
function isValidPartitionLocation(value: unknown): value is PartitionLocation {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const obj = value as Record<string, unknown>;

  if (!VALID_LOCATION_TYPES.includes(obj.type as string)) {
    return false;
  }

  switch (obj.type) {
    case 'file':
      return typeof obj.filename === 'string' && obj.filename.length > 0;

    case 'http':
      return typeof obj.url === 'string' && obj.url.length > 0;

    case 'arweave-tx':
      return typeof obj.txId === 'string' && obj.txId.length > 0;

    case 'arweave-bundle-item':
      return (
        typeof obj.txId === 'string' &&
        obj.txId.length > 0 &&
        typeof obj.offset === 'number' &&
        Number.isInteger(obj.offset) &&
        obj.offset >= 0 &&
        typeof obj.size === 'number' &&
        Number.isInteger(obj.size) &&
        obj.size > 0
      );

    default:
      return false;
  }
}

/**
 * Validates that a value is a valid partition info object.
 */
function isValidPartitionInfo(value: unknown): value is PartitionInfo {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const obj = value as Record<string, unknown>;

  // Required fields
  if (!isValidHexPrefix(obj.prefix)) {
    return false;
  }

  if (!isValidPartitionLocation(obj.location)) {
    return false;
  }

  if (
    typeof obj.recordCount !== 'number' ||
    !Number.isInteger(obj.recordCount) ||
    obj.recordCount < 0
  ) {
    return false;
  }

  if (
    typeof obj.size !== 'number' ||
    !Number.isInteger(obj.size) ||
    obj.size < 1
  ) {
    return false;
  }

  // Optional sha256
  if (obj.sha256 !== undefined && typeof obj.sha256 !== 'string') {
    return false;
  }

  return true;
}

/**
 * Type guard that validates a manifest object.
 * Unknown fields are ignored for forward compatibility.
 */
export function validateManifest(data: unknown): data is Cdb64Manifest {
  if (typeof data !== 'object' || data === null) {
    return false;
  }

  const obj = data as Record<string, unknown>;

  // Version must be 1
  if (obj.version !== 1) {
    return false;
  }

  // createdAt must be a non-empty string (ISO 8601 format not strictly validated)
  if (typeof obj.createdAt !== 'string' || obj.createdAt.length === 0) {
    return false;
  }

  // totalRecords must be a non-negative integer
  if (
    typeof obj.totalRecords !== 'number' ||
    !Number.isInteger(obj.totalRecords) ||
    obj.totalRecords < 0
  ) {
    return false;
  }

  // partitions must be an array
  if (!Array.isArray(obj.partitions)) {
    return false;
  }

  // Validate each partition
  for (const partition of obj.partitions) {
    if (!isValidPartitionInfo(partition)) {
      return false;
    }
  }

  // Check for duplicate prefixes
  const prefixes = new Set<string>();
  for (const partition of obj.partitions as PartitionInfo[]) {
    if (prefixes.has(partition.prefix)) {
      return false; // Duplicate prefix
    }
    prefixes.add(partition.prefix);
  }

  // Optional metadata must be an object if present
  if (obj.metadata !== undefined) {
    if (typeof obj.metadata !== 'object' || obj.metadata === null) {
      return false;
    }
  }

  return true;
}

/**
 * Parses a JSON string into a Cdb64Manifest.
 * Throws an error if the JSON is invalid or doesn't match the manifest schema.
 */
export function parseManifest(json: string): Cdb64Manifest {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `Invalid manifest JSON: ${error instanceof Error ? error.message : 'parse error'}`,
    );
  }

  if (!validateManifest(data)) {
    throw new Error('Invalid manifest: schema validation failed');
  }

  // Extract only the known fields to create a clean manifest object
  const manifest: Cdb64Manifest = {
    version: 1,
    createdAt: data.createdAt,
    totalRecords: data.totalRecords,
    partitions: data.partitions.map((p) => {
      const partition: PartitionInfo = {
        prefix: p.prefix,
        location: p.location,
        recordCount: p.recordCount,
        size: p.size,
      };
      if (p.sha256 !== undefined) {
        partition.sha256 = p.sha256;
      }
      return partition;
    }),
  };

  if (data.metadata !== undefined) {
    manifest.metadata = data.metadata as Record<string, unknown>;
  }

  return manifest;
}

/**
 * Serializes a Cdb64Manifest to a JSON string.
 * Uses 2-space indentation for readability.
 */
export function serializeManifest(manifest: Cdb64Manifest): string {
  if (!validateManifest(manifest)) {
    throw new Error('Invalid manifest: cannot serialize invalid manifest');
  }
  return JSON.stringify(manifest, null, 2);
}

/**
 * Gets the partition prefix for a key.
 * The prefix is the first byte of the key as a 2-character lowercase hex string.
 *
 * @param key - A Buffer containing the key (must be at least 1 byte)
 * @returns The 2-character hex prefix (00-ff)
 */
export function getPartitionPrefix(key: Buffer): string {
  if (key.length === 0) {
    throw new Error('Key must be at least 1 byte');
  }
  return key[0].toString(16).padStart(2, '0');
}

/**
 * Gets the partition index for a key.
 * This is simply the first byte of the key (0-255).
 *
 * @param key - A Buffer containing the key (must be at least 1 byte)
 * @returns The partition index (0-255)
 */
export function getPartitionIndex(key: Buffer): number {
  if (key.length === 0) {
    throw new Error('Key must be at least 1 byte');
  }
  return key[0];
}

/**
 * Converts a partition index (0-255) to a hex prefix string.
 *
 * @param index - The partition index (0-255)
 * @returns The 2-character hex prefix (00-ff)
 */
export function indexToPrefix(index: number): string {
  if (index < 0 || index > 255 || !Number.isInteger(index)) {
    throw new Error('Index must be an integer between 0 and 255');
  }
  return index.toString(16).padStart(2, '0');
}

/**
 * Converts a hex prefix string to a partition index.
 *
 * @param prefix - The 2-character hex prefix (00-ff)
 * @returns The partition index (0-255)
 */
export function prefixToIndex(prefix: string): number {
  if (!isValidHexPrefix(prefix)) {
    throw new Error(
      'Prefix must be a 2-character lowercase hex string (00-ff)',
    );
  }
  return parseInt(prefix, 16);
}

/**
 * Creates an empty manifest with the current timestamp.
 */
export function createEmptyManifest(
  metadata?: Record<string, unknown>,
): Cdb64Manifest {
  const manifest: Cdb64Manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    totalRecords: 0,
    partitions: [],
  };

  if (metadata !== undefined) {
    manifest.metadata = metadata;
  }

  return manifest;
}
