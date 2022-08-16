import arbundles from 'arbundles/stream/index.js';
import stream from 'stream';
import * as winston from 'winston';

import { BundleDatabase, DataItem, Tags } from '../types.js';
import { fromB64Url, sha256B64Url } from './encoding.js';

/* eslint-disable */
// @ts-ignore
const { default: processStream } = arbundles;

const DEFAULT_BATCH_SIZE = 10;

/* eslint-disable */
// @ts-ignore
export async function importAns102Bundle({
  log,
  db,
  bundleStream,
  parentTxId,
  batchSize = DEFAULT_BATCH_SIZE,
}: {
  log: winston.Logger;
  db: BundleDatabase;
  bundleStream: stream.Readable;
  parentTxId: string;
  batchSize?: number;
}): Promise<void> {}

export async function importAns104Bundle({
  log,
  db,
  bundleStream,
  parentTxId,
  batchSize = DEFAULT_BATCH_SIZE,
}: {
  log: winston.Logger;
  db: BundleDatabase;
  bundleStream: stream.Readable;
  parentTxId: string;
  batchSize?: number;
}): Promise<void> {
  const iterable = await processStream(bundleStream);
  const bundleLength = iterable.length;

  // TODO: create child logger
  log.info(`processing ${parentTxId} bundle tx of size ${bundleLength}`);

  const currentBatch: DataItem[] = [];
  const processedDataItems = new Set<string>();
  let nextBatchPromise: Promise<void> | undefined;
  for await (const [index, dataItem] of iterable.entries()) {
    log.info(`unpacking ${index + 1} of ${bundleLength} data items`);

    if (!dataItem.id) {
      // TODO counter metric data items with missing ids
      log.info(`data-item is missing id, skipping...`);
      continue;
    }

    if (processedDataItems.has(dataItem.id)) {
      // TODO counter metric for skipped data items
      log.info(`duplicate data-item id '${dataItem.id}', skipping...`);
      continue;
    }

    // data-items don't have tags b64 encoded
    const tags: Tags = (dataItem.tags || []).map(
      (tag: { name: string; value: string }) => ({
        name: fromB64Url(tag.name),
        value: fromB64Url(tag.value),
      }),
    );

    const newDataItem: DataItem = {
      parentTxId: fromB64Url(parentTxId),
      id: fromB64Url(dataItem.id),
      signature: fromB64Url(dataItem.signature),
      owner: fromB64Url(dataItem.owner),
      owner_address: fromB64Url(sha256B64Url(fromB64Url(dataItem.owner))),
      target: fromB64Url(dataItem.target || ''),
      anchor: fromB64Url(dataItem.anchor),
      tags,
      data_size: dataItem.dataSize ?? fromB64Url(dataItem.data).byteLength,
    };

    log.info(`succesfully unpacked data item ${dataItem.id}, adding to batch`);
    currentBatch.push(newDataItem);
    processedDataItems.add(dataItem.id);

    // wait for previous batch save to complete
    if (nextBatchPromise) {
      await nextBatchPromise;
      nextBatchPromise = undefined;
    }

    // create promise for batch when it's ready, or we're at the end
    if (currentBatch.length >= batchSize || index + 1 === bundleLength) {
      nextBatchPromise = db.saveDataItems(currentBatch);
      currentBatch.length = 0;
    }
  }

  await nextBatchPromise;
}
