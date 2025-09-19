/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';

import { TxOffsetSource, TxOffsetResult } from '../types.js';

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

  constructor({
    log,
    primarySource,
    fallbackSource,
    fallbackEnabled = true,
  }: {
    log: winston.Logger;
    primarySource: TxOffsetSource;
    fallbackSource?: TxOffsetSource;
    fallbackEnabled?: boolean;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.primarySource = primarySource;
    this.fallbackSource = fallbackSource;
    this.fallbackEnabled = fallbackEnabled;
  }

  async getTxByOffset(offset: number): Promise<TxOffsetResult> {
    const log = this.log.child({ method: 'getTxByOffset', offset });

    try {
      // Try primary source first
      log.debug('Attempting primary source');
      const primaryResult = await this.primarySource.getTxByOffset(offset);

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
        log.debug(
          'Primary source returned invalid result, attempting fallback',
        );
        const fallbackResult = await this.fallbackSource.getTxByOffset(offset);

        if (this.isValidResult(fallbackResult)) {
          log.debug('Fallback source returned valid result');
          return fallbackResult;
        } else {
          log.debug('Fallback source also returned invalid result');
          return fallbackResult;
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
