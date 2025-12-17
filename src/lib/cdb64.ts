/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * CDB64 - A 64-bit variant of the Constant Database format.
 *
 * Based on the CDB format by D. J. Bernstein (https://cr.yp.to/cdb.html)
 * with modifications to support 64-bit file offsets for files >4GB.
 * Compatible with the Rust cdb64-rs implementation.
 *
 * See docs/cdb64-format.md for the complete format specification.
 *
 * ## File Structure
 *
 * ```
 * +------------------+
 * |      Header      |  4096 bytes (256 × 16-byte pointers)
 * +------------------+
 * |     Records      |  Variable length key-value pairs
 * +------------------+
 * |   Hash Tables    |  256 tables for O(1) lookup
 * +------------------+
 * ```
 *
 * ## Header (4096 bytes)
 * - 256 table pointers, each 16 bytes:
 *   - position: uint64_le (byte offset of hash table)
 *   - length: uint64_le (number of slots in table)
 *
 * ## Records
 * - key_length: uint64_le
 * - value_length: uint64_le
 * - key: bytes[key_length]
 * - value: bytes[value_length]
 *
 * ## Hash Tables
 * - Each table has 2× the number of records that hash to it
 * - Each slot is 16 bytes:
 *   - hash: uint64_le (full 64-bit hash)
 *   - position: uint64_le (record position, 0 = empty)
 *
 * ## Lookup Algorithm
 * 1. hash = djb_hash(key) (64-bit)
 * 2. table_index = hash % 256
 * 3. starting_slot = (hash / 256) % table_length
 * 4. Linear probe until: empty slot (not found) or matching key (found)
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createWriteStream, WriteStream } from 'node:fs';

// Header size: 256 pointers * 16 bytes each = 4096 bytes
const HEADER_SIZE = 4096;

// Each header pointer: 8 bytes position + 8 bytes length = 16 bytes
const POINTER_SIZE = 16;

// Each hash table slot: 8 bytes hash + 8 bytes position = 16 bytes
const SLOT_SIZE = 16;

// Number of hash tables
const NUM_TABLES = 256;

// Maximum file size supported (limited by safe integer precision for file I/O)
const MAX_SAFE_FILE_SIZE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Safely converts a BigInt file position to Number for fs operations.
 * Throws an error if the position exceeds JavaScript's safe integer range.
 *
 * Note: Node.js fs operations use Number for file positions. While BigInt
 * can represent larger values, files >8TB (2^53 bytes) would require
 * BigInt-native I/O which Node.js doesn't support natively.
 *
 * @param position - The BigInt file position to convert
 * @returns The position as a safe Number
 * @throws Error if position exceeds MAX_SAFE_INTEGER
 */
function toSafeFilePosition(position: bigint): number {
  if (position > MAX_SAFE_FILE_SIZE) {
    throw new Error(
      `File position ${position} exceeds maximum safe integer (${Number.MAX_SAFE_INTEGER}). ` +
        `CDB64 files larger than ~8TB are not supported.`,
    );
  }
  return Number(position);
}

/**
 * DJB hash function used by CDB, extended to 64-bit.
 *
 * This is the same hash function used in the original CDB format,
 * but computed with 64-bit arithmetic for compatibility with cdb64-rs.
 * Formula: hash = ((hash << 5) + hash) ^ byte, starting with 5381.
 * This is equivalent to: hash = hash * 33 ^ byte
 *
 * @param key - The key bytes to hash
 * @returns An unsigned 64-bit integer hash value as bigint
 */
export function cdb64Hash(key: Buffer): bigint {
  let h = 5381n;
  for (const byte of key) {
    h = ((h << 5n) + h) ^ BigInt(byte);
    h = h & 0xffffffffffffffffn; // Keep as unsigned 64-bit
  }
  return h;
}

/**
 * Internal record structure used during writing.
 */
interface Record {
  hash: bigint;
  position: bigint;
}

/**
 * CDB64 Writer - Creates CDB64 files from key-value pairs.
 *
 * Usage:
 *   const writer = new Cdb64Writer('/path/to/output.cdb');
 *   await writer.add(key1, value1);
 *   await writer.add(key2, value2);
 *   await writer.finalize();
 */
export class Cdb64Writer {
  private outputPath: string;
  private tempPath: string;
  private stream: WriteStream | null = null;
  private position: bigint = BigInt(HEADER_SIZE);
  private records: Record[][] = [];
  private finalized = false;

  constructor(outputPath: string) {
    this.outputPath = outputPath;
    this.tempPath = `${outputPath}.tmp.${process.pid}`;

    // Initialize record arrays for each hash table
    for (let i = 0; i < NUM_TABLES; i++) {
      this.records[i] = [];
    }
  }

  /**
   * Opens the writer and prepares for adding records.
   */
  async open(): Promise<void> {
    // Ensure output directory exists
    const dir = path.dirname(this.outputPath);
    await fs.mkdir(dir, { recursive: true });

    // Pre-allocate header space with zeros to ensure proper file structure
    // on all filesystems (critical for macOS APFS which may not properly
    // handle sparse files created with start offset)
    const placeholderHeader = Buffer.alloc(HEADER_SIZE);
    await fs.writeFile(this.tempPath, placeholderHeader);

    // Create write stream in append mode to continue after the header
    this.stream = createWriteStream(this.tempPath, { flags: 'a' });

    // Wait for stream to be ready
    await new Promise<void>((resolve, reject) => {
      this.stream!.on('open', () => resolve());
      this.stream!.on('error', reject);
    });
  }

  /**
   * Adds a key-value pair to the database.
   * Keys and values are arbitrary byte sequences.
   */
  async add(key: Buffer, value: Buffer): Promise<void> {
    if (this.finalized) {
      throw new Error('Cannot add records after finalization');
    }
    if (!this.stream) {
      throw new Error('Writer not opened. Call open() first.');
    }

    const hash = cdb64Hash(key);
    const tableIndex = Number(hash % BigInt(NUM_TABLES));

    // Store record info for hash table construction
    this.records[tableIndex].push({
      hash,
      position: this.position,
    });

    // Write record: key_length (8) + value_length (8) + key + value
    const header = Buffer.alloc(16);
    header.writeBigUInt64LE(BigInt(key.length), 0);
    header.writeBigUInt64LE(BigInt(value.length), 8);

    await this.writeToStream(header);
    await this.writeToStream(key);
    await this.writeToStream(value);

    this.position += BigInt(16 + key.length + value.length);
  }

  /**
   * Finalizes the database by writing hash tables and header.
   */
  async finalize(): Promise<void> {
    if (this.finalized) {
      throw new Error('Already finalized');
    }
    if (!this.stream) {
      throw new Error('Writer not opened. Call open() first.');
    }

    this.finalized = true;

    // Build and write hash tables
    const tablePointers: { position: bigint; length: bigint }[] = [];

    for (let i = 0; i < NUM_TABLES; i++) {
      const records = this.records[i];

      // Hash table size is 2x number of records (for efficient probing)
      const tableLength = records.length === 0 ? 0 : records.length * 2;

      tablePointers.push({
        position: this.position,
        length: BigInt(tableLength),
      });

      if (tableLength === 0) {
        continue;
      }

      // Create hash table slots (initialized to zeros)
      const slots: { hash: bigint; position: bigint }[] = new Array(
        tableLength,
      );
      for (let j = 0; j < tableLength; j++) {
        slots[j] = { hash: 0n, position: 0n };
      }

      // Insert records into hash table using linear probing
      for (const record of records) {
        let slot = Number(
          (record.hash / BigInt(NUM_TABLES)) % BigInt(tableLength),
        );
        while (slots[slot].position !== 0n) {
          slot = (slot + 1) % tableLength;
        }
        slots[slot] = { hash: record.hash, position: record.position };
      }

      // Write hash table
      const tableBuffer = Buffer.alloc(tableLength * SLOT_SIZE);
      for (let j = 0; j < tableLength; j++) {
        const offset = j * SLOT_SIZE;
        tableBuffer.writeBigUInt64LE(slots[j].hash, offset);
        tableBuffer.writeBigUInt64LE(slots[j].position, offset + 8);
      }

      await this.writeToStream(tableBuffer);
      this.position += BigInt(tableLength * SLOT_SIZE);
    }

    // Close the data stream
    await new Promise<void>((resolve, reject) => {
      this.stream!.end(() => resolve());
      this.stream!.on('error', reject);
    });

    // Write header with table pointers
    const header = Buffer.alloc(HEADER_SIZE);
    for (let i = 0; i < NUM_TABLES; i++) {
      const offset = i * POINTER_SIZE;
      header.writeBigUInt64LE(tablePointers[i].position, offset);
      header.writeBigUInt64LE(tablePointers[i].length, offset + 8);
    }

    // Write header at the beginning of the file
    const fileHandle = await fs.open(this.tempPath, 'r+');
    try {
      await fileHandle.write(header, 0, HEADER_SIZE, 0);
      // Ensure data is flushed to disk before renaming (critical on macOS APFS)
      await fileHandle.sync();
    } finally {
      await fileHandle.close();
    }

    // Atomically move temp file to final location
    await fs.rename(this.tempPath, this.outputPath);
  }

  /**
   * Writes data to the stream with proper error handling.
   *
   * Always waits for the write callback to fire before resolving,
   * ensuring async write errors are properly captured. Backpressure
   * is implicitly handled since we await each write sequentially.
   */
  private async writeToStream(data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      this.stream!.write(data, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  /**
   * Cleans up resources if finalize was not called.
   */
  async abort(): Promise<void> {
    if (this.stream) {
      this.stream.destroy();
      this.stream = null;
    }
    try {
      await fs.unlink(this.tempPath);
    } catch {
      // Ignore if temp file doesn't exist
    }
  }
}

/**
 * CDB64 Reader - Performs lookups in CDB64 files.
 *
 * Usage:
 *   const reader = new Cdb64Reader('/path/to/data.cdb');
 *   await reader.open();
 *   const value = await reader.get(key);
 *   await reader.close();
 */
export class Cdb64Reader {
  private filePath: string;
  private fileHandle: fs.FileHandle | null = null;
  private tablePointers: { position: bigint; length: bigint }[] = [];

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * Opens the CDB64 file and reads the header.
   */
  async open(): Promise<void> {
    this.fileHandle = await fs.open(this.filePath, 'r');

    // Read header
    const header = Buffer.alloc(HEADER_SIZE);
    const { bytesRead } = await this.fileHandle.read(header, 0, HEADER_SIZE, 0);

    if (bytesRead !== HEADER_SIZE) {
      await this.close();
      throw new Error('Invalid CDB64 file: header too short');
    }

    // Parse table pointers
    this.tablePointers = [];
    for (let i = 0; i < NUM_TABLES; i++) {
      const offset = i * POINTER_SIZE;
      this.tablePointers.push({
        position: header.readBigUInt64LE(offset),
        length: header.readBigUInt64LE(offset + 8),
      });
    }
  }

  /**
   * Looks up a key in the database.
   * Returns the value if found, undefined otherwise.
   */
  async get(key: Buffer): Promise<Buffer | undefined> {
    if (!this.fileHandle) {
      throw new Error('Reader not opened. Call open() first.');
    }

    const hash = cdb64Hash(key);
    const tableIndex = Number(hash % BigInt(NUM_TABLES));
    const pointer = this.tablePointers[tableIndex];

    // Empty table means key definitely not present
    if (pointer.length === BigInt(0)) {
      return undefined;
    }

    const tableLength = Number(pointer.length);
    let slot = Number((hash / BigInt(NUM_TABLES)) % BigInt(tableLength));

    // Linear probe through hash table
    for (let i = 0; i < tableLength; i++) {
      const slotPosition = pointer.position + BigInt(slot * SLOT_SIZE);

      // Read slot
      const slotBuffer = Buffer.alloc(SLOT_SIZE);
      const { bytesRead: slotBytesRead } = await this.fileHandle.read(
        slotBuffer,
        0,
        SLOT_SIZE,
        toSafeFilePosition(slotPosition),
      );
      if (slotBytesRead !== SLOT_SIZE) {
        throw new Error(
          `Incomplete slot read: expected ${SLOT_SIZE} bytes, got ${slotBytesRead}`,
        );
      }

      const slotHash = slotBuffer.readBigUInt64LE(0);
      const recordPosition = slotBuffer.readBigUInt64LE(8);

      // Empty slot means key not found
      if (recordPosition === BigInt(0)) {
        return undefined;
      }

      // Hash match - verify key
      if (slotHash === hash) {
        // Read record header
        const recordHeader = Buffer.alloc(16);
        const { bytesRead: headerBytesRead } = await this.fileHandle.read(
          recordHeader,
          0,
          16,
          toSafeFilePosition(recordPosition),
        );
        if (headerBytesRead !== 16) {
          throw new Error(
            `Incomplete record header read: expected 16 bytes, got ${headerBytesRead}`,
          );
        }

        const keyLength = Number(recordHeader.readBigUInt64LE(0));
        const valueLength = Number(recordHeader.readBigUInt64LE(8));

        // Read and compare key
        const recordKey = Buffer.alloc(keyLength);
        const { bytesRead: keyBytesRead } = await this.fileHandle.read(
          recordKey,
          0,
          keyLength,
          toSafeFilePosition(recordPosition + 16n),
        );
        if (keyBytesRead !== keyLength) {
          throw new Error(
            `Incomplete key read: expected ${keyLength} bytes, got ${keyBytesRead}`,
          );
        }

        if (key.equals(recordKey)) {
          // Key matches - read and return value
          const value = Buffer.alloc(valueLength);
          const { bytesRead: valueBytesRead } = await this.fileHandle.read(
            value,
            0,
            valueLength,
            toSafeFilePosition(recordPosition + 16n + BigInt(keyLength)),
          );
          if (valueBytesRead !== valueLength) {
            throw new Error(
              `Incomplete value read: expected ${valueLength} bytes, got ${valueBytesRead}`,
            );
          }
          return value;
        }
      }

      // Move to next slot (linear probing)
      slot = (slot + 1) % tableLength;
    }

    // Should not reach here if table is properly constructed
    return undefined;
  }

  /**
   * Iterates over all key-value pairs in the database.
   * Records are yielded in the order they were written (file order).
   *
   * Usage:
   *   for await (const { key, value } of reader.entries()) {
   *     // process key and value
   *   }
   */
  async *entries(): AsyncGenerator<{ key: Buffer; value: Buffer }> {
    if (!this.fileHandle) {
      throw new Error('Reader not opened. Call open() first.');
    }

    // Find where records end by finding the minimum hash table position
    // Hash tables with length 0 have position pointing to where they would be,
    // but we need to find where actual hash table data starts
    let recordsEndPosition = BigInt(Number.MAX_SAFE_INTEGER);
    for (const pointer of this.tablePointers) {
      if (pointer.length > 0n && pointer.position < recordsEndPosition) {
        recordsEndPosition = pointer.position;
      }
    }

    // If no hash tables have entries, there are no records
    if (recordsEndPosition === BigInt(Number.MAX_SAFE_INTEGER)) {
      return;
    }

    // Scan records sequentially from after header until hash tables
    let position = BigInt(HEADER_SIZE);

    while (position < recordsEndPosition) {
      // Read record header (key_length + value_length = 16 bytes)
      const recordHeader = Buffer.alloc(16);
      const { bytesRead } = await this.fileHandle.read(
        recordHeader,
        0,
        16,
        toSafeFilePosition(position),
      );

      if (bytesRead < 16) {
        // Unexpected end of file
        break;
      }

      const keyLength = Number(recordHeader.readBigUInt64LE(0));
      const valueLength = Number(recordHeader.readBigUInt64LE(8));

      // Sanity check to avoid reading garbage
      if (keyLength > 1_000_000 || valueLength > 100_000_000) {
        throw new Error(
          `Invalid record at position ${position}: key=${keyLength}, value=${valueLength}`,
        );
      }

      // Read key
      const key = Buffer.alloc(keyLength);
      const { bytesRead: keyBytesRead } = await this.fileHandle.read(
        key,
        0,
        keyLength,
        toSafeFilePosition(position + 16n),
      );
      if (keyBytesRead !== keyLength) {
        throw new Error(
          `Incomplete key read at position ${position}: expected ${keyLength} bytes, got ${keyBytesRead}`,
        );
      }

      // Read value
      const value = Buffer.alloc(valueLength);
      const { bytesRead: valueBytesRead } = await this.fileHandle.read(
        value,
        0,
        valueLength,
        toSafeFilePosition(position + 16n + BigInt(keyLength)),
      );
      if (valueBytesRead !== valueLength) {
        throw new Error(
          `Incomplete value read at position ${position}: expected ${valueLength} bytes, got ${valueBytesRead}`,
        );
      }

      yield { key, value };

      position += BigInt(16 + keyLength + valueLength);
    }
  }

  /**
   * Closes the file handle.
   */
  async close(): Promise<void> {
    if (this.fileHandle) {
      await this.fileHandle.close();
      this.fileHandle = null;
    }
  }

  /**
   * Checks if the reader is currently open.
   */
  isOpen(): boolean {
    return this.fileHandle !== null;
  }
}
