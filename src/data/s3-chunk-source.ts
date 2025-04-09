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
    const key = `${this.s3Prefix}/${dataRoot}/${relativeOffset}`;
    this.log.debug('Fetching chunk from S3', {
      bucket: this.s3Bucket,
      key,
    });

    const response = await this.s3Client.GetObject({
      Bucket: this.s3Bucket,
      Key: key,
    });

    if (!response.Body) {
      throw new Error(`Failed to fetch chunk data from S3: ${key}`);
    }
    const chunk = Buffer.from(await response.Body.transformToByteArray());

    const hash = crypto.createHash('sha256').update(chunk).digest();

    return {
      hash, // Buffer containing the SHA-256 digest
      chunk, // Buffer of the actual chunk data
    };
  }
}
