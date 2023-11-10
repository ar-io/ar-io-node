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
import express from 'express';
import sinon from 'sinon';
import { default as request } from 'supertest';

import log from '../../log.js';
import {
  BlockListValidator,
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
    let blockListValidator: BlockListValidator;
    let manifestPathResolver: ManifestPathResolver;

    beforeEach(() => {
      app = express();
      dataIndex = {
        getDataAttributes: sinon.stub(),
        getDataParent: sinon.stub(),
        saveDataContentAttributes: sinon.stub(),
      };
      dataSource = { getData: sinon.stub() };
      blockListValidator = {
        isIdBlocked: sinon.stub(),
        isHashBlocked: sinon.stub(),
      };
      manifestPathResolver = {
        resolveFromIndex: sinon.stub(),
        resolveFromData: sinon.stub(),
      };
    });

    it('should handle blocked ID', async () => {
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
      blockListValidator.isIdBlocked.resolves(true);
      request(app)
        .get('/id')
        .expect(404)
        .end((err: any, _res: any) => {
          if (err) throw err;
        });
    });
  });
});
