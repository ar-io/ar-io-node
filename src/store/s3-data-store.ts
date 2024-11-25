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
import { AwsLiteS3 } from '@aws-lite/s3-types';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import winston from 'winston';

import { ContiguousDataStore } from '../types.js';

const MIN_PART_SIZE = 1024 * 1024 * 5; // 5MB

export class S3DataStore implements ContiguousDataStore {
  private log: winston.Logger;
  private baseDir: string;
  private s3Client: AwsLiteS3;
  private s3Prefix: string;
  private s3Bucket: string;

  constructor({
    log,
    baseDir,
    s3Client,
    s3Prefix = '',
    s3Bucket,
  }: {
    log: winston.Logger;
    baseDir: string;
    s3Client: AwsLiteS3;
    s3Prefix?: string;
    s3Bucket: string;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.baseDir = baseDir;
    this.s3Client = s3Client;
    this.s3Prefix = s3Prefix;
    this.s3Bucket = s3Bucket;
  }

  private getHashPrefix(hash: string) {
    return `${hash.substring(0, 2)}/${hash.substring(2, 4)}`;
  }

  private s3Key(hash: string) {
    const hashPath = `data/${this.getHashPrefix(hash)}/${hash}`;
    return this.s3Prefix ? `${this.s3Prefix}/${hashPath}` : hashPath;
  }

  private tempDir() {
    return `${this.baseDir}/tmp`;
  }

  private createTempPath() {
    return `${this.tempDir()}/${crypto.randomBytes(16).toString('hex')}`;
  }

  async has(hash: string) {
    const log = this.log.child({ method: 'has' });
    const key = this.s3Key(hash);

    try {
      await this.s3Client.HeadObject({
        Bucket: this.s3Bucket,
        Key: this.s3Key(hash),
      });

      log.debug('Object found in S3', {
        hash,
        bucket: this.s3Bucket,
        key,
      });

      return true;
    } catch (error: any) {
      if (
        error.name === 'NotFound' ||
        error.$metadata?.httpStatusCode === 404
      ) {
        log.debug('Object not found in S3', {
          hash,
          bucket: this.s3Bucket,
          key,
        });
        return false;
      }

      log.error('Error checking object existence in S3', {
        hash,
        bucket: this.s3Bucket,
        key,
        error: error.message,
        errorName: error.name,
        statusCode: error.$metadata?.httpStatusCode,
      });

      return false;
    }
  }

  async get(
    hash: string,
    region?: {
      offset: number;
      size: number;
    },
  ): Promise<Readable | undefined> {
    const log = this.log.child({ method: 'get' });
    const key = this.s3Key(hash);

    try {
      const params: {
        Bucket: string;
        Key: string;
        streamResponsePayload: boolean;
        Range?: string;
      } = {
        Bucket: this.s3Bucket,
        Key: key,
        streamResponsePayload: true,
      };

      if (region) {
        params.Range = `bytes=${region.offset}-${region.offset + region.size - 1}`;
      }

      const response = await this.s3Client.GetObject(params);

      if (response.Body) {
        log.debug('Successfully retrieved object from S3', {
          hash,
          bucket: this.s3Bucket,
          key,
          contentLength: response.ContentLength,
          ...region,
        });

        return response.Body as Readable;
      }

      log.warn('S3 object body is empty', {
        hash,
        bucket: this.s3Bucket,
        key,
        ...region,
      });

      return undefined;
    } catch (error: any) {
      log.error('Failed to get object from S3', {
        hash,
        bucket: this.s3Bucket,
        key,
        ...region,
        error: error.message,
        errorName: error.name,
        statusCode: error.$metadata?.httpStatusCode,
      });

      return undefined;
    }
  }

  async createWriteStream() {
    const tempPath = this.createTempPath();
    await fs.promises.mkdir(this.tempDir(), { recursive: true });
    const file = fs.createWriteStream(tempPath);
    return file;
  }

  async cleanup(stream: fs.WriteStream) {
    try {
      if (!stream.destroyed) {
        await new Promise((resolve) => {
          stream.end(resolve);
        });
      }

      if (typeof stream.path === 'string' && stream.path.length > 0) {
        await fs.promises.unlink(stream.path);
      }
    } catch (error: any) {
      this.log.error('Failed to cleanup contigous data stream', {
        message: error.message,
        stack: error.stack,
      });
    }
  }

  async finalize(stream: fs.WriteStream, hash: string) {
    const log = this.log.child({ method: 'finalize' });
    const key = this.s3Key(hash);

    log.debug('Finalizing data stream to S3', {
      hash,
      bucket: this.s3Bucket,
      key,
      tempPath: stream.path,
    });

    let uploadId: string | undefined;

    try {
      stream.end();

      const fileStats = await fs.promises.stat(stream.path);
      const fileSize = fileStats.size;

      if (fileSize === 0) {
        throw new Error('Cannot upload empty file');
      }

      if (fileSize < MIN_PART_SIZE) {
        const fileContent = await fs.promises.readFile(stream.path);
        await this.s3Client.PutObject({
          Bucket: this.s3Bucket,
          Key: key,
          Body: fileContent,
        });

        log.debug('Successfully uploaded small file to S3', {
          hash,
          bucket: this.s3Bucket,
          key,
          size: fileSize,
        });

        await fs.promises.unlink(stream.path);
        return;
      }

      const createUploadResponse = await this.s3Client.CreateMultipartUpload({
        Bucket: this.s3Bucket,
        Key: key,
      });

      if (createUploadResponse.UploadId === undefined) {
        throw new Error('Failed to get upload ID from CreateMultipartUpload');
      }

      uploadId = createUploadResponse.UploadId;

      const parts: { PartNumber: number; ETag: string }[] = [];
      const partSize = MIN_PART_SIZE;
      const numParts = Math.ceil(fileSize / partSize);

      const fileHandle = await fs.promises.open(stream.path, 'r');
      try {
        for (let partNumber = 1; partNumber <= numParts; partNumber++) {
          const start = (partNumber - 1) * partSize;
          const end = Math.min(partNumber * partSize, fileSize);
          const currentPartSize = end - start;
          const buffer = Buffer.alloc(currentPartSize);

          const { bytesRead } = await fileHandle.read(
            buffer,
            0,
            currentPartSize,
            start,
          );

          if (bytesRead !== currentPartSize) {
            throw new Error(
              `Failed to read part ${partNumber}: expected ${currentPartSize} bytes but got ${bytesRead}`,
            );
          }

          const response = await this.s3Client.UploadPart({
            Bucket: this.s3Bucket,
            Key: `${key}?partNumber=${partNumber}&uploadId=${uploadId}`,
            Body: buffer,
          });

          if (response.ETag === undefined || response.ETag.trim() === '') {
            throw new Error(`Failed to get valid ETag for part ${partNumber}`);
          }

          parts.push({ PartNumber: partNumber, ETag: response.ETag });
        }

        await this.s3Client.CompleteMultipartUpload({
          Bucket: this.s3Bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts },
        });

        log.debug('Successfully completed multipart upload to S3', {
          hash,
          bucket: this.s3Bucket,
          key,
          size: fileSize,
          parts: parts.length,
        });
      } finally {
        await fileHandle.close();
      }

      await fs.promises.unlink(stream.path);
    } catch (error: any) {
      log.error('Failed to finalize data stream to S3', {
        hash,
        bucket: this.s3Bucket,
        key,
        tempPath: stream.path,
        error: error.message,
        errorName: error.name,
        statusCode: error.$metadata?.httpStatusCode,
      });

      if (uploadId !== undefined) {
        try {
          await this.s3Client.AbortMultipartUpload({
            Bucket: this.s3Bucket,
            Key: key,
            UploadId: uploadId,
          });
          log.debug('Aborted multipart upload after error', {
            uploadId,
            key,
          });
        } catch (abortError: any) {
          log.error('Failed to abort multipart upload', {
            uploadId,
            key,
            error: abortError.message,
          });
        }
      }

      try {
        await fs.promises.unlink(stream.path);
        log.debug('Cleaned up temporary file after error', {
          tempPath: stream.path,
        });
      } catch (cleanupError: any) {
        log.error('Failed to cleanup temporary file after error', {
          tempPath: stream.path,
          error: cleanupError.message,
        });
      }

      throw error;
    }
  }
}
