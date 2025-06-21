/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import winston from 'winston';
import crypto from 'node:crypto';
import { AwsLiteS3 } from '@aws-lite/s3-types';

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
    if (!dataRoot || relativeOffset == null) {
      throw new Error(
        'S3ChunkSource.getChunkDataByAny called without dataRoot or relativeOffset',
      );
    }
    const key = this.s3Prefix
      ? `${this.s3Prefix}/${dataRoot}/${relativeOffset}`
      : `${dataRoot}/${relativeOffset}`;

    this.log.debug('Fetching chunk from S3', {
      bucket: this.s3Bucket,
      key,
    });

    const response = await this.s3Client.GetObject({
      Bucket: this.s3Bucket,
      Key: key,
      rawResponsePayload: true,
      streamResponsePayload: false,
    });

    if (!response.Body || !Buffer.isBuffer(response.Body)) {
      throw new Error(`Failed to fetch chunk data from S3: ${key}`);
    }

    // with rawResponsePayload: true, the Body is a Buffer
    const chunk = response.Body as unknown as Buffer;
    const hash = crypto.createHash('sha256').update(chunk).digest();

    return {
      hash, // Buffer containing the SHA-256 digest
      chunk, // Buffer of the actual chunk data
    };
  }
}
