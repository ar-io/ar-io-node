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

  constructor({
    log,
    dataSource,
    metadataStore,
    dataStore,
    contiguousDataIndex,
    dataContentAttributeImporter,
  }: {
    log: winston.Logger;
    dataSource: ContiguousDataSource;
    metadataStore: KvJsonStore<ContiguousMetadata>;
    dataStore: ContiguousDataStore;
    contiguousDataIndex: ContiguousDataIndex;
    dataContentAttributeImporter: DataContentAttributeImporter;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.dataSource = dataSource;
    this.metadataStore = metadataStore;
    this.dataStore = dataStore;
    this.contiguousDataIndex = contiguousDataIndex;
    this.dataContentAttributeImporter = dataContentAttributeImporter;
  }

  private calculateVerificationPriority(
    requestAttributes?: RequestAttributes,
  ): number | undefined {
    // Check if the ArNS name is preferred
    const { arnsName, arnsBasename } = requestAttributes ?? {};
    const isPreferredName =
      arnsName !== undefined && PREFERRED_ARNS_NAMES.has(arnsName);
    const isPreferredBasename =
      arnsBasename !== undefined && PREFERRED_ARNS_BASE_NAMES.has(arnsBasename);
    return isPreferredName || isPreferredBasename ? 80 : undefined;
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
  }: {
    id: string;
    dataAttributes?: ContiguousDataAttributes;
    requestAttributes?: RequestAttributes;
    region?: {
      offset: number;
      size: number;
    };
  }): Promise<ContiguousData> {
    this.log.debug('Checking for cached data...', {
      id,
    });

    try {
      const attributes =
        dataAttributes ??
        (await this.contiguousDataIndex.getDataAttributes(id));

      if (attributes?.hash !== undefined) {
        const { arnsName, arnsBasename } = requestAttributes ?? {};
        // Intentionally not awaiting
        this.updateMetadataCache({
          hash: attributes.hash,
          arnsName,
          arnsBasename,
        });
      }

      const cacheData = await this.getCacheData(
        id,
        attributes?.hash,
        attributes?.size,
        region,
      );

      if (cacheData !== undefined) {
        cacheData.stream.on('error', () => {
          metrics.getDataStreamErrorsTotal.inc({
            class: this.constructor.name,
            source: 'cache',
          });
        });

        cacheData.stream.on('end', () => {
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

      const data = await this.dataSource.getData({
        id,
        dataAttributes,
        requestAttributes,
        region,
      });

      // Skip caching when data is untrusted and we don't have a local hash to
      // compare against, and when serving regions to avoid persisting data
      // fragments and (more importantly) writing invalid ID to hash
      // relationships in the DB.
      if (
        (data.trusted === true || dataAttributes?.hash !== undefined) &&
        region === undefined
      ) {
        const hasher = crypto.createHash('sha256');
        const cacheStream = await this.dataStore.createWriteStream();
        pipeline(data.stream, cacheStream, async (error: any) => {
          if (error !== undefined) {
            this.log.error('Error streaming or caching data:', {
              id,
              message: error.message,
              stack: error.stack,
            });
            await this.dataStore.cleanup(cacheStream);
          } else {
            if (cacheStream !== undefined) {
              const hash = hasher.digest('base64url');

              try {
                // Only finalize (cache locally) when we trust the source or
                // the computed hash matches an existing hash computed from a
                // trusted source.
                if (data.trusted === true || dataAttributes?.hash === hash) {
                  await this.dataStore.finalize(cacheStream, hash);
                } else {
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
                this.log.error('Error finalizing data in cache:', {
                  id,
                  message: error.message,
                  stack: error.stack,
                });
              }

              this.log.info('Successfully cached data', { id, hash });
              try {
                const verificationPriority =
                  this.calculateVerificationPriority(requestAttributes);

                // Only update hashes when we trust the data source
                if (data.trusted === true) {
                  this.dataContentAttributeImporter.queueDataContentAttributes({
                    id,
                    dataRoot: attributes?.dataRoot,
                    hash,
                    dataSize: data.size,
                    contentType: data.sourceContentType,
                    cachedAt: currentUnixTimestamp(),
                    verified: data.verified,
                    verificationPriority,
                  });
                }
              } catch (error: any) {
                this.log.error('Error saving data content attributes:', {
                  id,
                  message: error.message,
                  stack: error.stack,
                });
              }
            }
          }
        });

        data.stream.on('data', (chunk) => {
          hasher.update(chunk);
        });
      }

      data.stream.on('error', () => {
        metrics.getDataStreamErrorsTotal.inc({
          class: this.constructor.name,
          source: 'cache',
        });
      });

      data.stream.on('end', () => {
        metrics.getDataStreamSuccessesTotal.inc({
          class: this.constructor.name,
          source: 'cache',
        });
      });

      data.stream.pause();

      return data;
    } catch (error) {
      metrics.getDataErrorsTotal.inc({
        class: this.constructor.name,
        source: 'cache',
      });

      throw error;
    }
  }
}
