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
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import * as winston from 'winston';
import axios from 'axios';
import { AoARIORead, ARIO } from '@ar.io/sdk';
import { Readable } from 'node:stream';
import { RequestAttributes } from '../types.js';
import { ArIODataSource } from './ar-io-data-source.js';
import * as metrics from '../metrics.js';
import { TestDestroyedReadable, axiosStreamData } from './test-utils.js';

let log: winston.Logger;
let dataSource: ArIODataSource;
let requestAttributes: RequestAttributes;
let mockedArIOInstance: AoARIORead;
let mockedAxiosGet: any;

before(async () => {
  log = winston.createLogger({ silent: true });
});

beforeEach(async () => {
  mockedArIOInstance = {
    getGateways: async () => ({
      items: [
        {
          gatewayAddress: 'peer1',
          settings: { protocol: 'http', fqdn: 'peer1.com' },
        },
        {
          gatewayAddress: 'peer2',
          settings: { protocol: 'https', fqdn: 'peer2.com' },
        },
        {
          gatewayAddress: 'localNode',
          settings: { protocol: 'https', fqdn: 'localNode.com' },
        },
      ],
      hasMore: false,
      nextCursor: undefined,
      sortBy: 'startTimestamp',
      sortOrder: 'desc',
      totalItems: 3,
    }),
  } as any;

  mockedAxiosGet = async () => ({
    status: 200,
    data: axiosStreamData,
    headers: {
      'content-length': '123',
      'content-type': 'application/octet-stream',
    },
  });

  mock.method(ARIO, 'init', () => mockedArIOInstance);

  mock.method(axios, 'get', mockedAxiosGet);

  mock.method(metrics.getDataErrorsTotal, 'inc');
  mock.method(metrics.getDataStreamErrorsTotal, 'inc');
  mock.method(metrics.getDataStreamSuccessesTotal, 'inc');

  dataSource = new ArIODataSource({
    log,
    arIO: ARIO.init(),
    nodeWallet: 'localNode',
  });

  requestAttributes = { origin: 'node-url', hops: 0 };
});

afterEach(async () => {
  dataSource.stopUpdatingPeers();
  mock.restoreAll();
});

describe('ArIODataSource', () => {
  describe('constructor', () => {
    it('should fetch peers and update peer list ignoring the running node as a peer', async () => {
      assert.deepEqual(dataSource.peers, {
        peer1: 'http://peer1.com',
        peer2: 'https://peer2.com',
      });
    });
  });

  describe('selectPeer', () => {
    it('should return a random peer url', async () => {
      const peerUrl = dataSource.selectPeer();
      assert.ok(['http://peer1.com', 'https://peer2.com'].includes(peerUrl));
    });

    it('should throw an error if no peers are available', async () => {
      dataSource.peers = {};
      assert.throws(() => dataSource.selectPeer(), /No peers available/);
    });
  });

  describe('getData', () => {
    it('should return data from a random peer', async () => {
      const data = await dataSource.getData({ id: 'dataId' });

      assert.deepEqual(data, {
        stream: axiosStreamData,
        size: 123,
        verified: false,
        sourceContentType: 'application/octet-stream',
        cached: false,
        requestAttributes: {
          hops: 1,
          origin: undefined,
          originNodeRelease: undefined,
        },
      });

      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      let receivedData = '';

      for await (const chunk of data.stream) {
        receivedData += chunk;
      }

      assert.equal(receivedData, 'mocked stream');
      assert.equal(
        (metrics.getDataStreamSuccessesTotal.inc as any).mock.callCount(),
        1,
      );
      assert.equal(
        (metrics.getDataStreamSuccessesTotal.inc as any).mock.calls[0]
          .arguments[0].class,
        'ArIODataSource',
      );
    });

    it('should retry with a different peer if the first one fails', async () => {
      let firstPeer = true;
      const secondPeerStreamData = Readable.from(['secondPeerData']);
      mock.method(axios, 'get', async () => {
        if (firstPeer) {
          firstPeer = false;
          throw new Error('First peer failed');
        }
        return {
          status: 200,
          data: secondPeerStreamData,
          headers: {
            'content-length': '10',
            'content-type': 'application/octet-stream',
          },
        };
      });

      const data = await dataSource.getData({ id: 'dataId' });

      assert.deepEqual(data, {
        stream: secondPeerStreamData,
        size: 10,
        verified: false,
        sourceContentType: 'application/octet-stream',
        cached: false,
        requestAttributes: {
          hops: 1,
          origin: undefined,
          originNodeRelease: undefined,
        },
      });

      let receivedData = '';

      for await (const chunk of data.stream) {
        receivedData += chunk;
      }

      assert.equal(receivedData, 'secondPeerData');

      assert.equal((metrics.getDataErrorsTotal.inc as any).mock.callCount(), 1);
      assert.equal(
        (metrics.getDataErrorsTotal.inc as any).mock.calls[0].arguments[0]
          .class,
        'ArIODataSource',
      );
      assert.equal(
        (metrics.getDataStreamSuccessesTotal.inc as any).mock.callCount(),
        1,
      );
      assert.equal(
        (metrics.getDataStreamSuccessesTotal.inc as any).mock.calls[0]
          .arguments[0].class,
        'ArIODataSource',
      );
    });

    it('should increment getDataStreamErrorsTotal', async () => {
      mock.method(axios, 'get', async () => ({
        status: 200,
        data: new TestDestroyedReadable(),
        headers: {
          'content-length': '10',
          'content-type': 'application/octet-stream',
        },
      }));

      try {
        const data = await dataSource.getData({ id: 'id' });
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        let receivedData = '';

        for await (const chunk of data.stream) {
          receivedData += chunk;
        }
      } catch (error: any) {
        assert.equal(
          (metrics.getDataStreamErrorsTotal.inc as any).mock.callCount(),
          1,
        );
        assert.equal(
          (metrics.getDataStreamErrorsTotal.inc as any).mock.calls[0]
            .arguments[0].class,
          'ArIODataSource',
        );
        assert.equal(error.message, 'Stream destroyed intentionally');
      }
    });

    it('should increment hops and origin if requestAttributes are provided', async () => {
      const data = await dataSource.getData({
        id: 'dataId',
        requestAttributes: { hops: 2 },
      });

      assert.deepEqual(data, {
        stream: axiosStreamData,
        size: 123,
        verified: false,
        sourceContentType: 'application/octet-stream',
        cached: false,
        requestAttributes: {
          hops: 3,
          origin: undefined,
          originNodeRelease: undefined,
        },
      });
    });

    it('should throw an error if all peers fail', async () => {
      mock.method(axios, 'get', () => {
        throw new Error('All peers failed');
      });

      assert.rejects(
        dataSource.getData({ id: 'dataId' }),
        /Failed to fetch contiguous data from ArIO peers/,
      );
    });

    it('should throw and error if max hops is reached', async () => {
      requestAttributes.hops = 10;

      assert.rejects(
        dataSource.getData({ id: 'dataId', requestAttributes }),
        /Max hops reached/,
      );
    });

    it('should include Range header when region is provided', async () => {
      let rangeHeader: string | undefined;
      mock.method(axios, 'get', async (_: string, config: any) => {
        rangeHeader = config.headers['Range'];
        return {
          status: 200,
          data: axiosStreamData,
          headers: {
            'content-length': '50',
            'content-type': 'application/octet-stream',
          },
        };
      });

      const region = { offset: 100, size: 200 };
      await dataSource.getData({ id: 'dataId', region });

      assert.equal(rangeHeader, 'bytes=100-299');
    });

    it('should handle errors when fetching data with region', async () => {
      const retryCount = 2;
      mock.method(axios, 'get', () => {
        throw new Error('Failed to fetch data with region');
      });

      const region = { offset: 100, size: 200 };
      await assert.rejects(
        dataSource.getData({ id: 'dataId', region, retryCount }),
        /Failed to fetch contiguous data from ArIO peers/,
      );

      assert.equal(
        (metrics.getDataErrorsTotal.inc as any).mock.callCount(),
        retryCount,
      );
    });
  });
});
