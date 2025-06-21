/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { KVBufferStore } from '../types.js';

/**
 * Key-Value Store for storing ArNS Name resolution data as a Buffer.
 *
 * Example data:
 *
 * {
 *   key: 'ardrive',
 *   value: Buffer.from({
 *      txId: <ARWEAVE-TX-ID>,
 *      processId: <AO-PROCESS-ID>,
 *      owner: <OWNING_ANT_ADDRESS>,
 *      ttl: <TTL_SECONDS>
 *   })
 * }
 */
export class KvArNSResolutionStore implements KVBufferStore {
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
