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
import {
  decodeCdb64Value,
  isCompleteValue,
  isPathCompleteValue,
  getRootTxId,
  getPath,
} from '../lib/cdb64-encoding.js';
import { fromB64Url, toB64Url } from '../lib/encoding.js';
import { PartitionedCdb64Reader } from '../lib/partitioned-cdb64-reader.js';
import { Cdb64Manifest, parseManifest } from '../lib/cdb64-manifest.js';

/** Valid CDB64 file extensions */
const CDB64_EXTENSIONS = ['.cdb', '.cdb64'];

/** Check if a file path has a valid CDB64 extension */
function isCdb64File(filePath: string): boolean {
  return CDB64_EXTENSIONS.some((ext) => filePath.endsWith(ext));
}

/** Parsed source specification */
type ParsedSource =
  | { type: 'file'; path: string }
  | { type: 'arweave-tx'; id: string }
  | { type: 'arweave-bundle-item'; id: string; offset: number; size: number }
  | { type: 'http'; url: string }
  | { type: 'partitioned-directory'; path: string }
  | { type: 'partitioned-http'; url: string }
  | { type: 'partitioned-arweave-tx'; id: string }
  | {
      type: 'partitioned-arweave-bundle-item';
      id: string;
      offset: number;
      size: number;
    };

/**
 * Parses a source specification string into a structured format.
 *
 * Supported formats:
 * - HTTP URLs: "https://..." or "http://..."
 * - HTTP URL ending in /manifest.json: partitioned HTTP source
 * - Arweave TX ID: 43-char base64url string
 * - Arweave TX ID with :manifest suffix: partitioned Arweave TX
 * - Bundle data item: "txId:offset:size" (colon-separated)
 * - Bundle data item with :manifest suffix: partitioned bundle item
 * - Local path: anything else (file or directory, determined at runtime)
 *
 * Note: For local paths, partitioned directories are detected at runtime
 * by checking for the presence of manifest.json in the directory.
 */
function parseSourceSpec(spec: string): ParsedSource {
  // HTTP URL
  if (spec.startsWith('http://') || spec.startsWith('https://')) {
    try {
      new URL(spec);
      // Check if URL ends with /manifest.json (partitioned HTTP)
      if (spec.endsWith('/manifest.json')) {
        return { type: 'partitioned-http', url: spec };
      }
      return { type: 'http', url: spec };
    } catch {
      throw new Error(`Invalid HTTP URL: ${spec}`);
    }
  }

  // Check for bundle data item format: txId:offset:size or txId:offset:size:manifest
  const colonParts = spec.split(':');

  // txId:offset:size:manifest format (partitioned bundle item)
  if (colonParts.length === 4 && colonParts[3] === 'manifest') {
    const [id, offsetStr, sizeStr] = colonParts;
    if (/^[A-Za-z0-9_-]{43}$/.test(id)) {
      const offset = parseInt(offsetStr, 10);
      const size = parseInt(sizeStr, 10);

      if (!isNaN(offset) && !isNaN(size) && offset >= 0 && size > 0) {
        return { type: 'partitioned-arweave-bundle-item', id, offset, size };
      }
    }
  }

  // txId:offset:size format (regular bundle item)
  if (colonParts.length === 3) {
    const [id, offsetStr, sizeStr] = colonParts;
    if (/^[A-Za-z0-9_-]{43}$/.test(id)) {
      const offset = parseInt(offsetStr, 10);
      const size = parseInt(sizeStr, 10);

      if (!isNaN(offset) && !isNaN(size) && offset >= 0 && size > 0) {
        return { type: 'arweave-bundle-item', id, offset, size };
      }
    }
  }

  // txId:manifest format (partitioned Arweave TX)
  if (colonParts.length === 2 && colonParts[1] === 'manifest') {
    const id = colonParts[0];
    if (/^[A-Za-z0-9_-]{43}$/.test(id)) {
      return { type: 'partitioned-arweave-tx', id };
    }
  }

  // Simple Arweave TX ID (43 chars, base64url, no colons)
  if (/^[A-Za-z0-9_-]{43}$/.test(spec)) {
    return { type: 'arweave-tx', id: spec };
  }

  // Default to local path (file vs directory/partitioned determined at runtime)
  return { type: 'file', path: spec };
}

/** Reader entry with metadata for logging (supports both single-file and partitioned readers) */
interface ReaderEntry {
  reader: Cdb64Reader | PartitionedCdb64Reader;
  sourceSpec: string;
  sourceType: string;
  isPartitioned: boolean;
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
  private remoteMaxConcurrentRequests?: number;

  constructor({
    log,
    sources,
    watch = true,
    contiguousDataSource,
    remoteCacheMaxRegions = 100,
    remoteCacheTtlMs = 300000,
    remoteRequestTimeoutMs = 30000,
    remoteMaxConcurrentRequests,
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
    /** Max concurrent HTTP requests per source (undefined = unlimited) */
    remoteMaxConcurrentRequests?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.sources = sources;
    this.watchEnabled = watch;
    this.contiguousDataSource = contiguousDataSource;
    this.remoteCacheMaxRegions = remoteCacheMaxRegions;
    this.remoteCacheTtlMs = remoteCacheTtlMs;
    this.remoteRequestTimeoutMs = remoteRequestTimeoutMs;
    this.remoteMaxConcurrentRequests = remoteMaxConcurrentRequests;
  }

  /**
   * Wraps a ByteRangeSource with caching using the configured cache settings.
   */
  private wrapWithCache(source: ByteRangeSource): CachingByteRangeSource {
    return new CachingByteRangeSource({
      source,
      cacheMaxSize: this.remoteCacheMaxRegions,
      cacheTtlMs: this.remoteCacheTtlMs,
    });
  }

  /**
   * Collects an async stream into a string.
   */
  private async streamToString(
    stream: AsyncIterable<Uint8Array | Buffer>,
  ): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf-8');
  }

  /**
   * Creates a ByteRangeSource for a parsed source specification.
   */
  private createByteRangeSource(parsed: ParsedSource): ByteRangeSource {
    switch (parsed.type) {
      case 'file':
        return new FileByteRangeSource(parsed.path);

      case 'http':
        return this.wrapWithCache(
          new HttpByteRangeSource({
            url: parsed.url,
            timeout: this.remoteRequestTimeoutMs,
            maxConcurrentRequests: this.remoteMaxConcurrentRequests,
          }),
        );

      case 'arweave-tx':
        if (!this.contiguousDataSource) {
          throw new Error(
            'ContiguousDataSource required for Arweave TX sources',
          );
        }
        return this.wrapWithCache(
          new ContiguousDataByteRangeSource({
            dataSource: this.contiguousDataSource,
            id: parsed.id,
          }),
        );

      case 'arweave-bundle-item':
        if (!this.contiguousDataSource) {
          throw new Error(
            'ContiguousDataSource required for Arweave bundle item sources',
          );
        }
        return this.wrapWithCache(
          new ContiguousDataByteRangeSource({
            dataSource: this.contiguousDataSource,
            id: parsed.id,
            baseOffset: parsed.offset,
            totalSize: parsed.size,
          }),
        );

      default:
        throw new Error(`Unknown source type: ${(parsed as any).type}`);
    }
  }

  /**
   * Creates a reader for a single source specification.
   * Note: Caller should check for directories before calling this method.
   */
  private async createReader(sourceSpec: string): Promise<ReaderEntry> {
    const parsed = parseSourceSpec(sourceSpec);
    const source = this.createByteRangeSource(parsed);
    const reader = Cdb64Reader.fromSource(source, true);

    await reader.open();

    return {
      reader,
      sourceSpec,
      sourceType: parsed.type,
      isPartitioned: false,
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
   *
   * Note: Only one directory can be watched at a time. If multiple directory
   * sources are configured, only the first will be watched.
   */
  private startWatching(dirPath: string): void {
    if (!this.watchEnabled) return;

    // Only one directory can be watched at a time
    if (this.watchedDirectory !== null && this.watchedDirectory !== dirPath) {
      this.log.warn(
        'Multiple directory sources configured; only one can be watched',
        {
          watchedDirectory: this.watchedDirectory,
          skippedDirectory: dirPath,
        },
      );
      return;
    }

    // Already watching this directory
    if (this.watcher && this.watchedDirectory === dirPath) {
      return;
    }

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
   * Starts watching a partitioned directory's manifest.json for changes.
   */
  private startWatchingManifest(dirPath: string): void {
    if (!this.watchEnabled) return;

    // Only one directory can be watched at a time
    if (this.watchedDirectory !== null && this.watchedDirectory !== dirPath) {
      this.log.warn(
        'Multiple directory sources configured; only one can be watched',
        {
          watchedDirectory: this.watchedDirectory,
          skippedDirectory: dirPath,
        },
      );
      return;
    }

    // Already watching this directory
    if (this.watcher && this.watchedDirectory === dirPath) {
      return;
    }

    this.watchedDirectory = dirPath;
    const manifestPath = path.join(dirPath, 'manifest.json');

    this.watcher = watch(manifestPath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 1000,
        pollInterval: 100,
      },
    });

    this.watcher.on('change', async () => {
      this.log.info('Manifest changed, reloading partitioned index', {
        path: dirPath,
      });
      await this.reloadPartitionedDirectory(dirPath).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log.error(
          'Failed to reload partitioned index after manifest change',
          {
            path: dirPath,
            error: message,
          },
        );
      });
    });

    this.watcher.on('error', (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error('Manifest watcher error', { error: message });
    });

    this.log.info('Manifest watcher started', { path: manifestPath });
  }

  /**
   * Reloads a partitioned directory after manifest change.
   */
  private async reloadPartitionedDirectory(dirPath: string): Promise<void> {
    // Close existing reader
    const existingEntry = this.readerMap.get(dirPath);
    if (existingEntry) {
      if (existingEntry.reader.isOpen()) {
        await existingEntry.reader.close();
      }
      this.readerMap.delete(dirPath);
    }

    // Create new reader with updated manifest
    try {
      const entry = await this.createPartitionedReader(dirPath, {
        type: 'partitioned-directory',
        path: dirPath,
      });
      this.readerMap.set(dirPath, entry);
      this.rebuildReaderList();
      this.log.info('Partitioned CDB64 index reloaded', {
        path: dirPath,
        partitionCount: (
          entry.reader as PartitionedCdb64Reader
        ).getTotalPartitionCount(),
      });
    } catch (error: any) {
      this.log.error('Failed to reload partitioned CDB64 directory', {
        path: dirPath,
        error: error.message,
      });
      this.rebuildReaderList();
    }
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

      const entry: ReaderEntry = {
        reader,
        sourceSpec: filePath,
        sourceType: 'file',
        isPartitioned: false,
      };
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
   * Checks if a local path is a directory.
   * Returns the path if it's a directory, undefined otherwise.
   */
  private async checkIfDirectory(
    sourceSpec: string,
  ): Promise<string | undefined> {
    const parsed = parseSourceSpec(sourceSpec);
    if (parsed.type !== 'file') {
      return undefined;
    }

    try {
      const stat = await fs.stat(parsed.path);
      return stat.isDirectory() ? parsed.path : undefined;
    } catch {
      // File doesn't exist or can't be stat'd - not a directory
      return undefined;
    }
  }

  /**
   * Checks if a directory contains a manifest.json (is a partitioned index).
   */
  private async isPartitionedDirectory(dirPath: string): Promise<boolean> {
    try {
      const manifestPath = path.join(dirPath, 'manifest.json');
      await fs.stat(manifestPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Loads a manifest from a local file.
   */
  private async loadLocalManifest(dirPath: string): Promise<Cdb64Manifest> {
    const manifestPath = path.join(dirPath, 'manifest.json');
    const content = await fs.readFile(manifestPath, 'utf-8');
    return parseManifest(content);
  }

  /**
   * Loads a manifest from a remote source (HTTP or Arweave).
   */
  private async loadRemoteManifest(
    parsed: ParsedSource,
  ): Promise<Cdb64Manifest> {
    switch (parsed.type) {
      case 'partitioned-http': {
        const response = await fetch(parsed.url, {
          signal: AbortSignal.timeout(this.remoteRequestTimeoutMs),
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        const content = await response.text();
        return parseManifest(content);
      }

      case 'partitioned-arweave-tx': {
        if (!this.contiguousDataSource) {
          throw new Error(
            'ContiguousDataSource required for Arweave TX manifest sources',
          );
        }
        const data = await this.contiguousDataSource.getData({
          id: parsed.id,
        });
        const content = await this.streamToString(data.stream);
        return parseManifest(content);
      }

      case 'partitioned-arweave-bundle-item': {
        if (!this.contiguousDataSource) {
          throw new Error(
            'ContiguousDataSource required for Arweave bundle item manifest sources',
          );
        }
        const data = await this.contiguousDataSource.getData({
          id: parsed.id,
          region: {
            offset: parsed.offset,
            size: parsed.size,
          },
        });
        const content = await this.streamToString(data.stream);
        return parseManifest(content);
      }

      default:
        throw new Error(
          `Cannot load manifest from source type: ${(parsed as ParsedSource).type}`,
        );
    }
  }

  /**
   * Creates a partitioned reader for a parsed source specification.
   */
  private async createPartitionedReader(
    sourceSpec: string,
    parsed: ParsedSource,
  ): Promise<ReaderEntry> {
    let manifest: Cdb64Manifest;
    let baseDir: string | undefined;

    switch (parsed.type) {
      case 'partitioned-directory':
        manifest = await this.loadLocalManifest(parsed.path);
        baseDir = parsed.path;
        break;

      case 'partitioned-http': {
        manifest = await this.loadRemoteManifest(parsed);
        // For HTTP, the base URL is the manifest URL without 'manifest.json'
        // Ensure the base URL ends with a trailing slash for proper path concatenation
        let baseUrl = parsed.url.replace(/manifest\.json$/, '');
        if (!baseUrl.endsWith('/')) {
          baseUrl += '/';
        }
        // For HTTP sources, we need to transform the manifest's file locations to HTTP locations
        manifest = this.transformManifestLocationsToHttp(manifest, baseUrl);
        break;
      }

      case 'partitioned-arweave-tx':
      case 'partitioned-arweave-bundle-item':
        manifest = await this.loadRemoteManifest(parsed);
        // For Arweave sources, partitions should already have arweave-* location types
        // in the manifest (they need to be stored as separate TXs or bundle items)
        break;

      default:
        throw new Error(
          `Cannot create partitioned reader for source type: ${(parsed as ParsedSource).type}`,
        );
    }

    const reader = new PartitionedCdb64Reader({
      manifest,
      baseDir,
      contiguousDataSource: this.contiguousDataSource,
      remoteCacheMaxRegions: this.remoteCacheMaxRegions,
      remoteCacheTtlMs: this.remoteCacheTtlMs,
      remoteRequestTimeoutMs: this.remoteRequestTimeoutMs,
      remoteMaxConcurrentRequests: this.remoteMaxConcurrentRequests,
      log: this.log,
    });

    await reader.open();

    return {
      reader,
      sourceSpec,
      sourceType: parsed.type,
      isPartitioned: true,
    };
  }

  /**
   * Transforms file locations in a manifest to HTTP locations using a base URL.
   */
  private transformManifestLocationsToHttp(
    manifest: Cdb64Manifest,
    baseUrl: string,
  ): Cdb64Manifest {
    return {
      ...manifest,
      partitions: manifest.partitions.map((p) => {
        if (p.location.type === 'file') {
          return {
            ...p,
            location: {
              type: 'http' as const,
              url: new URL(p.location.filename, baseUrl).toString(),
            },
          };
        }
        return p;
      }),
    };
  }

  /**
   * Initializes a partitioned directory (has manifest.json).
   */
  private async initializePartitionedDirectory(dirPath: string): Promise<void> {
    try {
      const entry = await this.createPartitionedReader(dirPath, {
        type: 'partitioned-directory',
        path: dirPath,
      });
      this.readerMap.set(dirPath, entry);
      this.log.info('Partitioned CDB64 index initialized', {
        path: dirPath,
        partitionCount: (
          entry.reader as PartitionedCdb64Reader
        ).getTotalPartitionCount(),
      });

      // Watch manifest.json for changes
      this.startWatchingManifest(dirPath);
    } catch (error: any) {
      this.log.error('Failed to initialize partitioned CDB64 directory', {
        path: dirPath,
        error: error.message,
      });
    }
  }

  /**
   * Initializes all CDB64 files from a non-partitioned directory.
   */
  private async initializeDirectory(dirPath: string): Promise<void> {
    const files = await this.discoverFilesInDirectory(dirPath);

    if (files.length === 0) {
      this.log.warn('No CDB64 files found in directory', { path: dirPath });
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
          isPartitioned: false,
        });
      } catch (fileError: any) {
        this.log.error('Failed to initialize CDB64 file in directory', {
          path: filePath,
          error: fileError.message,
        });
        // Continue with other files
      }
    }

    this.startWatching(dirPath);
  }

  /**
   * Performs the actual initialization work.
   */
  private async doInitialize(): Promise<void> {
    try {
      for (const sourceSpec of this.sources) {
        const parsed = parseSourceSpec(sourceSpec);

        // Handle partitioned remote sources
        if (
          parsed.type === 'partitioned-http' ||
          parsed.type === 'partitioned-arweave-tx' ||
          parsed.type === 'partitioned-arweave-bundle-item'
        ) {
          try {
            const entry = await this.createPartitionedReader(
              sourceSpec,
              parsed,
            );
            this.readerMap.set(sourceSpec, entry);
            this.log.info('Partitioned CDB64 source initialized', {
              source: sourceSpec,
              type: entry.sourceType,
              partitionCount: (
                entry.reader as PartitionedCdb64Reader
              ).getTotalPartitionCount(),
            });
          } catch (error: any) {
            this.log.error('Failed to initialize partitioned CDB64 source', {
              source: sourceSpec,
              error: error.message,
            });
          }
          continue;
        }

        // Check if this is a local directory
        const dirPath = await this.checkIfDirectory(sourceSpec);
        if (dirPath !== undefined) {
          // Check if it's a partitioned directory (has manifest.json)
          const isPartitioned = await this.isPartitionedDirectory(dirPath);
          if (isPartitioned) {
            await this.initializePartitionedDirectory(dirPath);
          } else {
            await this.initializeDirectory(dirPath);
          }
          continue;
        }

        // Single file or remote source
        try {
          const entry = await this.createReader(sourceSpec);
          this.readerMap.set(sourceSpec, entry);
          this.log.info('CDB64 source initialized', {
            source: sourceSpec,
            type: entry.sourceType,
          });
        } catch (error: any) {
          this.log.error('Failed to initialize CDB64 source', {
            source: sourceSpec,
            error: error.message,
          });
          // Continue with other sources - don't fail completely
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
        path?: string[];
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
          const rootTxId = toB64Url(getRootTxId(value));

          // Convert path buffers to base64url strings if present
          const pathBuffers = getPath(value);
          const path = pathBuffers?.map((buf) => toB64Url(buf));

          // Check for offset information (both legacy complete and path complete)
          if (isPathCompleteValue(value)) {
            return {
              rootTxId,
              path,
              rootOffset: value.rootDataItemOffset,
              rootDataOffset: value.rootDataOffset,
            };
          }

          if (isCompleteValue(value)) {
            return {
              rootTxId,
              path,
              rootOffset: value.rootDataItemOffset,
              rootDataOffset: value.rootDataOffset,
            };
          }

          return { rootTxId, path };
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

    const readerCount = this.readers.length;

    // Use Promise.allSettled to ensure all readers are closed even if some fail
    const closeResults = await Promise.allSettled(
      this.readers.map((entry) =>
        entry.reader.isOpen() ? entry.reader.close() : Promise.resolve(),
      ),
    );

    const failures = closeResults.filter((r) => r.status === 'rejected');
    if (failures.length > 0) {
      this.log.warn('Some readers failed to close', {
        failedCount: failures.length,
        totalCount: readerCount,
      });
    }

    if (readerCount > 0) {
      this.log.info('CDB64 root TX index closed', {
        readerCount,
      });
    }

    this.readerMap.clear();
    this.readers = [];
    this.initialized = false;
  }
}
