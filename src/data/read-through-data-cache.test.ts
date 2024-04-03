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
import { Readable, Writable } from 'node:stream';
import sinon, { SinonSandbox, SinonStubbedInstance } from 'sinon';
import sinonChai from 'sinon-chai';
import * as winston from 'winston';
import {
  ContiguousDataIndex,
  ContiguousDataSource,
  ContiguousDataStore,
} from '../types.js';
import { ReadThroughDataCache } from './read-through-data-cache.js';

chai.use(sinonChai);

describe('ReadThroughDataCache', function () {
  let log: winston.Logger;
  let sandbox: SinonSandbox;
  let dataSourceStub: SinonStubbedInstance<ContiguousDataSource>;
  let dataStoreStub: SinonStubbedInstance<ContiguousDataStore>;
  let contiguousDataIndexStub: SinonStubbedInstance<ContiguousDataIndex>;
  let readThroughDataCache: ReadThroughDataCache;

  beforeEach(function () {
    log = winston.createLogger({ silent: true });
    sandbox = sinon.createSandbox();
    dataSourceStub = {
      getData: sandbox.stub(),
    };
    dataStoreStub = {
      get: sinon.stub(),
      createWriteStream: sinon.stub(),
      finalize: sandbox.stub().resolves(),
    } as any;
    contiguousDataIndexStub = {
      getDataParent: sandbox.stub(),
      getDataAttributes: sandbox.stub(),
      saveDataContentAttributes: sandbox.stub(),
    };

    readThroughDataCache = new ReadThroughDataCache({
      log,
      dataSource: dataSourceStub,
      dataStore: dataStoreStub,
      contiguousDataIndex: contiguousDataIndexStub,
    });
  });

  afterEach(function () {
    sandbox.restore();
  });

  describe('getCachedData', function () {
    it('should return data from cache when available', async function () {
      const mockStream = new Readable();
      mockStream.push('cached data');
      mockStream.push(null);
      dataStoreStub.get.resolves(mockStream);

      const result = await readThroughDataCache.getCacheData(
        'test-id',
        'test-hash',
        123,
      );

      expect(dataStoreStub.get).to.have.been.calledWith('test-hash');
      expect(result).to.have.property('stream').that.equals(mockStream);
      expect(result).to.have.property('size', 123);
    });

    it('should return undefined when data is not found in cache', async function () {
      dataStoreStub.get.resolves(undefined);

      const result = await readThroughDataCache.getCacheData(
        'test-id',
        'test-hash',
        123,
      );

      expect(dataStoreStub.get).to.have.been.calledWith('test-hash');
      expect(result).to.be.undefined;
    });

    it('should return parent if found in cache when data is not found in cache', async function () {
      const mockStream = new Readable();
      mockStream.push('cached data');
      mockStream.push(null);
      dataStoreStub.get.withArgs('test-hash').resolves(undefined);
      dataStoreStub.get.withArgs('test-parent-hash').resolves(mockStream);
      contiguousDataIndexStub.getDataParent.resolves({
        parentId: 'test-parent-id',
        parentHash: 'test-parent-hash',
        offset: 0,
        size: 10,
      });

      const result = await readThroughDataCache.getCacheData(
        'test-id',
        'test-hash',
        20,
      );

      expect(dataStoreStub.get).to.have.been.calledWith('test-hash');
      expect(dataStoreStub.get).to.have.been.calledWith('test-parent-hash');
      expect(result).to.have.property('stream').that.equals(mockStream);
      expect(result).to.have.property('size', 20);
    });
  });

  describe('getData', function () {
    it('should fetch cached data successfully', async function () {
      contiguousDataIndexStub.getDataAttributes.resolves({
        hash: 'test-hash',
        size: 100,
        contentType: 'plain/text',
        isManifest: false,
        stable: true,
        verified: true,
      });
      dataStoreStub.get.resolves(
        new Readable({
          read() {
            this.push('test data');
            this.push(null);
          },
        }),
      );

      const result = await readThroughDataCache.getData('test-id');

      expect(result).to.have.property('hash', 'test-hash');
      expect(result).to.have.property('stream').that.is.instanceOf(Readable);
      expect(result).to.have.property('size', 100);
      expect(result).to.have.property('sourceContentType', 'plain/text');
      expect(result).to.have.property('verified', true);
      expect(result).to.have.property('cached', true);
      expect(dataStoreStub.get).to.have.been.calledWith('test-hash');
    });

    it('should fetch data from the source and cache it when not available in cache', async function () {
      dataStoreStub.get.resolves(undefined);
      dataStoreStub.createWriteStream.resolves(
        new Writable({
          write(_, __, callback) {
            callback();
          },
        }),
      );
      dataSourceStub.getData.resolves({
        hash: 'test-hash',
        stream: new Readable({
          read() {
            this.push('test data');
            this.push(null);
          },
        }),
        size: 99,
        verified: true,
        sourceContentType: 'plain/text',
        cached: false,
      });

      const result = await readThroughDataCache.getData('test-id');

      expect(dataSourceStub.getData).to.have.been.calledOnceWith('test-id');
      expect(dataStoreStub.createWriteStream).to.have.been.calledOnce;

      expect(result).to.have.property('hash', 'test-hash');
      expect(result).to.have.property('stream').that.is.instanceOf(Readable);
      expect(result).to.have.property('size', 99);
      expect(result).to.have.property('sourceContentType', 'plain/text');
      expect(result).to.have.property('verified', true);
      expect(result).to.have.property('cached', false);
    });
  });
});
