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

import { parse } from 'csv-parse';
import { CdbWriter } from 'cdb64/node/index.js';

import {
  encodeCdb64Value,
  Cdb64RootTxValue,
} from '../../src/lib/cdb64-encoding.js';
import { PartitionedCdb64Writer } from '../../src/lib/partitioned-cdb64-writer.js';

import {
  Config,
  ProcessingStats,
  createStats,
  parseArgs,
  printUsage,
  looksLikeHeader,
  parseBase64UrlId,
  parseOffset,
  parsePath,
  printGenerationSummary,
  printProgress,
  printPartitionDistribution,
} from './cdb64-generation-utils.js';

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

  const stats: ProcessingStats = createStats();
  let headerSkipped = false;

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
      stats.recordNumber++;

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
          parts.length >= 3 ? parsePath(parts[2], stats.recordNumber) : undefined;

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
            stats.pathCompleteCount++;
          } else {
            value = { path };
            stats.pathCount++;
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
            stats.completeCount++;
          } else {
            value = { rootTxId };
            stats.simpleCount++;
          }
        }

        // Rust writer uses synchronous put()
        writer.put(dataItemId, encodeCdb64Value(value));
        stats.recordCount++;

        // Progress indicator
        if (stats.recordCount % 100000 === 0) {
          printProgress(stats.recordCount, stats.startTime);
        }
      } catch (error: any) {
        stats.errorCount++;
        console.error(`Error on record ${stats.recordNumber}: ${error.message}`);

        // Stop on too many errors
        if (stats.errorCount > 100) {
          throw new Error('Too many errors, aborting');
        }
      }
    }

    // Finalize the CDB file (synchronous)
    writer.finalize();

    // Atomic rename from temp to final path
    fs.renameSync(tempPath, config.outputPath);

    // Print summary
    const fileStats = fs.statSync(config.outputPath);
    printGenerationSummary(stats, config.outputPath, undefined, fileStats.size);
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

  const stats: ProcessingStats = createStats();
  let headerSkipped = false;

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
      stats.recordNumber++;

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
          parts.length >= 3 ? parsePath(parts[2], stats.recordNumber) : undefined;

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
            stats.pathCompleteCount++;
          } else {
            value = { path: pathValue };
            stats.pathCount++;
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
            stats.completeCount++;
          } else {
            value = { rootTxId };
            stats.simpleCount++;
          }
        }

        await writer.add(dataItemId, encodeCdb64Value(value));
        stats.recordCount++;

        if (stats.recordCount % 100000 === 0) {
          const partitionStats = writer.getPartitionStats();
          printProgress(stats.recordCount, stats.startTime, partitionStats.length);
        }
      } catch (error: any) {
        stats.errorCount++;
        console.error(`Error on record ${stats.recordNumber}: ${error.message}`);

        if (stats.errorCount > 100) {
          throw new Error('Too many errors, aborting');
        }
      }
    }

    const manifest = await writer.finalize();

    const totalSize = manifest.partitions.reduce((sum, p) => sum + p.size, 0);
    printGenerationSummary(stats, config.outputPath, {
      count: manifest.partitions.length,
      totalSize,
    });
    printPartitionDistribution(manifest.partitions);
  } catch (error) {
    await writer.abort();
    throw error;
  }
}

async function main(): Promise<void> {
  try {
    const config = parseArgs();
    if (config === null) {
      printUsage(
        './tools/generate-cdb64-root-tx-index-rs',
        ' (Rust)\n\nUses the Rust-backed cdb64 library for improved single-file performance.',
      );
      process.exit(0);
    }

    await generateIndex(config);
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
