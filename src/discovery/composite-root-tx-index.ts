/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';
import CircuitBreaker from 'opossum';
import { DataItemRootIndex } from '../types.js';
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

  async getRootTx(id: string): Promise<
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
      try {
        log.debug('Trying index', {
          indexNumber: i + 1,
          totalIndexes: this.indexes.length,
          indexClass: indexName,
          circuitState: circuitBreaker.opened ? 'OPEN' : 'CLOSED',
        });

        // Execute with circuit breaker protection
        const result = await circuitBreaker.fire(id);
        const lookupDuration = Date.now() - lookupStartTime;
        metrics.rootTxLookupDurationSummary.observe(
          { source: sourceName },
          lookupDuration,
        );

        if (result !== undefined) {
          // Check if result has complete offset information
          // If offsets are missing, try next index (e.g., Turbo) for complete data
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

          if (hasCompleteOffsets) {
            log.debug('Found root TX ID with complete offsets', {
              rootTxId: result.rootTxId,
              indexNumber: i + 1,
              indexClass: indexName,
            });
            winningSourceName = sourceName;

            // Record composite lookup metrics
            metrics.compositeRootTxLookupTotal.inc({
              status: 'found',
              winning_source: winningSourceName,
              has_complete_offsets: 'true',
            });
            metrics.compositeRootTxLookupDurationSummary.observe(
              Date.now() - compositeStartTime,
            );

            return result;
          } else {
            // Save as fallback if we don't have one yet
            if (fallbackResult === undefined) {
              fallbackResult = result;
              fallbackSourceName = sourceName;
              log.debug(
                'Found root TX ID but missing offsets, saving as fallback',
                {
                  rootTxId: result.rootTxId,
                  indexNumber: i + 1,
                  indexClass: indexName,
                  hasRootOffset: result.rootOffset !== undefined,
                  hasRootDataOffset: result.rootDataOffset !== undefined,
                  hasSize: result.size !== undefined,
                  hasDataSize: result.dataSize !== undefined,
                },
              );
            }
            // Continue to next index for complete data
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
    metrics.compositeRootTxLookupDurationSummary.observe(
      Date.now() - compositeStartTime,
    );

    return undefined;
  }
}
