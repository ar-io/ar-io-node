/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * CDB64 Verification Tool
 *
 * Verifies that all IDs from a CSV file exist in a CDB64 index file.
 * Useful for validating CDB64 files after generation.
 */

import fs from 'node:fs';
import readline from 'node:readline';
import { performance } from 'node:perf_hooks';

import { Cdb64Reader } from '../../src/lib/cdb64.js';
import { decodeCdb64Value, getRootTxId } from '../../src/lib/cdb64-encoding.js';
import { fromB64Url, toB64Url } from '../../src/lib/encoding.js';

interface Config {
  cdb64Path: string;
  csvPath: string;
  skipHeader: boolean;
  verbose: boolean;
  jsonOutput: boolean;
  mode: 'random' | 'sequential';
  count: number | undefined;
  compareValues: boolean;
}

interface Stats {
  totalChecked: number;
  found: number;
  notFound: number;
  mismatched: number;
  errors: number;
  missingIds: string[];
  mismatchedIds: string[];
  startTime: number;
  endTime: number;
}

// Valid base64url TX/data item ID pattern (43 characters)
const ID_PATTERN = /^[a-zA-Z0-9_-]{43}$/;

interface CsvRow {
  id: string;
  expectedRootTxId?: string;
}

/**
 * Parse a CSV line and extract the ID and optional expected root TX ID.
 */
function parseLineForRow(line: string): CsvRow | null {
  const trimmedLine = line.trim();
  if (trimmedLine.length === 0) return null;

  // Handle CSV: split by comma (simple split, assumes no commas in values)
  const columns = trimmedLine.split(',');
  const firstColumn = columns[0].trim();
  // Remove quotes if present
  const id = firstColumn.replace(/^["']|["']$/g, '');

  if (!ID_PATTERN.test(id)) {
    return null;
  }

  // Check for expected root TX ID in second column
  let expectedRootTxId: string | undefined;
  if (columns.length > 1) {
    const secondColumn = columns[1].trim().replace(/^["']|["']$/g, '');
    if (ID_PATTERN.test(secondColumn)) {
      expectedRootTxId = secondColumn;
    }
  }

  return { id, expectedRootTxId };
}

/**
 * Get file size for random seeking.
 */
function getFileSize(csvPath: string): number {
  const stat = fs.statSync(csvPath);
  return stat.size;
}

/**
 * Get a random row by seeking to a random position in the file.
 * Seeks to random byte, finds next line boundary, reads that line.
 */
function getRandomRowFromFile(csvPath: string, fileSize: number): CsvRow | null {
  const fd = fs.openSync(csvPath, 'r');
  try {
    // Pick random position (leave room to find a complete line)
    const randomPos = Math.floor(Math.random() * Math.max(1, fileSize - 100));

    // Read a chunk starting from random position
    const chunkSize = 512; // Enough for a line with ID and root TX ID
    const buffer = Buffer.alloc(chunkSize);
    const bytesRead = fs.readSync(fd, buffer, 0, chunkSize, randomPos);

    if (bytesRead === 0) return null;

    const chunk = buffer.toString('utf-8', 0, bytesRead);

    // Find start of next complete line (skip partial line we landed in)
    let lineStart = chunk.indexOf('\n');
    if (lineStart === -1) return null;
    lineStart++; // Move past the newline

    // Find end of that line
    let lineEnd = chunk.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = bytesRead;

    const line = chunk.substring(lineStart, lineEnd);
    return parseLineForRow(line);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Get a random valid row, retrying if we land on an invalid line.
 */
function getRandomRow(csvPath: string, fileSize: number): CsvRow {
  let attempts = 0;
  const maxAttempts = 100;

  while (attempts < maxAttempts) {
    const row = getRandomRowFromFile(csvPath, fileSize);
    if (row) return row;
    attempts++;
  }

  throw new Error('Failed to find valid row after maximum attempts');
}

/**
 * Stream rows from CSV file sequentially, yielding them one at a time.
 */
async function* streamCsvRowsSequential(
  csvPath: string,
  skipHeader: boolean,
  count: number | undefined,
): AsyncGenerator<CsvRow> {
  const stream = fs.createReadStream(csvPath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lineNumber = 0;
  let yieldedCount = 0;

  for await (const line of rl) {
    lineNumber++;

    // Skip header if configured
    if (skipHeader && lineNumber === 1) {
      continue;
    }

    const row = parseLineForRow(line);
    if (row) {
      yield row;
      yieldedCount++;

      // Stop if we've reached the count limit
      if (count !== undefined && yieldedCount >= count) {
        rl.close();
        break;
      }
    }
  }
}

/**
 * Format duration for human-readable display.
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Check a single row against the CDB64 reader and update stats.
 * Verifies the value decodes and has a valid root TX ID.
 * Optionally compares the root TX ID against the expected value from CSV.
 */
async function checkRow(
  row: CsvRow,
  reader: Cdb64Reader,
  stats: Stats,
  config: Config,
): Promise<void> {
  const { id, expectedRootTxId } = row;

  try {
    const keyBuffer = fromB64Url(id);
    const valueBuffer = await reader.get(keyBuffer);

    if (valueBuffer) {
      // Decode and verify the value has a valid root TX ID
      const decoded = decodeCdb64Value(valueBuffer);
      const rootTxId = getRootTxId(decoded);
      if (rootTxId && rootTxId.length === 32) {
        // If comparing values, check against expected root TX ID
        if (config.compareValues && expectedRootTxId) {
          const actualRootTxId = toB64Url(rootTxId);
          if (actualRootTxId === expectedRootTxId) {
            stats.found++;
          } else {
            stats.mismatched++;
            if (config.verbose) {
              stats.mismatchedIds.push(
                `${id}: expected ${expectedRootTxId}, got ${actualRootTxId}`,
              );
            }
          }
        } else {
          stats.found++;
        }
      } else {
        stats.notFound++;
        if (config.verbose) {
          stats.missingIds.push(`${id} (invalid value)`);
        }
      }
    } else {
      stats.notFound++;
      if (config.verbose) {
        stats.missingIds.push(id);
      }
    }
  } catch {
    stats.errors++;
    if (config.verbose) {
      stats.missingIds.push(`${id} (error)`);
    }
  }
}

/**
 * Report progress to console or stderr.
 */
function reportProgress(stats: Stats, config: Config): void {
  const progressInterval = 100000; // Report every 100k IDs
  if (stats.totalChecked % progressInterval === 0) {
    const elapsed = (performance.now() - stats.startTime) / 1000;
    const rate = Math.round(stats.totalChecked / elapsed);
    const message = `[Progress: ${stats.totalChecked.toLocaleString()} checked | ${rate.toLocaleString()} IDs/sec]`;

    if (config.jsonOutput) {
      console.error(message);
    } else {
      console.log(message);
    }
  }
}

/**
 * Main verification function.
 */
async function verify(config: Config): Promise<Stats> {
  const stats: Stats = {
    totalChecked: 0,
    found: 0,
    notFound: 0,
    mismatched: 0,
    errors: 0,
    missingIds: [],
    mismatchedIds: [],
    startTime: performance.now(),
    endTime: 0,
  };

  const reader = new Cdb64Reader(config.cdb64Path);
  await reader.open();

  try {
    if (config.mode === 'random') {
      // Random mode: sample random rows from the CSV file
      const fileSize = getFileSize(config.csvPath);
      const count = config.count ?? 1000; // Default to 1000 for random mode

      for (let i = 0; i < count; i++) {
        const row = getRandomRow(config.csvPath, fileSize);
        stats.totalChecked++;
        await checkRow(row, reader, stats, config);
        reportProgress(stats, config);
      }
    } else {
      // Sequential mode: stream through the file
      for await (const row of streamCsvRowsSequential(
        config.csvPath,
        config.skipHeader,
        config.count,
      )) {
        stats.totalChecked++;
        await checkRow(row, reader, stats, config);
        reportProgress(stats, config);
      }
    }
  } finally {
    await reader.close();
  }

  stats.endTime = performance.now();
  return stats;
}

/**
 * Display console results.
 */
function displayConsoleResults(config: Config, stats: Stats): void {
  const duration = stats.endTime - stats.startTime;
  const foundRate =
    stats.totalChecked > 0
      ? ((stats.found / stats.totalChecked) * 100).toFixed(2)
      : '0.00';

  // Build mode string
  let modeStr: string = config.mode;
  if (config.mode === 'random') {
    const sampleSize = config.count ?? 1000;
    modeStr = `random (${sampleSize.toLocaleString()} samples)`;
  } else if (config.count !== undefined) {
    modeStr = `sequential (first ${config.count.toLocaleString()})`;
  }

  console.log('\n=== CDB64 Verification Results ===');
  console.log(`CDB64 File: ${config.cdb64Path}`);
  console.log(`CSV File: ${config.csvPath}`);
  console.log(`Mode: ${modeStr}`);
  if (config.compareValues) {
    console.log('Value Comparison: enabled');
  }
  console.log(`Duration: ${formatDuration(duration)}`);

  console.log('\nResults:');
  console.log(`  Total Checked: ${stats.totalChecked.toLocaleString()}`);
  console.log(`  Found:         ${stats.found.toLocaleString()} (${foundRate}%)`);
  console.log(`  Not Found:     ${stats.notFound.toLocaleString()}`);
  if (stats.mismatched > 0) {
    console.log(`  Mismatched:    ${stats.mismatched.toLocaleString()}`);
  }
  if (stats.errors > 0) {
    console.log(`  Errors:        ${stats.errors.toLocaleString()}`);
  }

  // Display missing IDs if verbose and there are any
  if (config.verbose && stats.missingIds.length > 0) {
    console.log('\nMissing IDs:');
    for (const id of stats.missingIds) {
      console.log(`  ${id}`);
    }
  }

  // Display mismatched IDs if verbose and there are any
  if (config.verbose && stats.mismatchedIds.length > 0) {
    console.log('\nMismatched Values:');
    for (const entry of stats.mismatchedIds) {
      console.log(`  ${entry}`);
    }
  }
}

/**
 * Display JSON results.
 */
function displayJsonResults(config: Config, stats: Stats): void {
  const duration = stats.endTime - stats.startTime;
  const foundRate =
    stats.totalChecked > 0
      ? parseFloat(((stats.found / stats.totalChecked) * 100).toFixed(2))
      : 0;

  const result = {
    cdb64File: config.cdb64Path,
    csvFile: config.csvPath,
    mode: config.mode,
    compareValues: config.compareValues,
    ...(config.mode === 'random'
      ? { sampleSize: config.count ?? 1000 }
      : config.count !== undefined
        ? { count: config.count }
        : {}),
    durationMs: Math.round(duration),
    totalChecked: stats.totalChecked,
    found: stats.found,
    notFound: stats.notFound,
    mismatched: stats.mismatched,
    errors: stats.errors,
    foundRate,
    ...(config.verbose && stats.missingIds.length > 0
      ? { missingIds: stats.missingIds }
      : {}),
    ...(config.verbose && stats.mismatchedIds.length > 0
      ? { mismatchedIds: stats.mismatchedIds }
      : {}),
  };

  console.log(JSON.stringify(result, null, 2));
}

/**
 * Parse command-line arguments.
 */
function parseArguments(): Config {
  const args = process.argv.slice(2);
  const config: Config = {
    cdb64Path: '',
    csvPath: '',
    skipHeader: false,
    verbose: false,
    jsonOutput: false,
    mode: 'sequential',
    count: undefined,
    compareValues: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case '--cdb64':
        if (!nextArg) {
          throw new Error('--cdb64 requires a file path');
        }
        config.cdb64Path = nextArg;
        i++;
        break;

      case '--csv':
        if (!nextArg) {
          throw new Error('--csv requires a file path');
        }
        config.csvPath = nextArg;
        i++;
        break;

      case '--mode':
        if (!nextArg || !['random', 'sequential'].includes(nextArg)) {
          throw new Error("--mode requires 'random' or 'sequential'");
        }
        config.mode = nextArg as 'random' | 'sequential';
        i++;
        break;

      case '--count':
        if (!nextArg || isNaN(parseInt(nextArg))) {
          throw new Error('--count requires a number');
        }
        config.count = parseInt(nextArg);
        i++;
        break;

      case '--skip-header':
        config.skipHeader = true;
        break;

      case '--compare-values':
        config.compareValues = true;
        break;

      case '--verbose':
        config.verbose = true;
        break;

      case '--json':
        config.jsonOutput = true;
        break;

      case '--help':
      case '-h':
        printUsage();
        process.exit(0);

      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  // Validate required arguments
  if (!config.cdb64Path) {
    throw new Error('--cdb64 is required');
  }

  if (!config.csvPath) {
    throw new Error('--csv is required');
  }

  // Validate file existence
  if (!fs.existsSync(config.cdb64Path)) {
    throw new Error(`CDB64 file not found: ${config.cdb64Path}`);
  }

  if (!fs.existsSync(config.csvPath)) {
    throw new Error(`CSV file not found: ${config.csvPath}`);
  }

  return config;
}

/**
 * Print usage information.
 */
function printUsage(): void {
  console.log(`
CDB64 Verification Tool

Verifies that IDs from a CSV file exist in a CDB64 index file.

Usage: ./tools/verify-cdb64 --cdb64 <file> --csv <file> [options]

Options:
  --cdb64 <file>       CDB64 file to verify against (required)
  --csv <file>         CSV file with IDs in first column (required)
  --compare-values     Compare root TX IDs against second column in CSV
  --mode <mode>        Sampling mode: 'random' or 'sequential' (default: sequential)
  --count <n>          Number of IDs to check (default: all for sequential, 1000 for random)
  --skip-header        Skip the first row of CSV (if it's a header)
  --verbose            Show each missing/mismatched ID
  --json               Output results as JSON
  --help, -h           Show this help message

Sampling Modes:
  sequential           Read IDs in order from start of file
  random               Sample random IDs by seeking to random file positions

Value Comparison:
  When --compare-values is specified, the tool compares the root TX ID stored
  in the CDB64 file against the expected value in the second column of the CSV.
  CSV format: data_item_id,root_tx_id,...

Examples:
  # Basic verification (sequential, all IDs)
  ./tools/verify-cdb64 --cdb64 root-tx-index.cdb --csv ids.csv

  # Verify values match CSV (existence + value comparison)
  ./tools/verify-cdb64 --cdb64 root-tx-index.cdb --csv ids.csv --compare-values --skip-header

  # Sequential mode - check first 1000
  ./tools/verify-cdb64 --cdb64 root-tx-index.cdb --csv ids.csv --count 1000

  # Random mode - sample 1000 random IDs (default)
  ./tools/verify-cdb64 --cdb64 root-tx-index.cdb --csv ids.csv --mode random

  # Random mode - sample 500 random IDs
  ./tools/verify-cdb64 --cdb64 root-tx-index.cdb --csv ids.csv --mode random --count 500

  # Skip CSV header row
  ./tools/verify-cdb64 --cdb64 root-tx-index.cdb --csv ids.csv --skip-header

  # Show missing/mismatched IDs
  ./tools/verify-cdb64 --cdb64 root-tx-index.cdb --csv ids.csv --verbose

  # JSON output with sampling
  ./tools/verify-cdb64 --cdb64 root-tx-index.cdb --csv ids.csv --mode random --count 500 --json
`);
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  try {
    const config = parseArguments();

    if (!config.jsonOutput) {
      console.log(`Verifying CDB64: ${config.cdb64Path}`);
      console.log(`Against CSV: ${config.csvPath}`);
      // Build mode string for initial output
      let modeStr: string = config.mode;
      if (config.mode === 'random') {
        const sampleSize = config.count ?? 1000;
        modeStr = `random (${sampleSize.toLocaleString()} samples)`;
      } else if (config.count !== undefined) {
        modeStr = `sequential (first ${config.count.toLocaleString()})`;
      }
      console.log(`Mode: ${modeStr}`);
      if (config.skipHeader) {
        console.log('Skipping header row');
      }
      console.log('');
    }

    const stats = await verify(config);

    if (config.jsonOutput) {
      displayJsonResults(config, stats);
    } else {
      displayConsoleResults(config, stats);
    }

    // Exit with error code if any IDs were not found or mismatched
    if (stats.notFound > 0 || stats.mismatched > 0 || stats.errors > 0) {
      process.exit(1);
    }
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    console.log('\nUse --help for usage information');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
