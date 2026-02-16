/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Streaming Partitioned CDB64 Writer - Two-phase writer that minimizes memory.
 *
 * Phase 1 (Scatter): During add() calls, records are appended to per-partition
 * temp files using a simple length-prefixed format. No CDB writers open, no
 * hash tables in memory.
 *
 * Phase 2 (Build): During finalize(), each partition is built sequentially --
 * one Rust CdbWriter at a time, reading from the scatter file, writing the CDB,
 * then releasing memory and deleting the scatter file before moving on.
 *
 * Peak memory: O(largest_partition) instead of O(total_records).
 *
 * ## Output Structure
 * ```
 * output-dir/
 *   manifest.json    # Index manifest with partition metadata
 *   00.cdb           # Records with keys starting 0x00
 *   ...
 *   ff.cdb           # Records with keys starting 0xff
 * ```
 */

import * as fs from 'node:fs/promises';
import { createWriteStream, WriteStream } from 'node:fs';
import * as path from 'node:path';
import { CdbWriter } from 'cdb64/node/index.js';
import {
  Cdb64Manifest,
  PartitionInfo,
  indexToPrefix,
  serializeManifest,
} from './cdb64-manifest.js';

interface ScatterPartitionState {
  stream: WriteStream;
  recordCount: number;
  filePath: string;
}

export interface StreamingPartitionedCdb64WriterOptions {
  metadata?: Record<string, unknown>;
  onBuildProgress?: (
    partitionIndex: number,
    prefix: string,
    phase: 'start' | 'done',
  ) => void;
}

export class StreamingPartitionedCdb64Writer {
  private outputDir: string;
  private tempDir: string;
  private scatterDir: string;
  private partitions: (ScatterPartitionState | null)[] = new Array(256).fill(
    null,
  );
  private opened = false;
  private finalized = false;
  private metadata?: Record<string, unknown>;
  private onBuildProgress?: (
    partitionIndex: number,
    prefix: string,
    phase: 'start' | 'done',
  ) => void;

  constructor(
    outputDir: string,
    options?: StreamingPartitionedCdb64WriterOptions,
  ) {
    this.outputDir = outputDir;
    this.tempDir = `${outputDir}.tmp.${process.pid}`;
    this.scatterDir = path.join(this.tempDir, 'scatter');
    this.metadata = options?.metadata;
    this.onBuildProgress = options?.onBuildProgress;
  }

  async open(): Promise<void> {
    if (this.finalized) {
      throw new Error('Cannot reopen a finalized writer');
    }
    if (this.opened) {
      throw new Error('Writer already opened');
    }

    const parentDir = path.dirname(this.outputDir);
    await fs.mkdir(parentDir, { recursive: true });

    await fs.rm(this.tempDir, { recursive: true, force: true });
    await fs.mkdir(this.scatterDir, { recursive: true });

    this.opened = true;
  }

  /**
   * Adds a key-value pair to the appropriate partition's scatter file.
   * The scatter file format per record is:
   *   [key_len: uint32 LE][value_len: uint32 LE][key bytes][value bytes]
   */
  add(key: Buffer, value: Buffer): void {
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

    if (this.partitions[partitionIndex] === null) {
      const prefix = indexToPrefix(partitionIndex);
      const filePath = path.join(this.scatterDir, `${prefix}.scatter`);
      const stream = createWriteStream(filePath);

      this.partitions[partitionIndex] = {
        stream,
        recordCount: 0,
        filePath,
      };
    }

    const partition = this.partitions[partitionIndex]!;

    // Write length-prefixed record: [keyLen u32 LE][valueLen u32 LE][key][value]
    const header = Buffer.allocUnsafe(8);
    header.writeUInt32LE(key.length, 0);
    header.writeUInt32LE(value.length, 4);

    partition.stream.write(header);
    partition.stream.write(key);
    partition.stream.write(value);

    partition.recordCount++;
  }

  async finalize(): Promise<Cdb64Manifest> {
    if (!this.opened) {
      throw new Error('Writer not opened. Call open() first.');
    }
    if (this.finalized) {
      throw new Error('Already finalized');
    }

    // Phase 1 complete: close all scatter write streams
    const closePromises: Promise<void>[] = [];
    for (let i = 0; i < 256; i++) {
      const partition = this.partitions[i];
      if (partition !== null) {
        closePromises.push(
          new Promise<void>((resolve, reject) => {
            partition.stream.end(() => {
              partition.stream.once('error', reject);
              resolve();
            });
          }),
        );
      }
    }
    await Promise.all(closePromises);

    // Phase 2: build each partition sequentially
    const partitionInfos: PartitionInfo[] = [];
    let totalRecords = 0;

    for (let i = 0; i < 256; i++) {
      const partition = this.partitions[i];
      if (partition === null) continue;

      const prefix = indexToPrefix(i);
      this.onBuildProgress?.(i, prefix, 'start');

      const cdbPath = path.join(this.tempDir, `${prefix}.cdb`);
      const writer = new CdbWriter(cdbPath);

      // Read scatter file and put records into CDB writer
      const fileHandle = await fs.open(partition.filePath, 'r');
      try {
        const headerBuf = Buffer.allocUnsafe(8);
        let position = 0;

        for (let r = 0; r < partition.recordCount; r++) {
          // Read header (key_len + value_len)
          const headerResult = await fileHandle.read(headerBuf, 0, 8, position);
          if (headerResult.bytesRead !== 8) {
            throw new Error(
              `Unexpected end of scatter file for partition ${prefix}`,
            );
          }
          position += 8;

          const keyLen = headerBuf.readUInt32LE(0);
          const valueLen = headerBuf.readUInt32LE(4);

          // Read key and value
          const recordBuf = Buffer.allocUnsafe(keyLen + valueLen);
          const dataResult = await fileHandle.read(
            recordBuf,
            0,
            keyLen + valueLen,
            position,
          );
          if (dataResult.bytesRead !== keyLen + valueLen) {
            throw new Error(
              `Unexpected end of scatter file for partition ${prefix}`,
            );
          }
          position += keyLen + valueLen;

          writer.put(recordBuf.subarray(0, keyLen), recordBuf.subarray(keyLen));
        }
      } finally {
        await fileHandle.close();
      }

      // Finalize this partition's CDB
      writer.finalize();

      // Delete scatter file to free disk
      await fs.unlink(partition.filePath);

      const stats = await fs.stat(cdbPath);
      partitionInfos.push({
        prefix,
        location: { type: 'file', filename: `${prefix}.cdb` },
        recordCount: partition.recordCount,
        size: stats.size,
      });

      totalRecords += partition.recordCount;
      this.onBuildProgress?.(i, prefix, 'done');
    }

    // Remove scatter directory
    await fs.rm(this.scatterDir, { recursive: true, force: true });

    partitionInfos.sort((a, b) => a.prefix.localeCompare(b.prefix));

    const manifest: Cdb64Manifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      totalRecords,
      partitions: partitionInfos,
    };

    if (this.metadata !== undefined) {
      manifest.metadata = this.metadata;
    }

    const manifestPath = path.join(this.tempDir, 'manifest.json');
    await fs.writeFile(manifestPath, serializeManifest(manifest), 'utf-8');

    // Atomic rename
    try {
      await fs.rm(this.outputDir, { recursive: true, force: true });
    } catch {
      // Ignore if doesn't exist
    }

    await fs.rename(this.tempDir, this.outputDir);

    this.finalized = true;

    return manifest;
  }

  async abort(): Promise<void> {
    // Destroy any open scatter streams
    for (let i = 0; i < 256; i++) {
      const partition = this.partitions[i];
      if (partition !== null) {
        partition.stream.destroy();
      }
    }

    try {
      await fs.rm(this.tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }

    this.opened = false;
    this.finalized = true;
  }

  getPartitionStats(): { prefix: string; recordCount: number }[] {
    const stats: { prefix: string; recordCount: number }[] = [];

    for (let i = 0; i < 256; i++) {
      const partition = this.partitions[i];
      if (partition !== null) {
        stats.push({
          prefix: indexToPrefix(i),
          recordCount: partition.recordCount,
        });
      }
    }

    return stats;
  }

  getTotalRecordCount(): number {
    return this.partitions
      .filter((p): p is ScatterPartitionState => p !== null)
      .reduce((sum, p) => sum + p.recordCount, 0);
  }

  getPartitionCount(): number {
    return this.partitions.filter((p) => p !== null).length;
  }

  isOpen(): boolean {
    return this.opened && !this.finalized;
  }

  getOutputDir(): string {
    return this.outputDir;
  }
}
