import * as winston from 'winston';
import stream from 'stream';
import processBundle from "arbundles/stream/index.js";
import base64url from "base64url";
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
  const iterable = await processBundle.default(bundleStream)
  const bundleLength = iterable.length;

  log.info(`[ans-104-bundle] processing ${parentTxId} bundle of size ${bundleLength}`)

  const batches: Array<Set<DataItem>> = [];
  const currentBatch = new Set<DataItem>();
  iterable.forEach((dataItem, index) => {
    log.info(`[data-item] ${index + 1}/${bundleLength} in ${tx.id}`);

    if (!dataItem.id) {
      log.info(`[data-item] missing id, skipping...`);
      return;
    }

    const existingDataItem = batches.find(b => b.has(dataItem.id));
    if (existingDataItem) {
      log.info(`[data-item] ans104 found duplicate data-item id: ${dataItem.id}`);
      return;
    }

    // data-items don't have tags b64 encoded
    const b64EncodedTags: Tags = (dataItem.tags || []).map((tag: Tag) => ({
      name: base64url.default(tag.name),
      value: base64url.default(tag.value),
    }));

    const newDataItem: DataItem = {
      parentTxId: Buffer.from(parentTxId),
      id: Buffer.from(dataItem.id),
      signature: Buffer.from(dataItem.signature),
      owner: dataItem.owner,
      owner_address: Buffer.from(sha256B64Url(fromB64Url(dataItem.owner))),
      target: Buffer.from(dataItem.target || ""),
      anchor: Buffer.from('TODO'),
      tags: b64EncodedTags,
      data_size: dataItem.dataSize ?? fromB64Url(dataItem.data).byteLength
    }

    if (currentBatch.size < batchSize){
      currentBatch.add(newDataItem);
    } else {
      // start a new batch
      batches.push(currentBatch);
      currentBatch.clear();
    }
  })

  // Save batches to database
  await Promise.all(
    batches.map(async (dataItems) => {
      db.saveDataItems([...dataItems]);
      // todo: save tags?
    })
  )
}
