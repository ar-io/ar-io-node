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
import { tracer } from '../tracing.js';
import { SpanStatusCode } from '@opentelemetry/api';
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
    const span = tracer.startSpan('S3DataSource.getData', {
      attributes: {
        'data.id': id,
        'data.region.has_region': region !== undefined,
        'data.region.offset': region?.offset,
        'data.region.size': region?.size,
        'arns.name': requestAttributes?.arnsName,
        'arns.basename': requestAttributes?.arnsBasename,
        's3.config.bucket': this.s3Bucket,
        's3.config.prefix': this.s3Prefix,
      },
    });

    const log = this.log.child({ method: 'getData', id });
    try {
      log.debug('Fetching contiguous data from S3', {
        bucket: this.s3Bucket,
        prefix: this.s3Prefix,
        region,
      });

      const objectKey = `${this.s3Prefix}/${id}`;
      span.setAttribute('s3.request.object_key', objectKey);
      span.addEvent('Starting S3 head request');
      const headRequestStart = Date.now();

      const head = await this.awsClient.S3.HeadObject({
        Bucket: this.s3Bucket,
        Key: objectKey,
      });

      const headRequestDuration = Date.now() - headRequestStart;

      span.setAttributes({
        's3.head.request_duration_ms': headRequestDuration,
        's3.head.content_length': head.ContentLength,
        's3.head.content_type': head.ContentType,
      });

      span.addEvent('S3 head request completed');

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
      const payloadContentType = head.Metadata?.['payload-content-type'];

      span.setAttributes({
        's3.metadata.payload_data_start':
          payloadDataStart !== undefined ? +payloadDataStart : undefined,
        's3.metadata.payload_content_type': payloadContentType,
      });

      if (
        payloadDataStart !== undefined &&
        +payloadDataStart === head.ContentLength
      ) {
        span.addEvent('Returning empty stream for zero-byte data item');

        log.debug('Returning empty stream for zero-byte data item', {
          payloadDataStart,
          contentLength: head.ContentLength,
        });

        span.setStatus({
          code: SpanStatusCode.OK,
          message: 'Zero-byte data item returned',
        });
        return {
          stream: Readable.from([]), // Return an empty stream for zero-byte items
          size: 0,
          verified: false,
          trusted: true,
          sourceContentType: payloadContentType,
          cached: false,
          requestAttributes: requestAttributesHeaders?.attributes,
        };
      }

      // Handle non-zero-byte data
      const startOffset = +(payloadDataStart ?? 0) + +(region?.offset ?? 0);
      const range = `bytes=${startOffset}-${region?.size !== undefined ? startOffset + region.size - 1 : ''}`;

      span.setAttributes({
        's3.request.start_offset': startOffset,
        's3.request.range': range,
      });

      span.addEvent('Starting S3 GetObject request');

      const getObjectStart = Date.now();
      const response = await this.s3Client.GetObject({
        Bucket: this.s3Bucket,
        Key: objectKey,
        Range: range,
        streamResponsePayload: true,
      });

      const getObjectDuration = Date.now() - getObjectStart;
      const sourceContentType = payloadContentType ?? response.ContentType;

      span.setAttributes({
        's3.get_object.duration_ms': getObjectDuration,
        's3.response.content_length': response.ContentLength,
        's3.response.content_type': response.ContentType,
        's3.response.content_range': response.ContentRange,
        's3.response.source_content_type': sourceContentType,
      });

      span.addEvent('S3 GetObject request completed');

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

      const finalSize =
        contentSizeFromContentRange(response.ContentRange) ??
        response.ContentLength;

      span.setAttributes({
        's3.response.final_size': finalSize,
        's3.data.verified': false,
        's3.data.trusted': true,
        's3.data.cached': false,
      });

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

      span.setStatus({
        code: SpanStatusCode.OK,
        message: 'S3 data retrieved successfully',
      });

      return {
        stream,
        size: finalSize,
        verified: false,
        trusted: true, // we only cache trusted data
        sourceContentType,
        cached: false,
        requestAttributes: requestAttributesHeaders?.attributes,
      };
    } catch (error: any) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });

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
    } finally {
      span.end();
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
