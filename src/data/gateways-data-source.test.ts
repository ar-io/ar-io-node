/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import axios from 'axios';
import { GatewaysDataSource } from './gateways-data-source.js';
import { RequestAttributes } from '../types.js';
import * as metrics from '../metrics.js';
import { TestDestroyedReadable, axiosStreamData } from './test-utils.js';
import { Readable } from 'node:stream';
import { createTestLogger } from '../../test/test-logger.js';

const axiosMockCommonParams = (config: any) => ({
  interceptors: {
    request: { use: () => {} },
    response: { use: () => {} },
  },
  defaults: config,
});

let log: ReturnType<typeof createTestLogger>;
let dataSource: GatewaysDataSource;
let mockedAxiosInstance: any;
let requestAttributes: RequestAttributes;

before(async () => {
  log = createTestLogger({ suite: 'GatewaysDataSource' });
});

beforeEach(async () => {
  mockedAxiosInstance = {
    request: async () => ({
      status: 200,
      data: Readable.from(['mocked stream']),
      headers: {
        'content-length': '123',
        'content-type': 'application/json',
        'X-AR-IO-Origin': 'node-url',
      },
    }),
    ...axiosMockCommonParams({ baseURL: 'https://gateway.domain' }),
  };

  mock.method(axios, 'create', () => mockedAxiosInstance);

  mock.method(metrics.getDataErrorsTotal, 'inc');
  mock.method(metrics.getDataStreamErrorsTotal, 'inc');
  mock.method(metrics.getDataStreamSuccessesTotal, 'inc');

  dataSource = new GatewaysDataSource({
    log,
    trustedGatewaysUrls: { 'https://gateway.domain': 1 },
  });

  requestAttributes = { origin: 'node-url', hops: 0 };
});

afterEach(async () => {
  mock.restoreAll();
});

describe('GatewayDataSource', () => {
  describe('Gateway Prioritization', () => {
    it('should initialize trusted gateways map correctly', () => {
      const dataSource = new GatewaysDataSource({
        log,
        trustedGatewaysUrls: {
          'https://gateway1.com': 1,
          'https://gateway2.com': 1,
          'https://gateway3.com': 2,
          'https://gateway4.com': 3,
        },
      });

      const gatewaysMap = (dataSource as any).trustedGateways;

      assert.equal(gatewaysMap.size, 3);
      assert.deepEqual(gatewaysMap.get(1), [
        'https://gateway1.com',
        'https://gateway2.com',
      ]);
      assert.deepEqual(gatewaysMap.get(2), ['https://gateway3.com']);
      assert.deepEqual(gatewaysMap.get(3), ['https://gateway4.com']);
    });

    it('should throw error when no gateways are provided', () => {
      assert.throws(() => {
        new GatewaysDataSource({
          log,
          trustedGatewaysUrls: {},
        });
      }, /At least one gateway URL must be provided/);
    });

    it('should try gateways in priority order', async () => {
      const requestLog: string[] = [];

      const dataSource = new GatewaysDataSource({
        log,
        trustedGatewaysUrls: {
          'https://gateway1.com': 1,
          'https://gateway2.com': 2,
          'https://gateway3.com': 3,
        },
      });

      mock.method(axios, 'create', (config: any) => ({
        request: async () => {
          requestLog.push(config.baseURL);
          if (config.baseURL !== 'https://gateway3.com') {
            throw new Error('Network Error');
          }
          return {
            status: 200,
            data: axiosStreamData,
            headers: {
              'content-length': '123',
              'content-type': 'application/json',
              'X-AR-IO-Origin': 'node-url',
            },
          };
        },
        ...axiosMockCommonParams(config),
      }));

      await dataSource.getData({ id: 'test-id' });

      assert.equal(requestLog[0], 'https://gateway1.com');
      assert.equal(requestLog[1], 'https://gateway2.com');
      assert.equal(requestLog[2], 'https://gateway3.com');
    });

    it('should try all gateways in same priority tier before moving to next tier', async () => {
      const requestLog: string[] = [];

      const dataSource = new GatewaysDataSource({
        log,
        trustedGatewaysUrls: {
          'https://gateway1.com': 1,
          'https://gateway2.com': 1,
          'https://gateway3.com': 2,
        },
      });

      mock.method(axios, 'create', (config: any) => ({
        request: async () => {
          requestLog.push(config.baseURL);
          if (config.baseURL !== 'https://gateway3.com') {
            throw new Error('Network Error');
          }
          return {
            status: 200,
            data: axiosStreamData,
            headers: {
              'content-length': '123',
              'content-type': 'application/json',
              'X-AR-IO-Origin': 'node-url',
            },
          };
        },
        ...axiosMockCommonParams(config),
      }));

      await dataSource.getData({ id: 'test-id' });

      assert.equal(requestLog.length, 3);
      assert.ok(requestLog.slice(0, 2).includes('https://gateway1.com'));
      assert.ok(requestLog.slice(0, 2).includes('https://gateway2.com'));
      assert.equal(requestLog[2], 'https://gateway3.com');
    });
  });

  describe('getData', () => {
    it('should fetch data successfully from the gateway', async () => {
      const data = await dataSource.getData({
        id: 'some-id',
        requestAttributes,
      });

      assert.equal(data.size, 123);
      assert.equal(data.sourceContentType, 'application/json');
      assert.equal(data.verified, false);
      assert.equal(data.cached, false);
      assert.deepEqual(data.requestAttributes, {
        hops: requestAttributes.hops + 1,
        origin: requestAttributes.origin,
        originNodeRelease: undefined,
        clientIps: [],
      });

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
        'GatewaysDataSource',
      );
    });

    it('should throw an error for unexpected status code', async () => {
      mockedAxiosInstance.request = async () => ({ status: 404 });

      try {
        await dataSource.getData({ id: 'bad-id', requestAttributes });
        assert.fail('Expected an error to be thrown');
      } catch (error: any) {
        assert.equal(
          (metrics.getDataErrorsTotal.inc as any).mock.callCount(),
          1,
        );
        assert.equal(
          (metrics.getDataErrorsTotal.inc as any).mock.calls[0].arguments[0]
            .class,
          'GatewaysDataSource',
        );
        assert.equal(
          error.message,
          'Unexpected status code from gateway: 404. Expected 200.',
        );
      }
    });

    it('should handle network or Axios errors gracefully', async () => {
      mockedAxiosInstance.request = async () => {
        throw new Error('Network Error');
      };

      try {
        await dataSource.getData({ id: 'bad-id', requestAttributes });
        assert.fail('Expected an error to be thrown');
      } catch (error: any) {
        assert.equal(
          (metrics.getDataErrorsTotal.inc as any).mock.callCount(),
          1,
        );
        assert.equal(
          (metrics.getDataErrorsTotal.inc as any).mock.calls[0].arguments[0]
            .class,
          'GatewaysDataSource',
        );
        assert.equal(error.message, 'Network Error');
      }
    });

    it('should increment getDataStreamErrorsTotal', async () => {
      mockedAxiosInstance.request = async () => ({
        status: 200,
        data: new TestDestroyedReadable(),
        headers: {
          'content-length': '123',
          'content-type': 'application/json',
        },
      });

      try {
        const data = await dataSource.getData({ id: 'id', requestAttributes });
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
          'GatewaysDataSource',
        );
        assert.equal(error.message, 'Stream destroyed intentionally');
      }
    });

    it('should send hops and origin query parameters if provided', async () => {
      let requestParams: any;
      mockedAxiosInstance.request = async (params: any) => {
        requestParams = params;
        return {
          status: 200,
          headers: { 'content-length': '123' },
          data: axiosStreamData,
        };
      };

      await dataSource.getData({
        id: 'some-id',
        requestAttributes,
      });

      assert.equal(
        requestParams.params['ar-io-hops'],
        requestAttributes.hops + 1,
      );
      assert.equal(
        requestParams.params['ar-io-origin'],
        requestAttributes.origin,
      );
    });

    it('should not send origin query parameter if not provided', async () => {
      let requestParams: any;
      mockedAxiosInstance.request = async (params: any) => {
        requestParams = params;
        return {
          status: 200,
          headers: { 'content-length': '123' },
          data: axiosStreamData,
        };
      };

      await dataSource.getData({
        id: 'some-id',
        requestAttributes: { hops: 0 },
      });

      assert.equal(requestParams.params['ar-io-hops'], 1);
      assert.equal(requestParams.params['ar-io-origin'], undefined);
    });

    it('should not send hops or origin query parameters if not provided', async () => {
      let requestParams: any;
      mockedAxiosInstance.request = async (params: any) => {
        requestParams = params;
        return {
          status: 200,
          headers: { 'content-length': '123' },
          data: axiosStreamData,
        };
      };

      await dataSource.getData({
        id: 'some-id',
      });

      assert.equal(requestParams.params['ar-io-hops'], undefined);
      assert.equal(requestParams.params['ar-io-origin'], undefined);
    });

    it('should return hops 1 in the response if not provided', async () => {
      const data = await dataSource.getData({
        id: 'some-id',
      });

      assert.equal(data.requestAttributes?.hops, 1);
      assert.equal(data.requestAttributes?.origin, 'node-url');
    });

    it('should increment hops in the response', async () => {
      const data = await dataSource.getData({
        id: 'some-id',
        requestAttributes: { hops: 5 },
      });

      assert.equal(data.requestAttributes?.hops, 6);
      assert.equal(data.requestAttributes?.origin, 'node-url');
    });

    it('should include Range header when region is provided', async () => {
      let requestParams: any;
      mockedAxiosInstance.request = async (params: any) => {
        requestParams = params;
        return {
          status: 206,
          headers: {
            'content-length': '200',
            'content-type': 'application/octet-stream',
          },
          data: axiosStreamData,
        };
      };

      const region = { offset: 100, size: 200 };
      await dataSource.getData({ id: 'some-id', region });

      assert.equal(requestParams.headers['Range'], 'bytes=100-299');
    });

    it('should handle errors when fetching data with region', async () => {
      mockedAxiosInstance.request = async () => {
        throw new Error('Failed to fetch data with region');
      };

      const region = { offset: 100, size: 200 };
      await assert.rejects(
        dataSource.getData({ id: 'some-id', region }),
        /Failed to fetch data with region/,
      );

      assert.equal((metrics.getDataErrorsTotal.inc as any).mock.callCount(), 1);
      assert.equal(
        (metrics.getDataErrorsTotal.inc as any).mock.calls[0].arguments[0]
          .class,
        'GatewaysDataSource',
      );
    });

    it('should accept 206 Partial Content status when region is provided', async () => {
      mockedAxiosInstance.request = async () => ({
        status: 206,
        headers: {
          'content-length': '200',
          'content-type': 'application/octet-stream',
        },
        data: axiosStreamData,
      });

      const region = { offset: 100, size: 200 };
      const data = await dataSource.getData({ id: 'some-id', region });

      assert.equal(data.size, 200);
      assert.equal(data.sourceContentType, 'application/octet-stream');
    });

    describe('ArNS query parameters', () => {
      it('should include ArNS record and basename as query parameters when provided', async () => {
        let requestParams: any;
        mockedAxiosInstance.request = async (params: any) => {
          requestParams = params;
          return {
            status: 200,
            headers: { 'content-length': '123' },
            data: axiosStreamData,
          };
        };

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

        // Verify all query parameters are included
        assert.equal(requestParams.params['ar-io-hops'], 2); // hops + 1
        assert.equal(requestParams.params['ar-io-origin'], 'test-origin');
        assert.equal(requestParams.params['ar-io-origin-release'], '42');
        assert.equal(requestParams.params['ar-io-arns-record'], 'subdomain');
        assert.equal(requestParams.params['ar-io-arns-basename'], 'example');
      });

      it('should include only provided request attributes as query parameters', async () => {
        let requestParams: any;
        mockedAxiosInstance.request = async (params: any) => {
          requestParams = params;
          return {
            status: 200,
            headers: { 'content-length': '123' },
            data: axiosStreamData,
          };
        };

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
        assert.equal(requestParams.params['ar-io-hops'], 1); // hops + 1
        assert.equal(requestParams.params['ar-io-arns-basename'], 'example');

        // Verify undefined parameters are passed through
        assert.equal(requestParams.params['ar-io-origin'], undefined);
        assert.equal(requestParams.params['ar-io-origin-release'], undefined);
        assert.equal(requestParams.params['ar-io-arns-record'], undefined);
      });

      it('should handle empty request attributes', async () => {
        let requestParams: any;
        mockedAxiosInstance.request = async (params: any) => {
          requestParams = params;
          return {
            status: 200,
            headers: { 'content-length': '123' },
            data: axiosStreamData,
          };
        };

        await dataSource.getData({
          id: 'testId',
          // no requestAttributes provided
        });

        // Verify all parameters are undefined when no request attributes are provided
        assert.equal(requestParams.params['ar-io-hops'], undefined);
        assert.equal(requestParams.params['ar-io-origin'], undefined);
        assert.equal(requestParams.params['ar-io-origin-release'], undefined);
        assert.equal(requestParams.params['ar-io-arns-record'], undefined);
        assert.equal(requestParams.params['ar-io-arns-basename'], undefined);
      });
    });

    describe('abort signal handling', () => {
      it('should throw immediately when signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();

        await assert.rejects(
          dataSource.getData({
            id: 'test-id',
            signal: controller.signal,
          }),
          { name: 'AbortError' },
        );
      });

      it('should not try next gateway when client disconnects', async () => {
        const requestLog: string[] = [];
        const controller = new AbortController();

        const dataSourceMultiGateway = new GatewaysDataSource({
          log,
          trustedGatewaysUrls: {
            'https://gateway1.com': 1,
            'https://gateway2.com': 2,
          },
        });

        mock.method(axios, 'create', (config: any) => ({
          request: async () => {
            requestLog.push(config.baseURL);
            // Simulate client disconnect by aborting the controller
            controller.abort();
            const error = new Error('aborted');
            error.name = 'AbortError';
            throw error;
          },
          ...axiosMockCommonParams(config),
        }));

        await assert.rejects(
          dataSourceMultiGateway.getData({ id: 'test-id', signal: controller.signal }),
          { name: 'AbortError' },
        );

        // Only first gateway should be tried on client disconnect
        assert.equal(requestLog.length, 1);
      });

      it('should try next gateway on timeout', async () => {
        const requestLog: string[] = [];

        const dataSourceMultiGateway = new GatewaysDataSource({
          log,
          trustedGatewaysUrls: {
            'https://gateway1.com': 1,
            'https://gateway2.com': 2,
          },
        });

        mock.method(axios, 'create', (config: any) => ({
          request: async () => {
            requestLog.push(config.baseURL);
            // Simulate timeout by throwing AbortError without client signal being aborted
            const error = new Error('timeout');
            error.name = 'AbortError';
            throw error;
          },
          ...axiosMockCommonParams(config),
        }));

        await assert.rejects(
          dataSourceMultiGateway.getData({ id: 'test-id' }),
          { name: 'AbortError' },
        );

        // Both gateways should be tried on timeout
        assert.equal(requestLog.length, 2);
      });
    });
  });
});
