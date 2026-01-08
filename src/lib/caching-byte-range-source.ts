/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { LRUCache } from 'lru-cache';
import { ByteRangeSource } from './byte-range-source.js';

/** Default size of the CDB64 header in bytes */
const CDB64_HEADER_SIZE = 4096;

/**
 * ByteRangeSource wrapper that caches byte ranges for improved performance.
 *
 * Designed specifically for CDB64 access patterns:
 * - The header (first 4KB) is cached permanently (critical for every lookup)
 * - Other regions use an LRU cache with configurable size and TTL
 *
 * This significantly reduces network round trips for remote sources by:
 * 1. Eliminating the header fetch after the first lookup
 * 2. Caching frequently accessed hash table regions
 */
export class CachingByteRangeSource implements ByteRangeSource {
  private source: ByteRangeSource;
  private ownsSource: boolean;

  /** Permanent cache for the header */
  private headerCache: Buffer | null = null;
  private headerSize: number;

  /** LRU cache for other byte ranges */
  private regionCache: LRUCache<string, Buffer>;

  constructor({
    source,
    ownsSource = true,
    headerSize = CDB64_HEADER_SIZE,
    cacheMaxSize = 100,
    cacheTtlMs = 300000, // 5 minutes
  }: {
    /** The underlying ByteRangeSource to wrap */
    source: ByteRangeSource;
    /** If true (default), close() will also close the underlying source */
    ownsSource?: boolean;
    /** Size of the header to cache permanently (default: 4096 for CDB64) */
    headerSize?: number;
    /** Maximum number of regions to cache (default: 100) */
    cacheMaxSize?: number;
    /** TTL for cached regions in milliseconds (default: 300000 = 5 minutes) */
    cacheTtlMs?: number;
  }) {
    this.source = source;
    this.ownsSource = ownsSource;
    this.headerSize = headerSize;

    this.regionCache = new LRUCache<string, Buffer>({
      max: cacheMaxSize,
      ttl: cacheTtlMs,
    });
  }

  async read(offset: number, size: number): Promise<Buffer> {
    // Check if this read is entirely within the header region
    if (offset + size <= this.headerSize) {
      return this.readFromHeader(offset, size);
    }

    // Check if this read starts in the header but extends beyond
    if (offset < this.headerSize) {
      // Split the read: header part + beyond header part
      const headerPart = await this.readFromHeader(
        offset,
        this.headerSize - offset,
      );
      const beyondPart = await this.readRegion(
        this.headerSize,
        offset + size - this.headerSize,
      );
      return Buffer.concat([headerPart, beyondPart]);
    }

    // Read is entirely beyond the header
    return this.readRegion(offset, size);
  }

  /**
   * Reads from the permanently cached header.
   */
  private async readFromHeader(offset: number, size: number): Promise<Buffer> {
    // Ensure header is cached
    if (this.headerCache === null) {
      this.headerCache = await this.source.read(0, this.headerSize);
    }

    // Return the requested slice
    return this.headerCache.subarray(offset, offset + size);
  }

  /**
   * Reads a region with LRU caching.
   */
  private async readRegion(offset: number, size: number): Promise<Buffer> {
    const cacheKey = `${offset}:${size}`;

    // Check cache first
    const cached = this.regionCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    // Fetch from source
    const data = await this.source.read(offset, size);

    // Cache the result
    this.regionCache.set(cacheKey, data);

    return data;
  }

  async close(): Promise<void> {
    if (this.ownsSource) {
      await this.source.close();
    }
    this.headerCache = null;
    this.regionCache.clear();
  }

  isOpen(): boolean {
    return this.source.isOpen();
  }

  /**
   * Returns the underlying ByteRangeSource.
   */
  getSource(): ByteRangeSource {
    return this.source;
  }

  /**
   * Clears all caches without closing the source.
   */
  clearCache(): void {
    this.headerCache = null;
    this.regionCache.clear();
  }

  /**
   * Returns cache statistics for monitoring.
   */
  getCacheStats(): {
    headerCached: boolean;
    regionCacheSize: number;
  } {
    return {
      headerCached: this.headerCache !== null,
      regionCacheSize: this.regionCache.size,
    };
  }
}
