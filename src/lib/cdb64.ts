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
 *
 * File format:
 * - Header: 256 table pointers (4096 bytes total)
 *   - Each pointer: position (64-bit LE) + length (64-bit LE) = 16 bytes
 * - Records: Sequential key-value pairs
 *   - key_length (32-bit LE)
 *   - value_length (32-bit LE)
 *   - key bytes
 *   - value bytes
 * - Hash tables: 256 separate tables
 *   - Each slot: hash (32-bit LE) + position (64-bit LE) = 12 bytes
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createWriteStream, WriteStream } from 'node:fs';

// Header size: 256 pointers * 16 bytes each = 4096 bytes
const HEADER_SIZE = 4096;

// Each header pointer: 8 bytes position + 8 bytes length = 16 bytes
const POINTER_SIZE = 16;

// Each hash table slot: 4 bytes hash + 8 bytes position = 12 bytes
const SLOT_SIZE = 12;

// Number of hash tables
const NUM_TABLES = 256;

/**
 * DJB hash function used by CDB.
 * Returns an unsigned 32-bit integer.
 */
export function cdb64Hash(key: Buffer): number {
  let h = 5381;
  for (const byte of key) {
    h = ((h << 5) + h) ^ byte;
    h = h >>> 0; // Keep as unsigned 32-bit
  }
  return h;
}

/**
 * Internal record structure used during writing.
 */
interface Record {
  hash: number;
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

    // Create write stream, skip header space (will write at end)
    this.stream = createWriteStream(this.tempPath, { start: HEADER_SIZE });

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
    const tableIndex = hash % NUM_TABLES;

    // Store record info for hash table construction
    this.records[tableIndex].push({
      hash,
      position: this.position,
    });

    // Write record: key_length (4) + value_length (4) + key + value
    const header = Buffer.alloc(8);
    header.writeUInt32LE(key.length, 0);
    header.writeUInt32LE(value.length, 4);

    await this.writeToStream(header);
    await this.writeToStream(key);
    await this.writeToStream(value);

    this.position += BigInt(8 + key.length + value.length);
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
      const slots: { hash: number; position: bigint }[] = new Array(
        tableLength,
      );
      for (let j = 0; j < tableLength; j++) {
        slots[j] = { hash: 0, position: BigInt(0) };
      }

      // Insert records into hash table using linear probing
      for (const record of records) {
        let slot = Math.floor(record.hash / NUM_TABLES) % tableLength;
        while (slots[slot].position !== BigInt(0)) {
          slot = (slot + 1) % tableLength;
        }
        slots[slot] = { hash: record.hash, position: record.position };
      }

      // Write hash table
      const tableBuffer = Buffer.alloc(tableLength * SLOT_SIZE);
      for (let j = 0; j < tableLength; j++) {
        const offset = j * SLOT_SIZE;
        tableBuffer.writeUInt32LE(slots[j].hash, offset);
        tableBuffer.writeBigUInt64LE(slots[j].position, offset + 4);
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
    } finally {
      await fileHandle.close();
    }

    // Atomically move temp file to final location
    await fs.rename(this.tempPath, this.outputPath);
  }

  /**
   * Writes data to the stream with backpressure handling.
   */
  private async writeToStream(data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const canContinue = this.stream!.write(data, (err) => {
        if (err) reject(err);
      });
      if (canContinue) {
        resolve();
      } else {
        this.stream!.once('drain', resolve);
      }
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
    const tableIndex = hash % NUM_TABLES;
    const pointer = this.tablePointers[tableIndex];

    // Empty table means key definitely not present
    if (pointer.length === BigInt(0)) {
      return undefined;
    }

    const tableLength = Number(pointer.length);
    let slot = Math.floor(hash / NUM_TABLES) % tableLength;

    // Linear probe through hash table
    for (let i = 0; i < tableLength; i++) {
      const slotPosition = pointer.position + BigInt(slot * SLOT_SIZE);

      // Read slot
      const slotBuffer = Buffer.alloc(SLOT_SIZE);
      await this.fileHandle.read(
        slotBuffer,
        0,
        SLOT_SIZE,
        Number(slotPosition),
      );

      const slotHash = slotBuffer.readUInt32LE(0);
      const recordPosition = slotBuffer.readBigUInt64LE(4);

      // Empty slot means key not found
      if (recordPosition === BigInt(0)) {
        return undefined;
      }

      // Hash match - verify key
      if (slotHash === hash) {
        // Read record header
        const recordHeader = Buffer.alloc(8);
        await this.fileHandle.read(recordHeader, 0, 8, Number(recordPosition));

        const keyLength = recordHeader.readUInt32LE(0);
        const valueLength = recordHeader.readUInt32LE(4);

        // Read and compare key
        const recordKey = Buffer.alloc(keyLength);
        await this.fileHandle.read(
          recordKey,
          0,
          keyLength,
          Number(recordPosition) + 8,
        );

        if (key.equals(recordKey)) {
          // Key matches - read and return value
          const value = Buffer.alloc(valueLength);
          await this.fileHandle.read(
            value,
            0,
            valueLength,
            Number(recordPosition) + 8 + keyLength,
          );
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
