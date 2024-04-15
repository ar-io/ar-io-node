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
import { afterEach, before, describe, it, mock } from 'node:test';
import { Readable } from 'node:stream';
import * as winston from 'winston';

import {
  ArweaveChainSourceStub,
  ArweaveChunkSourceStub,
} from '../../test/stubs.js';
import { TxChunksDataSource } from './tx-chunks-data-source.js';
import { RequestAttributes } from '../types.js';

const TX_ID = '----LT69qUmuIeC4qb0MZHlxVp7UxLu_14rEkA_9n6w';

describe('TxChunksDataSource', () => {
  let log: winston.Logger;
  let chainSource: ArweaveChainSourceStub;
  let chunkSource: ArweaveChunkSourceStub;
  let txChunkRetriever: TxChunksDataSource;
  let requestAttributes: RequestAttributes;

  before(() => {
    log = winston.createLogger({ silent: true });
    chainSource = new ArweaveChainSourceStub();
    chunkSource = new ArweaveChunkSourceStub();
    txChunkRetriever = new TxChunksDataSource({
      log,
      chainSource,
      chunkSource,
    });
    requestAttributes = { origin: 'node-url', hops: 0 };
  });

  afterEach(() => {
    mock.restoreAll();
  });

  describe('getContiguousData', () => {
    describe('an invalid transaction id', () => {
      it('should throw an error', async () => {
        await assert.rejects(
          async () => {
            await txChunkRetriever.getData({
              id: 'bad-tx-id',
              requestAttributes,
            });
          },
          {
            name: 'Error',
            message: 'Offset for bad-tx-id not found',
          },
        );
      });
    });

    describe('a valid transaction id', () => {
      it('should return chunk data of the correct size for a known chunk', () => {
        txChunkRetriever
          .getData({
            id: TX_ID,
            requestAttributes,
          })
          .then((res: { stream: Readable; size: number }) => {
            const { stream, size } = res;
            let bytes = 0;
            stream.on('data', (c) => {
              bytes += c.length;
            });
            stream.on('end', () => {
              assert.strictEqual(bytes, size);
            });
          });
      });

      it('should return cached property as false', async () => {
        const result = await txChunkRetriever.getData({
          id: TX_ID,
          requestAttributes,
        });

        assert.strictEqual(result.cached, false);
      });
    });

    describe('a bad piece of chunk data', () => {
      it('should throw an error', () => {
        const error = new Error('missing chunk');
        mock.method(chunkSource, 'getChunkDataByAny', () =>
          Promise.reject(error),
        );
        txChunkRetriever
          .getData({ id: TX_ID, requestAttributes })
          .then((res: { stream: Readable; size: number }) => {
            const { stream } = res;
            stream.on('error', (e: any) => {
              assert.strictEqual(e, error);
            });
            // do nothing
            stream.on('data', () => {
              return;
            });
          });
      });

      describe('an invalid chunk', () => {
        it('should throw an error', () => {
          const error = new Error('Invalid chunk');
          mock.method(chunkSource, 'getChunkByAny', () =>
            Promise.reject(error),
          );
          txChunkRetriever
            .getData({ id: TX_ID, requestAttributes })
            .then((res: { stream: Readable; size: number }) => {
              const { stream } = res;
              stream.on('error', (error: any) => {
                assert.strictEqual(error, error);
              });
              // do nothing
              stream.on('data', () => {
                return;
              });
            });
        });
      });
    });
  });
});
