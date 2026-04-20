/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import * as winston from 'winston';
import sql from 'sql-bricks';
import { ClickHouseClient, createClient } from '@clickhouse/client';
import { ValidationError } from 'apollo-server-express';

import {
  b64UrlToHex,
  b64UrlToUtf8,
  fromB64Url,
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
  private sqliteMinHeightEnabled: boolean;
  private sqliteMinHeightBuffer: number;
  private maxHeightCacheTtlMs: number;
  private maxHeightCache: { value: number; fetchedAt: number } | null = null;
  private maxHeightInFlight: Promise<number | null> | null = null;

  constructor({
    log,
    gqlQueryable,
    url,
    username,
    password,
    sqliteMinHeightEnabled = false,
    sqliteMinHeightBuffer = 10,
    maxHeightCacheTtlSeconds = 60,
  }: {
    log: winston.Logger;
    gqlQueryable: GqlQueryable;
    url: string;
    username?: string;
    password?: string;
    sqliteMinHeightEnabled?: boolean;
    sqliteMinHeightBuffer?: number;
    maxHeightCacheTtlSeconds?: number;
  }) {
    this.log = log;

    this.clickhouseClient = createClient({
      url,
      username,
      password,
    });

    this.gqlQueryable = gqlQueryable;
    this.sqliteMinHeightEnabled = sqliteMinHeightEnabled;
    this.sqliteMinHeightBuffer = sqliteMinHeightBuffer;
    this.maxHeightCacheTtlMs = maxHeightCacheTtlSeconds * 1000;
  }

  private async getClickHouseMaxHeight(): Promise<number | null> {
    const now = Date.now();
    if (
      this.maxHeightCache !== null &&
      now - this.maxHeightCache.fetchedAt < this.maxHeightCacheTtlMs
    ) {
      return this.maxHeightCache.value;
    }

    if (this.maxHeightInFlight !== null) {
      return this.maxHeightInFlight;
    }

    this.maxHeightInFlight = (async () => {
      try {
        const row = await this.clickhouseClient.query({
          query: 'SELECT max(height) AS max_height FROM transactions',
        });
        const jsonRow = await row.json<{
          max_height: number | string | null;
        }>();
        const raw = jsonRow.data[0]?.max_height;
        const value = raw == null ? null : Number(raw);
        if (value === null || !Number.isFinite(value)) {
          return null;
        }
        this.maxHeightCache = { value, fetchedAt: Date.now() };
        return value;
      } catch (error: any) {
        this.log.warn(
          'Failed to read ClickHouse max height; skipping boundary optimization',
          {
            message: error?.message,
          },
        );
        return null;
      } finally {
        this.maxHeightInFlight = null;
      }
    })();

    return this.maxHeightInFlight;
  }

  getGqlTransactionsBaseSql() {
    return sql
      .select(
        'height AS height',
        'block_transaction_index',
        'hex(block_indep_hash) AS block_indep_hash',
        'block_timestamp',
        'hex(block_previous_block) AS block_previous_block',
        'is_data_item',
        'hex(id) AS id',
        'hex(anchor)',
        'hex(target) AS target',
        'toString(reward) AS reward',
        'toString(quantity) AS quantity',
        'toString(data_size) AS data_size',
        'content_type',
        'hex(owner_address) AS owner_address',
        'owner_size',
        'owner_offset',
        'hex(parent_id) AS parent_id',
        'tags_count',
        'tags',
        'indexed_at',
        'signature_size',
        'signature_offset',
        'signature_type',
      )
      .from('transactions AS t');
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
        const pairs = hexValues
          .map((hexValue) => `(unhex('${hexName}'), unhex('${hexValue}'))`)
          .join(', ');
        const valueList = hexValues
          .map((hexValue) => `unhex('${hexValue}')`)
          .join(', ');
        query.where(sql(`hasAny(t.tags, [${pairs}])`));
        query.where(sql(`has(t.tag_names, unhex('${hexName}'))`));
        query.where(sql(`hasAny(t.tag_values, [${valueList}])`));
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
    if (ids?.length === 0) {
      if (sortOrder === 'HEIGHT_DESC') {
        if (cursorHeight != null) {
          const cursorIdHex = b64UrlToHex(cursorId ?? '');
          const cursorIsDataItemInt = cursorIsDataItem ? 1 : 0;
          // Standalone height predicate enables partition pruning on
          // intDiv(height, 100000); the tuple comparison alone is not
          // decomposed by the ClickHouse partition pruner.
          query.where(
            sql.lte('t.height', cursorHeight),
            sql(
              `(t.height, t.block_transaction_index, t.is_data_item, t.id) < ` +
                `(${cursorHeight}, ${cursorBlockTransactionIndex}, ${cursorIsDataItemInt}, unhex('${cursorIdHex}'))`,
            ),
          );
        }

        orderBy = '';
        if (recipients?.length === 1) {
          orderBy += 't.target DESC, ';
        } else if (owners?.length === 1) {
          orderBy += 't.owner_address DESC, ';
        }
        orderBy += 't.height DESC, ';
        orderBy += 't.block_transaction_index DESC, ';
        orderBy += 't.is_data_item DESC, ';
        orderBy += 't.id DESC';
      } else {
        if (cursorHeight != null) {
          const cursorIdHex = b64UrlToHex(cursorId ?? '');
          const cursorIsDataItemInt = cursorIsDataItem ? 1 : 0;
          // Standalone height predicate enables partition pruning on
          // intDiv(height, 100000); the tuple comparison alone is not
          // decomposed by the ClickHouse partition pruner.
          query.where(
            sql.gte('t.height', cursorHeight),
            sql(
              `(t.height, t.block_transaction_index, t.is_data_item, t.id) > ` +
                `(${cursorHeight}, ${cursorBlockTransactionIndex}, ${cursorIsDataItemInt}, unhex('${cursorIdHex}'))`,
            ),
          );
        }

        orderBy = '';
        if (recipients?.length === 1) {
          orderBy += 't.target ASC, ';
        } else if (owners?.length === 1) {
          orderBy += 't.owner_address ASC, ';
        }
        orderBy += 't.height ASC, ';
        orderBy += 't.block_transaction_index ASC, ';
        orderBy += 't.is_data_item ASC, ';
        orderBy += 't.id ASC';
      }
      query.orderBy(orderBy);
    }
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
    // Replaces FINAL: dedupes unmerged ReplacingMergeTree versions by PK.
    // FINAL would disable owner_projection selection and force a
    // PrimaryKeyExpand over skip-index results; LIMIT BY is a post-sort
    // filter that leaves projection planning intact.
    const dedupByPk =
      'LIMIT 1 BY t.height, t.block_transaction_index, t.is_data_item, t.id';
    const sql = `${txsSql} ${dedupByPk} LIMIT ${pageSize + 1}`;

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
      signatureSize: tx.signature_size as string,
      signatureOffset: tx.signature_offset as string,
      signatureType: (tx.signature_type as number) ?? null,
      recipient: tx.target ? hexToB64Url(tx.target) : null,
      ownerAddress: hexToB64Url(tx.owner_address),
      ownerKey: null,
      ownerSize: tx.owner_size as string,
      ownerOffset: tx.owner_offset as string,
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
      blockTimestamp: tx.block_timestamp
        ? (tx.block_timestamp as number)
        : null,
      blockPreviousBlock: tx.block_previous_block
        ? hexToB64Url(tx.block_previous_block)
        : null,
      parentId: tx.parent_id ? hexToB64Url(tx.parent_id) : null,
    }));

    let sqliteMinHeight = minHeight;
    let skipSqlite = false;
    if (this.sqliteMinHeightEnabled) {
      const clickhouseMaxHeight = await this.getClickHouseMaxHeight();
      if (clickhouseMaxHeight !== null) {
        const boundary = clickhouseMaxHeight - this.sqliteMinHeightBuffer;
        const candidate = boundary + 1;
        if (candidate > sqliteMinHeight) {
          sqliteMinHeight = candidate;
        }
        if (maxHeight >= 0 && sqliteMinHeight > maxHeight) {
          skipSqlite = true;
        }
      }
    }

    const gqlQueryableResults = skipSqlite
      ? { pageInfo: { hasNextPage: false }, edges: [] }
      : await this.gqlQueryable.getGqlTransactions({
          pageSize,
          cursor,
          sortOrder,
          ids,
          recipients,
          owners,
          minHeight: sqliteMinHeight,
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

      // Compare transaction IDs as binary data to match ClickHouse sorting
      const bufA = fromB64Url(txA.id);
      const bufB = fromB64Url(txB.id);
      return bufA.compare(bufB) * sortOrderModifier;
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
