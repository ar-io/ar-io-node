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

import { emitAns104UnbundleEvents } from '../lib/bundles.js';
import {
  ContiguousDataSource,
  PartialJsonTransaction,
  TransactionFilter,
} from '../types.js';

export class Ans104Unbundler {
  // Dependencies
  private log: winston.Logger;
  private eventEmitter: EventEmitter;
  private filter: TransactionFilter;
  private contigousDataSource: ContiguousDataSource;

  constructor({
    log,
    eventEmitter,
    filter,
    contiguousDataSource,
  }: {
    log: winston.Logger;
    eventEmitter: EventEmitter;
    filter: TransactionFilter;
    contiguousDataSource: ContiguousDataSource;
  }) {
    this.log = log.child({ class: 'Ans104Unbundler' });
    this.eventEmitter = eventEmitter;
    this.filter = filter;
    this.contigousDataSource = contiguousDataSource;

    this.eventEmitter.on('ans104-tx-saved', this.unbundle.bind(this));
  }

  async unbundle(tx: PartialJsonTransaction): Promise<void> {
    // TODO add logging
    if (await this.filter.match(tx)) {
      const dataStream = await this.contigousDataSource.getData(tx.id);

      emitAns104UnbundleEvents({
        log: this.log,
        eventEmitter: this.eventEmitter,
        bundleStream: dataStream.stream,
        parentTxId: tx.id,
      });
    }
  }
}
