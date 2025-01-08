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

import { isValidDataId } from '../lib/validation.js';
import { NameResolution, NameResolver } from '../types.js';
import { ANT, AoClient, AoARIORead, AOProcess, ARIO } from '@ar.io/sdk';
import * as config from '../config.js';
import { connect } from '@permaweb/aoconnect';
import CircuitBreaker from 'opossum';
import * as metrics from '../metrics.js';

export class OnDemandArNSResolver implements NameResolver {
  private log: winston.Logger;
  private networkProcess: AoARIORead;
  private ao: AoClient;
  private aoCircuitBreaker: CircuitBreaker<
    Parameters<AoARIORead['getArNSRecord']>,
    Awaited<ReturnType<AoARIORead['getArNSRecord']>>
  >;

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
    circuitBreakerOptions = {
      timeout: config.ARNS_ON_DEMAND_CIRCUIT_BREAKER_TIMEOUT_MS,
      errorThresholdPercentage:
        config.ARNS_ON_DEMAND_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE,
      rollingCountTimeout:
        config.ARNS_ON_DEMAND_CIRCUIT_BREAKER_ROLLING_COUNT_TIMEOUT_MS,
      resetTimeout: config.ARNS_ON_DEMAND_CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
    },
  }: {
    log: winston.Logger;
    networkProcess?: AoARIORead;
    ao?: AoClient;
    circuitBreakerOptions?: CircuitBreaker.Options;
  }) {
    this.log = log.child({
      class: 'OnDemandArNSResolver',
    });
    this.networkProcess = networkProcess;
    this.ao = ao;
    // TODO: use getRecords instead of getArNSRecord
    this.aoCircuitBreaker = new CircuitBreaker(
      ({ name }: { name: string }) => {
        return this.networkProcess.getArNSRecord({ name });
      },
      {
        ...circuitBreakerOptions,
        name: 'getArNSRecord',
      },
    );
    metrics.circuitBreakerMetrics.add(this.aoCircuitBreaker);
  }

  async resolve(name: string): Promise<NameResolution> {
    this.log.info('Resolving name...', { name });
    try {
      // get the base name which is the last of the array split by _
      const baseName = name.split('_').pop();
      if (baseName === undefined) {
        throw new Error('Invalid name');
      }
      // find that name in the network process, using the circuit breaker if there are persistent AO issues
      const arnsRecord = await this.aoCircuitBreaker.fire({ name: baseName });

      if (arnsRecord === undefined) {
        throw new Error('Unexpected undefined from CU');
      }

      if (arnsRecord === null || arnsRecord.processId === undefined) {
        return {
          name,
          resolvedId: undefined,
          resolvedAt: Date.now(),
          ttl: 300,
          processId: undefined,
        };
      }

      const processId = arnsRecord.processId;

      // now get the ant process from the process id
      const ant = ANT.init({
        process: new AOProcess({
          processId: processId,
          ao: this.ao,
        }),
      });

      // if it is the root name, then it should point to '@'
      const undername =
        name === baseName ? '@' : name.replace(`_${baseName}`, '');

      const antRecord = await ant.getRecord({
        undername,
      });

      if (antRecord === undefined) {
        throw new Error('Invalid name, ant record for name not found');
      }

      const resolvedId = antRecord.transactionId;
      const ttl = antRecord.ttlSeconds;

      if (!isValidDataId(resolvedId)) {
        throw new Error('Invalid resolved data ID');
      }
      return {
        name,
        resolvedId,
        resolvedAt: Date.now(),
        processId: processId,
        ttl,
      };
    } catch (error: any) {
      this.log.warn('Unable to resolve name:', {
        name,
        message: error.message,
        stack: error.stack,
      });
    }

    return {
      name,
      resolvedId: undefined,
      resolvedAt: undefined,
      ttl: undefined,
      processId: undefined,
    };
  }
}
