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
