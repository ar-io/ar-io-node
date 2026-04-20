/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import fs from 'node:fs';
import winston from 'winston';
import { watch, FSWatcher } from 'chokidar';

import { cidToV1Base32, isValidCid } from '../lib/ipfs-cid.js';

export class IpfsBlocklist {
  private log: winston.Logger;
  private filePath: string;
  private blockedCids: Set<string> = new Set();
  private watcher: FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;

  constructor({ log, filePath }: { log: winston.Logger; filePath: string }) {
    this.log = log.child({ class: this.constructor.name });
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    try {
      const content = await fs.promises.readFile(this.filePath, 'utf-8');
      const newSet = new Set<string>();

      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#')) continue;

        if (isValidCid(trimmed)) {
          // Normalize to CIDv1 base32 for consistent matching
          try {
            newSet.add(cidToV1Base32(trimmed));
          } catch {
            this.log.warn('Failed to normalize CID in blocklist', {
              cid: trimmed,
            });
          }
        } else {
          this.log.warn('Invalid CID in blocklist, skipping', {
            line: trimmed,
          });
        }
      }

      this.blockedCids = newSet;
      this.log.info('IPFS blocklist loaded', { count: newSet.size });
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        this.log.debug('IPFS blocklist file not found, no CIDs blocked', {
          filePath: this.filePath,
        });
        this.blockedCids = new Set();
      } else {
        this.log.error('Failed to load IPFS blocklist', {
          message: error.message,
        });
      }
    }
  }

  isBlocked(cidString: string): boolean {
    try {
      const normalized = cidToV1Base32(cidString);
      return this.blockedCids.has(normalized);
    } catch {
      return false;
    }
  }

  startWatching(): void {
    this.watcher = watch(this.filePath, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 1000 },
    });

    this.watcher.on('change', () => {
      this.log.info('IPFS blocklist file changed, reloading');
      this.scheduleReload();
    });

    this.watcher.on('add', () => {
      this.log.info('IPFS blocklist file created, loading');
      this.scheduleReload();
    });
  }

  private scheduleReload(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
    }
    this.reloadTimer = setTimeout(() => {
      this.load().catch((error) => {
        this.log.error('Failed to reload IPFS blocklist', {
          message: error.message,
        });
      });
    }, 1000);
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
  }
}
