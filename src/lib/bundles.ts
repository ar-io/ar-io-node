import * as winston from 'winston';
import stream from 'stream';
import { default as processBundle } from 'arbundles/stream/index.js';
import { fromB64Url, sha256B64Url } from './utils.js';
import { IBundleDatabase, DataItem, Tags } from '../types.js';

const DEFAULT_BATCH_SIZE = 10;

/* eslint-disable */
// @ts-ignore
export async function importAns102Bundle({
  log,
  db,
  bundleStream,
  parentTxId,
  batchSize = DEFAULT_BATCH_SIZE
}: {
  log: winston.Logger;
  db: IBundleDatabase;
  bundleStream: stream.Readable;
  parentTxId: string;
  batchSize?: number;
}) {}

export async function importAns104Bundle({
  log,
  db,
  bundleStream,
  parentTxId,
  batchSize = DEFAULT_BATCH_SIZE
}: {
  log: winston.Logger;
  db: IBundleDatabase;
  bundleStream: stream.Readable;
  parentTxId: string;
  batchSize?: number;
}) {
  const iterable = await processBundle(bundleStream)
  const bundleLength = iterable.length;

  // TODO: create child logger
  log.info(`processing ${parentTxId} bundle of size ${bundleLength}`)

  // Gather list of all data items in proper format
  const processedDataItems: DataItem[] = [];
  const currentBatch: DataItem[] = [];
  for await (const [index, dataItem] of iterable.entries()) {
    log.info(`unpacking ${index} of ${bundleLength} data items`);
    
    if (!dataItem.id) {
      log.info(`data-item is missing id, skipping...`);
      continue;
    }

    if (processedDataItems.includes(dataItem.id)) {
      log.info(`duplicate data-item id '${dataItem.id}', skipping...`);
      continue;
    }

    // data-items don't have tags b64 encoded
    const b64EncodedTags: Tags = (dataItem.tags || []).map((tag: { name: string; value: string }) => ({
        name: fromB64Url(tag.name),
        value: fromB64Url(tag.value),
    }));

    const newDataItem: DataItem = {
      parentTxId: fromB64Url(parentTxId),
      id: fromB64Url(dataItem.id),
      signature: fromB64Url(dataItem.signature),
      owner: fromB64Url(dataItem.owner),
      owner_address: fromB64Url(sha256B64Url(fromB64Url(dataItem.owner))),
      target: fromB64Url(dataItem.target || ''),
      anchor: fromB64Url(dataItem.anchor),
      tags: b64EncodedTags,
      data_size: dataItem.dataSize ?? fromB64Url(dataItem.data).byteLength
    }

    log.info(`succesfully unpacked data item, adding to batch`);
    currentBatch.push(newDataItem);

    // process batch when it's ready, or we're at the end
    if (currentBatch.length >= batchSize || index + 1 == bundleLength){
      processedDataItems.concat(currentBatch);
      await db.saveDataItems(currentBatch);
      currentBatch.length = 0;
    }
  }
}
