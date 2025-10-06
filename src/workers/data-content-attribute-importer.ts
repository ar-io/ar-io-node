/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
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
  verificationPriority?: number;
  rootTransactionId?: string;
  rootParentOffset?: number;
  dataOffset?: number;
  dataItemSize?: number;
  dataItemOffset?: number;
  formatId?: number;
  rootDataItemOffset?: number;
  rootDataOffset?: number;
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
      log.debug('Queueing data content attributes to be saved...', {
        rootTransactionId: properties.rootTransactionId,
        rootDataItemOffset: properties.rootDataItemOffset,
        rootDataOffset: properties.rootDataOffset,
      });
      this.queue.push(properties);
      log.debug('Data content attributes queued.');
    }
  }

  private async saveDataContentAttributes(
    properties: DataContentAttributeProperties,
  ): Promise<void> {
    const log = this.log.child({ id: properties.id });
    log.debug('Saving data content attributes...', {
      rootTransactionId: properties.rootTransactionId,
      rootDataItemOffset: properties.rootDataItemOffset,
      rootDataOffset: properties.rootDataOffset,
    });
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
