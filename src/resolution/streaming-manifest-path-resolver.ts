/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { LRUCache } from 'lru-cache';
import winston from 'winston';

import { resolveManifestStreamPath } from '../lib/encoding.js';
import {
  ContiguousData,
  ManifestPathResolver,
  ManifestResolution,
  ManifestResolutionStore,
} from '../types.js';

export class StreamingManifestPathResolver implements ManifestPathResolver {
  private log: winston.Logger;
  private cache: LRUCache<string, ManifestResolution>;
  private store: ManifestResolutionStore | undefined;

  constructor({
    log,
    cacheSize = 5000,
    store,
  }: {
    log: winston.Logger;
    cacheSize?: number;
    store?: ManifestResolutionStore;
  }) {
    this.log = log.child({ class: 'StreamingManifestPathResolver' });
    // A manifest transaction is immutable, so a resolved
    // (manifest id, path) -> data id mapping is valid forever — no TTL needed.
    // Bounded by `max` to cap memory and blunt path-scan cache pressure.
    this.cache = new LRUCache<string, ManifestResolution>({ max: cacheSize });
    this.store = store;
  }

  // Trailing-slash-normalized so `/foo` and `/foo/` are equivalent, matching
  // resolveManifestStreamPath's own normalization. An empty result is the root.
  private normalizePath(path: string | undefined): string {
    return (path ?? '').replace(/\/+$/g, '');
  }

  /**
   * Build the cache key for a manifest path resolution.
   *
   * The path is trailing-slash-normalized so `/foo` and `/foo/` share an
   * entry, and a NUL separator keeps the manifest id and path boundary
   * unambiguous.
   *
   * @param id - Manifest transaction id.
   * @param path - Requested sub-path, or undefined for the manifest root.
   * @returns A cache key unique to the (manifest, normalized path) pair.
   */
  private cacheKey(id: string, path: string | undefined): string {
    return `${id}\0${this.normalizePath(path)}`;
  }

  // Cache the immutable resolution (positive or negative) and return it.
  private remember(
    id: string,
    path: string | undefined,
    resolution: ManifestResolution,
  ): ManifestResolution {
    this.cache.set(this.cacheKey(id, path), resolution);
    return resolution;
  }

  async resolveFromIndex(
    id: string,
    path: string | undefined,
  ): Promise<ManifestResolution> {
    // In-memory cache covers any (manifest, path) — including sub-paths and
    // negatives — but only within the current process lifetime.
    const cached = this.cache.get(this.cacheKey(id, path));
    if (cached !== undefined) {
      this.log.debug('Resolved manifest path from cache', {
        id,
        path,
        resolvedId: cached.resolvedId,
        resolutionType: cached.resolutionType,
      });
      // `complete: true` short-circuits the caller: a cached hit serves the
      // resolvedId, a cached miss (resolvedId undefined) 404s — neither
      // re-fetches the manifest body. See sendManifestResponse.
      return { ...cached, id };
    }

    // Persistent index covers the manifest root only (index/fallback) — the
    // highest-traffic case — and survives restarts. Sub-paths are not stored
    // (the index has no path map), so they fall through to resolveFromData and
    // are served from the in-memory cache thereafter.
    if (this.store !== undefined && this.normalizePath(path) === '') {
      try {
        const row = await this.store.getManifestResolution(id);
        if (row?.indexId !== undefined) {
          return this.remember(id, path, {
            id,
            resolvedId: row.indexId,
            complete: true,
            resolutionType: 'index',
          });
        }
        if (row?.fallbackId !== undefined) {
          return this.remember(id, path, {
            id,
            resolvedId: row.fallbackId,
            complete: true,
            resolutionType: 'fallback',
          });
        }
      } catch (error: any) {
        // A store failure must never break serving — fall through to data.
        this.log.warn('Manifest resolution store lookup failed', {
          id,
          message: error?.message,
        });
      }
    }

    // Cache/index miss: signal `complete: false` so the caller falls through
    // to fetching the body and resolving via resolveFromData.
    return {
      id,
      resolvedId: undefined,
      complete: false,
    };
  }

  async resolveFromData(
    data: ContiguousData,
    id: string,
    path: string | undefined,
  ): Promise<ManifestResolution> {
    this.log.info('Resolving manifest path from data...', { id, path });
    const { id: resolvedId, resolutionType } = await resolveManifestStreamPath(
      data.stream,
      path,
    );
    this.log.info('Resolved manifest path from data', {
      id,
      path,
      resolvedId,
      resolutionType,
    });
    const resolution = this.remember(id, path, {
      id,
      resolvedId,
      complete: true,
      resolutionType,
    });

    // Persist the manifest root's index/fallback id so future requests — and
    // future process lifetimes — can serve it without fetching the body. Only
    // the root resolves via 'index'/'fallback'; sub-paths are never stored.
    if (
      this.store !== undefined &&
      this.normalizePath(path) === '' &&
      resolvedId !== undefined &&
      (resolutionType === 'index' || resolutionType === 'fallback')
    ) {
      // Fire-and-forget: persistence must not block or fail the response.
      this.store
        .saveManifestResolution({
          id,
          indexId: resolutionType === 'index' ? resolvedId : undefined,
          fallbackId: resolutionType === 'fallback' ? resolvedId : undefined,
          resolvedAt: Math.floor(Date.now() / 1000),
        })
        .catch((error: any) => {
          this.log.warn('Failed to persist manifest resolution', {
            id,
            message: error?.message,
          });
        });
    }

    return resolution;
  }
}
