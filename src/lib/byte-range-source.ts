/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import * as fs from 'node:fs/promises';

/**
 * Largest single read any ByteRangeSource will perform (64 MiB).
 *
 * Read sizes often come from the bytes being read: a CDB64 record header
 * carries its own key and value lengths, a bundle header its item count. A
 * hostile or corrupt file can put any 64-bit number there, and a source that
 * allocated whatever it was asked for would turn one lookup into a
 * multi-gigabyte allocation, or, at 2^31 and above, into an assertion inside
 * Node's fs binding that aborts the process with no chance to catch it.
 * Legitimate callers stay far below this: CDB64 lookups read tens of bytes,
 * and the largest planned read (a bundle index chunk) is 4 MiB.
 */
export const MAX_BYTE_RANGE_READ_SIZE = 64 * 1024 * 1024;

/**
 * Reject a read request that no source should honor.
 *
 * Throws an ordinary, catchable Error so a caller walking untrusted bytes
 * sees a failed read rather than an allocation or a native abort.
 *
 * @param offset - Requested byte offset
 * @param size - Requested byte count
 * @param maxSize - Largest size this source accepts
 * @throws Error if offset or size is not a non-negative safe integer, or if
 *   size exceeds maxSize
 */
export function assertReadableRange(
  offset: number,
  size: number,
  maxSize: number = MAX_BYTE_RANGE_READ_SIZE,
): void {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error(`Byte range read: invalid offset ${offset}`);
  }
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`Byte range read: invalid size ${size}`);
  }
  if (size > maxSize) {
    throw new Error(
      `Read of ${size} bytes at offset ${offset} exceeds the ${maxSize}-byte limit`,
    );
  }
}

/**
 * Abstraction for random-access byte range reads.
 *
 * Enables CDB64 and other readers to access data from various sources
 * (local files, HTTP endpoints, Arweave transactions) through a unified
 * interface.
 */
export interface ByteRangeSource {
  /**
   * Read a byte range from the source.
   *
   * @param offset - Byte offset from source start
   * @param size - Number of bytes to read
   * @returns Buffer containing the requested bytes
   * @throws Error if read fails or returns fewer bytes than requested
   */
  read(offset: number, size: number): Promise<Buffer>;

  /**
   * Total size of the source in bytes, when the source knows it.
   *
   * Optional: a remote source may not know its length up front. Readers use
   * it to bound offsets taken from the data itself before reading them.
   *
   * @returns The size in bytes, or undefined if unknown
   */
  getSize?(): Promise<number | undefined>;

  /**
   * Close the source and release resources.
   * Safe to call multiple times.
   */
  close(): Promise<void>;

  /**
   * Check if the source is currently open.
   */
  isOpen(): boolean;
}

/**
 * ByteRangeSource implementation for local files.
 *
 * Wraps fs.FileHandle with the ByteRangeSource interface. This is the
 * fastest path for local file access with minimal abstraction overhead.
 */
export class FileByteRangeSource implements ByteRangeSource {
  private filePath: string;
  private fileHandle: fs.FileHandle | null = null;
  private fileSize: number | undefined;
  private maxReadSize: number;

  /**
   * @param filePath - Path of the file to read
   * @param options.maxReadSize - Largest single read accepted (default
   *   MAX_BYTE_RANGE_READ_SIZE); larger requests throw before allocating
   */
  constructor(
    filePath: string,
    { maxReadSize = MAX_BYTE_RANGE_READ_SIZE }: { maxReadSize?: number } = {},
  ) {
    this.filePath = filePath;
    this.maxReadSize = maxReadSize;
  }

  /**
   * Opens the file for reading.
   * Must be called before read() operations.
   */
  async open(): Promise<void> {
    if (this.fileHandle !== null) {
      return;
    }
    const handle = await fs.open(this.filePath, 'r');
    try {
      this.fileSize = (await handle.stat()).size;
    } catch (error) {
      await handle.close();
      throw error;
    }
    this.fileHandle = handle;
  }

  /**
   * Size of the file as it was when opened.
   *
   * Index files are immutable once written, so the size taken at open is
   * the one that bounds every later read.
   */
  async getSize(): Promise<number | undefined> {
    return this.fileHandle === null ? undefined : this.fileSize;
  }

  /**
   * @throws Error if the source is not open, the range is invalid or larger
   *   than the per-read limit, or the file holds fewer bytes than requested
   */
  async read(offset: number, size: number): Promise<Buffer> {
    if (this.fileHandle === null) {
      throw new Error('FileByteRangeSource not opened. Call open() first.');
    }

    // Checked before allocating: Buffer.alloc of an untrusted size is the
    // hazard, and fs read aborts the process on a length of 2^31 or more.
    assertReadableRange(offset, size, this.maxReadSize);
    if (this.fileSize !== undefined && offset + size > this.fileSize) {
      throw new Error(
        `Short read at offset ${offset}: expected ${size} bytes, but the file is ${this.fileSize} bytes`,
      );
    }

    const buffer = Buffer.alloc(size);
    const { bytesRead } = await this.fileHandle.read(buffer, 0, size, offset);

    if (bytesRead !== size) {
      throw new Error(
        `Short read at offset ${offset}: expected ${size} bytes, got ${bytesRead}`,
      );
    }

    return buffer;
  }

  async close(): Promise<void> {
    if (this.fileHandle !== null) {
      await this.fileHandle.close();
      this.fileHandle = null;
      this.fileSize = undefined;
    }
  }

  isOpen(): boolean {
    return this.fileHandle !== null;
  }

  /**
   * Returns the file path this source reads from.
   */
  getFilePath(): string {
    return this.filePath;
  }
}
