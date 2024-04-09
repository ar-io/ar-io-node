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

let log: winston.Logger;
let dataSource: GatewayDataSource;
let mockedAxiosInstance: any;

before(async () => {
  log = winston.createLogger({ silent: true });
});

beforeEach(async () => {
  mockedAxiosInstance = {
    request: async () => ({
      status: 200,
      data: 'mocked stream',
      headers: {
        'content-length': '123',
        'content-type': 'application/json',
      },
    }),
    defaults: {
      baseURL: 'https://gateway.domain',
    },
  };

  mock.method(axios, 'create', () => mockedAxiosInstance);

  dataSource = new GatewayDataSource({
    log,
    trustedGatewayUrl: 'https://gateway.domain',
  });
});

afterEach(async () => {
  mock.restoreAll();
});

describe('GatewayDataSource', () => {
  describe('getData', () => {
    it('should fetch data successfully from the gateway', async () => {
      const data = await dataSource.getData('some-id');

      assert.deepEqual(data, {
        stream: 'mocked stream',
        size: 123,
        sourceContentType: 'application/json',
        verified: false,
        cached: false,
      });
    });

    it('should throw an error for unexpected status code', async () => {
      mockedAxiosInstance.request = async () => ({ status: 404 });

      try {
        await dataSource.getData('bad-id');
        assert.fail('Expected an error to be thrown');
      } catch (error: any) {
        assert.equal(error.message, 'Unexpected status code from gateway: 404');
      }
    });

    it('should handle network or Axios errors gracefully', async () => {
      mockedAxiosInstance.request = async () => {
        throw new Error('Network Error');
      };

      try {
        await dataSource.getData('bad-id');
        assert.fail('Expected an error to be thrown');
      } catch (error: any) {
        assert.equal(error.message, 'Network Error');
      }
    });
  });
});
