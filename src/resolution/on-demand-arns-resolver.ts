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
import { ANT, AoClient, AoIORead, AOProcess, IO } from '@ar.io/sdk';
import * as config from '../config.js';
import { connect } from '@permaweb/aoconnect';

export class OnDemandArNSResolver implements NameResolver {
  private log: winston.Logger;
  private networkProcess: AoIORead;
  private ao: AoClient;

  constructor({
    log,
    ao = connect({
      MU_URL: config.AO_MU_URL,
      CU_URL: config.AO_CU_URL,
      GRAPHQL_URL: config.AO_GRAPHQL_URL,
      GATEWAY_URL: config.AO_GATEWAY_URL,
    }),
    networkProcess = IO.init({
      process: new AOProcess({
        processId: config.IO_PROCESS_ID,
        ao: ao,
      }),
    }),
  }: {
    log: winston.Logger;
    networkProcess?: AoIORead;
    ao?: AoClient;
  }) {
    this.log = log.child({
      class: 'OnDemandArNSResolver',
    });
    this.networkProcess = networkProcess;
    this.ao = ao;
  }

  async resolve(name: string): Promise<NameResolution> {
    this.log.info('Resolving name...', { name });
    try {
      // get the base name which is the last of th array split by _
      const baseName = name.split('_').pop();
      if (baseName === undefined) {
        throw new Error('Invalid name');
      }
      // find that name in the network process
      const arnsRecord = await this.networkProcess.getArNSRecord({
        name: baseName,
      });

      if (arnsRecord === undefined || arnsRecord.processId === undefined) {
        throw new Error('Invalid name, arns record not found');
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
