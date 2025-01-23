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
import { Readable } from 'node:stream';
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  it,
  mock,
} from 'node:test';
import winston from 'winston';
import { ContiguousDataIndex, ContiguousDataSource } from '../types.js';

import { DataVerificationWorker } from './data-verification.js';

describe('DataVerificationWorker', () => {
  let log: winston.Logger;
  let dataVerificationWorker: DataVerificationWorker;
  let contiguousDataIndex: ContiguousDataIndex;
  let contiguousDataSource: ContiguousDataSource;

  before(() => {
    log = winston.createLogger({ silent: true });

    contiguousDataIndex = {
      getDataAttributes: async () => {
        return {
          dataRoot: 'UwpYX2u5CYy6hYJbRTWfBxIig01UDe74SY7Om3_1ftw',
        };
      },
      saveVerificationStatus: async () => {
        return true;
      },
    } as any;

    contiguousDataSource = {
      getData: () =>
        Promise.resolve({
          stream: Readable.from(Buffer.from('testing...')),
          size: 10,
          verified: false,
          cached: false,
        }),
    };

    dataVerificationWorker = new DataVerificationWorker({
      log,
      contiguousDataIndex,
      contiguousDataSource,
    });
  });

  afterEach(async () => {
    mock.restoreAll();
  });

  after(async () => {
    await dataVerificationWorker.stop();
  });

  it('should verify data root correctly', async () => {
    assert.equal(await dataVerificationWorker.verifyDataRoot(''), true);
  });

  it('should fail verification when they dont match', async () => {
    (contiguousDataIndex as any).getDataAttributes = async () => {
      return {
        dataRoot: 'nomatch',
      };
    };

    assert.equal(await dataVerificationWorker.verifyDataRoot(''), false);
  });
});
