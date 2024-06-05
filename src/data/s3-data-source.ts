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
import { headerNames } from '../constants.js';

import {
  ContiguousData,
  ContiguousDataSource,
  RequestAttributes,
} from '../types.js';
import { AwsLiteS3 } from '@aws-lite/s3-types';
import { Readable } from 'node:stream';

export class S3DataSource implements ContiguousDataSource {
  private log: winston.Logger;
  private s3Client: AwsLiteS3;
  private s3Bucket: string;
  private s3Prefix: string;

  constructor({
    log,
    s3Client,
    s3Bucket,
    s3Prefix = '',
  }: {
    log: winston.Logger;
    s3Client: AwsLiteS3;
    s3Bucket: string;
    s3Prefix?: string;
  }) {
    this.log = log.child({ class: 'S3DataSource' });
    this.s3Client = s3Client;
    this.s3Bucket = s3Bucket;
    this.s3Prefix = s3Prefix;
  }

  async getData({
    id,
    requestAttributes,
  }: {
    id: string;
    requestAttributes?: RequestAttributes;
  }): Promise<ContiguousData> {
    const log = this.log.child({ method: 'getData' });
    log.info('Fetching contiguous data from S3', {
      id,
      bucket: this.s3Bucket,
      prefix: this.s3Prefix,
    });

    try {
      const response = await this.s3Client.GetObject({
        Bucket: this.s3Bucket,
        Key: `${this.s3Prefix}/${id}`,
        streamResponsePayload: true,
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

      if (response.ContentLength === undefined) {
        throw new Error('Content-Length header missing from S3 response');
      }

      if (response.Body === undefined) {
        throw new Error('Body missing from S3 response');
      }

      return {
        stream: response.Body as Readable,
        size: response.ContentLength,
        verified: false,
        sourceContentType: response.ContentType,
        cached: false,
        requestAttributes: {
          hops,
          origin,
        },
      };
    } catch (error: any) {
      log.error('Failed to fetch contiguous data from S3', {
        id,
        error,
      });
      throw error;
    }
  }
}
