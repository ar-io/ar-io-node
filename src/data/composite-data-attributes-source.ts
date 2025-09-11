/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { LRUCache } from 'lru-cache';
import winston from 'winston';

import { ContiguousDataAttributes, DataAttributesSource } from '../types.js';

const DEFAULT_MAX_CACHE_SIZE = 10000;

export class CompositeDataAttributesSource implements DataAttributesSource {
  private log: winston.Logger;
  private source: DataAttributesSource;
  private cache: LRUCache<string, ContiguousDataAttributes>;
  private pendingPromises: Map<
    string,
    Promise<ContiguousDataAttributes | undefined>
  >;

  constructor({
    log,
    source,
    cacheSize = DEFAULT_MAX_CACHE_SIZE,
  }: {
    log: winston.Logger;
    source: DataAttributesSource;
    cacheSize?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.source = source;
    this.cache = new LRUCache<string, ContiguousDataAttributes>({
      max: cacheSize,
    });
    this.pendingPromises = new Map();
  }

  async getDataAttributes(
    id: string,
  ): Promise<ContiguousDataAttributes | undefined> {
    // Check if there's a pending promise for this ID
    const existingPromise = this.pendingPromises.get(id);
    if (existingPromise) {
      this.log.debug('Returning existing pending promise for data attributes', {
        id,
      });
      return existingPromise;
    }

    // Check cache first
    const cachedResult = this.cache.get(id);
    if (cachedResult) {
      this.log.debug('Cache hit for data attributes', { id });
      return cachedResult;
    }

    // Create new promise for this ID
    const promise = this.fetchAndCache(id);
    this.pendingPromises.set(id, promise);

    try {
      const result = await promise;
      return result;
    } finally {
      // Always clean up the pending promise
      this.pendingPromises.delete(id);
    }
  }

  private async fetchAndCache(
    id: string,
  ): Promise<ContiguousDataAttributes | undefined> {
    this.log.debug('Fetching data attributes from source', { id });

    try {
      const result = await this.source.getDataAttributes(id);

      if (result !== undefined) {
        this.log.debug('Caching data attributes result', { id });
        this.cache.set(id, result);
      } else {
        this.log.debug('Data attributes not found', { id });
      }

      return result;
    } catch (error: any) {
      this.log.warn('Failed to fetch data attributes from source', {
        id,
        error: error.message,
      });
      throw error;
    }
  }
}
