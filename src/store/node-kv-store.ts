/**
 * AR.IO Gateway
 * Copyright (C) 2022-2023 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
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
