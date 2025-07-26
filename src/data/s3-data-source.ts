/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';

import {
  ContiguousData,
  ContiguousDataSource,
  Region,
  RequestAttributes,
} from '../types.js';
import { AwsLiteS3 } from '@aws-lite/s3-types';
import { Readable } from 'node:stream';
import { AwsLiteClient } from '@aws-lite/client';
import { generateRequestAttributes } from '../lib/request-attributes.js';
import * as metrics from '../metrics.js';

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
    this.log = log.child({ class: this.constructor.name });
    this.s3Client = s3Client;
    this.s3Bucket = s3Bucket;
    this.s3Prefix = s3Prefix;
    this.awsClient = awsClient;
  }

  async getData({
    id,
    requestAttributes,
    region,
  }: {
    id: string;
    requestAttributes?: RequestAttributes;
    region?: Region;
  }): Promise<ContiguousData> {
    const log = this.log.child({ method: 'getData', id });
    log.debug('Fetching contiguous data from S3', {
      bucket: this.s3Bucket,
      prefix: this.s3Prefix,
      region,
    });

    try {
      const head = await this.awsClient.S3.HeadObject({
        Bucket: this.s3Bucket,
        Key: `${this.s3Prefix}/${id}`,
      });

      log.debug('S3 head response', {
        response: {
          ContentLength: head.ContentLength,
          ContentType: head.ContentType,
          Metadata: head.Metadata,
        },
      });

      const requestAttributesHeaders =
        generateRequestAttributes(requestAttributes);

      // Handle zero-byte data items
      const payloadDataStart = head.Metadata?.['payload-data-start'];
      if (
        payloadDataStart !== undefined &&
        head.ContentLength !== undefined &&
        +payloadDataStart === head.ContentLength
      ) {
        log.debug('Returning empty stream for zero-byte data item', {
          payloadDataStart,
          contentLength: head.ContentLength,
        });
        return {
          stream: Readable.from([]), // Return an empty stream for zero-byte items
          size: 0,
          verified: false,
          trusted: true,
          sourceContentType: head.Metadata?.['payload-content-type'],
          cached: false,
          requestAttributes: requestAttributesHeaders?.attributes,
        };
      }

      // Handle non-zero-byte data
      const startOffset =
        +(head.Metadata?.['payload-data-start'] ?? 0) + +(region?.offset ?? 0);
      const range = `bytes=${startOffset}-${region?.size !== undefined ? startOffset + region.size - 1 : ''}`;

      const response = await this.s3Client.GetObject({
        Bucket: this.s3Bucket,
        Key: `${this.s3Prefix}/${id}`,
        Range: range,
        streamResponsePayload: true,
      });

      const sourceContentType =
        head.Metadata?.['payload-content-type'] ?? response.ContentType;

      log.debug('S3 response', {
        response: {
          ContentLength: response.ContentLength,
          ContentType: response.ContentType,
          ContentRange: response.ContentRange,
        },
        payload: {
          range,
          sourceContentType,
        },
      });

      if (response.ContentLength === undefined) {
        throw new Error('Content-Length header missing from S3 response');
      }

      if (response.Body === undefined) {
        throw new Error('Body missing from S3 response');
      }

      const stream = response.Body as Readable;

      stream.on('error', () => {
        metrics.getDataStreamErrorsTotal.inc({
          class: this.constructor.name,
          source: 's3',
        });
      });

      stream.on('end', () => {
        metrics.getDataStreamSuccessesTotal.inc({
          class: this.constructor.name,
          source: 's3',
        });
      });

      return {
        stream,
        size:
          contentSizeFromContentRange(response.ContentRange) ??
          response.ContentLength,
        verified: false,
        trusted: true, // we only cache trusted data
        sourceContentType,
        cached: false,
        requestAttributes: requestAttributesHeaders?.attributes,
      };
    } catch (error: any) {
      metrics.getDataErrorsTotal.inc({
        class: this.constructor.name,
        source: 's3',
      });
      log.error('Failed to fetch contiguous data from S3', {
        id,
        message: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }
}

// Expected format: `bytes start-end/maxSize`
function contentSizeFromContentRange(
  contentRange: string | undefined,
): number | undefined {
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
  if (!contentRange) return undefined;

  const parts = contentRange.match(/bytes (\d+)-(\d+)/);
  if (!parts) return undefined;

  const start = parseInt(parts[1], 10);
  const end = parseInt(parts[2], 10);
  if (isNaN(start) || isNaN(end)) return undefined;

  return end - start + 1;
}
