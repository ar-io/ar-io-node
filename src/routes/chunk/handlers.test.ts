/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import crypto from 'node:crypto';
import express from 'express';
import { default as request } from 'supertest';
import {
  createChunkOffsetHandler,
  createChunkOffsetDataHandler,
  determineFailureStatusCode,
} from './handlers.js';
import { ChunkNotFoundError } from '../../data/chunk-retrieval-service.js';
import { formatContentDigest } from '../../lib/digest.js';
import { createTestLogger } from '../../../test/test-logger.js';

const log = createTestLogger({ suite: 'chunk-handlers' });

const CHUNK_OFFSET_PATH = '/chunk/:offset(\\d+)';

/**
 * SHA-256 (base64url) of the serialized JSON body that the chunk-offset
 * handler emits. Both ETag and Content-Digest are derived from this single
 * hash — the helpers below split into the two formats the handler actually
 * sets on the response.
 */
function expectedJsonHash(parts: {
  chunk: Buffer;
  data_path: Buffer;
  tx_path?: Buffer;
}): string {
  const body: Record<string, string> = {
    chunk: parts.chunk.toString('base64url'),
    data_path: parts.data_path.toString('base64url'),
  };
  if (parts.tx_path !== undefined) {
    body.tx_path = parts.tx_path.toString('base64url');
  }
  body.packing = 'unpacked';
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(body))
    .digest('base64url');
}

/**
 * Compute the expected ETag for a chunk-offset JSON response. The handler
 * sets ETag from the SHA-256 (base64url) of the serialized JSON body — not
 * from the raw chunk bytes — so ETag describes what's actually served per
 * RFC 9110 §8.8.1.
 */
function expectedJsonEtag(parts: {
  chunk: Buffer;
  data_path: Buffer;
  tx_path?: Buffer;
}): string {
  return `"${expectedJsonHash(parts)}"`;
}

/**
 * Compute the expected `Content-Digest` for a chunk-offset JSON response,
 * in RFC 9530 dictionary syntax (`sha-256=:<base64>:`). Derived from the
 * same hash as ETag — pairing the two assertions in tests guards against
 * the representation validator and the HTTPSIG body-binding digest
 * silently disagreeing.
 */
function expectedJsonContentDigest(parts: {
  chunk: Buffer;
  data_path: Buffer;
  tx_path?: Buffer;
}): string {
  return formatContentDigest(expectedJsonHash(parts));
}

const DEFAULT_MOCK_CHUNK = Buffer.from('chunk data');
const DEFAULT_MOCK_DATA_PATH = Buffer.from('12345abc');

/**
 * Creates a mock ChunkRetrievalService that returns a BoundaryFetchResult.
 */
function mockService(
  chunkFields: Record<string, any>,
  overrides?: Record<string, any>,
): any {
  return {
    retrieveChunk: async () => ({
      type: 'boundary_fetch',
      chunk: {
        chunk: Buffer.from('chunk data'),
        data_path: Buffer.from('12345abc'),
        source: 'cache',
        ...chunkFields,
      },
      dataRoot: 'abc1234',
      dataSize: 100,
      weaveOffset: 99,
      relativeOffset: 0,
      contiguousDataStartDelimiter: 0,
      ...overrides,
    }),
  };
}

/**
 * Creates a mock ChunkRetrievalService that throws ChunkNotFoundError.
 */
function mockNotFoundService(
  message = 'Not found',
  errorType = 'not_found',
): any {
  return {
    retrieveChunk: async () => {
      throw new ChunkNotFoundError(message, errorType);
    },
  };
}

describe('Chunk routes', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it('should return 200 for a valid chunk request', async () => {
    const chunkRetrievalService = mockService({ source: 'cache' });

    app.get(
      CHUNK_OFFSET_PATH,
      createChunkOffsetHandler({ chunkRetrievalService, log }),
    );

    await request(app)
      .get('/chunk/274995392586018')
      .expect(200)
      .then((res: any) => {
        assert.strictEqual(res.status, 200);
        assert.strictEqual(
          res.header['content-type'],
          'application/json; charset=utf-8',
        );
        assert.deepEqual(res.body, {
          chunk: 'Y2h1bmsgZGF0YQ', // base64url of "chunk data"
          data_path: 'MTIzNDVhYmM',
          packing: 'unpacked',
        });
      });
  });

  it('should return 200 with tx_path when available', async () => {
    const chunkRetrievalService = mockService({
      tx_path: Buffer.from('txpath123'),
      source: 'arweave-network',
    });

    app.get(
      CHUNK_OFFSET_PATH,
      createChunkOffsetHandler({ chunkRetrievalService, log }),
    );

    await request(app)
      .get('/chunk/274995392586018')
      .expect(200)
      .then((res: any) => {
        assert.strictEqual(res.status, 200);
        assert.strictEqual(
          res.header['content-type'],
          'application/json; charset=utf-8',
        );
        assert.deepEqual(res.body, {
          chunk: 'Y2h1bmsgZGF0YQ', // base64url of "chunk data"
          data_path: 'MTIzNDVhYmM',
          tx_path: 'dHhwYXRoMTIz', // base64url of "txpath123"
          packing: 'unpacked',
        });
      });
  });

  it('should return 404 for an invalid (non-numeric) offset', async () => {
    const chunkRetrievalService = mockService({});

    app.get(
      CHUNK_OFFSET_PATH,
      createChunkOffsetHandler({ chunkRetrievalService, log }),
    );

    await request(app)
      .get('/chunk/invalid-offset')
      .expect(404)
      .then((res: any) => {
        assert.strictEqual(res.status, 404);
      });
  });

  it('should return 404 if transaction not found', async () => {
    const chunkRetrievalService = mockNotFoundService(
      'No TX boundary found',
      'boundary_not_found',
    );

    app.get(
      CHUNK_OFFSET_PATH,
      createChunkOffsetHandler({ chunkRetrievalService, log }),
    );

    await request(app)
      .get('/chunk/1234')
      .expect(404)
      .then((res: any) => {
        assert.strictEqual(res.status, 404);
        assert.strictEqual(res.text, 'Not Found');
      });
  });

  it('should return 404 if chunk fetch fails', async () => {
    const chunkRetrievalService = mockNotFoundService(
      'Chunk fetch failed',
      'fetch_failed',
    );

    app.get(
      CHUNK_OFFSET_PATH,
      createChunkOffsetHandler({ chunkRetrievalService, log }),
    );

    await request(app)
      .get('/chunk/1234')
      .expect(404)
      .then((res: any) => {
        assert.strictEqual(res.status, 404);
      });
  });

  it('should return 500 if the chunk is not a valid Buffer (simulate base64 conversion issue)', async () => {
    // This test artificially simulates a scenario where `chunk`
    // is not a Buffer. The typical code tries `Buffer.from(chunk).toString('base64')`,
    // which would fail if chunk is not a valid buffer/string.
    const chunkRetrievalService = mockService({
      chunk: 1234, // Not a Buffer or string
    });

    app.get(
      CHUNK_OFFSET_PATH,
      createChunkOffsetHandler({ chunkRetrievalService, log }),
    );

    await request(app)
      .get('/chunk/1234')
      .expect(500)
      .then((res: any) => {
        assert.strictEqual(res.status, 500);
        assert.match(res.text, /Error converting chunk to base64url/);
      });
  });

  describe('HEAD requests', () => {
    it('should return 200 with headers but no body for HEAD request', async () => {
      const chunkRetrievalService = mockService({
        source: 'cache',
        hash: Buffer.from('dGVzdC1oYXNo', 'base64url'),
      });

      app.head(
        CHUNK_OFFSET_PATH,
        createChunkOffsetHandler({ chunkRetrievalService, log }),
      );

      await request(app)
        .head('/chunk/274995392586018')
        .expect(200)
        .then((res: any) => {
          assert.strictEqual(res.status, 200);
          assert.strictEqual(
            res.header['content-type'],
            'application/json; charset=utf-8',
          );
          assert.strictEqual(res.header['x-cache'], 'HIT');
          // ETag describes the JSON representation served by this endpoint,
          // not the raw chunk bytes.
          assert.strictEqual(
            res.header['etag'],
            expectedJsonEtag({
              chunk: DEFAULT_MOCK_CHUNK,
              data_path: DEFAULT_MOCK_DATA_PATH,
            }),
          );
          assert.ok(res.header['content-length']);
          // HEAD request should have no body
          assert.ok(res.text === '' || res.text === undefined);
        });
    });

    it('should return 404 for HEAD request with invalid offset', async () => {
      const chunkRetrievalService = mockService({});

      app.head(
        CHUNK_OFFSET_PATH,
        createChunkOffsetHandler({ chunkRetrievalService, log }),
      );

      await request(app)
        .head('/chunk/invalid-offset')
        .expect(404)
        .then((res: any) => {
          assert.strictEqual(res.status, 404);
          // HEAD responses have no body
          assert.ok(res.text === '' || res.text === undefined);
        });
    });

    it('should return same headers for HEAD and GET requests', async () => {
      const chunkRetrievalService = mockService({
        source: 'network',
        sourceHost: 'example.com',
      });

      const handler = createChunkOffsetHandler({
        chunkRetrievalService,
        log,
      });

      app.get(CHUNK_OFFSET_PATH, handler);
      app.head(CHUNK_OFFSET_PATH, handler);

      const getResponse = await request(app).get('/chunk/1234');
      const headResponse = await request(app).head('/chunk/1234');

      assert.strictEqual(getResponse.status, headResponse.status);
      assert.strictEqual(
        getResponse.header['content-type'],
        headResponse.header['content-type'],
      );
      assert.strictEqual(
        getResponse.header['x-cache'],
        headResponse.header['x-cache'],
      );
      assert.strictEqual(
        getResponse.header['x-ar-io-chunk-source'],
        headResponse.header['x-ar-io-chunk-source'],
      );
      assert.strictEqual(
        getResponse.header['x-ar-io-chunk-host'],
        headResponse.header['x-ar-io-chunk-host'],
      );
      // HEAD should have no body
      assert.ok(getResponse.body.chunk);
      assert.ok(headResponse.text === '' || headResponse.text === undefined);
    });
  });

  describe('ETag support', () => {
    // Contract change (2026): ETag on /chunk/:offset describes the JSON
    // body served by this endpoint, not the raw chunk bytes — so it is
    // always present (the JSON is fully in memory) and always agrees with
    // Content-Digest. Cache status / hash availability no longer gate it.

    it('should include ETag derived from JSON body when cached', async () => {
      const chunkRetrievalService = mockService({
        source: 'cache',
        hash: Buffer.from('abc123def456', 'base64url'),
      });

      app.get(
        CHUNK_OFFSET_PATH,
        createChunkOffsetHandler({ chunkRetrievalService, log }),
      );

      await request(app)
        .get('/chunk/1234')
        .expect(200)
        .then((res: any) => {
          assert.strictEqual(
            res.header['etag'],
            expectedJsonEtag({
              chunk: DEFAULT_MOCK_CHUNK,
              data_path: DEFAULT_MOCK_DATA_PATH,
            }),
          );
          assert.strictEqual(
            res.header['content-digest'],
            expectedJsonContentDigest({
              chunk: DEFAULT_MOCK_CHUNK,
              data_path: DEFAULT_MOCK_DATA_PATH,
            }),
          );
        });
    });

    it('should include ETag for HEAD request regardless of cache status', async () => {
      const chunkRetrievalService = mockService({
        source: 'network', // Not cached
        hash: Buffer.from('abc123def456', 'base64url'),
      });

      app.head(
        CHUNK_OFFSET_PATH,
        createChunkOffsetHandler({ chunkRetrievalService, log }),
      );

      await request(app)
        .head('/chunk/1234')
        .expect(200)
        .then((res: any) => {
          assert.strictEqual(
            res.header['etag'],
            expectedJsonEtag({
              chunk: DEFAULT_MOCK_CHUNK,
              data_path: DEFAULT_MOCK_DATA_PATH,
            }),
          );
          assert.strictEqual(
            res.header['content-digest'],
            expectedJsonContentDigest({
              chunk: DEFAULT_MOCK_CHUNK,
              data_path: DEFAULT_MOCK_DATA_PATH,
            }),
          );
          assert.strictEqual(res.header['x-cache'], 'MISS');
        });
    });

    it('should include ETag even when chunk hash is unavailable', async () => {
      const chunkRetrievalService = mockService({
        source: 'network',
        // No raw-chunk hash field — but ETag covers the JSON body, which
        // we always have, so ETag is still emitted.
      });

      app.get(
        CHUNK_OFFSET_PATH,
        createChunkOffsetHandler({ chunkRetrievalService, log }),
      );

      await request(app)
        .get('/chunk/1234')
        .expect(200)
        .then((res: any) => {
          assert.strictEqual(
            res.header['etag'],
            expectedJsonEtag({
              chunk: DEFAULT_MOCK_CHUNK,
              data_path: DEFAULT_MOCK_DATA_PATH,
            }),
          );
          assert.strictEqual(
            res.header['content-digest'],
            expectedJsonContentDigest({
              chunk: DEFAULT_MOCK_CHUNK,
              data_path: DEFAULT_MOCK_DATA_PATH,
            }),
          );
        });
    });

    it('should include ETag for GET from network when not cached', async () => {
      const chunkRetrievalService = mockService({
        source: 'network',
        hash: Buffer.from('abc123def456', 'base64url'),
      });

      app.get(
        CHUNK_OFFSET_PATH,
        createChunkOffsetHandler({ chunkRetrievalService, log }),
      );

      await request(app)
        .get('/chunk/1234')
        .expect(200)
        .then((res: any) => {
          assert.strictEqual(
            res.header['etag'],
            expectedJsonEtag({
              chunk: DEFAULT_MOCK_CHUNK,
              data_path: DEFAULT_MOCK_DATA_PATH,
            }),
          );
          assert.strictEqual(
            res.header['content-digest'],
            expectedJsonContentDigest({
              chunk: DEFAULT_MOCK_CHUNK,
              data_path: DEFAULT_MOCK_DATA_PATH,
            }),
          );
          assert.strictEqual(res.header['x-cache'], 'MISS');
        });
    });
  });

  describe('If-None-Match conditional requests', () => {
    const jsonEtag = expectedJsonEtag({
      chunk: DEFAULT_MOCK_CHUNK,
      data_path: DEFAULT_MOCK_DATA_PATH,
    });
    const jsonContentDigest = expectedJsonContentDigest({
      chunk: DEFAULT_MOCK_CHUNK,
      data_path: DEFAULT_MOCK_DATA_PATH,
    });

    it('should return 304 when If-None-Match matches ETag for GET', async () => {
      const chunkRetrievalService = mockService({
        source: 'cache',
        hash: Buffer.from('dGVzdC1oYXNo', 'base64url'),
      });

      app.get(
        CHUNK_OFFSET_PATH,
        createChunkOffsetHandler({ chunkRetrievalService, log }),
      );

      await request(app)
        .get('/chunk/1234')
        .set('If-None-Match', jsonEtag)
        .expect(304)
        .then((res: any) => {
          assert.strictEqual(res.status, 304);
          // 304 responses should not have Content-Length
          assert.strictEqual(res.header['content-length'], undefined);
          assert.ok(res.text === '' || res.text === undefined);
        });
    });

    it('should return 304 when If-None-Match matches ETag for HEAD', async () => {
      const chunkRetrievalService = mockService({
        source: 'cache',
        hash: Buffer.from('dGVzdC1oYXNo', 'base64url'),
      });

      app.head(
        CHUNK_OFFSET_PATH,
        createChunkOffsetHandler({ chunkRetrievalService, log }),
      );

      await request(app)
        .head('/chunk/1234')
        .set('If-None-Match', jsonEtag)
        .expect(304)
        .then((res: any) => {
          assert.strictEqual(res.status, 304);
          assert.strictEqual(res.header['content-length'], undefined);
          assert.ok(res.text === '' || res.text === undefined);
        });
    });

    it('should return 200 when If-None-Match does not match ETag', async () => {
      const chunkRetrievalService = mockService({
        source: 'cache',
        hash: Buffer.from('dGVzdC1oYXNo', 'base64url'),
      });

      app.get(
        CHUNK_OFFSET_PATH,
        createChunkOffsetHandler({ chunkRetrievalService, log }),
      );

      await request(app)
        .get('/chunk/1234')
        .set('If-None-Match', '"different-hash"')
        .expect(200)
        .then((res: any) => {
          assert.strictEqual(res.status, 200);
          assert.ok(res.body.chunk);
          assert.strictEqual(res.header['etag'], jsonEtag);
          assert.strictEqual(res.header['content-digest'], jsonContentDigest);
        });
    });

    it('should return 200 when If-None-Match is set but no ETag available', async () => {
      const chunkRetrievalService = mockService({
        source: 'network',
        // No hash, so no ETag
      });

      app.get(
        CHUNK_OFFSET_PATH,
        createChunkOffsetHandler({ chunkRetrievalService, log }),
      );

      await request(app)
        .get('/chunk/1234')
        .set('If-None-Match', '"some-hash"')
        .expect(200)
        .then((res: any) => {
          assert.strictEqual(res.status, 200);
          assert.ok(res.body.chunk);
          // ETag is now derived from the JSON body (always available), so
          // the request's mismatched If-None-Match returns 200 with the
          // computed ETag instead of 304.
          assert.strictEqual(
            res.header['etag'],
            expectedJsonEtag({
              chunk: DEFAULT_MOCK_CHUNK,
              data_path: DEFAULT_MOCK_DATA_PATH,
            }),
          );
          assert.strictEqual(
            res.header['content-digest'],
            expectedJsonContentDigest({
              chunk: DEFAULT_MOCK_CHUNK,
              data_path: DEFAULT_MOCK_DATA_PATH,
            }),
          );
        });
    });
  });

  describe('Cache status headers', () => {
    it('should set X-AR-IO-Cache-Status to HIT when cached', async () => {
      const chunkRetrievalService = mockService({ source: 'cache' });

      app.get(
        CHUNK_OFFSET_PATH,
        createChunkOffsetHandler({ chunkRetrievalService, log }),
      );

      await request(app)
        .get('/chunk/1234')
        .expect(200)
        .then((res: any) => {
          assert.strictEqual(res.header['x-cache'], 'HIT');
        });
    });

    it('should set X-AR-IO-Cache-Status to MISS when not cached', async () => {
      const chunkRetrievalService = mockService({ source: 'network' });

      app.get(
        CHUNK_OFFSET_PATH,
        createChunkOffsetHandler({ chunkRetrievalService, log }),
      );

      await request(app)
        .get('/chunk/1234')
        .expect(200)
        .then((res: any) => {
          assert.strictEqual(res.header['x-cache'], 'MISS');
        });
    });
  });

  describe('Raw binary data endpoint (/chunk/:offset/data)', () => {
    const CHUNK_DATA_PATH = '/chunk/:offset(\\d+)/data';

    // Note: These are basic unit tests focusing on error handling.
    // Comprehensive integration tests with real chunk data and merkle path
    // validation should be added separately as the parseDataPath function
    // requires cryptographically valid test data.

    it('should return 400 for invalid (non-numeric) offset', async () => {
      const chunkRetrievalService = mockService({});

      app.get(
        CHUNK_DATA_PATH,
        createChunkOffsetDataHandler({ chunkRetrievalService, log }),
      );

      await request(app).get('/chunk/invalid-offset/data').expect(404); // Express routing returns 404 for non-matching pattern
    });

    it('should return 404 if transaction not found', async () => {
      const chunkRetrievalService = mockNotFoundService(
        'No TX boundary found',
        'boundary_not_found',
      );

      app.get(
        CHUNK_DATA_PATH,
        createChunkOffsetDataHandler({ chunkRetrievalService, log }),
      );

      await request(app).get('/chunk/1234/data').expect(404);
    });

    it('should return 404 if chunk source throws error', async () => {
      const chunkRetrievalService = mockNotFoundService(
        'Chunk fetch failed',
        'fetch_failed',
      );

      app.get(
        CHUNK_DATA_PATH,
        createChunkOffsetDataHandler({ chunkRetrievalService, log }),
      );

      await request(app).get('/chunk/524288/data').expect(404);
    });

    it('should return 404 if chunk source returns undefined', async () => {
      const chunkRetrievalService = mockNotFoundService(
        'Chunk fetch failed',
        'fetch_failed',
      );

      app.get(
        CHUNK_DATA_PATH,
        createChunkOffsetDataHandler({ chunkRetrievalService, log }),
      );

      await request(app).get('/chunk/524288/data').expect(404);
    });

    // TODO: Add comprehensive integration tests with real chunk data to test:
    // - Successful GET requests with all headers (including Content-Digest)
    // - HEAD requests with Content-Digest header
    // - ETag support and conditional requests (304)
    // - Cache status headers
    // - Merkle path parsing and offset calculations
    // - Binary data integrity
    // - Content-Digest RFC 9530 format validation (sha-256=:base64:)
    // - Content-Digest only present when cached or HEAD request
  });
});

describe('determineFailureStatusCode', () => {
  it('should return 500 when no peers were contacted', () => {
    assert.strictEqual(determineFailureStatusCode([]), 500);
  });

  it('should return 500 when all peers were skipped', () => {
    const results = [
      {
        peer: 'http://peer1',
        success: false,
        statusCode: 0,
        canceled: false,
        timedOut: false,
        skipped: true,
      },
      {
        peer: 'http://peer2',
        success: false,
        statusCode: 0,
        canceled: false,
        timedOut: false,
        skipped: true,
      },
    ];
    assert.strictEqual(determineFailureStatusCode(results), 500);
  });

  it('should return 400 when all peers return 400', () => {
    const results = [
      {
        peer: 'http://peer1',
        success: false,
        statusCode: 400,
        canceled: false,
        timedOut: false,
      },
      {
        peer: 'http://peer2',
        success: false,
        statusCode: 400,
        canceled: false,
        timedOut: false,
      },
      {
        peer: 'http://peer3',
        success: false,
        statusCode: 400,
        canceled: false,
        timedOut: false,
      },
    ];
    assert.strictEqual(determineFailureStatusCode(results), 400);
  });

  it('should return 500 when all peers return 500', () => {
    const results = [
      {
        peer: 'http://peer1',
        success: false,
        statusCode: 500,
        canceled: false,
        timedOut: false,
      },
      {
        peer: 'http://peer2',
        success: false,
        statusCode: 500,
        canceled: false,
        timedOut: false,
      },
    ];
    assert.strictEqual(determineFailureStatusCode(results), 500);
  });

  it('should return most common status code (400 over 500)', () => {
    const results = [
      {
        peer: 'http://peer1',
        success: false,
        statusCode: 400,
        canceled: false,
        timedOut: false,
      },
      {
        peer: 'http://peer2',
        success: false,
        statusCode: 400,
        canceled: false,
        timedOut: false,
      },
      {
        peer: 'http://peer3',
        success: false,
        statusCode: 400,
        canceled: false,
        timedOut: false,
      },
      {
        peer: 'http://peer4',
        success: false,
        statusCode: 500,
        canceled: false,
        timedOut: false,
      },
      {
        peer: 'http://peer5',
        success: false,
        statusCode: 500,
        canceled: false,
        timedOut: false,
      },
    ];
    assert.strictEqual(determineFailureStatusCode(results), 400);
  });

  it('should prefer lowest 4xx when tied', () => {
    const results = [
      {
        peer: 'http://peer1',
        success: false,
        statusCode: 400,
        canceled: false,
        timedOut: false,
      },
      {
        peer: 'http://peer2',
        success: false,
        statusCode: 400,
        canceled: false,
        timedOut: false,
      },
      {
        peer: 'http://peer3',
        success: false,
        statusCode: 429,
        canceled: false,
        timedOut: false,
      },
      {
        peer: 'http://peer4',
        success: false,
        statusCode: 429,
        canceled: false,
        timedOut: false,
      },
    ];
    assert.strictEqual(determineFailureStatusCode(results), 400);
  });

  it('should prefer 4xx over 5xx when tied', () => {
    const results = [
      {
        peer: 'http://peer1',
        success: false,
        statusCode: 400,
        canceled: false,
        timedOut: false,
      },
      {
        peer: 'http://peer2',
        success: false,
        statusCode: 500,
        canceled: false,
        timedOut: false,
      },
    ];
    assert.strictEqual(determineFailureStatusCode(results), 400);
  });

  it('should return 504 when all peers timeout', () => {
    const results = [
      {
        peer: 'http://peer1',
        success: false,
        statusCode: 0,
        canceled: false,
        timedOut: true,
      },
      {
        peer: 'http://peer2',
        success: false,
        statusCode: 0,
        canceled: false,
        timedOut: true,
      },
    ];
    assert.strictEqual(determineFailureStatusCode(results), 504);
  });

  it('should return 502 when all peers have network errors', () => {
    const results = [
      {
        peer: 'http://peer1',
        success: false,
        statusCode: 0,
        canceled: false,
        timedOut: false,
      },
      {
        peer: 'http://peer2',
        success: false,
        statusCode: 0,
        canceled: false,
        timedOut: false,
      },
    ];
    assert.strictEqual(determineFailureStatusCode(results), 502);
  });

  it('should return 499 when all peers are canceled', () => {
    const results = [
      {
        peer: 'http://peer1',
        success: false,
        statusCode: 0,
        canceled: true,
        timedOut: false,
      },
      {
        peer: 'http://peer2',
        success: false,
        statusCode: 0,
        canceled: true,
        timedOut: false,
      },
    ];
    assert.strictEqual(determineFailureStatusCode(results), 499);
  });

  it('should exclude skipped peers from calculation', () => {
    const results = [
      {
        peer: 'http://peer1',
        success: false,
        statusCode: 400,
        canceled: false,
        timedOut: false,
      },
      {
        peer: 'http://peer2',
        success: false,
        statusCode: 0,
        canceled: false,
        timedOut: false,
        skipped: true,
      },
      {
        peer: 'http://peer3',
        success: false,
        statusCode: 0,
        canceled: false,
        timedOut: false,
        skipped: true,
      },
    ];
    assert.strictEqual(determineFailureStatusCode(results), 400);
  });

  it('should handle mixed results correctly', () => {
    const results = [
      {
        peer: 'http://peer1',
        success: false,
        statusCode: 400,
        canceled: false,
        timedOut: false,
      },
      {
        peer: 'http://peer2',
        success: false,
        statusCode: 400,
        canceled: false,
        timedOut: false,
      },
      {
        peer: 'http://peer3',
        success: false,
        statusCode: 0,
        canceled: false,
        timedOut: true,
      }, // timeout -> 504
      {
        peer: 'http://peer4',
        success: false,
        statusCode: 500,
        canceled: false,
        timedOut: false,
      },
    ];
    // 400 appears twice, others appear once
    assert.strictEqual(determineFailureStatusCode(results), 400);
  });

  it('should exclude successful peers from calculation', () => {
    const results = [
      {
        peer: 'http://peer1',
        success: true,
        statusCode: 200,
        canceled: false,
        timedOut: false,
      },
      {
        peer: 'http://peer2',
        success: true,
        statusCode: 200,
        canceled: false,
        timedOut: false,
      },
      {
        peer: 'http://peer3',
        success: false,
        statusCode: 400,
        canceled: false,
        timedOut: false,
      },
      {
        peer: 'http://peer4',
        success: false,
        statusCode: 500,
        canceled: false,
        timedOut: false,
      },
    ];
    // Even though 200 is most common, we only count failures
    // Between 400 and 500 (tied), 4xx is preferred
    assert.strictEqual(determineFailureStatusCode(results), 400);
  });

  it('should return 500 when all contacted peers succeeded', () => {
    const results = [
      {
        peer: 'http://peer1',
        success: true,
        statusCode: 200,
        canceled: false,
        timedOut: false,
      },
      {
        peer: 'http://peer2',
        success: true,
        statusCode: 200,
        canceled: false,
        timedOut: false,
      },
    ];
    // No failed peers to aggregate, return default 500
    assert.strictEqual(determineFailureStatusCode(results), 500);
  });

  it('should prefer lowest 5xx when tied', () => {
    const results = [
      {
        peer: 'http://peer1',
        success: false,
        statusCode: 500,
        canceled: false,
        timedOut: false,
      },
      {
        peer: 'http://peer2',
        success: false,
        statusCode: 500,
        canceled: false,
        timedOut: false,
      },
      {
        peer: 'http://peer3',
        success: false,
        statusCode: 503,
        canceled: false,
        timedOut: false,
      },
      {
        peer: 'http://peer4',
        success: false,
        statusCode: 503,
        canceled: false,
        timedOut: false,
      },
    ];
    assert.strictEqual(determineFailureStatusCode(results), 500);
  });
});
