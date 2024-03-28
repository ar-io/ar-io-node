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
import axios from 'axios';
import chai, { expect } from 'chai';
import sinon, { SinonSandbox } from 'sinon';
import sinonChai from 'sinon-chai';
import * as winston from 'winston';
import { GatewayDataSource } from './gateway-data-source.js';

chai.use(sinonChai);

describe('GatewayDataSource', function () {
  let log: winston.Logger;
  let sandbox: SinonSandbox;
  let dataSource: GatewayDataSource;
  let mockedAxiosInstance: any;

  before(function () {
    log = winston.createLogger({ silent: true });
  });

  beforeEach(function () {
    sandbox = sinon.createSandbox();

    mockedAxiosInstance = {
      request: sandbox.stub().resolves({
        status: 200,
        data: 'mocked stream',
        headers: {
          'content-length': '123',
          'content-type': 'application/json',
        },
      }),
      defaults: {
        baseURL: 'https://gateway.domain', // Ensure this matches what you expect
      },
    };
    sandbox.stub(axios, 'create').returns(mockedAxiosInstance as any);

    dataSource = new GatewayDataSource({
      log,
      trustedGatewayUrl: 'https://gateway.domain',
    });
  });

  afterEach(function () {
    sandbox.restore();
  });

  describe('getData', function () {
    it('should fetch data successfully from the gateway', async function () {
      const data = await dataSource.getData('some-id');

      expect(data).to.have.property('stream', 'mocked stream');
      expect(data).to.have.property('size', 123);
      expect(data).to.have.property('sourceContentType', 'application/json');
      expect(data).to.have.property('verified', false);
      expect(data).to.have.property('cached', false);
    });

    it('should throw an error for unexpected status code', async function () {
      mockedAxiosInstance.request.resolves({ status: 404 });

      try {
        await dataSource.getData('bad-id');
      } catch (error: any) {
        expect(error.message).to.equal(
          'Unexpected status code from gateway: 404',
        );
      }
    });

    it('should handle network or Axios errors gracefully', async function () {
      mockedAxiosInstance.request.rejects(new Error('Network Error'));

      await expect(dataSource.getData('bad-id')).to.be.rejectedWith(
        'Network Error',
      );
    });
  });
});
