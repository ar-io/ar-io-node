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
import CircuitBreaker from 'opossum';

import * as config from '../config.js';
import {
  b64UrlToHex,
  b64UrlToUtf8,
  fromB64Url,
  hexToB64Url,
  utf8ToB64Url,
} from '../lib/encoding.js';
import * as metrics from '../metrics.js';
import { GqlTransactionsResult, GqlQueryable, GqlWarning } from '../types.js';

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

type SqliteGqlArgs = Parameters<GqlQueryable['getGqlTransactions']>[0];

export class CompositeClickHouseDatabase implements GqlQueryable {
  private log: winston.Logger;
  private clickhouseClient: ClickHouseClient;
  private gqlQueryable: GqlQueryable;
  private sqliteMinHeightEnabled: boolean;
  private sqliteMinHeightBuffer: number;
  private maxHeightCacheTtlMs: number;
  private maxHeightCache: { value: number; fetchedAt: number } | null = null;
  private maxHeightInFlight: Promise<number | null> | null = null;
  private sqliteBreaker: CircuitBreaker<[SqliteGqlArgs], GqlTransactionsResult>;

  constructor({
    log,
    gqlQueryable,
    url,
    username,
    password,
    sqliteMinHeightEnabled = false,
    sqliteMinHeightBuffer = 10,
    maxHeightCacheTtlSeconds = 60,
    queryTimeoutSeconds = 3,
    sqliteCircuitBreakerOptions = {
      timeout: config.CLICKHOUSE_SQLITE_CIRCUIT_BREAKER_TIMEOUT_MS,
      errorThresholdPercentage:
        config.CLICKHOUSE_SQLITE_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE,
      rollingCountTimeout:
        config.CLICKHOUSE_SQLITE_CIRCUIT_BREAKER_ROLLING_COUNT_TIMEOUT_MS,
      resetTimeout: config.CLICKHOUSE_SQLITE_CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
    },
  }: {
    log: winston.Logger;
    gqlQueryable: GqlQueryable;
    url: string;
    username?: string;
    password?: string;
    sqliteMinHeightEnabled?: boolean;
    sqliteMinHeightBuffer?: number;
    maxHeightCacheTtlSeconds?: number;
    queryTimeoutSeconds?: number;
    sqliteCircuitBreakerOptions?: CircuitBreaker.Options;
  }) {
    this.log = log;

    this.clickhouseClient = createClient({
      url,
      username,
      password,
      // Give the HTTP layer a small grace window past the server-side
      // timeout so the server's error response can surface before the
      // client aborts the request.
      request_timeout: queryTimeoutSeconds * 1000 + 2000,
      clickhouse_settings: {
        max_execution_time: queryTimeoutSeconds,
      },
    });

    this.gqlQueryable = gqlQueryable;
    this.sqliteMinHeightEnabled = sqliteMinHeightEnabled;
    this.sqliteMinHeightBuffer = sqliteMinHeightBuffer;
    this.maxHeightCacheTtlMs = maxHeightCacheTtlSeconds * 1000;

    this.sqliteBreaker = new CircuitBreaker(
      (args: SqliteGqlArgs) => this.gqlQueryable.getGqlTransactions(args),
      { ...sqliteCircuitBreakerOptions, name: 'composite-sqlite-gql' },
    );
    metrics.setUpCircuitBreakerListenerMetrics(
      'composite-sqlite-gql',
      this.sqliteBreaker,
      this.log,
    );
  }

  // Non-blocking view of the cached ClickHouse max height. Used on the
  // request path so the SQLite leg can be dispatched in parallel with
  // ClickHouse without an extra roundtrip. A cold cache falls back to
  // "no optimization" — SQLite scans the caller's full height range and
  // merge-time dedupe absorbs the overlap.
  private getCachedClickHouseMaxHeight(): number | null {
    if (this.maxHeightCache === null) return null;
    if (
      Date.now() - this.maxHeightCache.fetchedAt >=
      this.maxHeightCacheTtlMs
    ) {
      return null;
    }
    return this.maxHeightCache.value;
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

  // Builds the ORDER BY column list for a GQL transactions query. `qualified`
  // = true produces `t.height ...` for the inner SELECT; false produces bare
  // names (`height ...`) for the outer wrapper that reads from a subquery.
  // Returns an empty string when no ORDER BY should be emitted (id lookups).
  private buildTransactionOrderBy({
    sortOrder,
    recipients,
    owners,
    ids,
    qualified,
  }: {
    sortOrder: 'HEIGHT_DESC' | 'HEIGHT_ASC';
    recipients: string[];
    owners: string[];
    ids: string[];
    qualified: boolean;
  }): string {
    if (ids.length > 0) return '';
    const prefix = qualified ? 't.' : '';
    const dir = sortOrder === 'HEIGHT_DESC' ? 'DESC' : 'ASC';
    const parts: string[] = [];
    if (recipients.length === 1) {
      parts.push(`${prefix}target ${dir}`);
    } else if (owners.length === 1) {
      parts.push(`${prefix}owner_address ${dir}`);
    }
    parts.push(
      `${prefix}height ${dir}`,
      `${prefix}block_transaction_index ${dir}`,
      `${prefix}is_data_item ${dir}`,
      `${prefix}id ${dir}`,
    );
    return parts.join(', ');
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

    if (ids?.length === 0 && cursorHeight != null) {
      const cursorIdHex = b64UrlToHex(cursorId ?? '');
      const cursorIsDataItemInt = cursorIsDataItem ? 1 : 0;
      // Standalone height predicate enables partition pruning on
      // intDiv(height, 100000); the tuple comparison alone is not
      // decomposed by the ClickHouse partition pruner.
      if (sortOrder === 'HEIGHT_DESC') {
        query.where(
          sql.lte('t.height', cursorHeight),
          sql(
            `(t.height, t.block_transaction_index, t.is_data_item, t.id) < ` +
              `(${cursorHeight}, ${cursorBlockTransactionIndex}, ${cursorIsDataItemInt}, unhex('${cursorIdHex}'))`,
          ),
        );
      } else {
        query.where(
          sql.gte('t.height', cursorHeight),
          sql(
            `(t.height, t.block_transaction_index, t.is_data_item, t.id) > ` +
              `(${cursorHeight}, ${cursorBlockTransactionIndex}, ${cursorIsDataItemInt}, unhex('${cursorIdHex}'))`,
          ),
        );
      }
    }

    const orderBy = this.buildTransactionOrderBy({
      sortOrder,
      recipients,
      owners,
      ids,
      qualified: true,
    });
    if (orderBy) {
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

    const innerSql = txsQuery.toString();
    // Wrapping the filtered select as a subquery with its own `LIMIT N`
    // unlocks ClickHouse's read-in-order early termination: a plain
    // `ORDER BY pk LIMIT N` is what the planner short-circuits, whereas
    // an intervening `LIMIT 1 BY` blocks pushdown and forces the full
    // scan to complete before dedupe. The outer `LIMIT 1 BY` then
    // collapses unmerged ReplacingMergeTree versions; its companion
    // `ORDER BY` pins a deterministic ordering through the subquery
    // boundary. The inner SELECT / FROM / WHERE is unchanged, so
    // owner_projection selection still kicks in for owner-filtered
    // queries.
    const innerLimit = (pageSize + 1) * config.CLICKHOUSE_GQL_DEDUPE_HEADROOM;
    const outerOrderBy = this.buildTransactionOrderBy({
      sortOrder,
      recipients,
      owners,
      ids,
      qualified: false,
    });
    const outerOrderByClause = outerOrderBy ? ` ORDER BY ${outerOrderBy}` : '';
    const dedupByPk =
      'LIMIT 1 BY height, block_transaction_index, is_data_item, id';
    // Per-query settings:
    // - `optimize_use_projections = 0` for id lookups: the projection cost
    //   estimator compares projection marks vs. main-table marks BEFORE
    //   applying skip indexes, so owner_projection (no bloom on id) wins
    //   over the main table and forces a full scan. Disabling it for id
    //   lookups lets id_bloom narrow ~6000 granules to a handful.
    // - `max_rows_to_read` as a hard guardrail: any GQL query that ends up
    //   scanning more than the configured threshold throws Code: 158
    //   instead of grinding through the whole table. Catches future
    //   regressions where a skip index is silently bypassed.
    const settings: string[] = [
      `max_rows_to_read = ${config.CLICKHOUSE_GQL_MAX_ROWS_TO_READ}`,
    ];
    if (ids?.length > 0) {
      settings.push('optimize_use_projections = 0');
    }
    const settingsClause = ` SETTINGS ${settings.join(', ')}`;
    const sql =
      `SELECT * FROM (${innerSql} LIMIT ${innerLimit})` +
      `${outerOrderByClause} ${dedupByPk} LIMIT ${pageSize + 1}` +
      settingsClause;

    this.log.debug('Querying ClickHouse transactions...', { sql });

    // Resolve the SQLite boundary from the *cached* ClickHouse max height
    // only, so we can launch both legs in parallel without a blocking
    // roundtrip. Cold cache → skip the optimization and let merge-time
    // dedupe absorb overlap.
    let sqliteMinHeight = minHeight;
    let skipSqlite = false;
    if (this.sqliteMinHeightEnabled) {
      const cachedMax = this.getCachedClickHouseMaxHeight();
      if (cachedMax !== null) {
        const boundary = cachedMax - this.sqliteMinHeightBuffer;
        const candidate = boundary + 1;
        if (candidate > sqliteMinHeight) {
          sqliteMinHeight = candidate;
        }
        if (maxHeight >= 0 && sqliteMinHeight > maxHeight) {
          skipSqlite = true;
        }
      }
    }

    const chPromise = (async () => {
      const row = await this.clickhouseClient.query({ query: sql });
      const jsonRow = await row.json();
      return jsonRow.data.map((tx: any) => ({
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
    })();

    const sqlitePromise: Promise<GqlTransactionsResult> = skipSqlite
      ? Promise.resolve({ pageInfo: { hasNextPage: false }, edges: [] })
      : this.sqliteBreaker.fire({
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

    // Keep the boundary-optimization cache warm for future calls without
    // blocking this one. Cache hits short-circuit; misses dedupe via
    // maxHeightInFlight.
    if (this.sqliteMinHeightEnabled) {
      void this.getClickHouseMaxHeight();
    }

    const [chSettled, sqliteSettled] = await Promise.allSettled([
      chPromise,
      sqlitePromise,
    ]);

    // ClickHouse errors (timeout, max_rows_to_read, etc.) propagate to the
    // caller — slow/bad queries should surface to whoever authored them.
    if (chSettled.status === 'rejected') {
      throw chSettled.reason;
    }
    const txs = chSettled.value;

    // SQLite rejections (breaker open, breaker timeout, underlying error)
    // degrade to ClickHouse-only results. A warning is attached to the
    // returned result so the resolver layer can surface it to the caller
    // via GraphQL `extensions` — callers must not receive silent partials
    // (SQLite is the sole source for tip-of-chain rows when the boundary
    // optimization is enabled).
    let sqliteEdges: GqlTransactionsResult['edges'] = [];
    const warnings: GqlWarning[] = [];
    if (sqliteSettled.status === 'fulfilled') {
      sqliteEdges = sqliteSettled.value.edges.filter(
        (edge) => !txs.some((tx) => tx.id === edge.node.id),
      );
      if (
        sqliteSettled.value.warnings !== undefined &&
        sqliteSettled.value.warnings.length > 0
      ) {
        warnings.push(...sqliteSettled.value.warnings);
      }
    } else {
      const reason = sqliteSettled.reason as {
        message?: string;
        code?: string;
      };
      this.log.warn(
        'Composite SQLite GQL leg failed; returning ClickHouse-only results',
        {
          message: reason?.message,
          code: reason?.code,
        },
      );
      warnings.push({
        code: 'PARTIAL_RESULT',
        message: `sqlite unavailable: ${reason?.code ?? reason?.message ?? 'unknown'}`,
      });
    }

    // Combine the ClickHouse results with the SQLite results
    const edges = [
      ...txs.map((tx) => ({
        cursor: encodeTransactionGqlCursor(tx),
        node: tx,
      })),
      ...sqliteEdges,
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
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  async getGqlTransaction({
    id,
    warnings,
  }: {
    id: string;
    warnings?: GqlWarning[];
  }) {
    const results = await this.getGqlTransactions({
      pageSize: 1,
      ids: [id],
      tags: [],
    });
    // Surface composite-level warnings (e.g. SQLite unavailable) so the
    // single-record lookup isn't a silent false negative when the leg
    // that would have produced the match is unreachable.
    if (
      warnings !== undefined &&
      results.warnings !== undefined &&
      results.warnings.length > 0
    ) {
      warnings.push(...results.warnings);
    }
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
