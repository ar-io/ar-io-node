/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
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
