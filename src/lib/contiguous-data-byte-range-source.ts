/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Readable } from 'node:stream';
import { ByteRangeSource } from './byte-range-source.js';
import { ContiguousDataSource } from '../types.js';

/**
 * Collects a readable stream into a single Buffer.
 */
async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * ByteRangeSource implementation for Arweave data via ContiguousDataSource.
 *
 * Fetches byte ranges using the existing ContiguousDataSource infrastructure,
 * which handles multi-source fallback, caching, and verification.
 *
 * Supports optional base offset for accessing data items within bundles,
 * enabling the "txId:offset:size" addressing format for unindexed bundle items.
 */
export class ContiguousDataByteRangeSource implements ByteRangeSource {
  private dataSource: ContiguousDataSource;
  private id: string;
  private baseOffset: number;
  private totalSize?: number;
  private opened = true;

  /**
   * Creates a ContiguousDataByteRangeSource.
   *
   * @param dataSource - The ContiguousDataSource to fetch data from
   * @param id - Transaction ID or data item ID
   * @param baseOffset - Byte offset within the TX where the CDB64 data starts (default: 0)
   *                     Use this for addressing data items within bundles
   * @param totalSize - Total size of the CDB64 data (optional, for bounds checking)
   */
  constructor({
    dataSource,
    id,
    baseOffset = 0,
    totalSize,
  }: {
    dataSource: ContiguousDataSource;
    id: string;
    baseOffset?: number;
    totalSize?: number;
  }) {
    this.dataSource = dataSource;
    this.id = id;
    this.baseOffset = baseOffset;
    this.totalSize = totalSize;
  }

  async read(offset: number, size: number): Promise<Buffer> {
    // Bounds checking if total size is known
    if (this.totalSize !== undefined && offset + size > this.totalSize) {
      throw new Error(
        `Read beyond data bounds: offset=${offset}, size=${size}, totalSize=${this.totalSize}`,
      );
    }

    // Translate to absolute offset within the transaction/bundle
    const absoluteOffset = this.baseOffset + offset;

    const data = await this.dataSource.getData({
      id: this.id,
      region: {
        offset: absoluteOffset,
        size,
      },
    });

    // Convert stream to buffer
    const buffer = await streamToBuffer(data.stream);

    if (buffer.length !== size) {
      throw new Error(
        `ContiguousData short read: expected ${size} bytes, got ${buffer.length}`,
      );
    }

    return buffer;
  }

  async close(): Promise<void> {
    this.opened = false;
  }

  isOpen(): boolean {
    return this.opened;
  }

  /**
   * Returns the transaction/data item ID this source reads from.
   */
  getId(): string {
    return this.id;
  }

  /**
   * Returns the base offset within the transaction.
   */
  getBaseOffset(): number {
    return this.baseOffset;
  }

  /**
   * Returns the total size if known.
   */
  getTotalSize(): number | undefined {
    return this.totalSize;
  }
}
