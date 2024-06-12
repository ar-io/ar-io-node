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
import { RequestAttributes } from '../types.js';
import { ArIODataSource } from './ar-io-data-source.js';
import { ArIO, ArIOReadable } from '@ar.io/sdk';
import axios from 'axios';

let log: winston.Logger;
let dataSource: ArIODataSource;
let requestAttributes: RequestAttributes;
let mockedArIOInstance: ArIOReadable;
let mockedAxiosGet: any;

before(async () => {
  log = winston.createLogger({ silent: true });
});

beforeEach(async () => {
  mockedArIOInstance = {
    getGateways: async () => ({
      peer1: { settings: { protocol: 'http', fqdn: 'peer1.com' } },
      peer2: { settings: { protocol: 'https', fqdn: 'peer2.com' } },
      localNode: { settings: { protocol: 'https', fqdn: 'localNode.com' } },
    }),
  } as any;

  mockedAxiosGet = async () => ({
    status: 200,
    data: 'streamData',
    headers: {
      'content-length': '123',
      'content-type': 'application/octet-stream',
    },
  });

  mock.method(ArIO, 'init', () => mockedArIOInstance);

  mock.method(axios, 'get', mockedAxiosGet);

  dataSource = new ArIODataSource({
    log,
    arIO: ArIO.init(),
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
    it('should fetch peers and upodate peer list ignoring the running node as a peer', async () => {
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
        stream: 'streamData',
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
    });

    it('should retry with a different peer if the first one fails', async () => {
      let firstPeer = true;
      mock.method(axios, 'get', async () => {
        if (firstPeer) {
          firstPeer = false;
          throw new Error('First peer failed');
        }
        return {
          status: 200,
          data: 'secondPeerData',
          headers: {
            'content-length': '10',
            'content-type': 'application/octet-stream',
          },
        };
      });

      const data = await dataSource.getData({ id: 'dataId' });

      assert.deepEqual(data, {
        stream: 'secondPeerData',
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
    });

    it('should increment hops and origin if requestAttributes are provided', async () => {
      const data = await dataSource.getData({
        id: 'dataId',
        requestAttributes: { hops: 2 },
      });

      assert.deepEqual(data, {
        stream: 'streamData',
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
  });
});
