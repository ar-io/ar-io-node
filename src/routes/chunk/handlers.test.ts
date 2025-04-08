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
    const chunkDataSource: any = {
      getChunkDataByAny: async () => ({
        chunk: Buffer.from('chunk data'),
      }),
    };

    const chunkMetaDataSource: any = {
      getChunkMetadataByAny: async () => ({
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
        chunkDataSource,
        chunkMetaDataSource,
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
        });
      });
  });

  it('should return 404 for an invalid (non-numeric) offset', async () => {
    app.get(
      CHUNK_OFFSET_PATH,
      createChunkOffsetHandler({
        chunkDataSource: {} as any,
        chunkMetaDataSource: {} as any,
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
        chunkDataSource: {} as any,
        chunkMetaDataSource: {} as any,
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

  it('should return 404 if chunk data source throws an (ex. http) error', async () => {
    const chunkDataSource: any = {
      getChunkDataByAny: async () => {
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
        chunkDataSource,
        chunkMetaDataSource: {} as any,
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

  it('should return 500 if chunk data source returns undefined', async () => {
    const chunkDataSource: any = {
      getChunkDataByAny: async () => ({ chunk: undefined }),
    };

    const chunkMetaDataSource: any = {
      getChunkMetadataByAny: async () => ({
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
        chunkDataSource,
        chunkMetaDataSource,
        log,
        db,
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

  it('should return 500 if the chunk is not a valid Buffer (simulate base64 conversion issue)', async () => {
    // This test artificially simulates a scenario where `chunk`
    // is not a Buffer. The typical code tries `Buffer.from(chunk).toString('base64')`,
    // which would fail if chunk is not a valid buffer/string.
    const chunkDataSource: any = {
      getChunkDataByAny: async () => ({
        chunk: 1234, // Not a Buffer or string
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
        chunkDataSource,
        chunkMetaDataSource: {} as any,
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
});
