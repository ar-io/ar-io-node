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
import { fromB64Url } from '../../src/lib/encoding.js';

interface Config {
  cdb64Path: string;
  csvPath: string;
  skipHeader: boolean;
  verbose: boolean;
  jsonOutput: boolean;
}

interface Stats {
  totalChecked: number;
  found: number;
  notFound: number;
  errors: number;
  missingIds: string[];
  startTime: number;
  endTime: number;
}

// Valid base64url TX/data item ID pattern (43 characters)
const ID_PATTERN = /^[a-zA-Z0-9_-]{43}$/;

/**
 * Parse a CSV line and extract the ID from the first column.
 */
function parseLineForId(line: string): string | null {
  const trimmedLine = line.trim();
  if (trimmedLine.length === 0) return null;

  // Handle CSV: take first column (split by comma)
  const firstColumn = trimmedLine.split(',')[0].trim();
  // Remove quotes if present
  const id = firstColumn.replace(/^["']|["']$/g, '');

  if (ID_PATTERN.test(id)) {
    return id;
  }
  return null;
}

/**
 * Stream IDs from CSV file, yielding them one at a time.
 */
async function* streamCsvIds(
  csvPath: string,
  skipHeader: boolean,
): AsyncGenerator<string> {
  const stream = fs.createReadStream(csvPath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lineNumber = 0;

  for await (const line of rl) {
    lineNumber++;

    // Skip header if configured
    if (skipHeader && lineNumber === 1) {
      continue;
    }

    const id = parseLineForId(line);
    if (id) {
      yield id;
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
 * Main verification function.
 */
async function verify(config: Config): Promise<Stats> {
  const stats: Stats = {
    totalChecked: 0,
    found: 0,
    notFound: 0,
    errors: 0,
    missingIds: [],
    startTime: performance.now(),
    endTime: 0,
  };

  const reader = new Cdb64Reader(config.cdb64Path);
  await reader.open();

  const progressInterval = 100000; // Report every 100k IDs

  try {
    for await (const id of streamCsvIds(config.csvPath, config.skipHeader)) {
      stats.totalChecked++;

      try {
        const keyBuffer = fromB64Url(id);
        const result = await reader.get(keyBuffer);

        if (result) {
          stats.found++;
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

      // Progress reporting (to stderr if JSON output)
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

  console.log('\n=== CDB64 Verification Results ===');
  console.log(`CDB64 File: ${config.cdb64Path}`);
  console.log(`CSV File: ${config.csvPath}`);
  console.log(`Duration: ${formatDuration(duration)}`);

  console.log('\nResults:');
  console.log(`  Total Checked: ${stats.totalChecked.toLocaleString()}`);
  console.log(`  Found:         ${stats.found.toLocaleString()} (${foundRate}%)`);
  console.log(`  Not Found:     ${stats.notFound.toLocaleString()}`);
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
    durationMs: Math.round(duration),
    totalChecked: stats.totalChecked,
    found: stats.found,
    notFound: stats.notFound,
    errors: stats.errors,
    foundRate,
    ...(config.verbose && stats.missingIds.length > 0
      ? { missingIds: stats.missingIds }
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

      case '--skip-header':
        config.skipHeader = true;
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

Verifies that all IDs from a CSV file exist in a CDB64 index file.

Usage: ./tools/verify-cdb64 --cdb64 <file> --csv <file> [options]

Options:
  --cdb64 <file>       CDB64 file to verify against (required)
  --csv <file>         CSV file with IDs in first column (required)
  --skip-header        Skip the first row of CSV (if it's a header)
  --verbose            Show each missing ID
  --json               Output results as JSON
  --help, -h           Show this help message

Examples:
  # Basic verification
  ./tools/verify-cdb64 --cdb64 root-tx-index.cdb --csv ids.csv

  # Skip CSV header row
  ./tools/verify-cdb64 --cdb64 root-tx-index.cdb --csv ids.csv --skip-header

  # Show missing IDs
  ./tools/verify-cdb64 --cdb64 root-tx-index.cdb --csv ids.csv --verbose

  # JSON output
  ./tools/verify-cdb64 --cdb64 root-tx-index.cdb --csv ids.csv --json

  # Full verification with verbose JSON
  ./tools/verify-cdb64 --cdb64 root-tx-index.cdb --csv ids.csv --verbose --json
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

    // Exit with error code if any IDs were not found
    if (stats.notFound > 0 || stats.errors > 0) {
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
