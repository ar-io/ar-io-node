/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';

import { isValidDataId } from '../lib/validation.js';
import { NameResolution, NameResolver } from '../types.js';
import { ANT, AOProcess, AoArNSNameDataWithName, AoClient } from '@ar.io/sdk';
import * as config from '../config.js';
import { connect } from '@permaweb/aoconnect';
import CircuitBreaker from 'opossum';
import * as metrics from '../metrics.js';

export class OnDemandArNSResolver implements NameResolver {
  private log: winston.Logger;
  private ao: AoClient;
  private hyperbeamUrl: string | undefined;

  constructor({
    log,
    ao = connect({
      MU_URL: config.AO_MU_URL,
      CU_URL: config.ANT_AO_CU_URL,
      GRAPHQL_URL: config.AO_GRAPHQL_URL,
      GATEWAY_URL: config.AO_GATEWAY_URL,
    }),
    hyperbeamUrl = config.AO_ANT_HYPERBEAM_URL,
  }: {
    log: winston.Logger;
    ao?: AoClient;
    circuitBreakerOptions?: CircuitBreaker.Options;
    hyperbeamUrl?: string;
  }) {
    this.log = log.child({
      class: 'OnDemandArNSResolver',
      networkCuUrl: config.NETWORK_AO_CU_URL ?? '<sdk default>',
      antCuUrl: config.ANT_AO_CU_URL ?? '<sdk default>',
      hyperbeamUrl: hyperbeamUrl ?? '<sdk default>',
    });
    this.ao = ao;
    this.hyperbeamUrl = hyperbeamUrl;
  }

  async resolve({
    name,
    baseArNSRecordFn,
  }: {
    name: string;
    baseArNSRecordFn: (
      parentSpan?: any,
    ) => Promise<AoArNSNameDataWithName | undefined>;
  }): Promise<NameResolution> {
    this.log.info('Resolving name...', { name });
    try {
      const baseArNSRecord = await baseArNSRecordFn();
      if (!baseArNSRecord) {
        this.log.warn('Base name not found in ArNS names cache', {
          name,
        });
        metrics.arnsNameCacheMissCounter.inc();
        return {
          name,
          resolvedId: undefined,
          resolvedAt: undefined,
          ttl: undefined,
          processId: undefined,
          limit: undefined,
          index: undefined,
        };
      }

      // get the base name which is the last of the array split by _
      const baseName = name.split('_').pop();
      if (baseName === undefined) {
        throw new Error('Invalid name');
      }

      if (baseArNSRecord === undefined) {
        throw new Error('Unexpected undefined from CU');
      }

      if (baseArNSRecord === null || baseArNSRecord.processId === undefined) {
        return {
          name,
          resolvedId: undefined,
          resolvedAt: Date.now(),
          ttl: 300,
          processId: undefined,
          limit: undefined,
          index: undefined,
        };
      }

      const processId = baseArNSRecord.processId;

      // now get the ant process from the process id
      const ant = ANT.init({
        process: new AOProcess({
          processId: processId,
          ao: this.ao,
        }),
        hyperbeamUrl: this.hyperbeamUrl,
      });

      // if it is the root name, then it should point to '@'
      const undername =
        name === baseName ? '@' : name.replace(`_${baseName}`, '');

      // sdk sorts the records by priority, we will use the undername to get the record
      const antRecords = await ant.getRecords();
      const antRecord = antRecords[undername];

      // fail quickly if the name is not in the contract
      if (antRecord === undefined) {
        throw new Error('Invalid name, ant record for name not found');
      }

      // sort the records by priority
      const resolvedId = antRecord.transactionId;
      const ttl = antRecord.ttlSeconds;
      const index = antRecord.index;

      if (!isValidDataId(resolvedId)) {
        throw new Error('Invalid resolved data ID');
      }
      return {
        name,
        resolvedId,
        resolvedAt: Date.now(),
        processId: processId,
        ttl,
        limit: baseArNSRecord.undernameLimit,
        index,
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
      limit: undefined,
      index: undefined,
    };
  }
}
