/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import winston from 'winston';
import crypto from 'node:crypto';
import { AwsLiteS3 } from '@aws-lite/s3-types';
import { tracer } from '../tracing.js';

import {
  ChunkData,
  ChunkDataByAnySource,
  ChunkDataByAnySourceParams,
} from '../types.js';

export class S3ChunkSource implements ChunkDataByAnySource {
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
    this.log = log.child({ class: this.constructor.name });
    this.s3Client = s3Client;
    this.s3Bucket = s3Bucket;
    this.s3Prefix = s3Prefix;
  }

  async getChunkDataByAny({
    dataRoot,
    relativeOffset,
  }: ChunkDataByAnySourceParams): Promise<ChunkData> {
    const span = tracer.startSpan('S3ChunkSource.getChunkDataByAny', {
      attributes: {
        'chunk.data_root': dataRoot,
        'chunk.relative_offset': relativeOffset,
        's3.bucket': this.s3Bucket,
        's3.prefix': this.s3Prefix,
      },
    });

    try {
      if (dataRoot === undefined || relativeOffset == null) {
        const error = new Error(
          'S3ChunkSource.getChunkDataByAny called without dataRoot or relativeOffset',
        );
        span.recordException(error);
        throw error;
      }

      const key = this.s3Prefix
        ? `${this.s3Prefix}/${dataRoot}/${relativeOffset}`
        : `${dataRoot}/${relativeOffset}`;

      span.setAttribute('s3.key', key);
      span.addEvent('Fetching from S3');

      this.log.debug('Fetching chunk from S3', {
        bucket: this.s3Bucket,
        key,
      });

      const startTime = Date.now();
      const response = await this.s3Client.GetObject({
        Bucket: this.s3Bucket,
        Key: key,
        rawResponsePayload: true,
        streamResponsePayload: false,
      });
      const fetchDuration = Date.now() - startTime;

      if (!response.Body || !Buffer.isBuffer(response.Body)) {
        const error = new Error(`Failed to fetch chunk data from S3: ${key}`);
        span.recordException(error);
        throw error;
      }

      // with rawResponsePayload: true, the Body is a Buffer
      const chunk = response.Body as unknown as Buffer;
      const hash = crypto.createHash('sha256').update(chunk).digest();

      span.setAttributes({
        'chunk.size': chunk.length,
        's3.fetch_duration_ms': fetchDuration,
        'chunk.source': 'legacy-s3',
      });

      span.addEvent('S3 fetch successful', {
        chunk_size: chunk.length,
        fetch_duration_ms: fetchDuration,
      });

      return {
        hash, // Buffer containing the SHA-256 digest
        chunk, // Buffer of the actual chunk data
        source: 'legacy-s3',
        // No sourceHost for S3 since it's internal storage
      };
    } catch (error: any) {
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  }
}
