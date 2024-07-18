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
import * as winston from 'winston';
import sql from 'sql-bricks';
import { ClickHouseClient, createClient } from '@clickhouse/client';
import { ValidationError } from 'apollo-server-express';

import {
  b64UrlToHex,
  b64UrlToUtf8,
  hexToB64Url,
  utf8ToB64Url,
} from '../lib/encoding.js';
//import * as metrics from '../metrics.js';
import { GqlTransactionsResult, GqlQueryable } from '../types.js';

// TODO reconcile this cursor fromat with what's in StandaloneSqlite
export function encodeTransactionGqlCursor({
  height,
  blockTransactionIndex,
  isDataItem,
  id,
  indexedAt,
}: {
  height: number | null;
  blockTransactionIndex: number | null;
  isDataItem: boolean | null;
  id: string | null;
  indexedAt: number | null;
}) {
  return utf8ToB64Url(
    JSON.stringify([height, blockTransactionIndex, isDataItem, id, indexedAt]),
  );
}

// TODO reconcile this cursor format with what's in StandaloneSqlite
export function decodeTransactionGqlCursor(cursor: string | undefined) {
  try {
    if (!cursor) {
      return {
        height: null,
        blockTransactionIndex: null,
        isDataItem: null,
        id: null,
        indexedAt: null,
      };
    }

    const [height, blockTransactionIndex, id, indexedAt] = JSON.parse(
      b64UrlToUtf8(cursor),
    ) as [
      number | null,
      number | null,
      boolean | null,
      string | null,
      number | null,
    ];

    return { height, blockTransactionIndex, id, indexedAt };
  } catch (error) {
    throw new ValidationError('Invalid transaction cursor');
  }
}

export function encodeBlockGqlCursor({ height }: { height: number }) {
  return utf8ToB64Url(JSON.stringify([height]));
}

export function decodeBlockGqlCursor(cursor: string | undefined) {
  try {
    if (!cursor) {
      return { height: null };
    }

    const [height] = JSON.parse(b64UrlToUtf8(cursor)) as [number];

    return { height };
  } catch (error) {
    throw new ValidationError('Invalid block cursor');
  }
}

function inB64UrlStrings(xs: string[]) {
  return sql(xs.map((x) => `unhex('${b64UrlToHex(x)}')`).join(', '));
}

export class ClickHouseDatabase implements GqlQueryable {
  private log: winston.Logger;
  private clickhouseClient: ClickHouseClient;
  private gqlQueryable: GqlQueryable;

  constructor({
    log,
    gqlQueryable,
  }: {
    log: winston.Logger;
    gqlQueryable: GqlQueryable;
  }) {
    this.log = log;

    this.clickhouseClient = createClient({
      host: 'http://localhost:8123',
    });

    this.gqlQueryable = gqlQueryable;
  }

  getGqlTransactionsBaseSql() {
    return sql
      .select()
      .distinct(
        'height AS height',
        'block_transaction_index AS block_transaction_index',
        'is_data_item',
        'hex(id) AS id',
        'hex(anchor)',
        'hex(target) AS target',
        'toString(reward) AS reward',
        'toString(quantity) AS quantity',
        'toString(data_size) AS data_size',
        'content_type',
        'hex(owner_address) AS owner_address',
        'hex(parent_id) AS parent_id',
        'tags_count',
        'tags',
      )
      .from('transactions t');
  }

  addGqlTransactionFilters({
    query,
    cursor,
    sortOrder = 'HEIGHT_DESC',
    ids = [],
    recipients = [],
    owners = [],
    minHeight = -1,
    maxHeight = -1,
    bundledIn,
    tags = [],
  }: {
    query: sql.SelectStatement;
    cursor?: string;
    sortOrder?: 'HEIGHT_DESC' | 'HEIGHT_ASC';
    ids?: string[];
    recipients?: string[];
    owners?: string[];
    minHeight?: number;
    maxHeight?: number;
    bundledIn?: string[] | null;
    tags: { name: string; values: string[] }[];
  }) {
    const maxDbHeight = Infinity;

    if (ids?.length > 0) {
      query.where(sql.in('t.id', inB64UrlStrings(ids)));
    }

    if (recipients?.length > 0) {
      query.where(sql.in('t.target', inB64UrlStrings(recipients)));
    }

    if (owners?.length > 0) {
      query.where(sql.in('t.owner_address', inB64UrlStrings(owners)));
    }

    if (tags) {
      tags.forEach((tag) => {
        const hexName = Buffer.from(tag.name).toString('hex');
        const hexValues = tag.values.map((value) =>
          Buffer.from(value).toString('hex'),
        );
        const wheres = hexValues.map((hexValue) =>
          sql(`has(tags, (unhex('${hexName}'), unhex('${hexValue}')))`),
        );
        query.where(sql.or.apply(null, wheres));
      });
    }

    if (minHeight != null && minHeight > 0) {
      query.where(sql.gte('t.height', minHeight));
    }

    if (maxHeight != null && maxHeight >= 0 && maxHeight < maxDbHeight) {
      query.where(sql.lte('t.height', maxHeight));
    }

    if (Array.isArray(bundledIn)) {
      query.where(sql.in('t.parent_id', inB64UrlStrings(bundledIn)));
    }

    // TODO need to review, but cursor handling should be fairly similar
    //const {
    //  height: cursorHeight,
    //  blockTransactionIndex: cursorBlockTransactionIndex,
    //  dataItemId: cursorDataItemId,
    //  indexedAt: cursorIndexedAt,
    //  id: cursorId,
    //} = decodeTransactionGqlCursor(cursor);

    //if (sortOrder === 'HEIGHT_DESC') {
    //  if (
    //    ['new_txs', 'new_items'].includes(source) &&
    //    cursorHeight == null &&
    //    cursorIndexedAt != null
    //  ) {
    //    query.where(
    //      sql.or(
    //        sql.and(
    //          // indexed_at is only considered when the height is null
    //          sql.isNull(`${heightSortTableAlias}.height`),
    //          sql.or(
    //            // If the indexed_at is less than the cursor, the ID is not
    //            // considered
    //            sql.lt(`${txTableAlias}.indexed_at`, cursorIndexedAt),
    //            sql.and(
    //              // If the indexedAt is the same as the cursor, the ID is
    //              // compared
    //              sql.lte(`${txTableAlias}.indexed_at`, cursorIndexedAt),
    //              sql.lt(
    //                'id',
    //                cursorId ? fromB64Url(cursorId) : Buffer.from([0]),
    //              ),
    //            ),
    //          ),
    //        ),
    //        // Non-null heights are always after pending transactions and data
    //        // items when sorting in descending order
    //        sql.isNotNull(`${heightSortTableAlias}.height`),
    //      ),
    //    );
    //  } else if (cursorHeight != null && cursorBlockTransactionIndex != null) {
    //    let dataItemIdField = source === 'stable_items' ? 'sdi.id' : "x'00'";
    //    query.where(
    //      sql.lte(`${heightSortTableAlias}.height`, cursorHeight),
    //      sql.or(
    //        sql.lt(`${heightSortTableAlias}.height`, cursorHeight),
    //        sql.and(
    //          sql.eq(`${heightSortTableAlias}.height`, cursorHeight),
    //          sql.lt(
    //            `${blockTransactionIndexSortTableAlias}.block_transaction_index`,
    //            cursorBlockTransactionIndex,
    //          ),
    //        ),
    //        sql.and(
    //          sql.eq(`${heightSortTableAlias}.height`, cursorHeight),
    //          sql.eq(
    //            `${blockTransactionIndexSortTableAlias}.block_transaction_index`,
    //            cursorBlockTransactionIndex,
    //          ),
    //          sql.lt(
    //            dataItemIdField,
    //            cursorDataItemId
    //              ? fromB64Url(cursorDataItemId)
    //              : Buffer.from([0]),
    //          ),
    //        ),
    //      ),
    //    );
    //  }
    //  let orderBy = `${heightSortTableAlias}.height DESC NULLS FIRST`;
    //  orderBy += `, ${blockTransactionIndexSortTableAlias}.block_transaction_index DESC NULLS FIRST`;
    //  if (source === 'stable_items' && dataItemSortTableAlias !== undefined) {
    //    orderBy += `, ${dataItemSortTableAlias}.data_item_id DESC`;
    //  } else {
    //    orderBy += `, 3 DESC`;
    //  }
    //  orderBy += `, indexed_at DESC`;
    //  orderBy += `, 5 DESC`;
    //  query.orderBy(orderBy);
    //} else {
    //  if (
    //    ['new_txs', 'new_items'].includes(source) &&
    //    cursorHeight == null &&
    //    cursorIndexedAt != null
    //  ) {
    //    query.where(
    //      // indexed_at is only considered when the height is null
    //      sql.isNull(`${heightSortTableAlias}.height`),
    //      sql.or(
    //        // If the indexed_at is greater than the cursor, the ID is not
    //        // considered
    //        sql.gt(`${txTableAlias}.indexed_at`, cursorIndexedAt),
    //        sql.and(
    //          // If the indexed_at is the same as the cursor, the ID is
    //          // compared
    //          sql.gte(`${txTableAlias}.indexed_at`, cursorIndexedAt),
    //          sql.gt('id', cursorId ? fromB64Url(cursorId) : Buffer.from([0])),
    //        ),
    //      ),
    //    );
    //  } else if (
    //    cursorHeight != undefined &&
    //    cursorBlockTransactionIndex != undefined
    //  ) {
    //    let dataItemIdField = source === 'stable_items' ? 'sdi.id' : "x'00'";
    //    query.where(
    //      sql.gte(`${heightSortTableAlias}.height`, cursorHeight),
    //      sql.or(
    //        sql.gt(`${heightSortTableAlias}.height`, cursorHeight),
    //        sql.and(
    //          sql.eq(`${heightSortTableAlias}.height`, cursorHeight),
    //          sql.gt(
    //            `${blockTransactionIndexSortTableAlias}.block_transaction_index`,
    //            cursorBlockTransactionIndex,
    //          ),
    //        ),
    //        sql.and(
    //          sql.eq(`${heightSortTableAlias}.height`, cursorHeight),
    //          sql.eq(
    //            `${blockTransactionIndexSortTableAlias}.block_transaction_index`,
    //            cursorBlockTransactionIndex,
    //          ),
    //          sql.gt(
    //            dataItemIdField,
    //            cursorDataItemId
    //              ? fromB64Url(cursorDataItemId)
    //              : Buffer.from([0]),
    //          ),
    //        ),
    //      ),
    //    );
    //  }
    //  let orderBy = `${heightSortTableAlias}.height ASC NULLS LAST`;
    //  orderBy += `, ${blockTransactionIndexSortTableAlias}.block_transaction_index ASC NULLS LAST`;
    //  if (source === 'stable_items' && dataItemSortTableAlias !== undefined) {
    //    orderBy += `, ${dataItemSortTableAlias}.data_item_id ASC`;
    //  } else {
    //    orderBy += `, 3 ASC`;
    //  }
    //  orderBy += `, indexed_at ASC`;
    //  orderBy += `, 5 ASC`;
    //  query.orderBy(orderBy);
    //}

    let orderBy = '';
    if (sortOrder === 'HEIGHT_DESC') {
      orderBy = 'height DESC, ';
      orderBy += 'block_transaction_index DESC, ';
      orderBy += 'is_data_item DESC, ';
      orderBy += 'id DESC';
    } else {
      orderBy = 'height ASC, ';
      orderBy += 'block_transaction_index ASC, ';
      orderBy += 'is_data_item ASC, ';
      orderBy += 'id ASC';
    }
    query.orderBy(orderBy);
  }

  async getGqlTransactions({
    pageSize,
    cursor,
    sortOrder = 'HEIGHT_DESC',
    ids = [],
    recipients = [],
    owners = [],
    minHeight = -1,
    maxHeight = -1,
    bundledIn,
    tags = [],
  }: {
    pageSize: number;
    cursor?: string;
    sortOrder?: 'HEIGHT_DESC' | 'HEIGHT_ASC';
    ids?: string[];
    recipients?: string[];
    owners?: string[];
    minHeight?: number;
    maxHeight?: number;
    bundledIn?: string[] | null;
    tags?: { name: string; values: string[] }[];
  }): Promise<GqlTransactionsResult> {
    const txsQuery = this.getGqlTransactionsBaseSql();

    this.addGqlTransactionFilters({
      query: txsQuery,
      cursor,
      sortOrder,
      ids,
      recipients,
      owners,
      minHeight,
      maxHeight,
      bundledIn,
      tags,
    });

    const txsSql = txsQuery.toString();
    const sql = `${txsSql} LIMIT ${pageSize + 1}`;

    this.log.debug('Querying ClickHouse transactions...', { sql });

    const row = await this.clickhouseClient.query({ query: sql });
    const jsonRow = await row.json();
    const txs = jsonRow.data.map((tx: any) => ({
      height: tx.height as number,
      blockTransactionIndex: tx.block_transaction_index as number,
      isDataItem: tx.is_data_item as boolean,
      id: hexToB64Url(tx.id),
      dataItemId: tx.is_data_item ? hexToB64Url(tx.id) : null,
      indexedAt: tx.indexed_at as number,
      anchor: tx.anchor ? hexToB64Url(tx.anchor) : null,
      signature: null,
      recipient: tx.target ? hexToB64Url(tx.target) : null,
      ownerAddress: hexToB64Url(tx.owner_address),
      ownerKey: null,
      fee: tx.reward as string,
      quantity: tx.quantity as string,
      dataSize: tx.data_size as string,
      tags:
        tx.tags_count > 0
          ? tx.tags.map((tag: any) => ({
              name: tag[0] as string,
              value: tag[1] as string,
            }))
          : [],
      contentType: tx.content_type as string,
      blockIndepHash: tx.block_indep_hash
        ? hexToB64Url(tx.block_indep_hash)
        : null,
      blockTimestamp: tx.block_timestamp as number,
      blockPreviousBlock: tx.block_previous_block
        ? hexToB64Url(tx.block_previous_block)
        : null,
      parentId: tx.parent_id ? hexToB64Url(tx.parent_id) : null,
    }));

    return {
      pageInfo: {
        hasNextPage: txs.length > pageSize,
      },
      edges: txs.slice(0, pageSize).map((tx) => {
        return {
          cursor: encodeTransactionGqlCursor(tx),
          node: tx,
        };
      }),
    };
  }

  async getGqlTransaction({ id }: { id: string }) {
    return (
      await this.getGqlTransactions({
        pageSize: 1,
        ids: [id],
      })
    ).edges[0].node;
  }

  getGqlBlock(args: { id: string }) {
    return this.gqlQueryable.getGqlBlock(args);
  }

  getGqlBlocks(args: {
    pageSize: number;
    cursor?: string;
    sortOrder?: 'HEIGHT_DESC' | 'HEIGHT_ASC';
    ids?: string[];
    minHeight?: number;
    maxHeight?: number;
  }) {
    return this.gqlQueryable.getGqlBlocks(args);
  }
}
