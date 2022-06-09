import * as winston from 'winston';
import stream from 'stream';
import processBundle from "arbundles/stream/index.js";
import { IBundleDatabase } from '../types.js';

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
  const alreadyProcessed = new Set();
  const txBatch = [];
  const tagsBatch = [];

  const iterable = await processBundle.default(bundleStream)
  const bundleLength = iterable.length;

  log.info(`[ans-104-bundle] processing ${parentTxId} bundle of size ${bundleLength}`)

  // Save individual data items to database

  // Traverse tags of data items

  // Update data items to S3

  // Store tagsBatch in array (where is this used?) 

}
