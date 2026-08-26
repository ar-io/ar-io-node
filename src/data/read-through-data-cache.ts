/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Span } from '@opentelemetry/api';
import crypto from 'node:crypto';
import * as EventEmitter from 'node:events';
import { PassThrough, Readable, Transform, pipeline } from 'node:stream';
import winston from 'winston';

import {
  CONTIGUOUS_DATA_CACHE_INDEX_UPDATE_ON_READ,
  PREFERRED_ARNS_BASE_NAMES,
  PREFERRED_ARNS_NAMES,
} from '../config.js';
import { verificationPriorities } from '../constants.js';
import * as events from '../events.js';
import { generateRequestAttributes } from '../lib/request-attributes.js';
import { Semaphore } from '../lib/semaphore.js';
import { currentUnixTimestamp } from '../lib/time.js';
import * as metrics from '../metrics.js';
import { KvJsonStore } from '../store/kv-attributes-store.js';
import { startChildSpan } from '../tracing.js';
import {
  ContiguousData,
  ContiguousDataAttributesStore,
  ContiguousDataCacheIndex,
  ContiguousDataIndex,
  ContiguousDataSource,
  ContiguousDataStore,
  ContiguousMetadata,
  RequestAttributes,
} from '../types.js';
import { DataContentAttributeImporter } from '../workers/data-content-attribute-importer.js';

const MAX_MRU_ARNS_NAMES_LENGTH = 10;

/**
 * How a leader's foreground fetch ended, as seen by callers waiting on it.
 *
 * The distinction drives leader re-election. `false` alone conflated three
 * different endings, and only one of them is worth electing a new leader for:
 *
 * - `cached`   — a blob was finalized. Waiters re-read the cache and are served.
 * - `uncached` — the fetch succeeded but the write was declined by policy
 *                (size cap, concurrency cap, zero-length). Writes being
 *                disabled, and ranged requests, cannot produce this: both
 *                clear `coalescingEligible`, so such a request never claims
 *                the ID and so never has waiters to report an outcome to.
 *                A new leader would hit the same policy, so waiters go
 *                straight to their own fetch rather than re-electing.
 * - `failed`   — the fetch errored, or its caller aborted. Nothing about the
 *                object says the next attempt must fail too, so one waiter is
 *                promoted to leader and the rest wait on it instead of every
 *                waiter firing its own fetch in the same tick.
 */
type ForegroundFetchOutcome = 'cached' | 'uncached' | 'failed';

function updateMruList(
  currentMruList: string[] | string | undefined,
  newItem: string | undefined,
  maxLength: number,
): string[] {
  let updatedList: string[] = [];
  if (currentMruList !== undefined) {
    if (Array.isArray(currentMruList)) {
      updatedList = [...currentMruList];
    } else if (typeof currentMruList === 'string') {
      updatedList = [currentMruList];
    }
  }

  if (newItem !== undefined) {
    updatedList = updatedList.filter((name) => name !== newItem);
    updatedList.unshift(newItem);

    if (updatedList.length > maxLength) {
      updatedList = updatedList.slice(0, maxLength);
    }
  }
  return updatedList;
}

/**
 * Arguments to {@link ReadThroughDataCache.getData}. Extracted as a named type
 * because the public entry point forwards them unchanged to the internal
 * implementation, which takes an additional coalescing attempt budget.
 */
type GetDataArgs = {
  /** Transaction or data item ID to retrieve. */
  id: string;
  /** Caller context (ArNS name, hops, origin) used for verification priority, cache-index tiering and MRU bookkeeping. */
  requestAttributes?: RequestAttributes;
  /**
   * Byte range to serve, relative to the start of the item.
   *
   * Ranged requests are deliberately never written to the cache -- persisting
   * fragments would record invalid ID-to-hash relationships -- so they are
   * also never coalesced, since no finalized blob would exist for a waiting
   * caller to be served from. A range miss may instead trigger a background
   * fetch of the whole item; see `triggerBackgroundCacheForRange`.
   */
  region?: {
    offset: number;
    size: number;
  };
  /** Parent OTEL span; the retrieval span is attached beneath it. */
  parentSpan?: Span;
  /**
   * Aborts this caller's request. It does not abort a fetch shared with other
   * callers: a request waiting on another's in-flight fetch detaches itself
   * only, leaving that fetch and its staging file intact for everyone else.
   */
  signal?: AbortSignal;
  /**
   * Rejects cached content by content type. Returning false for a cached
   * entry's stored content type evicts the blob and treats the request as a
   * cold miss, which heals entries poisoned by upstream error pages
   * (PE-9099). Also forwarded upstream.
   */
  acceptContentType?: (contentType: string | undefined) => boolean;
};

export class ReadThroughDataCache implements ContiguousDataSource {
  private log: winston.Logger;
  private dataSource: ContiguousDataSource;
  private metadataStore: KvJsonStore<ContiguousMetadata>;
  private dataStore: ContiguousDataStore;
  private contiguousDataIndex: ContiguousDataIndex;
  private dataAttributesStore: ContiguousDataAttributesStore;
  private dataContentAttributeImporter: DataContentAttributeImporter;
  // Optional cleanup index: when present, each cache write records its
  // {hash, size, cachedAt, tier} so the index-driven evictor can reclaim
  // without a filesystem walk (PE-9131).
  private contiguousDataCacheIndex?: ContiguousDataCacheIndex;
  /**
   * Bypass the cache entirely: serve nothing from it, write nothing to it, and
   * populate no cache-index rows. Implies {@link skipCacheWrites}.
   */
  private skipCache: boolean;
  /**
   * Suppress cache writes -- both the full-response caching pipeline and
   * background range caching -- while leaving cache reads and cache-index
   * population intact.
   *
   * This is the control for a cache volume under disk pressure: it stops the
   * volume growing without stopping it being served, and without starving the
   * index-driven evictor of the rows it needs to reclaim space.
   */
  private skipCacheWrites: boolean;
  private eventEmitter?: EventEmitter;
  private untrustedCacheRetryRate: number;
  private trustedCacheRetryRate: number;
  private pendingRetries: Set<string> = new Set();
  private pendingBackgroundCaches: Set<string> = new Set();
  private backgroundCacheRangeMaxSize: number;
  private backgroundCacheSemaphore: Semaphore;
  /**
   * Single-flight map for foreground full-object fetches, keyed by data ID.
   *
   * Without this, N concurrent requests for one uncached object each ran their
   * own upstream fetch and opened their own staging file. Observed in
   * production as 59 concurrent partial copies of a single 1.5 GB bundle --
   * 83% of ~253 GB staged in `contiguous/tmp` was redundant, and because the
   * disk never drained no copy finished, so every new request was also a miss
   * and started yet another copy.
   *
   * The first caller for an ID becomes the leader: it owns the upstream fetch,
   * the staging file, and the tee. Later callers do not touch any of those --
   * they wait on the leader's promise and are then served from the blob the
   * leader finalized. See {@link awaitInFlightFetch} for why followers can
   * never cancel or destroy the shared fetch.
   */
  private inFlightForegroundFetches: Map<
    string,
    Promise<ForegroundFetchOutcome>
  > = new Map();
  private foregroundCacheMaxSize: number;
  /** Undefined when foreground cache-write concurrency is unbounded. */
  private foregroundCacheSemaphore: Semaphore | undefined;
  /** 0 waits indefinitely. See the config docs for why a bound matters. */
  private foregroundCacheCoalesceTimeoutMs: number;
  /**
   * Known object sizes below this never coalesce. 0 disables the floor. An
   * object of unknown size is treated as eligible, so this can only narrow
   * coalescing where the object is positively known to be small.
   */
  private foregroundCacheCoalesceMinSize: number;
  /**
   * How many times one request may attach to a leader before fetching for
   * itself. 1 disables re-election (a single attach, then go it alone).
   */
  private foregroundCacheCoalesceMaxAttempts: number;

  constructor({
    log,
    dataSource,
    metadataStore,
    dataStore,
    contiguousDataIndex,
    dataAttributesStore,
    dataContentAttributeImporter,
    contiguousDataCacheIndex,
    skipCache = false,
    skipCacheWrites = false,
    eventEmitter,
    untrustedCacheRetryRate = 0,
    trustedCacheRetryRate = 0,
    backgroundCacheRangeMaxSize = 0,
    backgroundCacheRangeConcurrency = 1,
    foregroundCacheMaxSize = 0,
    foregroundCacheConcurrency = 0,
    foregroundCacheCoalesceTimeoutMs = 300000,
    foregroundCacheCoalesceMinSize = 0,
    foregroundCacheCoalesceMaxAttempts = 2,
    foregroundCacheSemaphore,
  }: {
    log: winston.Logger;
    dataSource: ContiguousDataSource;
    metadataStore: KvJsonStore<ContiguousMetadata>;
    dataStore: ContiguousDataStore;
    contiguousDataIndex: ContiguousDataIndex;
    dataAttributesStore: ContiguousDataAttributesStore;
    dataContentAttributeImporter: DataContentAttributeImporter;
    contiguousDataCacheIndex?: ContiguousDataCacheIndex;
    skipCache?: boolean;
    skipCacheWrites?: boolean;
    eventEmitter?: EventEmitter;
    untrustedCacheRetryRate?: number;
    trustedCacheRetryRate?: number;
    backgroundCacheRangeMaxSize?: number;
    backgroundCacheRangeConcurrency?: number;
    foregroundCacheMaxSize?: number;
    foregroundCacheConcurrency?: number;
    foregroundCacheCoalesceTimeoutMs?: number;
    foregroundCacheCoalesceMinSize?: number;
    foregroundCacheCoalesceMaxAttempts?: number;
    /**
     * Shared across instances by {@link system}. The resource being bounded is
     * `contiguous/tmp` on one disk, which every instance writes to, so the
     * budget has to be process-wide rather than per-instance. Takes precedence
     * over {@link foregroundCacheConcurrency}, which exists for standalone use.
     */
    foregroundCacheSemaphore?: Semaphore;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.dataSource = dataSource;
    this.metadataStore = metadataStore;
    this.dataStore = dataStore;
    this.contiguousDataIndex = contiguousDataIndex;
    this.dataAttributesStore = dataAttributesStore;
    this.dataContentAttributeImporter = dataContentAttributeImporter;
    this.contiguousDataCacheIndex = contiguousDataCacheIndex;
    this.skipCache = skipCache;
    // A full cache bypass necessarily bypasses writes too.
    this.skipCacheWrites = skipCacheWrites || skipCache;
    this.eventEmitter = eventEmitter;
    this.untrustedCacheRetryRate = untrustedCacheRetryRate;
    this.trustedCacheRetryRate = trustedCacheRetryRate;
    if (
      !Number.isFinite(backgroundCacheRangeMaxSize) ||
      backgroundCacheRangeMaxSize < 0
    ) {
      throw new Error(
        'backgroundCacheRangeMaxSize must be a non-negative finite number',
      );
    }
    if (
      !Number.isFinite(backgroundCacheRangeConcurrency) ||
      backgroundCacheRangeConcurrency < 1
    ) {
      throw new Error(
        'backgroundCacheRangeConcurrency must be a positive finite number',
      );
    }

    if (
      !Number.isFinite(foregroundCacheMaxSize) ||
      foregroundCacheMaxSize < 0
    ) {
      throw new Error(
        'foregroundCacheMaxSize must be a non-negative finite number',
      );
    }
    // Integer, not merely finite: a fractional permit count would otherwise
    // either throw from inside Semaphore or silently yield a half-permit.
    if (
      !Number.isInteger(foregroundCacheConcurrency) ||
      foregroundCacheConcurrency < 0
    ) {
      throw new Error(
        'foregroundCacheConcurrency must be a non-negative integer',
      );
    }
    if (
      !Number.isFinite(foregroundCacheCoalesceTimeoutMs) ||
      foregroundCacheCoalesceTimeoutMs < 0
    ) {
      throw new Error(
        'foregroundCacheCoalesceTimeoutMs must be a non-negative finite number',
      );
    }
    if (
      !Number.isFinite(foregroundCacheCoalesceMinSize) ||
      foregroundCacheCoalesceMinSize < 0
    ) {
      throw new Error(
        'foregroundCacheCoalesceMinSize must be a non-negative finite number',
      );
    }
    // At least 1: a request must be allowed one attach, otherwise coalescing is
    // off entirely and the single-flight map would never be consulted.
    if (
      !Number.isInteger(foregroundCacheCoalesceMaxAttempts) ||
      foregroundCacheCoalesceMaxAttempts < 1
    ) {
      throw new Error(
        'foregroundCacheCoalesceMaxAttempts must be an integer >= 1',
      );
    }

    this.backgroundCacheRangeMaxSize = backgroundCacheRangeMaxSize;
    this.backgroundCacheSemaphore = new Semaphore(
      backgroundCacheRangeConcurrency,
    );
    this.foregroundCacheMaxSize = foregroundCacheMaxSize;
    // 0 means unbounded -- leave the semaphore unset rather than constructing
    // one with a permit count that would reject in the Semaphore constructor.
    this.foregroundCacheSemaphore =
      foregroundCacheSemaphore ??
      (foregroundCacheConcurrency > 0
        ? new Semaphore(foregroundCacheConcurrency)
        : undefined);
    this.foregroundCacheCoalesceTimeoutMs = foregroundCacheCoalesceTimeoutMs;
    this.foregroundCacheCoalesceMinSize = foregroundCacheCoalesceMinSize;
    this.foregroundCacheCoalesceMaxAttempts =
      foregroundCacheCoalesceMaxAttempts;
  }

  private calculateVerificationPriority(
    requestAttributes?: RequestAttributes,
  ): number | undefined {
    const { arnsName, arnsBasename } = requestAttributes ?? {};

    // Check if the ArNS name is preferred
    const isPreferredName =
      arnsName !== undefined && PREFERRED_ARNS_NAMES.has(arnsName);
    const isPreferredBasename =
      arnsBasename !== undefined && PREFERRED_ARNS_BASE_NAMES.has(arnsBasename);

    if (isPreferredName || isPreferredBasename) {
      this.log.debug('Setting preferred ArNS verification priority', {
        arnsName,
        arnsBasename,
        priority: verificationPriorities.preferredArns,
      });
      return verificationPriorities.preferredArns;
    }

    // Check if any ArNS attributes are present
    if (arnsName !== undefined || arnsBasename !== undefined) {
      this.log.debug('Setting ArNS verification priority', {
        arnsName,
        arnsBasename,
        priority: verificationPriorities.arns,
      });
      return verificationPriorities.arns;
    }

    return undefined;
  }

  // Record a freshly-cached blob in the cleanup index (best-effort). Tier 1 =
  // preferred ArNS (evicted last), tier 0 = general. No-op when the index is
  // not wired (feature disabled).
  private recordCacheIndexEntry(
    hash: string,
    size: number,
    requestAttributes?: RequestAttributes,
  ): void {
    if (this.contiguousDataCacheIndex === undefined) {
      return;
    }
    const priority = this.calculateVerificationPriority(requestAttributes);
    const tier = priority === verificationPriorities.preferredArns ? 1 : 0;
    this.contiguousDataCacheIndex
      .saveContiguousDataCacheEntry({
        hash,
        size,
        cachedAt: currentUnixTimestamp(),
        tier,
      })
      .catch((error: any) => {
        this.log.debug('Failed to record cache index entry', {
          hash,
          message: error?.message,
        });
      });
  }

  // Refresh a cached blob's recency (and promote its tier on a preferred-ArNS
  // read) in the cleanup index on a cache hit. No-op when the index isn't wired
  // or update-on-read is disabled (FIFO mode). Best-effort.
  private touchCacheIndexEntry(
    hash: string,
    requestAttributes?: RequestAttributes,
  ): void {
    if (
      this.contiguousDataCacheIndex === undefined ||
      !CONTIGUOUS_DATA_CACHE_INDEX_UPDATE_ON_READ
    ) {
      return;
    }
    const priority = this.calculateVerificationPriority(requestAttributes);
    const tier = priority === verificationPriorities.preferredArns ? 1 : 0;
    this.contiguousDataCacheIndex
      .touchContiguousDataCacheEntry(hash, currentUnixTimestamp(), tier)
      .catch((error: any) => {
        this.log.debug('Failed to touch cache index entry', {
          hash,
          message: error?.message,
        });
      });
  }

  private async updateMetadataCache({
    hash,
    arnsName,
    arnsBasename,
  }: {
    hash: string;
    arnsName?: string;
    arnsBasename?: string;
  }): Promise<void> {
    const existingMetadata = await this.metadataStore.get(hash);

    // Prepare the metadata object for storage. Start with existing fields (if
    // any) to preserve them.
    const metadataToSet: ContiguousMetadata = {
      ...(existingMetadata ?? {}),
      accessTimestampMs: Date.now(), // Update the access timestamp
    };

    if (arnsName !== undefined) {
      const updatedMruArnsNames = updateMruList(
        existingMetadata?.mruArNSNames,
        arnsName,
        MAX_MRU_ARNS_NAMES_LENGTH,
      );

      const updatedMruArnsBaseNames = updateMruList(
        existingMetadata?.mruArNSBaseNames,
        arnsBasename,
        MAX_MRU_ARNS_NAMES_LENGTH,
      );

      if (updatedMruArnsNames.length > 0) {
        metadataToSet.mruArNSNames = updatedMruArnsNames;
      } else {
        // If the list is empty, remove the field to keep the stored object
        // clean, aligning with how optional fields are typically handled.
        delete metadataToSet.mruArNSNames;
      }

      if (updatedMruArnsBaseNames.length > 0) {
        metadataToSet.mruArNSBaseNames = updatedMruArnsBaseNames;
      } else {
        delete metadataToSet.mruArNSBaseNames;
      }
    }

    this.metadataStore.set(hash, metadataToSet as ContiguousMetadata);
  }

  private triggerBackgroundReVerification(
    id: string,
    cachedHash: string,
    trustStatus: 'trusted' | 'untrusted',
  ): void {
    this.pendingRetries.add(id);
    metrics.cacheRetryAttemptsTotal.inc({ trust_status: trustStatus });

    this.dataSource
      .getData({ id })
      .then(async (upstreamData) => {
        const hasher = crypto.createHash('sha256');
        const stream = upstreamData.stream;

        await new Promise<void>((resolve, reject) => {
          stream.on('data', (chunk: Buffer) => hasher.update(chunk));
          stream.on('end', resolve);
          stream.on('error', reject);
        });

        const upstreamHash = hasher.digest('base64url');

        if (upstreamHash === cachedHash) {
          metrics.cacheRetryMatchesTotal.inc();
          this.log.debug('Cache re-verification hash match', {
            id,
            hash: cachedHash,
          });
        } else {
          metrics.cacheRetryMismatchesTotal.inc();
          metrics.cacheEvictionsTotal.inc();
          this.log.warn('Cache re-verification hash mismatch, evicting', {
            id,
            cachedHash,
            upstreamHash,
          });

          await this.dataStore.delete(cachedHash);
          await this.contiguousDataIndex.clearDataHash(id);
          await this.dataAttributesStore.setDataAttributes(id, {
            hash: undefined,
          });
        }
      })
      .catch((error: any) => {
        this.log.debug('Cache re-verification fetch failed', {
          id,
          message: error.message,
        });
      })
      .finally(() => {
        this.pendingRetries.delete(id);
      });
  }

  private triggerBackgroundCacheForRange(
    id: string,
    dataSize: number | undefined,
    requestAttributes?: RequestAttributes,
  ): void {
    if (this.backgroundCacheRangeMaxSize <= 0) {
      metrics.backgroundRangeCacheSkippedTotal.inc({ reason: 'disabled' });
      return;
    }

    if (this.skipCacheWrites) {
      metrics.backgroundRangeCacheSkippedTotal.inc({
        reason: 'skip_cache_set',
      });
      return;
    }

    if (dataSize === undefined || !Number.isFinite(dataSize) || dataSize < 0) {
      metrics.backgroundRangeCacheSkippedTotal.inc({
        reason: 'unknown_size',
      });
      return;
    }

    if (this.pendingBackgroundCaches.has(id)) {
      metrics.backgroundRangeCacheSkippedTotal.inc({
        reason: 'already_pending',
      });
      return;
    }

    // A foreground fetch of this ID is already downloading and caching the
    // whole object, so a background full-item fetch would be pure duplication.
    // Skipping also keeps the background permit free: without this check the
    // trigger below would coalesce onto that foreground leader and hold its
    // permit for the duration -- with BACKGROUND_CACHE_RANGE_CONCURRENCY
    // defaulting to 1, one slow foreground fetch would stall background range
    // caching process-wide.
    if (this.inFlightForegroundFetches.has(id)) {
      metrics.backgroundRangeCacheSkippedTotal.inc({
        reason: 'already_pending',
      });
      return;
    }

    if (dataSize > this.backgroundCacheRangeMaxSize) {
      metrics.backgroundRangeCacheSkippedTotal.inc({
        reason: 'exceeds_max_size',
      });
      return;
    }

    if (!this.backgroundCacheSemaphore.tryAcquire()) {
      metrics.backgroundRangeCacheSkippedTotal.inc({ reason: 'at_capacity' });
      return;
    }

    this.pendingBackgroundCaches.add(id);
    metrics.backgroundRangeCacheTriggeredTotal.inc();
    this.log.debug('Triggered background range cache fetch', { id, dataSize });

    this.getData({ id, requestAttributes })
      .then((result) => {
        return new Promise<void>((resolve, reject) => {
          result.stream.on('end', () => {
            this.log.debug('Completed background range cache fetch', { id });
            metrics.backgroundRangeCacheCompletedTotal.inc();
            resolve();
          });
          result.stream.on('error', reject);
          result.stream.resume();
        });
      })
      .catch((error: any) => {
        this.log.debug('Background range cache fetch failed', {
          id,
          message: error.message,
        });
        metrics.backgroundRangeCacheFailedTotal.inc();
      })
      .finally(() => {
        this.pendingBackgroundCaches.delete(id);
        this.backgroundCacheSemaphore.release();
      });
  }

  async getCacheData(
    id: string,
    hash?: string,
    dataSize?: number,
    region?: {
      offset: number;
      size: number;
    },
  ): Promise<
    | {
        stream: Readable;
        size: number;
      }
    | undefined
  > {
    // Skip cache retrieval if configured to do so
    if (this.skipCache) {
      this.log.debug(
        'Skipping cache retrieval due to SKIP_DATA_CACHE setting',
        { id },
      );
      return undefined;
    }

    if (hash !== undefined) {
      try {
        this.log.debug('Found data hash in index', { id, hash });
        const cacheStream = await this.dataStore.get(hash, region);

        if (cacheStream === undefined) {
          this.log.debug('Unable to find data in cache', {
            id,
            hash,
            ...region,
          });
        } else {
          this.log.debug('Found data in cache', { id, hash, ...region });
          // It should be impossible for dataSize to be undefined if hash is
          // set, but TypeScript doesn't know that.
          if (dataSize === undefined || dataSize <= 0) {
            this.log.warn('Skipping cache serve due to invalid data size', {
              id,
              hash,
              dataSize,
            });
            cacheStream.destroy();
            return undefined;
          }
          return {
            stream: cacheStream,
            size: dataSize,
          };
        }
      } catch (error: any) {
        this.log.error('Error getting data from cache:', {
          id,
          message: error.message,
          stack: error.stack,
        });
      }
    }

    this.log.debug('Checking for parent data ID...', { id });
    const parentData = await this.contiguousDataIndex.getDataParent(id);
    if (parentData?.parentHash !== undefined) {
      this.log.debug('Found parent data ID', { id, ...parentData });
      // We might have a parent but no data size when retreiving by ID
      const size = dataSize ?? parentData.size;

      return this.getCacheData(
        parentData.parentId,
        parentData.parentHash,
        size,
        {
          offset: (region?.offset ?? 0) + parentData.offset,
          // Preserve the caller's requested slice size. Falling back to
          // the child's full data size here (the previous behavior) made
          // FsDataStore open the parent file with end=start+child_size-1
          // and emit up to that many bytes — for BDI-nested items that's
          // hundreds of MB per request, which then trips strict size
          // checks in callers like fetchDataFromParent (PE-9098).
          size: region?.size ?? size,
        },
      );
    }

    return undefined;
  }

  /**
   * Wait for another caller's in-flight foreground fetch to settle.
   *
   * The waiter only ever observes the shared fetch. It holds no reference to
   * the leader's upstream stream, tee, or staging file, so an aborting waiter
   * detaches itself and nothing else: the leader keeps downloading for the
   * benefit of every other waiter, and no staging file is orphaned. The
   * reverse also holds -- if the *leader* aborts, this resolves `false` and
   * the waiter falls back to its own fetch.
   *
   * Resolves `'timed_out'` rather than throwing when the wait bound expires:
   * a leader that wedges never reaches its pipeline callback, and waiting on
   * it forever would convert a transient stall into permanent unavailability
   * for that ID.
   */
  private awaitInFlightFetch(
    inFlight: Promise<ForegroundFetchOutcome>,
    signal?: AbortSignal,
  ): Promise<ForegroundFetchOutcome | 'timed_out'> {
    const timeoutMs = this.foregroundCacheCoalesceTimeoutMs;
    signal?.throwIfAborted();

    if (signal === undefined && timeoutMs <= 0) {
      return inFlight;
    }

    return new Promise<ForegroundFetchOutcome | 'timed_out'>(
      (resolve, reject) => {
        let timer: NodeJS.Timeout | undefined;

        const cleanup = () => {
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
          signal?.removeEventListener('abort', onAbort);
        };

        const onAbort = () => {
          cleanup();
          reject(signal?.reason ?? new Error('Aborted'));
        };

        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            cleanup();
            resolve('timed_out');
          }, timeoutMs);
          // Deliberately NOT unref'd: an unref'd timer can fail to fire if the
          // loop drains, which is the exact hang this bound exists to prevent.
          // A parked waiter is an in-flight request, so keeping the loop alive
          // for it is correct; the timer is cleared as soon as the leader
          // settles.
        }

        signal?.addEventListener('abort', onAbort, { once: true });

        inFlight.then(
          (cached) => {
            cleanup();
            resolve(cached);
          },
          (error) => {
            cleanup();
            reject(error);
          },
        );
      },
    );
  }

  async getData(args: GetDataArgs): Promise<ContiguousData> {
    return this.getDataInternal(args, this.foregroundCacheCoalesceMaxAttempts);
  }

  /**
   * @param coalesceAttemptsRemaining How many more times this call may attach
   *   to another caller's in-flight fetch. 0 means fetch for ourselves without
   *   waiting on anyone.
   *
   *   Spending one on each attach is what makes leader re-election terminate.
   *   When a leader fails, its waiters all wake at once; the first to re-enter
   *   finds no owner and claims the ID, and the rest attach to it rather than
   *   each starting their own fetch. Without a budget that could chain for as
   *   long as leaders keep failing; with it, a request waits at most this many
   *   times before fetching independently.
   *
   *   Only a genuine leader failure is worth re-electing for. A leader that
   *   succeeded but declined to cache ('uncached') would be followed by a new
   *   leader hitting the same policy, and a leader that timed out keeps its map
   *   entry, so re-attaching would just wait on the same stalled fetch. Both
   *   re-enter with 0.
   */
  private async getDataInternal(
    {
      id,
      requestAttributes,
      region,
      parentSpan,
      signal,
      acceptContentType,
    }: GetDataArgs,
    coalesceAttemptsRemaining: number,
  ): Promise<ContiguousData> {
    const span = startChildSpan(
      'ReadThroughDataCache.getData',
      {
        attributes: {
          'data.id': id,
          'data.has_region': region !== undefined,
          'data.region_offset': region?.offset,
          'data.region_size': region?.size,
          'arns.name': requestAttributes?.arnsName,
          'arns.basename': requestAttributes?.arnsBasename,
        },
      },
      parentSpan,
    );

    this.log.debug('Checking for cached data...', {
      id,
    });

    // Foreground single-flight / cache-write-guard bookkeeping. Declared out
    // here so the catch block below can settle and release on the error paths.
    let settleInFlight: ((outcome: ForegroundFetchOutcome) => void) | undefined;
    let foregroundPermitHeld = false;
    const finishForegroundCache = (outcome: ForegroundFetchOutcome) => {
      if (foregroundPermitHeld) {
        foregroundPermitHeld = false;
        this.foregroundCacheSemaphore?.release();
      }
      // Idempotent: settleInFlight ignores repeat calls.
      settleInFlight?.(outcome);
    };

    try {
      // Check for abort before starting
      signal?.throwIfAborted();
      // Get data attributes
      let attributes = await this.dataAttributesStore.getDataAttributes(id);

      if (attributes) {
        span.setAttributes({
          'data.size': attributes.size,
          'data.hash': attributes.hash,
          'data.stable': attributes.stable,
          'data.verified': attributes.verified,
          'data.content_type': attributes.contentType,
        });
      }

      // PE-9099: lazy poison eviction. If the caller supplied a
      // content-type predicate and the cached attributes record a
      // content-type the caller refuses (e.g., text/html for a
      // request that expects an ANS-104 bundle, a known footprint of
      // legacy gateway S3 caches poisoned with `gateway.bundlr.network`
      // parking pages), drop the on-disk blob and treat this request
      // as a cache miss. The next successful cache write (after a
      // fall-through to a clean source) will overwrite the stale
      // attributes with the correct content-type, healing the entry
      // for future requests.
      if (
        acceptContentType !== undefined &&
        attributes !== undefined &&
        !acceptContentType(attributes.contentType)
      ) {
        span.addEvent('Evicting poisoned cache entry', {
          'cache.evicted.id': id,
          'cache.evicted.hash': attributes.hash,
          'cache.evicted.content_type': attributes.contentType,
        });
        this.log.warn('Evicting poisoned cache entry', {
          id,
          hash: attributes.hash,
          contentType: attributes.contentType,
        });
        metrics.poisonedCacheEvictionsTotal.inc({
          content_type: attributes.contentType ?? 'unknown',
        });
        if (attributes.hash !== undefined) {
          try {
            await this.dataStore.delete(attributes.hash);
          } catch (err: any) {
            this.log.warn('Failed to delete poisoned cache blob', {
              id,
              hash: attributes.hash,
              message: err?.message,
            });
          }
        }
        // Clear attributes so the rest of getData() falls through
        // as if this were a cold cache miss.
        attributes = undefined;
      }

      if (attributes?.hash !== undefined) {
        const { arnsName, arnsBasename } = requestAttributes ?? {};
        // Intentionally not awaiting
        this.updateMetadataCache({
          hash: attributes.hash,
          arnsName,
          arnsBasename,
        });
      }

      // Check cache
      span.addEvent('Checking cache');
      const cacheCheckStart = Date.now();
      const cacheData = await this.getCacheData(
        id,
        attributes?.hash,
        attributes?.size,
        region,
      );
      const cacheCheckDuration = Date.now() - cacheCheckStart;
      span.setAttribute(
        'cache.operation.check_duration_ms',
        cacheCheckDuration,
      );

      // Cache hit
      if (cacheData !== undefined) {
        span.setAttributes({
          'cache.operation.hit': true,
          'data.source': 'cache',
          'data.cached': true,
        });
        span.addEvent('Cache hit', {
          'cache.check_duration_ms': cacheCheckDuration,
        });

        const requestType = region ? 'range' : 'full';

        metrics.contiguousDataCacheHitTotal.inc({ request_type: requestType });

        // Refresh recency (and promote tier on preferred-ArNS reads) in the
        // cleanup index so eviction is LRU rather than FIFO.
        if (attributes?.hash !== undefined) {
          this.touchCacheIndexEntry(attributes.hash, requestAttributes);
        }

        cacheData.stream.once('error', () => {
          metrics.getDataStreamErrorsTotal.inc({
            class: this.constructor.name,
            source: 'cache',
            request_type: requestType,
          });
        });

        cacheData.stream.once('end', () => {
          metrics.getDataStreamSuccessesTotal.inc({
            class: this.constructor.name,
            source: 'cache',
            request_type: requestType,
          });

          // Track bytes streamed from cache
          const bytesStreamed = region?.size ?? cacheData.size;
          metrics.getDataStreamBytesTotal.inc(
            {
              class: this.constructor.name,
              source: 'cache',
              request_type: requestType,
            },
            bytesStreamed,
          );

          metrics.getDataStreamSizeHistogram.observe(
            {
              class: this.constructor.name,
              source: 'cache',
              request_type: requestType,
            },
            bytesStreamed,
          );
        });

        // Stochastic re-verification
        const retryRate =
          attributes?.trusted === false
            ? this.untrustedCacheRetryRate
            : this.trustedCacheRetryRate;

        if (
          retryRate > 0 &&
          Math.random() < retryRate &&
          attributes?.hash !== undefined &&
          !this.pendingRetries.has(id)
        ) {
          this.triggerBackgroundReVerification(
            id,
            attributes.hash,
            attributes?.trusted === false ? 'untrusted' : 'trusted',
          );
        }

        const processedRequestAttributes =
          generateRequestAttributes(requestAttributes);

        return {
          hash: attributes?.hash,
          stream: cacheData.stream,
          size: region?.size ?? cacheData.size,
          totalSize: attributes?.size,
          sourceContentType: attributes?.contentType,
          verified: attributes?.verified ?? false,
          trusted: attributes?.trusted !== false,
          cached: true,
          requestAttributes: processedRequestAttributes?.attributes,
        };
      }

      // Cache miss - fetch from upstream
      span.setAttributes({
        'cache.operation.hit': false,
        'cache.operation.miss': true,
      });
      span.addEvent('Cache miss - fetching from upstream', {
        'cache.check_duration_ms': cacheCheckDuration,
      });

      // A known-small object is exempt from coalescing. Waiters are served from
      // the finalized blob, so coalescing costs them the whole download in
      // time-to-first-byte -- worth paying on a multi-gigabyte object whose
      // duplicates are measured in gigabytes, not on a small one that
      // duplicates cheaply and finishes fast.
      //
      // The size used is the one the attributes store already resolved above.
      // data.size is not available here: the upstream fetch has not run yet,
      // and a leader must claim the ID before it does. An unknown size is
      // therefore treated as eligible, so the floor can only narrow coalescing
      // where the object is positively known to be small -- it can never make
      // stampede protection weaker than leaving it unset.
      const knownSize = attributes?.size;
      const belowCoalesceFloor =
        this.foregroundCacheCoalesceMinSize > 0 &&
        knownSize !== undefined &&
        knownSize < this.foregroundCacheCoalesceMinSize;

      // Only full-object fetches that are allowed to write to the cache can be
      // coalesced: a range request caches nothing, so there would be no
      // finalized blob for a waiter to be served from.
      const coalescingEligible =
        !this.skipCacheWrites && region === undefined && !belowCoalesceFloor;

      // Counts every miss the floor exempted, not just the ones that would
      // have found a leader. Nothing claims the in-flight entry for an exempt
      // ID, so there is no way to tell here whether a concurrent fetch existed
      // -- gating on that would make this unreachable. Compare against
      // already_pending to judge whether the floor is set too high.
      if (belowCoalesceFloor) {
        metrics.foregroundCacheSkippedTotal.inc({
          reason: 'below_coalesce_floor',
        });
        this.log.debug('Below coalesce floor, fetching independently', {
          id,
          knownSize,
          coalesceMinSize: this.foregroundCacheCoalesceMinSize,
        });
      }

      if (coalescingEligible && coalesceAttemptsRemaining > 0) {
        const inFlight = this.inFlightForegroundFetches.get(id);
        if (inFlight !== undefined) {
          metrics.foregroundCacheSkippedTotal.inc({
            reason: 'already_pending',
          });
          span.addEvent('Attaching to in-flight foreground fetch');
          this.log.debug('Attaching to in-flight foreground fetch', { id });

          const attachStart = Date.now();
          let leaderOutcome: ForegroundFetchOutcome | 'timed_out' = 'failed';
          try {
            leaderOutcome = await this.awaitInFlightFetch(inFlight, signal);
          } catch (error: any) {
            if (error?.name === 'AbortError') {
              // Our caller went away. Detach only -- the leader's fetch and
              // staging file belong to it and are untouched.
              throw error;
            }
            this.log.debug(
              'In-flight foreground fetch failed, falling back to own fetch',
              { id, message: error?.message },
            );
          }
          span.addEvent('In-flight foreground fetch settled', {
            'cache.coalesce_wait_ms': Date.now() - attachStart,
            'cache.leader_outcome': leaderOutcome,
          });

          if (leaderOutcome === 'timed_out') {
            // The leader is stalled, not merely slow. Stop waiting on it and
            // fetch for ourselves; its map entry stays put in case it does
            // finish, but it can no longer strand anyone indefinitely.
            metrics.foregroundCacheCoalescedOutcomeTotal.inc({
              outcome: 'timed_out',
            });
            this.log.warn(
              'Timed out waiting on in-flight foreground fetch, fetching independently',
              { id, waitedMs: Date.now() - attachStart },
            );
          }

          // Leader re-election. Only a genuine failure earns another attach:
          // the leader's map entry is gone, so the first of its waiters back
          // through here claims the ID and the rest attach to that new leader
          // instead of every waiter firing its own fetch in the same tick.
          //
          // 'uncached' does not, because a new leader would be declined by the
          // same policy that declined this one, and 'timed_out' does not,
          // because the stalled leader still owns the entry -- re-attaching
          // would wait on the fetch we just gave up on.
          const nextAttempts =
            leaderOutcome === 'failed' ? coalesceAttemptsRemaining - 1 : 0;
          // Deliberately a separate counter rather than another label on
          // foregroundCacheCoalescedOutcomeTotal: that one records exactly one
          // terminal outcome per attached request, so it sums to the number of
          // requests that attached. A re-electing request goes on to record
          // cache_hit or refetched as well, and folding both into the same
          // counter would double-count it and break that invariant.
          if (leaderOutcome === 'failed' && nextAttempts > 0) {
            metrics.foregroundCacheReElectionsTotal.inc();
          }

          // Re-enter rather than duplicating the cache-read path: this reruns
          // poison eviction, hit metrics, and MRU bookkeeping exactly as a
          // normal request would.
          const result = await this.getDataInternal(
            {
              id,
              requestAttributes,
              region,
              parentSpan: span,
              signal,
              acceptContentType,
            },
            nextAttempts,
          );
          if (leaderOutcome !== 'timed_out') {
            metrics.foregroundCacheCoalescedOutcomeTotal.inc({
              outcome: result.cached ? 'cache_hit' : 'refetched',
            });
          }
          return result;
        }
      }

      // Become the leader for this ID. The get() above and this set() are in
      // the same synchronous run -- no await separates them -- so exactly one
      // concurrent caller can claim the key.
      if (coalescingEligible && !this.inFlightForegroundFetches.has(id)) {
        let resolveInFlight!: (outcome: ForegroundFetchOutcome) => void;
        const inFlightPromise = new Promise<ForegroundFetchOutcome>(
          (resolve) => {
            resolveInFlight = resolve;
          },
        );
        this.inFlightForegroundFetches.set(id, inFlightPromise);

        let settled = false;
        settleInFlight = (outcome: ForegroundFetchOutcome) => {
          if (settled) {
            return;
          }
          settled = true;
          // Identity check: a later leader may already own the key.
          if (this.inFlightForegroundFetches.get(id) === inFlightPromise) {
            this.inFlightForegroundFetches.delete(id);
          }
          // Always resolves, never rejects, so an unobserved leader failure
          // cannot surface as an unhandled rejection.
          resolveInFlight(outcome);
        };
      }

      const upstreamStart = Date.now();
      const data = await this.dataSource.getData({
        id,
        requestAttributes,
        region,
        parentSpan: span,
        signal,
        acceptContentType,
      });
      const upstreamDuration = Date.now() - upstreamStart;

      const missRequestType = region ? 'range' : 'full';
      metrics.contiguousDataCacheMissTotal.inc({
        request_type: missRequestType,
      });

      span.setAttributes({
        'upstream.fetch_duration_ms': upstreamDuration,
        'data.cached': data.cached,
        'data.trusted': data.trusted,
        'data.verified': data.verified ?? false,
      });
      span.addEvent('Upstream fetch completed', {
        'upstream.operation.duration_ms': upstreamDuration,
        'data.cached': data.cached,
        'data.trusted': data.trusted,
      });

      // Skip caching when serving regions to avoid persisting data fragments
      // and (more importantly) writing invalid ID to hash relationships in the
      // DB, and when data size is zero to avoid unnecessary storage operations
      // and indexing.
      const cacheEligible =
        !this.skipCacheWrites && region === undefined && data.size > 0;

      // Bound what a burst of *distinct* objects can stage, the way
      // triggerBackgroundCacheForRange already bounds the background path.
      // Failing either guard degrades to "serve the bytes, stage nothing"
      // rather than to an error -- the caller still gets its data.
      let foregroundSkipReason: string | undefined;
      if (cacheEligible) {
        if (
          this.foregroundCacheMaxSize > 0 &&
          data.size > this.foregroundCacheMaxSize
        ) {
          foregroundSkipReason = 'exceeds_max_size';
        } else if (this.foregroundCacheSemaphore !== undefined) {
          if (this.foregroundCacheSemaphore.tryAcquire()) {
            foregroundPermitHeld = true;
          } else {
            foregroundSkipReason = 'at_capacity';
          }
        }

        if (foregroundSkipReason !== undefined) {
          metrics.foregroundCacheSkippedTotal.inc({
            reason: foregroundSkipReason,
          });
          this.log.debug('Skipping foreground cache write', {
            id,
            reason: foregroundSkipReason,
            dataSize: data.size,
          });
        }
      }

      if (cacheEligible && foregroundSkipReason === undefined) {
        span.addEvent('Starting caching process');
        const cachingStart = Date.now();
        let bytesReceived = 0;
        // Whether the staging file was promoted into the cache. Drives what
        // waiting followers are told: true means "re-read, it is there now".
        let cacheFinalized = false;
        const hasher = crypto.createHash('sha256');
        const cacheStream = await this.dataStore.createWriteStream();

        // Tee the upstream stream so the cache pipeline and downstream
        // consumers (DataImporter, HTTP /raw/ responses) operate on
        // independent stream objects.
        //
        // The wedge this fixes: returning the inner `data.stream` directly
        // gave it two consumers — `pipeline(data.stream, ...)` below AND the
        // caller's listeners. The pipeline pauses the source for backpressure
        // when cacheStream is slow; the caller (e.g., DataImporter) calls
        // `.resume()` once and walks away expecting `'end'`/`'error'`. After
        // a backpressure pause neither side re-resumes (pipeline only
        // resumes from its own 'drain' listener, which can stall on slow
        // disk; the caller has no resume loop). The underlying TCP
        // IncomingMessage halts on socket recv-window-zero, the peer goes
        // idle, and the worker is wedged forever — `'end'` never fires
        // because the upstream never sent FIN, `'error'` never fires
        // because no party times out the socket. PR #734's wall-clock cap
        // on `attachStallTimeout` was supposed to be a safety net but its
        // cleanup is triggered by pipeline's 'close', cancelling the timer
        // before it can fire.
        //
        // Fix: pipeline is the sole consumer of the source IncomingMessage.
        // A `PassThrough` (`consumerStream`) becomes the new `data.stream`
        // returned to callers. The hashing Transform writes each chunk to
        // both its normal output (→ cacheStream) AND consumerStream — a
        // synchronous fan-out — and the pipeline callback signals
        // completion on consumerStream via `.end()` / `.destroy(error)`.
        // Backpressure now isolates: cache write speed can't starve the
        // caller, and a stalled consumer can't pause the source.
        const consumerStream = new PassThrough();

        // Hash + byte-count chunks inside a Transform so backpressure flows
        // end-to-end on the cache branch (data.stream → hashingStream →
        // cacheStream). Tee the same chunk to consumerStream synchronously.
        // We deliberately ignore consumerStream.write()'s return value: a
        // slow consumer buffers in memory rather than backpressuring the
        // shared pipeline. For DataImporter (which `.resume()`s and
        // discards), the buffer stays empty. For HTTP `/raw/` clients,
        // short slow periods buffer briefly on a single bundle's worth of
        // bytes — bounded by `data.size`.
        // A wedged pipeline never invokes its callback, so the permit acquired
        // above would never come back and -- at FOREGROUND_CACHE_CONCURRENCY=1
        // -- one wedged stream would stop foreground cache writes for the life
        // of the process. Reclaim the permit once the write stops producing
        // bytes entirely. Keying on inactivity rather than total elapsed time
        // matters: a slow but live multi-GB write keeps resetting this and
        // keeps its permit, so the cap still bounds real concurrency instead of
        // decaying into an advisory limit under sustained load.
        const stallBoundMs = this.foregroundCacheCoalesceTimeoutMs;
        let stallTimer: NodeJS.Timeout | undefined;
        const clearStallTimer = () => {
          if (stallTimer !== undefined) {
            clearTimeout(stallTimer);
            stallTimer = undefined;
          }
        };
        const touchStallTimer = () => {
          if (!foregroundPermitHeld || stallBoundMs <= 0) {
            return;
          }
          clearStallTimer();
          stallTimer = setTimeout(() => {
            stallTimer = undefined;
            if (!foregroundPermitHeld) {
              return;
            }
            foregroundPermitHeld = false;
            this.foregroundCacheSemaphore?.release();
            metrics.foregroundCacheStalledWritesTotal.inc();
            this.log.warn(
              'Reclaiming foreground cache permit from stalled write',
              { id, bytesReceived, dataSize: data.size },
            );
          }, stallBoundMs);
        };
        touchStallTimer();

        const hashingStream = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            bytesReceived += chunk.length;
            hasher.update(chunk);
            consumerStream.write(chunk);
            touchStallTimer();
            callback(null, chunk);
          },
        });

        pipeline(
          data.stream,
          hashingStream,
          cacheStream,
          async (error: any) => {
            const cachingDuration = Date.now() - cachingStart;
            if (error !== undefined) {
              // Handle abort errors specially - just log at debug level
              if (error.name === 'AbortError') {
                span.addEvent('Caching aborted due to client disconnect', {
                  'cache.duration_ms': cachingDuration,
                });
                this.log.debug('Caching aborted due to client disconnect', {
                  id,
                });
                await this.dataStore.cleanup(cacheStream);
                // This branch returns early, so it must do its own
                // single-flight teardown -- the calls at the end of this
                // callback are not reached. Without it a client disconnecting
                // mid-download leaves this ID's in-flight entry behind
                // forever, and every later request for it waits the full
                // coalesce timeout before refetching, for the life of the
                // process.
                clearStallTimer();
                finishForegroundCache('failed');
                return;
              }

              span.addEvent('Cache storage failed', {
                'cache.duration_ms': cachingDuration,
                'error.message': error.message,
              });
              span.setAttribute('cache.operation.storage_error', true);
              this.log.error('Error streaming or caching data:', {
                id,
                message: error.message,
                stack: error.stack,
              });
              // Only cleanup cacheStream - pipeline handles stream destruction
              await this.dataStore.cleanup(cacheStream);
            } else {
              if (cacheStream !== undefined) {
                const hash = hasher.digest('base64url');

                try {
                  if (bytesReceived !== data.size) {
                    span.addEvent('Skipping cache storage - size mismatch', {
                      'data.expected_size': data.size,
                      'data.received_size': bytesReceived,
                    });
                    span.setAttribute('cache.operation.size_mismatch', true);
                    this.log.warn('Stream size mismatch - not caching', {
                      id,
                      expectedSize: data.size,
                      receivedSize: bytesReceived,
                    });
                    await this.dataStore.cleanup(cacheStream);
                  } else if (data.trusted === true) {
                    // Trusted source: finalize, save with trusted: true
                    await this.dataStore.finalize(cacheStream, hash);
                    cacheFinalized = true;
                    span.addEvent('Data cached successfully', {
                      'cache.duration_ms': cachingDuration,
                      'data.computed_hash': hash,
                      'data.trusted': data.trusted,
                    });
                    span.setAttribute('cache.operation.stored', true);

                    this.log.info('Successfully cached data', { id, hash });
                    this.recordCacheIndexEntry(
                      hash,
                      data.size,
                      requestAttributes,
                    );

                    this.eventEmitter?.emit(events.DATA_CACHED, {
                      id,
                      hash,
                      dataSize: data.size,
                      contentType: data.sourceContentType,
                      cachedAt: currentUnixTimestamp(),
                    });

                    try {
                      const verificationPriority =
                        this.calculateVerificationPriority(requestAttributes);

                      // Fetch attributes again to get any updates (like root offsets)
                      // that were set by the upstream data source during getData
                      const updatedAttributes =
                        await this.dataAttributesStore.getDataAttributes(id);

                      this.dataContentAttributeImporter.queueDataContentAttributes(
                        {
                          id,
                          dataRoot: updatedAttributes?.dataRoot,
                          hash,
                          dataSize: data.size,
                          contentType: data.sourceContentType,
                          cachedAt: currentUnixTimestamp(),
                          verified: data.verified,
                          verificationPriority,
                          rootTransactionId:
                            updatedAttributes?.rootTransactionId,
                          rootDataItemOffset:
                            updatedAttributes?.rootDataItemOffset,
                          rootDataOffset: updatedAttributes?.rootDataOffset,
                          dataItemSize: updatedAttributes?.itemSize,
                          trusted: true,
                        },
                      );

                      // Update the in-memory cache with the hash so subsequent requests can find it
                      // This prevents cache misses due to stale cache entries with offsets but no hash
                      await this.dataAttributesStore.setDataAttributes(id, {
                        hash,
                        size: data.size,
                        contentType: data.sourceContentType,
                        trusted: true,
                      });
                    } catch (error: any) {
                      this.log.error('Error saving data content attributes:', {
                        id,
                        message: error.message,
                        stack: error.stack,
                      });
                    }
                  } else if (attributes?.hash === hash) {
                    // Untrusted source, hash matches existing: finalize but
                    // don't update trust status
                    await this.dataStore.finalize(cacheStream, hash);
                    cacheFinalized = true;
                    span.addEvent('Data cached successfully', {
                      'cache.duration_ms': cachingDuration,
                      'data.computed_hash': hash,
                      'data.trusted': data.trusted,
                    });
                    span.setAttribute('cache.operation.stored', true);
                    this.log.info(
                      'Successfully cached untrusted data matching local hash',
                      { id, hash },
                    );
                  } else if (attributes?.hash === undefined) {
                    // Untrusted source, no local hash: optimistic cache
                    await this.dataStore.finalize(cacheStream, hash);
                    cacheFinalized = true;
                    span.addEvent('Data cached optimistically (untrusted)', {
                      'cache.duration_ms': cachingDuration,
                      'data.computed_hash': hash,
                    });
                    span.setAttribute('cache.operation.stored', true);

                    this.log.info('Optimistically cached untrusted data', {
                      id,
                      hash,
                    });
                    this.recordCacheIndexEntry(
                      hash,
                      data.size,
                      requestAttributes,
                    );
                    try {
                      const verificationPriority =
                        this.calculateVerificationPriority(requestAttributes);

                      this.dataContentAttributeImporter.queueDataContentAttributes(
                        {
                          id,
                          dataRoot: attributes?.dataRoot,
                          hash,
                          dataSize: data.size,
                          contentType: data.sourceContentType,
                          cachedAt: currentUnixTimestamp(),
                          verified: false,
                          verificationPriority,
                          rootTransactionId: attributes?.rootTransactionId,
                          rootDataItemOffset: attributes?.rootDataItemOffset,
                          rootDataOffset: attributes?.rootDataOffset,
                          dataItemSize: attributes?.itemSize,
                          trusted: false,
                        },
                      );

                      await this.dataAttributesStore.setDataAttributes(id, {
                        hash,
                        size: data.size,
                        contentType: data.sourceContentType,
                        trusted: false,
                      });
                    } catch (error: any) {
                      this.log.error('Error saving data content attributes:', {
                        id,
                        message: error.message,
                        stack: error.stack,
                      });
                    }
                  } else {
                    // Untrusted source, hash mismatch: don't cache
                    span.addEvent('Skipping cache storage - hash mismatch', {
                      'data.trusted_hash': attributes?.hash,
                      'data.computed_hash': hash,
                    });
                    span.setAttribute('cache.operation.stored', false);
                    this.log.debug(
                      'Skipping caching of untrusted data with hash that does not match local hash',
                      {
                        trustedHash: attributes?.hash,
                        streamedHash: hash,
                      },
                    );
                    await this.dataStore.cleanup(cacheStream);
                  }
                } catch (error: any) {
                  span.addEvent('Cache finalization failed', {
                    'error.message': error.message,
                  });
                  this.log.error('Error finalizing data in cache:', {
                    id,
                    message: error.message,
                    stack: error.stack,
                  });
                  await this.dataStore.cleanup(cacheStream);
                }
              }
            }

            // Signal the consumer side of the tee. End-of-data fires after
            // the cache finalize logic above so callers don't see 'end'
            // before the cache write is durable. On error, propagate via
            // destroy(err) — DataImporter's reject() handler picks it up
            // and the worker promptly fails-and-retries instead of wedging.
            if (error !== undefined) {
              consumerStream.destroy(error);
            } else {
              consumerStream.end();
            }

            // Release the cache-write permit and wake any callers that
            // attached to this fetch. Deliberately last: it runs after the
            // finalize logic above, so a follower that re-reads the cache on
            // being woken finds a durable blob rather than a staging file.
            clearStallTimer();
            finishForegroundCache(cacheFinalized ? 'cached' : 'failed');
          },
        );

        // Replace `data.stream` with the consumer-side tee branch so
        // downstream callers (the metric listeners below, DataImporter,
        // HTTP /raw/ pipes) only see the PassThrough — never the inner
        // IncomingMessage that the pipeline now owns exclusively.
        data.stream = consumerStream;
      } else {
        // Nothing will be written to the cache on this path, so release any
        // waiters now instead of parking them until the stream drains.
        // The fetch itself succeeded; only the write was declined, so this is
        // 'uncached' rather than 'failed' -- a re-elected leader would be
        // declined by the same policy.
        finishForegroundCache('uncached');

        // Log why caching was skipped
        const reasons = [];
        if (foregroundSkipReason !== undefined) {
          reasons.push(`foreground cache ${foregroundSkipReason}`);
        }
        if (this.skipCacheWrites) {
          reasons.push(
            this.skipCache
              ? 'SKIP_DATA_CACHE is set'
              : 'SKIP_DATA_CACHE_WRITES is set',
          );
        }
        if (region !== undefined) {
          reasons.push('serving data region');
        }
        if (data.size === 0) {
          reasons.push('zero-size data');
        }

        if (reasons.length > 0) {
          this.log.debug('Skipping caching due to:', {
            id,
            reasons: reasons.join(', '),
            dataSize: data.size,
            trusted: data.trusted,
            hasLocalHash: attributes?.hash !== undefined,
            hasRegion: region !== undefined,
          });
        }

        if (region !== undefined && data.size > 0) {
          this.triggerBackgroundCacheForRange(
            id,
            attributes?.size ?? data.totalSize,
            requestAttributes,
          );
        }
      }

      const requestType = region ? 'range' : 'full';

      data.stream.once('error', () => {
        metrics.getDataStreamErrorsTotal.inc({
          class: this.constructor.name,
          source: 'cache',
          request_type: requestType,
        });
      });

      data.stream.once('end', () => {
        metrics.getDataStreamSuccessesTotal.inc({
          class: this.constructor.name,
          source: 'cache',
          request_type: requestType,
        });

        // Track bytes streamed from upstream
        const bytesStreamed = region?.size ?? data.size;
        metrics.getDataStreamBytesTotal.inc(
          {
            class: this.constructor.name,
            source: 'cache',
            request_type: requestType,
          },
          bytesStreamed,
        );

        metrics.getDataStreamSizeHistogram.observe(
          {
            class: this.constructor.name,
            source: 'cache',
            request_type: requestType,
          },
          bytesStreamed,
        );
      });

      data.stream.pause();

      span.addEvent('Returning data from upstream');
      return data;
    } catch (error: any) {
      // Release the permit and unblock waiters before rethrowing -- otherwise
      // a failed leader parks every follower until their own signals fire.
      finishForegroundCache('failed');

      // Don't record AbortError as exception
      if (error.name === 'AbortError') {
        span.addEvent('Request aborted', {
          'data.retrieval.error': 'client_disconnected',
        });
        throw error;
      }

      span.recordException(error);
      span.setAttribute('data.error', error.message);
      metrics.getDataErrorsTotal.inc({
        class: this.constructor.name,
        source: 'cache',
      });
      const notFoundRequestType = region ? 'range' : 'full';
      metrics.contiguousDataCacheNotFoundTotal.inc({
        request_type: notFoundRequestType,
      });

      throw error;
    } finally {
      span.end();
    }
  }
}
