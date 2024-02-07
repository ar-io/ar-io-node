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
import arbundles from 'arbundles/stream/index.js';
import * as EventEmitter from 'node:events';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream';
import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from 'node:worker_threads';
import * as winston from 'winston';

import * as events from '../events.js';
import { createFilter } from '../filters.js';
import log from '../log.js';
import {
  ContiguousData,
  ContiguousDataSource,
  NormalizedDataItem,
} from '../types.js';
import { fromB64Url, sha256B64Url, utf8ToB64Url } from './encoding.js';

/* eslint-disable */
// @ts-ignore
const { default: processStream } = arbundles;

type ParseEventName =
  | 'data-item-matched'
  | 'unbundle-complete'
  | 'unbundle-error';

const DATA_ITEM_MATCHED: ParseEventName = 'data-item-matched';
const UNBUNDLE_COMPLETE: ParseEventName = 'unbundle-complete';
const UNBUNDLE_ERROR: ParseEventName = 'unbundle-error';

const DEFAULT_STREAM_TIMEOUT = 1000 * 30; // 30 seconds

interface ParserMessage {
  eventName: ParseEventName;
  dataItem?: NormalizedDataItem;
  dataItemIndexFilterString?: string;
  itemCount?: number;
  matchedItemCount?: number;
}

export function normalizeAns104DataItem({
  rootTxId,
  parentId,
  parentIndex,
  index,
  filter,
  ans104DataItem,
}: {
  rootTxId: string;
  parentId: string;
  parentIndex: number;
  index: number;
  filter: string;
  ans104DataItem: Record<string, any>;
}): NormalizedDataItem {
  const tags = (ans104DataItem.tags || []).map(
    (tag: { name: string; value: string }) => ({
      name: utf8ToB64Url(tag.name),
      value: utf8ToB64Url(tag.value),
    }),
  );

  return {
    id: ans104DataItem.id,
    index: index,
    parent_id: parentId,
    parent_index: parentIndex,
    root_tx_id: rootTxId,
    signature: ans104DataItem.signature,
    owner: ans104DataItem.owner,
    owner_address: sha256B64Url(fromB64Url(ans104DataItem.owner)),
    target: ans104DataItem.target,
    anchor: ans104DataItem.anchor,
    tags,
    data_offset: ans104DataItem.dataOffset,
    data_size: ans104DataItem.dataSize,
    filter,
  } as NormalizedDataItem;
}

export class Ans104Parser {
  private log: winston.Logger;
  private contiguousDataSource: ContiguousDataSource;
  private streamTimeout: number;
  private workers: any[] = []; // TODO what's the type for this?
  private workQueue: any[] = []; // TODO what's the type for this?

  constructor({
    log,
    eventEmitter,
    contiguousDataSource,
    dataItemIndexFilterString,
    workerCount,
    streamTimeout = DEFAULT_STREAM_TIMEOUT,
  }: {
    log: winston.Logger;
    eventEmitter: EventEmitter;
    contiguousDataSource: ContiguousDataSource;
    dataItemIndexFilterString: string;
    workerCount: number;
    streamTimeout?: number;
  }) {
    this.log = log.child({ class: 'Ans104Parser' });
    this.contiguousDataSource = contiguousDataSource;
    this.streamTimeout = streamTimeout;

    const self = this;

    function spawn() {
      const workerUrl = new URL('./ans-104.js', import.meta.url);
      const worker = new Worker(workerUrl, {
        workerData: {
          dataItemIndexFilterString,
        },
      });

      let job: any = null; // Current item from the queue
      let error: any = null; // Error that caused the worker to crash

      function takeWork() {
        if (!job && self.workQueue.length) {
          // If there's a job in the queue, send it to the worker
          job = self.workQueue.shift();
          worker.postMessage(job.message);
        }
      }

      worker
        .on('online', () => {
          self.workers.push({ takeWork });
          takeWork();
        })
        .on('message', (message: ParserMessage) => {
          switch (message.eventName) {
            case DATA_ITEM_MATCHED:
              eventEmitter.emit(
                events.ANS104_DATA_ITEM_MATCHED,
                message.dataItem,
              );
              break;
            case UNBUNDLE_COMPLETE:
              const { eventName, ...eventBody } = message;
              eventEmitter.emit(events.ANS104_UNBUNDLE_COMPLETE, {
                dataItemIndexFilterString,
                ...eventBody,
              });
              job.resolve();
              job = null;
              break;
            case UNBUNDLE_ERROR:
              job.reject(new Error('Worker error'));
              job = null;
              break;
            default:
              job.reject(new Error('Unknown worker message'));
              job = null;
              break;
          }
          takeWork(); // Check if there's more work to do
        })
        .on('error', (err) => {
          self.log.error('Worker error', err);
          error = err;
        })
        .on('exit', (code) => {
          self.workers = self.workers.filter(
            (w: any) => w.takeWork !== takeWork,
          );
          if (job) {
            job.reject(error || new Error('worker died'));
          }
          if (code !== 0) {
            self.log.error('Worker stopped with exit code ' + code, {
              exitCode: code,
            });
            spawn(); // Worker died, so spawn a new one
          }
        });
    }

    for (let i = 0; i < workerCount; i++) {
      spawn();
    }
  }

  async stop(): Promise<void> {
    const log = this.log.child({ method: 'stop' });
    const promises: Promise<any>[] = [];
    this.workers.forEach(() => {
      promises.push(this.queueWork('terminate'));
    });

    await Promise.all(promises);
    log.debug('Stopped successfully.');
  }

  drainQueue() {
    for (const worker of this.workers) {
      worker.takeWork();
    }
  }

  queueWork(message: any): Promise<any> {
    return new Promise((resolve, reject) => {
      this.workQueue.push({
        resolve,
        reject,
        message,
      });
      this.drainQueue();
    });
  }

  async parseBundle({
    rootTxId,
    parentId,
    parentIndex,
  }: {
    rootTxId: string;
    parentId: string;
    parentIndex: number;
  }): Promise<void> {
    return new Promise(async (resolve, reject) => {
      let bundlePath: string | undefined;
      let data: ContiguousData | undefined;
      try {
        const log = this.log.child({ parentId });

        // Get data stream
        data = await this.contiguousDataSource.getData(parentId);

        // Construct temp path for passing data to worker
        await fsPromises.mkdir(path.join(process.cwd(), 'data/tmp/ans-104'), {
          recursive: true,
        });
        bundlePath = path.join(
          process.cwd(),
          'data/tmp/ans-104',
          `${parentId}-${Math.random().toString(36).substring(2, 15)}`,
        );

        // Setup timeout for stalled data streams
        let timeout: NodeJS.Timeout;
        const resetTimeout = () => {
          if (timeout !== undefined) {
            clearTimeout(timeout);
          }
          timeout = setTimeout(() => {
            data?.stream.destroy(new Error('Timeout'));
          }, this.streamTimeout);
        };
        data.stream.on('data', resetTimeout);
        data.stream.pause();

        // Write data stream to temp file
        const writeStream = fs.createWriteStream(bundlePath);
        pipeline(data.stream, writeStream, async (error) => {
          if (error !== undefined) {
            reject(error);
            log.error('Error writing ANS-104 bundle stream', error);
            if (bundlePath !== undefined) {
              try {
                await fsPromises.unlink(bundlePath);
              } catch (error: any) {
                log.error('Error deleting ANS-104 bundle temporary file', {
                  message: error?.message,
                  stack: error?.stack,
                });
              }
            }
          } else {
            log.info('Parsing ANS-104 bundle stream...');
            this.workQueue.push({
              resolve,
              reject,
              message: {
                rootTxId,
                parentId,
                parentIndex,
                bundlePath,
              },
            });
            this.drainQueue();
          }
        });
      } catch (error) {
        reject(error);
        if (bundlePath !== undefined) {
          try {
            await fsPromises.unlink(bundlePath);
          } catch (error: any) {
            log.error('Error deleting ANS-104 bundle temporary file', {
              message: error?.message,
              stack: error?.stack,
            });
          }
        }
        if (data !== undefined) {
          try {
            data.stream.destroy();
          } catch (error: any) {
            log.error('Error destroying ANS-104 data stream', {
              message: error?.message,
              stack: error?.stack,
            });
          }
        }
      }
    });
  }
}

if (!isMainThread) {
  const filter = createFilter(JSON.parse(workerData.dataItemIndexFilterString));
  parentPort?.on('message', async (message: any) => {
    if (message == 'terminate') {
      parentPort?.postMessage(null);
      process.exit(0);
    }

    const { rootTxId, parentId, parentIndex, bundlePath } = message;
    let stream: fs.ReadStream | undefined = undefined;
    try {
      stream = fs.createReadStream(bundlePath);
      const iterable = await processStream(stream);
      const bundleLength = iterable.length;
      let matchedItemCount = 0;

      const fnLog = log.child({ rootTxId, parentId, bundleLength });
      fnLog.info('Unbundling ANS-104 bundle stream data items...');

      const processedDataItemIds = new Set<string>();
      for await (const [index, dataItem] of iterable.entries()) {
        const diLog = fnLog.child({
          dataItemId: dataItem.id,
          dataItemIndex: index,
        });
        diLog.info('Processing data item...');

        if (!dataItem.id) {
          diLog.warn('Skipping data item with missing ID.');
          continue;
        }

        if (processedDataItemIds.has(dataItem.id)) {
          diLog.warn('Skipping duplicate data item ID.');
          continue;
        }

        if (!dataItem.dataOffset) {
          diLog.warn('Skipping data item with missing data offset.');
        }

        const normalizedDataItem = normalizeAns104DataItem({
          rootTxId: rootTxId as string,
          parentId: parentId as string,
          parentIndex: parentIndex as number,
          index: index as number,
          filter: workerData.dataItemIndexFilterString,
          ans104DataItem: dataItem as Record<string, any>,
        });

        if (await filter.match(normalizedDataItem)) {
          matchedItemCount++;
          parentPort?.postMessage({
            eventName: DATA_ITEM_MATCHED,
            dataItem: normalizedDataItem,
          });
        } else {
          diLog.debug('Data item did not match index filter.');
        }
      }
      parentPort?.postMessage({
        eventName: UNBUNDLE_COMPLETE,
        parentId: parentId as string,
        itemCount: bundleLength,
        matchedItemCount,
      });
    } catch (error: any) {
      log.error('Error unbundling ANS-104 bundle stream', {
        message: error?.message,
        stack: error?.stack,
      });
      parentPort?.postMessage({ eventName: 'unbundle-error' });
    } finally {
      try {
        await fsPromises.unlink(bundlePath);
      } catch (error: any) {
        log.error('Error deleting ANS-104 bundle temporary file', {
          message: error?.message,
          stack: error?.stack,
        });
      }
      if (stream !== undefined) {
        try {
          stream.destroy();
        } catch (error: any) {
          log.error('Error destroying ANS-104 bundle temporary file stream', {
            message: error?.message,
            stack: error?.stack,
          });
        }
      }
    }
  });
}
