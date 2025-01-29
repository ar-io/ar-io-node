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
import { default as fastq } from 'fastq';
import type { queueAsPromised } from 'fastq';
import * as EventEmitter from 'node:events';
import * as winston from 'winston';

import * as events from '../events.js';
import * as metrics from '../metrics.js';
import {
  ContiguousDataIndex,
  NestedDataIndexWriter,
  NormalizedDataItem,
} from '../types.js';

const DEFAULT_WORKER_COUNT = 1;

export class Ans104DataIndexer {
  // Dependencies
  private log: winston.Logger;
  private eventEmitter: EventEmitter;
  private indexWriter: NestedDataIndexWriter;
  private contiguousDataIndex: ContiguousDataIndex;

  // Data indexing queue
  private queue: queueAsPromised<NormalizedDataItem, void>;

  constructor({
    log,
    eventEmitter,
    indexWriter,
    contiguousDataIndex,
    workerCount = DEFAULT_WORKER_COUNT,
  }: {
    log: winston.Logger;
    eventEmitter: EventEmitter;
    indexWriter: NestedDataIndexWriter;
    contiguousDataIndex: ContiguousDataIndex;
    workerCount?: number;
  }) {
    this.log = log.child({ class: 'Ans104DataIndexer' });
    this.indexWriter = indexWriter;
    this.contiguousDataIndex = contiguousDataIndex;
    this.eventEmitter = eventEmitter;

    this.queue = fastq.promise(this.indexDataItem.bind(this), workerCount);
  }

  async queueDataItem(item: NormalizedDataItem): Promise<void> {
    const log = this.log.child({
      method: 'queueDataItem',
      id: item.id,
      parentId: item.parent_id,
      rootTxId: item.root_tx_id,
      dataOffset: item?.data_offset,
      dataSize: item?.data_size,
    });

    log.debug('Queueing data item for indexing...');
    this.queue.push(item);
    log.debug('Data item queued for indexing.');
  }

  queueDepth(): number {
    return this.queue.length();
  }

  async indexDataItem(item: NormalizedDataItem): Promise<void> {
    const log = this.log.child({
      method: 'indexDataItem',
      id: item.id,
      parentId: item.parent_id,
      rootTxId: item.root_tx_id,
      dataOffset: item.data_offset,
      dataSize: item.data_size,
    });

    try {
      if (
        typeof item.data_offset === 'number' &&
        !Number.isNaN(item.data_offset) &&
        typeof item.data_size === 'number' &&
        !Number.isNaN(item.data_size)
      ) {
        log.debug('Indexing data item data...');
        if (item.data_hash != null) {
          await this.contiguousDataIndex.saveDataContentAttributes({
            id: item.id,
            parentId: item.parent_id,
            hash: item.data_hash,
            dataSize: item.data_size,
            contentType: item.content_type,
          });

          // Index data hash to parent ID relationship
          if (item.parent_id != null) {
            await this.indexWriter.saveNestedDataHash({
              hash: item.data_hash,
              parentId: item.parent_id,
              dataOffset: item.data_offset,
            });
          } else {
            log.warn(
              'Skipping data item nested data indexing due to missing parent ID.',
            );
          }
        } else {
          log.warn('Skipping data item data indexing due to missing hash.');
        }

        // Index data offset and size for ID to parent ID relationship
        if (item.parent_id != null) {
          await this.indexWriter.saveNestedDataId({
            id: item.id,
            parentId: item.parent_id,
            dataOffset: item.data_offset,
            dataSize: item.data_size,
          });
        } else {
          log.warn(
            'Skipping data item parent ID indexing due to missing parent ID.',
          );
        }
        metrics.dataItemDataIndexedCounter.inc({
          parent_type:
            item.parent_id === item.root_tx_id ? 'transaction' : 'data_item',
        });
        this.eventEmitter.emit(events.ANS104_DATA_ITEM_DATA_INDEXED, item);
        log.debug('Data item data indexed.');
      } else {
        this.log.warn('Data item data is missing data offset or size.');
      }
    } catch (error: any) {
      log.error('Failed to index data item data:', {
        message: error.message,
        stack: error.stack,
        id: item.id,
      });
    }
  }

  async stop(): Promise<void> {
    const log = this.log.child({ method: 'stop' });
    this.queue.kill();
    await this.queue.drained();
    log.debug('Stopped successfully.');
  }
}
