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
import assert from 'node:assert';
import { describe, it, beforeEach, after, mock } from 'node:test';
import fs from 'node:fs';
import winston from 'winston';
import { AwsLiteS3 } from '@aws-lite/s3-types';
import { S3DataStore } from './s3-data-store.js';
import { StreamingBlobPayloadOutputTypes } from '@smithy/types';
import { Readable } from 'node:stream';

describe('S3DataStore', () => {
  let s3DataStore: S3DataStore;
  let mockS3Client: AwsLiteS3;
  const testBucket = 'test-bucket';
  const testPrefix = 'test-prefix';
  const testBaseDir = '/tmp/test';
  const testHash = 'abc123';

  const logger = winston.createLogger({
    transports: [new winston.transports.Console({ silent: true })],
  });

  beforeEach(async () => {
    mockS3Client = {
      HeadObject: mock.fn(),
      GetObject: mock.fn(),
      PutObject: mock.fn(),
      CreateMultipartUpload: mock.fn(),
      UploadPart: mock.fn(),
      CompleteMultipartUpload: mock.fn(),
      AbortMultipartUpload: mock.fn(),
    } as unknown as AwsLiteS3;

    s3DataStore = new S3DataStore({
      log: logger,
      baseDir: testBaseDir,
      s3Client: mockS3Client,
      s3Prefix: testPrefix,
      s3Bucket: testBucket,
    });

    // Ensure test directory exists
    await fs.promises.mkdir(`${testBaseDir}/tmp`, { recursive: true });
  });

  after(async () => {
    try {
      await fs.promises.rm(testBaseDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('has', () => {
    it('should return true when object exists', async () => {
      mockS3Client.HeadObject = mock.fn(() =>
        Promise.resolve({
          $metadata: {
            httpStatusCode: 200,
            requestId: 'test-request-id',
            attempts: 1,
            totalRetryDelay: 0,
          },
        }),
      );

      const result = await s3DataStore.has(testHash);
      assert.strictEqual(result, true);
      assert.strictEqual((mockS3Client.HeadObject as any).mock.calls.length, 1);
    });

    it('should return false when object does not exist', async () => {
      mockS3Client.HeadObject = mock.fn(() =>
        Promise.reject({
          name: 'NotFound',
          $metadata: { httpStatusCode: 404 },
        }),
      );

      const result = await s3DataStore.has(testHash);
      assert.strictEqual(result, false);
      assert.strictEqual((mockS3Client.HeadObject as any).mock.calls.length, 1);
    });
  });

  describe('get', () => {
    it('should return readable stream when object exists', async () => {
      const mockStream = new Readable({
        read() {
          this.push(null);
        },
      });

      mockS3Client.GetObject = mock.fn(() =>
        Promise.resolve({
          $metadata: { httpStatusCode: 200 },
          Body: mockStream as StreamingBlobPayloadOutputTypes,
          ContentLength: 100,
        }),
      );

      const result = await s3DataStore.get(testHash);
      assert.ok(result instanceof Readable);
      assert.strictEqual((mockS3Client.GetObject as any).mock.calls.length, 1);
    });

    it('should handle range requests', async () => {
      const mockStream = new Readable({
        read() {
          this.push(null);
        },
      });

      mockS3Client.GetObject = mock.fn(() =>
        Promise.resolve({
          $metadata: { httpStatusCode: 206 },
          Body: mockStream as StreamingBlobPayloadOutputTypes,
          ContentLength: 50,
        }),
      );

      const region = { offset: 0, size: 50 };
      const result = await s3DataStore.get(testHash, region);

      assert.ok(result instanceof Readable);
      assert.strictEqual((mockS3Client.GetObject as any).mock.calls.length, 1);
      const callArgs = (mockS3Client.GetObject as any).mock.calls[0]
        .arguments[0];
      assert.strictEqual(callArgs.Range, 'bytes=0-49');
    });
  });

  describe('createWriteStream', () => {
    it('should create a write stream', async () => {
      const stream = await s3DataStore.createWriteStream();
      assert.ok(stream instanceof fs.WriteStream);

      const pathString = stream.path.toString();
      assert.ok(pathString.startsWith(testBaseDir));
    });
  });

  describe('finalize', () => {
    it('should upload small files directly', async () => {
      const tempPath = `${testBaseDir}/tmp/test-file`;
      await fs.promises.writeFile(tempPath, 'test content');

      const writeStream = fs.createWriteStream(tempPath);
      mockS3Client.PutObject = mock.fn(() =>
        Promise.resolve({
          $metadata: { httpStatusCode: 200 },
          ETag: '"test-etag"',
        }),
      );

      await s3DataStore.finalize(writeStream, testHash);

      assert.strictEqual((mockS3Client.PutObject as any).mock.calls.length, 1);
      const putObjectCall = (mockS3Client.PutObject as any).mock.calls[0]
        .arguments[0];
      assert.strictEqual(putObjectCall.Bucket, testBucket);
      assert.strictEqual(
        putObjectCall.Key,
        `${testPrefix}/data/${testHash.substring(0, 2)}/${testHash.substring(2, 4)}/${testHash}`,
      );

      try {
        await fs.promises.unlink(tempPath);
      } catch (error) {
        // Ignore cleanup errors
      }
    });

    it('should handle multipart uploads for large files', async () => {
      const tempPath = `${testBaseDir}/tmp/large-file`;
      const largeContent = Buffer.alloc(1024 * 1024 * 6); // 6MB
      const writeStream = fs.createWriteStream(tempPath);

      await new Promise((resolve, reject) => {
        writeStream.write(largeContent, (err) => {
          if (err) reject(err);
          writeStream.end(resolve);
        });
      });

      mockS3Client.CreateMultipartUpload = mock.fn(() =>
        Promise.resolve({
          $metadata: { httpStatusCode: 200 },
          UploadId: 'test-upload-id',
        }),
      );

      mockS3Client.UploadPart = mock.fn(() =>
        Promise.resolve({
          $metadata: { httpStatusCode: 200 },
          ETag: '"test-etag"',
        }),
      );

      mockS3Client.CompleteMultipartUpload = mock.fn(() =>
        Promise.resolve({
          $metadata: { httpStatusCode: 200 },
          Location: 'test-location',
          ETag: '"final-etag"',
        }),
      );

      await s3DataStore.finalize(writeStream, testHash);

      assert.strictEqual(
        (mockS3Client.CreateMultipartUpload as any).mock.calls.length,
        1,
      );
      const createCall = (mockS3Client.CreateMultipartUpload as any).mock
        .calls[0].arguments[0];
      assert.strictEqual(createCall.Bucket, testBucket);
      assert.strictEqual(
        createCall.Key,
        `${testPrefix}/data/${testHash.substring(0, 2)}/${testHash.substring(
          2,
          4,
        )}/${testHash}`,
      );

      assert.strictEqual((mockS3Client.UploadPart as any).mock.calls.length, 2);
      assert.strictEqual(
        (mockS3Client.CompleteMultipartUpload as any).mock.calls.length,
        1,
      );
      const completeCall = (mockS3Client.CompleteMultipartUpload as any).mock
        .calls[0].arguments[0];
      assert.strictEqual(completeCall.UploadId, 'test-upload-id');
      assert.strictEqual(completeCall.MultipartUpload.Parts.length, 2);

      await assert.rejects(fs.promises.access(tempPath), /ENOENT/);
    });

    it('should abort multipart upload on failure', async () => {
      const tempPath = `${testBaseDir}/tmp/large-file`;
      const largeContent = Buffer.alloc(1024 * 1024 * 6); // 6MB
      const writeStream = fs.createWriteStream(tempPath);

      await new Promise((resolve, reject) => {
        writeStream.write(largeContent, (err) => {
          if (err) reject(err);
          writeStream.end(resolve);
        });
      });

      mockS3Client.CreateMultipartUpload = mock.fn(() =>
        Promise.resolve({
          $metadata: { httpStatusCode: 200 },
          UploadId: 'test-upload-id',
        }),
      );

      mockS3Client.UploadPart = mock.fn(() =>
        Promise.reject(new Error('Upload part failed')),
      );

      mockS3Client.AbortMultipartUpload = mock.fn(() =>
        Promise.resolve({
          $metadata: { httpStatusCode: 204 },
        }),
      );

      await assert.rejects(
        () => s3DataStore.finalize(writeStream, testHash),
        /Upload part failed/,
      );

      assert.strictEqual(
        (mockS3Client.AbortMultipartUpload as any).mock.calls.length,
        1,
      );
      const abortCall = (mockS3Client.AbortMultipartUpload as any).mock.calls[0]
        .arguments[0];
      assert.strictEqual(abortCall.UploadId, 'test-upload-id');

      await assert.rejects(fs.promises.access(tempPath), /ENOENT/);
    });

    it('should throw error for empty files', async () => {
      const tempPath = `${testBaseDir}/tmp/empty-file`;
      await fs.promises.writeFile(tempPath, '');
      const writeStream = fs.createWriteStream(tempPath);

      await assert.rejects(
        () => s3DataStore.finalize(writeStream, testHash),
        /Cannot upload empty file/,
      );

      try {
        await fs.promises.unlink(tempPath);
      } catch (error) {
        // Ignore cleanup errors
      }
    });

    it('should handle PutObject errors', async () => {
      const tempPath = `${testBaseDir}/tmp/test-file`;
      await fs.promises.writeFile(tempPath, 'test content');
      const writeStream = fs.createWriteStream(tempPath);

      mockS3Client.PutObject = mock.fn(() =>
        Promise.reject(new Error('Failed to upload')),
      );

      await assert.rejects(
        () => s3DataStore.finalize(writeStream, testHash),
        /Failed to upload/,
      );

      await assert.rejects(fs.promises.access(tempPath), /ENOENT/);
    });
  });

  describe('cleanup', () => {
    it('should cleanup temporary files', async () => {
      const tempPath = `${testBaseDir}/tmp/cleanup-test`;
      await fs.promises.writeFile(tempPath, 'test content');
      const writeStream = fs.createWriteStream(tempPath);

      await s3DataStore.cleanup(writeStream);

      await assert.rejects(fs.promises.access(tempPath), /ENOENT/);
    });

    it('should handle cleanup errors gracefully', async () => {
      const nonexistentPath = '/nonexistent/path';
      const writeStream = fs.createWriteStream(nonexistentPath);

      writeStream.on('error', () => {
        // Ignore the expected ENOENT error
      });

      await s3DataStore.cleanup(writeStream);
    });
  });
});
