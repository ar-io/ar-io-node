/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import crypto from 'node:crypto';
import { Readable, pipeline } from 'node:stream';
import winston from 'winston';

import { currentUnixTimestamp } from '../lib/time.js';
import { startChildSpan } from '../tracing.js';
import { Span } from '@opentelemetry/api';
import { generateRequestAttributes } from '../lib/request-attributes.js';
import { KvJsonStore } from '../store/kv-attributes-store.js';
import {
  ContiguousData,
  ContiguousDataAttributes,
  ContiguousDataIndex,
  ContiguousDataSource,
  ContiguousDataStore,
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
  private dataContentAttributeImporter: DataContentAttributeImporter;
  private skipCache: boolean;

  constructor({
    log,
    dataSource,
    metadataStore,
    dataStore,
    contiguousDataIndex,
    dataContentAttributeImporter,
    skipCache = false,
  }: {
    log: winston.Logger;
    dataSource: ContiguousDataSource;
    metadataStore: KvJsonStore<ContiguousMetadata>;
    dataStore: ContiguousDataStore;
    contiguousDataIndex: ContiguousDataIndex;
    dataContentAttributeImporter: DataContentAttributeImporter;
    skipCache?: boolean;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.dataSource = dataSource;
    this.metadataStore = metadataStore;
    this.dataStore = dataStore;
    this.contiguousDataIndex = contiguousDataIndex;
    this.dataContentAttributeImporter = dataContentAttributeImporter;
    this.skipCache = skipCache;
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
    dataAttributes,
    requestAttributes,
    region,
    parentSpan,
  }: {
    id: string;
    dataAttributes?: ContiguousDataAttributes;
    requestAttributes?: RequestAttributes;
    region?: {
      offset: number;
      size: number;
    };
    parentSpan?: Span;
  }): Promise<ContiguousData> {
    const span = startChildSpan(
      'ReadThroughDataCache.getData',
      {
        attributes: {
          'data.id': id,
          'data.has_attributes': dataAttributes !== undefined,
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
      // Get data attributes if not provided
      const attributes =
        dataAttributes ??
        (await this.contiguousDataIndex.getDataAttributes(id));

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

        cacheData.stream.once('error', () => {
          metrics.getDataStreamErrorsTotal.inc({
            class: this.constructor.name,
            source: 'cache',
          });
        });

        cacheData.stream.once('end', () => {
          metrics.getDataStreamSuccessesTotal.inc({
            class: this.constructor.name,
            source: 'cache',
          });
        });

        const processedRequestAttributes =
          generateRequestAttributes(requestAttributes);

        return {
          hash: attributes?.hash,
          stream: cacheData.stream,
          size: region?.size ?? cacheData.size,
          sourceContentType: attributes?.contentType,
          verified: attributes?.verified ?? false,
          trusted: true, // only trusted or verified data is cached in the first place
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
        dataAttributes,
        requestAttributes,
        region,
        parentSpan: span,
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

      // Skip caching when data is untrusted and we don't have a local hash to
      // compare against, and when serving regions to avoid persisting data
      // fragments and (more importantly) writing invalid ID to hash
      // relationships in the DB.
      if (
        (data.trusted === true || dataAttributes?.hash !== undefined) &&
        region === undefined
      ) {
        span.addEvent('Starting caching process');
        const cachingStart = Date.now();
        let bytesReceived = 0;
        const hasher = crypto.createHash('sha256');
        const cacheStream = await this.dataStore.createWriteStream();

        pipeline(data.stream, cacheStream, async (error: any) => {
          const cachingDuration = Date.now() - cachingStart;
          if (error !== undefined) {
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
                // Only finalize (cache locally) when we trust the source or
                // the computed hash matches an existing hash computed from a
                // trusted source.
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
                } else if (
                  data.trusted === true ||
                  dataAttributes?.hash === hash
                ) {
                  await this.dataStore.finalize(cacheStream, hash);
                  span.addEvent('Data cached successfully', {
                    'cache.duration_ms': cachingDuration,
                    'data.computed_hash': hash,
                    'data.trusted': data.trusted,
                  });
                  span.setAttribute('cache.operation.stored', true);

                  this.log.info('Successfully cached data', { id, hash });
                  try {
                    const verificationPriority =
                      this.calculateVerificationPriority(requestAttributes);

                    // Only update hashes when we trust the data source
                    if (data.trusted === true) {
                      this.dataContentAttributeImporter.queueDataContentAttributes(
                        {
                          id,
                          dataRoot: attributes?.dataRoot,
                          hash,
                          dataSize: data.size,
                          contentType: data.sourceContentType,
                          cachedAt: currentUnixTimestamp(),
                          verified: data.verified,
                          verificationPriority,
                        },
                      );
                    }
                  } catch (error: any) {
                    this.log.error('Error saving data content attributes:', {
                      id,
                      message: error.message,
                      stack: error.stack,
                    });
                  }
                } else {
                  span.addEvent('Skipping cache storage - hash mismatch', {
                    'data.trusted_hash': dataAttributes?.hash,
                    'data.computed_hash': hash,
                  });
                  span.setAttribute('cache.operation.stored', false);
                  this.log.debug(
                    'Skipping caching of untrusted data with hash that does not match local hash',
                    {
                      trustedHash: dataAttributes?.hash,
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
      }

      data.stream.once('error', () => {
        metrics.getDataStreamErrorsTotal.inc({
          class: this.constructor.name,
          source: 'cache',
        });
      });

      data.stream.once('end', () => {
        metrics.getDataStreamSuccessesTotal.inc({
          class: this.constructor.name,
          source: 'cache',
        });
      });

      data.stream.pause();

      span.addEvent('Returning data from upstream');
      return data;
    } catch (error: any) {
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
