/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * CLI tool to export root TX mappings from SQLite (data.db) to CDB64 format.
 *
 * This tool reads from the contiguous_data_ids table in data.db and writes
 * directly to a CDB64 file, producing complete format values with offsets
 * when available.
 *
 * NOTE: It is recommended to stop the ar-io-node service before running
 * this tool to ensure data consistency during the export.
 *
 * Usage:
 *   ./tools/export-sqlite-to-cdb64 --output index.cdb
 *   ./tools/export-sqlite-to-cdb64 --data-db /path/to/data.db --output index.cdb
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import Sqlite, { Database } from 'better-sqlite3';

import { Cdb64Writer } from '../../src/lib/cdb64.js';
import { PartitionedCdb64Writer } from '../../src/lib/partitioned-cdb64-writer.js';
import { encodeCdb64Value } from '../../src/lib/cdb64-encoding.js';

interface Config {
  dataDbPath: string;
  outputPath: string;
  outputDir?: string;
  partitioned: boolean;
}

interface DataRow {
  id: Buffer;
  root_transaction_id: Buffer;
  root_data_item_offset: number | null;
  root_data_offset: number | null;
}

function printUsage(): void {
  console.log(`
Export SQLite to CDB64

This tool exports root TX mappings from the local data.db SQLite database
directly to CDB64 format.

NOTE: It is recommended to stop the ar-io-node service before running
this tool to ensure data consistency during the export.

Usage: ./tools/export-sqlite-to-cdb64 [options]

Options:
  --data-db <path>     Path to data.db file (default: ./data/sqlite/data.db)
  --output <path>      Output CDB64 file path (single file mode, required unless --partitioned)
  --partitioned        Enable partitioned output (splits by key prefix into 00.cdb-ff.cdb)
  --output-dir <path>  Output directory for partitioned index (required with --partitioned)
  --help               Show this help message

Example:
  # Single file output
  ./tools/export-sqlite-to-cdb64 --output root-tx-index.cdb

  # Partitioned output
  ./tools/export-sqlite-to-cdb64 --partitioned --output-dir ./root-tx-index/
`);
}

function parseArgs(): Config | null {
  const args = process.argv.slice(2);
  let dataDbPath = './data/sqlite/data.db';
  let outputPath: string | undefined;
  let outputDir: string | undefined;
  let partitioned = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case '--data-db':
        if (!nextArg) throw new Error('--data-db requires a path');
        dataDbPath = path.resolve(nextArg);
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
      case '--help':
      case '-h':
        printUsage();
        return null;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
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

  return { dataDbPath, outputPath, outputDir, partitioned };
}

async function exportToCdb64(config: Config): Promise<void> {
  console.log('=== SQLite to CDB64 Exporter ===\n');
  console.log(`Database: ${config.dataDbPath}`);
  console.log(`Output:   ${config.outputPath}`);
  if (config.partitioned) {
    console.log('Mode:     Partitioned (prefix-based sharding)');
  }
  console.log('');

  // Check if data.db exists
  if (!fs.existsSync(config.dataDbPath)) {
    throw new Error(`Database not found: ${config.dataDbPath}`);
  }

  // Open database in read-only mode
  const db: Database = new Sqlite(config.dataDbPath, { readonly: true });

  try {
    // Prepare the query
    const query = db.prepare(`
      SELECT id, root_transaction_id, root_data_item_offset, root_data_offset
      FROM contiguous_data_ids
      WHERE root_transaction_id IS NOT NULL
    `);

    // Count total rows for progress reporting
    const countResult = db.prepare(`
      SELECT COUNT(*) as count
      FROM contiguous_data_ids
      WHERE root_transaction_id IS NOT NULL
    `).get() as { count: number };
    const totalRows = countResult.count;

    console.log(`Total records to export: ${totalRows.toLocaleString()}`);
    console.log('');

    if (totalRows === 0) {
      console.log('No records to export.');
      return;
    }

    // Create appropriate writer
    let writer: Cdb64Writer | PartitionedCdb64Writer;
    if (config.partitioned) {
      if (!config.outputDir) {
        throw new Error('outputDir is required when partitioned mode is enabled');
      }
      writer = new PartitionedCdb64Writer(config.outputDir);
    } else {
      writer = new Cdb64Writer(config.outputPath);
    }
    await writer.open();

    let recordCount = 0;
    let simpleCount = 0;
    let completeCount = 0;
    let skippedCount = 0;

    try {
      // Iterate through all rows
      for (const row of query.iterate() as IterableIterator<DataRow>) {
        // Validate that id is a 32-byte Buffer (required for proper CDB64 lookup semantics)
        if (!Buffer.isBuffer(row.id) || row.id.length !== 32) {
          skippedCount++;
          continue;
        }

        // Validate that root_transaction_id is a 32-byte Buffer
        if (
          !Buffer.isBuffer(row.root_transaction_id) ||
          row.root_transaction_id.length !== 32
        ) {
          skippedCount++;
          continue;
        }

        // Check for partial offsets (data inconsistency - only one offset present)
        const hasPartialOffsets =
          (row.root_data_item_offset === null) !==
          (row.root_data_offset === null);
        if (hasPartialOffsets) {
          // Data inconsistency: skip rather than silently downgrade to simple format
          skippedCount++;
          continue;
        }

        const hasOffsets =
          row.root_data_item_offset !== null && row.root_data_offset !== null;

        // Encode value based on available data
        let encodedValue: Buffer;
        if (hasOffsets) {
          encodedValue = encodeCdb64Value({
            rootTxId: row.root_transaction_id,
            rootDataItemOffset: row.root_data_item_offset!,
            rootDataOffset: row.root_data_offset!,
          });
          completeCount++;
        } else {
          encodedValue = encodeCdb64Value({
            rootTxId: row.root_transaction_id,
          });
          simpleCount++;
        }

        // Write to CDB64
        await writer.add(row.id, encodedValue);
        recordCount++;

        // Progress indicator
        if (recordCount % 100000 === 0) {
          const percent = ((recordCount / totalRows) * 100).toFixed(1);
          console.log(
            `Exported ${recordCount.toLocaleString()} / ${totalRows.toLocaleString()} records (${percent}%)...`,
          );
        }
      }

      const manifest = await writer.finalize();

      console.log('\n=== Export Complete ===');
      console.log(`Records exported: ${recordCount.toLocaleString()}`);
      console.log(`  - Simple format: ${simpleCount.toLocaleString()}`);
      console.log(`  - Complete format: ${completeCount.toLocaleString()}`);
      if (skippedCount > 0) {
        console.log(
          `Records skipped (invalid): ${skippedCount.toLocaleString()}`,
        );
      }
      console.log(`Output: ${config.outputPath}`);

      // Show partition stats for partitioned mode
      if (config.partitioned && manifest) {
        console.log(`Partitions: ${manifest.partitions.length}`);
        const totalSize = manifest.partitions.reduce(
          (sum, p) => sum + p.size,
          0,
        );
        const sizeMB = (totalSize / 1024 / 1024).toFixed(2);
        console.log(`Total size: ${sizeMB} MB`);
      } else {
        // Show file size for single-file mode
        const stats = fs.statSync(config.outputPath);
        const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
        console.log(`File size: ${sizeMB} MB`);
      }
    } catch (error) {
      await writer.abort();
      throw error;
    }
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  try {
    const config = parseArgs();
    if (config === null) {
      process.exit(0);
    }

    await exportToCdb64(config);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

main();
