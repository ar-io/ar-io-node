/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';
import CircuitBreaker from 'opossum';
import {
  DataItemRootIndex,
  GetRootTxOptions,
  RootTxLookupResult,
} from '../types.js';
import * as config from '../config.js';
import * as metrics from '../metrics.js';

export class CompositeRootTxIndex implements DataItemRootIndex {
  private log: winston.Logger;
  private indexes: DataItemRootIndex[];
  private circuitBreakers: Map<
    string,
    CircuitBreaker<
      [string],
      | {
          rootTxId: string;
          path?: string[];
          rootOffset?: number;
          rootDataOffset?: number;
          contentType?: string;
          size?: number;
          dataSize?: number;
        }
      | undefined
    >
  >;

  // Map class names to source labels for metrics
  private static readonly SOURCE_NAME_MAP: Record<string, string> = {
    TurboRootTxIndex: 'turbo',
    GatewaysRootTxIndex: 'gateways',
    GraphQLRootTxIndex: 'graphql',
    StandaloneSqlite: 'db',
    Cdb64RootTxIndex: 'cdb64',
    HyperBeamRootTxIndex: 'hyperbeam',
  };

  private getSourceName(className: string): string {
    return (
      CompositeRootTxIndex.SOURCE_NAME_MAP[className] ?? className.toLowerCase()
    );
  }

  constructor({
    log,
    indexes,
    circuitBreakerOptions = {
      timeout: config.ROOT_TX_INDEX_CIRCUIT_BREAKER_TIMEOUT_MS,
      errorThresholdPercentage:
        config.ROOT_TX_INDEX_CIRCUIT_BREAKER_FAILURE_THRESHOLD,
      resetTimeout: config.ROOT_TX_INDEX_CIRCUIT_BREAKER_TIMEOUT_MS,
      rollingCountTimeout: config.ROOT_TX_INDEX_CIRCUIT_BREAKER_TIMEOUT_MS * 2,
    },
  }: {
    log: winston.Logger;
    indexes: DataItemRootIndex[];
    circuitBreakerOptions?: CircuitBreaker.Options;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.indexes = indexes;

    // Create a circuit breaker for each index
    this.circuitBreakers = new Map();
    for (const index of indexes) {
      const name = index.constructor.name;
      const breaker = new CircuitBreaker((id: string) => index.getRootTx(id), {
        ...circuitBreakerOptions,
        name,
      });

      // Register metrics for this circuit breaker
      // Map class names to BreakerSource values
      // Handle GraphQL as a special case to keep it as one word
      const breakerSourceName = name
        .replace('RootTxIndex', '')
        .replace('GraphQL', 'Graphql')
        .replace('HyperBeam', 'Hyperbeam')
        .replace(/([A-Z])/g, '-$1')
        .toLowerCase()
        .replace(/^-/, '')
        .concat('-root-tx-index') as metrics.BreakerSource;

      // Use both deprecated and new metrics setup for compatibility
      metrics.circuitBreakerMetrics.add(breaker);
      metrics.setUpCircuitBreakerListenerMetrics(
        breakerSourceName,
        breaker,
        log,
      );

      this.circuitBreakers.set(name, breaker);
    }
  }

  /**
   * Resolves a data item ID to its root transaction, probing the configured
   * indexes in order and returning the first *actionable* result — one the
   * caller can proceed on without consulting the remaining (often remote and
   * expensive) sources. A result is actionable when it has complete offsets,
   * is a definitive L1 root (`rootTxId === id`), carries `rootOffset` +
   * `rootDataOffset`, or carries a non-empty traversal path.
   *
   * A bare `rootTxId` (no path/offsets, not an L1 root) is not actionable: it
   * is retained as a fallback while later indexes are probed for something
   * richer. If no source is actionable, the saved fallback is returned, or
   * `undefined` when nothing resolved.
   *
   * Callers can override the acceptance decision via `opts.accept` — a
   * predicate that returns `true` to short-circuit on a given result. This
   * lets a caller that only needs (say) a `rootTxId` stop as soon as any
   * source supplies one, rather than probing remote sources for richer
   * metadata it will derive locally. When omitted, the default actionable
   * acceptance above applies.
   *
   * @param id - base64url data item / transaction ID to resolve.
   * @param opts - optional lookup options; see {@link GetRootTxOptions}.
   * @returns The root transaction info, or `undefined` if unresolved.
   */
  async getRootTx(
    id: string,
    opts?: GetRootTxOptions,
  ): Promise<
    | {
        rootTxId: string;
        path?: string[];
        rootOffset?: number;
        rootDataOffset?: number;
        contentType?: string;
        size?: number;
        dataSize?: number;
      }
    | undefined
  > {
    const log = this.log.child({ method: 'getRootTx', id });
    const compositeStartTime = Date.now();

    // Keep track of incomplete result as fallback
    let fallbackResult:
      | {
          rootTxId: string;
          path?: string[];
          rootOffset?: number;
          rootDataOffset?: number;
          contentType?: string;
          size?: number;
          dataSize?: number;
        }
      | undefined;
    let fallbackSourceName: string | undefined;
    let winningSourceName: string | undefined;
    // Number of sources actually queried (circuit-open sources are skipped and
    // do not count). Emitted so we can measure how much of the chain a
    // short-circuit avoids.
    let probedCount = 0;

    for (let i = 0; i < this.indexes.length; i++) {
      const index = this.indexes[i];
      const indexName = index.constructor.name;
      const sourceName = this.getSourceName(indexName);
      const circuitBreaker = this.circuitBreakers.get(indexName)!;

      // Skip if circuit is open
      if (circuitBreaker.opened) {
        log.debug('Skipping index due to open circuit', {
          indexNumber: i + 1,
          indexClass: indexName,
          circuitState: 'OPEN',
        });
        metrics.rootTxLookupTotal.inc({
          source: sourceName,
          status: 'circuit_open',
          has_offsets: 'false',
        });
        continue;
      }

      const lookupStartTime = Date.now();
      let result: RootTxLookupResult | undefined;
      try {
        log.debug('Trying index', {
          indexNumber: i + 1,
          totalIndexes: this.indexes.length,
          indexClass: indexName,
          circuitState: circuitBreaker.opened ? 'OPEN' : 'CLOSED',
        });

        // Execute with circuit breaker protection
        probedCount++;
        result = await circuitBreaker.fire(id);
      } catch (error: any) {
        const lookupDuration = Date.now() - lookupStartTime;
        metrics.rootTxLookupDurationSummary.observe(
          { source: sourceName },
          lookupDuration,
        );
        metrics.rootTxLookupTotal.inc({
          source: sourceName,
          status: 'error',
          has_offsets: 'false',
        });
        log.debug('Index failed with error', {
          indexNumber: i + 1,
          indexClass: indexName,
          error: error.message,
          circuitState: circuitBreaker.opened ? 'OPEN' : 'CLOSED',
        });
        // Continue to next index
        continue;
      }

      // Result classification runs OUTSIDE the source-lookup try/catch above so
      // that an exception thrown by a caller-supplied opts.accept predicate
      // propagates to the caller instead of being misattributed as a source
      // failure — which would swallow the bug and silently return a fallback or
      // later result.
      const lookupDuration = Date.now() - lookupStartTime;
      metrics.rootTxLookupDurationSummary.observe(
        { source: sourceName },
        lookupDuration,
      );

      if (result !== undefined) {
        // Check if result has complete offset information
        const hasCompleteOffsets =
          result.rootOffset !== undefined &&
          result.rootDataOffset !== undefined &&
          result.size !== undefined &&
          result.dataSize !== undefined;

        metrics.rootTxLookupTotal.inc({
          source: sourceName,
          status: 'found',
          has_offsets: hasCompleteOffsets ? 'true' : 'false',
        });

        // Decide whether this result is sufficient to stop the search.
        //
        // When the caller supplies opts.accept, it fully governs the decision
        // (exit reason `caller_accept`) — e.g. "any rootTxId is enough, I'll
        // resolve offsets locally" avoids probing remote sources. Otherwise the
        // default "actionable" acceptance applies: requiring all four offset
        // fields (hasCompleteOffsets) is too strict — no locally-configured
        // source (db, cdb) ever supplies `size`, so the search never
        // short-circuited and every lookup fell through to the expensive
        // downstream sources (e.g. GraphQL) even when db/cdb had already
        // answered. A result is actionable when the caller can proceed without
        // probing the remaining sources:
        //   - complete_offsets: full offsets + size (skip even a header parse)
        //   - l1_root: rootTxId === id, a definitive L1 root (passthrough)
        //   - offsets: rootOffset + rootDataOffset present (serve via a cheap
        //     header parse for size; the CDB case)
        //   - path: a bundle traversal path (path-guided navigation)
        let exitReason:
          | 'complete_offsets'
          | 'l1_root'
          | 'offsets'
          | 'path'
          | 'caller_accept'
          | undefined;
        if (opts?.accept !== undefined) {
          if (opts.accept(result)) {
            exitReason = 'caller_accept';
          }
        } else if (hasCompleteOffsets) {
          exitReason = 'complete_offsets';
        } else if (result.rootTxId === id) {
          exitReason = 'l1_root';
        } else if (
          result.rootOffset !== undefined &&
          result.rootDataOffset !== undefined
        ) {
          exitReason = 'offsets';
        } else if (result.path !== undefined && result.path.length > 0) {
          exitReason = 'path';
        }

        if (exitReason !== undefined) {
          winningSourceName = sourceName;
          log.debug('Found actionable root TX result, short-circuiting', {
            rootTxId: result.rootTxId,
            indexNumber: i + 1,
            indexClass: indexName,
            exitReason,
            sourcesProbed: probedCount,
            sourcesSkipped: this.indexes.length - i - 1,
          });

          metrics.compositeRootTxLookupTotal.inc({
            status: 'found',
            winning_source: winningSourceName,
            has_complete_offsets: hasCompleteOffsets ? 'true' : 'false',
          });
          metrics.compositeRootTxExitReasonTotal.inc({
            reason: exitReason,
            winning_source: winningSourceName,
          });
          metrics.compositeRootTxSourcesProbedSummary.observe(probedCount);
          metrics.compositeRootTxLookupDurationSummary.observe(
            Date.now() - compositeStartTime,
          );

          return result;
        }

        // Not actionable (bare rootTxId: no path, no offsets, not an L1 root).
        // Save as a fallback and keep probing for something better.
        if (fallbackResult === undefined) {
          fallbackResult = result;
          fallbackSourceName = sourceName;
          log.debug('Found root TX ID but not actionable, saving as fallback', {
            rootTxId: result.rootTxId,
            indexNumber: i + 1,
            indexClass: indexName,
          });
        }
      } else {
        metrics.rootTxLookupTotal.inc({
          source: sourceName,
          status: 'not_found',
          has_offsets: 'false',
        });
        log.debug('Index returned undefined', {
          indexNumber: i + 1,
          indexClass: indexName,
        });
      }
    }

    // If we have a fallback result (incomplete but has rootTxId), return it
    if (fallbackResult !== undefined) {
      log.debug('Returning fallback result with incomplete offsets', {
        rootTxId: fallbackResult.rootTxId,
        hasRootOffset: fallbackResult.rootOffset !== undefined,
        hasRootDataOffset: fallbackResult.rootDataOffset !== undefined,
        hasSize: fallbackResult.size !== undefined,
      });

      // Record composite lookup metrics for fallback result
      metrics.compositeRootTxLookupTotal.inc({
        status: 'found',
        winning_source: fallbackSourceName ?? 'fallback',
        has_complete_offsets: 'false',
      });
      metrics.compositeRootTxExitReasonTotal.inc({
        reason: 'fallback',
        winning_source: fallbackSourceName ?? 'fallback',
      });
      metrics.compositeRootTxSourcesProbedSummary.observe(probedCount);
      metrics.compositeRootTxLookupDurationSummary.observe(
        Date.now() - compositeStartTime,
      );

      return fallbackResult;
    }

    log.debug('All indexes failed to find root TX ID', {
      id,
      triedIndexes: this.indexes.length,
    });

    // Record composite lookup metrics for not found case
    metrics.compositeRootTxLookupTotal.inc({
      status: 'not_found',
      winning_source: 'none',
      has_complete_offsets: 'false',
    });
    metrics.compositeRootTxExitReasonTotal.inc({
      reason: 'not_found',
      winning_source: 'none',
    });
    metrics.compositeRootTxSourcesProbedSummary.observe(probedCount);
    metrics.compositeRootTxLookupDurationSummary.observe(
      Date.now() - compositeStartTime,
    );

    return undefined;
  }
}
