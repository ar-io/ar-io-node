import * as winston from 'winston';
import stream from 'stream';

import { IBundleDatabase } from '../types.js';

export async function importAns102Bundle({
  log,
  db,
  bundleStream,
  parentTxId
}: {
  log: winston.Logger;
  db: IBundleDatabase;
  bundleStream: stream.Readable;
  parentTxId: string;
}) {}

export async function importAns104Bundle({
  log,
  db,
  bundleStream,
  parentTxId
}: {
  log: winston.Logger;
  db: IBundleDatabase;
  bundleStream: stream.Readable;
  parentTxId: string;
}) {}
