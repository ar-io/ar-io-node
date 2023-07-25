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
import { default as wait } from 'wait';
import * as winston from 'winston';

import * as events from '../events.js';
import { createFilter } from '../filters.js';
import log from '../log.js';
import { ContiguousDataSource, NormalizedDataItem } from '../types.js';
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
  // TODO stricter type checking (maybe zod)

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
  private worker: Worker;
  private contiguousDataSource: ContiguousDataSource;
  private unbundlePromise: Promise<void> | undefined;
  private unbundlePromiseResolve: (() => void) | undefined;
  private unbundlePromiseReject: ((reason?: any) => void) | undefined;

  constructor({
    log,
    eventEmitter,
    contiguousDataSource,
    dataItemIndexFilterString,
  }: {
    log: winston.Logger;
    eventEmitter: EventEmitter;
    contiguousDataSource: ContiguousDataSource;
    dataItemIndexFilterString: string;
  }) {
    this.log = log.child({ class: 'Ans104Parser' });
    this.contiguousDataSource = contiguousDataSource;

    const workerUrl = new URL('./ans-104.js', import.meta.url);
    this.worker = new Worker(workerUrl, {
      workerData: {
        dataItemIndexFilterString,
      },
    });

    const self = this;
    this.worker
      .on(
        'message',
        ((message: ParserMessage) => {
          switch (message.eventName) {
            case DATA_ITEM_MATCHED:
              eventEmitter.emit(
                events.ANS104_DATA_ITEM_MATCHED,
                message.dataItem,
              );
              break;
            case UNBUNDLE_COMPLETE:
              self.unbundlePromiseResolve?.();
              self.resetUnbundlePromise();
              const { eventName, ...eventBody } = message;
              eventEmitter.emit(events.ANS104_UNBUNDLE_COMPLETE, {
                dataItemIndexFilterString,
                ...eventBody,
              });
              break;
            case UNBUNDLE_ERROR:
              self.unbundlePromiseReject?.();
              self.resetUnbundlePromise();
              break;
          }
        }).bind(this),
      )
      .on('error', (error: any) => {
        self.unbundlePromiseReject?.();
        self.resetUnbundlePromise();
        self.log.error('Error in ANS-104 worker:', error);
      })
      .on('exit', (code: number) => {
        self.unbundlePromiseReject?.();
        self.resetUnbundlePromise();
        self.log.error(`ANS-104 worker exited with code ${code}.`);
      });
  }

  resetUnbundlePromise() {
    this.unbundlePromise = undefined;
    this.unbundlePromiseResolve = undefined;
    this.unbundlePromiseReject = undefined;
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
    const unbundlePromise: Promise<void> = new Promise(
      async (resolve, reject) => {
        try {
          this.unbundlePromiseResolve = resolve;
          this.unbundlePromiseReject = reject;

          const log = this.log.child({ parentId });
          log.debug('Waiting for previous bundle to finish...');
          while (this.unbundlePromise) {
            await wait(100);
          }
          log.debug('Previous bundle finished.');

          await fsPromises.mkdir(path.join(process.cwd(), 'data/tmp/ans-104'), {
            recursive: true,
          });
          const data = await this.contiguousDataSource.getData(parentId);
          const bundlePath = path.join(
            process.cwd(),
            'data/tmp/ans-104',
            `${parentId}`,
          );
          const writeStream = fs.createWriteStream(bundlePath);
          pipeline(
            data.stream,
            writeStream,
            (error) => {
              if (error !== undefined) {
                this.unbundlePromiseReject?.(error);
                this.resetUnbundlePromise();
                log.error('Error writing ANS-104 bundle stream', error);
              } else {
                log.info('Parsing ANS-104 bundle stream...');
                this.worker.postMessage({
                  rootTxId,
                  parentId,
                  parentIndex,
                  bundlePath,
                });
              }
            }
          );
        } catch (error) {
          reject(error);
        }
      },
    );
    this.unbundlePromise = unbundlePromise;
    return unbundlePromise;
  }
}

if (!isMainThread) {
  const filter = createFilter(JSON.parse(workerData.dataItemIndexFilterString));
  parentPort?.on('message', async (message: any) => {
    const { rootTxId, parentId, parentIndex, bundlePath } = message;
    try {
      const stream = fs.createReadStream(bundlePath);
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
        }
      }
      parentPort?.postMessage({
        eventName: UNBUNDLE_COMPLETE,
        parentId: parentId as string,
        itemCount: bundleLength,
        matchedItemCount,
      });
    } catch (error) {
      log.error('Error unbundling ANS-104 bundle stream', error);
      parentPort?.postMessage({ eventName: 'unbundle-error' });
    } finally {
      try {
        await fsPromises.unlink(bundlePath);
      } catch (error) {
        log.error('Error deleting ANS-104 temporary bundle file', error);
      }
    }
  });
}
