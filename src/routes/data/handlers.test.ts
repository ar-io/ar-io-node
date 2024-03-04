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
import { expect } from 'chai';
import express from 'express';
import { Readable } from 'node:stream';
import sinon from 'sinon';
import { default as request } from 'supertest';

import log from '../../log.js';
import {
  ContiguousDataIndex,
  ContiguousDataSource,
  ManifestPathResolver,
} from '../../types.js';
import { createDataHandler } from './handlers.js';

describe('Data routes', () => {
  describe('createDataHandler', () => {
    let app: express.Express;
    let dataIndex: ContiguousDataIndex;
    let dataSource: ContiguousDataSource;
    let blockListValidator: any;
    let manifestPathResolver: ManifestPathResolver;

    beforeEach(() => {
      app = express();
      dataIndex = {
        getDataAttributes: sinon.stub(),
        getDataParent: sinon.stub(),
        saveDataContentAttributes: sinon.stub(),
      };
      dataSource = {
        getData: sinon.stub().returns({
          stream: Readable.from(Buffer.from('testing...')),
          size: 10,
        }),
      };
      blockListValidator = {
        isIdBlocked: sinon.stub(),
        isHashBlocked: sinon.stub(),
      };
      manifestPathResolver = {
        resolveFromIndex: sinon.stub(),
        resolveFromData: sinon.stub(),
      };
    });

    it('should return 200 status code and data for unblocked data request', async () => {
      app.get(
        '/:id',
        createDataHandler({
          log,
          dataIndex,
          dataSource,
          blockListValidator,
          manifestPathResolver,
        }),
      );
      blockListValidator.isIdBlocked.resolves(false);
      blockListValidator.isHashBlocked.resolves(false);

      return request(app)
        .get('/not-a-real-id')
        .expect(200)
        .then((res: any) => {
          expect(res.body.toString()).to.equal('testing...');
        });
    });

    it('should return 200 status code and empty data for unblocked data HEAD request', async () => {
      app.get(
        '/:id',
        createDataHandler({
          log,
          dataIndex,
          dataSource,
          blockListValidator,
          manifestPathResolver,
        }),
      );
      blockListValidator.isIdBlocked.resolves(false);
      blockListValidator.isHashBlocked.resolves(false);

      return request(app)
        .head('/not-a-real-id')
        .expect(200)
        .then((res: any) => {
          expect(res.body).to.eql({});
        });
    });

    it('should return 206 status code and partial data for a range request', async () => {
      const blockListValidator = {
        isIdBlocked: sinon.stub(),
        isHashBlocked: sinon.stub(),
      };
      app.get(
        '/:id',
        createDataHandler({
          log,
          dataIndex,
          dataSource,
          blockListValidator,
          manifestPathResolver,
        }),
      );

      return request(app)
        .get('/not-a-real-id')
        .set('Range', 'bytes=2-3')
        .expect(206)
        .then((res: any) => {
          expect(res.body.toString()).to.equal('st');
        });
    });

    it('should return 206 status code and empty data for a HEAD range request', async () => {
      const blockListValidator = {
        isIdBlocked: sinon.stub(),
        isHashBlocked: sinon.stub(),
      };
      app.get(
        '/:id',
        createDataHandler({
          log,
          dataIndex,
          dataSource,
          blockListValidator,
          manifestPathResolver,
        }),
      );

      return request(app)
        .head('/not-a-real-id')
        .set('Range', 'bytes=2-3')
        .expect(206)
        .then((res: any) => {
          expect(res.body).to.eql({});
        });
    });

    // Multiple ranges are not yet supported
    it('should return 416 status code for a range request with multiple ranges', async () => {
      app.get(
        '/:id',
        createDataHandler({
          log,
          dataIndex,
          dataSource,
          blockListValidator,
          manifestPathResolver,
        }),
      );
      const get = request(app)
        .get('/not-a-real-id')
        .set('Range', 'bytes=1-2,4-5')
        .expect(416);
      const head = request(app)
        .head('/not-a-real-id')
        .set('Range', 'bytes=1-2,4-5')
        .expect(416);

      await Promise.all([get, head]);
    });

    it('should return 404 given a blocked ID', async () => {
      app.get(
        '/:id',
        createDataHandler({
          log,
          dataIndex,
          dataSource,
          blockListValidator,
          manifestPathResolver,
        }),
      );
      blockListValidator.isIdBlocked.resolves(true);
      const get = request(app).get('/not-a-real-id-id').expect(404);
      const head = request(app).head('/not-a-real-id-id').expect(404);
      await Promise.all([get, head]);
    });
  });
});
