/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import * as winston from 'winston';
import axios from 'axios';
import { AoARIORead, ARIO } from '@ar.io/sdk';
import { Readable } from 'node:stream';
import { RequestAttributes, DataAttributesSource } from '../types.js';
import { ArIODataSource } from './ar-io-data-source.js';
import { ArIOPeerManager } from './ar-io-peer-manager.js';
import * as metrics from '../metrics.js';
import { TestDestroyedReadable, axiosStreamData } from './test-utils.js';
import { headerNames } from '../constants.js';
import { release } from '../version.js';

let log: winston.Logger;
let dataSource: ArIODataSource;
let peerManager: ArIOPeerManager;
const nodeUrl = 'localNode.com';
let requestAttributes: RequestAttributes;
let mockedArIOInstance: AoARIORead;
let mockedAxiosGet: any;
let mockDataAttributesSource: DataAttributesSource;

before(async () => {
  log = winston.createLogger({ silent: true });
});

beforeEach(async () => {
  mockDataAttributesSource = {
    getDataAttributes: mock.fn(() => Promise.resolve(undefined)),
  };

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
      [headerNames.verified.toLowerCase()]: 'true',
      [headerNames.trusted.toLowerCase()]: 'false',
    },
  });

  mock.method(ARIO, 'init', () => mockedArIOInstance);

  mock.method(axios, 'get', mockedAxiosGet);

  mock.method(metrics.getDataErrorsTotal, 'inc');
  mock.method(metrics.getDataStreamErrorsTotal, 'inc');
  mock.method(metrics.getDataStreamSuccessesTotal, 'inc');

  peerManager = new ArIOPeerManager({
    log,
    networkProcess: ARIO.init(),
    nodeWallet: 'localNode',
    initialPeers: {
      peer1: 'http://peer1.com',
      peer2: 'https://peer2.com',
    },
    initialCategories: ['data'],
  });

  dataSource = new ArIODataSource({
    log,
    peerManager,
    dataAttributesSource: mockDataAttributesSource,
  });

  requestAttributes = { origin: 'node-url', hops: 0 };
});

afterEach(async () => {
  peerManager.stopUpdatingPeers();
  mock.restoreAll();
});

describe('ArIODataSource', () => {
  describe('constructor', () => {
    it('should initialize with test peers', async () => {
      const peers = peerManager.getPeers();
      assert.deepEqual(peers, {
        peer1: 'http://peer1.com',
        peer2: 'https://peer2.com',
      });
    });
  });

  describe('getData', () => {
    it('should return data from a random peer', async () => {
      const data = await dataSource.getData({ id: 'dataId' });

      assert.deepEqual(data, {
        stream: axiosStreamData,
        size: 123,
        verified: false,
        trusted: false,
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
            [headerNames.verified.toLowerCase()]: 'true',
            [headerNames.trusted.toLowerCase()]: 'false',
          },
        };
      });

      const data = await dataSource.getData({ id: 'dataId' });

      assert.deepEqual(data, {
        stream: secondPeerStreamData,
        size: 10,
        verified: false,
        trusted: false,
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
          [headerNames.verified.toLowerCase()]: 'true',
          [headerNames.trusted.toLowerCase()]: 'false',
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
        trusted: false,
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
        /Maximum hops \(\d+\) exceeded/,
      );
    });

    it('should throw error when hops equals default max hops (3)', async () => {
      requestAttributes.hops = 3;

      await assert.rejects(
        dataSource.getData({ id: 'dataId', requestAttributes }),
        /Maximum hops \(\d+\) exceeded/,
      );
    });

    it('should allow hops less than max hops (2 < 3)', async () => {
      requestAttributes.hops = 2;

      const data = await dataSource.getData({
        id: 'dataId',
        requestAttributes,
      });

      assert.ok(data.stream != null);
      assert.equal(data.requestAttributes?.hops, 3); // Should increment from 2 to 3
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
            [headerNames.verified.toLowerCase()]: 'true',
            [headerNames.trusted.toLowerCase()]: 'false',
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

    it('should accept data when peer indicates verified=true', async () => {
      mock.method(axios, 'get', async () => ({
        status: 200,
        data: axiosStreamData,
        headers: {
          'content-length': '123',
          'content-type': 'application/octet-stream',
          [headerNames.verified.toLowerCase()]: 'true',
          [headerNames.trusted.toLowerCase()]: 'false',
        },
      }));

      const data = await dataSource.getData({ id: 'dataId' });
      assert.equal(data.size, 123);
    });

    it('should accept data when peer indicates trusted=true', async () => {
      mock.method(axios, 'get', async () => ({
        status: 200,
        data: axiosStreamData,
        headers: {
          'content-length': '123',
          'content-type': 'application/octet-stream',
          [headerNames.verified.toLowerCase()]: 'false',
          [headerNames.trusted.toLowerCase()]: 'true',
        },
      }));

      const data = await dataSource.getData({ id: 'dataId' });
      assert.equal(data.size, 123);
    });

    it('should accept data when peer indicates both verified=true and trusted=true', async () => {
      mock.method(axios, 'get', async () => ({
        status: 200,
        data: axiosStreamData,
        headers: {
          'content-length': '123',
          'content-type': 'application/octet-stream',
          [headerNames.verified.toLowerCase()]: 'true',
          [headerNames.trusted.toLowerCase()]: 'true',
        },
      }));

      const data = await dataSource.getData({ id: 'dataId' });
      assert.equal(data.size, 123);
    });

    it('should reject data when peer indicates neither verified nor trusted', async () => {
      mock.method(axios, 'get', async () => ({
        status: 200,
        data: axiosStreamData,
        headers: {
          'content-length': '123',
          'content-type': 'application/octet-stream',
          [headerNames.verified.toLowerCase()]: 'false',
          [headerNames.trusted.toLowerCase()]: 'false',
        },
      }));

      await assert.rejects(
        dataSource.getData({ id: 'dataId' }),
        /Failed to fetch contiguous data from ArIO peers/,
      );
    });

    it('should reject data when peer headers are missing', async () => {
      mock.method(axios, 'get', async () => ({
        status: 200,
        data: axiosStreamData,
        headers: {
          'content-length': '123',
          'content-type': 'application/octet-stream',
        },
      }));

      await assert.rejects(
        dataSource.getData({ id: 'dataId' }),
        /Failed to fetch contiguous data from ArIO peers/,
      );
    });

    it('should retry with next peer when first peer rejects data as unverified/untrusted', async () => {
      let firstPeer = true;
      const secondPeerStreamData = Readable.from(['secondPeerData']);

      mock.method(axios, 'get', async () => {
        if (firstPeer) {
          firstPeer = false;
          return {
            status: 200,
            data: axiosStreamData,
            headers: {
              'content-length': '123',
              'content-type': 'application/octet-stream',
              [headerNames.verified.toLowerCase()]: 'false',
              [headerNames.trusted.toLowerCase()]: 'false',
            },
          };
        }
        return {
          status: 200,
          data: secondPeerStreamData,
          headers: {
            'content-length': '10',
            'content-type': 'application/octet-stream',
            [headerNames.verified.toLowerCase()]: 'true',
            [headerNames.trusted.toLowerCase()]: 'false',
          },
        };
      });

      const data = await dataSource.getData({ id: 'dataId' });
      assert.equal(data.stream, secondPeerStreamData);
      assert.equal(data.size, 10);
    });

    describe('hash validation', () => {
      it('should accept data when peer digest matches expected hash', async () => {
        const expectedHash = 'test-hash-123';
        const streamData = Readable.from(['valid data']);

        // Mock data attributes source to return expected hash
        mockDataAttributesSource.getDataAttributes = mock.fn(() =>
          Promise.resolve({
            hash: expectedHash,
            size: 10,
            isManifest: false,
            stable: true,
            verified: true,
            offset: 0,
            signature: null,
          }),
        );

        mock.method(axios, 'get', async (url, config) => {
          // Verify expected digest header is sent
          assert.equal(
            config.headers[headerNames.expectedDigest],
            expectedHash,
          );

          return {
            status: 200,
            data: streamData,
            headers: {
              'content-length': '10',
              'content-type': 'application/octet-stream',
              [headerNames.digest.toLowerCase()]: expectedHash,
              [headerNames.verified.toLowerCase()]: 'true',
            },
          };
        });

        const data = await dataSource.getData({
          id: 'dataId',
        });

        assert.deepEqual(data, {
          stream: streamData,
          size: 10,
          verified: false,
          trusted: false,
          sourceContentType: 'application/octet-stream',
          cached: false,
          requestAttributes: {
            hops: 1,
            origin: undefined,
            originNodeRelease: undefined,
          },
        });
      });

      it('should reject data when peer digest does not match expected hash', async () => {
        const expectedHash = 'expected-hash-123';
        const wrongHash = 'wrong-hash-456';
        const streamData = Readable.from(['invalid data']);

        // Mock data attributes source to return expected hash
        mockDataAttributesSource.getDataAttributes = mock.fn(() =>
          Promise.resolve({
            hash: expectedHash,
            size: 10,
            isManifest: false,
            stable: true,
            verified: true,
            offset: 0,
            signature: null,
          }),
        );

        mock.method(axios, 'get', async () => ({
          status: 200,
          data: streamData,
          headers: {
            'content-length': '10',
            'content-type': 'application/octet-stream',
            [headerNames.digest.toLowerCase()]: wrongHash,
            [headerNames.verified.toLowerCase()]: 'true',
          },
        }));

        await assert.rejects(
          dataSource.getData({
            id: 'dataId',
          }),
          {
            message: 'Failed to fetch contiguous data from ArIO peers',
          },
        );

        // Verify the stream was destroyed
        assert.equal(streamData.destroyed, true);

        // Verify error metrics were incremented
        assert.equal(
          (metrics.getDataErrorsTotal.inc as any).mock.callCount(),
          2,
        );
      });

      it('should not send expected digest header when no hash is provided', async () => {
        const streamData = Readable.from(['data without hash']);

        mock.method(axios, 'get', async (url, config) => {
          // Verify expected digest header is NOT sent
          assert.equal(config.headers[headerNames.expectedDigest], undefined);

          return {
            status: 200,
            data: streamData,
            headers: {
              'content-length': '10',
              'content-type': 'application/octet-stream',
              [headerNames.verified.toLowerCase()]: 'true',
            },
          };
        });

        const data = await dataSource.getData({ id: 'dataId' });

        assert.equal(data.stream, streamData);
        assert.equal(data.size, 10);
      });

      it('should accept data when peer does not provide digest header', async () => {
        const expectedHash = 'test-hash-123';
        const streamData = Readable.from(['data without digest']);

        mock.method(axios, 'get', async () => ({
          status: 200,
          data: streamData,
          headers: {
            'content-length': '10',
            'content-type': 'application/octet-stream',
            // No digest header provided by peer
            [headerNames.verified.toLowerCase()]: 'true',
          },
        }));

        const data = await dataSource.getData({
          id: 'dataId',
          dataAttributes: {
            hash: expectedHash,
            size: 10,
            isManifest: false,
            stable: true,
            verified: true,
            offset: 0,
            signature: null,
          },
        });

        assert.equal(data.stream, streamData);
        assert.equal(data.size, 10);
      });
    });

    describe('ArNS query parameters', () => {
      it('should include ArNS record and basename as query parameters when provided', async () => {
        let requestUrl: string | undefined;
        let requestConfig: any;

        mock.method(axios, 'get', async (url: string, config: any) => {
          requestUrl = url;
          requestConfig = config;
          return {
            status: 200,
            data: axiosStreamData,
            headers: {
              'content-length': '123',
              'content-type': 'application/octet-stream',
              [headerNames.verified.toLowerCase()]: 'true',
              [headerNames.trusted.toLowerCase()]: 'false',
            },
          };
        });

        const requestAttributesWithArns: RequestAttributes = {
          hops: 1,
          origin: 'test-origin',
          originNodeRelease: '42',
          arnsRecord: 'subdomain',
          arnsBasename: 'example',
        };

        await dataSource.getData({
          id: 'testId',
          requestAttributes: requestAttributesWithArns,
        });

        // Verify the URL includes the base path
        assert.ok(requestUrl?.includes('/raw/testId'));

        // Verify all query parameters are included
        assert.equal(requestConfig.params['ar-io-hops'], 2); // hops + 1
        assert.equal(requestConfig.params['ar-io-origin'], 'test-origin');
        assert.equal(requestConfig.params['ar-io-origin-release'], '42');
        assert.equal(requestConfig.params['ar-io-arns-record'], 'subdomain');
        assert.equal(requestConfig.params['ar-io-arns-basename'], 'example');
      });

      it('should include only provided request attributes as query parameters', async () => {
        let requestConfig: any;

        mock.method(axios, 'get', async (url: string, config: any) => {
          requestConfig = config;
          return {
            status: 200,
            data: axiosStreamData,
            headers: {
              'content-length': '123',
              'content-type': 'application/octet-stream',
              [headerNames.verified.toLowerCase()]: 'true',
              [headerNames.trusted.toLowerCase()]: 'false',
            },
          };
        });

        const requestAttributesPartial: RequestAttributes = {
          hops: 0,
          arnsBasename: 'example',
          // arnsRecord is undefined
        };

        await dataSource.getData({
          id: 'testId',
          requestAttributes: requestAttributesPartial,
        });

        // Verify provided parameters are included
        assert.equal(requestConfig.params['ar-io-hops'], 1); // hops + 1
        assert.equal(requestConfig.params['ar-io-arns-basename'], 'example');

        // Verify undefined parameters are still passed (following axios behavior)
        assert.equal(requestConfig.params['ar-io-origin'], undefined);
        assert.equal(requestConfig.params['ar-io-origin-release'], undefined);
        assert.equal(requestConfig.params['ar-io-arns-record'], undefined);
      });

      it('should handle empty request attributes', async () => {
        let requestConfig: any;

        mock.method(axios, 'get', async (url: string, config: any) => {
          requestConfig = config;
          return {
            status: 200,
            data: axiosStreamData,
            headers: {
              'content-length': '123',
              'content-type': 'application/octet-stream',
              [headerNames.verified.toLowerCase()]: 'true',
              [headerNames.trusted.toLowerCase()]: 'false',
            },
          };
        });

        await dataSource.getData({
          id: 'testId',
          // no requestAttributes provided
        });

        // Verify all parameters are undefined when no request attributes are provided
        assert.equal(requestConfig.params['ar-io-hops'], undefined);
        assert.equal(requestConfig.params['ar-io-origin'], undefined);
        assert.equal(requestConfig.params['ar-io-origin-release'], undefined);
        assert.equal(requestConfig.params['ar-io-arns-record'], undefined);
        assert.equal(requestConfig.params['ar-io-arns-basename'], undefined);
      });
    });
  });

  describe('Request attribute headers propagation', () => {
    it('should send X-AR-IO-Hops and X-AR-IO-Origin headers when requestAttributes are provided', async () => {
      let capturedHeaders: any;
      let capturedParams: any;

      mock.method(axios, 'get', async (url: string, config: any) => {
        capturedHeaders = config.headers;
        capturedParams = config.params;
        return {
          status: 200,
          data: axiosStreamData,
          headers: {
            'content-length': '123',
            'content-type': 'application/octet-stream',
            [headerNames.verified.toLowerCase()]: 'true',
            [headerNames.trusted.toLowerCase()]: 'false',
          },
        };
      });

      await dataSource.getData({
        id: 'dataId',
        requestAttributes: {
          hops: 1,
          origin: 'test-origin',
          originNodeRelease: 'v1.2.3',
        },
      });

      // Check headers
      assert.equal(capturedHeaders[headerNames.hops], '2'); // incremented from 1
      assert.equal(capturedHeaders[headerNames.origin], 'test-origin');
      assert.equal(capturedHeaders[headerNames.originNodeRelease], 'v1.2.3');

      // Check query params
      assert.equal(capturedParams['ar-io-hops'], 2);
      assert.equal(capturedParams['ar-io-origin'], 'test-origin');
      assert.equal(capturedParams['ar-io-origin-release'], 'v1.2.3');
    });

    it('should send only X-AR-IO-Hops header when origin is not provided', async () => {
      let capturedHeaders: any;
      let capturedParams: any;

      mock.method(axios, 'get', async (url: string, config: any) => {
        capturedHeaders = config.headers;
        capturedParams = config.params;
        return {
          status: 200,
          data: axiosStreamData,
          headers: {
            'content-length': '123',
            'content-type': 'application/octet-stream',
            [headerNames.verified.toLowerCase()]: 'true',
            [headerNames.trusted.toLowerCase()]: 'false',
          },
        };
      });

      await dataSource.getData({
        id: 'dataId',
        requestAttributes: {
          hops: 1,
        },
      });

      // Check headers
      assert.equal(capturedHeaders[headerNames.hops], '2'); // incremented from 1
      assert.equal(capturedHeaders[headerNames.origin], undefined);
      assert.equal(capturedHeaders[headerNames.originNodeRelease], undefined);

      // Check query params
      assert.equal(capturedParams['ar-io-hops'], 2);
      assert.equal(capturedParams['ar-io-origin'], undefined);
      assert.equal(capturedParams['ar-io-origin-release'], undefined);
    });

    it('should not send request attribute headers when no requestAttributes are provided', async () => {
      let capturedHeaders: any;
      let capturedParams: any;

      mock.method(axios, 'get', async (url: string, config: any) => {
        capturedHeaders = config.headers;
        capturedParams = config.params;
        return {
          status: 200,
          data: axiosStreamData,
          headers: {
            'content-length': '123',
            'content-type': 'application/octet-stream',
            [headerNames.verified.toLowerCase()]: 'true',
            [headerNames.trusted.toLowerCase()]: 'false',
          },
        };
      });

      await dataSource.getData({ id: 'dataId' });

      // Check headers - should not be present when no requestAttributes provided
      assert.equal(capturedHeaders[headerNames.hops], undefined);
      assert.equal(capturedHeaders[headerNames.origin], undefined);
      assert.equal(capturedHeaders[headerNames.originNodeRelease], undefined);

      // Check query params - should also not be present
      assert.equal(capturedParams['ar-io-hops'], undefined);
      assert.equal(capturedParams['ar-io-origin'], undefined);
      assert.equal(capturedParams['ar-io-origin-release'], undefined);
    });

    it('should send request attribute headers when both origin and release are initialized', async () => {
      let capturedHeaders: any;
      let capturedParams: any;

      mock.method(axios, 'get', async (url: string, config: any) => {
        capturedHeaders = config.headers;
        capturedParams = config.params;
        return {
          status: 200,
          data: axiosStreamData,
          headers: {
            'content-length': '123',
            'content-type': 'application/octet-stream',
            [headerNames.verified.toLowerCase()]: 'true',
            [headerNames.trusted.toLowerCase()]: 'false',
          },
        };
      });

      // This simulates the initial request from handlers where both origin and release are initialized together
      await dataSource.getData({
        id: 'dataId',
        requestAttributes: {
          hops: 0,
          origin: nodeUrl,
          originNodeRelease: release,
        },
      });

      // Check headers - hops should be incremented to 1
      assert.equal(capturedHeaders[headerNames.hops], '1');
      assert.equal(capturedHeaders[headerNames.origin], nodeUrl);
      assert.equal(capturedHeaders[headerNames.originNodeRelease], release);

      // Check query params
      assert.equal(capturedParams['ar-io-hops'], 1);
      assert.equal(capturedParams['ar-io-origin'], nodeUrl);
      assert.equal(capturedParams['ar-io-origin-release'], release);
    });

    it('should propagate headers correctly across multiple peer retries', async () => {
      let callCount = 0;
      const capturedHeaders: any[] = [];
      const capturedParams: any[] = [];

      mock.method(axios, 'get', async (url: string, config: any) => {
        capturedHeaders.push({ ...config.headers });
        capturedParams.push({ ...config.params });
        callCount++;

        if (callCount === 1) {
          // First peer fails
          throw new Error('First peer failed');
        }

        // Second peer succeeds
        return {
          status: 200,
          data: axiosStreamData,
          headers: {
            'content-length': '123',
            'content-type': 'application/octet-stream',
            [headerNames.verified.toLowerCase()]: 'true',
            [headerNames.trusted.toLowerCase()]: 'false',
          },
        };
      });

      await dataSource.getData({
        id: 'dataId',
        requestAttributes: {
          hops: 1,
          origin: 'original-node',
          originNodeRelease: 'v1.0.0',
        },
      });

      // Both attempts should have the same headers
      assert.equal(callCount, 2);
      for (const headers of capturedHeaders) {
        assert.equal(headers[headerNames.hops], '2');
        assert.equal(headers[headerNames.origin], 'original-node');
        assert.equal(headers[headerNames.originNodeRelease], 'v1.0.0');
      }

      // Both attempts should have the same query params
      for (const params of capturedParams) {
        assert.equal(params['ar-io-hops'], 2);
        assert.equal(params['ar-io-origin'], 'original-node');
        assert.equal(params['ar-io-origin-release'], 'v1.0.0');
      }
    });

    it('should include request attribute headers along with other headers', async () => {
      let capturedHeaders: any;

      mock.method(axios, 'get', async (url: string, config: any) => {
        capturedHeaders = config.headers;
        return {
          status: 200,
          data: axiosStreamData,
          headers: {
            'content-length': '50',
            'content-type': 'application/octet-stream',
            [headerNames.verified.toLowerCase()]: 'true',
            [headerNames.trusted.toLowerCase()]: 'false',
          },
        };
      });

      const region = { offset: 100, size: 200 };
      await dataSource.getData({
        id: 'dataId',
        region,
        requestAttributes: {
          hops: 1,
          origin: 'test-node',
        },
      });

      // Should have both Range header and request attribute headers
      assert.equal(capturedHeaders['Range'], 'bytes=100-299');
      assert.equal(capturedHeaders[headerNames.hops], '2');
      assert.equal(capturedHeaders[headerNames.origin], 'test-node');
      assert.equal(capturedHeaders['Accept-Encoding'], 'identity');
    });
  });
});
