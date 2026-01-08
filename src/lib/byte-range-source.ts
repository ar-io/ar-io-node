/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import * as fs from 'node:fs/promises';

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

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * Opens the file for reading.
   * Must be called before read() operations.
   */
  async open(): Promise<void> {
    if (this.fileHandle !== null) {
      return;
    }
    this.fileHandle = await fs.open(this.filePath, 'r');
  }

  async read(offset: number, size: number): Promise<Buffer> {
    if (this.fileHandle === null) {
      throw new Error('FileByteRangeSource not opened. Call open() first.');
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
