/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * CLI tool to generate a CDB64 root TX index from a CSV file.
 *
 * CSV format:
 *   data_item_id,root_tx_id[,root_data_item_offset,root_data_offset]
 *
 * - First two columns are required (base64url-encoded IDs)
 * - Offset columns are optional; if present, complete format is used
 *
 * Usage:
 *   ./tools/generate-cdb64-root-tx-index --input data.csv --output index.cdb
 */

import * as fs from 'node:fs';
import * as readline from 'node:readline';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Cdb64Writer } from '../../src/lib/cdb64.js';
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
Generate CDB64 Root TX Index

This tool generates a CDB64 index file from a CSV file containing
data item ID to root transaction ID mappings.

Usage: ./tools/generate-cdb64-root-tx-index [options]

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
  ./tools/generate-cdb64-root-tx-index --input mappings.csv --output index.cdb
  ./tools/generate-cdb64-root-tx-index --input data.csv --output index.cdb --skip-header
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
  console.log('=== CDB64 Root TX Index Generator ===\n');
  console.log(`Input:  ${config.inputPath}`);
  console.log(`Output: ${config.outputPath}`);
  if (config.skipHeader) {
    console.log('Skipping header line');
  }
  console.log('');

  // Verify input file exists
  if (!fs.existsSync(config.inputPath)) {
    throw new Error(`Input file not found: ${config.inputPath}`);
  }

  const writer = new Cdb64Writer(config.outputPath);
  await writer.open();

  let lineNumber = 0;
  let recordCount = 0;
  let simpleCount = 0;
  let completeCount = 0;
  let errorCount = 0;

  const fileStream = fs.createReadStream(config.inputPath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      lineNumber++;

      // Skip header if requested
      if (lineNumber === 1 && config.skipHeader) {
        continue;
      }

      // Skip empty lines
      const trimmedLine = line.trim();
      if (trimmedLine === '') {
        continue;
      }

      // Skip comment lines
      if (trimmedLine.startsWith('#')) {
        continue;
      }

      try {
        const parts = trimmedLine.split(',');

        if (parts.length < 2) {
          throw new Error('CSV line must have at least 2 columns');
        }

        const dataItemId = parseBase64UrlId(parts[0], 'data_item_id');
        const rootTxId = parseBase64UrlId(parts[1], 'root_tx_id');

        let value;
        if (parts.length >= 4 && parts[2].trim() !== '' && parts[3].trim() !== '') {
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

        await writer.add(dataItemId, encodeCdb64Value(value));
        recordCount++;

        // Progress indicator
        if (recordCount % 100000 === 0) {
          console.log(`Processed ${recordCount.toLocaleString()} records...`);
        }
      } catch (error: any) {
        errorCount++;
        console.error(`Error on line ${lineNumber}: ${error.message}`);

        // Stop on too many errors
        if (errorCount > 100) {
          throw new Error('Too many errors, aborting');
        }
      }
    }

    await writer.finalize();

    console.log('\n=== Generation Complete ===');
    console.log(`Total lines processed: ${lineNumber.toLocaleString()}`);
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
  } catch (error) {
    // Clean up on error
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
