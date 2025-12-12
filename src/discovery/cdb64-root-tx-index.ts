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
 * from pre-built CDB64 files. Supports both single file and directory
 * containing multiple .cdb files. This acts as a distributable historical
 * index that can be used without network access to external APIs.
 *
 * When watching is enabled and a directory is configured, the index
 * automatically detects when .cdb files are added or removed and
 * updates the reader list accordingly.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { watch, FSWatcher } from 'chokidar';
import winston from 'winston';
import { DataItemRootIndex } from '../types.js';
import { Cdb64Reader } from '../lib/cdb64.js';
import { decodeCdb64Value, isCompleteValue } from '../lib/cdb64-encoding.js';
import { fromB64Url, toB64Url } from '../lib/encoding.js';

export class Cdb64RootTxIndex implements DataItemRootIndex {
  private log: winston.Logger;
  private readers: Cdb64Reader[] = [];
  private readerMap: Map<string, Cdb64Reader> = new Map();
  private cdbPath: string;
  private initialized = false;
  private initError: Error | null = null;
  private isDirectory = false;
  private watchEnabled: boolean;
  private watcher: FSWatcher | null = null;

  constructor({
    log,
    cdbPath,
    watch = true,
  }: {
    log: winston.Logger;
    cdbPath: string;
    watch?: boolean;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.cdbPath = cdbPath;
    this.watchEnabled = watch;
  }

  /**
   * Discovers CDB64 files from the configured path.
   * Supports both single file paths and directories containing .cdb files.
   */
  private async discoverCdbFiles(): Promise<string[]> {
    const stat = await fs.stat(this.cdbPath);

    if (stat.isFile()) {
      // Single file - backward compatible
      this.isDirectory = false;
      return [this.cdbPath];
    }

    if (stat.isDirectory()) {
      // Directory - find all .cdb files
      this.isDirectory = true;
      const entries = await fs.readdir(this.cdbPath);
      const cdbFiles = entries
        .filter((f) => f.endsWith('.cdb'))
        .sort() // Alphabetical order for deterministic behavior
        .map((f) => path.join(this.cdbPath, f));

      if (cdbFiles.length === 0) {
        this.log.warn('No .cdb files found in directory', {
          path: this.cdbPath,
        });
      }

      return cdbFiles;
    }

    throw new Error(
      `CDB64 path is neither file nor directory: ${this.cdbPath}`,
    );
  }

  /**
   * Starts watching the directory for .cdb file changes.
   * Only active when watching is enabled and path is a directory.
   */
  private startWatching(): void {
    if (!this.watchEnabled || !this.isDirectory) return;

    this.watcher = watch(this.cdbPath, {
      ignored: (filePath: string) => {
        // Allow directories to be traversed
        // Only allow .cdb files
        return !filePath.endsWith('.cdb') && filePath !== this.cdbPath;
      },
      persistent: true,
      ignoreInitial: true, // Don't fire for existing files
      awaitWriteFinish: {
        // Wait for file to be fully written
        stabilityThreshold: 1000,
        pollInterval: 100,
      },
      depth: 0, // Only watch immediate directory, not subdirectories
    });

    this.watcher.on('add', async (filePath: string) => {
      if (!filePath.endsWith('.cdb')) return;
      await this.addReader(filePath);
    });

    this.watcher.on('unlink', async (filePath: string) => {
      if (!filePath.endsWith('.cdb')) return;
      await this.removeReader(filePath);
    });

    this.watcher.on('error', (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error('CDB64 file watcher error', { error: message });
    });

    this.log.info('CDB64 file watcher started', { path: this.cdbPath });
  }

  /**
   * Stops watching the directory.
   */
  private async stopWatching(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
      this.log.info('CDB64 file watcher stopped');
    }
  }

  /**
   * Adds a new reader for a .cdb file.
   *
   * Note: There's a potential race condition where an unlink event could fire
   * while we're awaiting reader.open(). To handle this, we verify the file
   * still exists after opening before adding the reader to the map.
   */
  private async addReader(filePath: string): Promise<void> {
    if (this.readerMap.has(filePath)) return;

    let reader: Cdb64Reader | undefined;
    try {
      reader = new Cdb64Reader(filePath);
      await reader.open();

      // Verify file still exists after opening (race with unlink)
      // If the file was deleted while we were opening, don't add the reader
      await fs.stat(filePath);

      this.readerMap.set(filePath, reader);
      this.rebuildReaderList();
      this.log.info('CDB64 file added', { path: filePath });
    } catch (error: any) {
      // Clean up the opened reader if we can't add it
      if (reader?.isOpen()) {
        try {
          await reader.close();
        } catch {
          // Ignore close errors during cleanup
        }
      }

      // Only log as error if it's not a "file doesn't exist" error
      // (which is expected if file was deleted during open)
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
   * Removes a reader for a .cdb file.
   */
  private async removeReader(filePath: string): Promise<void> {
    const reader = this.readerMap.get(filePath);
    if (!reader) return;

    try {
      if (reader.isOpen()) {
        await reader.close();
      }
      this.readerMap.delete(filePath);
      this.rebuildReaderList();
      this.log.info('CDB64 file removed', { path: filePath });
    } catch (error: any) {
      this.log.error('Failed to remove CDB64 file', {
        path: filePath,
        error: error.message,
      });
    }
  }

  /**
   * Rebuilds the readers array from the readerMap in sorted order.
   */
  private rebuildReaderList(): void {
    const sortedPaths = [...this.readerMap.keys()].sort();
    this.readers = sortedPaths.map((p) => this.readerMap.get(p)!);
  }

  /**
   * Initializes the readers by opening all CDB64 files.
   * Called lazily on first lookup.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Clear any previous error before retrying initialization
    this.initError = null;

    try {
      const cdbFiles = await this.discoverCdbFiles();

      for (const filePath of cdbFiles) {
        const reader = new Cdb64Reader(filePath);
        await reader.open();
        this.readerMap.set(filePath, reader);
      }

      this.rebuildReaderList();
      this.startWatching();

      this.initialized = true;
      this.log.info('CDB64 root TX index initialized', {
        path: this.cdbPath,
        fileCount: this.readers.length,
        watching: this.watchEnabled && this.isDirectory,
      });
    } catch (error: any) {
      // Close any readers that were opened before the failure to avoid FD leaks
      await Promise.allSettled(
        [...this.readerMap.values()].map((r) =>
          r.isOpen() ? r.close() : Promise.resolve(),
        ),
      );
      this.readerMap.clear();
      this.readers = [];

      // Cache the error but don't set initialized = true
      // This allows retry on transient errors (e.g., files not yet available)
      this.initError = error;
      this.log.error('Failed to initialize CDB64 root TX index', {
        path: this.cdbPath,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Looks up a data item ID and returns its root transaction information.
   *
   * @param id - Base64URL-encoded data item ID (43 characters)
   * @returns Root TX info if found, undefined otherwise
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
      // If initialization failed, return undefined to allow fallback
      return undefined;
    }

    try {
      // Convert base64url ID to 32-byte binary key
      const keyBuffer = fromB64Url(id);

      if (keyBuffer.length !== 32) {
        this.log.debug('Invalid data item ID length', {
          id,
          length: keyBuffer.length,
        });
        return undefined;
      }

      // Snapshot readers array to avoid issues if list changes during iteration
      const currentReaders = this.readers;

      // Search through all readers in order (first match wins)
      for (const reader of currentReaders) {
        const valueBuffer = await reader.get(keyBuffer);

        if (valueBuffer !== undefined) {
          // Decode MessagePack value
          const value = decodeCdb64Value(valueBuffer);

          // Convert binary rootTxId back to base64url
          const rootTxId = toB64Url(value.rootTxId);

          // Return result based on value format
          if (isCompleteValue(value)) {
            return {
              rootTxId,
              rootOffset: value.rootDataItemOffset,
              rootDataOffset: value.rootDataOffset,
            };
          }

          // Simple format - no offset information
          return {
            rootTxId,
          };
        }
      }

      // Key not found in any file
      return undefined;
    } catch (error: any) {
      this.log.error('Error looking up root TX in CDB64', {
        id,
        error: error.message,
      });
      return undefined;
    }
  }

  /**
   * Closes all CDB64 file handles and stops watching.
   * Should be called during shutdown.
   */
  async close(): Promise<void> {
    await this.stopWatching();

    for (const reader of this.readers) {
      if (reader.isOpen()) {
        await reader.close();
      }
    }
    if (this.readers.length > 0) {
      this.log.info('CDB64 root TX index closed', {
        fileCount: this.readers.length,
      });
    }
  }
}
