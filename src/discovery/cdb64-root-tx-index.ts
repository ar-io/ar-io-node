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
import { Dirent } from 'node:fs';
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
import { Semaphore } from '../lib/semaphore.js';
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
import * as metrics from '../metrics.js';

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
  | { type: 'arweave-byte-range'; id: string; offset: number; size: number }
  | { type: 'http'; url: string }
  | { type: 'partitioned-directory'; path: string }
  | { type: 'partitioned-http'; url: string }
  | { type: 'partitioned-arweave-tx'; id: string }
  | {
      type: 'partitioned-arweave-byte-range';
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
 * - Arweave byte range: "rootTxId:offset:size" (colon-separated)
 * - Arweave byte range with :manifest suffix: partitioned byte-range source
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

  // Check for byte-range format: rootTxId:offset:size or rootTxId:offset:size:manifest
  const colonParts = spec.split(':');

  // rootTxId:offset:size:manifest format (partitioned byte-range)
  if (colonParts.length === 4 && colonParts[3] === 'manifest') {
    const [id, offsetStr, sizeStr] = colonParts;
    if (/^[A-Za-z0-9_-]{43}$/.test(id)) {
      const offset = parseInt(offsetStr, 10);
      const size = parseInt(sizeStr, 10);

      if (
        Number.isSafeInteger(offset) &&
        Number.isSafeInteger(size) &&
        offset >= 0 &&
        size > 0
      ) {
        return { type: 'partitioned-arweave-byte-range', id, offset, size };
      }
    }
  }

  // rootTxId:offset:size format (regular byte-range)
  if (colonParts.length === 3) {
    const [id, offsetStr, sizeStr] = colonParts;
    if (/^[A-Za-z0-9_-]{43}$/.test(id)) {
      const offset = parseInt(offsetStr, 10);
      const size = parseInt(sizeStr, 10);

      if (
        Number.isSafeInteger(offset) &&
        Number.isSafeInteger(size) &&
        offset >= 0 &&
        size > 0
      ) {
        return { type: 'arweave-byte-range', id, offset, size };
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
  /**
   * Lookups currently inside this reader. A reader being retired is dropped
   * from the lookup list immediately but closed only once this reaches zero,
   * so a lookup already in progress finishes instead of surfacing as a miss.
   */
  inFlight: number;
}

export class Cdb64RootTxIndex implements DataItemRootIndex {
  private log: winston.Logger;
  private readers: ReaderEntry[] = [];
  private readerMap: Map<string, ReaderEntry> = new Map();
  private sources: string[];
  private initialized = false;
  private initializationPromise: Promise<void> | null = null;
  private watchEnabled: boolean;
  /**
   * Active watchers, keyed `<kind>:<path>`. Every configured directory gets
   * its own: a single shared watcher meant that with more than one directory
   * source only the first was ever watched, and changes under the rest were
   * silently missed.
   */
  private watchers: Map<string, FSWatcher> = new Map();

  /**
   * Directory sources that did not exist yet when the index started, each
   * with the timer that checks for it. A sidecar creates its install
   * directory on first use, so a gateway that starts first must wait for it
   * rather than write it off as a missing file.
   */
  private pendingDirectories: Map<string, NodeJS.Timeout> = new Map();

  // Dependencies for remote sources
  private contiguousDataSource?: ContiguousDataSource;

  // Cache configuration
  private remoteCacheMaxRegions: number;
  private remoteCacheTtlMs: number;
  private remoteRequestTimeoutMs: number;
  private remoteSemaphore?: Semaphore;
  private remoteSemaphoreTimeoutMs?: number;

  constructor({
    log,
    sources,
    watch = true,
    contiguousDataSource,
    remoteCacheMaxRegions = 100,
    remoteCacheTtlMs = 300000,
    remoteRequestTimeoutMs = 30000,
    remoteSemaphore,
    remoteSemaphoreTimeoutMs,
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
    /** Shared semaphore for limiting concurrent HTTP requests */
    remoteSemaphore?: Semaphore;
    /** Timeout for acquiring the semaphore in ms */
    remoteSemaphoreTimeoutMs?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.sources = sources;
    this.watchEnabled = watch;
    this.contiguousDataSource = contiguousDataSource;
    this.remoteCacheMaxRegions = remoteCacheMaxRegions;
    this.remoteCacheTtlMs = remoteCacheTtlMs;
    this.remoteRequestTimeoutMs = remoteRequestTimeoutMs;
    this.remoteSemaphore = remoteSemaphore;
    this.remoteSemaphoreTimeoutMs = remoteSemaphoreTimeoutMs;
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

  /** Maximum manifest size in bytes (10 MB) */
  private static readonly MAX_MANIFEST_SIZE = 10 * 1024 * 1024;

  /** How long to wait for in-flight lookups before closing a retired reader. */
  private static readonly READER_DRAIN_TIMEOUT_MS = 5000;
  private static readonly READER_DRAIN_POLL_MS = 25;

  /** How often a directory source that does not exist yet is checked for. */
  static PENDING_DIRECTORY_POLL_MS = 30_000;

  /**
   * Converts a fetch Response body to an AsyncIterable.
   */
  private async *responseToAsyncIterable(
    response: Response,
  ): AsyncIterable<Uint8Array> {
    if (response.body === null) {
      return;
    }
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Collects an async stream into a string with optional size limit.
   * @param maxBytes Maximum bytes to read (default: MAX_MANIFEST_SIZE)
   * @throws Error if the stream exceeds the size limit
   */
  private async streamToString(
    stream: AsyncIterable<Uint8Array | Buffer>,
    maxBytes: number = Cdb64RootTxIndex.MAX_MANIFEST_SIZE,
  ): Promise<string> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > maxBytes) {
        throw new Error(`Stream exceeds maximum size of ${maxBytes} bytes`);
      }
      chunks.push(buffer);
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
            semaphore: this.remoteSemaphore,
            semaphoreTimeoutMs: this.remoteSemaphoreTimeoutMs,
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

      case 'arweave-byte-range':
        if (!this.contiguousDataSource) {
          throw new Error(
            'ContiguousDataSource required for Arweave byte-range sources',
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
      inFlight: 0,
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
   * Starts watching a flat directory for CDB64 file additions and removals.
   */
  private startWatching(dirPath: string): void {
    if (!this.watchEnabled) return;

    const key = `files:${dirPath}`;
    if (this.watchers.has(key)) return;

    const watcher = watch(dirPath, {
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
    this.watchers.set(key, watcher);

    watcher.on('add', async (filePath: string) => {
      if (!isCdb64File(filePath)) return;
      await this.addFileReader(filePath).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log.error('Failed handling CDB64 add event', {
          path: filePath,
          error: message,
        });
      });
    });

    watcher.on('unlink', async (filePath: string) => {
      if (!isCdb64File(filePath)) return;
      await this.removeReader(filePath).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log.error('Failed handling CDB64 unlink event', {
          path: filePath,
          error: message,
        });
      });
    });

    watcher.on('error', (error: unknown) => {
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

    const key = `manifest:${dirPath}`;
    if (this.watchers.has(key)) return;

    const manifestPath = path.join(dirPath, 'manifest.json');

    const watcher = watch(manifestPath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 1000,
        pollInterval: 100,
      },
    });
    this.watchers.set(key, watcher);

    // Handler for manifest changes (reused for both 'change' and 'add' events)
    const handleManifestChange = async () => {
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
    };

    watcher.on('change', handleManifestChange);
    // Handle atomic renames (common in production): unlink + add rather than change
    watcher.on('add', handleManifestChange);

    watcher.on('error', (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error('Manifest watcher error', { error: message });
    });

    this.log.info('Manifest watcher started', { path: manifestPath });
  }

  /**
   * Reloads a partitioned directory after manifest change.
   */
  private async reloadPartitionedDirectory(dirPath: string): Promise<void> {
    // Open the replacement first and publish it before draining the old
    // reader. Draining while the old reader is still in the lookup list
    // lets new lookups keep entering it, so under steady traffic it never
    // goes idle, is closed at the drain deadline with lookups in flight, and
    // those lookups miss until the new reader arrives.
    const existingEntry = this.readerMap.get(dirPath);
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
      this.readerMap.delete(dirPath);
      this.rebuildReaderList();
    } finally {
      if (existingEntry !== undefined) {
        await this.closeReaderWhenIdle(existingEntry);
      }
    }
  }

  /**
   * Starts watching a collection directory: one whose immediate
   * subdirectories are each a partitioned index.
   *
   * A band is installed by renaming a fully-written directory into place and
   * retired by removing it, so the appearance or disappearance of a
   * subdirectory's `manifest.json` is the signal to load or drop a reader.
   * Watching at depth 1 with the partition files ignored keeps the watch
   * cheap: a band holds up to 256 `.cdb` files that never need watching, and
   * only its manifest matters here.
   */
  private startWatchingCollection(dirPath: string): void {
    if (!this.watchEnabled) return;

    const key = `collection:${dirPath}`;
    if (this.watchers.has(key)) return;

    const watcher = watch(dirPath, {
      // chokidar 4 removed glob support, so the pattern is expressed as a
      // depth-bounded watch plus a filter rather than `<dir>/*/manifest.json`.
      ignored: (filePath: string) => isCdb64File(filePath),
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 1000,
        pollInterval: 100,
      },
      depth: 1,
    });
    this.watchers.set(key, watcher);

    /** The band directory a path belongs to, if it is one of ours. */
    const bandDirFor = (manifestPath: string): string | undefined => {
      if (path.basename(manifestPath) !== 'manifest.json') return undefined;
      const bandDir = path.dirname(manifestPath);
      if (path.dirname(bandDir) !== dirPath) return undefined;
      if (bandDir.endsWith('.tmp')) return undefined;
      return bandDir;
    };

    const handleBandManifest = async (manifestPath: string) => {
      const bandDir = bandDirFor(manifestPath);
      if (bandDir === undefined) return;

      if (this.readerMap.has(bandDir)) {
        await this.reloadPartitionedDirectory(bandDir);
        return;
      }

      await this.initializePartitionedDirectory(bandDir, {
        watchManifest: false,
      });
      this.rebuildReaderList();
      this.log.info('CDB64 index band added', {
        collection: dirPath,
        band: bandDir,
      });
    };

    watcher.on('add', (manifestPath: string) => {
      handleBandManifest(manifestPath).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log.error('Failed handling index band add', {
          path: manifestPath,
          error: message,
        });
      });
    });

    watcher.on('change', (manifestPath: string) => {
      handleBandManifest(manifestPath).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log.error('Failed handling index band change', {
          path: manifestPath,
          error: message,
        });
      });
    });

    watcher.on('unlink', (manifestPath: string) => {
      const bandDir = bandDirFor(manifestPath);
      if (bandDir === undefined) return;
      this.removeReader(bandDir).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log.error('Failed handling index band removal', {
          path: bandDir,
          error: message,
        });
      });
    });

    // Removing a whole band directory does not always surface as an unlink of
    // the manifest inside it, so treat the directory going away as removal.
    watcher.on('unlinkDir', (bandDir: string) => {
      if (path.dirname(bandDir) !== dirPath) return;
      if (!this.readerMap.has(bandDir)) return;
      this.removeReader(bandDir).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log.error('Failed handling index band directory removal', {
          path: bandDir,
          error: message,
        });
      });
    });

    watcher.on('error', (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error('Index collection watcher error', { error: message });
    });

    this.log.info('CDB64 index collection watcher started', { path: dirPath });
  }

  /**
   * Lists the band directories inside a collection: immediate subdirectories
   * holding a `manifest.json`. Directories ending in `.tmp` are skipped, so a
   * band still being written is not loaded half-formed.
   */
  private async discoverBandsInDirectory(dirPath: string): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return [];
    }

    const bands: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.endsWith('.tmp')) continue;
      const bandPath = path.join(dirPath, entry.name);
      if (await this.isPartitionedDirectory(bandPath)) {
        bands.push(bandPath);
      }
    }
    return bands.sort();
  }

  /**
   * Loads every band in a collection directory and watches for more.
   *
   * @returns how many bands were loaded.
   */
  private async initializeCollectionDirectory(
    dirPath: string,
  ): Promise<number> {
    const bands = await this.discoverBandsInDirectory(dirPath);

    for (const bandPath of bands) {
      await this.initializePartitionedDirectory(bandPath, {
        watchManifest: false,
      });
    }

    this.startWatchingCollection(dirPath);

    if (bands.length > 0) {
      this.log.info('CDB64 index collection initialized', {
        path: dirPath,
        bandCount: bands.length,
      });
    }

    return bands.length;
  }

  /**
   * Closes a reader once no lookup is inside it.
   *
   * Closing under an in-flight read makes that lookup throw, which the caller
   * sees as a miss on a source that was perfectly good a moment earlier. The
   * wait is bounded so a wedged read cannot leak the file handle forever.
   */
  private async closeReaderWhenIdle(entry: ReaderEntry): Promise<void> {
    const deadline = Date.now() + Cdb64RootTxIndex.READER_DRAIN_TIMEOUT_MS;
    while (entry.inFlight > 0 && Date.now() < deadline) {
      await new Promise((resolve) =>
        setTimeout(resolve, Cdb64RootTxIndex.READER_DRAIN_POLL_MS),
      );
    }

    if (entry.inFlight > 0) {
      this.log.warn('Closing CDB64 reader with lookups still in flight', {
        source: entry.sourceSpec,
        inFlight: entry.inFlight,
      });
    }

    if (entry.reader.isOpen()) {
      await entry.reader.close();
    }
  }

  /**
   * Stops watching the directory.
   */
  private async stopWatching(): Promise<void> {
    for (const timer of this.pendingDirectories.values()) {
      clearTimeout(timer);
    }
    this.pendingDirectories.clear();

    if (this.watchers.size === 0) return;

    const watcherCount = this.watchers.size;
    await Promise.allSettled(
      [...this.watchers.values()].map((watcher) => watcher.close()),
    );
    this.watchers.clear();
    this.log.info('CDB64 file watchers stopped', { watcherCount });
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
        inFlight: 0,
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
      // Drop it from the lookup list first so no new lookup reaches it, then
      // wait for lookups already inside it before closing.
      this.readerMap.delete(key);
      this.rebuildReaderList();
      await this.closeReaderWhenIdle(entry);
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
    // Preserve config order: iterate sources in their original order.
    // Sources that map directly to a reader (partitioned dirs, remote, single
    // files) use the sourceSpec as the map key. Non-partitioned directories
    // expand into individual file readers whose keys are file paths — collect
    // those by prefix so they stay grouped under their source.
    const result: ReaderEntry[] = [];
    const claimed = new Set<string>();
    const perSource = new Map<string, number>();

    for (const sourceSpec of this.sources) {
      if (this.readerMap.has(sourceSpec)) {
        result.push(this.readerMap.get(sourceSpec)!);
        claimed.add(sourceSpec);
        perSource.set(sourceSpec, 1);
      } else {
        // Non-partitioned directory: individual file keys start with sourceSpec.
        // Sort alphabetically within the directory for deterministic ordering.
        const matched: [string, ReaderEntry][] = [];
        for (const [key, entry] of this.readerMap) {
          if (!claimed.has(key) && key.startsWith(sourceSpec)) {
            matched.push([key, entry]);
            claimed.add(key);
          }
        }
        matched.sort(([a], [b]) => a.localeCompare(b));
        for (const [, entry] of matched) {
          result.push(entry);
        }
        perSource.set(sourceSpec, matched.length);
      }
    }

    // Include any remaining readers not matched to a source (e.g. dynamically
    // added via watcher after initialization)
    for (const [key, entry] of this.readerMap) {
      if (!claimed.has(key)) {
        result.push(entry);
      }
    }

    this.readers = result;

    // Report per source rather than in total: a collection source's count is
    // how many bands are currently installed, which is what drops when a band
    // is retired and rises when one arrives.
    for (const [sourceSpec, count] of perSource) {
      metrics.cdb64RootTxIndexReadersGauge.set({ source: sourceSpec }, count);
    }
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

  /** True only when nothing exists at the path; other errors are not. */
  private async pathIsMissing(filePath: string): Promise<boolean> {
    try {
      await fs.stat(filePath);
      return false;
    } catch (error: any) {
      return error?.code === 'ENOENT';
    }
  }

  /**
   * Checks for a directory source that does not exist yet until it does,
   * then loads it exactly as it would have been loaded at startup.
   *
   * Without this, a gateway that starts before the index-swarm sidecar has
   * created its install directory treats the path as a missing file and
   * never looks at it again, so every band installed afterwards sits on disk
   * unread until the gateway restarts. A timer rather than a watcher, because
   * the missing part may be several levels deep and the gateway mounts the
   * volume read only, so it cannot create the directory itself.
   */
  private waitForDirectory(dirPath: string): void {
    if (!this.watchEnabled || this.pendingDirectories.has(dirPath)) return;

    this.log.info('CDB64 directory source does not exist yet; waiting for it', {
      path: dirPath,
      pollMs: Cdb64RootTxIndex.PENDING_DIRECTORY_POLL_MS,
    });

    const check = async () => {
      if (!this.pendingDirectories.has(dirPath)) return;
      const found = await this.checkIfDirectory(dirPath);
      // close() may have run while that was awaited.
      if (!this.pendingDirectories.has(dirPath)) return;
      if (found === undefined) {
        schedule();
        return;
      }
      this.pendingDirectories.delete(dirPath);
      try {
        if (await this.isPartitionedDirectory(found)) {
          await this.initializePartitionedDirectory(found);
        } else {
          await this.initializeDirectory(found);
        }
        this.rebuildReaderList();
        this.log.info('CDB64 directory source appeared and was loaded', {
          path: found,
        });
      } catch (error: any) {
        this.log.error('Failed to load CDB64 directory source', {
          path: found,
          error: error.message,
        });
      }
    };

    const schedule = () => {
      const timer = setTimeout(() => {
        void check();
      }, Cdb64RootTxIndex.PENDING_DIRECTORY_POLL_MS);
      // Waiting must never be what keeps the process alive.
      timer.unref();
      this.pendingDirectories.set(dirPath, timer);
    };

    schedule();
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
        // Check Content-Length if available
        const contentLength = response.headers.get('content-length');
        if (contentLength !== null) {
          const size = parseInt(contentLength, 10);
          if (!isNaN(size) && size > Cdb64RootTxIndex.MAX_MANIFEST_SIZE) {
            throw new Error(
              `Manifest exceeds maximum size of ${Cdb64RootTxIndex.MAX_MANIFEST_SIZE} bytes (Content-Length: ${size})`,
            );
          }
        }
        // Also enforce limit while reading in case Content-Length was missing or inaccurate
        const content = await this.streamToString(
          this.responseToAsyncIterable(response),
        );
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

      case 'partitioned-arweave-byte-range': {
        if (!this.contiguousDataSource) {
          throw new Error(
            'ContiguousDataSource required for Arweave byte-range manifest sources',
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
      case 'partitioned-arweave-byte-range': {
        manifest = await this.loadRemoteManifest(parsed);
        // Validate: Arweave manifests cannot contain file locations
        const fileLocations = manifest.partitions.filter(
          (p) => p.location.type === 'file',
        );
        if (fileLocations.length > 0) {
          throw new Error(
            `Arweave manifest contains ${fileLocations.length} partition(s) with file locations. ` +
              `Arweave manifests must use arweave-id, arweave-byte-range, or http location types.`,
          );
        }
        break;
      }

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
      remoteSemaphore: this.remoteSemaphore,
      remoteSemaphoreTimeoutMs: this.remoteSemaphoreTimeoutMs,
      log: this.log,
    });

    await reader.open();

    return {
      reader,
      sourceSpec,
      sourceType: parsed.type,
      isPartitioned: true,
      inFlight: 0,
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
  private async initializePartitionedDirectory(
    dirPath: string,
    { watchManifest = true }: { watchManifest?: boolean } = {},
  ): Promise<void> {
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

      // Watch manifest.json for changes. A band inside a collection is
      // already covered by the collection's own watcher, so it does not need
      // one of its own.
      if (watchManifest) {
        this.startWatchingManifest(dirPath);
      }
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
          inFlight: 0,
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

    // The same directory may instead, or additionally, hold one subdirectory
    // per index: a collection. Checking for both keeps an existing flat
    // directory behaving exactly as before while letting a directory that
    // bands are installed into pick them up without a restart, including
    // while it is still empty.
    const bandCount = await this.initializeCollectionDirectory(dirPath);

    if (files.length === 0 && bandCount === 0) {
      this.log.warn('No CDB64 files or index bands found in directory', {
        path: dirPath,
      });
    }
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
          parsed.type === 'partitioned-arweave-byte-range'
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

        // A local path that does not exist and is not named like a CDB64
        // file is a directory nothing has created yet. Wait for it.
        if (
          parsed.type === 'file' &&
          !isCdb64File(parsed.path) &&
          (await this.pathIsMissing(parsed.path))
        ) {
          this.waitForDirectory(parsed.path);
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
        watcherCount: this.watchers.size,
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
      entry.inFlight += 1;
      try {
        const valueBuffer = await entry.reader.get(keyBuffer);

        if (valueBuffer !== undefined) {
          const value = decodeCdb64Value(valueBuffer);
          const rootTxId = toB64Url(getRootTxId(value));

          // Convert path buffers to base64url strings if present
          const pathBuffers = getPath(value);
          const path = pathBuffers?.map((buf) => toB64Url(buf));

          // Check for offset information (both legacy complete and path complete).
          //
          // When the value records the item size it is returned as `size` (the
          // whole item, header + payload). `dataSize` is deliberately left
          // unset even though it could be derived: a result carrying
          // `dataSize` is treated as ready to serve with no header read, but
          // the index does not store the item's content type, and only reading
          // the item header recovers it (and confirms the offset belongs to
          // the requested ID).
          if (isPathCompleteValue(value) || isCompleteValue(value)) {
            return {
              rootTxId,
              path,
              rootOffset: value.rootDataItemOffset,
              rootDataOffset: value.rootDataOffset,
              ...(value.dataItemSize !== undefined
                ? { size: value.dataItemSize }
                : {}),
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
      } finally {
        entry.inFlight -= 1;
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
