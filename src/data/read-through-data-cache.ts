/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import crypto from 'node:crypto';
import * as EventEmitter from 'node:events';
import { Readable, pipeline } from 'node:stream';
import winston from 'winston';

import * as events from '../events.js';
import { currentUnixTimestamp } from '../lib/time.js';
import { Semaphore } from '../lib/semaphore.js';
import { startChildSpan } from '../tracing.js';
import { Span } from '@opentelemetry/api';
import { generateRequestAttributes } from '../lib/request-attributes.js';
import { KvJsonStore } from '../store/kv-attributes-store.js';
import {
  ContiguousData,
  ContiguousDataIndex,
  ContiguousDataSource,
  ContiguousDataStore,
  ContiguousDataAttributesStore,
  RequestAttributes,
  ContiguousMetadata,
} from '../types.js';
import * as metrics from '../metrics.js';
import { DataContentAttributeImporter } from '../workers/data-content-attribute-importer.js';
import { PREFERRED_ARNS_NAMES, PREFERRED_ARNS_BASE_NAMES } from '../config.js';
import { verificationPriorities } from '../constants.js';

const MAX_MRU_ARNS_NAMES_LENGTH = 10;

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

export class ReadThroughDataCache implements ContiguousDataSource {
  private log: winston.Logger;
  private dataSource: ContiguousDataSource;
  private metadataStore: KvJsonStore<ContiguousMetadata>;
  private dataStore: ContiguousDataStore;
  private contiguousDataIndex: ContiguousDataIndex;
  private dataAttributesStore: ContiguousDataAttributesStore;
  private dataContentAttributeImporter: DataContentAttributeImporter;
  private skipCache: boolean;
  private eventEmitter?: EventEmitter;
  private untrustedCacheRetryRate: number;
  private trustedCacheRetryRate: number;
  private pendingRetries: Set<string> = new Set();
  private pendingBackgroundCaches: Set<string> = new Set();
  private backgroundCacheRangeMaxSize: number;
  private backgroundCacheSemaphore: Semaphore;

  constructor({
    log,
    dataSource,
    metadataStore,
    dataStore,
    contiguousDataIndex,
    dataAttributesStore,
    dataContentAttributeImporter,
    skipCache = false,
    eventEmitter,
    untrustedCacheRetryRate = 0,
    trustedCacheRetryRate = 0,
    backgroundCacheRangeMaxSize = 0,
    backgroundCacheRangeConcurrency = 1,
  }: {
    log: winston.Logger;
    dataSource: ContiguousDataSource;
    metadataStore: KvJsonStore<ContiguousMetadata>;
    dataStore: ContiguousDataStore;
    contiguousDataIndex: ContiguousDataIndex;
    dataAttributesStore: ContiguousDataAttributesStore;
    dataContentAttributeImporter: DataContentAttributeImporter;
    skipCache?: boolean;
    eventEmitter?: EventEmitter;
    untrustedCacheRetryRate?: number;
    trustedCacheRetryRate?: number;
    backgroundCacheRangeMaxSize?: number;
    backgroundCacheRangeConcurrency?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.dataSource = dataSource;
    this.metadataStore = metadataStore;
    this.dataStore = dataStore;
    this.contiguousDataIndex = contiguousDataIndex;
    this.dataAttributesStore = dataAttributesStore;
    this.dataContentAttributeImporter = dataContentAttributeImporter;
    this.skipCache = skipCache;
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

    this.backgroundCacheRangeMaxSize = backgroundCacheRangeMaxSize;
    this.backgroundCacheSemaphore = new Semaphore(
      backgroundCacheRangeConcurrency,
    );
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

    if (this.skipCache) {
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
          if (dataSize === undefined) {
            throw new Error('Missing data size');
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
          size,
        },
      );
    }

    return undefined;
  }

  async getData({
    id,
    requestAttributes,
    region,
    parentSpan,
    signal,
  }: {
    id: string;
    requestAttributes?: RequestAttributes;
    region?: {
      offset: number;
      size: number;
    };
    parentSpan?: Span;
    signal?: AbortSignal;
  }): Promise<ContiguousData> {
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

    try {
      // Check for abort before starting
      signal?.throwIfAborted();
      // Get data attributes
      const attributes = await this.dataAttributesStore.getDataAttributes(id);

      if (attributes) {
        span.setAttributes({
          'data.size': attributes.size,
          'data.hash': attributes.hash,
          'data.stable': attributes.stable,
          'data.verified': attributes.verified,
          'data.content_type': attributes.contentType,
        });
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

      const upstreamStart = Date.now();
      const data = await this.dataSource.getData({
        id,
        requestAttributes,
        region,
        parentSpan: span,
        signal,
      });
      const upstreamDuration = Date.now() - upstreamStart;

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

      data.stream.setMaxListeners(Infinity); // Suppress listener leak warnings

      // Skip caching when serving regions to avoid persisting data fragments
      // and (more importantly) writing invalid ID to hash relationships in the
      // DB, and when data size is zero to avoid unnecessary storage operations
      // and indexing.
      if (!this.skipCache && region === undefined && data.size > 0) {
        span.addEvent('Starting caching process');
        const cachingStart = Date.now();
        let bytesReceived = 0;
        const hasher = crypto.createHash('sha256');
        const cacheStream = await this.dataStore.createWriteStream();

        pipeline(data.stream, cacheStream, async (error: any) => {
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
                  span.addEvent('Data cached successfully', {
                    'cache.duration_ms': cachingDuration,
                    'data.computed_hash': hash,
                    'data.trusted': data.trusted,
                  });
                  span.setAttribute('cache.operation.stored', true);

                  this.log.info('Successfully cached data', { id, hash });

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
                        rootTransactionId: updatedAttributes?.rootTransactionId,
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
                  span.addEvent('Data cached optimistically (untrusted)', {
                    'cache.duration_ms': cachingDuration,
                    'data.computed_hash': hash,
                  });
                  span.setAttribute('cache.operation.stored', true);

                  this.log.info('Optimistically cached untrusted data', {
                    id,
                    hash,
                  });
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
              }
            }
          }
        });

        data.stream.on('data', (chunk) => {
          bytesReceived += chunk.length;
          hasher.update(chunk);
        });
      } else {
        // Log why caching was skipped
        const reasons = [];
        if (this.skipCache) {
          reasons.push('SKIP_DATA_CACHE is set');
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

      throw error;
    } finally {
      span.end();
    }
  }
}
