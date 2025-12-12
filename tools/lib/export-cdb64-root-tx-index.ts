/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * CLI tool to export a CDB64 root TX index to CSV format.
 *
 * CSV output format:
 *   data_item_id,root_tx_id[,root_data_item_offset,root_data_offset]
 *
 * - First two columns are always present (base64url-encoded IDs)
 * - Offset columns are present if the value has complete format
 *
 * Usage:
 *   ./tools/export-cdb64-root-tx-index --input index.cdb --output data.csv
 *   ./tools/export-cdb64-root-tx-index --input index.cdb --output - # stdout
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { stringify } from 'csv-stringify';

import { Cdb64Reader } from '../../src/lib/cdb64.js';
import { decodeCdb64Value, isCompleteValue } from '../../src/lib/cdb64-encoding.js';
import { toB64Url } from '../../src/lib/encoding.js';

interface Config {
  inputPath: string;
  outputPath: string;
  includeHeader: boolean;
}

function printUsage(): void {
  console.log(`
Export CDB64 Root TX Index

This tool exports a CDB64 index file to CSV format containing
data item ID to root transaction ID mappings.

Usage: ./tools/export-cdb64-root-tx-index [options]

Options:
  --input <path>    Input CDB64 file path (required)
  --output <path>   Output CSV file path (required, use "-" for stdout)
  --no-header       Omit CSV header row
  --help            Show this help message

CSV Output Format:
  data_item_id,root_tx_id,root_data_item_offset,root_data_offset

  - data_item_id: Base64URL-encoded data item ID (43 characters)
  - root_tx_id: Base64URL-encoded root transaction ID (43 characters)
  - root_data_item_offset: Byte offset (empty if not available)
  - root_data_offset: Byte offset (empty if not available)

Example:
  ./tools/export-cdb64-root-tx-index --input index.cdb --output data.csv
  ./tools/export-cdb64-root-tx-index --input index.cdb --output - > data.csv
  ./tools/export-cdb64-root-tx-index --input index.cdb --output data.csv --no-header
`);
}

function parseArgs(): Config | null {
  const args = process.argv.slice(2);
  let inputPath: string | undefined;
  let outputPath: string | undefined;
  let includeHeader = true;

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
        outputPath = nextArg === '-' ? '-' : path.resolve(nextArg);
        i++;
        break;
      case '--no-header':
        includeHeader = false;
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

  return { inputPath, outputPath, includeHeader };
}

async function exportIndex(config: Config): Promise<void> {
  const isStdout = config.outputPath === '-';

  if (!isStdout) {
    console.error('=== CDB64 Root TX Index Exporter ===\n');
    console.error(`Input:  ${config.inputPath}`);
    console.error(`Output: ${config.outputPath}`);
    console.error('');
  }

  // Verify input file exists
  if (!fs.existsSync(config.inputPath)) {
    throw new Error(`Input file not found: ${config.inputPath}`);
  }

  const reader = new Cdb64Reader(config.inputPath);
  await reader.open();

  // Create output stream
  const outputStream = isStdout
    ? process.stdout
    : fs.createWriteStream(config.outputPath);

  // Create CSV stringifier with RFC 4180 support
  const stringifier = stringify({
    header: config.includeHeader,
    columns: [
      'data_item_id',
      'root_tx_id',
      'root_data_item_offset',
      'root_data_offset',
    ],
  });

  // Pipe stringifier to output stream
  stringifier.pipe(outputStream);

  let recordCount = 0;
  let simpleCount = 0;
  let completeCount = 0;
  let errorCount = 0;

  try {
    for await (const { key, value } of reader.entries()) {
      try {
        // Decode the value
        const decoded = decodeCdb64Value(value);

        // Convert binary IDs to base64url
        const dataItemId = toB64Url(key);
        const rootTxId = toB64Url(decoded.rootTxId);

        // Build CSV record
        let record: (string | number)[];
        if (isCompleteValue(decoded)) {
          record = [
            dataItemId,
            rootTxId,
            decoded.rootDataItemOffset,
            decoded.rootDataOffset,
          ];
          completeCount++;
        } else {
          record = [dataItemId, rootTxId, '', ''];
          simpleCount++;
        }

        // Write record with backpressure handling
        const canContinue = stringifier.write(record);
        if (!canContinue) {
          await new Promise<void>((resolve) =>
            stringifier.once('drain', resolve),
          );
        }

        recordCount++;

        // Progress indicator (only to stderr when not stdout)
        if (!isStdout && recordCount % 100000 === 0) {
          console.error(`Exported ${recordCount.toLocaleString()} records...`);
        }
      } catch (error: any) {
        errorCount++;
        console.error(`Error decoding record: ${error.message}`);

        // Stop on too many errors
        if (errorCount > 100) {
          throw new Error('Too many errors, aborting');
        }
      }
    }

    // End the stringifier and wait for it to finish
    await new Promise<void>((resolve, reject) => {
      stringifier.on('finish', resolve);
      stringifier.on('error', reject);
      stringifier.end();
    });

    await reader.close();

    if (!isStdout) {
      console.error('\n=== Export Complete ===');
      console.error(`Records exported: ${recordCount.toLocaleString()}`);
      console.error(`  - Simple format: ${simpleCount.toLocaleString()}`);
      console.error(`  - Complete format: ${completeCount.toLocaleString()}`);
      if (errorCount > 0) {
        console.error(`Errors: ${errorCount}`);
      }
      console.error(`Output: ${config.outputPath}`);

      // Show file size
      const stats = fs.statSync(config.outputPath);
      const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
      console.error(`File size: ${sizeMB} MB`);
    }
  } catch (error) {
    await reader.close();
    stringifier.destroy();
    if (!isStdout && outputStream !== process.stdout) {
      (outputStream as fs.WriteStream).destroy();
      // Clean up partial file
      try {
        fs.unlinkSync(config.outputPath);
      } catch {
        // Ignore cleanup errors
      }
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

    await exportIndex(config);
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
