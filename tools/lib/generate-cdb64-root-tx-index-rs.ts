/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * CLI tool to generate a CDB64 root TX index from a CSV file.
 * Uses the Rust-backed cdb64 library for improved performance.
 *
 * CSV format:
 *   data_item_id,root_tx_id,path,root_data_item_offset,root_data_offset
 *
 * - data_item_id and root_tx_id are always required (base64url-encoded IDs)
 * - path column contains JSON array of base64url IDs for nested bundles (optional)
 * - offset columns are optional; if present, complete format is used
 *
 * Supports all 4 CDB64 value formats:
 * - Simple: rootTxId only
 * - Complete: rootTxId + offsets
 * - Path: path array (for nested bundles)
 * - Path Complete: path array + offsets
 *
 * Usage:
 *   ./tools/generate-cdb64-root-tx-index-rs --input data.csv --output index.cdb
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { parse } from 'csv-parse';
import { CdbWriter } from 'cdb64/node/index.js';

import {
  encodeCdb64Value,
  Cdb64RootTxValue,
} from '../../src/lib/cdb64-encoding.js';
import { fromB64Url } from '../../src/lib/encoding.js';
import { PartitionedCdb64Writer } from '../../src/lib/partitioned-cdb64-writer.js';

interface Config {
  inputPath: string;
  outputPath: string;
  outputDir?: string;
  partitioned: boolean;
  skipHeader: boolean;
  force: boolean;
}

function printUsage(): void {
  console.log(`
Generate CDB64 Root TX Index (Rust)

This tool generates a CDB64 index file from a CSV file containing
data item ID to root transaction ID mappings. Uses the Rust-backed
cdb64 library for improved single-file performance.

Usage: ./tools/generate-cdb64-root-tx-index-rs [options]

Options:
  --input, -i <path>    Input CSV file path (required)
  --output, -o <path>   Output CDB64 file path (single file mode, required unless --partitioned)
  --partitioned         Enable partitioned output (uses TypeScript writer for each partition)
  --output-dir <path>   Output directory for partitioned index (required with --partitioned)
  --skip-header         Skip the first line of the CSV (default: false)
  --force, -f           Overwrite output file if it exists
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
  # Single file output (uses Rust writer for speed)
  ./tools/generate-cdb64-root-tx-index-rs --input mappings.csv --output index.cdb

  # Partitioned output
  ./tools/generate-cdb64-root-tx-index-rs --input data.csv --partitioned --output-dir ./index/
`);
}

function parseArgs(): Config | null {
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
        printUsage();
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
function looksLikeHeader(record: string[]): boolean {
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

function parseBase64UrlId(value: string, fieldName: string): Buffer {
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

function parseOffset(value: string, fieldName: string): number {
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

function parsePath(
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

async function generateIndex(config: Config): Promise<void> {
  console.log('=== CDB64 Root TX Index Generator (Rust) ===\n');
  console.log(`Input:  ${config.inputPath}`);
  console.log(`Output: ${config.outputPath}`);
  if (config.partitioned) {
    console.log('Mode:   Partitioned (using TypeScript writer)');
  }
  console.log('');

  // Verify input file exists
  if (!fs.existsSync(config.inputPath)) {
    throw new Error(`Input file not found: ${config.inputPath}`);
  }

  // Check if output file/directory exists (unless --force)
  if (fs.existsSync(config.outputPath) && !config.force) {
    throw new Error(
      `Output ${config.partitioned ? 'directory' : 'file'} already exists: ${config.outputPath} (use --force to overwrite)`,
    );
  }

  // For partitioned mode, use PartitionedCdb64Writer
  if (config.partitioned) {
    return generatePartitionedIndex(config);
  }

  // Write to temp file first, rename on success (atomic write)
  const tempPath = config.outputPath + '.tmp.' + process.pid;

  // Create Rust-backed CDB writer
  const writer = new CdbWriter(tempPath);

  let recordNumber = 0;
  let recordCount = 0;
  let simpleCount = 0;
  let completeCount = 0;
  let pathCount = 0;
  let pathCompleteCount = 0;
  let errorCount = 0;
  let headerSkipped = false;
  const startTime = Date.now();

  // Create CSV parser with RFC 4180 support
  const parser = fs.createReadStream(config.inputPath).pipe(
    parse({
      columns: false, // Return arrays, not objects
      skip_empty_lines: true,
      trim: true,
      relax_quotes: true, // Handle minor quote issues gracefully
      comment: '#', // Skip comment lines
    }),
  );

  try {
    for await (const record of parser) {
      recordNumber++;

      // Skip header: either explicitly requested or auto-detected on first record
      if (
        !headerSkipped &&
        (config.skipHeader || looksLikeHeader(record as string[]))
      ) {
        headerSkipped = true;
        if (config.skipHeader) {
          console.log('Skipping header (--skip-header)');
        } else {
          console.log('Header auto-detected, skipping first line');
        }
        continue;
      }
      headerSkipped = true; // Mark as checked even if not skipped

      try {
        const parts = record as string[];

        if (parts.length < 2) {
          throw new Error('CSV record must have at least 2 columns');
        }

        const dataItemId = parseBase64UrlId(parts[0], 'data_item_id');
        const rootTxId = parseBase64UrlId(parts[1], 'root_tx_id');

        // Parse optional path (column 3)
        const path =
          parts.length >= 3 ? parsePath(parts[2], recordNumber) : undefined;

        // Check for offset columns (columns 4-5)
        const hasOffsetCols = parts.length >= 5;
        const hasOffset1 = hasOffsetCols && parts[3].trim() !== '';
        const hasOffset2 = hasOffsetCols && parts[4].trim() !== '';

        // Enforce both-or-neither for offset columns
        if (hasOffset1 !== hasOffset2) {
          throw new Error(
            'If offset columns are present, both root_data_item_offset and root_data_offset must be provided',
          );
        }

        // Build value based on format type
        let value: Cdb64RootTxValue;
        if (path !== undefined) {
          // Path-based formats
          if (hasOffset1 && hasOffset2) {
            const rootDataItemOffset = parseOffset(
              parts[3],
              'root_data_item_offset',
            );
            const rootDataOffset = parseOffset(parts[4], 'root_data_offset');
            value = {
              path,
              rootDataItemOffset,
              rootDataOffset,
            };
            pathCompleteCount++;
          } else {
            value = { path };
            pathCount++;
          }
        } else {
          // Legacy formats
          if (hasOffset1 && hasOffset2) {
            const rootDataItemOffset = parseOffset(
              parts[3],
              'root_data_item_offset',
            );
            const rootDataOffset = parseOffset(parts[4], 'root_data_offset');
            value = {
              rootTxId,
              rootDataItemOffset,
              rootDataOffset,
            };
            completeCount++;
          } else {
            value = { rootTxId };
            simpleCount++;
          }
        }

        // Rust writer uses synchronous put()
        writer.put(dataItemId, encodeCdb64Value(value));
        recordCount++;

        // Progress indicator
        if (recordCount % 100000 === 0) {
          const elapsedSec = (Date.now() - startTime) / 1000;
          const recordsPerSec = Math.round(recordCount / elapsedSec);
          console.log(
            `Processed ${recordCount.toLocaleString()} records... (${recordsPerSec.toLocaleString()} records/sec)`,
          );
        }
      } catch (error: any) {
        errorCount++;
        console.error(`Error on record ${recordNumber}: ${error.message}`);

        // Stop on too many errors
        if (errorCount > 100) {
          throw new Error('Too many errors, aborting');
        }
      }
    }

    // Finalize the CDB file (synchronous)
    writer.finalize();

    // Atomic rename from temp to final path
    fs.renameSync(tempPath, config.outputPath);

    const totalElapsedSec = (Date.now() - startTime) / 1000;
    const avgRecordsPerSec =
      totalElapsedSec > 0 ? Math.round(recordCount / totalElapsedSec) : 0;

    console.log('\n=== Generation Complete ===');
    console.log(`Total records processed: ${recordNumber.toLocaleString()}`);
    console.log(`Records written: ${recordCount.toLocaleString()}`);
    console.log('  Legacy formats:');
    console.log(`    - Simple: ${simpleCount.toLocaleString()}`);
    console.log(`    - Complete: ${completeCount.toLocaleString()}`);
    console.log('  Path formats:');
    console.log(`    - Path: ${pathCount.toLocaleString()}`);
    console.log(`    - Path Complete: ${pathCompleteCount.toLocaleString()}`);
    if (errorCount > 0) {
      console.log(`Errors: ${errorCount}`);
    }
    console.log(`Output: ${config.outputPath}`);

    // Show file size
    const stats = fs.statSync(config.outputPath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
    console.log(`File size: ${sizeMB} MB`);
    console.log(
      `Elapsed time: ${totalElapsedSec.toFixed(1)}s (${avgRecordsPerSec.toLocaleString()} records/sec)`,
    );
  } catch (error) {
    // Clean up temp file on error
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Generates a partitioned index using the TypeScript PartitionedCdb64Writer.
 */
async function generatePartitionedIndex(config: Config): Promise<void> {
  if (!config.outputDir) {
    throw new Error('outputDir is required for partitioned index generation');
  }
  const writer = new PartitionedCdb64Writer(config.outputDir);
  await writer.open();

  let recordNumber = 0;
  let recordCount = 0;
  let simpleCount = 0;
  let completeCount = 0;
  let pathCount = 0;
  let pathCompleteCount = 0;
  let errorCount = 0;
  let headerSkipped = false;
  const startTime = Date.now();

  // Create CSV parser with RFC 4180 support
  const parser = fs.createReadStream(config.inputPath).pipe(
    parse({
      columns: false,
      skip_empty_lines: true,
      trim: true,
      relax_quotes: true,
      comment: '#',
    }),
  );

  try {
    for await (const record of parser) {
      recordNumber++;

      if (
        !headerSkipped &&
        (config.skipHeader || looksLikeHeader(record as string[]))
      ) {
        headerSkipped = true;
        if (config.skipHeader) {
          console.log('Skipping header (--skip-header)');
        } else {
          console.log('Header auto-detected, skipping first line');
        }
        continue;
      }
      headerSkipped = true;

      try {
        const parts = record as string[];

        if (parts.length < 2) {
          throw new Error('CSV record must have at least 2 columns');
        }

        const dataItemId = parseBase64UrlId(parts[0], 'data_item_id');
        const rootTxId = parseBase64UrlId(parts[1], 'root_tx_id');

        const pathValue =
          parts.length >= 3 ? parsePath(parts[2], recordNumber) : undefined;

        const hasOffsetCols = parts.length >= 5;
        const hasOffset1 = hasOffsetCols && parts[3].trim() !== '';
        const hasOffset2 = hasOffsetCols && parts[4].trim() !== '';

        if (hasOffset1 !== hasOffset2) {
          throw new Error(
            'If offset columns are present, both root_data_item_offset and root_data_offset must be provided',
          );
        }

        let value: Cdb64RootTxValue;
        if (pathValue !== undefined) {
          if (hasOffset1 && hasOffset2) {
            const rootDataItemOffset = parseOffset(
              parts[3],
              'root_data_item_offset',
            );
            const rootDataOffset = parseOffset(parts[4], 'root_data_offset');
            value = {
              path: pathValue,
              rootDataItemOffset,
              rootDataOffset,
            };
            pathCompleteCount++;
          } else {
            value = { path: pathValue };
            pathCount++;
          }
        } else {
          if (hasOffset1 && hasOffset2) {
            const rootDataItemOffset = parseOffset(
              parts[3],
              'root_data_item_offset',
            );
            const rootDataOffset = parseOffset(parts[4], 'root_data_offset');
            value = {
              rootTxId,
              rootDataItemOffset,
              rootDataOffset,
            };
            completeCount++;
          } else {
            value = { rootTxId };
            simpleCount++;
          }
        }

        await writer.add(dataItemId, encodeCdb64Value(value));
        recordCount++;

        if (recordCount % 100000 === 0) {
          const elapsedSec = (Date.now() - startTime) / 1000;
          const recordsPerSec = Math.round(recordCount / elapsedSec);
          const stats = writer.getPartitionStats();
          console.log(
            `Processed ${recordCount.toLocaleString()} records, ${stats.length} partitions... (${recordsPerSec.toLocaleString()} records/sec)`,
          );
        }
      } catch (error: any) {
        errorCount++;
        console.error(`Error on record ${recordNumber}: ${error.message}`);

        if (errorCount > 100) {
          throw new Error('Too many errors, aborting');
        }
      }
    }

    const manifest = await writer.finalize();

    const totalElapsedSec = (Date.now() - startTime) / 1000;
    const avgRecordsPerSec =
      totalElapsedSec > 0 ? Math.round(recordCount / totalElapsedSec) : 0;

    console.log('\n=== Generation Complete ===');
    console.log(`Total records processed: ${recordNumber.toLocaleString()}`);
    console.log(`Records written: ${recordCount.toLocaleString()}`);
    console.log('  Legacy formats:');
    console.log(`    - Simple: ${simpleCount.toLocaleString()}`);
    console.log(`    - Complete: ${completeCount.toLocaleString()}`);
    console.log('  Path formats:');
    console.log(`    - Path: ${pathCount.toLocaleString()}`);
    console.log(`    - Path Complete: ${pathCompleteCount.toLocaleString()}`);
    if (errorCount > 0) {
      console.log(`Errors: ${errorCount}`);
    }
    console.log(`Output: ${config.outputPath}`);
    console.log(`Partitions: ${manifest.partitions.length}`);

    const totalSize = manifest.partitions.reduce((sum, p) => sum + p.size, 0);
    const sizeMB = (totalSize / 1024 / 1024).toFixed(2);
    console.log(`Total size: ${sizeMB} MB`);

    // Show partition distribution
    console.log('\nPartition distribution:');
    const sortedPartitions = [...manifest.partitions].sort(
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

    console.log(
      `\nElapsed time: ${totalElapsedSec.toFixed(1)}s (${avgRecordsPerSec.toLocaleString()} records/sec)`,
    );
  } catch (error) {
    await writer.abort();
    throw error;
  }
}

async function main(): Promise<void> {
  try {
    const config = parseArgs();
    if (config === null) {
      process.exit(0);
    }

    await generateIndex(config);
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
