/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Partitioned CDB64 Writer - Creates prefix-partitioned CDB64 indexes.
 *
 * This writer splits records across up to 256 separate CDB64 files based on
 * the first byte of the 32-byte key. Each partition file is named using the
 * hex prefix (00.cdb - ff.cdb).
 *
 * ## Output Structure
 * ```
 * output-dir/
 *   manifest.json    # Index manifest with partition metadata
 *   00.cdb           # Records with keys starting 0x00
 *   01.cdb           # Records with keys starting 0x01
 *   ...
 *   ff.cdb           # Records with keys starting 0xff
 * ```
 *
 * ## Usage
 * ```typescript
 * const writer = new PartitionedCdb64Writer('/path/to/output-dir');
 * await writer.open();
 * await writer.add(key1, value1);  // Routes to partition based on key[0]
 * await writer.add(key2, value2);
 * const manifest = await writer.finalize();  // Returns manifest
 * ```
 *
 * ## Features
 * - Lazy partition creation: only creates files for partitions that receive records
 * - Atomic directory creation: writes to temp dir, then renames atomically
 * - Generates manifest.json with partition metadata
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Cdb64Writer } from './cdb64.js';
import {
  Cdb64Manifest,
  PartitionInfo,
  indexToPrefix,
  serializeManifest,
} from './cdb64-manifest.js';

/**
 * Tracks metadata for a partition during writing.
 */
interface PartitionState {
  writer: Cdb64Writer;
  prefix: string;
  recordCount: number;
}

/**
 * Options for creating a PartitionedCdb64Writer.
 */
export interface PartitionedCdb64WriterOptions {
  /** Optional metadata to include in the manifest */
  metadata?: Record<string, unknown>;
}

/**
 * Partitioned CDB64 Writer - Creates prefix-partitioned CDB64 indexes.
 */
export class PartitionedCdb64Writer {
  private outputDir: string;
  private tempDir: string;
  private partitions: (PartitionState | null)[] = new Array(256).fill(null);
  private opened = false;
  private finalized = false;
  private metadata?: Record<string, unknown>;

  /**
   * Creates a new partitioned writer.
   *
   * @param outputDir - Directory where the partitioned index will be created
   * @param options - Optional configuration
   */
  constructor(outputDir: string, options?: PartitionedCdb64WriterOptions) {
    this.outputDir = outputDir;
    // Temp dir in same parent for atomic rename across filesystems
    this.tempDir = `${outputDir}.tmp.${process.pid}`;
    this.metadata = options?.metadata;
  }

  /**
   * Opens the writer and prepares for adding records.
   * Creates a temporary directory for writing.
   */
  async open(): Promise<void> {
    if (this.finalized) {
      throw new Error('Cannot reopen a finalized writer');
    }
    if (this.opened) {
      throw new Error('Writer already opened');
    }

    // Ensure parent directory exists
    const parentDir = path.dirname(this.outputDir);
    await fs.mkdir(parentDir, { recursive: true });

    // Create temp directory
    await fs.mkdir(this.tempDir, { recursive: true });

    this.opened = true;
  }

  /**
   * Adds a key-value pair to the appropriate partition.
   * The partition is determined by the first byte of the key.
   *
   * @param key - The key (must be at least 1 byte)
   * @param value - The value
   */
  async add(key: Buffer, value: Buffer): Promise<void> {
    if (!this.opened) {
      throw new Error('Writer not opened. Call open() first.');
    }
    if (this.finalized) {
      throw new Error('Cannot add records after finalization');
    }
    if (key.length === 0) {
      throw new Error('Key must be at least 1 byte');
    }

    const partitionIndex = key[0];

    // Lazy creation of partition writer
    if (this.partitions[partitionIndex] === null) {
      const prefix = indexToPrefix(partitionIndex);
      const partitionPath = path.join(this.tempDir, `${prefix}.cdb`);
      const writer = new Cdb64Writer(partitionPath);
      await writer.open();

      this.partitions[partitionIndex] = {
        writer,
        prefix,
        recordCount: 0,
      };
    }

    const partition = this.partitions[partitionIndex]!;
    await partition.writer.add(key, value);
    partition.recordCount++;
  }

  /**
   * Finalizes the index by writing all partitions and the manifest.
   * Performs an atomic directory rename to the output location.
   *
   * @returns The generated manifest
   */
  async finalize(): Promise<Cdb64Manifest> {
    if (!this.opened) {
      throw new Error('Writer not opened. Call open() first.');
    }
    if (this.finalized) {
      throw new Error('Already finalized');
    }

    this.finalized = true;

    // Finalize all open partition writers
    const partitionInfos: PartitionInfo[] = [];
    let totalRecords = 0;

    for (let i = 0; i < 256; i++) {
      const partition = this.partitions[i];
      if (partition !== null) {
        await partition.writer.finalize();

        // Get file size after finalization
        const filePath = path.join(this.tempDir, `${partition.prefix}.cdb`);
        const stats = await fs.stat(filePath);

        partitionInfos.push({
          prefix: partition.prefix,
          location: {
            type: 'file',
            filename: `${partition.prefix}.cdb`,
          },
          recordCount: partition.recordCount,
          size: stats.size,
        });

        totalRecords += partition.recordCount;
      }
    }

    // Sort partitions by prefix for consistent ordering
    partitionInfos.sort((a, b) => a.prefix.localeCompare(b.prefix));

    // Create manifest
    const manifest: Cdb64Manifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      totalRecords,
      partitions: partitionInfos,
    };

    if (this.metadata !== undefined) {
      manifest.metadata = this.metadata;
    }

    // Write manifest to temp directory
    const manifestPath = path.join(this.tempDir, 'manifest.json');
    await fs.writeFile(manifestPath, serializeManifest(manifest), 'utf-8');

    // Atomic rename of temp directory to final location
    // First, remove existing output directory if it exists
    try {
      await fs.rm(this.outputDir, { recursive: true, force: true });
    } catch {
      // Ignore if doesn't exist
    }

    await fs.rename(this.tempDir, this.outputDir);

    return manifest;
  }

  /**
   * Aborts the writer and cleans up temporary files.
   */
  async abort(): Promise<void> {
    // Abort all open partition writers
    const abortPromises: Promise<void>[] = [];
    for (const partition of this.partitions) {
      if (partition !== null) {
        abortPromises.push(partition.writer.abort());
      }
    }

    // Wait for all abort operations
    await Promise.allSettled(abortPromises);

    // Clean up temp directory
    try {
      await fs.rm(this.tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }

    this.opened = false;
    this.finalized = true;
  }

  /**
   * Returns the current state of all partitions.
   * Useful for progress reporting during writing.
   */
  getPartitionStats(): { prefix: string; recordCount: number }[] {
    const stats: { prefix: string; recordCount: number }[] = [];

    for (let i = 0; i < 256; i++) {
      const partition = this.partitions[i];
      if (partition !== null) {
        stats.push({
          prefix: partition.prefix,
          recordCount: partition.recordCount,
        });
      }
    }

    return stats;
  }

  /**
   * Returns the total number of records added so far.
   */
  getTotalRecordCount(): number {
    return this.partitions
      .filter((p): p is PartitionState => p !== null)
      .reduce((sum, p) => sum + p.recordCount, 0);
  }

  /**
   * Returns the number of partitions created so far.
   */
  getPartitionCount(): number {
    return this.partitions.filter((p) => p !== null).length;
  }

  /**
   * Checks if the writer is currently open.
   */
  isOpen(): boolean {
    return this.opened && !this.finalized;
  }

  /**
   * Returns the output directory path.
   */
  getOutputDir(): string {
    return this.outputDir;
  }
}
