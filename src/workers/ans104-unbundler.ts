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

const DEFAULT_MAX_QUEUE_SIZE = 1000;

interface IndexProperty {
  index: number;
}

export type UnbundleableItem = (NormalizedDataItem | PartialJsonTransaction) &
  IndexProperty;

export class Ans104Unbundler {
  // Dependencies
  private log: winston.Logger;
  private filter: ItemFilter;

  // Unbundling queue
  private workerCount: number;
  private maxQueueSize: number;
  private queue: queueAsPromised<UnbundleableItem, void>;
  private shouldUnbundle: () => boolean;

  // Parser
  private ans104Parser: Ans104Parser;

  constructor({
    log,
    eventEmitter,
    filter,
    contiguousDataSource,
    dataItemIndexFilterString,
    workerCount,
    maxQueueSize = DEFAULT_MAX_QUEUE_SIZE,
    shouldUnbundle = () => true,
    ans104Parser,
  }: {
    log: winston.Logger;
    eventEmitter: EventEmitter;
    filter: ItemFilter;
    contiguousDataSource: ContiguousDataSource;
    dataItemIndexFilterString: string;
    workerCount: number;
    maxQueueSize?: number;
    shouldUnbundle?: () => boolean;
    ans104Parser?: Ans104Parser;
  }) {
    this.log = log.child({ class: 'Ans104Unbundler' });
    this.filter = filter;
    this.ans104Parser =
      ans104Parser ||
      new Ans104Parser({
        log,
        eventEmitter,
        contiguousDataSource,
        workerCount,
        dataItemIndexFilterString,
      });

    this.workerCount = workerCount;
    this.maxQueueSize = maxQueueSize;
    this.queue = fastq.promise(
      this.unbundle.bind(this),
      Math.max(workerCount, 1),
    );
    this.shouldUnbundle = shouldUnbundle;
  }

  async queueItem(
    item: UnbundleableItem,
    prioritized: boolean | undefined,
  ): Promise<void> {
    const log = this.log.child({ method: 'queueItem', id: item.id });

    if (this.workerCount === 0) {
      log.warn('Skipping data item queuing due to no workers.');
      return;
    }

    if (!this.shouldUnbundle()) {
      log.warn('Skipping data item queuing due to high queue depth.');
      return;
    }

    if (prioritized === true) {
      log.debug('Queueing prioritized bundle...');
      this.queue.unshift(item);
      log.debug('Prioritized bundle queued.');
    } else if (this.queue.length() < this.maxQueueSize) {
      log.debug('Queueing bundle...');
      this.queue.push(item);
      log.debug('Bundle queued.');
    } else {
      log.debug('Skipping unbundle, queue is full.');
    }
  }

  async unbundle(item: UnbundleableItem): Promise<void> {
    const log = this.log.child({ method: 'unbundle', id: item.id });
    try {
      let rootTxId: string | undefined;
      if ('root_tx_id' in item && item.root_tx_id !== null) {
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
    } catch (error: any) {
      log.error('Unbundling failed:', {
        message: error?.message,
        stack: error?.stack,
      });
    }
  }

  queueDepth(): number {
    return this.queue.length();
  }

  async stop(): Promise<void> {
    const log = this.log.child({ method: 'stop' });
    this.queue.kill();
    await this.queue.drained();
    await this.ans104Parser.stop();
    log.debug('Stopped successfully.');
  }
}
