/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { KVBufferStore } from '../types.js';

/**
 * Key-Value stored intended to hold ArNS Name Registry data.
 *
 * Example data:
 *
 * {
 *   key: 'ardrive',
 *   value: {
 *      processId: AO_PROCESS_ID,
 *      undernameLimit: UNDERNAME_LIMIT,
 *      type: 'permabuy' | 'lease',
 *      startTimestamp: TIMESTAMP,
 *      endTimestamp?: TIMESTAMP
 *   }
 * }
 */
export class KvArNSRegistryStore implements KVBufferStore {
  private kvBufferStore: KVBufferStore;
  private hashKeyPrefix: string;
  constructor({
    hashKeyPrefix,
    kvBufferStore,
  }: {
    hashKeyPrefix: string;
    kvBufferStore: KVBufferStore;
  }) {
    this.kvBufferStore = kvBufferStore;
    this.hashKeyPrefix = hashKeyPrefix;
  }

  private hashKey(key: string): string {
    return `${this.hashKeyPrefix}|${key}`;
  }

  async get(key: string): Promise<Buffer | undefined> {
    return this.kvBufferStore.get(this.hashKey(key));
  }

  async set(key: string, value: Buffer): Promise<void> {
    return this.kvBufferStore.set(this.hashKey(key), value);
  }

  async has(key: string): Promise<boolean> {
    return this.kvBufferStore.has(this.hashKey(key));
  }

  async del(key: string): Promise<void> {
    return this.kvBufferStore.del(this.hashKey(key));
  }

  async close(): Promise<void> {
    return this.kvBufferStore.close();
  }
}
