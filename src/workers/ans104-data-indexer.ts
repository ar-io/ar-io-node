/**
 * AR.IO Gateway
 * Copyright (C) 2022 Permanent Data Solutions, Inc
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
import { default as fastq } from 'fastq';
import type { queueAsPromised } from 'fastq';
import * as EventEmitter from 'node:events';
import * as winston from 'winston';

import { NestedDataIndexWriter, NormalizedDataItem } from '../types.js';

const DEFAULT_WORKER_COUNT = 1;

export class Ans104DataIndexer {
  // Dependencies
  private log: winston.Logger;
  private eventEmitter: EventEmitter;
  private indexWriter: NestedDataIndexWriter;

  // Data indexing queue
  private queue: queueAsPromised<NormalizedDataItem, void>;

  constructor({
    log,
    eventEmitter,
    indexWriter,
    workerCount = DEFAULT_WORKER_COUNT,
  }: {
    log: winston.Logger;
    eventEmitter: EventEmitter;
    indexWriter: NestedDataIndexWriter;
    workerCount?: number;
  }) {
    this.log = log.child({ class: 'Ans104DataIndexer' });
    this.indexWriter = indexWriter;
    this.eventEmitter = eventEmitter;

    this.queue = fastq.promise(this.indexDataItem.bind(this), workerCount);
  }

  async queueDataItem(item: NormalizedDataItem): Promise<void> {
    const log = this.log.child({
      method: 'queueDataItem',
      id: item.id,
      parentId: item.parent_id,
      dataOffset: item?.data_offset,
      dataSize: item?.data_size,
    });
    log.debug('Queueing data item for indexing...');
    this.queue.push(item);
    log.debug('Data item queued for indexing.');
  }

  async indexDataItem(item: NormalizedDataItem): Promise<void> {
    const log = this.log.child({
      method: 'indexDataItem',
      id: item.id,
      parentId: item.parent_id,
      dataOffset: item?.data_offset,
      dataSize: item?.data_size,
    });

    try {
      if (
        typeof item.data_offset === 'number' &&
        typeof item.data_size === 'number'
      ) {
        log.debug('Indexing data item data...');
        this.indexWriter.saveNestedDataId({
          id: item.id,
          parentId: item.parent_id,
          dataOffset: item.data_offset,
          dataSize: item.data_size,
        });
        this.eventEmitter.emit('ans104-data-indexed', item);
        log.debug('Data item data indexed.');
      } else {
        this.log.warn('Data item data is missing data offset or size.');
      }
    } catch (error) {
      log.error('Failed to index data item data:', error);
    }
  }
}
