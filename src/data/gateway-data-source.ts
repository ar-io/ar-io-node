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
import { default as axios } from 'axios';
import winston from 'winston';
import { headerNames } from '../constants.js';

import {
  ContiguousData,
  ContiguousDataSource,
  RequestAttributes,
} from '../types.js';
import * as metrics from '../metrics.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 10000;

export class GatewayDataSource implements ContiguousDataSource {
  private log: winston.Logger;
  private trustedGatewayAxios;

  constructor({
    log,
    trustedGatewayUrl,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  }: {
    log: winston.Logger;
    trustedGatewayUrl: string;
    requestTimeoutMs?: number;
  }) {
    this.log = log.child({ class: 'GatewayDataSource' });
    this.trustedGatewayAxios = axios.create({
      baseURL: trustedGatewayUrl,
      timeout: requestTimeoutMs,
    });
  }

  async getData({
    id,
    requestAttributes,
  }: {
    id: string;
    requestAttributes?: RequestAttributes;
  }): Promise<ContiguousData> {
    const path = `/raw/${id}`;
    this.log.info('Fetching contiguous data from gateway', {
      id,
      trustedGatewayUrl: this.trustedGatewayAxios.defaults.baseURL,
      path,
    });

    const requestOriginAndHopsHeaders: { [key: string]: string } = {};
    let hops;
    let origin;
    if (requestAttributes !== undefined) {
      hops = requestAttributes.hops + 1;
      requestOriginAndHopsHeaders[headerNames.hops] = hops.toString();

      if (requestAttributes.origin !== undefined) {
        origin = requestAttributes.origin;
        requestOriginAndHopsHeaders[headerNames.origin] = origin;
      }
    } else {
      hops = 1;
    }

    const response = await this.trustedGatewayAxios.request({
      method: 'GET',
      headers: {
        'Accept-Encoding': 'identity',
        ...requestOriginAndHopsHeaders,
      },
      url: path,
      responseType: 'stream',
    });

    metrics.arweaveTxFetchCounter.inc({ node_type: 'trusted' });

    if (response.status !== 200) {
      throw new Error(
        `Unexpected status code from gateway: ${response.status}`,
      );
    }

    return {
      stream: response.data,
      size: parseInt(response.headers['content-length']),
      verified: false,
      sourceContentType: response.headers['content-type'],
      cached: false,
      requestAttributes: {
        hops:
          response.headers[headerNames.hops.toLowerCase()] !== undefined
            ? parseInt(response.headers[headerNames.hops.toLowerCase()])
            : hops,
        origin,
      },
    };
  }
}
