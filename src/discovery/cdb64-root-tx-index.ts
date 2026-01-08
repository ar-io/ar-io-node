/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * CDB64-based Root TX Index
 *
 * Provides O(1) lookups of data item ID → root transaction ID mappings
 * from pre-built CDB64 files. Supports multiple source types:
 *
 * - Local files and directories (with optional file watching)
 * - Arweave transactions (via ContiguousDataSource)
 * - Bundle data items with offset addressing (for unindexed bundles)
 * - HTTP URLs (S3, CDN, dedicated index servers)
 *
 * Source format examples:
 *   - "data/cdb64-root-tx-index" - Local path (file or directory)
 *   - "ABC123def456..." - Arweave TX ID (43-char base64url)
 *   - "TxId:1024:500000" - Bundle data item (txId:offset:size)
 *   - "https://example.com/index.cdb" - HTTP URL
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { watch, FSWatcher } from 'chokidar';
import winston from 'winston';
import { ContiguousDataSource, DataItemRootIndex } from '../types.js';
import { Cdb64Reader } from '../lib/cdb64.js';
import {
  ByteRangeSource,
  FileByteRangeSource,
} from '../lib/byte-range-source.js';
import { HttpByteRangeSource } from '../lib/http-byte-range-source.js';
import { ContiguousDataByteRangeSource } from '../lib/contiguous-data-byte-range-source.js';
import { CachingByteRangeSource } from '../lib/caching-byte-range-source.js';
import { decodeCdb64Value, isCompleteValue } from '../lib/cdb64-encoding.js';
import { fromB64Url, toB64Url } from '../lib/encoding.js';

/** Valid CDB64 file extensions */
const CDB64_EXTENSIONS = ['.cdb', '.cdb64'];

/** Check if a file path has a valid CDB64 extension */
function isCdb64File(filePath: string): boolean {
  return CDB64_EXTENSIONS.some((ext) => filePath.endsWith(ext));
}

/** Parsed source specification */
type ParsedSource =
  | { type: 'file'; path: string }
  | { type: 'directory'; path: string }
  | { type: 'arweave-tx'; id: string }
  | { type: 'arweave-bundle-item'; id: string; offset: number; size: number }
  | { type: 'http'; url: string };

/**
 * Parses a source specification string into a structured format.
 *
 * Supported formats:
 * - HTTP URLs: "https://..." or "http://..."
 * - Arweave TX ID: 43-char base64url string
 * - Bundle data item: "txId:offset:size" (colon-separated)
 * - Local path: anything else (file or directory, determined at runtime)
 */
function parseSourceSpec(spec: string): ParsedSource {
  // HTTP URL
  if (spec.startsWith('http://') || spec.startsWith('https://')) {
    return { type: 'http', url: spec };
  }

  // Check for bundle data item format: txId:offset:size
  const colonParts = spec.split(':');
  if (colonParts.length === 3) {
    const [id, offsetStr, sizeStr] = colonParts;
    // Validate that it looks like a TX ID (43 chars, base64url)
    if (/^[A-Za-z0-9_-]{43}$/.test(id)) {
      const offset = parseInt(offsetStr, 10);
      const size = parseInt(sizeStr, 10);

      if (!isNaN(offset) && !isNaN(size) && offset >= 0 && size > 0) {
        return { type: 'arweave-bundle-item', id, offset, size };
      }
    }
  }

  // Simple Arweave TX ID (43 chars, base64url, no colons)
  if (/^[A-Za-z0-9_-]{43}$/.test(spec)) {
    return { type: 'arweave-tx', id: spec };
  }

  // Default to local path (file vs directory determined at runtime)
  return { type: 'file', path: spec };
}

/** Reader entry with metadata for logging */
interface ReaderEntry {
  reader: Cdb64Reader;
  sourceSpec: string;
  sourceType: string;
}

export class Cdb64RootTxIndex implements DataItemRootIndex {
  private log: winston.Logger;
  private readers: ReaderEntry[] = [];
  private readerMap: Map<string, ReaderEntry> = new Map();
  private sources: string[];
  private initialized = false;
  private initializationPromise: Promise<void> | null = null;
  private watchEnabled: boolean;
  private watcher: FSWatcher | null = null;
  private watchedDirectory: string | null = null;

  // Dependencies for remote sources
  private contiguousDataSource?: ContiguousDataSource;

  // Cache configuration
  private remoteCacheMaxRegions: number;
  private remoteCacheTtlMs: number;
  private remoteRequestTimeoutMs: number;

  constructor({
    log,
    sources,
    watch = true,
    contiguousDataSource,
    remoteCacheMaxRegions = 100,
    remoteCacheTtlMs = 300000,
    remoteRequestTimeoutMs = 30000,
  }: {
    log: winston.Logger;
    /** List of source specifications (local paths, TX IDs, URLs) */
    sources: string[];
    /** Enable file watching for local directories (default: true) */
    watch?: boolean;
    /** ContiguousDataSource for Arweave-based sources (required for TX/bundle sources) */
    contiguousDataSource?: ContiguousDataSource;
    /** Max cached regions per remote source (default: 100) */
    remoteCacheMaxRegions?: number;
    /** TTL for cached regions in ms (default: 300000 = 5 minutes) */
    remoteCacheTtlMs?: number;
    /** Request timeout for remote sources in ms (default: 30000 = 30 seconds) */
    remoteRequestTimeoutMs?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.sources = sources;
    this.watchEnabled = watch;
    this.contiguousDataSource = contiguousDataSource;
    this.remoteCacheMaxRegions = remoteCacheMaxRegions;
    this.remoteCacheTtlMs = remoteCacheTtlMs;
    this.remoteRequestTimeoutMs = remoteRequestTimeoutMs;
  }

  /**
   * Creates a ByteRangeSource for a parsed source specification.
   */
  private createByteRangeSource(parsed: ParsedSource): ByteRangeSource {
    switch (parsed.type) {
      case 'file':
        return new FileByteRangeSource(parsed.path);

      case 'http':
        return new CachingByteRangeSource({
          source: new HttpByteRangeSource({
            url: parsed.url,
            timeout: this.remoteRequestTimeoutMs,
          }),
          cacheMaxSize: this.remoteCacheMaxRegions,
          cacheTtlMs: this.remoteCacheTtlMs,
        });

      case 'arweave-tx':
        if (!this.contiguousDataSource) {
          throw new Error(
            'ContiguousDataSource required for Arweave TX sources',
          );
        }
        return new CachingByteRangeSource({
          source: new ContiguousDataByteRangeSource({
            dataSource: this.contiguousDataSource,
            id: parsed.id,
          }),
          cacheMaxSize: this.remoteCacheMaxRegions,
          cacheTtlMs: this.remoteCacheTtlMs,
        });

      case 'arweave-bundle-item':
        if (!this.contiguousDataSource) {
          throw new Error(
            'ContiguousDataSource required for Arweave bundle item sources',
          );
        }
        return new CachingByteRangeSource({
          source: new ContiguousDataByteRangeSource({
            dataSource: this.contiguousDataSource,
            id: parsed.id,
            baseOffset: parsed.offset,
            totalSize: parsed.size,
          }),
          cacheMaxSize: this.remoteCacheMaxRegions,
          cacheTtlMs: this.remoteCacheTtlMs,
        });

      default:
        throw new Error(`Unknown source type: ${(parsed as any).type}`);
    }
  }

  /**
   * Creates a reader for a single source specification.
   */
  private async createReader(sourceSpec: string): Promise<ReaderEntry> {
    const parsed = parseSourceSpec(sourceSpec);

    // For file paths, check if it's actually a directory
    if (parsed.type === 'file') {
      try {
        const stat = await fs.stat(parsed.path);
        if (stat.isDirectory()) {
          // Return a placeholder - directories are handled specially
          throw new Error('DIRECTORY');
        }
      } catch (error: any) {
        if (error.message === 'DIRECTORY') {
          throw error;
        }
        // File doesn't exist or can't be stat'd - will fail on open
      }
    }

    const source = this.createByteRangeSource(parsed);
    const reader = Cdb64Reader.fromSource(source, true);

    await reader.open();

    return {
      reader,
      sourceSpec,
      sourceType: parsed.type,
    };
  }

  /**
   * Discovers CDB64 files from a directory path.
   */
  private async discoverFilesInDirectory(dirPath: string): Promise<string[]> {
    const entries = await fs.readdir(dirPath);
    return entries
      .filter(isCdb64File)
      .sort() // Alphabetical order for deterministic behavior
      .map((f) => path.join(dirPath, f));
  }

  /**
   * Starts watching a directory for CDB64 file changes.
   */
  private startWatching(dirPath: string): void {
    if (!this.watchEnabled) return;

    this.watchedDirectory = dirPath;
    this.watcher = watch(dirPath, {
      ignored: (filePath: string) => {
        return !isCdb64File(filePath) && filePath !== dirPath;
      },
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 1000,
        pollInterval: 100,
      },
      depth: 0,
    });

    this.watcher.on('add', async (filePath: string) => {
      if (!isCdb64File(filePath)) return;
      await this.addFileReader(filePath).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log.error('Failed handling CDB64 add event', {
          path: filePath,
          error: message,
        });
      });
    });

    this.watcher.on('unlink', async (filePath: string) => {
      if (!isCdb64File(filePath)) return;
      await this.removeReader(filePath).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log.error('Failed handling CDB64 unlink event', {
          path: filePath,
          error: message,
        });
      });
    });

    this.watcher.on('error', (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error('CDB64 file watcher error', { error: message });
    });

    this.log.info('CDB64 file watcher started', { path: dirPath });
  }

  /**
   * Stops watching the directory.
   */
  private async stopWatching(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
      this.watchedDirectory = null;
      this.log.info('CDB64 file watcher stopped');
    }
  }

  /**
   * Adds a reader for a local CDB64 file (used by file watcher).
   */
  private async addFileReader(filePath: string): Promise<void> {
    if (this.readerMap.has(filePath)) return;

    let reader: Cdb64Reader | undefined;
    try {
      const source = new FileByteRangeSource(filePath);
      reader = Cdb64Reader.fromSource(source, true);
      await reader.open();

      // Verify file still exists after opening
      await fs.stat(filePath);

      const entry = { reader, sourceSpec: filePath, sourceType: 'file' };
      this.readerMap.set(filePath, entry);
      this.rebuildReaderList();
      this.log.info('CDB64 file added', { path: filePath });
    } catch (error: any) {
      if (reader?.isOpen()) {
        try {
          await reader.close();
        } catch {
          // Ignore close errors during cleanup
        }
      }

      if (error.code !== 'ENOENT') {
        this.log.error('Failed to add CDB64 file', {
          path: filePath,
          error: error.message,
        });
      } else {
        this.log.debug('CDB64 file no longer exists, skipping', {
          path: filePath,
        });
      }
    }
  }

  /**
   * Removes a reader by its source specification key.
   */
  private async removeReader(key: string): Promise<void> {
    const entry = this.readerMap.get(key);
    if (!entry) return;

    try {
      if (entry.reader.isOpen()) {
        await entry.reader.close();
      }
      this.readerMap.delete(key);
      this.rebuildReaderList();
      this.log.info('CDB64 source removed', {
        source: key,
        type: entry.sourceType,
      });
    } catch (error: any) {
      this.log.error('Failed to remove CDB64 source', {
        source: key,
        error: error.message,
      });
    }
  }

  /**
   * Rebuilds the readers array from the readerMap in sorted order.
   */
  private rebuildReaderList(): void {
    const sortedKeys = [...this.readerMap.keys()].sort();
    this.readers = sortedKeys.map((k) => this.readerMap.get(k)!);
  }

  /**
   * Initializes the readers for all configured sources.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.initializationPromise !== null) {
      return this.initializationPromise;
    }

    this.initializationPromise = this.doInitialize();

    try {
      await this.initializationPromise;
    } finally {
      this.initializationPromise = null;
    }
  }

  /**
   * Performs the actual initialization work.
   */
  private async doInitialize(): Promise<void> {
    try {
      for (const sourceSpec of this.sources) {
        try {
          const entry = await this.createReader(sourceSpec);
          this.readerMap.set(sourceSpec, entry);
          this.log.info('CDB64 source initialized', {
            source: sourceSpec,
            type: entry.sourceType,
          });
        } catch (error: any) {
          // Handle directory sources
          if (error.message === 'DIRECTORY') {
            const parsed = parseSourceSpec(sourceSpec);
            if (parsed.type === 'file') {
              const dirPath = parsed.path;
              const files = await this.discoverFilesInDirectory(dirPath);

              if (files.length === 0) {
                this.log.warn('No CDB64 files found in directory', {
                  path: dirPath,
                });
              }

              for (const filePath of files) {
                try {
                  const source = new FileByteRangeSource(filePath);
                  const reader = Cdb64Reader.fromSource(source, true);
                  await reader.open();
                  this.readerMap.set(filePath, {
                    reader,
                    sourceSpec: filePath,
                    sourceType: 'file',
                  });
                } catch (fileError: any) {
                  this.log.error(
                    'Failed to initialize CDB64 file in directory',
                    {
                      path: filePath,
                      error: fileError.message,
                    },
                  );
                  // Continue with other files
                }
              }

              // Start watching this directory
              this.startWatching(dirPath);
            }
          } else {
            this.log.error('Failed to initialize CDB64 source', {
              source: sourceSpec,
              error: error.message,
            });
            // Continue with other sources - don't fail completely
          }
        }
      }

      this.rebuildReaderList();
      this.initialized = true;

      this.log.info('CDB64 root TX index initialized', {
        sourceCount: this.sources.length,
        readerCount: this.readers.length,
        watching: this.watchedDirectory !== null,
      });
    } catch (error: any) {
      // Close any readers that were opened before the failure
      await Promise.allSettled(
        [...this.readerMap.values()].map((e) =>
          e.reader.isOpen() ? e.reader.close() : Promise.resolve(),
        ),
      );
      this.readerMap.clear();
      this.readers = [];

      this.log.error('Failed to initialize CDB64 root TX index', {
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Looks up a data item ID and returns its root transaction information.
   */
  async getRootTx(id: string): Promise<
    | {
        rootTxId: string;
        rootOffset?: number;
        rootDataOffset?: number;
        contentType?: string;
        size?: number;
        dataSize?: number;
      }
    | undefined
  > {
    try {
      await this.ensureInitialized();
    } catch {
      return undefined;
    }

    // Convert base64url ID to 32-byte binary key
    let keyBuffer: Buffer;
    try {
      keyBuffer = fromB64Url(id);
    } catch {
      this.log.debug('Invalid base64url encoding for data item ID', { id });
      return undefined;
    }

    if (keyBuffer.length !== 32) {
      this.log.debug('Invalid data item ID length', {
        id,
        length: keyBuffer.length,
      });
      return undefined;
    }

    // Snapshot readers array to avoid issues during iteration
    const currentReaders = this.readers;

    // Search through all readers in order (first match wins)
    for (const entry of currentReaders) {
      try {
        const valueBuffer = await entry.reader.get(keyBuffer);

        if (valueBuffer !== undefined) {
          const value = decodeCdb64Value(valueBuffer);
          const rootTxId = toB64Url(value.rootTxId);

          if (isCompleteValue(value)) {
            return {
              rootTxId,
              rootOffset: value.rootDataItemOffset,
              rootDataOffset: value.rootDataOffset,
            };
          }

          return { rootTxId };
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.debug('Error reading from CDB64 source, trying next', {
          id,
          source: entry.sourceSpec,
          type: entry.sourceType,
          error: message,
        });
        continue;
      }
    }

    return undefined;
  }

  /**
   * Closes all readers and stops watching.
   */
  async close(): Promise<void> {
    await this.stopWatching();

    for (const entry of this.readers) {
      if (entry.reader.isOpen()) {
        await entry.reader.close();
      }
    }

    if (this.readers.length > 0) {
      this.log.info('CDB64 root TX index closed', {
        readerCount: this.readers.length,
      });
    }

    this.readerMap.clear();
    this.readers = [];
    this.initialized = false;
  }
}
