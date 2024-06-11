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
import { AwsLiteClient } from '@aws-lite/client';

export class S3DataSource implements ContiguousDataSource {
  private log: winston.Logger;
  private s3Client: AwsLiteS3;
  private s3Bucket: string;
  private s3Prefix: string;

  // TODO: Remove this when aws-lite s3 supports Metadata on head-requests
  private awsClient: AwsLiteClient;

  constructor({
    log,
    s3Client,
    s3Bucket,
    s3Prefix = '',
    awsClient,
  }: {
    log: winston.Logger;
    s3Client: AwsLiteS3;
    s3Bucket: string;
    s3Prefix?: string;
    awsClient: AwsLiteClient;
  }) {
    this.log = log.child({ class: 'S3DataSource' });
    this.s3Client = s3Client;
    this.s3Bucket = s3Bucket;
    this.s3Prefix = s3Prefix;
    this.awsClient = awsClient;
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
      // TODO: Use S3 client instead of accessing  aws client directly when aws-lite s3 supports Metadata on head-requests
      // const head = this.s3Client.HeadObject({
      //   Bucket: this.s3Bucket,
      //   Key: `${this.s3Prefix}/${id}`,
      // });

      log.debug('Fetching S3 metadata', {
        id,
        bucket: this.s3Bucket,
        prefix: this.s3Prefix,
      });

      const head = await this.awsClient({
        service: 's3',
        path: `${this.s3Bucket}/${this.s3Prefix}/${id}`,
      });

      if (head.statusCode !== 200) {
        throw new Error('Failed to head data from S3');
      }

      const payloadDataStartS3MetaDataTag = 'x-amz-meta-payload-data-start';
      const range =
        head.headers?.[payloadDataStartS3MetaDataTag] !== undefined
          ? `bytes=${head.headers[payloadDataStartS3MetaDataTag]}-`
          : `bytes=0-`;

      const response = await this.s3Client.GetObject({
        Bucket: this.s3Bucket,
        Key: `${this.s3Prefix}/${id}`,
        Range: range,
        streamResponsePayload: true,
      });

      const payloadContentTypeS3MetaDataTag = 'x-amz-meta-payload-content-type';
      const sourceContentType =
        head.headers?.[payloadContentTypeS3MetaDataTag] ?? response.ContentType;

      log.debug('S3 response', {
        id,
        response: {
          ContentLength: response.ContentLength,
          ContentType: response.ContentType,
        },
        payload: {
          range,
          sourceContentType,
        },
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
        sourceContentType,
        cached: false,
        requestAttributes: {
          hops,
          origin,
        },
      };
    } catch (error: any) {
      log.error('Failed to fetch contiguous data from S3', {
        id,
        message: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }
}
