/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Partitioned CDB64 Reader - Reads from prefix-partitioned CDB64 indexes.
 *
 * This reader handles lookups across multiple CDB64 partition files based on
 * the first byte of the key. Partition files can be stored locally or accessed
 * remotely via HTTP or Arweave transactions.
 *
 * ## Features
 * - Lazy partition opening: only opens partitions on first access
 * - Multiple location types: local files, HTTP, Arweave ID, byte-range
 * - Caching for remote sources to reduce network round trips
 * - Graceful error handling: logs errors and returns undefined
 *
 * ## Usage
 * ```typescript
 * const manifest = parseManifest(await fs.readFile('manifest.json', 'utf-8'));
 * const reader = new PartitionedCdb64Reader({
 *   manifest,
 *   baseDir: '/path/to/index/',
 * });
 * await reader.open();
 * const value = await reader.get(key);
 * await reader.close();
 * ```
 */

import * as path from 'node:path';
import winston from 'winston';

import { Cdb64Reader } from './cdb64.js';
import { FileByteRangeSource, ByteRangeSource } from './byte-range-source.js';
import { HttpByteRangeSource } from './http-byte-range-source.js';
import { ContiguousDataByteRangeSource } from './contiguous-data-byte-range-source.js';
import { CachingByteRangeSource } from './caching-byte-range-source.js';
import { Semaphore } from './semaphore.js';
import {
  Cdb64Manifest,
  PartitionInfo,
  PartitionLocation,
  prefixToIndex,
} from './cdb64-manifest.js';
import { ContiguousDataSource } from '../types.js';

/**
 * State for a partition reader.
 */
interface PartitionState {
  reader: Cdb64Reader;
  source: ByteRangeSource;
}

/**
 * Options for creating a PartitionedCdb64Reader.
 */
export interface PartitionedCdb64ReaderOptions {
  /** The manifest describing the partitioned index */
  manifest: Cdb64Manifest;

  /** Base directory for resolving file locations (required for file locations) */
  baseDir?: string;

  /** ContiguousDataSource for Arweave data (required for arweave-* locations) */
  contiguousDataSource?: ContiguousDataSource;

  /** Maximum regions to cache for remote sources (default: 100) */
  remoteCacheMaxRegions?: number;

  /** TTL for cached regions in ms (default: 300000 = 5 minutes) */
  remoteCacheTtlMs?: number;

  /** Timeout for remote requests in ms (default: 30000) */
  remoteRequestTimeoutMs?: number;

  /** Shared semaphore for limiting concurrent HTTP requests */
  remoteSemaphore?: Semaphore;

  /** Timeout for acquiring the semaphore in ms (default: 5000) */
  remoteSemaphoreTimeoutMs?: number;

  /** Logger instance */
  log?: winston.Logger;
}

/**
 * Partitioned CDB64 Reader - Reads from prefix-partitioned CDB64 indexes.
 */
export class PartitionedCdb64Reader {
  private manifest: Cdb64Manifest;
  private baseDir?: string;
  private contiguousDataSource?: ContiguousDataSource;
  private remoteCacheMaxRegions: number;
  private remoteCacheTtlMs: number;
  private remoteRequestTimeoutMs: number;
  private remoteSemaphore?: Semaphore;
  private remoteSemaphoreTimeoutMs?: number;
  private log: winston.Logger;

  // Map from prefix (00-ff) to partition state
  // undefined = partition exists but not yet opened
  // null = partition does not exist in manifest
  private partitions: (PartitionState | undefined | null)[] = new Array(256);

  // Quick lookup from prefix to partition info
  private partitionInfoByPrefix: Map<string, PartitionInfo> = new Map();

  // Track in-flight partition opens to dedupe concurrent requests
  private partitionOpenPromises: Map<number, Promise<PartitionState | null>> =
    new Map();

  private opened = false;

  constructor(options: PartitionedCdb64ReaderOptions) {
    this.manifest = options.manifest;
    this.baseDir = options.baseDir;
    this.contiguousDataSource = options.contiguousDataSource;
    this.remoteCacheMaxRegions = options.remoteCacheMaxRegions ?? 100;
    this.remoteCacheTtlMs = options.remoteCacheTtlMs ?? 300000;
    this.remoteRequestTimeoutMs = options.remoteRequestTimeoutMs ?? 30000;
    this.remoteSemaphore = options.remoteSemaphore;
    this.remoteSemaphoreTimeoutMs = options.remoteSemaphoreTimeoutMs;
    this.log =
      options.log ??
      winston.createLogger({
        silent: true,
      });

    // Build prefix lookup and initialize partition states
    for (let i = 0; i < 256; i++) {
      this.partitions[i] = null; // Default: partition doesn't exist
    }

    for (const partition of this.manifest.partitions) {
      const index = prefixToIndex(partition.prefix);
      this.partitionInfoByPrefix.set(partition.prefix, partition);
      this.partitions[index] = undefined; // Partition exists but not opened
    }
  }

  /**
   * Opens the reader. This doesn't open any partition readers yet -
   * they are opened lazily on first access.
   */
  async open(): Promise<void> {
    this.opened = true;
  }

  /**
   * Looks up a key in the partitioned index.
   *
   * @param key - The key to look up (must be at least 1 byte)
   * @returns The value if found, undefined otherwise
   */
  async get(key: Buffer): Promise<Buffer | undefined> {
    if (!this.opened) {
      throw new Error('Reader not opened. Call open() first.');
    }

    if (key.length === 0) {
      throw new Error('Key must be at least 1 byte');
    }

    const partitionIndex = key[0];
    const partitionState = this.partitions[partitionIndex];

    // Partition doesn't exist in manifest
    if (partitionState === null) {
      return undefined;
    }

    // Lazily open partition (with deduplication of concurrent opens)
    if (partitionState === undefined) {
      const prefix = partitionIndex.toString(16).padStart(2, '0');
      const partitionInfo = this.partitionInfoByPrefix.get(prefix);

      if (partitionInfo === undefined) {
        // Shouldn't happen, but handle gracefully
        this.log.warn('Partition info not found for prefix', { prefix });
        this.partitions[partitionIndex] = null;
        return undefined;
      }

      // Check for in-flight open to prevent concurrent opens from leaking readers
      let openPromise = this.partitionOpenPromises.get(partitionIndex);
      if (openPromise === undefined) {
        // Start new open and track it
        openPromise = this.openPartition(partitionInfo)
          .then((state) => {
            this.partitions[partitionIndex] = state;
            return state;
          })
          .catch((error) => {
            if (this.isConfigurationError(error)) {
              throw error;
            }
            this.log.debug('Failed to open partition', {
              prefix,
              error: error instanceof Error ? error.message : String(error),
            });
            this.partitions[partitionIndex] = null;
            return null;
          })
          .finally(() => {
            this.partitionOpenPromises.delete(partitionIndex);
          });
        this.partitionOpenPromises.set(partitionIndex, openPromise);
      }

      // Await the shared promise
      const result = await openPromise;
      if (result === null) {
        return undefined;
      }
    }

    // At this point, partitions[partitionIndex] should be a PartitionState
    const state = this.partitions[partitionIndex] as PartitionState | null;
    if (state === null) {
      return undefined;
    }

    // Perform lookup
    try {
      return await state.reader.get(key);
    } catch (error) {
      this.log.debug('Partition lookup error', {
        prefix: partitionIndex.toString(16).padStart(2, '0'),
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * Opens a partition reader based on its location type.
   */
  private async openPartition(
    partitionInfo: PartitionInfo,
  ): Promise<PartitionState> {
    const source = await this.createByteRangeSource(partitionInfo);
    const reader = Cdb64Reader.fromSource(source, true);
    await reader.open();

    return { reader, source };
  }

  /**
   * Creates a ByteRangeSource for a partition location.
   */
  private async createByteRangeSource(
    partitionInfo: PartitionInfo,
  ): Promise<ByteRangeSource> {
    const location = partitionInfo.location;
    switch (location.type) {
      case 'file': {
        if (this.baseDir === undefined) {
          throw new Error('baseDir is required for file partition locations');
        }
        const filePath = path.resolve(this.baseDir, location.filename);
        const source = new FileByteRangeSource(filePath);
        await source.open();
        return source;
      }

      case 'http': {
        const httpSource = new HttpByteRangeSource({
          url: location.url,
          timeout: this.remoteRequestTimeoutMs,
          semaphore: this.remoteSemaphore,
          semaphoreTimeoutMs: this.remoteSemaphoreTimeoutMs,
        });
        return new CachingByteRangeSource({
          source: httpSource,
          ownsSource: true,
          cacheMaxSize: this.remoteCacheMaxRegions,
          cacheTtlMs: this.remoteCacheTtlMs,
        });
      }

      case 'arweave-id': {
        if (this.contiguousDataSource === undefined) {
          throw new Error(
            'contiguousDataSource is required for arweave-id partition locations',
          );
        }
        const txSource = new ContiguousDataByteRangeSource({
          dataSource: this.contiguousDataSource,
          id: location.id,
        });
        return new CachingByteRangeSource({
          source: txSource,
          ownsSource: true,
          cacheMaxSize: this.remoteCacheMaxRegions,
          cacheTtlMs: this.remoteCacheTtlMs,
        });
      }

      case 'arweave-byte-range': {
        if (this.contiguousDataSource === undefined) {
          throw new Error(
            'contiguousDataSource is required for arweave-byte-range partition locations',
          );
        }
        const bundleSource = new ContiguousDataByteRangeSource({
          dataSource: this.contiguousDataSource,
          id: location.rootTxId,
          baseOffset: location.dataOffsetInRootTx,
          totalSize: partitionInfo.size,
        });
        return new CachingByteRangeSource({
          source: bundleSource,
          ownsSource: true,
          cacheMaxSize: this.remoteCacheMaxRegions,
          cacheTtlMs: this.remoteCacheTtlMs,
        });
      }

      default: {
        // Should be unreachable if manifest validation is correct
        const exhaustiveCheck: never = location;
        throw new Error(
          `Unknown partition location type: ${(exhaustiveCheck as PartitionLocation).type}`,
        );
      }
    }
  }

  /**
   * Checks if an error is a configuration error that should be propagated.
   * Configuration errors indicate problems with how the reader was set up,
   * not runtime issues like missing files or network problems.
   */
  private isConfigurationError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const configErrorPatterns = [
      'baseDir is required',
      'contiguousDataSource is required',
      'Unknown partition location type',
    ];

    return configErrorPatterns.some((pattern) =>
      error.message.includes(pattern),
    );
  }

  /**
   * Closes the reader and all open partition readers.
   */
  async close(): Promise<void> {
    const closePromises: Promise<void>[] = [];

    for (const state of this.partitions) {
      if (state !== null && state !== undefined) {
        closePromises.push(state.reader.close());
      }
    }

    await Promise.allSettled(closePromises);

    // Clear any in-flight opens
    this.partitionOpenPromises.clear();

    // Reset partition states
    for (let i = 0; i < 256; i++) {
      const partitionInfo = this.partitionInfoByPrefix.get(
        i.toString(16).padStart(2, '0'),
      );
      this.partitions[i] = partitionInfo !== undefined ? undefined : null;
    }

    this.opened = false;
  }

  /**
   * Checks if the reader is open.
   */
  isOpen(): boolean {
    return this.opened;
  }

  /**
   * Returns the manifest this reader is using.
   */
  getManifest(): Cdb64Manifest {
    return this.manifest;
  }

  /**
   * Returns the number of partitions that have been opened.
   */
  getOpenPartitionCount(): number {
    return this.partitions.filter((s) => s != null).length;
  }

  /**
   * Returns the total number of partitions in the manifest.
   */
  getTotalPartitionCount(): number {
    return this.manifest.partitions.length;
  }
}
