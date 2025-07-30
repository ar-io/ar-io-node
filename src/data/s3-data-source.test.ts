/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { Readable } from 'node:stream';
import * as winston from 'winston';
import { AwsLiteS3 } from '@aws-lite/s3-types';
import { AwsLiteClient } from '@aws-lite/client';

import { S3DataSource } from './s3-data-source.js';
import * as metrics from '../metrics.js';
import { TestDestroyedReadable } from './test-utils.js';

let log: winston.Logger;
let s3DataSource: S3DataSource;
let mockS3Client: AwsLiteS3;
let mockAwsClient: AwsLiteClient;

const testBucket = 'test-bucket';
const testPrefix = 'test-prefix';
const testId = 'test-data-id';

before(async () => {
  log = winston.createLogger({ silent: true });
});

beforeEach(async () => {
  mockS3Client = {
    GetObject: mock.fn(async () => ({
      Body: Readable.from(['test data']) as any,
      ContentLength: 9,
      ContentType: 'application/octet-stream',
      ContentRange: undefined,
      $metadata: {},
    })),
  } as any;

  mockAwsClient = {
    S3: {
      HeadObject: mock.fn(async () => ({
        ContentLength: 9,
        ContentType: 'application/octet-stream',
        Metadata: {},
        $metadata: {},
      })),
    },
  } as any;

  mock.method(metrics.getDataErrorsTotal, 'inc');
  mock.method(metrics.getDataStreamErrorsTotal, 'inc');
  mock.method(metrics.getDataStreamSuccessesTotal, 'inc');

  s3DataSource = new S3DataSource({
    log,
    s3Client: mockS3Client,
    s3Bucket: testBucket,
    s3Prefix: testPrefix,
    awsClient: mockAwsClient,
  });
});

afterEach(async () => {
  mock.restoreAll();
});

describe('S3DataSource', () => {
  describe('constructor', () => {
    it('should use empty string as default prefix', async () => {
      const dataSource = new S3DataSource({
        log,
        s3Client: mockS3Client,
        s3Bucket: testBucket,
        awsClient: mockAwsClient,
      });

      // Call getData to verify the prefix is used correctly
      await dataSource.getData({ id: testId });

      // Verify that the S3 calls use the correct key format (no prefix)
      const headCall = (mockAwsClient.S3.HeadObject as any).mock.calls[0];
      assert.equal(headCall.arguments[0].Key, `/${testId}`); // Should be just the ID, no prefix

      const getCall = (mockS3Client.GetObject as any).mock.calls[0];
      assert.equal(getCall.arguments[0].Key, `/${testId}`); // Should be just the ID, no prefix
    });
  });

  describe('getData', () => {
    it('should fetch data successfully from S3', async () => {
      const mockStream = Readable.from(['test data']);
      mockS3Client.GetObject = mock.fn(async () => ({
        Body: mockStream as any,
        ContentLength: 9,
        ContentType: 'application/octet-stream',
        $metadata: {},
      }));

      const result = await s3DataSource.getData({ id: testId });

      assert.equal(result.stream, mockStream);
      assert.equal(result.size, 9);
      assert.equal(result.verified, false);
      assert.equal(result.trusted, true);
      assert.equal(result.sourceContentType, 'application/octet-stream');
      assert.equal(result.cached, false);

      assert.equal((mockAwsClient.S3.HeadObject as any).mock.callCount(), 1);
      assert.equal((mockS3Client.GetObject as any).mock.callCount(), 1);

      const headCall = (mockAwsClient.S3.HeadObject as any).mock.calls[0];
      assert.equal(headCall.arguments[0].Bucket, testBucket);
      assert.equal(headCall.arguments[0].Key, `${testPrefix}/${testId}`);

      const getCall = (mockS3Client.GetObject as any).mock.calls[0];
      assert.equal(getCall.arguments[0].Bucket, testBucket);
      assert.equal(getCall.arguments[0].Key, `${testPrefix}/${testId}`);
    });

    it('should handle zero-byte data items', async () => {
      mockAwsClient.S3.HeadObject = mock.fn(async () => ({
        ContentLength: 100,
        ContentType: 'application/octet-stream',
        Metadata: {
          'payload-data-start': '100',
          'payload-content-type': 'text/plain',
        },
        $metadata: {},
      }));

      const result = await s3DataSource.getData({ id: testId });

      assert.ok(result.stream instanceof Readable);
      assert.equal(result.size, 0);
      assert.equal(result.verified, false);
      assert.equal(result.trusted, true);
      assert.equal(result.sourceContentType, 'text/plain');
      assert.equal(result.cached, false);

      assert.equal((mockAwsClient.S3.HeadObject as any).mock.callCount(), 1);
      assert.equal((mockS3Client.GetObject as any).mock.callCount(), 0);

      let receivedData = '';
      for await (const chunk of result.stream) {
        receivedData += chunk;
      }
      assert.equal(receivedData, '');
    });

    it('should handle region offset and size', async () => {
      const region = { offset: 10, size: 20 };
      mockAwsClient.S3.HeadObject = mock.fn(async () => ({
        ContentLength: 100,
        ContentType: 'application/octet-stream',
        Metadata: {
          'payload-data-start': '50',
        },
        $metadata: {},
      }));

      const mockStream = Readable.from(['partial data']);
      mockS3Client.GetObject = mock.fn(async () => ({
        Body: mockStream as any,
        ContentLength: 20,
        ContentType: 'application/octet-stream',
        ContentRange: 'bytes 60-79/100',
        $metadata: {},
      }));

      const result = await s3DataSource.getData({
        id: testId,
        region,
      });

      assert.equal(result.stream, mockStream);
      assert.equal(result.size, 20);

      const getCall = (mockS3Client.GetObject as any).mock.calls[0];
      assert.equal(getCall.arguments[0].Range, 'bytes=60-79');
    });

    it('should handle region that spans to end of data', async () => {
      const region = { offset: 10, size: 90 };
      mockAwsClient.S3.HeadObject = mock.fn(async () => ({
        ContentLength: 100,
        ContentType: 'application/octet-stream',
        Metadata: {},
        $metadata: {},
      }));

      const mockStream = Readable.from(['data from offset to end']);
      mockS3Client.GetObject = mock.fn(async () => ({
        Body: mockStream as any,
        ContentLength: 90,
        ContentType: 'application/octet-stream',
        $metadata: {},
      }));

      await s3DataSource.getData({
        id: testId,
        region,
      });

      const getCall = (mockS3Client.GetObject as any).mock.calls[0];
      assert.equal(getCall.arguments[0].Range, 'bytes=10-99');
    });

    it('should handle invalid range requests', async () => {
      mockAwsClient.S3.HeadObject = mock.fn(async () => ({
        ContentLength: 100,
        ContentType: 'application/octet-stream',
        Metadata: {},
        $metadata: {},
      }));

      // Test region that extends beyond file size
      const invalidRegion = { offset: 50, size: 100 }; // Would request bytes 50-149 but file is only 100 bytes

      mockS3Client.GetObject = mock.fn(async () => {
        const error = new Error('The requested range is not satisfiable');
        (error as any).statusCode = 416;
        throw error;
      });

      await assert.rejects(
        s3DataSource.getData({
          id: testId,
          region: invalidRegion,
        }),
        /The requested range is not satisfiable/,
      );

      const getCall = (mockS3Client.GetObject as any).mock.calls[0];
      // Should still attempt the range request
      assert.equal(getCall.arguments[0].Range, 'bytes=50-149');

      // Should increment error metrics
      assert.equal((metrics.getDataErrorsTotal.inc as any).mock.callCount(), 1);
    });

    it('should use payload content type from metadata when available', async () => {
      mockAwsClient.S3.HeadObject = mock.fn(async () => ({
        ContentLength: 50,
        ContentType: 'application/octet-stream',
        Metadata: {
          'payload-content-type': 'image/png',
        },
        $metadata: {},
      }));

      const mockStream = Readable.from(['image data']);
      mockS3Client.GetObject = mock.fn(async () => ({
        Body: mockStream as any,
        ContentLength: 50,
        ContentType: 'application/octet-stream',
        $metadata: {},
      }));

      const result = await s3DataSource.getData({ id: testId });

      assert.equal(result.sourceContentType, 'image/png');
    });

    it('should fall back to response content type when payload content type is not available', async () => {
      mockAwsClient.S3.HeadObject = mock.fn(async () => ({
        ContentLength: 50,
        ContentType: 'application/octet-stream',
        Metadata: {},
        $metadata: {},
      }));

      const mockStream = Readable.from(['data']);
      mockS3Client.GetObject = mock.fn(async () => ({
        Body: mockStream as any,
        ContentLength: 50,
        ContentType: 'text/html',
        $metadata: {},
      }));

      const result = await s3DataSource.getData({ id: testId });

      assert.equal(result.sourceContentType, 'text/html');
    });

    it('should calculate size from content range when available', async () => {
      mockAwsClient.S3.HeadObject = mock.fn(async () => ({
        ContentLength: 100,
        ContentType: 'application/octet-stream',
        Metadata: {},
        $metadata: {},
      }));

      const mockStream = Readable.from(['partial data']);
      mockS3Client.GetObject = mock.fn(async () => ({
        Body: mockStream as any,
        ContentLength: 12345, // Nonsensical, but provided to show that ContentRange is used
        ContentType: 'application/octet-stream',
        ContentRange: 'bytes 10-39/100',
        $metadata: {},
      }));

      const result = await s3DataSource.getData({
        id: testId,
        region: { offset: 10, size: 30 },
      });

      assert.equal(result.size, 30);
    });

    it('should throw error and increment metric when ContentLength is missing', async () => {
      mockS3Client.GetObject = mock.fn(async () => ({
        Body: Readable.from(['data']) as any,
        ContentType: 'application/octet-stream',
        $metadata: {},
      }));

      await assert.rejects(
        s3DataSource.getData({ id: testId }),
        /Content-Length header missing from S3 response/,
      );

      assert.equal((metrics.getDataErrorsTotal.inc as any).mock.callCount(), 1);
    });

    it('should throw error and increment metric when Body is missing', async () => {
      mockS3Client.GetObject = mock.fn(async () => ({
        ContentLength: 10,
        ContentType: 'application/octet-stream',
        $metadata: {},
      }));

      await assert.rejects(
        s3DataSource.getData({ id: testId }),
        /Body missing from S3 response/,
      );

      assert.equal((metrics.getDataErrorsTotal.inc as any).mock.callCount(), 1);
    });

    it('should handle S3 errors and increment error metrics', async () => {
      mockAwsClient.S3.HeadObject = mock.fn(async () => {
        throw new Error('S3 HeadObject failed');
      });

      await assert.rejects(
        s3DataSource.getData({ id: testId }),
        /S3 HeadObject failed/,
      );

      assert.equal((metrics.getDataErrorsTotal.inc as any).mock.callCount(), 1);
      const errorCall = (metrics.getDataErrorsTotal.inc as any).mock.calls[0];
      assert.equal(errorCall.arguments[0].class, 'S3DataSource');
      assert.equal(errorCall.arguments[0].source, 's3');
    });

    it('should increment stream success metrics when stream ends', async () => {
      const mockStream = Readable.from(['test data']);
      mockS3Client.GetObject = mock.fn(async () => ({
        Body: mockStream as any,
        ContentLength: 9,
        ContentType: 'application/octet-stream',
        $metadata: {},
      }));

      const result = await s3DataSource.getData({ id: testId });

      let receivedData = '';
      for await (const chunk of result.stream) {
        receivedData += chunk;
      }

      assert.equal(receivedData, 'test data');
      assert.equal(
        (metrics.getDataStreamSuccessesTotal.inc as any).mock.callCount(),
        1,
      );
      const successCall = (metrics.getDataStreamSuccessesTotal.inc as any).mock
        .calls[0];
      assert.equal(successCall.arguments[0].class, 'S3DataSource');
      assert.equal(successCall.arguments[0].source, 's3');
    });

    it('should increment stream error metrics when stream errors', async () => {
      const mockStream = new TestDestroyedReadable();
      mockS3Client.GetObject = mock.fn(async () => ({
        Body: mockStream as any,
        ContentLength: 9,
        ContentType: 'application/octet-stream',
        $metadata: {},
      }));

      const result = await s3DataSource.getData({ id: testId });

      try {
        let receivedData = '';
        for await (const chunk of result.stream) {
          receivedData += chunk;
        }
      } catch (error: any) {
        assert.equal(error.message, 'Stream destroyed intentionally');
        assert.equal(
          (metrics.getDataStreamErrorsTotal.inc as any).mock.callCount(),
          1,
        );
        const errorCall = (metrics.getDataStreamErrorsTotal.inc as any).mock
          .calls[0];
        assert.equal(errorCall.arguments[0].class, 'S3DataSource');
        assert.equal(errorCall.arguments[0].source, 's3');
      }
    });

    it('should pass request attributes correctly', async () => {
      const mockStream = Readable.from(['test data']);
      mockS3Client.GetObject = mock.fn(async () => ({
        Body: mockStream as any,
        ContentLength: 9,
        ContentType: 'application/octet-stream',
        $metadata: {},
      }));

      const result = await s3DataSource.getData({
        id: testId,
        requestAttributes: { hops: 2, origin: 'test-origin' },
      });

      assert.deepEqual(result.requestAttributes, {
        hops: 3,
        origin: 'test-origin',
      });
    });

    it('should handle empty request attributes', async () => {
      const mockStream = Readable.from(['test data']);
      mockS3Client.GetObject = mock.fn(async () => ({
        Body: mockStream as any,
        ContentLength: 9,
        ContentType: 'application/octet-stream',
        $metadata: {},
      }));

      const result = await s3DataSource.getData({ id: testId });

      assert.equal(result.requestAttributes, undefined);
    });
  });
});
