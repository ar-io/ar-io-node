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

import { Ans104Parser } from '../lib/ans-104.js';
import {
  ContiguousDataSource,
  ItemFilter,
  NormalizedDataItem,
  PartialJsonTransaction,
} from '../types.js';

const DEFAULT_WORKER_COUNT = 1;

interface IndexProperty {
  index: number;
}

type UnbundleableItem = (NormalizedDataItem | PartialJsonTransaction) &
  IndexProperty;

export class Ans104Unbundler {
  // Dependencies
  private log: winston.Logger;
  private filter: ItemFilter;

  // Unbundling queue
  private queue: queueAsPromised<UnbundleableItem, void>;

  // Parser
  private ans104Parser: Ans104Parser;

  constructor({
    log,
    eventEmitter,
    filter,
    contiguousDataSource,
    dataItemIndexFilterString,
    workerCount = DEFAULT_WORKER_COUNT,
  }: {
    log: winston.Logger;
    eventEmitter: EventEmitter;
    filter: ItemFilter;
    contiguousDataSource: ContiguousDataSource;
    dataItemIndexFilterString: string;
    workerCount?: number;
  }) {
    this.log = log.child({ class: 'Ans104Unbundler' });
    this.filter = filter;
    this.ans104Parser = new Ans104Parser({
      log,
      eventEmitter,
      contiguousDataSource,
      dataItemIndexFilterString,
    });

    this.queue = fastq.promise(this.unbundle.bind(this), workerCount);
  }

  async queueItem(item: UnbundleableItem): Promise<void> {
    const log = this.log.child({ method: 'queueItem', id: item.id });
    log.debug('Queueing bundle...');
    this.queue.push(item);
    log.debug('Bundle queued.');
  }

  async unbundle(item: UnbundleableItem): Promise<void> {
    const log = this.log.child({ method: 'unbundle', id: item.id });
    try {
      let rootTxId: string | undefined;
      if ('root_tx_id' in item) {
        // Data item with root_tx_id
        rootTxId = item.root_tx_id;
      } else if ('last_tx' in item) {
        // Layer 1 transaction
        rootTxId = item.id;
      } else {
        // Data item without root_tx_id (should be impossible)
        throw new Error('Missing root_tx_id on data item.');
      }
      if (await this.filter.match(item)) {
        log.info('Unbundling bundle...');
        await this.ans104Parser.parseBundle({
          rootTxId,
          parentId: item.id,
          parentIndex: item.index,
        });
        log.info('Bundle unbundled.');
      }
    } catch (error) {
      log.error('Unbundling failed:', error);
    }
  }
}
