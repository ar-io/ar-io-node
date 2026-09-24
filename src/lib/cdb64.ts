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
import { ByteRangeSource, FileByteRangeSource } from './byte-range-source.js';

// Header size: 256 pointers * 16 bytes each = 4096 bytes
const HEADER_SIZE = 4096;

// Each header pointer: 8 bytes position + 8 bytes length = 16 bytes
const POINTER_SIZE = 16;

// Each hash table slot: 8 bytes hash + 8 bytes position = 16 bytes
const SLOT_SIZE = 16;

// Number of hash tables
const NUM_TABLES = 256;

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
 * Largest key a record may declare (1 KiB).
 *
 * Root-transaction indexes key on 32-byte IDs. A lookup never needs this
 * bound, since a record whose key length differs from the probe key cannot
 * match it; it limits what entries() and verifyCdb64File accept from a file
 * nobody has probed yet.
 */
export const MAX_CDB64_KEY_LENGTH = 1024;

/**
 * Default largest value a record may declare (1 MiB).
 *
 * The format itself carries arbitrary values, and this is the generic
 * reader's ceiling; root-transaction values are MessagePack objects of a few
 * hundred bytes, and index kinds that know that apply a tighter bound (see
 * the cdb64-root-tx artifact kind). The point of any bound is that a record
 * header is untrusted input: without one, a single crafted header turns a
 * lookup into a multi-gigabyte allocation.
 */
export const MAX_CDB64_VALUE_LENGTH = 1024 * 1024;

/** Record header: key_length (8) + value_length (8). */
const RECORD_HEADER_SIZE = 16;

/**
 * Read a little-endian uint64 as a Number, or undefined if it exceeds
 * Number.MAX_SAFE_INTEGER.
 *
 * Every length and offset in a CDB64 file is a uint64 the file itself
 * asserts. Values past 2^53 cannot be a real offset or length in any file
 * Node can read, so they are reported as undefined for the caller to treat
 * as corruption, rather than rounded into a plausible-looking number.
 */
function readSafeUint64(buffer: Buffer, offset: number): number | undefined {
  const low = buffer.readUInt32LE(offset);
  const high = buffer.readUInt32LE(offset + 4);
  // 2^53 - 1 has 21 bits in the high word.
  if (high > 0x1fffff) {
    return undefined;
  }
  return high * 0x100000000 + low;
}

/** A header pointer, checked once at open. */
interface CheckedTablePointer {
  /** Byte offset of the table. */
  position: number;
  /** Slot count. */
  length: number;
  /**
   * False when the pointer cannot describe a table inside the file: it
   * overlaps the header, runs past the end, or does not fit in a safe
   * integer. Lookups that hash to such a table find nothing.
   */
  valid: boolean;
}

/**
 * Options for Cdb64Reader.
 */
export interface Cdb64ReaderOptions {
  /**
   * Largest value length a record may declare (default
   * MAX_CDB64_VALUE_LENGTH). A record declaring more is treated as corrupt.
   */
  maxValueLength?: number;
}

/**
 * CDB64 Reader - Performs lookups in CDB64 data.
 *
 * Supports reading from any ByteRangeSource, enabling access to CDB64 data
 * stored in local files, HTTP endpoints, or Arweave transactions.
 *
 * The reader treats every offset and length in the file as untrusted: an
 * index file may come from a remote publisher. A table pointer, slot or
 * record header that points outside the file, or declares a length past the
 * reader's bounds, makes that lookup return undefined and is counted (see
 * getCorruptRecordCount), rather than driving an allocation or read of
 * whatever size the file names.
 *
 * Usage with file path (convenience):
 *   const reader = new Cdb64Reader('/path/to/data.cdb');
 *   await reader.open();
 *   const value = await reader.get(key);
 *   await reader.close();
 *
 * Usage with ByteRangeSource (advanced):
 *   const source = new HttpByteRangeSource({ url: 'https://...' });
 *   const reader = Cdb64Reader.fromSource(source);
 *   await reader.open();
 *   const value = await reader.get(key);
 *   await reader.close();
 */
export class Cdb64Reader {
  private source: ByteRangeSource;
  private ownsSource: boolean;
  private tablePointers: { position: bigint; length: bigint }[] = [];
  private checkedPointers: CheckedTablePointer[] = [];
  private maxValueLength: number;
  /** Source size, when the source knows it. */
  private sourceSize: number | undefined;
  /**
   * Where the record region ends: the lowest valid, non-empty table
   * position, else the source size. Undefined only for a source of unknown
   * size with no tables.
   */
  private recordsEnd: number | undefined;
  private corruptRecords = 0;
  private opened = false;

  /**
   * Creates a reader for a local file path.
   * This is a convenience constructor that creates a FileByteRangeSource internally.
   *
   * @param filePath - Path to the CDB64 file
   * @param ownsSource - Ignored for a path; the reader always owns the file
   * @param options - Reader bounds
   */
  constructor(
    filePath: string,
    ownsSource?: boolean,
    options?: Cdb64ReaderOptions,
  );

  /**
   * Creates a reader from a ByteRangeSource.
   * Use the static fromSource() method for clarity.
   *
   * @param source - The ByteRangeSource to read from
   * @param ownsSource - If true, close() will also close the source
   * @param options - Reader bounds
   */
  constructor(
    source: ByteRangeSource,
    ownsSource?: boolean,
    options?: Cdb64ReaderOptions,
  );

  constructor(
    filePathOrSource: string | ByteRangeSource,
    ownsSource = true,
    { maxValueLength = MAX_CDB64_VALUE_LENGTH }: Cdb64ReaderOptions = {},
  ) {
    if (typeof filePathOrSource === 'string') {
      this.source = new FileByteRangeSource(filePathOrSource);
      this.ownsSource = true;
    } else {
      this.source = filePathOrSource;
      this.ownsSource = ownsSource;
    }
    this.maxValueLength = maxValueLength;
  }

  /**
   * Creates a reader from a ByteRangeSource.
   *
   * @param source - The ByteRangeSource to read from
   * @param ownsSource - If true (default), close() will also close the source
   * @param options - Reader bounds
   */
  static fromSource(
    source: ByteRangeSource,
    ownsSource = true,
    options: Cdb64ReaderOptions = {},
  ): Cdb64Reader {
    return new Cdb64Reader(source, ownsSource, options);
  }

  /**
   * Opens the reader and reads the header.
   * For FileByteRangeSource, this also opens the underlying file.
   *
   * Also takes the source size (when known) and checks each table pointer
   * against it once, so lookups never follow a pointer out of the file.
   */
  async open(): Promise<void> {
    if (this.opened) {
      return;
    }

    // Open the source if it has an open method (FileByteRangeSource)
    if ('open' in this.source && typeof this.source.open === 'function') {
      await (this.source as FileByteRangeSource).open();
    }

    // Read header
    let header: Buffer;
    try {
      header = await this.source.read(0, HEADER_SIZE);
    } catch (error: any) {
      await this.close();
      throw new Error(`Failed to read CDB64 header: ${error.message}`);
    }

    if (header.length !== HEADER_SIZE) {
      await this.close();
      throw new Error('Invalid CDB64 file: header too short');
    }

    try {
      this.sourceSize =
        this.source.getSize !== undefined
          ? await this.source.getSize()
          : undefined;
    } catch {
      // A source that cannot say how big it is is read without that bound;
      // the per-read size caps still apply.
      this.sourceSize = undefined;
    }

    // Parse table pointers
    this.tablePointers = [];
    this.checkedPointers = [];
    const limit = this.sourceSize ?? Number.MAX_SAFE_INTEGER;
    for (let i = 0; i < NUM_TABLES; i++) {
      const offset = i * POINTER_SIZE;
      this.tablePointers.push({
        position: header.readBigUInt64LE(offset),
        length: header.readBigUInt64LE(offset + 8),
      });

      const position = readSafeUint64(header, offset);
      const length = readSafeUint64(header, offset + 8);
      const valid =
        length === 0 ||
        (position !== undefined &&
          length !== undefined &&
          position >= HEADER_SIZE &&
          // Checked as length <= room / SLOT_SIZE so the product cannot
          // leave safe-integer range.
          position <= limit &&
          length <= Math.floor((limit - position) / SLOT_SIZE));
      this.checkedPointers.push({
        position: position ?? 0,
        length: length ?? 0,
        valid,
      });
    }

    let recordsEnd = this.sourceSize;
    for (const pointer of this.checkedPointers) {
      if (
        pointer.valid &&
        pointer.length > 0 &&
        (recordsEnd === undefined || pointer.position < recordsEnd)
      ) {
        recordsEnd = pointer.position;
      }
    }
    this.recordsEnd = recordsEnd;

    this.opened = true;
  }

  /**
   * Looks up a key in the database.
   * Returns the value if found, undefined otherwise.
   *
   * Corrupt structure on the probe path (a table pointer or slot outside the
   * file, a record running past the record region, a value length above the
   * reader's bound) also returns undefined, and bumps the corruption count.
   * A record whose key length differs from the probe key is a hash collision
   * with some other key, so probing continues without reading its key.
   *
   * @throws if the reader is not open, or the source fails a read
   */
  async get(key: Buffer): Promise<Buffer | undefined> {
    if (!this.opened) {
      throw new Error('Reader not opened. Call open() first.');
    }

    const hash = cdb64Hash(key);
    const tableIndex = Number(hash % BigInt(NUM_TABLES));
    const pointer = this.checkedPointers[tableIndex];

    if (!pointer.valid) {
      this.corruptRecords++;
      return undefined;
    }
    // Empty table means key definitely not present
    if (pointer.length === 0) {
      return undefined;
    }

    const tableLength = pointer.length;
    const recordsLimit = this.recordsEnd ?? Number.MAX_SAFE_INTEGER;
    let slot = Number((hash / BigInt(NUM_TABLES)) % BigInt(tableLength));

    // Linear probe through hash table; at most one pass over its slots.
    for (let i = 0; i < tableLength; i++) {
      // In range: open() checked position + length * SLOT_SIZE <= size.
      const slotBuffer = await this.source.read(
        pointer.position + slot * SLOT_SIZE,
        SLOT_SIZE,
      );

      const slotHash = slotBuffer.readBigUInt64LE(0);
      const recordPosition = readSafeUint64(slotBuffer, 8);

      // Empty slot means key not found
      if (recordPosition === 0) {
        return undefined;
      }

      // Hash match - verify key
      if (slotHash === hash) {
        if (
          recordPosition === undefined ||
          recordPosition < HEADER_SIZE ||
          recordPosition + RECORD_HEADER_SIZE > recordsLimit
        ) {
          this.corruptRecords++;
          return undefined;
        }

        const recordHeader = await this.source.read(
          recordPosition,
          RECORD_HEADER_SIZE,
        );
        const keyLength = readSafeUint64(recordHeader, 0);
        const valueLength = readSafeUint64(recordHeader, 8);
        if (keyLength === undefined || valueLength === undefined) {
          this.corruptRecords++;
          return undefined;
        }

        if (keyLength === key.length) {
          const keyStart = recordPosition + RECORD_HEADER_SIZE;
          if (
            valueLength > this.maxValueLength ||
            keyStart + keyLength + valueLength > recordsLimit
          ) {
            this.corruptRecords++;
            return undefined;
          }

          const recordKey = await this.source.read(keyStart, keyLength);
          if (key.equals(recordKey)) {
            return this.source.read(keyStart + keyLength, valueLength);
          }
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
   *
   * @throws on a record whose lengths exceed the reader's bounds or run
   *   past the record region
   */
  async *entries(): AsyncGenerator<{ key: Buffer; value: Buffer }> {
    if (!this.opened) {
      throw new Error('Reader not opened. Call open() first.');
    }

    // Records run from the header to the first hash table. With no tables
    // there are no records (and, for a source of unknown size, no way to
    // tell where they would end).
    const hasTables = this.checkedPointers.some(
      (pointer) => pointer.valid && pointer.length > 0,
    );
    if (!hasTables || this.recordsEnd === undefined) {
      return;
    }
    const recordsEnd = this.recordsEnd;

    // Scan records sequentially from after header until hash tables
    let position = HEADER_SIZE;

    while (position < recordsEnd) {
      if (position + RECORD_HEADER_SIZE > recordsEnd) {
        throw new Error(
          `Invalid record at position ${position}: header runs past the record region`,
        );
      }
      const recordHeader = await this.source.read(position, RECORD_HEADER_SIZE);

      const keyLength = readSafeUint64(recordHeader, 0);
      const valueLength = readSafeUint64(recordHeader, 8);

      // Sanity check to avoid reading garbage
      if (
        keyLength === undefined ||
        valueLength === undefined ||
        keyLength > MAX_CDB64_KEY_LENGTH ||
        valueLength > this.maxValueLength ||
        position + RECORD_HEADER_SIZE + keyLength + valueLength > recordsEnd
      ) {
        throw new Error(
          `Invalid record at position ${position}: key=${keyLength}, value=${valueLength}`,
        );
      }

      const keyStart = position + RECORD_HEADER_SIZE;
      const key = await this.source.read(keyStart, keyLength);
      const value = await this.source.read(keyStart + keyLength, valueLength);

      yield { key, value };

      position = keyStart + keyLength + valueLength;
    }
  }

  /**
   * Closes the reader and optionally the underlying source.
   */
  async close(): Promise<void> {
    if (this.ownsSource) {
      await this.source.close();
    }
    this.opened = false;
    this.tablePointers = [];
    this.checkedPointers = [];
    this.sourceSize = undefined;
    this.recordsEnd = undefined;
  }

  /**
   * Checks if the reader is currently open.
   */
  isOpen(): boolean {
    return this.opened;
  }

  /**
   * Number of lookups that stopped on corrupt structure since construction.
   *
   * A well-formed file never increments this; a nonzero count means the
   * file is damaged or hostile and is worth surfacing to an operator.
   */
  getCorruptRecordCount(): number {
    return this.corruptRecords;
  }

  /**
   * Number of records in the file, read from the header.
   *
   * Each hash table is sized at two slots per record, so the slot counts the
   * header already carries give the total without reading any data. Useful
   * as a cheap integrity cross-check: a file that is the right length but
   * zero-filled parses as a valid, empty database, which a size or digest
   * check cannot distinguish from a real one.
   *
   * @throws if the reader is not open.
   */
  getRecordCount(): number {
    if (!this.opened) {
      throw new Error('Cannot count records before open()');
    }
    let slots = 0n;
    for (const pointer of this.tablePointers) {
      slots += pointer.length;
    }
    return Number(slots / 2n);
  }

  /**
   * Returns the underlying ByteRangeSource.
   */
  getSource(): ByteRangeSource {
    return this.source;
  }
}

/**
 * Longest run of occupied slots verifyCdb64File accepts in one hash table.
 *
 * Tables are half full, and at that load linear probing's longest cluster
 * grows with the log of the table size: under a hundred slots even for tens
 * of millions of records. A lookup that misses walks the whole run, so a
 * table built with one long cluster makes every miss in it cost one read per
 * slot; this bound keeps a hostile file from doing that.
 */
export const MAX_CDB64_PROBE_RUN = 1024;

/** Read size for verifyCdb64File's sequential scan (1 MiB). */
const VERIFY_READ_CHUNK_SIZE = 1024 * 1024;

/**
 * Options for verifyCdb64File.
 */
export interface VerifyCdb64FileOptions {
  /** Largest key length a record may declare (default MAX_CDB64_KEY_LENGTH). */
  maxKeyLength?: number;
  /** Largest value length a record may declare (default MAX_CDB64_VALUE_LENGTH). */
  maxValueLength?: number;
  /** Longest run of occupied slots allowed (default MAX_CDB64_PROBE_RUN). */
  maxProbeRun?: number;
  /** Bytes read per sequential read (default 1 MiB; tests shrink it). */
  readChunkSize?: number;
}

/**
 * Walk a local CDB64 file end to end and prove its structure is one the
 * reader can follow safely, throwing on the first fault.
 *
 * Checks that:
 * - every non-empty table pointer lies wholly inside the file, after the
 *   header, and no two tables overlap;
 * - the records, walked sequentially from the end of the header, each
 *   declare a key and value length within bounds, and the walk lands
 *   exactly on the first table rather than inside or past it;
 * - every occupied slot hashes to its own table and points at a record
 *   header inside the record region;
 * - the occupied slots number exactly the records walked, and no table has
 *   a run of occupied slots longer than maxProbeRun.
 *
 * Memory is bounded by one read buffer whatever the file size, and the file
 * is read once, in order, so a multi-gigabyte file costs one sequential
 * pass. It does not re-hash keys or prove each slot points at the start of a
 * record; the reader's own bounds keep either fault from doing more than
 * returning a wrong or missing value, which a publisher could produce with
 * well-formed bytes anyway.
 *
 * @param filePath - Local CDB64 file
 * @param options - Bounds to enforce
 * @returns The number of records in the file
 * @throws Error describing the first structural fault found
 */
export async function verifyCdb64File(
  filePath: string,
  {
    maxKeyLength = MAX_CDB64_KEY_LENGTH,
    maxValueLength = MAX_CDB64_VALUE_LENGTH,
    maxProbeRun = MAX_CDB64_PROBE_RUN,
    readChunkSize = VERIFY_READ_CHUNK_SIZE,
  }: VerifyCdb64FileOptions = {},
): Promise<{ records: number }> {
  // Whole slots per chunk, and always room for a record header.
  const chunkSize = Math.max(
    SLOT_SIZE,
    Math.floor(readChunkSize / SLOT_SIZE) * SLOT_SIZE,
  );

  const handle = await fs.open(filePath, 'r');
  try {
    const fileSize = (await handle.stat()).size;
    if (fileSize < HEADER_SIZE) {
      throw new Error(
        `file is ${fileSize} bytes, shorter than the ${HEADER_SIZE}-byte header`,
      );
    }

    const buffer = Buffer.allocUnsafe(Math.max(chunkSize, HEADER_SIZE));

    /** Fill buffer[0, length) from the file at position, or throw. */
    const readExactly = async (
      position: number,
      length: number,
    ): Promise<void> => {
      let done = 0;
      while (done < length) {
        const { bytesRead } = await handle.read(
          buffer,
          done,
          length - done,
          position + done,
        );
        if (bytesRead === 0) {
          throw new Error(`short read at offset ${position + done}`);
        }
        done += bytesRead;
      }
    };

    // Header: collect the non-empty tables, checking each lies in the file.
    await readExactly(0, HEADER_SIZE);
    const tables: { index: number; position: number; length: number }[] = [];
    for (let index = 0; index < NUM_TABLES; index++) {
      const position = readSafeUint64(buffer, index * POINTER_SIZE);
      const length = readSafeUint64(buffer, index * POINTER_SIZE + 8);
      if (length === 0) {
        continue;
      }
      if (
        position === undefined ||
        length === undefined ||
        position < HEADER_SIZE ||
        position > fileSize ||
        length > Math.floor((fileSize - position) / SLOT_SIZE)
      ) {
        throw new Error(
          `table ${index} (position ${position ?? '>2^53'}, ${length ?? '>2^53'} slots) does not fit in the ${fileSize}-byte file`,
        );
      }
      tables.push({ index, position, length });
    }
    tables.sort((a, b) => a.position - b.position);
    for (let i = 1; i < tables.length; i++) {
      const previous = tables[i - 1];
      if (
        previous.position + previous.length * SLOT_SIZE >
        tables[i].position
      ) {
        throw new Error(
          `tables ${previous.index} and ${tables[i].index} overlap`,
        );
      }
    }

    // Records run from the header to the first table (or, with no tables,
    // to the end of the file, where a well-formed empty database has none).
    const recordsEnd = tables.length > 0 ? tables[0].position : fileSize;

    let records = 0;
    let bufferStart = 0;
    let bufferLength = 0;
    let position = HEADER_SIZE;
    while (position < recordsEnd) {
      if (position + RECORD_HEADER_SIZE > recordsEnd) {
        throw new Error(
          `record at offset ${position} would overlap the hash tables at ${recordsEnd}`,
        );
      }
      if (
        position < bufferStart ||
        position + RECORD_HEADER_SIZE > bufferStart + bufferLength
      ) {
        // Refill from this header: bytes skipped over (keys and values)
        // are never read unless a header shares their chunk.
        bufferStart = position;
        bufferLength = Math.min(chunkSize, recordsEnd - position);
        await readExactly(bufferStart, bufferLength);
      }
      const offset = position - bufferStart;
      const keyLength = readSafeUint64(buffer, offset);
      const valueLength = readSafeUint64(buffer, offset + 8);
      if (
        keyLength === undefined ||
        valueLength === undefined ||
        keyLength > maxKeyLength ||
        valueLength > maxValueLength
      ) {
        throw new Error(
          `record at offset ${position} declares key length ${keyLength ?? '>2^53'} and value length ${valueLength ?? '>2^53'}, beyond the ${maxKeyLength}/${maxValueLength}-byte bounds`,
        );
      }
      const next = position + RECORD_HEADER_SIZE + keyLength + valueLength;
      if (next > recordsEnd) {
        throw new Error(
          `record at offset ${position} runs to ${next}, past the hash tables at ${recordsEnd}`,
        );
      }
      records++;
      position = next;
    }

    // Slots: each occupied one belongs to its table and points at a record.
    let occupied = 0;
    for (const table of tables) {
      let run = 0;
      let leadingRun = 0;
      let longestRun = 0;
      let sawEmpty = false;
      for (let first = 0; first < table.length; ) {
        const count = Math.min(chunkSize / SLOT_SIZE, table.length - first);
        await readExactly(
          table.position + first * SLOT_SIZE,
          count * SLOT_SIZE,
        );
        for (let slot = 0; slot < count; slot++) {
          const offset = slot * SLOT_SIZE;
          const recordPosition = readSafeUint64(buffer, offset + 8);
          if (recordPosition === 0) {
            if (!sawEmpty) {
              leadingRun = run;
              sawEmpty = true;
            }
            run = 0;
            continue;
          }
          // The table index is hash % 256, the hash's low byte.
          if (
            buffer[offset] !== table.index ||
            recordPosition === undefined ||
            recordPosition < HEADER_SIZE ||
            recordPosition + RECORD_HEADER_SIZE > recordsEnd
          ) {
            throw new Error(
              `table ${table.index} slot ${first + slot} is not a valid entry for this table`,
            );
          }
          occupied++;
          run++;
          if (run > longestRun) {
            longestRun = run;
          }
        }
        first += count;
      }
      // Probing wraps, so a run at the end continues into the one at the
      // start; a table with no empty slot is one run of its full length.
      const wrappedRun = sawEmpty ? run + leadingRun : table.length;
      if (Math.max(longestRun, wrappedRun) > maxProbeRun) {
        throw new Error(
          `table ${table.index} has a run of ${Math.max(longestRun, wrappedRun)} occupied slots, more than the ${maxProbeRun} allowed`,
        );
      }
    }

    if (occupied !== records) {
      throw new Error(
        `hash tables index ${occupied} records, but the file holds ${records}`,
      );
    }

    return { records };
  } finally {
    await handle.close();
  }
}
