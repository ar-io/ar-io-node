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
import {
  contentTypeSourceOutranks,
  isOctetStreamPlaceholder,
} from '../lib/content-type.js';
import { MANIFEST_CONTENT_TYPE } from '../lib/encoding.js';

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

/**
 * Whether `incoming`'s content type replaces `existing`'s in memory: a
 * better-ranked type always does, and a specific type replaces the
 * octet-stream placeholder unless it is lower-ranked.
 */
const incomingContentTypeWins = (
  existing: Partial<ContiguousDataAttributes>,
  incoming: Partial<ContiguousDataAttributes>,
): boolean => {
  if (incoming.contentType == null) {
    return false;
  }
  if (
    contentTypeSourceOutranks(
      incoming.contentTypeSource,
      existing.contentTypeSource,
    )
  ) {
    return true;
  }
  return (
    isOctetStreamPlaceholder(existing.contentType) &&
    !isOctetStreamPlaceholder(incoming.contentType) &&
    !contentTypeSourceOutranks(
      existing.contentTypeSource,
      incoming.contentTypeSource,
    )
  );
};

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
  // When each recently invalidated ID was invalidated (a counter, not a
  // clock). A source read that began before an invalidation must not cache
  // what it read, or the stale value it was invalidating would come back.
  private invalidationStamps: LRUCache<string, number>;
  private invalidationCounter = 0;

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
    this.invalidationStamps = new LRUCache<string, number>({ max: cacheSize });
  }

  /**
   * Drops what is held for `id`, so the next read goes to the source.
   *
   * Source-backed entries never expire, so without this a record the database
   * has since corrected (for example an item indexed after it was first
   * served, whose indexed Content-Type now outranks the per-hash value) would
   * keep being answered from memory until eviction or restart. Called once the
   * index write has finished.
   */
  invalidate(id: string): void {
    this.cache.delete(id);
    this.pendingPromises.delete(id);
    this.invalidationStamps.set(id, ++this.invalidationCounter);
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
      // Clean up our own pending promise only: an invalidation may have
      // replaced it with a newer read, which must stay shareable.
      if (this.pendingPromises.get(id) === promise) {
        this.pendingPromises.delete(id);
      }
    }
  }

  private async fetchAndCache(
    id: string,
  ): Promise<ContiguousDataAttributes | undefined> {
    this.log.debug('Fetching data attributes from source', { id });
    const invalidationStamp = this.invalidationStamps.get(id);

    try {
      const result = await this.source.getDataAttributes(id);

      if (
        result !== undefined &&
        this.invalidationStamps.get(id) !== invalidationStamp
      ) {
        // Invalidated while this read was in flight: what it read may be the
        // stale value. Answer this caller, but leave the cache to the next read.
        this.log.debug('Not caching data attributes read before invalidation', {
          id,
        });
      } else if (result !== undefined) {
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
   *
   * The one content type that does **not** hold its ground is the
   * octet-stream placeholder. It is what an entry carries when nobody had
   * read the item's tags yet, so preserving it over an incoming specific
   * type pins the wrong answer in memory: the write that heals
   * `contiguous_data.original_source_content_type` on the cache-miss path
   * would correct the row while this cache — which has no TTL — kept serving
   * the placeholder until eviction or restart. Yielding to a specific type
   * mirrors the one-way transition `insertDataHash` allows, so memory and
   * the persisted row heal together.
   *
   * Otherwise a type is replaced only by a better-ranked one (see
   * `ContentTypeSource`): the item's own tag replaces a per-hash value that
   * may belong to another item with the same bytes. A specific type is never
   * replaced by an equal- or lower-ranked one, or by the placeholder, and the
   * placeholder does not yield to a lower-ranked type either, since an item
   * whose indexed tag really is octet-stream must keep it.
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
      if (
        existingAttributes.contentType != null &&
        !incomingContentTypeWins(existingAttributes, attributes)
      ) {
        // Kept with its rank, so a lower-ranked write cannot relabel it.
        authoritative.contentType = existingAttributes.contentType;
        authoritative.contentTypeSource = existingAttributes.contentTypeSource;
      }
      // isManifest follows the type it was derived from (as the index derives
      // it): kept while the type is, recomputed when a better-ranked type
      // replaces it, or an HTML item would go to manifest resolution.
      const mergedContentType =
        authoritative.contentType ??
        attributes.contentType ??
        existingAttributes.contentType;
      if (
        mergedContentType != null &&
        mergedContentType !== existingAttributes.contentType
      ) {
        authoritative.isManifest = mergedContentType === MANIFEST_CONTENT_TYPE;
      } else if (existingAttributes.isManifest != null) {
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
