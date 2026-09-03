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
 * 1. Database (fastest) — for indexed transactions
 * 2. Chunk-metadata anchor (optional) — peer HEAD on /chunk/{offset}/data
 *    cross-checked against the chain. Drops the typical fallback cost from
 *    log₂(height) block fetches to one HEAD per offset and two chain
 *    lookups per unique tx (cached). See ar-io/ar-io-node#681.
 * 3. tx_path validation — for unindexed data with tx_path from peers
 * 4. Chain fallback (slowest) — binary search through chain
 *
 * Returns the first successful result from any source.
 *
 * Chain fallback has a configurable concurrency limit to prevent resource
 * exhaustion from expensive binary search operations.
 */
export class CompositeTxBoundarySource implements TxBoundarySource {
  private log: winston.Logger;
  private dbSource: TxBoundarySource;
  private anchorSource?: TxBoundarySource;
  private txPathSource?: TxBoundarySource;
  private chainSource?: TxBoundarySource;
  private chainFallbackConcurrencyLimit: number;
  private activeChainFallbackCount = 0;

  constructor({
    log,
    dbSource,
    anchorSource,
    txPathSource,
    chainSource,
    chainFallbackConcurrencyLimit = 5,
  }: {
    log: winston.Logger;
    dbSource: TxBoundarySource;
    anchorSource?: TxBoundarySource;
    txPathSource?: TxBoundarySource;
    chainSource?: TxBoundarySource;
    chainFallbackConcurrencyLimit?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.dbSource = dbSource;
    this.anchorSource = anchorSource;
    this.txPathSource = txPathSource;
    this.chainSource = chainSource;
    this.chainFallbackConcurrencyLimit = chainFallbackConcurrencyLimit;
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
        return { ...dbResult, source: 'db' };
      }
      log.debug('Database lookup returned no result');
    } catch (error: any) {
      // Re-throw AbortError to propagate cancellation
      if (error.name === 'AbortError') {
        throw error;
      }
      log.debug('Database lookup failed', { error: error.message });
    }

    // Check for abort before chunk-metadata anchor
    signal?.throwIfAborted();

    // 2. Try chunk-metadata anchor — HEAD a peer's /chunk/{offset}/data
    //    and cross-check the headers against the chain. Cheaper than the
    //    binary search below for any tx covered by a reachable peer.
    if (this.anchorSource) {
      try {
        log.debug('Attempting chunk-metadata anchor');
        const anchorResult = await this.anchorSource.getTxBoundary(
          absoluteOffset,
          signal,
        );
        if (anchorResult) {
          log.debug('Chunk-metadata anchor successful', {
            txId: anchorResult.id,
            dataRoot: anchorResult.dataRoot,
          });
          return { ...anchorResult, source: 'anchor' };
        }
        log.debug('Chunk-metadata anchor returned no result');
      } catch (error: any) {
        // Re-throw AbortError to propagate cancellation
        if (error.name === 'AbortError') {
          throw error;
        }
        log.debug('Chunk-metadata anchor failed', { error: error.message });
      }
    }

    // Check for abort before tx_path validation
    signal?.throwIfAborted();

    // 3. Try tx_path validation (for unindexed data)
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
          return { ...txPathResult, source: 'tx_path' };
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

    // 4. Try chain fallback (slowest) with concurrency limit
    if (this.chainSource) {
      // Check concurrency limit before attempting chain fallback
      if (this.activeChainFallbackCount >= this.chainFallbackConcurrencyLimit) {
        log.debug('Skipping chain fallback - concurrency limit reached', {
          activeChainFallbackCount: this.activeChainFallbackCount,
          chainFallbackConcurrencyLimit: this.chainFallbackConcurrencyLimit,
        });
        return null;
      }

      this.activeChainFallbackCount++;
      try {
        log.debug('Attempting chain fallback', {
          activeChainFallbackCount: this.activeChainFallbackCount,
          chainFallbackConcurrencyLimit: this.chainFallbackConcurrencyLimit,
        });
        const chainResult = await this.chainSource.getTxBoundary(
          absoluteOffset,
          signal,
        );
        if (chainResult) {
          log.debug('Chain fallback successful', {
            txId: chainResult.id,
            dataRoot: chainResult.dataRoot,
          });
          return { ...chainResult, source: 'chain' };
        }
        log.debug('Chain fallback returned no result');
      } catch (error: any) {
        // Re-throw AbortError to propagate cancellation
        if (error.name === 'AbortError') {
          throw error;
        }
        log.debug('Chain fallback failed', { error: error.message });
      } finally {
        this.activeChainFallbackCount--;
      }
    }

    log.debug('All sources exhausted - no TX boundary found');
    return null;
  }
}
