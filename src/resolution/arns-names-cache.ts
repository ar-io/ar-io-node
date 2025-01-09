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
import winston from 'winston';

import {
  AoClient,
  AoARIORead,
  AOProcess,
  ARIO,
  fetchAllArNSRecords,
} from '@ar.io/sdk';
import * as config from '../config.js';
import { connect } from '@permaweb/aoconnect';

const DEFAULT_CACHE_TTL = config.ARNS_NAMES_CACHE_TTL_SECONDS * 1000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY = 5 * 1000; // 5 seconds

const DEFAULT_CACHE_MISS_DEBOUNCE_TTL =
  config.ARNS_NAME_LIST_CACHE_MISS_REFRESH_INTERVAL_SECONDS * 1000;
const DEFAULT_CACHE_HIT_DEBOUNCE_TTL =
  config.ARNS_NAME_LIST_CACHE_HIT_REFRESH_INTERVAL_SECONDS * 1000;

export class ArNSNamesCache {
  private log: winston.Logger;
  private networkProcess: AoARIORead;
  private namesCache: Promise<Set<string>>;
  private lastSuccessfulNames: Set<string> | null = null;
  private lastCacheTime = 0;
  private cacheTtl: number;
  private maxRetries: number;
  private retryDelay: number;
  private cacheMissDebounceTtl: number;
  private cacheHitDebounceTtl: number;
  private debounceTimeout: NodeJS.Timeout | null = null;
  private isDebouncing = false;

  constructor({
    log,
    ao = connect({
      MU_URL: config.AO_MU_URL,
      CU_URL: config.AO_CU_URL,
      GRAPHQL_URL: config.AO_GRAPHQL_URL,
      GATEWAY_URL: config.AO_GATEWAY_URL,
    }),
    networkProcess = ARIO.init({
      process: new AOProcess({
        processId: config.IO_PROCESS_ID,
        ao: ao,
      }),
    }),
    cacheTtl = DEFAULT_CACHE_TTL,
    maxRetries = DEFAULT_MAX_RETRIES,
    retryDelay = DEFAULT_RETRY_DELAY,
    cacheMissDebounceTtl = DEFAULT_CACHE_MISS_DEBOUNCE_TTL,
    cacheHitDebounceTtl = DEFAULT_CACHE_HIT_DEBOUNCE_TTL,
  }: {
    log: winston.Logger;
    ao?: AoClient;
    networkProcess?: AoARIORead;
    cacheTtl?: number;
    maxRetries?: number;
    retryDelay?: number;
    cacheMissDebounceTtl?: number;
    cacheHitDebounceTtl?: number;
  }) {
    this.log = log.child({
      class: 'ArNSNamesCache',
    });
    this.networkProcess = networkProcess;
    this.cacheTtl = cacheTtl;
    this.maxRetries = maxRetries;
    this.retryDelay = retryDelay;
    this.cacheMissDebounceTtl = cacheMissDebounceTtl;
    this.cacheHitDebounceTtl = cacheHitDebounceTtl;
    this.log.info('Initiating cache load');
    this.namesCache = this.getNames({ forceCacheUpdate: true });
  }

  async getNames({
    forceCacheUpdate = false,
  }: {
    forceCacheUpdate?: boolean;
  } = {}): Promise<Set<string>> {
    const log = this.log.child({ method: 'getNames' });

    const expiredTtl = Date.now() - this.lastCacheTime > this.cacheTtl;
    const shouldRefresh = forceCacheUpdate || expiredTtl;

    if (shouldRefresh) {
      this.log.debug('Refreshing names cache promise', {
        forced: forceCacheUpdate,
      });
      this.namesCache = this.getNamesFromContract();
      this.lastCacheTime = Date.now();
    } else {
      log.debug('Using cached names promise', {
        expiration: this.lastCacheTime + this.cacheTtl,
      });
    }

    return this.namesCache;
  }

  async has(name: string): Promise<boolean> {
    const names = await this.getNames();
    const nameExists = names.has(name);
    // schedule the next debounce based on the cache hit or miss
    await this.scheduleCacheRefresh(
      nameExists ? this.cacheHitDebounceTtl : this.cacheMissDebounceTtl,
    );
    return nameExists;
  }

  private async scheduleCacheRefresh(ttl: number): Promise<void> {
    if (this.isDebouncing) {
      this.log.debug('Already debouncing, skipping...');
      return;
    }
    if (this.debounceTimeout) {
      clearTimeout(this.debounceTimeout);
      this.debounceTimeout = null;
    }
    this.log.debug(
      `Setting cache debounce timeout to refresh cache in ${ttl}ms`,
    );
    // set the new timeout to refresh the cache after the debounce interval
    this.debounceTimeout = setTimeout(async () => {
      this.log.debug('Debounce timeout triggered, refreshing cache...');
      this.getNames({ forceCacheUpdate: true });
      this.debounceTimeout = null;
      this.isDebouncing = false;
    }, ttl);
    this.isDebouncing = true; // set the debouncing flag to true to prevent multiple debounces
  }

  async getCacheSize(): Promise<number> {
    const names = await this.namesCache;
    return names.size;
  }

  private async getNamesFromContract(): Promise<Set<string>> {
    const log = this.log.child({ method: 'getNamesFromContract' });
    log.info('Starting to fetch names from contract');

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const records = await fetchAllArNSRecords({
          contract: this.networkProcess,
        });

        const names = new Set(Object.keys(records));

        // to be safe, we will throw here to force a retry if no names returned
        if (names.size === 0) {
          throw new Error('Failed to fetch ArNS names');
        }

        log.info(
          `Successfully fetched ${names.size} names from contract on attempt ${attempt}`,
        );

        this.lastSuccessfulNames = names;

        return names;
      } catch (error) {
        lastError = error as Error;

        if (attempt === this.maxRetries) {
          if (this.lastSuccessfulNames) {
            log.warn(
              `Failed to fetch names after ${this.maxRetries} attempts, falling back to last successful cache of ${this.lastSuccessfulNames.size} names`,
              {
                error: lastError.message,
              },
            );
            return this.lastSuccessfulNames;
          }

          log.error(
            `Failed to fetch names after ${this.maxRetries} attempts and no previous successful cache exists`,
            {
              error: lastError.message,
            },
          );
          throw new Error(
            `Failed to fetch ArNS records after ${this.maxRetries} attempts: ${lastError.message}`,
          );
        }

        log.warn(
          `Attempt ${attempt}/${this.maxRetries} failed, retrying in ${this.retryDelay}ms`,
          {
            error: lastError.message,
          },
        );

        await new Promise((resolve) => setTimeout(resolve, this.retryDelay));
      }
    }

    throw lastError || new Error('Unexpected error in getNamesFromContract');
  }
}
