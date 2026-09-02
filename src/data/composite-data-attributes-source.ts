/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { LRUCache } from 'lru-cache';
import winston from 'winston';

import {
  ContiguousDataAttributes,
  ContiguousDataAttributesStore,
  DataAttributesSource,
} from '../types.js';

const DEFAULT_MAX_CACHE_SIZE = 10000;

/**
 * How long a retrieval-time seed from {@link
 * CompositeDataAttributesSource.setDataAttributes} may answer reads before the
 * source is consulted again.
 *
 * Seeded entries are partial by construction -- callers write what retrieval
 * knew, which for `contentType` is frequently nothing -- and a cache hit
 * short-circuits `fetchAndCache`. Without a bound, one partial seed masks the
 * database record for the life of the process, so an item whose stored content
 * type is correct is still served as `application/octet-stream` until the entry
 * happens to be evicted by capacity pressure. The window is long enough to
 * cover the gap between retrieval and the corresponding database write, which
 * is the reason the seed exists.
 */
const DEFAULT_PARTIAL_SEED_TTL_MS = 30000;

export class CompositeDataAttributesSource
  implements ContiguousDataAttributesStore
{
  private log: winston.Logger;
  private source: DataAttributesSource;
  private partialSeedTtlMs: number;
  private cache: LRUCache<string, ContiguousDataAttributes>;
  private pendingPromises: Map<
    string,
    Promise<ContiguousDataAttributes | undefined>
  >;

  constructor({
    log,
    source,
    cacheSize = DEFAULT_MAX_CACHE_SIZE,
    partialSeedTtlMs = DEFAULT_PARTIAL_SEED_TTL_MS,
  }: {
    log: winston.Logger;
    source: DataAttributesSource;
    cacheSize?: number;
    partialSeedTtlMs?: number;
  }) {
    // A non-positive or fractional TTL cannot express "expire a seed after
    // this long", and `0` in particular is not a short expiry: lru-cache reads
    // it as no expiry at all, so seeds would mask the source indefinitely and
    // `getRemainingTTL` would report Infinity, making `isSeededEntry` classify
    // them as source-backed too. Fail at construction rather than silently
    // restoring the behaviour this class exists to prevent.
    if (
      !Number.isInteger(partialSeedTtlMs) ||
      (partialSeedTtlMs as number) <= 0
    ) {
      throw new Error(
        `partialSeedTtlMs must be a positive integer, got ${partialSeedTtlMs}`,
      );
    }

    this.log = log.child({ class: this.constructor.name });
    this.source = source;
    this.partialSeedTtlMs = partialSeedTtlMs;
    this.cache = new LRUCache<string, ContiguousDataAttributes>({
      max: cacheSize,
      // Entries written by `fetchAndCache` are set without a TTL and so never
      // expire; only seeded entries pass one to `set`. `ttlAutopurge` keeps
      // expired seeds from occupying capacity until they are next read.
      ttlAutopurge: true,
    });
    this.pendingPromises = new Map();
  }

  /**
   * True when `id` is held by a seed rather than a source-backed record.
   * Source-backed entries are written without a TTL, so their remaining TTL is
   * `Infinity`; a live seed reports a positive finite value. An absent key
   * reports `0`, which is excluded here so that a caller reaching this with no
   * entry gets the permanent (source-backed) default rather than being told the
   * entry is a seed.
   */
  private isSeededEntry(id: string): boolean {
    const remainingTtl = this.cache.getRemainingTTL(id);
    return remainingTtl > 0 && Number.isFinite(remainingTtl);
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

  /**
   * Merge partial attributes into the cache. When an existing entry is
   * present, incoming values are applied on top, but DB-authoritative
   * fields (contentType, isManifest) are preserved via reverse splat
   * so partial producers cannot overwrite them.
   */
  async setDataAttributes(
    id: string,
    attributes: Partial<ContiguousDataAttributes>,
  ): Promise<void> {
    this.log.debug('Setting data attributes in cache', { id });
    const existingAttributes = this.cache.get(id);
    // Read before the write below, which would otherwise reset the TTL and
    // make the answer meaningless.
    const wasSeeded = this.isSeededEntry(id);
    if (existingAttributes != null) {
      // Preserve DB-authoritative fields from the existing entry
      const authoritative: Partial<ContiguousDataAttributes> = {};
      if (existingAttributes.contentType != null) {
        authoritative.contentType = existingAttributes.contentType;
      }
      if (existingAttributes.isManifest != null) {
        authoritative.isManifest = existingAttributes.isManifest;
      }
      this.cache.set(
        id,
        {
          ...existingAttributes,
          ...attributes,
          ...authoritative,
        },
        // Merging another partial write into a seed must not promote it to a
        // permanent entry, or a steady trickle of writes would keep an entry
        // that has never seen the source alive indefinitely.
        //
        // `noUpdateTTL` is what makes that true: `set` otherwise restarts the
        // countdown, so writes arriving more often than the TTL would postpone
        // the deadline forever. The value is still updated -- only the expiry
        // is left alone.
        wasSeeded
          ? { ttl: this.partialSeedTtlMs, noUpdateTTL: true }
          : undefined,
      );
    } else {
      // Seed the cache with partial attributes. Callers like
      // ReadThroughDataCache rely on this to serve hash/size/contentType in
      // the window between retrieval and the corresponding database write.
      //
      // The TTL is what keeps that a shortcut rather than a replacement: a
      // cache hit returns without consulting the source, so an unbounded seed
      // -- typically carrying `contentType: undefined`, because the upstream
      // response had no usable Content-Type -- would answer every later read
      // with a value the database could have corrected.
      this.cache.set(id, attributes as ContiguousDataAttributes, {
        ttl: this.partialSeedTtlMs,
      });
    }
  }
}
