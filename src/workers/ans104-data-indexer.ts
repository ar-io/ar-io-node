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
import * as EventEmitter from 'node:events';
import * as winston from 'winston';

import { ItemFilter, NestedDataIndexer, NormalizedDataItem } from '../types.js';

export class Ans104DataIndexer {
  // Dependencies
  private log: winston.Logger;
  private eventEmitter: EventEmitter;
  private filter: ItemFilter;
  private indexWriter: NestedDataIndexer;

  constructor({
    log,
    eventEmitter,
    filter,
    indexWriter,
  }: {
    log: winston.Logger;
    eventEmitter: EventEmitter;
    filter: ItemFilter;
    indexWriter: NestedDataIndexer;
  }) {
    this.log = log.child({ class: 'Ans104DataIndexer' });
    this.eventEmitter = eventEmitter;
    this.filter = filter;
    this.indexWriter = indexWriter;

    // TODO use a queue
    this.eventEmitter.on('data-item-unbundled', this.index.bind(this));
  }

  async index(item: NormalizedDataItem): Promise<void> {
    if (await this.filter.match(item)) {
      if (
        typeof item.data_offset === 'number' &&
        typeof item.data_size === 'number'
      ) {
        this.log.debug('Indexing ANS-104 data item data by ID.', {
          id: item.id,
          parentId: item.parent_id,
          dataOffset: item.data_offset,
          dataSize: item.data_size,
        });
        this.indexWriter.saveNestedDataId({
          id: item.id,
          parentId: item.parent_id,
          dataOffset: item.data_offset,
          dataSize: item.data_size,
        });
      }
    }
  }
}
