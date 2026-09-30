/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { AwsLiteS3 } from '@aws-lite/s3-types';
import { SolanaSigner, createData } from '@dha-team/arbundles';
// @ts-expect-error bs58 v4 has no type declarations
import bs58 from 'bs58';
import { AwsLiteClient } from '@aws-lite/client';

import { S3DataSource, splitLeadingBytes } from './s3-data-source.js';
import * as metrics from '../metrics.js';
import { TestDestroyedReadable } from './test-utils.js';
import { createTestLogger } from '../../test/test-logger.js';

let log: ReturnType<typeof createTestLogger>;
let s3DataSource: S3DataSource;
let mockS3Client: AwsLiteS3;
let mockAwsClient: AwsLiteClient;

const testBucket = 'test-bucket';
const testPrefix = 'test-prefix';
const testId = 'test-data-id';

before(async () => {
  log = createTestLogger({ suite: 'S3DataSource' });
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

    it('should rethrow a 404 without counting it as a source error', async () => {
      // aws-lite cannot parse an error body from a HEAD 404, so the message is
      // uninformative; statusCode is the only reliable signal.
      const notFound: any = new Error(
        '@aws-lite/client: S3.HeadObject: unknown error',
      );
      notFound.statusCode = 404;
      mockAwsClient.S3.HeadObject = mock.fn(async () => {
        throw notFound;
      });

      // Must still throw, and throw *this* error: SequentialDataSource
      // advances the retrieval cascade on exceptions, so swallowing it would
      // strand the request here.
      await assert.rejects(
        s3DataSource.getData({ id: testId }),
        (err: any) => err === notFound && err.statusCode === 404,
      );

      // A miss is not a failure -- S3 is first in the retrieval order, so most
      // probes are for data that was never uploaded via Turbo.
      assert.equal((metrics.getDataErrorsTotal.inc as any).mock.callCount(), 0);
    });

    it('should count a non-404 S3 failure as a source error', async () => {
      const denied: any = new Error('@aws-lite/client: S3.HeadObject: denied');
      denied.statusCode = 403;
      mockAwsClient.S3.HeadObject = mock.fn(async () => {
        throw denied;
      });

      await assert.rejects(
        s3DataSource.getData({ id: testId }),
        (err: any) => err === denied && err.statusCode === 403,
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

    describe('abort signal handling', () => {
      it('should throw immediately when signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();

        await assert.rejects(
          s3DataSource.getData({
            id: testId,
            signal: controller.signal,
          }),
          { name: 'AbortError' },
        );

        // Verify no S3 calls were made
        assert.equal((mockAwsClient.S3.HeadObject as any).mock.callCount(), 0);
        assert.equal((mockS3Client.GetObject as any).mock.callCount(), 0);
      });

      it('should throw when signal is aborted before GetObject', async () => {
        const controller = new AbortController();

        // HeadObject succeeds but aborts before GetObject
        mockAwsClient.S3.HeadObject = mock.fn(async () => {
          controller.abort();
          return {
            ContentLength: 9,
            ContentType: 'application/octet-stream',
            Metadata: {},
            $metadata: {},
          };
        });

        await assert.rejects(
          s3DataSource.getData({
            id: testId,
            signal: controller.signal,
          }),
          { name: 'AbortError' },
        );

        // HeadObject was called but GetObject should not have been
        assert.equal((mockAwsClient.S3.HeadObject as any).mock.callCount(), 1);
        assert.equal((mockS3Client.GetObject as any).mock.callCount(), 0);
      });
    });
  });

  // Turbo stores each item as its whole signed data item, with metadata
  // saying where the payload starts. An item uploaded compressed carries a
  // signed `Content-Encoding` tag; objects stored before Turbo recorded it as
  // metadata (`payload-content-encoding`) have only the tag, so a full read
  // starts at the header, in the same request, and reads it there.
  describe('Content-Encoding', () => {
    let signer: SolanaSigner;
    const html = Buffer.from(
      '<!doctype html><title>compressed on chain</title>',
    );
    const gzipped = gzipSync(html);

    before(() => {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const seed = privateKey
        .export({ format: 'der', type: 'pkcs8' })
        .subarray(-32);
      const pub = publicKey
        .export({ format: 'der', type: 'spki' })
        .subarray(-32);
      signer = new SolanaSigner(bs58.encode(Buffer.concat([seed, pub])));
    });

    const signedItem = async (
      payload: Buffer,
      tags: { name: string; value: string }[],
    ) => {
      const item = createData(payload, signer, { tags });
      await item.sign(signer);
      const raw = item.getRaw();
      return { id: item.id, raw, headerLength: raw.length - payload.length };
    };

    // Serves `raw` the way S3 does, honouring the Range header, optionally in
    // small chunks so the header is split across several of them.
    const storeObject = (
      raw: Buffer,
      metadata: Record<string, string>,
      chunkSize = 1 << 20,
    ) => {
      mockAwsClient.S3.HeadObject = mock.fn(async () => ({
        ContentLength: raw.length,
        ContentType: 'application/octet-stream',
        Metadata: metadata,
        $metadata: {},
      })) as any;
      mockS3Client.GetObject = mock.fn(async ({ Range }: any) => {
        const m = /^bytes=(\d+)-(\d*)$/.exec(Range ?? '');
        const start = m ? Number(m[1]) : 0;
        const end = m && m[2] !== '' ? Number(m[2]) : raw.length - 1;
        const body = raw.subarray(start, end + 1);
        const chunks: Buffer[] = [];
        for (let i = 0; i < body.length; i += chunkSize) {
          chunks.push(body.subarray(i, i + chunkSize));
        }
        return {
          Body: Readable.from(chunks) as any,
          ContentLength: body.length,
          ContentType: 'application/octet-stream',
          ContentRange: `bytes ${start}-${end}/${raw.length}`,
          $metadata: {},
        };
      }) as any;
    };
    const requestedRange = () =>
      (mockS3Client.GetObject as any).mock.calls[0].arguments[0].Range;
    const readAll = async (stream: NodeJS.ReadableStream) => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks);
    };

    it("reads the encoding from the item's signed header, in the same request", async () => {
      const item = await signedItem(gzipped, [
        { name: 'Content-Type', value: 'text/html' },
        { name: 'Content-Encoding', value: 'gzip' },
      ]);
      storeObject(item.raw, {
        'payload-data-start': String(item.headerLength),
        'payload-content-type': 'text/html',
      });

      const result = await s3DataSource.getData({ id: item.id });

      assert.deepEqual(await readAll(result.stream), gzipped);
      assert.equal(result.size, gzipped.length);
      assert.equal(result.totalSize, gzipped.length);
      assert.equal(result.sourceContentEncoding, 'gzip');
      assert.equal(result.sourceContentEncodingFromTags, true);
      assert.equal(requestedRange(), 'bytes=0-');
      assert.equal((mockS3Client.GetObject as any).mock.callCount(), 1);
    });

    it('splits the header off correctly when it arrives in small chunks', async () => {
      const item = await signedItem(gzipped, [
        { name: 'Content-Encoding', value: 'gzip' },
      ]);
      storeObject(
        item.raw,
        { 'payload-data-start': String(item.headerLength) },
        7,
      );

      const result = await s3DataSource.getData({ id: item.id });

      assert.deepEqual(await readAll(result.stream), gzipped);
      assert.equal(result.sourceContentEncoding, 'gzip');
    });

    it('reports no encoding for an untagged item and serves it as before', async () => {
      const item = await signedItem(html, [
        { name: 'Content-Type', value: 'text/html' },
      ]);
      storeObject(item.raw, {
        'payload-data-start': String(item.headerLength),
      });

      const result = await s3DataSource.getData({ id: item.id });

      assert.deepEqual(await readAll(result.stream), html);
      assert.equal(result.size, html.length);
      assert.equal(result.sourceContentEncoding, undefined);
      assert.equal(result.sourceContentEncodingFromTags, undefined);
    });

    it("uses Turbo's payload-content-encoding metadata without reading the header", async () => {
      const item = await signedItem(gzipped, [
        { name: 'Content-Encoding', value: 'gzip' },
      ]);
      storeObject(item.raw, {
        'payload-data-start': String(item.headerLength),
        'payload-content-encoding': 'GZIP',
      });

      const result = await s3DataSource.getData({ id: item.id });

      assert.deepEqual(await readAll(result.stream), gzipped);
      assert.equal(result.sourceContentEncoding, 'gzip');
      assert.equal(result.sourceContentEncodingFromTags, true);
      assert.equal(requestedRange(), `bytes=${item.headerLength}-`);
    });

    it("does not trust a header that is not the requested item's", async () => {
      const item = await signedItem(gzipped, [
        { name: 'Content-Encoding', value: 'gzip' },
      ]);
      storeObject(item.raw, {
        'payload-data-start': String(item.headerLength),
      });

      const result = await s3DataSource.getData({ id: 'another-item-id' });

      assert.deepEqual(await readAll(result.stream), gzipped);
      assert.equal(result.sourceContentEncoding, undefined);
    });

    it('does not trust a header that ends before the recorded payload start', async () => {
      const item = await signedItem(gzipped, [
        { name: 'Content-Encoding', value: 'gzip' },
      ]);
      // Metadata says the payload starts one byte later than it does.
      storeObject(item.raw, {
        'payload-data-start': String(item.headerLength + 1),
      });

      const result = await s3DataSource.getData({ id: item.id });

      assert.equal(result.sourceContentEncoding, undefined);
      assert.deepEqual(
        await readAll(result.stream),
        gzipped.subarray(1),
        'served from where the metadata says, as before',
      );
    });

    it('reads a range straight from the payload, without the header', async () => {
      const item = await signedItem(gzipped, [
        { name: 'Content-Encoding', value: 'gzip' },
      ]);
      storeObject(item.raw, {
        'payload-data-start': String(item.headerLength),
      });

      const result = await s3DataSource.getData({
        id: item.id,
        region: { offset: 2, size: 5 },
      });

      assert.deepEqual(await readAll(result.stream), gzipped.subarray(2, 7));
      assert.equal(result.sourceContentEncoding, undefined);
      assert.equal(
        requestedRange(),
        `bytes=${item.headerLength + 2}-${item.headerLength + 6}`,
      );
    });

    it('fails when the object ends inside the header', async () => {
      const item = await signedItem(gzipped, [
        { name: 'Content-Encoding', value: 'gzip' },
      ]);
      // A truncated object: the metadata claims a header longer than it.
      storeObject(item.raw.subarray(0, 10), {
        'payload-data-start': String(item.headerLength),
      });

      await assert.rejects(s3DataSource.getData({ id: item.id }));
    });
  });
});

describe('splitLeadingBytes', () => {
  const readAll = async (stream: NodeJS.ReadableStream) => {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  };

  it('splits at a chunk boundary and in the middle of a chunk', async () => {
    for (const chunks of [
      ['abc', 'def'],
      ['ab', 'cdef'],
      ['a', 'b', 'c', 'd', 'e', 'f'],
      ['abcdef'],
    ]) {
      const { head, rest } = await splitLeadingBytes(
        Readable.from(chunks.map((c) => Buffer.from(c))),
        3,
      );
      assert.equal(head.toString(), 'abc', chunks.join('|'));
      assert.equal((await readAll(rest)).toString(), 'def', chunks.join('|'));
    }
  });

  it('rejects when the stream ends first', async () => {
    await assert.rejects(
      splitLeadingBytes(Readable.from([Buffer.from('ab')]), 3),
      /ended after 2 of 3/,
    );
  });

  it('destroys the source when the rest is destroyed', async () => {
    const source = new Readable({ read() {} });
    source.push(Buffer.from('abcdef'));
    const { rest } = await splitLeadingBytes(source, 3);
    rest.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(source.destroyed, true);
  });
});
