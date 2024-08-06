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
import axios from 'axios';
import * as winston from 'winston';
import { GatewayDataSource } from './gateway-data-source.js';
import { RequestAttributes } from '../types.js';
import * as metrics from '../metrics.js';
import { TestDestroyedReadable, axiosStreamData } from './test-utils.js';

let log: winston.Logger;
let dataSource: GatewayDataSource;
let mockedAxiosInstance: any;
let requestAttributes: RequestAttributes;

before(async () => {
  log = winston.createLogger({ silent: true });
});

beforeEach(async () => {
  mockedAxiosInstance = {
    request: async () => ({
      status: 200,
      data: axiosStreamData,
      headers: {
        'content-length': '123',
        'content-type': 'application/json',
        'X-AR-IO-Origin': 'node-url',
      },
    }),
    defaults: {
      baseURL: 'https://gateway.domain',
    },
  };

  mock.method(axios, 'create', () => mockedAxiosInstance);

  mock.method(metrics.getDataErrorsTotal, 'inc');
  mock.method(metrics.getDataStreamErrorsTotal, 'inc');
  mock.method(metrics.getDataStreamSuccessesTotal, 'inc');

  dataSource = new GatewayDataSource({
    log,
    trustedGatewayUrl: 'https://gateway.domain',
  });

  requestAttributes = { origin: 'node-url', hops: 0 };
});

afterEach(async () => {
  mock.restoreAll();
});

describe('GatewayDataSource', () => {
  describe('getData', () => {
    it('should fetch data successfully from the gateway', async () => {
      const data = await dataSource.getData({
        id: 'some-id',
        requestAttributes,
      });

      assert.deepEqual(data, {
        stream: axiosStreamData,
        size: 123,
        sourceContentType: 'application/json',
        verified: false,
        cached: false,
        requestAttributes: {
          hops: requestAttributes.hops + 1,
          origin: requestAttributes.origin,
          originNodeRelease: undefined,
        },
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
        'GatewayDataSource',
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
          'GatewayDataSource',
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
          'GatewayDataSource',
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
          'GatewayDataSource',
        );
        assert.equal(error.message, 'Stream destroyed intentionally');
      }
    });

    it('should send hops and origin headers if provided', async () => {
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
        requestParams.headers['X-AR-IO-Hops'],
        (requestAttributes.hops + 1).toString(),
      );
      assert.equal(
        requestParams.headers['X-AR-IO-Origin'],
        requestAttributes.origin,
      );
    });

    it('should not send origin header if not provided', async () => {
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

      assert.equal(requestParams.headers['X-AR-IO-Hops'], '1');
      assert.equal(requestParams.headers['X-AR-IO-Origin'], undefined);
    });

    it('should not send hops or origin headers if not provided', async () => {
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

      assert.equal(requestParams.headers['X-AR-IO-Hops'], undefined);
      assert.equal(requestParams.headers['X-AR-IO-Origin'], undefined);
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
        'GatewayDataSource',
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
  });
});
