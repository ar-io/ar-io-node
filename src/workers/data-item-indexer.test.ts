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
import EventEmitter from 'node:events';
import { after, before, describe, it } from 'node:test';
import winston from 'winston';
import { NormalizedDataItem } from '../types.js';
import { DataItemIndexer } from './data-item-indexer.js';

describe('DataItemIndexer', function () {
  let log: winston.Logger;
  let dataItemIndexer: DataItemIndexer;

  const mockDataItem = {
    id: 'test-id',
    parent_id: 'parent-id',
    root_tx_id: 'root-tx-id',
    data_offset: 0,
    data_size: 100,
  } as NormalizedDataItem;

  before(async function () {
    log = winston.createLogger({
      silent: true,
    });
    const mockEventEmitter = new EventEmitter();
    const mockIndexWriter = {
      saveDataItem: async () => {}, // eslint-disable-line @typescript-eslint/no-empty-function
      saveNestedDataId: async () => {}, // eslint-disable-line @typescript-eslint/no-empty-function
      saveNestedDataHash: async () => {}, // eslint-disable-line @typescript-eslint/no-empty-function
    };

    dataItemIndexer = new DataItemIndexer({
      log,
      eventEmitter: mockEventEmitter,
      indexWriter: mockIndexWriter,
      shouldUnbundle: (queueDepth) => queueDepth < 5,
    });
  });

  after(async function () {
    await dataItemIndexer.stop();
  });

  it.only('Should skip indexing data items if shouldUnbundle returns false', async function () {
    for (let i = 0; i < 10; i++) {
      dataItemIndexer.queueDataItem(mockDataItem);
    }

    assert.equal(dataItemIndexer.queueDepth(), 5);
  });
});
