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
  AoIORead,
  AOProcess,
  IO,
  fetchAllArNSRecords,
} from '@ar.io/sdk';
import * as config from '../config.js';
import { connect } from '@permaweb/aoconnect';

const DEFAULT_CACHE_TTL = config.ARNS_NAMES_CACHE_TTL_SECONDS * 1000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY = 5 * 1000; // 5 seconds

export class ArNSNamesCache {
  private log: winston.Logger;
  private networkProcess: AoIORead;
  private namesCache: Promise<Set<string>>;
  private lastSuccessfulNames: Set<string> | null = null;
  private lastCacheTime = 0;
  private cacheTtl: number;
  private maxRetries: number;
  private retryDelay: number;

  constructor({
    log,
    ao = connect({
      MU_URL: config.AO_MU_URL,
      CU_URL: config.AO_CU_URL,
      GRAPHQL_URL: config.AO_GRAPHQL_URL,
      GATEWAY_URL: config.AO_GATEWAY_URL,
    }),
    networkProcess = IO.init({
      process: new AOProcess({
        processId: config.IO_PROCESS_ID,
        ao: ao,
      }),
    }),
    cacheTtl = DEFAULT_CACHE_TTL,
    maxRetries = DEFAULT_MAX_RETRIES,
    retryDelay = DEFAULT_RETRY_DELAY,
  }: {
    log: winston.Logger;
    ao?: AoClient;
    networkProcess?: AoIORead;
    cacheTtl?: number;
    maxRetries?: number;
    retryDelay?: number;
  }) {
    this.log = log.child({
      class: 'ArNSNamesCache',
    });
    this.networkProcess = networkProcess;
    this.cacheTtl = cacheTtl;
    this.maxRetries = maxRetries;
    this.retryDelay = retryDelay;

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
      if (forceCacheUpdate) {
        log.debug('Forcing cache update');
      } else {
        log.debug('Cache expired, refreshing...');
      }
      this.namesCache = this.getNamesFromContract();
      this.lastCacheTime = Date.now();
    } else {
      log.debug('Using cached names list');
    }

    return this.namesCache;
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
