/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { RootDatabase, open } from 'lmdb';

import { KVBufferStore } from '../types.js';

export class LmdbKVStore implements KVBufferStore {
  private db: RootDatabase<Buffer, string>;

  constructor({ dbPath }: { dbPath: string }) {
    this.db = open({
      path: dbPath,
      encoding: 'binary',
      commitDelay: 100, // 100ms delay - increases writes per transaction to reduce I/O
    });
  }

  async get(key: string): Promise<Buffer | undefined> {
    const value = this.db.get(key);
    return value;
  }

  async has(key: string): Promise<boolean> {
    return this.db.doesExist(key);
  }

  async del(key: string): Promise<void> {
    if (await this.has(key)) {
      await this.db.remove(key);
    }
  }

  async set(key: string, buffer: Buffer): Promise<void> {
    await this.db.put(key, buffer);
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
