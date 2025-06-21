/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import NodeCache from 'node-cache';
import { KVBufferStore } from '../types.js';

export class NodeKvStore implements KVBufferStore {
  private cache: NodeCache;

  constructor({
    ttlSeconds,
    maxKeys,
  }: {
    ttlSeconds: number;
    maxKeys: number;
  }) {
    this.cache = new NodeCache({
      stdTTL: ttlSeconds,
      maxKeys,
      deleteOnExpire: true,
      useClones: false, // cloning promises is unsafe
      checkperiod: Math.min(60 * 5, ttlSeconds),
    });
  }

  async get(key: string): Promise<Buffer | undefined> {
    const value = this.cache.get(key);
    if (value === undefined) {
      return undefined;
    }
    return value as Buffer;
  }

  async set(key: string, buffer: Buffer): Promise<void> {
    this.cache.set(key, buffer);
  }

  async del(key: string): Promise<void> {
    this.cache.del(key);
  }

  async has(key: string): Promise<boolean> {
    return this.cache.has(key);
  }

  async close(): Promise<void> {
    this.cache.close();
  }
}
