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

import { emitAns104UnbundleEvents } from '../lib/bundles.js';
import {
  ContiguousDataSource,
  ItemFilter,
  PartialJsonTransaction,
} from '../types.js';

const DEFAULT_WORKER_COUNT = 1;

export class Ans104Unbundler {
  // Dependencies
  private log: winston.Logger;
  private eventEmitter: EventEmitter;
  private filter: ItemFilter;
  private contigousDataSource: ContiguousDataSource;

  // Unbundling queue
  private queue: queueAsPromised<PartialJsonTransaction, void>;

  constructor({
    log,
    eventEmitter,
    filter,
    contiguousDataSource,
    workerCount = DEFAULT_WORKER_COUNT,
  }: {
    log: winston.Logger;
    eventEmitter: EventEmitter;
    filter: ItemFilter;
    contiguousDataSource: ContiguousDataSource;
    workerCount?: number;
  }) {
    this.log = log.child({ class: 'Ans104Unbundler' });
    this.eventEmitter = eventEmitter;
    this.filter = filter;
    this.contigousDataSource = contiguousDataSource;

    this.queue = fastq.promise(this.unbundle.bind(this), workerCount);
  }

  async queueTx(tx: PartialJsonTransaction): Promise<void> {
    const log = this.log.child({ method: 'queueTx', txId: tx.id });
    log.debug('Queueing bundle...');
    this.queue.push(tx);
    log.debug('Bundle queued.');
  }

  async unbundle(tx: PartialJsonTransaction): Promise<void> {
    const log = this.log.child({ method: 'unbundle', txId: tx.id });
    try {
      if (await this.filter.match(tx)) {
        log.info('Unbundling bundle...');
        const dataStream = await this.contigousDataSource.getData(tx.id);
        await emitAns104UnbundleEvents({
          log: this.log,
          eventEmitter: this.eventEmitter,
          bundleStream: dataStream.stream,
          parentTxId: tx.id,
        });
        log.info('Bundle unbundled.');
      }
    } catch (error) {
      log.error('Unbundling failed:', error);
    }
  }
}
