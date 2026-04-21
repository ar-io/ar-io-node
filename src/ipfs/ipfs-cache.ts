/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import winston from 'winston';
import { LRUCache } from 'lru-cache';

interface CacheEntry {
  size: number;
  contentType: string;
}

export class IpfsFsCache {
  private log: winston.Logger;
  private baseDir: string;
  private index: LRUCache<string, CacheEntry>;

  constructor({
    log,
    basePath,
    maxSizeBytes,
  }: {
    log: winston.Logger;
    basePath: string;
    maxSizeBytes: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.baseDir = basePath;
    this.index = new LRUCache<string, CacheEntry>({
      maxSize: maxSizeBytes,
      sizeCalculation: (entry) => entry.size,
      dispose: (_entry, key) => {
        // Delete file from disk when evicted from LRU
        const dataPath = this.dataPath(key);
        const metaPath = this.metaPath(key);
        fs.promises.unlink(dataPath).catch(() => {});
        fs.promises.unlink(metaPath).catch(() => {});
        this.log.debug('Evicted IPFS cache entry', { key });
      },
    });
  }

  private cacheKey(cidString: string, path?: string): string {
    const raw =
      path !== undefined && path !== '' ? `${cidString}/${path}` : cidString;
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  private dataDir(key: string): string {
    const prefix = `${key.substring(0, 2)}/${key.substring(2, 4)}`;
    return `${this.baseDir}/data/${prefix}`;
  }

  private dataPath(key: string): string {
    return `${this.dataDir(key)}/${key}`;
  }

  private metaPath(key: string): string {
    return `${this.dataDir(key)}/${key}.meta`;
  }

  private tempDir(): string {
    return `${this.baseDir}/tmp`;
  }

  private createTempPath(): string {
    return `${this.tempDir()}/${crypto.randomBytes(16).toString('hex')}`;
  }

  async has(cidString: string, path?: string): Promise<boolean> {
    const key = this.cacheKey(cidString, path);
    if (this.index.has(key)) {
      return true;
    }
    // Check disk in case index was lost (restart)
    try {
      await fs.promises.access(this.dataPath(key), fs.constants.F_OK);
      // Rebuild index entry from meta file
      const meta = await this.readMeta(key);
      if (meta) {
        this.index.set(key, meta);
        return true;
      }
    } catch {
      // Not found
    }
    return false;
  }

  async get(
    cidString: string,
    path?: string,
  ): Promise<
    { stream: Readable; size: number; contentType: string } | undefined
  > {
    const key = this.cacheKey(cidString, path);
    let entry = this.index.get(key);

    // Rebuild index from disk if entry is missing (e.g., after restart)
    if (!entry) {
      try {
        await fs.promises.access(this.dataPath(key), fs.constants.F_OK);
        const meta = await this.readMeta(key);
        if (meta) {
          this.index.set(key, meta);
          entry = meta;
        }
      } catch {
        // File not on disk — true cache miss
      }
    }

    if (entry) {
      const dataPath = this.dataPath(key);
      try {
        await fs.promises.access(dataPath, fs.constants.F_OK);
        const stream = fs.createReadStream(dataPath);
        return {
          stream,
          size: entry.size,
          contentType: entry.contentType,
        };
      } catch (error: any) {
        this.log.error('Failed to read cached IPFS content', {
          key,
          message: error.message,
        });
        this.index.delete(key);
      }
    }
    return undefined;
  }

  async put(
    cidString: string,
    stream: Readable,
    size: number,
    contentType: string,
    path?: string,
  ): Promise<void> {
    const key = this.cacheKey(cidString, path);

    try {
      await fs.promises.mkdir(this.tempDir(), { recursive: true });
      const tempPath = this.createTempPath();
      const writeStream = fs.createWriteStream(tempPath);

      await pipeline(stream, writeStream);

      // Move to final location
      const dataDir = this.dataDir(key);
      await fs.promises.mkdir(dataDir, { recursive: true });
      await fs.promises.rename(tempPath, this.dataPath(key));

      // Write metadata
      const meta: CacheEntry = { size, contentType };
      await fs.promises.writeFile(
        this.metaPath(key),
        JSON.stringify(meta),
        'utf-8',
      );

      // Update index
      this.index.set(key, meta);

      this.log.debug('Cached IPFS content', { cidString, path, key, size });
    } catch (error: any) {
      this.log.error('Failed to cache IPFS content', {
        cidString,
        path,
        message: error.message,
      });
    }
  }

  /**
   * Finalize a cache entry from an already-written temp file.
   * Used by the streaming cache writer to avoid double-copying data.
   */
  async putFromFile(
    cidString: string,
    tempPath: string,
    size: number,
    contentType: string,
    path?: string,
  ): Promise<void> {
    const key = this.cacheKey(cidString, path);

    try {
      const dataDir = this.dataDir(key);
      await fs.promises.mkdir(dataDir, { recursive: true });
      await fs.promises.rename(tempPath, this.dataPath(key));

      const meta: CacheEntry = { size, contentType };
      await fs.promises.writeFile(
        this.metaPath(key),
        JSON.stringify(meta),
        'utf-8',
      );

      this.index.set(key, meta);

      this.log.debug('Cached IPFS content from file', {
        cidString,
        path,
        key,
        size,
      });
    } catch (error: any) {
      this.log.error('Failed to finalize cached IPFS content', {
        cidString,
        path,
        message: error.message,
      });
      // Clean up temp file on failure
      fs.promises.unlink(tempPath).catch(() => {});
    }
  }

  getCachePath(): string {
    return this.baseDir;
  }

  private async readMeta(key: string): Promise<CacheEntry | null> {
    try {
      const raw = await fs.promises.readFile(this.metaPath(key), 'utf-8');
      return JSON.parse(raw) as CacheEntry;
    } catch {
      return null;
    }
  }
}
