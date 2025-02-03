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
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import * as winston from 'winston';
import { computeDataRootFromReadable } from './data-root-streaming.js';

import log from '../log.js';
import { ContiguousData, ContiguousDataSource } from '../types.js';

type ParseEventName = 'data-root-success' | 'data-root-failure';

const DATA_ROOT_SUCCESS: ParseEventName = 'data-root-success';
const DATA_ROOT_FAILURE: ParseEventName = 'data-root-failure';

const DEFAULT_STREAM_TIMEOUT = 1000 * 30; // 30 seconds

interface ParserMessage {
  eventName: ParseEventName;
  computedDataRoot?: string;
  id?: string;
}

export class DataRootComputer {
  private log: winston.Logger;
  private contiguousDataSource: ContiguousDataSource;
  private streamTimeout: number;
  private workers: any[] = []; // TODO what's the type for this?
  private workQueue: any[] = []; // TODO what's the type for this?

  constructor({
    log,
    contiguousDataSource,
    workerCount,
    streamTimeout = DEFAULT_STREAM_TIMEOUT,
  }: {
    log: winston.Logger;
    contiguousDataSource: ContiguousDataSource;
    workerCount: number;
    streamTimeout?: number;
  }) {
    this.log = log.child({ class: 'DataRootComputer' });
    this.contiguousDataSource = contiguousDataSource;
    this.streamTimeout = streamTimeout;

    const self = this; // eslint-disable-line @typescript-eslint/no-this-alias

    function spawn() {
      const workerUrl = new URL('./data-root.js', import.meta.url);
      const worker = new Worker(workerUrl);

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
          // Handle termination message from worker
          if (message !== null) {
            switch (message.eventName) {
              case DATA_ROOT_SUCCESS:
                job.resolve(message.computedDataRoot);
                break;
              case DATA_ROOT_FAILURE:
                job.reject(new Error('Worker error'));
                break;
              default:
                job.reject(new Error('Unknown worker message'));
                break;
            }
            job = null;
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
            // handle worker termination
            if (job.message === 'terminate') {
              job.resolve();
            } else {
              job.reject(error || new Error('worker died'));
            }
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

  async computeDataRoot(id: string): Promise<string | undefined> {
    const tempPath = 'data/tmp/data-root';
    // eslint-disable-next-line no-async-promise-executor
    return new Promise(async (resolve, reject) => {
      let dataPath: string | undefined;
      let data: ContiguousData | undefined;
      try {
        const log = this.log.child({ id });

        // Get data stream
        data = await this.contiguousDataSource.getData({ id });

        // Construct temp path for passing data to worker
        await fsPromises.mkdir(path.join(process.cwd(), tempPath), {
          recursive: true,
        });
        dataPath = path.join(
          process.cwd(),
          tempPath,
          `${id}-${Math.random().toString(36).substring(2, 15)}`,
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
        const writeStream = fs.createWriteStream(dataPath);
        pipeline(data.stream, writeStream, async (error) => {
          if (error !== undefined) {
            reject(error);
            log.error('Error writing TX stream', error);
            if (dataPath !== undefined) {
              try {
                await fsPromises.unlink(dataPath);
              } catch (error: any) {
                log.error('Error deleting temporary file', {
                  message: error?.message,
                  stack: error?.stack,
                });
              }
            }
          } else {
            this.workQueue.push({
              resolve,
              reject,
              message: {
                dataPath,
                id,
              },
            });
            this.drainQueue();
          }
        });
      } catch (error) {
        reject(error);
        if (dataPath !== undefined) {
          try {
            await fsPromises.unlink(dataPath);
          } catch (error: any) {
            log.error('Error deleting temporary file', {
              message: error?.message,
              stack: error?.stack,
            });
          }
        }
        if (data !== undefined) {
          try {
            data.stream.destroy();
          } catch (error: any) {
            log.error('Error destroying data stream', {
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
  parentPort?.on('message', async (message: any) => {
    if (message === 'terminate') {
      parentPort?.postMessage(null);
      process.exit(0);
    }

    const { id, dataPath } = message;
    const fnLog = log.child({ id, worker: true });
    try {
      const dataBuffer = fs.createReadStream(dataPath);
      fnLog.debug('Computing data root...');
      const dataRootB64Url = await computeDataRootFromReadable(dataBuffer);
      fnLog.debug('Computed data root...', { dataRoot: dataRootB64Url });

      parentPort?.postMessage({
        eventName: DATA_ROOT_SUCCESS,
        computedDataRoot: dataRootB64Url,
      });
    } catch (error: any) {
      fnLog.error('Error computing data root', {
        message: error?.message,
        stack: error?.stack,
      });
      parentPort?.postMessage({ eventName: DATA_ROOT_FAILURE });
    } finally {
      try {
        await fsPromises.unlink(dataPath);
      } catch (error: any) {
        fnLog.error('Error deleting temporary file', {
          message: error?.message,
          stack: error?.stack,
        });
      }
    }
  });
}
