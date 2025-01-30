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
import * as winston from 'winston';

import { ContiguousDataIndex } from '../types.js';

const DEFAULT_WORKER_COUNT = 1;
const DEFAULT_MAX_QUEUE_SIZE = 100;

export type DataContentAttributeProperties = {
  id: string;
  dataRoot?: string;
  hash: string;
  dataSize: number;
  contentType?: string;
  cachedAt?: number;
  verified?: boolean;
};

export class DataContentAttributeImporter {
  private log: winston.Logger;
  private contiguousDataIndex: ContiguousDataIndex;
  private maxQueueSize: number;
  private queue: queueAsPromised<DataContentAttributeProperties, void>;

  constructor({
    log,
    contiguousDataIndex,
    workerCount = DEFAULT_WORKER_COUNT,
    maxQueueSize = DEFAULT_MAX_QUEUE_SIZE,
  }: {
    log: winston.Logger;
    contiguousDataIndex: ContiguousDataIndex;
    workerCount?: number;
    maxQueueSize?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.contiguousDataIndex = contiguousDataIndex;
    this.maxQueueSize = maxQueueSize;

    this.queue = fastq.promise(
      this.saveDataContentAttributes.bind(this),
      workerCount,
    );
  }

  queueDataContentAttributes(properties: DataContentAttributeProperties): void {
    const log = this.log.child({
      method: 'queueDataContentAttributes',
      id: properties.id,
    });
    if (this.queue.length() >= this.maxQueueSize) {
      log.debug('Skipping save data content attributes, queue is full.');
    } else {
      log.debug('Queueing data content attributes to be saved...');
      this.queue.push(properties);
      log.debug('Data content attributes queued.');
    }
  }

  private async saveDataContentAttributes(
    properties: DataContentAttributeProperties,
  ): Promise<void> {
    const log = this.log.child({ id: properties.id });
    log.debug('Saving data content attributes...');
    await this.contiguousDataIndex.saveDataContentAttributes(properties);
    log.debug('Data content attributes saved...');
  }

  async stop(): Promise<void> {
    const log = this.log.child({ method: 'stop' });
    this.queue.kill();
    log.debug('Stopped successfully.');
  }

  queueDepth(): number {
    return this.queue.length();
  }
}
