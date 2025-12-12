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
 *   data_item_id,root_tx_id[,root_data_item_offset,root_data_offset]
 *
 * - First two columns are required (base64url-encoded IDs)
 * - Offset columns are optional; if present, complete format is used
 *
 * Usage:
 *   ./tools/generate-cdb64-root-tx-index-rs --input data.csv --output index.cdb
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'csv-parse';
import { CdbWriter } from 'cdb64/node/index.js';

import { encodeCdb64Value } from '../../src/lib/cdb64-encoding.js';
import { fromB64Url } from '../../src/lib/encoding.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface Config {
  inputPath: string;
  outputPath: string;
  skipHeader: boolean;
}

function printUsage(): void {
  console.log(`
Generate CDB64 Root TX Index (Rust)

This tool generates a CDB64 index file from a CSV file containing
data item ID to root transaction ID mappings. Uses the Rust-backed
cdb64 library for improved performance.

Usage: ./tools/generate-cdb64-root-tx-index-rs [options]

Options:
  --input <path>    Input CSV file path (required)
  --output <path>   Output CDB64 file path (required)
  --skip-header     Skip the first line of the CSV (default: false)
  --help            Show this help message

CSV Format:
  data_item_id,root_tx_id[,root_data_item_offset,root_data_offset]

  - data_item_id: Base64URL-encoded data item ID (43 characters)
  - root_tx_id: Base64URL-encoded root transaction ID (43 characters)
  - root_data_item_offset: (optional) Byte offset to data item header
  - root_data_offset: (optional) Byte offset to data payload

  If offset columns are present, both must be provided.

Example:
  ./tools/generate-cdb64-root-tx-index-rs --input mappings.csv --output index.cdb
  ./tools/generate-cdb64-root-tx-index-rs --input data.csv --output index.cdb --skip-header
`);
}

function parseArgs(): Config | null {
  const args = process.argv.slice(2);
  let inputPath: string | undefined;
  let outputPath: string | undefined;
  let skipHeader = false;

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
      case '--skip-header':
        skipHeader = true;
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
  if (!outputPath) {
    throw new Error('--output is required');
  }

  return { inputPath, outputPath, skipHeader };
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

  return num;
}

async function generateIndex(config: Config): Promise<void> {
  console.log('=== CDB64 Root TX Index Generator (Rust) ===\n');
  console.log(`Input:  ${config.inputPath}`);
  console.log(`Output: ${config.outputPath}`);
  console.log('');

  // Verify input file exists
  if (!fs.existsSync(config.inputPath)) {
    throw new Error(`Input file not found: ${config.inputPath}`);
  }

  // Write to temp file first, rename on success (atomic write)
  const tempPath = config.outputPath + '.tmp.' + process.pid;

  // Create Rust-backed CDB writer
  const writer = new CdbWriter(tempPath);

  let recordNumber = 0;
  let recordCount = 0;
  let simpleCount = 0;
  let completeCount = 0;
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

        let value;
        if (
          parts.length >= 4 &&
          parts[2].trim() !== '' &&
          parts[3].trim() !== ''
        ) {
          // Complete format with offsets
          const rootDataItemOffset = parseOffset(
            parts[2],
            'root_data_item_offset',
          );
          const rootDataOffset = parseOffset(parts[3], 'root_data_offset');

          value = {
            rootTxId,
            rootDataItemOffset,
            rootDataOffset,
          };
          completeCount++;
        } else {
          // Simple format
          value = { rootTxId };
          simpleCount++;
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
    console.log(`  - Simple format: ${simpleCount.toLocaleString()}`);
    console.log(`  - Complete format: ${completeCount.toLocaleString()}`);
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
