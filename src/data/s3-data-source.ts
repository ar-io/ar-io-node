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
import { PassThrough, Readable } from 'node:stream';
import { AwsLiteClient } from '@aws-lite/client';
import { generateRequestAttributes } from '../lib/request-attributes.js';
import { startChildSpan } from '../tracing.js';
import { Span } from '@opentelemetry/api';
import { SpanStatusCode } from '@opentelemetry/api';
import * as metrics from '../metrics.js';
import {
  buildRangeHeader,
  parseContentEncoding,
  parseContentRange,
} from '../lib/http-utils.js';
import { decodeDataItemHeader } from '../lib/ans104-bundle-scan.js';

/**
 * Largest item header read to learn an item's Content-Encoding. ANS-104
 * headers are a few KiB (signature, owner, and at most 4 KiB of tags), so
 * anything larger is not read and the item is served without an encoding, as
 * before.
 */
const MAX_ITEM_HEADER_READ_BYTES = 64 * 1024;

/**
 * Reads exactly `length` bytes from the start of `stream`, then hands back the
 * rest of the stream unread: no bytes are lost, duplicated or re-requested.
 *
 * @throws when the stream ends or fails before `length` bytes arrive
 */
export function splitLeadingBytes(
  stream: Readable,
  length: number,
): Promise<{ head: Buffer; rest: Readable }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    const cleanup = () => {
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onEnd = () => {
      cleanup();
      reject(
        new Error(`Stream ended after ${received} of ${length} header bytes`),
      );
    };
    const onData = (chunk: Buffer) => {
      if (received + chunk.length < length) {
        chunks.push(chunk);
        received += chunk.length;
        return;
      }
      const needed = length - received;
      chunks.push(chunk.subarray(0, needed));
      cleanup();
      stream.pause();

      const rest = new PassThrough();
      const remainder = chunk.subarray(needed);
      if (remainder.length > 0) {
        rest.write(remainder);
      }
      stream.on('error', (error) => rest.destroy(error));
      rest.on('close', () => {
        if (!stream.destroyed) {
          stream.destroy();
        }
      });
      stream.pipe(rest);
      resolve({ head: Buffer.concat(chunks), rest });
    };
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}

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

  /**
   * The Content-Encoding from an item's own header bytes, read from the start
   * of its object. The header must be this item's (its signature hashes to
   * `id`) and end where the metadata says the payload starts; otherwise, or if
   * it cannot be decoded, the encoding is left unknown and the payload is
   * served as before.
   */
  private contentEncodingFromHeader(
    id: string,
    itemHeader: Buffer,
    log: winston.Logger,
  ): string | undefined {
    try {
      const decoded = decodeDataItemHeader(itemHeader);
      if (
        !decoded.complete ||
        decoded.header.id !== id ||
        decoded.header.headerSize !== itemHeader.length
      ) {
        log.debug('Item header does not match its object; encoding unknown', {
          complete: decoded.complete,
          headerId: decoded.complete ? decoded.header.id : undefined,
        });
        return undefined;
      }
      return parseContentEncoding(decoded.header.contentEncoding);
    } catch (error: any) {
      log.debug('Could not decode item header; encoding unknown', {
        error: error.message,
      });
      return undefined;
    }
  }

  /**
   * Fetch contiguous data for `id` from the configured S3 bucket.
   *
   * Logging contract: a `HeadObject` 404 means the object is simply absent --
   * an expected miss, since S3 is typically first in the retrieval order and
   * most ids were never uploaded via Turbo. Misses are logged at debug and are
   * *not* counted in `getDataErrorsTotal`; every other failure is. Both still
   * throw, because the caller's cascade advances on exceptions.
   */
  async getData({
    id,
    requestAttributes,
    region,
    parentSpan,
    signal,
  }: {
    id: string;
    requestAttributes?: RequestAttributes;
    region?: Region;
    parentSpan?: Span;
    signal?: AbortSignal;
  }): Promise<ContiguousData> {
    const span = startChildSpan(
      'S3DataSource.getData',
      {
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
      },
      parentSpan,
    );

    const log = this.log.child({ method: 'getData', id });
    try {
      // Check for abort before starting
      signal?.throwIfAborted();
      log.debug('Fetching contiguous data from S3', {
        bucket: this.s3Bucket,
        prefix: this.s3Prefix,
        region,
      });

      const objectKey = `${this.s3Prefix}/${id}`;
      span.setAttribute('s3.request.object_key', objectKey);
      span.addEvent('Starting S3 head request');
      const headRequestStart = Date.now();

      // Check for abort before S3 HeadObject
      signal?.throwIfAborted();

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

        return {
          stream: Readable.from([]), // Return an empty stream for zero-byte items
          size: 0,
          totalSize: 0,
          verified: false,
          trusted: true,
          sourceContentType: payloadContentType,
          cached: false,
          requestAttributes: requestAttributesHeaders?.attributes,
        };
      }

      // Handle non-zero-byte data
      // The item's Content-Encoding. Turbo records it as metadata when the
      // item is tagged with one; objects written before that carry none, so
      // a full read starts at the item header instead of the payload, in the
      // same request, and reads it from the signed tags there.
      const metadataContentEncoding = parseContentEncoding(
        head.Metadata?.['payload-content-encoding'],
      );
      const headerLength = +(payloadDataStart ?? 0);
      const readItemHeader =
        metadataContentEncoding === undefined &&
        region === undefined &&
        payloadDataStart !== undefined &&
        Number.isSafeInteger(headerLength) &&
        headerLength > 0 &&
        headerLength <= MAX_ITEM_HEADER_READ_BYTES;
      const startOffset =
        (readItemHeader ? 0 : headerLength) + +(region?.offset ?? 0);
      const endOffset =
        region?.size !== undefined ? startOffset + region.size - 1 : undefined;
      const range = buildRangeHeader(startOffset, endOffset);

      span.setAttributes({
        's3.request.start_offset': startOffset,
        's3.request.range': range,
      });

      span.addEvent('Starting S3 GetObject request');

      // Check for abort before S3 GetObject
      signal?.throwIfAborted();

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

      let stream = response.Body as Readable;

      let finalSize =
        parseContentRange(response.ContentRange)?.size ??
        response.ContentLength;

      let sourceContentEncoding = metadataContentEncoding;
      if (readItemHeader) {
        const { head: itemHeader, rest } = await splitLeadingBytes(
          stream,
          headerLength,
        );
        stream = rest;
        finalSize -= headerLength;
        sourceContentEncoding = this.contentEncodingFromHeader(
          id,
          itemHeader,
          log,
        );
      }

      span.setAttributes({
        's3.response.final_size': finalSize,
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

      return {
        stream,
        size: finalSize,
        totalSize: (head.ContentLength ?? 0) - +(payloadDataStart ?? 0),
        verified: false,
        trusted: true, // we only cache trusted data
        sourceContentType,
        // From the item's signed tags: directly, or through Turbo's metadata,
        // which it derives from them.
        ...(sourceContentEncoding !== undefined
          ? { sourceContentEncoding, sourceContentEncodingFromTags: true }
          : {}),
        cached: false,
        requestAttributes: requestAttributesHeaders?.attributes,
      };
    } catch (error: any) {
      // Don't record AbortError as exception
      if (error.name === 'AbortError') {
        span.addEvent('Request aborted', {
          'data.retrieval.error': 'client_disconnected',
        });
        throw error;
      }

      // A 404 means the object simply isn't in the bucket. S3 is typically
      // first in ON_DEMAND_RETRIEVAL_ORDER, so most requests probe it for data
      // that was never uploaded via Turbo -- an expected miss, not a failure.
      // Counting these as errors buries genuine S3 faults (403/5xx) in noise
      // and skews the retrieval error ratio operators grade source health on.
      // Still rethrow: SequentialDataSource advances the cascade on exceptions.
      if (error.statusCode === 404) {
        span.addEvent('S3 object not found');
        log.debug('Contiguous data not found in S3', { id });
        throw error;
      }

      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });

      metrics.getDataErrorsTotal.inc({
        class: this.constructor.name,
        source: 's3',
      });
      log.error('Failed to fetch contiguous data from S3', {
        id,
        statusCode: error.statusCode,
        message: error.message,
        stack: error.stack,
      });
      throw error;
    } finally {
      span.end();
    }
  }
}
