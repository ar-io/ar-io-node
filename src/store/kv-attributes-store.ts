/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';

import {
  KVBufferStore,
  DataItemAttributesStore,
  DataItemAttributes,
  TransactionAttributesStore,
  TransactionAttributes,
} from '../types.js';

export class KvJsonStore<T> {
  private log: winston.Logger;
  private kvBufferStore: KVBufferStore;
  private allowOverwrite: boolean;

  constructor({
    log,
    kvBufferStore,
    allowOverwrite = false,
  }: {
    log: winston.Logger;
    kvBufferStore: KVBufferStore;
    allowOverwrite?: boolean;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.kvBufferStore = kvBufferStore;
    this.allowOverwrite = allowOverwrite;
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

  async get(key: string): Promise<T | undefined> {
    try {
      if (await this.has(key)) {
        const buffer = await this.kvBufferStore.get(key);

        if (buffer === undefined) {
          throw new Error('Missing value in store');
        }

        return JSON.parse(buffer.toString('utf-8'));
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

  async set(key: string, value: T) {
    try {
      if (!(await this.has(key)) || this.allowOverwrite) {
        const buffer = Buffer.from(JSON.stringify(value), 'utf-8');

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

export class KvDataItemAttributesStore
  extends KvJsonStore<DataItemAttributes>
  implements DataItemAttributesStore {}

export class KvTransactionAttributesStore
  extends KvJsonStore<TransactionAttributes>
  implements TransactionAttributesStore {}
