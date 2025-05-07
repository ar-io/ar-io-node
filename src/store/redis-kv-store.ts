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

import { Redis } from 'ioredis';
import winston from 'winston';
import * as metrics from '../metrics.js';
import { KVBufferStore } from '../types.js';

export class RedisKvStore implements KVBufferStore {
  private client: Redis;
  private log: winston.Logger;
  private ttlSeconds: number;
  private keyPrefix: string | undefined;

  constructor({
    log,
    redisUrl,
    ttlSeconds,
    keyPrefix,
  }: {
    log: winston.Logger;
    redisUrl: string;
    ttlSeconds: number;
    keyPrefix?: string;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.ttlSeconds = ttlSeconds;
    this.keyPrefix = keyPrefix;
    this.client = new Redis(redisUrl);
    this.client.on('error', (error: any) => {
      this.log.error(`Redis error`, {
        message: error.message,
        stack: error.stack,
        url: redisUrl,
      });
      metrics.redisErrorCounter.inc();
    });
  }

  private key(key: string): string {
    return this.keyPrefix !== undefined ? `${this.keyPrefix}|${key}` : key;
  }

  async get(key: string): Promise<Buffer | undefined> {
    const prefixedKey = this.key(key);
    const value = await this.client.getBuffer(prefixedKey);
    return value ?? undefined;
  }

  async has(key: string): Promise<boolean> {
    const prefixedKey = this.key(key);
    return (await this.client.exists(prefixedKey)) === 1;
  }

  async del(key: string): Promise<void> {
    if (await this.has(key)) {
      const prefixedKey = this.key(key);
      await this.client.del(prefixedKey);
    }
  }

  async set(key: string, buffer: Buffer): Promise<void> {
    // set the key with a TTL for every key
    const prefixedKey = this.key(key);
    await this.client.set(prefixedKey, buffer, 'EX', this.ttlSeconds);
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}
