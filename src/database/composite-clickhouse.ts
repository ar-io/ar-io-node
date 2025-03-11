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
import { GqlTransactionsResult, GqlQueryable } from '../types.js';

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

export function decodeTransactionGqlCursor(cursor: string | undefined) {
  try {
    if (cursor === undefined) {
      return {
        height: null,
        blockTransactionIndex: null,
        isDataItem: null,
        id: null,
        indexedAt: null,
      };
    }

    const [height, blockTransactionIndex, isDataItem, id, indexedAt] =
      JSON.parse(b64UrlToUtf8(cursor)) as [
        number | null,
        number | null,
        boolean | null,
        string | null,
        number | null,
      ];

    return { height, blockTransactionIndex, isDataItem, id, indexedAt };
  } catch (error) {
    throw new ValidationError('Invalid transaction cursor');
  }
}

export function encodeBlockGqlCursor({ height }: { height: number }) {
  return utf8ToB64Url(JSON.stringify([height]));
}

export function decodeBlockGqlCursor(cursor: string | undefined) {
  try {
    if (cursor === undefined) {
      return { height: null };
    }

    const [height] = JSON.parse(b64UrlToUtf8(cursor)) as [number];

    return { height };
  } catch (error) {
    throw new ValidationError('Invalid block cursor');
  }
}

// We do not have a good way to pass raw binary data to ClickHouse so we
// workaround that by converting to/from hex.
function inB64UrlStrings(xs: string[]) {
  return sql(xs.map((x) => `unhex('${b64UrlToHex(x)}')`).join(', '));
}

export class CompositeClickHouseDatabase implements GqlQueryable {
  private log: winston.Logger;
  private clickhouseClient: ClickHouseClient;
  private gqlQueryable: GqlQueryable;

  constructor({
    log,
    gqlQueryable,
    url,
  }: {
    log: winston.Logger;
    gqlQueryable: GqlQueryable;
    url: string;
  }) {
    this.log = log;

    this.clickhouseClient = createClient({
      url,
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

    if (tags.length > 0) {
      tags.forEach((tag) => {
        const hexName = Buffer.from(tag.name).toString('hex');
        const hexValues = tag.values.map((value) =>
          Buffer.from(value).toString('hex'),
        );
        const wheres = hexValues.map((hexValue) =>
          sql(`has(t.tags, (unhex('${hexName}'), unhex('${hexValue}')))`),
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

    const {
      height: cursorHeight,
      blockTransactionIndex: cursorBlockTransactionIndex,
      isDataItem: cursorIsDataItem,
      id: cursorId,
    } = decodeTransactionGqlCursor(cursor);

    let orderBy = '';
    if (sortOrder === 'HEIGHT_DESC') {
      if (cursorHeight != null) {
        query.where(
          sql.lte('t.height', cursorHeight),
          sql.or(
            sql.lt('t.height', cursorHeight),
            sql.and(
              sql.eq('t.height', cursorHeight),
              sql.lt('t.block_transaction_index', cursorBlockTransactionIndex),
            ),
            sql.and(
              sql.eq('t.height', cursorHeight),
              sql.eq('t.block_transaction_index', cursorBlockTransactionIndex),
              sql.lt('t.is_data_item', cursorIsDataItem),
            ),
            sql.and(
              sql.eq('t.height', cursorHeight),
              sql.eq('t.block_transaction_index', cursorBlockTransactionIndex),
              sql.eq('t.is_data_item', cursorIsDataItem),
              sql.lt(
                't.id',
                sql(`unhex('${sql(b64UrlToHex(cursorId ?? ''))}')`),
              ),
            ),
          ),
        );
      }

      orderBy = 't.height DESC, ';
      orderBy += 't.block_transaction_index DESC, ';
      orderBy += 't.is_data_item DESC, ';
      orderBy += 't.id DESC';
    } else {
      if (cursorHeight != null) {
        query.where(
          sql.gte('t.height', cursorHeight),
          sql.or(
            sql.gt('t.height', cursorHeight),
            sql.and(
              sql.eq('t.height', cursorHeight),
              sql.gt('t.block_transaction_index', cursorBlockTransactionIndex),
            ),
            sql.and(
              sql.eq('t.height', cursorHeight),
              sql.eq('t.block_transaction_index', cursorBlockTransactionIndex),
              sql.gt('t.is_data_item', cursorIsDataItem),
            ),
            sql.and(
              sql.eq('t.height', cursorHeight),
              sql.eq('t.block_transaction_index', cursorBlockTransactionIndex),
              sql.eq('t.is_data_item', cursorIsDataItem),
              sql.gt(
                't.id',
                sql(`unhex('${sql(b64UrlToHex(cursorId ?? ''))}')`),
              ),
            ),
          ),
        );
      }

      orderBy = 't.height ASC, ';
      orderBy += 't.block_transaction_index ASC, ';
      orderBy += 't.is_data_item ASC, ';
      orderBy += 't.id ASC';
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

    const gqlQueryableResults = await this.gqlQueryable.getGqlTransactions({
      pageSize,
      cursor,
      sortOrder,
      ids,
      recipients,
      owners,
      minHeight,
      maxHeight,
      tags,
    });

    // Filter out edges that already exist in the ClickHouse results
    const gqlQueryableEdges = gqlQueryableResults.edges.filter(
      (edge) => !txs.some((tx) => tx.id === edge.node.id),
    );

    // Combine the ClickHouse results with the gqlQueryable results
    const edges = [
      ...txs.map((tx) => ({
        cursor: encodeTransactionGqlCursor(tx),
        node: tx,
      })),
      ...gqlQueryableEdges,
    ];

    // Sort the combined results by height, blockTransactionIndex, isDataItem, and id
    edges.sort((a, b) => {
      const sortOrderModifier = sortOrder === 'HEIGHT_DESC' ? -1 : 1;

      const txA = a.node;
      const txB = b.node;

      const heightA = txA.height ?? Number.MAX_SAFE_INTEGER;
      const heightB = txB.height ?? Number.MAX_SAFE_INTEGER;
      if (heightA !== heightB) {
        return (heightA - heightB) * sortOrderModifier;
      }

      if (txA.blockTransactionIndex !== txB.blockTransactionIndex) {
        return (
          (txA.blockTransactionIndex - txB.blockTransactionIndex) *
          sortOrderModifier
        );
      }

      if (txA.isDataItem !== txB.isDataItem) {
        return (txA.isDataItem ? 1 : -1) * sortOrderModifier;
      }

      return txA.id.localeCompare(txB.id) * sortOrderModifier;
    });

    return {
      pageInfo: {
        hasNextPage: edges.length > pageSize,
      },
      edges: edges.slice(0, pageSize),
    };
  }

  async getGqlTransaction({ id }: { id: string }) {
    const results = await this.getGqlTransactions({
      pageSize: 1,
      ids: [id],
    });
    if (!Array.isArray(results.edges) || results.edges.length === 0) {
      return null;
    } else {
      return results.edges[0]?.node ?? null;
    }
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
