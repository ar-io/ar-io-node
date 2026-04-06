/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { Readable } from 'node:stream';
import { afterEach, describe, it, mock } from 'node:test';
import { LRUCache } from 'lru-cache';
import axios from 'axios';
import { serializeTags } from '@dha-team/arbundles';
import { HyperBeamRootTxIndex } from './hyperbeam-root-tx-index.js';
import { getSignatureMeta } from '../lib/bundles.js';
import { createTestLogger } from '../../test/test-logger.js';

const log = createTestLogger({ suite: 'HyperBeamRootTxIndex' });

/**
 * Builds a valid ANS-104 data item header buffer for testing backward-scan.
 */
function buildDataItemHeader({
  signatureType = 1,
  hasTarget = false,
  hasAnchor = false,
  tags = [] as { name: string; value: string }[],
}: {
  signatureType?: number;
  hasTarget?: boolean;
  hasAnchor?: boolean;
  tags?: { name: string; value: string }[];
} = {}): Buffer {
  const { sigLength, pubLength } = getSignatureMeta(signatureType);

  const parts: Buffer[] = [];

  // Signature type (2 bytes, little-endian)
  const sigTypeBuf = Buffer.alloc(2);
  sigTypeBuf.writeUInt16LE(signatureType, 0);
  parts.push(sigTypeBuf);

  // Signature (filled with 0xAA)
  parts.push(Buffer.alloc(sigLength, 0xaa));

  // Owner/public key (filled with 0xBB)
  parts.push(Buffer.alloc(pubLength, 0xbb));

  // Target flag + optional target
  parts.push(Buffer.from([hasTarget ? 1 : 0]));
  if (hasTarget) {
    parts.push(Buffer.alloc(32, 0xcc));
  }

  // Anchor flag + optional anchor
  parts.push(Buffer.from([hasAnchor ? 1 : 0]));
  if (hasAnchor) {
    parts.push(Buffer.alloc(32, 0xdd));
  }

  // Tags metadata + serialized tags
  const serializedTags =
    tags.length > 0 ? serializeTags(tags) : Buffer.alloc(0);
  const tagCountBuf = Buffer.alloc(8);
  tagCountBuf.writeBigUInt64LE(BigInt(tags.length), 0);
  const tagBytesBuf = Buffer.alloc(8);
  tagBytesBuf.writeBigUInt64LE(BigInt(serializedTags.length), 0);
  parts.push(tagCountBuf);
  parts.push(tagBytesBuf);
  if (serializedTags.length > 0) {
    parts.push(serializedTags);
  }

  return Buffer.concat(parts);
}

function createMockAxiosInstance(responseOrFn: any) {
  const getInstance =
    typeof responseOrFn === 'function' ? responseOrFn : () => responseOrFn;
  return {
    get: mock.fn((url: string) => getInstance(url)),
    defaults: { raxConfig: {} },
    interceptors: {
      request: { use: mock.fn(), eject: mock.fn() },
      response: { use: mock.fn(), eject: mock.fn() },
    },
  };
}

function createMockBoundarySource(result: any) {
  return {
    getTxBoundary: mock.fn(() => Promise.resolve(result)),
  };
}

function createMockDataSource(buffer: Buffer) {
  return {
    getData: mock.fn(() =>
      Promise.resolve({
        stream: Readable.from([buffer]),
        size: buffer.length,
        verified: false,
        trusted: false,
        cached: false,
      }),
    ),
  };
}

function createMockDataAttributesStore(attrs: any) {
  return {
    getDataAttributes: mock.fn(() => Promise.resolve(attrs)),
    setDataAttributes: mock.fn(() => Promise.resolve()),
  };
}

function createIndex(overrides: Record<string, any> = {}) {
  return new HyperBeamRootTxIndex({
    log,
    hyperbeamEndpoint: 'https://arweave.net',
    txBoundarySource: createMockBoundarySource(null),
    rateLimitBurstSize: 1000,
    rateLimitTokensPerInterval: 1000,
    rateLimitInterval: 'second' as const,
    ...overrides,
  });
}

describe('HyperBeamRootTxIndex', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  describe('constructor', () => {
    it('should implement DataItemRootIndex interface', () => {
      const index = createIndex();
      assert(typeof index.getRootTx === 'function');
    });
  });

  describe('getRootTx', () => {
    it('should resolve data item to root TX via HyperBEAM offset', async () => {
      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: '355950809045177' }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const boundary = {
        id: 'root-tx-abc',
        dataRoot: 'data-root-123',
        dataSize: 1000000,
        weaveOffset: 355950810045176,
      };
      const txBoundarySource = createMockBoundarySource(boundary);

      const index = createIndex({ txBoundarySource });
      // Prefill rate limiter
      (index as any)['limiter'].content = (index as any)['limiter'].bucketSize;

      const result = await index.getRootTx('test-data-item');

      assert(result !== undefined);
      assert.equal(result.rootTxId, 'root-tx-abc');
      // relativeDataOffset = 355950809045177 - (355950810045176 - 1000000 + 1)
      assert.equal(
        result.rootDataOffset,
        355950809045177 - (355950810045176 - 1000000 + 1),
      );
      assert.equal(mockAxios.get.mock.calls.length, 1);
    });

    it('should handle string offset response', async () => {
      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: '  12345  ' }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const boundary = {
        id: 'root-tx-abc',
        dataRoot: 'dr',
        dataSize: 1000,
        weaveOffset: 13344,
      };
      const txBoundarySource = createMockBoundarySource(boundary);

      const index = createIndex({ txBoundarySource });
      (index as any)['limiter'].content = (index as any)['limiter'].bucketSize;

      const result = await index.getRootTx('test-item');

      assert(result !== undefined);
      assert.equal(result.rootTxId, 'root-tx-abc');
      // relativeDataOffset = 12345 - (13344 - 1000 + 1) = 12345 - 12345 = 0
      assert.equal(result.rootDataOffset, 0);
    });

    it('should handle numeric offset response', async () => {
      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: 12345 }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const boundary = {
        id: 'root-tx-abc',
        dataRoot: 'dr',
        dataSize: 100,
        weaveOffset: 12444,
      };
      const txBoundarySource = createMockBoundarySource(boundary);

      const index = createIndex({ txBoundarySource });
      (index as any)['limiter'].content = (index as any)['limiter'].bucketSize;

      const result = await index.getRootTx('test-item');

      assert(result !== undefined);
      assert.equal(result.rootTxId, 'root-tx-abc');
      // relativeDataOffset = 12345 - (12444 - 100 + 1) = 12345 - 12345 = 0
      assert.equal(result.rootDataOffset, 0);
    });

    it('should return undefined for 404 from HyperBEAM', async () => {
      const mockAxios = createMockAxiosInstance(
        Promise.reject({ response: { status: 404 }, message: 'Not found' }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const index = createIndex();
      (index as any)['limiter'].content = (index as any)['limiter'].bucketSize;

      const result = await index.getRootTx('nonexistent-item');

      assert.equal(result, undefined);
    });

    it('should return undefined when boundary source returns null', async () => {
      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: '12345' }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const txBoundarySource = createMockBoundarySource(null);

      const index = createIndex({ txBoundarySource });
      (index as any)['limiter'].content = (index as any)['limiter'].bucketSize;

      const result = await index.getRootTx('test-item');

      assert.equal(result, undefined);
    });

    it('should return undefined when boundary has no TX ID', async () => {
      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: '12345' }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const boundary = {
        id: undefined,
        dataRoot: 'dr',
        dataSize: 100,
        weaveOffset: 12444,
      };
      const txBoundarySource = createMockBoundarySource(boundary);

      const index = createIndex({ txBoundarySource });
      (index as any)['limiter'].content = (index as any)['limiter'].bucketSize;

      const result = await index.getRootTx('test-item');

      assert.equal(result, undefined);
    });

    it('should return undefined for non-numeric response', async () => {
      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: 'not-a-number' }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const index = createIndex();
      (index as any)['limiter'].content = (index as any)['limiter'].bucketSize;

      const result = await index.getRootTx('test-item');

      assert.equal(result, undefined);
    });

    it('should re-throw network errors for circuit breaker', async () => {
      const networkError = new Error('ECONNREFUSED');
      const mockAxios = createMockAxiosInstance(Promise.reject(networkError));
      mock.method(axios, 'create', () => mockAxios);

      const index = createIndex();
      (index as any)['limiter'].content = (index as any)['limiter'].bucketSize;

      await assert.rejects(
        () => index.getRootTx('test-item'),
        (error: Error) => error.message === 'ECONNREFUSED',
      );
    });

    it('should return cached result on cache hit', async () => {
      const cache = new LRUCache<string, any>({
        max: 100,
        ttl: 1000 * 60 * 5,
      });

      const cachedResult = {
        rootTxId: 'cached-root-tx',
        rootDataOffset: 500,
      };
      cache.set('cached-item', cachedResult);

      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: '12345' }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const index = createIndex({ cache });

      const result = await index.getRootTx('cached-item');

      assert.deepEqual(result, cachedResult);
      // Should not have made any HTTP request
      assert.equal(mockAxios.get.mock.calls.length, 0);
    });

    it('should return undefined when rate limit is exhausted', async () => {
      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: '12345' }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const index = createIndex();

      // Set rate limiter to 0 tokens — should immediately return undefined
      (index as any)['limiter'].content = 0;

      const result = await index.getRootTx('rate-limited-item');

      assert.equal(result, undefined);
      // No HTTP calls should have been made
      assert.equal(mockAxios.get.mock.calls.length, 0);
    });

    it('should cache results after successful resolution', async () => {
      const cache = new LRUCache<string, any>({
        max: 100,
        ttl: 1000 * 60 * 5,
      });

      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: '12345' }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const boundary = {
        id: 'root-tx-abc',
        dataRoot: 'dr',
        dataSize: 100,
        weaveOffset: 12444,
      };
      const txBoundarySource = createMockBoundarySource(boundary);

      const index = createIndex({ txBoundarySource, cache });
      (index as any)['limiter'].content = (index as any)['limiter'].bucketSize;

      // First call populates cache
      await index.getRootTx('test-item');

      // Second call uses cache
      const result = await index.getRootTx('test-item');

      assert(result !== undefined);
      assert.equal(result.rootTxId, 'root-tx-abc');
      // Only 1 HTTP call
      assert.equal(mockAxios.get.mock.calls.length, 1);
    });
  });

  describe('backward-scan enrichment', () => {
    // Maximum header size constant (same as in hyperbeam-root-tx-index.ts)
    const MAX_DATA_ITEM_HEADER_SIZE =
      2 + 2052 + 1025 + 33 + 33 + 16 + 4096 + 1024;

    /**
     * Helper to set up a test with backward-scan.
     * Builds a properly sized buffer with padding + header at the end,
     * matching what the scan expects (fetchSize bytes ending at relativeDataOffset).
     */
    function setupBackwardScanTest({
      headerBuffer,
      globalOffset = 50000,
      weaveOffset = 100000,
      txDataSize = 60000,
    }: {
      headerBuffer: Buffer;
      globalOffset?: number;
      weaveOffset?: number;
      txDataSize?: number;
    }) {
      const relativeDataOffset = globalOffset - (weaveOffset - txDataSize + 1);
      const fetchStart = Math.max(
        0,
        relativeDataOffset - MAX_DATA_ITEM_HEADER_SIZE,
      );
      const fetchSize = relativeDataOffset - fetchStart;

      // Build buffer: padding + header at end, total = fetchSize
      const paddingSize = fetchSize - headerBuffer.length;
      const fullBuffer =
        paddingSize > 0
          ? Buffer.concat([Buffer.alloc(paddingSize, 0xff), headerBuffer])
          : headerBuffer;

      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: String(globalOffset) }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const boundary = {
        id: 'root-tx-scan',
        dataRoot: 'dr',
        dataSize: txDataSize,
        weaveOffset,
      };
      const txBoundarySource = createMockBoundarySource(boundary);
      const contiguousDataSource = createMockDataSource(fullBuffer);

      return { mockAxios, txBoundarySource, contiguousDataSource };
    }

    it('should extract rootOffset and contentType from backward-scan', async () => {
      const header = buildDataItemHeader({
        signatureType: 1,
        tags: [{ name: 'Content-Type', value: 'application/json' }],
      });

      // Global offset = 50000, weaveOffset = 100000, txDataSize = 60000
      // TX data starts at: 100000 - 60000 + 1 = 40001
      // relativeDataOffset = 50000 - 40001 = 9999
      // fetchStart = max(0, 9999 - MAX_HEADER_SIZE) = 1718
      // fetchSize = 9999 - 1718 = 8281
      // The mock returns a buffer with padding + header at the end.
      // The scan should find the header at (buffer.length - header.length)
      // rootOffset = fetchStart + (buffer.length - header.length)

      const fetchStart = 1718; // pre-calculated
      const fetchSize = 9999 - fetchStart;

      // Build buffer: padding + header, total = fetchSize
      const padding = Buffer.alloc(fetchSize - header.length, 0xff);
      const fullBuffer = Buffer.concat([padding, header]);

      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: '50000' }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const boundary = {
        id: 'root-tx-scan',
        dataRoot: 'dr',
        dataSize: 60000,
        weaveOffset: 100000,
      };
      const txBoundarySource = createMockBoundarySource(boundary);
      const contiguousDataSource = createMockDataSource(fullBuffer);

      const index = createIndex({ txBoundarySource, contiguousDataSource });
      (index as any)['limiter'].content = (index as any)['limiter'].bucketSize;

      const result = await index.getRootTx('test-scan-item');

      assert(result !== undefined);
      assert.equal(result.rootTxId, 'root-tx-scan');
      assert.equal(result.contentType, 'application/json');
      assert(result.rootOffset !== undefined);
      // rootOffset = fetchStart + (fullBuffer.length - header.length)
      const expectedRootOffset =
        fetchStart + (fullBuffer.length - header.length);
      assert.equal(result.rootOffset, expectedRootOffset);
      // Which should equal relativeDataOffset - header.length
      assert.equal(result.rootOffset, 9999 - header.length);
    });

    it('should parse Ed25519 (type 2) headers', async () => {
      const header = buildDataItemHeader({
        signatureType: 2,
        tags: [{ name: 'Content-Type', value: 'text/plain' }],
      });

      const { txBoundarySource, contiguousDataSource } = setupBackwardScanTest({
        headerBuffer: header,
      });

      const index = createIndex({ txBoundarySource, contiguousDataSource });
      (index as any)['limiter'].content = (index as any)['limiter'].bucketSize;

      const result = await index.getRootTx('test-ed25519');

      assert(result !== undefined);
      assert.equal(result.contentType, 'text/plain');
      assert(result.rootOffset !== undefined);
    });

    it('should parse Ethereum (type 3) headers', async () => {
      const header = buildDataItemHeader({
        signatureType: 3,
        tags: [{ name: 'Content-Type', value: 'image/png' }],
      });

      const { txBoundarySource, contiguousDataSource } = setupBackwardScanTest({
        headerBuffer: header,
      });

      const index = createIndex({ txBoundarySource, contiguousDataSource });
      (index as any)['limiter'].content = (index as any)['limiter'].bucketSize;

      const result = await index.getRootTx('test-ethereum');

      assert(result !== undefined);
      assert.equal(result.contentType, 'image/png');
      assert(result.rootOffset !== undefined);
    });

    it('should parse headers with target and anchor', async () => {
      const header = buildDataItemHeader({
        signatureType: 2,
        hasTarget: true,
        hasAnchor: true,
        tags: [{ name: 'Content-Type', value: 'text/html' }],
      });

      const { txBoundarySource, contiguousDataSource } = setupBackwardScanTest({
        headerBuffer: header,
      });

      const index = createIndex({ txBoundarySource, contiguousDataSource });
      (index as any)['limiter'].content = (index as any)['limiter'].bucketSize;

      const result = await index.getRootTx('test-target-anchor');

      assert(result !== undefined);
      assert.equal(result.contentType, 'text/html');
      assert(result.rootOffset !== undefined);
    });

    it('should parse headers without tags', async () => {
      const header = buildDataItemHeader({
        signatureType: 2,
        tags: [],
      });

      const { txBoundarySource, contiguousDataSource } = setupBackwardScanTest({
        headerBuffer: header,
      });

      const index = createIndex({ txBoundarySource, contiguousDataSource });
      (index as any)['limiter'].content = (index as any)['limiter'].bucketSize;

      const result = await index.getRootTx('test-no-tags');

      assert(result !== undefined);
      assert.equal(result.contentType, undefined);
      assert(result.rootOffset !== undefined);
    });

    it('should fall back to DB enrichment when backward-scan fails', async () => {
      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: '50000' }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const boundary = {
        id: 'root-tx-fallback',
        dataRoot: 'dr',
        dataSize: 60000,
        weaveOffset: 100000,
      };
      const txBoundarySource = createMockBoundarySource(boundary);

      // Data source that fails
      const contiguousDataSource = {
        getData: mock.fn(() => Promise.reject(new Error('chunk unavailable'))),
      };

      const dataAttributesStore = createMockDataAttributesStore({
        rootDataItemOffset: 9000,
        contentType: 'application/octet-stream',
        size: 500,
        itemSize: 600,
      });

      const index = createIndex({
        txBoundarySource,
        contiguousDataSource,
        dataAttributesStore,
      });
      (index as any)['limiter'].content = (index as any)['limiter'].bucketSize;

      const result = await index.getRootTx('test-fallback');

      assert(result !== undefined);
      assert.equal(result.rootTxId, 'root-tx-fallback');
      assert.equal(result.rootOffset, 9000);
      assert.equal(result.contentType, 'application/octet-stream');
      assert.equal(result.dataSize, 500);
      assert.equal(result.size, 600);
    });

    it('should return incomplete result when both enrichments fail', async () => {
      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: '50000' }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const boundary = {
        id: 'root-tx-incomplete',
        dataRoot: 'dr',
        dataSize: 60000,
        weaveOffset: 100000,
      };
      const txBoundarySource = createMockBoundarySource(boundary);

      const index = createIndex({ txBoundarySource });
      (index as any)['limiter'].content = (index as any)['limiter'].bucketSize;

      const result = await index.getRootTx('test-incomplete');

      assert(result !== undefined);
      assert.equal(result.rootTxId, 'root-tx-incomplete');
      assert.equal(result.rootDataOffset, 50000 - (100000 - 60000 + 1));
      // No enrichment data
      assert.equal(result.rootOffset, undefined);
      assert.equal(result.contentType, undefined);
      assert.equal(result.size, undefined);
      assert.equal(result.dataSize, undefined);
    });

    it('should skip backward-scan when contiguousDataSource is not provided', async () => {
      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: '50000' }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const boundary = {
        id: 'root-tx-noscan',
        dataRoot: 'dr',
        dataSize: 60000,
        weaveOffset: 100000,
      };
      const txBoundarySource = createMockBoundarySource(boundary);

      const dataAttributesStore = createMockDataAttributesStore({
        rootDataItemOffset: 9000,
        contentType: 'text/plain',
        size: 500,
        itemSize: 600,
      });

      // No contiguousDataSource provided
      const index = createIndex({
        txBoundarySource,
        contiguousDataSource: undefined,
        dataAttributesStore,
      });
      (index as any)['limiter'].content = (index as any)['limiter'].bucketSize;

      const result = await index.getRootTx('test-noscan');

      assert(result !== undefined);
      // Should still get DB enrichment
      assert.equal(result.rootOffset, 9000);
      assert.equal(result.contentType, 'text/plain');
    });

    it('should reject false positive signature type patterns', async () => {
      // Buffer with bytes 01 00 that don't form a valid header
      // because the structural parse won't end at the buffer boundary
      const fakeBuffer = Buffer.alloc(200, 0x00);
      fakeBuffer[10] = 0x01; // Looks like sig type 1
      fakeBuffer[11] = 0x00;
      // But the rest is all zeros, so target/anchor flags are 0, tags are 0
      // The structural parse will end much earlier than the buffer length

      const { txBoundarySource, contiguousDataSource } = setupBackwardScanTest({
        headerBuffer: fakeBuffer,
      });

      const dataAttributesStore = createMockDataAttributesStore(undefined);

      const index = createIndex({
        txBoundarySource,
        contiguousDataSource,
        dataAttributesStore,
      });
      (index as any)['limiter'].content = (index as any)['limiter'].bucketSize;

      const result = await index.getRootTx('test-false-positive');

      assert(result !== undefined);
      // Should not have found a valid header
      assert.equal(result.rootOffset, undefined);
    });
  });

  describe('DB attribute enrichment', () => {
    it('should enrich from data attributes when available', async () => {
      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: '50000' }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const boundary = {
        id: 'root-tx-db',
        dataRoot: 'dr',
        dataSize: 60000,
        weaveOffset: 100000,
      };
      const txBoundarySource = createMockBoundarySource(boundary);

      const dataAttributesStore = createMockDataAttributesStore({
        rootDataItemOffset: 8500,
        contentType: 'video/mp4',
        size: 2000,
        itemSize: 2200,
      });

      const index = createIndex({ txBoundarySource, dataAttributesStore });
      (index as any)['limiter'].content = (index as any)['limiter'].bucketSize;

      const result = await index.getRootTx('test-db-enrich');

      assert(result !== undefined);
      assert.equal(result.rootOffset, 8500);
      assert.equal(result.contentType, 'video/mp4');
      assert.equal(result.dataSize, 2000);
      assert.equal(result.size, 2200);
    });

    it('should handle undefined data attributes gracefully', async () => {
      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: '50000' }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const boundary = {
        id: 'root-tx-noattrs',
        dataRoot: 'dr',
        dataSize: 60000,
        weaveOffset: 100000,
      };
      const txBoundarySource = createMockBoundarySource(boundary);

      const dataAttributesStore = createMockDataAttributesStore(undefined);

      const index = createIndex({ txBoundarySource, dataAttributesStore });
      (index as any)['limiter'].content = (index as any)['limiter'].bucketSize;

      const result = await index.getRootTx('test-noattrs');

      assert(result !== undefined);
      assert.equal(result.rootTxId, 'root-tx-noattrs');
      assert.equal(result.rootOffset, undefined);
      assert.equal(result.contentType, undefined);
    });
  });
});
