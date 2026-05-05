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
 * Drain a readable stream into a single fixed-size Buffer.
 *
 * Pre-allocates `Buffer.alloc(size)` and copies chunks at running offset.
 * Aborts the stream and throws if the upstream emits more bytes than
 * requested. This avoids the O(N²) `Buffer.concat`-per-chunk shape and
 * removes the slot-8 pinned-accumulator pattern that motivated PE-9081.
 */
async function streamToBuffer(stream: Readable, size: number): Promise<Buffer> {
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(`streamToBuffer: invalid size ${size}`);
  }
  const buffer = Buffer.alloc(size);
  let bytesRead = 0;
  try {
    for await (const rawChunk of stream) {
      const chunk = Buffer.isBuffer(rawChunk)
        ? rawChunk
        : Buffer.from(rawChunk);
      if (bytesRead + chunk.length > size) {
        stream.destroy();
        throw new Error(
          `streamToBuffer: upstream emitted more bytes than requested ` +
            `(requestedSize=${size}, bytesAtOverage=${bytesRead + chunk.length})`,
        );
      }
      chunk.copy(buffer, bytesRead);
      bytesRead += chunk.length;
    }
  } catch (error) {
    if (!stream.destroyed) stream.destroy();
    throw error;
  }
  if (bytesRead !== size) {
    throw new Error(
      `streamToBuffer: short read (requestedSize=${size}, actualSize=${bytesRead})`,
    );
  }
  return buffer;
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

    // Drain to a pre-allocated buffer of exactly `size` bytes, aborting
    // on upstream overage. Replaces the previous Buffer.concat-based
    // accumulator that allowed unbounded memory growth (PE-9081).
    return streamToBuffer(data.stream, size);
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
