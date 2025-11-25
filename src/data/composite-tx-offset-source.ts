/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';

import { TxOffsetSource, TxOffsetResult, TxPathContext } from '../types.js';

/**
 * A composite transaction offset source that tries multiple sources with fallback support.
 * Tries the primary source first, and falls back to the secondary source if the primary
 * returns empty or invalid results.
 */
export class CompositeTxOffsetSource implements TxOffsetSource {
  private log: winston.Logger;
  private primarySource: TxOffsetSource;
  private fallbackSource?: TxOffsetSource;
  private fallbackEnabled: boolean;
  private fallbackConcurrencyLimit: number;
  private activeFallbackCount = 0;

  constructor({
    log,
    primarySource,
    fallbackSource,
    fallbackEnabled = true,
    fallbackConcurrencyLimit = 5,
  }: {
    log: winston.Logger;
    primarySource: TxOffsetSource;
    fallbackSource?: TxOffsetSource;
    fallbackEnabled?: boolean;
    fallbackConcurrencyLimit?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.primarySource = primarySource;
    this.fallbackSource = fallbackSource;
    this.fallbackEnabled = fallbackEnabled;
    this.fallbackConcurrencyLimit = fallbackConcurrencyLimit;
  }

  async getTxByOffset(
    offset: number,
    txPathContext?: TxPathContext,
  ): Promise<TxOffsetResult> {
    const log = this.log.child({ method: 'getTxByOffset', offset });

    try {
      // Try primary source first
      log.debug('Attempting primary source');
      const primaryResult = await this.primarySource.getTxByOffset(
        offset,
        txPathContext,
      );

      // Check if primary result is valid
      if (this.isValidResult(primaryResult)) {
        log.debug('Primary source returned valid result');
        return primaryResult;
      }

      // If primary result is invalid and fallback is available, try fallback
      if (
        this.fallbackSource &&
        this.fallbackEnabled &&
        !this.isValidResult(primaryResult)
      ) {
        // Check if we're under the concurrency limit
        if (this.activeFallbackCount >= this.fallbackConcurrencyLimit) {
          log.debug('Skipping fallback - concurrency limit reached', {
            activeFallbackCount: this.activeFallbackCount,
            fallbackConcurrencyLimit: this.fallbackConcurrencyLimit,
          });
          return primaryResult;
        }

        log.debug(
          'Primary source returned invalid result, attempting fallback',
          {
            activeFallbackCount: this.activeFallbackCount,
            fallbackConcurrencyLimit: this.fallbackConcurrencyLimit,
          },
        );

        this.activeFallbackCount++;
        try {
          const fallbackResult = await this.fallbackSource.getTxByOffset(
            offset,
            txPathContext,
          );

          if (this.isValidResult(fallbackResult)) {
            log.debug('Fallback source returned valid result');
            return fallbackResult;
          } else {
            log.debug('Fallback source also returned invalid result');
            return fallbackResult;
          }
        } finally {
          this.activeFallbackCount--;
        }
      }

      // Return primary result even if invalid (no fallback available)
      log.debug('No fallback available, returning primary result');
      return primaryResult;
    } catch (error: any) {
      log.error('Error in composite transaction offset source', {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  /**
   * Checks if a result is valid (has all required fields defined)
   */
  private isValidResult(result: TxOffsetResult): boolean {
    return (
      result.data_root !== undefined &&
      result.id !== undefined &&
      result.offset !== undefined &&
      result.data_size !== undefined
    );
  }
}
