import arbundles from 'arbundles/stream/index.js';
import * as EventEmitter from 'node:events';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { default as wait } from 'wait';
import * as winston from 'winston';

import log from '../log.js';
import { ContiguousDataSource, NormalizedDataItem } from '../types.js';
import { fromB64Url, sha256B64Url, utf8ToB64Url } from './encoding.js';

/* eslint-disable */
// @ts-ignore
const { default: processStream } = arbundles;

export function normalizeAns104DataItem(
  parentTxId: string,
  ans104DataItem: Record<string, any>,
): NormalizedDataItem {
  // TODO stricter type checking (maybe zod)

  const tags = (ans104DataItem.tags || []).map(
    (tag: { name: string; value: string }) => ({
      name: utf8ToB64Url(tag.name),
      value: utf8ToB64Url(tag.value),
    }),
  );

  return {
    parent_id: parentTxId,
    id: ans104DataItem.id,
    signature: ans104DataItem.signature,
    owner: ans104DataItem.owner,
    owner_address: sha256B64Url(fromB64Url(ans104DataItem.owner)),
    target: ans104DataItem.target,
    anchor: ans104DataItem.anchor,
    tags,
    data_offset: ans104DataItem.dataOffset,
    data_size: ans104DataItem.dataSize,
  } as NormalizedDataItem;
}

export class Ans104Parser {
  private log: winston.Logger;
  private worker: Worker;
  private contiguousDataSource: ContiguousDataSource;
  private unbundlePromise: Promise<void> | undefined;

  constructor({
    log,
    eventEmitter,
    contiguousDataSource,
  }: {
    log: winston.Logger;
    eventEmitter: EventEmitter;
    contiguousDataSource: ContiguousDataSource;
  }) {
    this.log = log.child({ class: 'Ans104Parser' });
    this.contiguousDataSource = contiguousDataSource;

    const workerUrl = new URL('./ans-104.js', import.meta.url);
    this.worker = new Worker(workerUrl);

    this.worker.on(
      'message',
      ((message: any) => {
        this.log.info('message', { message });
        switch (message.eventName) {
          case 'data-item-unbundled':
            eventEmitter.emit(message.eventName, message.dataItem);
            break;
          case 'unbundle-complete':
            this.unbundlePromise = undefined;
            break;
          case 'unbundle-error':
            this.unbundlePromise = undefined;
            break;
        }
      }).bind(this),
    );

    this.worker.on('error', (error: any) => {
      this.unbundlePromise = undefined;
      this.log.error('Error in ANS-104 worker', error);
    });
  }

  async parseBundle({ parentTxId }: { parentTxId: string }): Promise<void> {
    const unbundlePromise: Promise<void> = new Promise(async (resolve, reject) => {
      const log = this.log.child({ parentTxId });
      log.debug('Waiting for previous bundle to finish...');
      while (this.unbundlePromise) {
        await wait(100);
      }
      log.debug('Previous bundle finished.');
      await fsPromises.mkdir(path.join(process.cwd(), 'data/tmp/ans-104'), {
        recursive: true,
      });
      const data = await this.contiguousDataSource.getData(parentTxId);
      const bundlePath = path.join(
        process.cwd(),
        'data/tmp/ans-104',
        `${parentTxId}`,
      );
      const writeStream = fs.createWriteStream(bundlePath);
      // TODO consider using pipeline
      data.stream.pipe(writeStream);
      writeStream.on('error', (error) => {
        log.error('Error writing ANS-104 bundle stream', error);
        reject(error);
      });
      writeStream.on('finish', async () => {
        log.info('Parsing ANS-104 bundle stream...');
        this.worker.postMessage({ parentTxId, bundlePath });
        resolve();
      });
    });
    this.unbundlePromise = unbundlePromise;
    return unbundlePromise;
  }
}

if (!isMainThread) {
  parentPort?.on('message', async (message: any) => {
    const { parentTxId, bundlePath } = message;
    try {
      const stream = fs.createReadStream(bundlePath);
      const iterable = await processStream(stream);
      const bundleLength = iterable.length;

      const fnLog = log.child({ parentTxId, bundleLength });
      fnLog.info('Unbundling ANS-104 bundle stream data items...');

      const processedDataItemIds = new Set<string>();
      for await (const [index, dataItem] of iterable.entries()) {
        const diLog = fnLog.child({
          dataItemId: dataItem.id,
          dataItemIndex: index,
        });
        diLog.info('Processing data item...');

        if (!dataItem.id) {
          // TODO counter metric data items with missing ids
          diLog.warn('Skipping data item with missing ID.');
          continue;
        }

        if (processedDataItemIds.has(dataItem.id)) {
          // TODO counter metric for skipped data items
          diLog.warn('Skipping duplicate data item ID.');
          continue;
        }

        if (!dataItem.dataOffset) {
          // TODO counter metric for skipped data items
          diLog.warn('Skipping data item with missing data offset.');
        }

        parentPort?.postMessage({
          eventName: 'data-item-unbundled',
          dataItem: normalizeAns104DataItem(parentTxId, dataItem),
        });
      }
      parentPort?.postMessage({ eventName: 'unbundle-complete' });
    } catch (error) {
      log.error('Error unbundling ANS-104 bundle stream', error);
      parentPort?.postMessage({ eventName: 'unbundle-error' });
    } finally {
      await fsPromises.unlink(bundlePath);
    }
  });
}
