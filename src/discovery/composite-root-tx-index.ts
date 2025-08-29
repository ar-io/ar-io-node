/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';
import { DataItemRootTxIndex } from '../types.js';
import { CircuitBreaker } from './circuit-breaker.js';
import * as config from '../config.js';

export class CompositeRootTxIndex implements DataItemRootTxIndex {
  private log: winston.Logger;
  private indexes: DataItemRootTxIndex[];
  private circuitBreakers: Map<string, CircuitBreaker>;

  constructor({
    log,
    indexes,
    circuitBreakerConfig = {
      failureThreshold: config.CIRCUIT_BREAKER_FAILURE_THRESHOLD,
      successThreshold: config.CIRCUIT_BREAKER_SUCCESS_THRESHOLD,
      timeoutMs: config.CIRCUIT_BREAKER_TIMEOUT_MS,
    },
  }: {
    log: winston.Logger;
    indexes: DataItemRootTxIndex[];
    circuitBreakerConfig?: {
      failureThreshold: number;
      successThreshold: number;
      timeoutMs: number;
    };
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
      this.circuitBreakers.set(
        name,
        new CircuitBreaker({
          name,
          log,
          ...circuitBreakerConfig,
        }),
      );
    }
  }

  async getRootTxId(id: string): Promise<string | undefined> {
    const log = this.log.child({ method: 'getRootTxId', id });

    for (let i = 0; i < this.indexes.length; i++) {
      const index = this.indexes[i];
      const indexName = index.constructor.name;
      const circuitBreaker = this.circuitBreakers.get(indexName)!;

      // Skip if circuit is open
      if (circuitBreaker.isOpen()) {
        log.debug('Skipping index due to open circuit', {
          indexNumber: i + 1,
          indexClass: indexName,
          circuitState: circuitBreaker.getState(),
        });
        continue;
      }

      try {
        log.debug('Trying index', {
          indexNumber: i + 1,
          totalIndexes: this.indexes.length,
          indexClass: indexName,
          circuitState: circuitBreaker.getState(),
        });

        // Execute with circuit breaker protection
        const rootTxId = await circuitBreaker.execute(() =>
          index.getRootTxId(id),
        );

        if (rootTxId !== undefined) {
          log.debug('Found root TX ID', {
            rootTxId,
            indexNumber: i + 1,
            indexClass: indexName,
          });
          return rootTxId;
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
          circuitState: circuitBreaker.getState(),
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
