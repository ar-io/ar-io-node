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
import { CHUNK_OFFSET_PATH } from './constants.js';
import { createChunkOffsetHandler } from './handlers.js';

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
        db,
      }),
    );

    return request(app)
      .get('/chunk/274995392586018')
      .expect(200)
      .then((res: any) => {
        assert.strictEqual(res.status, 200);
        assert.strictEqual(
          res.header['content-type'],
          'application/json; charset=utf-8',
        );
        assert.deepEqual(res.body, {
          chunk: 'Y2h1bmsgZGF0YQ',
        });
      });
  });
});
