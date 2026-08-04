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
} from '../types.js';

export class StreamingManifestPathResolver implements ManifestPathResolver {
  private log: winston.Logger;
  private cache: LRUCache<string, ManifestResolution>;

  constructor({
    log,
    cacheSize = 5000,
  }: {
    log: winston.Logger;
    cacheSize?: number;
  }) {
    this.log = log.child({ class: 'StreamingManifestPathResolver' });
    // A manifest transaction is immutable, so a resolved
    // (manifest id, path) -> data id mapping is valid forever — no TTL needed.
    // Bounded by `max` to cap memory and blunt path-scan cache pressure.
    this.cache = new LRUCache<string, ManifestResolution>({ max: cacheSize });
  }

  /**
   * Build the cache key for a manifest path resolution.
   *
   * The path is trailing-slash-normalized so `/foo` and `/foo/` share an
   * entry, matching resolveManifestStreamPath's own normalization, and a NUL
   * separator keeps the manifest id and path boundary unambiguous.
   *
   * @param id - Manifest transaction id.
   * @param path - Requested sub-path, or undefined for the manifest root.
   * @returns A cache key unique to the (manifest, normalized path) pair.
   */
  private cacheKey(id: string, path: string | undefined): string {
    return `${id}\0${(path ?? '').replace(/\/+$/g, '')}`;
  }

  async resolveFromIndex(
    id: string,
    path: string | undefined,
  ): Promise<ManifestResolution> {
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
    // Cache miss: signal `complete: false` so the caller falls through to
    // fetching the body and resolving via resolveFromData.
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
    const resolution: ManifestResolution = {
      id,
      resolvedId,
      complete: true,
      resolutionType,
    };
    // Cache the immutable result (positive or negative) so repeat requests for
    // this (manifest, path) skip the fetch + stream-parse entirely.
    this.cache.set(this.cacheKey(id, path), resolution);
    return resolution;
  }
}
