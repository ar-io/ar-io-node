/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';

import { KVBufferStore, B64UrlStore } from '../types.js';
import { fromB64Url, toB64Url } from '../lib/encoding.js';

export class KvB64UrlStore implements B64UrlStore {
  private log: winston.Logger;
  private kvBufferStore: KVBufferStore;

  constructor({
    log,
    kvBufferStore,
  }: {
    log: winston.Logger;
    kvBufferStore: KVBufferStore;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.kvBufferStore = kvBufferStore;
  }

  async has(key: string) {
    try {
      const exists = await this.kvBufferStore.has(key);

      return exists;
    } catch (error: any) {
      this.log.error('Failed to verify if value exists in store', {
        key,
        message: error.message,
        stack: error.stack,
      });
    }

    return false;
  }

  async get(key: string) {
    try {
      if (await this.has(key)) {
        const buffer = await this.kvBufferStore.get(key);

        if (buffer === undefined) {
          throw new Error('Missing value in store');
        }

        return toB64Url(buffer);
      }
    } catch (error: any) {
      this.log.error('Failed to get value from store', {
        key,
        message: error.message,
        stack: error.stack,
      });
    }

    return undefined;
  }

  async set(key: string, value: string) {
    try {
      if (!(await this.has(key))) {
        const buffer = fromB64Url(value);

        return this.kvBufferStore.set(key, buffer);
      }
    } catch (error: any) {
      this.log.error('Failed to set value in key/value store', {
        key,
        message: error.message,
        stack: error.stack,
      });
    }
  }

  // Currenly unused
  async del(key: string) {
    try {
      if (await this.has(key)) {
        return this.kvBufferStore.del(key);
      }
    } catch (error: any) {
      this.log.error('Failed to delete key from store', {
        key,
        message: error.message,
        stack: error.stack,
      });
    }
  }
}
