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

import { KVBufferStore } from '../types';
import pDebounce from 'p-debounce';

/**
 * A wrapper around a KVBufferStore that debounces the hydrate function
 * on cache miss and cache hit.
 */
export class KvDebounceStore implements KVBufferStore {
  private kvBufferStore: KVBufferStore;
  private debounceHydrateOnMiss: (...args: any[]) => Promise<void>;
  private debounceHydrateOnHit: (...args: any[]) => Promise<void>;

  constructor({
    kvBufferStore,
    cacheMissDebounceTtl,
    cacheHitDebounceTtl,
    hydrateImmediately = true,
    debounceFn,
  }: {
    kvBufferStore: KVBufferStore;
    cacheMissDebounceTtl: number;
    cacheHitDebounceTtl: number;
    hydrateImmediately?: boolean;
    debounceFn: () => Promise<void>; // caller is responsible for handling errors from debounceFn, this class will bubble up errors on instantiation if debounceFn throws
  }) {
    this.kvBufferStore = kvBufferStore;
    this.debounceHydrateOnMiss = pDebounce(debounceFn, cacheMissDebounceTtl);
    this.debounceHydrateOnHit = pDebounce(debounceFn, cacheHitDebounceTtl);
    // hydrate the cache immediately when the cache is created
    if (hydrateImmediately) {
      debounceFn();
    }
  }

  async get(key: string): Promise<Buffer | undefined> {
    const value = await this.kvBufferStore.get(key);
    if (value === undefined) {
      this.debounceHydrateOnMiss();
      return undefined;
    }
    this.debounceHydrateOnHit();
    return value;
  }

  async set(key: string, value: Buffer): Promise<void> {
    await this.kvBufferStore.set(key, value);
  }

  async del(key: string): Promise<void> {
    await this.kvBufferStore.del(key);
  }

  async has(key: string): Promise<boolean> {
    return this.kvBufferStore.has(key);
  }

  async close(): Promise<void> {
    await this.kvBufferStore.close();
  }
}
