/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import * as winston from 'winston';

import {
  ArweaveChainSourceStub,
  ArweaveChunkSourceStub,
} from '../../test/stubs.js';
import { TxChunksDataSource } from './tx-chunks-data-source.js';
import { RequestAttributes } from '../types.js';
import * as metrics from '../metrics.js';

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

  beforeEach(() => {
    mock.method(metrics.getDataErrorsTotal, 'inc');
    mock.method(metrics.getDataStreamErrorsTotal, 'inc');
    mock.method(metrics.getDataStreamSuccessesTotal, 'inc');
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

        assert.equal(
          (metrics.getDataErrorsTotal.inc as any).mock.callCount(),
          1,
        );
        assert.equal(
          (metrics.getDataErrorsTotal.inc as any).mock.calls[0].arguments[0]
            .class,
          'TxChunksDataSource',
        );
      });
    });

    describe('a valid transaction id', () => {
      it('should return chunk data of the correct size for a known chunk', async () => {
        const data = await txChunkRetriever.getData({
          id: TX_ID,
          requestAttributes,
        });

        let bytes = 0;
        for await (const chunk of data.stream) {
          bytes += chunk.length;
        }

        assert.strictEqual(bytes, data.size);
        assert.equal(
          (metrics.getDataStreamSuccessesTotal.inc as any).mock.callCount(),
          1,
        );
        assert.equal(
          (metrics.getDataStreamSuccessesTotal.inc as any).mock.calls[0]
            .arguments[0].class,
          'TxChunksDataSource',
        );
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
      it('should throw an error', async () => {
        const error = new Error('missing chunk');
        mock.method(chunkSource, 'getChunkDataByAny', () =>
          Promise.reject(error),
        );

        try {
          const data = await txChunkRetriever.getData({
            id: TX_ID,
            requestAttributes,
          });

          for await (const _chunk of data.stream) {
            // do nothing
          }
        } catch (e) {
          assert.strictEqual(e, error);
        }
      });

      describe('an invalid chunk', () => {
        it('should throw an error', async () => {
          const error = new Error('Invalid chunk');
          mock.method(chunkSource, 'getChunkByAny', () =>
            Promise.reject(error),
          );

          try {
            const data = await txChunkRetriever.getData({
              id: TX_ID,
              requestAttributes,
            });

            for await (const _chunk of data.stream) {
              // do nothing
            }
          } catch (e) {
            assert.strictEqual(e, error);
          }
        });
      });
    });
  });
});
