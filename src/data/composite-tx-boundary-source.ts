/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';

import { TxBoundary, TxBoundarySource } from '../types.js';

/**
 * Composite transaction boundary source that orchestrates multiple sources
 * with a DB-first strategy:
 * 1. Database (fastest) - for indexed transactions
 * 2. tx_path validation - for unindexed data with tx_path from peers
 * 3. Chain fallback (slowest) - binary search through chain
 *
 * Returns the first successful result from any source.
 */
export class CompositeTxBoundarySource implements TxBoundarySource {
  private log: winston.Logger;
  private dbSource: TxBoundarySource;
  private txPathSource?: TxBoundarySource;
  private chainSource?: TxBoundarySource;

  constructor({
    log,
    dbSource,
    txPathSource,
    chainSource,
  }: {
    log: winston.Logger;
    dbSource: TxBoundarySource;
    txPathSource?: TxBoundarySource;
    chainSource?: TxBoundarySource;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.dbSource = dbSource;
    this.txPathSource = txPathSource;
    this.chainSource = chainSource;
  }

  async getTxBoundary(
    absoluteOffset: bigint,
    signal?: AbortSignal,
  ): Promise<TxBoundary | null> {
    const log = this.log.child({
      method: 'getTxBoundary',
      absoluteOffset: absoluteOffset.toString(),
    });

    // Check for abort before starting
    signal?.throwIfAborted();

    // 1. Try database source first (fastest)
    try {
      log.debug('Attempting database lookup');
      const dbResult = await this.dbSource.getTxBoundary(
        absoluteOffset,
        signal,
      );
      if (dbResult) {
        log.debug('Database lookup successful', {
          txId: dbResult.id,
          dataRoot: dbResult.dataRoot,
        });
        return dbResult;
      }
      log.debug('Database lookup returned no result');
    } catch (error: any) {
      // Re-throw AbortError to propagate cancellation
      if (error.name === 'AbortError') {
        throw error;
      }
      log.debug('Database lookup failed', { error: error.message });
    }

    // Check for abort before tx_path validation
    signal?.throwIfAborted();

    // 2. Try tx_path validation (for unindexed data)
    if (this.txPathSource) {
      try {
        log.debug('Attempting tx_path validation');
        const txPathResult = await this.txPathSource.getTxBoundary(
          absoluteOffset,
          signal,
        );
        if (txPathResult) {
          log.debug('tx_path validation successful', {
            dataRoot: txPathResult.dataRoot,
          });
          return txPathResult;
        }
        log.debug('tx_path validation returned no result');
      } catch (error: any) {
        // Re-throw AbortError to propagate cancellation
        if (error.name === 'AbortError') {
          throw error;
        }
        log.debug('tx_path validation failed', { error: error.message });
      }
    }

    // Check for abort before chain fallback
    signal?.throwIfAborted();

    // 3. Try chain fallback (slowest)
    if (this.chainSource) {
      try {
        log.debug('Attempting chain fallback');
        const chainResult = await this.chainSource.getTxBoundary(
          absoluteOffset,
          signal,
        );
        if (chainResult) {
          log.debug('Chain fallback successful', {
            txId: chainResult.id,
            dataRoot: chainResult.dataRoot,
          });
          return chainResult;
        }
        log.debug('Chain fallback returned no result');
      } catch (error: any) {
        // Re-throw AbortError to propagate cancellation
        if (error.name === 'AbortError') {
          throw error;
        }
        log.debug('Chain fallback failed', { error: error.message });
      }
    }

    log.debug('All sources exhausted - no TX boundary found');
    return null;
  }
}
