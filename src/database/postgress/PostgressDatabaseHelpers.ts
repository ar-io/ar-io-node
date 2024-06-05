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
import { b64UrlToUtf8, fromB64Url, utf8ToB64Url } from '../../lib/encoding.js';
import { ValidationError } from 'apollo-server-express';
import crypto from 'node:crypto';
import { NormalizedDataItem, PartialJsonTransaction } from '../../types';
import { currentUnixTimestamp } from '../../lib/time.js';

const LOW_SELECTIVITY_TAG_NAMES = new Set(['App-Name', 'Content-Type']);

export function txToDbRows(tx: PartialJsonTransaction, height?: number) {
  const tagNames = [] as { name: Buffer; hash: Buffer }[];
  const tagValues = [] as { value: Buffer; hash: Buffer }[];
  const newTxTags = [] as {
    tag_name_hash: Buffer;
    tag_value_hash: Buffer;
    transaction_id: Buffer;
    transaction_tag_index: number;
    indexed_at: number;
  }[];
  const wallets = [] as { address: Buffer; public_modulus: Buffer }[];

  let contentType: string | undefined;
  const txId = fromB64Url(tx.id);

  let transactionTagIndex = 0;
  for (const tag of tx.tags) {
    const tagName = fromB64Url(tag.name);
    const tagNameHash = hashTagPart(tagName);
    tagNames.push({ name: tagName, hash: tagNameHash });

    const tagValue = fromB64Url(tag.value);
    const tagValueHash = hashTagPart(tagValue);
    tagValues.push({ value: tagValue, hash: tagValueHash });

    if (isContentTypeTag(tagName)) {
      contentType = tagValue.toString('utf8');
    }

    newTxTags.push({
      tag_name_hash: tagNameHash,
      tag_value_hash: tagValueHash,
      transaction_id: txId,
      transaction_tag_index: transactionTagIndex,
      indexed_at: currentUnixTimestamp(),
    });

    transactionTagIndex++;
  }

  const ownerBuffer = fromB64Url(tx.owner);
  const ownerAddressBuffer = ownerToAddress(ownerBuffer);

  wallets.push({ address: ownerAddressBuffer, public_modulus: ownerBuffer });

  return {
    tagNames,
    tagValues,
    newTxTags,
    wallets,
    newTx: {
      id: txId,
      signature: fromB64Url(tx.signature),
      format: tx.format,
      last_tx: fromB64Url(tx.last_tx),
      owner_address: ownerAddressBuffer,
      target: fromB64Url(tx.target),
      quantity: tx.quantity,
      reward: tx.reward,
      data_size: tx.data_size,
      data_root: fromB64Url(tx.data_root),
      content_type: contentType,
      tag_count: tx.tags.length,
      indexed_at: currentUnixTimestamp(),
      height: height,
    },
  };
}

export function tagJoinSortPriority(tag: { name: string; values: string[] }) {
  return LOW_SELECTIVITY_TAG_NAMES.has(tag.name) ? 1 : 0;
}

export function encodeTransactionGqlCursor({
  height,
  blockTransactionIndex,
  dataItemId,
  indexedAt,
  id,
}: {
  height: number | null;
  blockTransactionIndex: number | null;
  dataItemId: string | null;
  indexedAt: number | null;
  id: string | null;
}) {
  return utf8ToB64Url(
    JSON.stringify([height, blockTransactionIndex, dataItemId, indexedAt, id]),
  );
}

export function decodeTransactionGqlCursor(cursor: string | undefined) {
  try {
    if (cursor === undefined) {
      return {
        height: null,
        blockTransactionIndex: null,
        dataItemId: null,
        indexedAt: null,
        id: null,
      };
    }

    const [height, blockTransactionIndex, dataItemId, indexedAt, id] =
      JSON.parse(b64UrlToUtf8(cursor)) as [
        number | null,
        number | null,
        string | null,
        number | null,
        string | null,
      ];

    return { height, blockTransactionIndex, dataItemId, indexedAt, id };
  } catch (error) {
    throw new ValidationError('Invalid transaction cursor');
  }
}

export function encodeBlockGqlCursor({ height }: { height: number }) {
  return utf8ToB64Url(JSON.stringify([height]));
}

export function decodeBlockGqlCursor(cursor: string | undefined) {
  try {
    if (cursor !== undefined) {
      return { height: null };
    }

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    //@ts-ignore
    // todo uitzoeken hier ik dit moet doen
    const [height] = JSON.parse(b64UrlToUtf8(cursor)) as [number];

    return { height };
  } catch (error) {
    throw new ValidationError('Invalid block cursor');
  }
}

export function toSqliteParams(sqlBricksParams: { values: any[] }) {
  return sqlBricksParams.values
    .map((v, i) => [i + 1, v])
    .reduce(
      (acc, [i, v]) => {
        acc[i] = v;
        return acc;
      },
      {} as { [key: string]: any },
    );
}

function hashTagPart(value: Buffer) {
  return crypto.createHash('sha1').update(value).digest();
}

function isContentTypeTag(tagName: Buffer) {
  return tagName.toString('utf8').toLowerCase() === 'content-type';
}

function ownerToAddress(owner: Buffer) {
  return crypto.createHash('sha256').update(owner).digest();
}

export function dataItemToDbRows(item: NormalizedDataItem, height?: number) {
  const tagNames = [] as { name: Buffer; hash: Buffer }[];
  const tagValues = [] as { value: Buffer; hash: Buffer }[];
  const newDataItemTags = [] as {
    tag_name_hash: Buffer;
    tag_value_hash: Buffer;
    root_transaction_id: Buffer;
    data_item_id: Buffer;
    data_item_tag_index: number;
    indexed_at: number;
  }[];
  const wallets = [] as { address: Buffer; public_modulus: Buffer }[];

  let contentType: string | undefined;
  const id = fromB64Url(item.id);

  let dataItemTagIndex = 0;
  for (const tag of item.tags) {
    const tagName = fromB64Url(tag.name);
    const tagNameHash = hashTagPart(tagName);
    tagNames.push({ name: tagName, hash: tagNameHash });

    const tagValue = fromB64Url(tag.value);
    const tagValueHash = hashTagPart(tagValue);
    tagValues.push({ value: tagValue, hash: tagValueHash });

    if (isContentTypeTag(tagName)) {
      contentType = tagValue.toString('utf8');
    }

    newDataItemTags.push({
      tag_name_hash: tagNameHash,
      tag_value_hash: tagValueHash,
      root_transaction_id: fromB64Url(item.root_tx_id),
      data_item_id: id,
      data_item_tag_index: dataItemTagIndex,
      indexed_at: currentUnixTimestamp(),
    });

    dataItemTagIndex++;
  }

  const ownerBuffer = fromB64Url(item.owner);
  const ownerAddressBuffer = fromB64Url(item.owner_address);

  wallets.push({ address: ownerAddressBuffer, public_modulus: ownerBuffer });

  const parentId = fromB64Url(item.parent_id);
  const rootTxId = fromB64Url(item.root_tx_id);

  return {
    tagNames,
    tagValues,
    newDataItemTags,
    wallets,
    bundleDataItem: {
      id,
      parent_id: parentId,
      parent_index: item.parent_index,
      root_transaction_id: rootTxId,
      indexed_at: currentUnixTimestamp(),
      filter: item.filter,
    },
    newDataItem: {
      id,
      parent_id: parentId,
      root_transaction_id: rootTxId,
      height: height,
      signature: fromB64Url(item.signature),
      anchor: fromB64Url(item.anchor),
      owner_address: ownerAddressBuffer,
      target: fromB64Url(item.target),
      data_offset: item.data_offset,
      data_size: item.data_size,
      content_type: contentType,
      tag_count: item.tags.length,
      indexed_at: currentUnixTimestamp(),
    },
  };
}
