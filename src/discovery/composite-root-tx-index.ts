/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';
import CircuitBreaker from 'opossum';
import { DataItemRootTxIndex } from '../types.js';
import * as config from '../config.js';
import * as metrics from '../metrics.js';

export class CompositeRootTxIndex implements DataItemRootTxIndex {
  private log: winston.Logger;
  private indexes: DataItemRootTxIndex[];
  private circuitBreakers: Map<
    string,
    CircuitBreaker<
      [string],
      | {
          rootTxId: string;
          rootOffset?: number;
          rootDataOffset?: number;
          contentType?: string;
          size?: number;
          dataSize?: number;
        }
      | undefined
    >
  >;

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
    indexes: DataItemRootTxIndex[];
    circuitBreakerOptions?: CircuitBreaker.Options;
  }) {
    this.log = log.child({ class: this.constructor.name });

    if (indexes.length === 0) {
      throw new Error('At least one index must be provided');
    }

    this.indexes = indexes;

    // Create a circuit breaker for each index
    this.circuitBreakers = new Map();
    for (const index of indexes) {
      const name = index.constructor.name;
      const breaker = new CircuitBreaker(
        (id: string) => index.getRootTxId(id),
        {
          ...circuitBreakerOptions,
          name,
        },
      );

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

  async getRootTxId(id: string): Promise<
    | {
        rootTxId: string;
        rootOffset?: number;
        rootDataOffset?: number;
        contentType?: string;
        size?: number;
        dataSize?: number;
      }
    | undefined
  > {
    const log = this.log.child({ method: 'getRootTxId', id });

    for (let i = 0; i < this.indexes.length; i++) {
      const index = this.indexes[i];
      const indexName = index.constructor.name;
      const circuitBreaker = this.circuitBreakers.get(indexName)!;

      // Skip if circuit is open
      if (circuitBreaker.opened) {
        log.debug('Skipping index due to open circuit', {
          indexNumber: i + 1,
          indexClass: indexName,
          circuitState: 'OPEN',
        });
        continue;
      }

      try {
        log.debug('Trying index', {
          indexNumber: i + 1,
          totalIndexes: this.indexes.length,
          indexClass: indexName,
          circuitState: circuitBreaker.opened ? 'OPEN' : 'CLOSED',
        });

        // Execute with circuit breaker protection
        const result = await circuitBreaker.fire(id);

        if (result !== undefined) {
          log.debug('Found root TX ID', {
            rootTxId: result.rootTxId,
            indexNumber: i + 1,
            indexClass: indexName,
          });
          return result;
        }

        log.debug('Index returned undefined', {
          indexNumber: i + 1,
          indexClass: indexName,
        });
      } catch (error: any) {
        log.debug('Index failed with error', {
          indexNumber: i + 1,
          indexClass: indexName,
          error: error.message,
          circuitState: circuitBreaker.opened ? 'OPEN' : 'CLOSED',
        });
        // Continue to next index
      }
    }

    log.debug('All indexes failed to find root TX ID', {
      id,
      triedIndexes: this.indexes.length,
    });

    return undefined;
  }
}
