/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import express from 'express';
import { default as request } from 'supertest';
import { createChunkOffsetHandler } from './handlers.js';
import log from '../../log.js';

const CHUNK_OFFSET_PATH = '/chunk/:offset(\\d+)';

describe('Chunk routes', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it('should return 200 for a valid chunk request', async () => {
    const chunkSource: any = {
      getChunkByAny: async () => ({
        chunk: Buffer.from('chunk data'),
        data_path: Buffer.from('12345abc'),
        source: 'cache',
      }),
    };

    const db: any = {
      getTxByOffset: () => ({
        data_root: 'abc1234',
        data_size: 100,
        offset: 0,
        id: 'foobarbaz',
      }),
    };

    app.get(
      CHUNK_OFFSET_PATH,
      createChunkOffsetHandler({
        chunkSource,
        db,
        log,
      }),
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
          chunk: 'Y2h1bmsgZGF0YQ', // base64 of "chunk data"
          data_path: 'MTIzNDVhYmM',
          packing: 'unpacked',
        });
      });
  });

  it('should return 404 for an invalid (non-numeric) offset', async () => {
    app.get(
      CHUNK_OFFSET_PATH,
      createChunkOffsetHandler({
        chunkSource: {} as any,
        db: {} as any,
        log,
      }),
    );

    await request(app)
      .get('/chunk/invalid-offset')
      .expect(404)
      .then((res: any) => {
        assert.strictEqual(res.status, 404);
      });
  });

  it('should return 404 if DB returns undefined (transaction not found)', async () => {
    const db: any = {
      getTxByOffset: () => ({
        data_root: undefined,
        data_size: 100,
        offset: 0,
        id: 'foobarbaz',
      }),
    };

    app.get(
      CHUNK_OFFSET_PATH,
      createChunkOffsetHandler({
        chunkSource: {} as any,
        db,
        log,
      }),
    );

    await request(app)
      .get('/chunk/1234')
      .expect(404)
      .then((res: any) => {
        assert.strictEqual(res.status, 404);
        assert.strictEqual(res.text, 'Not Found');
      });
  });

  it('should return 404 if chunk source throws an (ex. http) error', async () => {
    const chunkSource: any = {
      getChunkByAny: async () => {
        throw new Error('Something went wrong');
      },
    };

    const db: any = {
      getTxByOffset: () => ({
        data_root: 'abc1234',
        data_size: 100,
        offset: 0,
        id: 'foobarbaz',
      }),
    };

    app.get(
      CHUNK_OFFSET_PATH,
      createChunkOffsetHandler({
        chunkSource,
        db,
        log,
      }),
    );

    await request(app)
      .get('/chunk/1234')
      .expect(404)
      .then((res: any) => {
        assert.strictEqual(res.status, 404);
      });
  });

  it('should return 404 if chunk source returns undefined', async () => {
    const chunkSource: any = {
      getChunkByAny: async () => undefined,
    };

    const db: any = {
      getTxByOffset: () => ({
        data_root: 'abc1234',
        data_size: 100,
        offset: 0,
        id: 'foobarbaz',
      }),
    };

    app.get(
      CHUNK_OFFSET_PATH,
      createChunkOffsetHandler({
        chunkSource,
        db,
        log,
      }),
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
    const chunkSource: any = {
      getChunkByAny: async () => ({
        chunk: 1234, // Not a Buffer or string
        data_path: Buffer.from('12345abc'),
      }),
    };

    const db: any = {
      getTxByOffset: () => ({
        data_root: 'abc1234',
        data_size: 100,
        offset: 0,
        id: 'foobarbaz',
      }),
    };

    app.get(
      CHUNK_OFFSET_PATH,
      createChunkOffsetHandler({
        chunkSource,
        db,
        log,
      }),
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
      const chunkSource: any = {
        getChunkByAny: async () => ({
          chunk: Buffer.from('chunk data'),
          data_path: Buffer.from('12345abc'),
          source: 'cache',
          hash: Buffer.from('test-hash'),
        }),
      };

      const db: any = {
        getTxByOffset: () => ({
          data_root: 'abc1234',
          data_size: 100,
          offset: 0,
          id: 'foobarbaz',
        }),
      };

      app.head(
        CHUNK_OFFSET_PATH,
        createChunkOffsetHandler({
          chunkSource,
          db,
          log,
        }),
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
          assert.strictEqual(res.header['etag'], '"test-hash"');
          assert.strictEqual(res.header['x-ar-io-digest'], 'test-hash');
          assert.ok(res.header['content-length']);
          // HEAD request should have no body
          assert.ok(res.text === '' || res.text === undefined);
        });
    });

    it('should return 404 for HEAD request with invalid offset', async () => {
      app.head(
        CHUNK_OFFSET_PATH,
        createChunkOffsetHandler({
          chunkSource: {} as any,
          db: {} as any,
          log,
        }),
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
      const chunkSource: any = {
        getChunkByAny: async () => ({
          chunk: Buffer.from('chunk data'),
          data_path: Buffer.from('12345abc'),
          source: 'network',
          sourceHost: 'example.com',
        }),
      };

      const db: any = {
        getTxByOffset: () => ({
          data_root: 'abc1234',
          data_size: 100,
          offset: 0,
          id: 'foobarbaz',
        }),
      };

      const handler = createChunkOffsetHandler({
        chunkSource,
        db,
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
    it('should include ETag when chunk hash is available and cached', async () => {
      const chunkSource: any = {
        getChunkByAny: async () => ({
          chunk: Buffer.from('chunk data'),
          data_path: Buffer.from('12345abc'),
          source: 'cache',
          hash: Buffer.from('abc123def456'),
        }),
      };

      const db: any = {
        getTxByOffset: () => ({
          data_root: 'abc1234',
          data_size: 100,
          offset: 0,
          id: 'foobarbaz',
        }),
      };

      app.get(
        CHUNK_OFFSET_PATH,
        createChunkOffsetHandler({
          chunkSource,
          db,
          log,
        }),
      );

      await request(app)
        .get('/chunk/1234')
        .expect(200)
        .then((res: any) => {
          assert.strictEqual(res.header['etag'], '"abc123def456"');
          assert.strictEqual(res.header['x-ar-io-digest'], 'abc123def456');
        });
    });

    it('should include ETag for HEAD request regardless of cache status', async () => {
      const chunkSource: any = {
        getChunkByAny: async () => ({
          chunk: Buffer.from('chunk data'),
          data_path: Buffer.from('12345abc'),
          source: 'network', // Not cached
          hash: Buffer.from('abc123def456'),
        }),
      };

      const db: any = {
        getTxByOffset: () => ({
          data_root: 'abc1234',
          data_size: 100,
          offset: 0,
          id: 'foobarbaz',
        }),
      };

      app.head(
        CHUNK_OFFSET_PATH,
        createChunkOffsetHandler({
          chunkSource,
          db,
          log,
        }),
      );

      await request(app)
        .head('/chunk/1234')
        .expect(200)
        .then((res: any) => {
          assert.strictEqual(res.header['etag'], '"abc123def456"');
          assert.strictEqual(res.header['x-ar-io-digest'], 'abc123def456');
          assert.strictEqual(res.header['x-cache'], 'MISS');
        });
    });

    it('should not include ETag when chunk hash is unavailable', async () => {
      const chunkSource: any = {
        getChunkByAny: async () => ({
          chunk: Buffer.from('chunk data'),
          data_path: Buffer.from('12345abc'),
          source: 'network',
          // No hash field
        }),
      };

      const db: any = {
        getTxByOffset: () => ({
          data_root: 'abc1234',
          data_size: 100,
          offset: 0,
          id: 'foobarbaz',
        }),
      };

      app.get(
        CHUNK_OFFSET_PATH,
        createChunkOffsetHandler({
          chunkSource,
          db,
          log,
        }),
      );

      await request(app)
        .get('/chunk/1234')
        .expect(200)
        .then((res: any) => {
          // Express may set a weak ETag automatically, but we should not have our strong ETag
          assert.ok(!res.header['etag'] || res.header['etag'].startsWith('W/'));
          assert.strictEqual(res.header['x-ar-io-digest'], undefined);
        });
    });

    it('should not include ETag for GET from network when hash available but not cached', async () => {
      const chunkSource: any = {
        getChunkByAny: async () => ({
          chunk: Buffer.from('chunk data'),
          data_path: Buffer.from('12345abc'),
          source: 'network',
          hash: Buffer.from('abc123def456'),
        }),
      };

      const db: any = {
        getTxByOffset: () => ({
          data_root: 'abc1234',
          data_size: 100,
          offset: 0,
          id: 'foobarbaz',
        }),
      };

      app.get(
        CHUNK_OFFSET_PATH,
        createChunkOffsetHandler({
          chunkSource,
          db,
          log,
        }),
      );

      await request(app)
        .get('/chunk/1234')
        .expect(200)
        .then((res: any) => {
          // No strong ETag for streamed network data on GET (Express may add weak ETag)
          assert.ok(!res.header['etag'] || res.header['etag'].startsWith('W/'));
          assert.strictEqual(res.header['x-ar-io-digest'], undefined);
          assert.strictEqual(res.header['x-cache'], 'MISS');
        });
    });
  });

  describe('If-None-Match conditional requests', () => {
    it('should return 304 when If-None-Match matches ETag for GET', async () => {
      const chunkSource: any = {
        getChunkByAny: async () => ({
          chunk: Buffer.from('chunk data'),
          data_path: Buffer.from('12345abc'),
          source: 'cache',
          hash: Buffer.from('test-hash'),
        }),
      };

      const db: any = {
        getTxByOffset: () => ({
          data_root: 'abc1234',
          data_size: 100,
          offset: 0,
          id: 'foobarbaz',
        }),
      };

      app.get(
        CHUNK_OFFSET_PATH,
        createChunkOffsetHandler({
          chunkSource,
          db,
          log,
        }),
      );

      await request(app)
        .get('/chunk/1234')
        .set('If-None-Match', '"test-hash"')
        .expect(304)
        .then((res: any) => {
          assert.strictEqual(res.status, 304);
          // 304 responses should not have Content-Length
          assert.strictEqual(res.header['content-length'], undefined);
          assert.ok(res.text === '' || res.text === undefined);
        });
    });

    it('should return 304 when If-None-Match matches ETag for HEAD', async () => {
      const chunkSource: any = {
        getChunkByAny: async () => ({
          chunk: Buffer.from('chunk data'),
          data_path: Buffer.from('12345abc'),
          source: 'cache',
          hash: Buffer.from('test-hash'),
        }),
      };

      const db: any = {
        getTxByOffset: () => ({
          data_root: 'abc1234',
          data_size: 100,
          offset: 0,
          id: 'foobarbaz',
        }),
      };

      app.head(
        CHUNK_OFFSET_PATH,
        createChunkOffsetHandler({
          chunkSource,
          db,
          log,
        }),
      );

      await request(app)
        .head('/chunk/1234')
        .set('If-None-Match', '"test-hash"')
        .expect(304)
        .then((res: any) => {
          assert.strictEqual(res.status, 304);
          assert.strictEqual(res.header['content-length'], undefined);
          assert.ok(res.text === '' || res.text === undefined);
        });
    });

    it('should return 200 when If-None-Match does not match ETag', async () => {
      const chunkSource: any = {
        getChunkByAny: async () => ({
          chunk: Buffer.from('chunk data'),
          data_path: Buffer.from('12345abc'),
          source: 'cache',
          hash: Buffer.from('test-hash'),
        }),
      };

      const db: any = {
        getTxByOffset: () => ({
          data_root: 'abc1234',
          data_size: 100,
          offset: 0,
          id: 'foobarbaz',
        }),
      };

      app.get(
        CHUNK_OFFSET_PATH,
        createChunkOffsetHandler({
          chunkSource,
          db,
          log,
        }),
      );

      await request(app)
        .get('/chunk/1234')
        .set('If-None-Match', '"different-hash"')
        .expect(200)
        .then((res: any) => {
          assert.strictEqual(res.status, 200);
          assert.ok(res.body.chunk);
          assert.strictEqual(res.header['etag'], '"test-hash"');
        });
    });

    it('should return 200 when If-None-Match is set but no ETag available', async () => {
      const chunkSource: any = {
        getChunkByAny: async () => ({
          chunk: Buffer.from('chunk data'),
          data_path: Buffer.from('12345abc'),
          source: 'network',
          // No hash, so no ETag
        }),
      };

      const db: any = {
        getTxByOffset: () => ({
          data_root: 'abc1234',
          data_size: 100,
          offset: 0,
          id: 'foobarbaz',
        }),
      };

      app.get(
        CHUNK_OFFSET_PATH,
        createChunkOffsetHandler({
          chunkSource,
          db,
          log,
        }),
      );

      await request(app)
        .get('/chunk/1234')
        .set('If-None-Match', '"some-hash"')
        .expect(200)
        .then((res: any) => {
          assert.strictEqual(res.status, 200);
          assert.ok(res.body.chunk);
          // Express may set a weak ETag, but we should not have a strong one matching our hash
          assert.ok(!res.header['etag'] || res.header['etag'].startsWith('W/'));
        });
    });
  });

  describe('Cache status headers', () => {
    it('should set X-AR-IO-Cache-Status to HIT when cached', async () => {
      const chunkSource: any = {
        getChunkByAny: async () => ({
          chunk: Buffer.from('chunk data'),
          data_path: Buffer.from('12345abc'),
          source: 'cache',
        }),
      };

      const db: any = {
        getTxByOffset: () => ({
          data_root: 'abc1234',
          data_size: 100,
          offset: 0,
          id: 'foobarbaz',
        }),
      };

      app.get(
        CHUNK_OFFSET_PATH,
        createChunkOffsetHandler({
          chunkSource,
          db,
          log,
        }),
      );

      await request(app)
        .get('/chunk/1234')
        .expect(200)
        .then((res: any) => {
          assert.strictEqual(res.header['x-cache'], 'HIT');
        });
    });

    it('should set X-AR-IO-Cache-Status to MISS when not cached', async () => {
      const chunkSource: any = {
        getChunkByAny: async () => ({
          chunk: Buffer.from('chunk data'),
          data_path: Buffer.from('12345abc'),
          source: 'network',
        }),
      };

      const db: any = {
        getTxByOffset: () => ({
          data_root: 'abc1234',
          data_size: 100,
          offset: 0,
          id: 'foobarbaz',
        }),
      };

      app.get(
        CHUNK_OFFSET_PATH,
        createChunkOffsetHandler({
          chunkSource,
          db,
          log,
        }),
      );

      await request(app)
        .get('/chunk/1234')
        .expect(200)
        .then((res: any) => {
          assert.strictEqual(res.header['x-cache'], 'MISS');
        });
    });
  });
});
