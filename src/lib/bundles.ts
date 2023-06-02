/**
 * AR.IO Gateway
 * Copyright (C) 2022 Permanent Data Solutions, Inc
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
import stream from 'node:stream';
import * as winston from 'winston';

import * as events from '../../src/events.js';
import { NormalizedDataItem } from '../types.js';
import { fromB64Url, sha256B64Url, utf8ToB64Url } from './encoding.js';

/* eslint-disable */
// @ts-ignore
const { default: processStream } = arbundles;

/* eslint-disable */
// @ts-ignore
export async function emitAns102UnbundleEvents({
  log,
  eventEmitter,
  bundleStream,
  parentTxId,
}: {
  log: winston.Logger;
  eventEmitter: EventEmitter;
  bundleStream: stream.Readable;
  parentTxId: string;
}): Promise<void> {}

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

export async function emitAns104UnbundleEvents({
  log,
  eventEmitter,
  bundleStream,
  parentTxId,
}: {
  log: winston.Logger;
  eventEmitter: EventEmitter;
  bundleStream: stream.Readable;
  parentTxId: string;
}): Promise<void> {
  const iterable = await processStream(bundleStream);
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

    eventEmitter.emit(
      events.ANS104_DATA_ITEM_UNBUNDLED,
      normalizeAns104DataItem(parentTxId, dataItem),
    );
  }
}
