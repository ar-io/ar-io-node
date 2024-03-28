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
import chai, { expect } from 'chai';
import { Readable } from 'node:stream';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import * as winston from 'winston';

import {
  ArweaveChainSourceStub,
  ArweaveChunkSourceStub,
} from '../../test/stubs.js';
import { TxChunksDataSource } from './tx-chunks-data-source.js';

chai.use(sinonChai);
const TX_ID = '----LT69qUmuIeC4qb0MZHlxVp7UxLu_14rEkA_9n6w';

describe('TxChunksDataSource', () => {
  let log: winston.Logger;
  let chainSource: ArweaveChainSourceStub;
  let chunkSource: ArweaveChunkSourceStub;
  let txChunkRetriever: TxChunksDataSource;

  before(() => {
    log = winston.createLogger({ silent: true });
    chainSource = new ArweaveChainSourceStub();
    chunkSource = new ArweaveChunkSourceStub();
    txChunkRetriever = new TxChunksDataSource({
      log,
      chainSource,
      chunkSource,
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('getContiguousData', () => {
    describe('an invalid transaction id', () => {
      it('should throw an error', async () => {
        await expect(txChunkRetriever.getData('bad-tx-id')).to.be.rejectedWith(
          Error,
        );
      });
    });

    describe('a valid transaction id', () => {
      it('should return chunk data of the correct size for a known chunk', (done) => {
        txChunkRetriever
          .getData(TX_ID)
          .then((res: { stream: Readable; size: number }) => {
            const { stream, size } = res;
            let bytes = 0;
            stream.on('error', (error: any) => {
              done(error);
            });
            stream.on('data', (c) => {
              bytes += c.length;
            });
            stream.on('end', () => {
              expect(bytes).to.equal(size);
              done();
            });
          });
      });

      it('should return cached property as false', async () => {
        const result = await txChunkRetriever.getData(TX_ID);

        expect(result).to.have.property('cached', false);
      });
    });

    describe('a bad piece of chunk data', () => {
      it('should throw an error', function (done) {
        const error = new Error('missing chunk');
        sinon.stub(chunkSource, 'getChunkDataByAny').rejects(error);
        txChunkRetriever
          .getData(TX_ID)
          .then((res: { stream: Readable; size: number }) => {
            const { stream } = res;
            stream.on('error', (e: any) => {
              expect(e).to.deep.equal(error);
              done();
            });
            // do nothing
            stream.on('data', () => {
              return;
            });
          });
      });

      describe('an invalid chunk', () => {
        it('should throw an error', function (done) {
          const error = new Error('Invalid chunk');
          sinon.stub(chunkSource, 'getChunkByAny').rejects(error);
          txChunkRetriever
            .getData(TX_ID)
            .then((res: { stream: Readable; size: number }) => {
              const { stream } = res;
              stream.on('error', (error: any) => {
                expect(error).to.deep.equal(error);
                done();
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
