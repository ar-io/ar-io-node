/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Shared utilities for CDB64 root TX index generation tools.
 *
 * These utilities are shared between the TypeScript and Rust-backed
 * CDB64 generator tools to avoid code duplication.
 */

import * as path from 'node:path';

import { fromB64Url } from '../../src/lib/encoding.js';

/**
 * Configuration for CDB64 index generation.
 */
export interface Config {
  inputPath: string;
  outputPath: string;
  outputDir?: string;
  partitioned: boolean;
  skipHeader: boolean;
  force: boolean;
}

/**
 * Statistics tracked during index generation.
 */
export interface ProcessingStats {
  recordNumber: number;
  recordCount: number;
  simpleCount: number;
  completeCount: number;
  pathCount: number;
  pathCompleteCount: number;
  errorCount: number;
  startTime: number;
}

/**
 * Creates initial processing stats.
 */
export function createStats(): ProcessingStats {
  return {
    recordNumber: 0,
    recordCount: 0,
    simpleCount: 0,
    completeCount: 0,
    pathCount: 0,
    pathCompleteCount: 0,
    errorCount: 0,
    startTime: Date.now(),
  };
}

/**
 * Prints usage help for the generator tool.
 */
export function printUsage(toolName: string, description: string): void {
  console.log(`
Generate CDB64 Root TX Index${description}

This tool generates a CDB64 index file from a CSV file containing
data item ID to root transaction ID mappings.${description}

Usage: ${toolName} [options]

Options:
  --input, -i <path>    Input CSV file path (required)
  --output, -o <path>   Output CDB64 file path (single file mode, required unless --partitioned)
  --partitioned         Enable partitioned output (splits by key prefix into 00.cdb-ff.cdb)
  --output-dir <path>   Output directory for partitioned index (required with --partitioned)
  --skip-header         Skip the first line of the CSV (default: false)
  --force, -f           Overwrite output file/directory if it exists
  --help, -h            Show this help message

CSV Format:
  data_item_id,root_tx_id,path,root_data_item_offset,root_data_offset

  - data_item_id: Base64URL-encoded data item ID (43 characters)
  - root_tx_id: Base64URL-encoded root transaction ID (43 characters)
  - path: JSON array of base64url IDs for nested bundles (empty if not path format)
          Format: ["rootId","bundle1Id","bundle2Id",...,"parentId"]
  - root_data_item_offset: Byte offset (empty if not available)
  - root_data_offset: Byte offset (empty if not available)

  If offset columns are present, both must be provided.

Supported Value Formats:
  - Simple: rootTxId only (legacy)
  - Complete: rootTxId + offsets (legacy)
  - Path: bundle traversal path (nested bundles)
  - Path Complete: path + offsets (nested bundles with offsets)

Example:
  # Single file output
  ${toolName} --input mappings.csv --output index.cdb

  # Partitioned output
  ${toolName} --input data.csv --partitioned --output-dir ./index/
`);
}

/**
 * Parses command line arguments.
 *
 * @returns Config object if arguments are valid, null if help was shown
 * @throws Error if arguments are invalid
 */
export function parseArgs(): Config | null {
  const args = process.argv.slice(2);
  let inputPath: string | undefined;
  let outputPath: string | undefined;
  let outputDir: string | undefined;
  let partitioned = false;
  let skipHeader = false;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case '--input':
      case '-i':
        if (!nextArg) throw new Error('--input requires a path');
        inputPath = path.resolve(nextArg);
        i++;
        break;
      case '--output':
      case '-o':
        if (!nextArg) throw new Error('--output requires a path');
        outputPath = path.resolve(nextArg);
        i++;
        break;
      case '--output-dir':
        if (!nextArg) throw new Error('--output-dir requires a path');
        outputDir = path.resolve(nextArg);
        i++;
        break;
      case '--partitioned':
        partitioned = true;
        break;
      case '--skip-header':
        skipHeader = true;
        break;
      case '--force':
      case '-f':
        force = true;
        break;
      case '--help':
      case '-h':
        return null;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!inputPath) {
    throw new Error('--input is required');
  }

  if (partitioned) {
    if (!outputDir) {
      throw new Error('--output-dir is required when using --partitioned');
    }
    // In partitioned mode, outputPath is set to outputDir for logging purposes
    outputPath = outputDir;
  } else {
    if (!outputPath) {
      throw new Error('--output is required');
    }
  }

  return { inputPath, outputPath, outputDir, partitioned, skipHeader, force };
}

/**
 * Checks if a record looks like a CSV header rather than data.
 * Headers won't have valid 43-character base64url IDs in the first two columns.
 */
export function looksLikeHeader(record: string[]): boolean {
  if (record.length < 2) return true;

  const first = record[0].trim();
  const second = record[1].trim();

  // Valid IDs are exactly 43 characters of base64url
  if (first.length !== 43 || second.length !== 43) {
    return true;
  }

  // Check for non-base64url characters
  const base64urlPattern = /^[A-Za-z0-9_-]+$/;
  return !base64urlPattern.test(first) || !base64urlPattern.test(second);
}

/**
 * Parses a base64url-encoded ID from a CSV field.
 *
 * @param value - The raw CSV field value
 * @param fieldName - Field name for error messages
 * @returns The decoded 32-byte buffer
 * @throws Error if the ID is invalid
 */
export function parseBase64UrlId(value: string, fieldName: string): Buffer {
  const trimmed = value.trim();

  // Validate length (base64url-encoded 32 bytes = 43 characters)
  if (trimmed.length !== 43) {
    throw new Error(
      `Invalid ${fieldName}: expected 43 characters, got ${trimmed.length}`,
    );
  }

  const buffer = fromB64Url(trimmed);

  if (buffer.length !== 32) {
    throw new Error(
      `Invalid ${fieldName}: expected 32 bytes after decoding, got ${buffer.length}`,
    );
  }

  return buffer;
}

/**
 * Parses an offset value from a CSV field.
 *
 * @param value - The raw CSV field value
 * @param fieldName - Field name for error messages
 * @returns The parsed offset as a number
 * @throws Error if the offset is invalid
 */
export function parseOffset(value: string, fieldName: string): number {
  const trimmed = value.trim();
  const num = parseInt(trimmed, 10);

  if (isNaN(num) || !Number.isInteger(num) || num < 0) {
    throw new Error(
      `Invalid ${fieldName}: expected non-negative integer, got "${trimmed}"`,
    );
  }

  if (num > Number.MAX_SAFE_INTEGER) {
    throw new Error(
      `Invalid ${fieldName}: value ${trimmed} exceeds maximum safe integer (${Number.MAX_SAFE_INTEGER})`,
    );
  }

  return num;
}

/**
 * Parses a path JSON array from a CSV field.
 *
 * @param pathStr - The raw path JSON string
 * @param recordNumber - Record number for error messages
 * @returns Array of decoded ID buffers, or undefined if path is empty
 * @throws Error if the path JSON is invalid
 */
export function parsePath(
  pathStr: string,
  recordNumber: number,
): Buffer[] | undefined {
  const trimmed = pathStr.trim();
  if (trimmed === '') {
    return undefined;
  }

  let pathArray: string[];
  try {
    pathArray = JSON.parse(trimmed);
  } catch {
    throw new Error(`Invalid path JSON at record ${recordNumber}`);
  }

  if (!Array.isArray(pathArray) || pathArray.length === 0) {
    throw new Error(`Path must be a non-empty array at record ${recordNumber}`);
  }

  return pathArray.map((id, idx) =>
    parseBase64UrlId(id, `path[${idx}] at record ${recordNumber}`),
  );
}

/**
 * Prints generation summary statistics.
 */
export function printGenerationSummary(
  stats: ProcessingStats,
  outputPath: string,
  partitionInfo?: { count: number; totalSize: number },
  fileSize?: number,
): void {
  const totalElapsedSec = (Date.now() - stats.startTime) / 1000;
  const avgRecordsPerSec =
    totalElapsedSec > 0 ? Math.round(stats.recordCount / totalElapsedSec) : 0;

  console.log('\n=== Generation Complete ===');
  console.log(`Total records processed: ${stats.recordNumber.toLocaleString()}`);
  console.log(`Records written: ${stats.recordCount.toLocaleString()}`);
  console.log('  Legacy formats:');
  console.log(`    - Simple: ${stats.simpleCount.toLocaleString()}`);
  console.log(`    - Complete: ${stats.completeCount.toLocaleString()}`);
  console.log('  Path formats:');
  console.log(`    - Path: ${stats.pathCount.toLocaleString()}`);
  console.log(`    - Path Complete: ${stats.pathCompleteCount.toLocaleString()}`);
  if (stats.errorCount > 0) {
    console.log(`Errors: ${stats.errorCount}`);
  }
  console.log(`Output: ${outputPath}`);

  if (partitionInfo !== undefined) {
    console.log(`Partitions: ${partitionInfo.count}`);
    const sizeMB = (partitionInfo.totalSize / 1024 / 1024).toFixed(2);
    console.log(`Total size: ${sizeMB} MB`);
  } else if (fileSize !== undefined) {
    const sizeMB = (fileSize / 1024 / 1024).toFixed(2);
    console.log(`File size: ${sizeMB} MB`);
  }

  console.log(
    `Elapsed time: ${totalElapsedSec.toFixed(1)}s (${avgRecordsPerSec.toLocaleString()} records/sec)`,
  );
}

/**
 * Prints progress during generation.
 */
export function printProgress(
  recordCount: number,
  startTime: number,
  partitionCount?: number,
): void {
  const elapsedSec = (Date.now() - startTime) / 1000;
  const recordsPerSec = Math.round(recordCount / elapsedSec);

  if (partitionCount !== undefined) {
    console.log(
      `Processed ${recordCount.toLocaleString()} records, ${partitionCount} partitions... (${recordsPerSec.toLocaleString()} records/sec)`,
    );
  } else {
    console.log(
      `Processed ${recordCount.toLocaleString()} records... (${recordsPerSec.toLocaleString()} records/sec)`,
    );
  }
}

/**
 * Prints partition distribution summary.
 */
export function printPartitionDistribution(
  partitions: Array<{ prefix: string; recordCount: number; size: number }>,
): void {
  console.log('\nPartition distribution:');
  const sortedPartitions = [...partitions].sort(
    (a, b) => b.recordCount - a.recordCount,
  );
  const top5 = sortedPartitions.slice(0, 5);
  for (const p of top5) {
    console.log(
      `  ${p.prefix}: ${p.recordCount.toLocaleString()} records (${(p.size / 1024 / 1024).toFixed(2)} MB)`,
    );
  }
  if (sortedPartitions.length > 5) {
    console.log(`  ... and ${sortedPartitions.length - 5} more partitions`);
  }
}
