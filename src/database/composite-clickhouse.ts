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

// Single source of truth for the GraphQL transactions SELECT column
// list, shared by both the stable leg (`transactions`) and the unstable
// leg (`new_transactions`). The unstable table doesn't store the
// offset/size pointer family — those are stable-pipeline artifacts —
// so when the caller asks for `'null'` projections those four columns
// become typed-nullable NULL casts. The cast is required: ClickHouse
// would otherwise parse a bare `NULL AS alias` as a reference to a
// column literally named NULL, not a NULL literal. The same column
// order is also what `mapTransactionRow` and `addGqlTransactionFilters`
// depend on, so adding a column means updating those in lockstep.
function buildGqlTransactionColumns(
  offsetFamily: 'concrete' | 'null',
): string[] {
  const nullCol = (name: string) =>
    offsetFamily === 'null'
      ? `CAST(NULL AS Nullable(UInt64)) AS ${name}`
      : name;
  return [
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
    nullCol('owner_size'),
    nullCol('owner_offset'),
    'hex(parent_id) AS parent_id',
    'tags_count',
    'tags',
    'indexed_at',
    nullCol('signature_size'),
    nullCol('signature_offset'),
    'signature_type',
  ];
}

type SqliteGqlArgs = Parameters<GqlQueryable['getGqlTransactions']>[0];

// Pre-encoded SQL literal forms shared across the two CH legs in
// `getGqlTransactions`. Built once by `prepareGqlFilterEncodings` and
// passed into `addGqlTransactionFilters` so each leg doesn't redo the
// same hex/b64url encoding work on a hot path. `sql.Statement`
// fragments are pure data (rendered to strings at `query.toString()`
// time) and safe to reuse across query objects.
interface EncodedGqlFilters {
  idsInList?: sql.Statement;
  recipientsInList?: sql.Statement;
  ownersInList?: sql.Statement;
  bundledInList?: sql.Statement;
  tagPredicates: Array<{
    // `(unhex('aa'), unhex('bb')), (unhex('aa'), unhex('cc')), ...`
    pairsSql: string;
    // `unhex('aa')`
    nameSql: string;
    // `unhex('bb'), unhex('cc'), ...`
    valueListSql: string;
  }>;
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
  private sqliteBreaker: CircuitBreaker<[SqliteGqlArgs], GqlTransactionsResult>;
  // Streaming mode: when true, the composite queries `new_transactions`
  // (joined against `new_blocks` for orphan filtering) as a third leg
  // covering the unstable head. When false, behavior is unchanged from
  // the 2-leg (CH stable + SQLite) path.
  private queryUnstableHead: boolean;
  // When true, the SQLite leg is skipped entirely. Operators set this
  // alongside streaming-enable to make CH the sole read path. Has no
  // effect on SQLite WRITES; the indexer still feeds SQLite for the
  // Parquet export pipeline.
  private skipSqliteReads: boolean;

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
    queryUnstableHead = false,
    skipSqliteReads = false,
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
    queryUnstableHead?: boolean;
    skipSqliteReads?: boolean;
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
    this.queryUnstableHead = queryUnstableHead;
    this.skipSqliteReads = skipSqliteReads;

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
      .select(...buildGqlTransactionColumns('concrete'))
      .from('transactions AS t');
  }

  /**
   * Builds the base SELECT for the **unstable-head** ClickHouse leg of
   * the GraphQL transactions merge — reads from `new_transactions`
   * joined against `new_blocks` for orphan filtering.
   *
   * Mirrors the column shape of {@link getGqlTransactionsBaseSql} so
   * `addGqlTransactionFilters` and the result mapper work identically
   * across the two CH legs. `new_transactions` deliberately doesn't
   * store the offset/size pointer family (those are stable-pipeline
   * artifacts), so those columns are projected as NULL — keeping the
   * result shape uniform with the stable leg avoids special-casing in
   * the JS merge or in downstream GraphQL resolvers.
   *
   * The orphan-filter join is expressed as a tuple-IN subquery against
   * `new_blocks`. Reorgs prune `new_blocks` directly, so any unstable
   * transactions whose `(height, block_indep_hash)` no longer matches
   * a row in `new_blocks` are filtered out at query time and age out
   * via TTL. ClickHouse handles the tuple-IN with a single hash-set
   * probe over the small `new_blocks` table.
   *
   * Only invoked when `queryUnstableHead` is true. See PR #699.
   */
  private getGqlUnstableTransactionsBaseSql() {
    const base = sql
      .select(...buildGqlTransactionColumns('null'))
      .from('new_transactions AS t');
    base.where(
      sql(
        '(t.height, t.block_indep_hash) IN ' +
          '(SELECT height, indep_hash FROM new_blocks)',
      ),
    );
    return base;
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

  /**
   * Hex/b64url-encodes id/recipient/owner/bundledIn lists and per-tag
   * name/value bytes into the SQL-literal forms that
   * `addGqlTransactionFilters` will splice into `WHERE` clauses. The
   * resulting struct is pure data — no `sql-bricks` query objects are
   * mutated here — so it can be safely passed to both the stable and
   * unstable leg builders, which would otherwise each redo the same
   * `Buffer.from(...).toString('hex')` and `inB64UrlStrings(...)` work
   * on a hot path when streaming is enabled.
   */
  prepareGqlFilterEncodings({
    ids = [],
    recipients = [],
    owners = [],
    bundledIn,
    tags = [],
  }: {
    ids?: string[];
    recipients?: string[];
    owners?: string[];
    bundledIn?: string[] | null;
    tags?: { name: string; values: string[] }[];
  }): EncodedGqlFilters {
    const encoded: EncodedGqlFilters = { tagPredicates: [] };
    if (ids.length > 0) encoded.idsInList = inB64UrlStrings(ids);
    if (recipients.length > 0)
      encoded.recipientsInList = inB64UrlStrings(recipients);
    if (owners.length > 0) encoded.ownersInList = inB64UrlStrings(owners);
    if (Array.isArray(bundledIn))
      encoded.bundledInList = inB64UrlStrings(bundledIn);
    for (const tag of tags) {
      const hexName = Buffer.from(tag.name).toString('hex');
      const hexValues = tag.values.map((value) =>
        Buffer.from(value).toString('hex'),
      );
      encoded.tagPredicates.push({
        pairsSql: hexValues
          .map((hexValue) => `(unhex('${hexName}'), unhex('${hexValue}'))`)
          .join(', '),
        nameSql: `unhex('${hexName}')`,
        valueListSql: hexValues
          .map((hexValue) => `unhex('${hexValue}')`)
          .join(', '),
      });
    }
    return encoded;
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
    encoded,
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
    // Optional pre-encoded forms shared across CH legs. When omitted
    // (single-leg callers and tests) the encoding happens inline.
    encoded?: EncodedGqlFilters;
  }) {
    const maxDbHeight = Infinity;
    const prepared =
      encoded ??
      this.prepareGqlFilterEncodings({
        ids,
        recipients,
        owners,
        bundledIn,
        tags,
      });

    if (prepared.idsInList !== undefined) {
      query.where(sql.in('t.id', prepared.idsInList));
    }

    if (prepared.recipientsInList !== undefined) {
      query.where(sql.in('t.target', prepared.recipientsInList));
    }

    if (prepared.ownersInList !== undefined) {
      query.where(sql.in('t.owner_address', prepared.ownersInList));
    }

    for (const tagPred of prepared.tagPredicates) {
      query.where(sql(`hasAny(t.tags, [${tagPred.pairsSql}])`));
      query.where(sql(`has(t.tag_names, ${tagPred.nameSql})`));
      query.where(sql(`hasAny(t.tag_values, [${tagPred.valueListSql}])`));
    }

    if (minHeight != null && minHeight > 0) {
      query.where(sql.gte('t.height', minHeight));
    }

    if (maxHeight != null && maxHeight >= 0 && maxHeight < maxDbHeight) {
      query.where(sql.lte('t.height', maxHeight));
    }

    if (prepared.bundledInList !== undefined) {
      query.where(sql.in('t.parent_id', prepared.bundledInList));
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

  // Wraps a filtered base SELECT in the standard outer LIMIT 1 BY +
  // inner LIMIT envelope used by both CH legs. The wrapping unlocks
  // ClickHouse's read-in-order early termination (a plain
  // `ORDER BY pk LIMIT N` is what the planner short-circuits, whereas
  // an intervening `LIMIT 1 BY` blocks pushdown), then the outer
  // LIMIT 1 BY collapses unmerged ReplacingMergeTree versions. The
  // result is shape-identical across stable and unstable legs, so
  // mapTransactionRow handles either leg's rows without branching.
  private buildChTransactionsSql({
    innerSql,
    pageSize,
    sortOrder,
    recipients,
    owners,
    ids,
    tags,
  }: {
    innerSql: string;
    pageSize: number;
    sortOrder: 'HEIGHT_DESC' | 'HEIGHT_ASC';
    recipients: string[];
    owners: string[];
    ids: string[];
    tags: { name: string; values: string[] }[];
  }): string {
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
    // - `optimize_use_projections = 0` for id and tag lookups: projections
    //   don't support inline skip indexes (ClickHouse grammar rejects INDEX
    //   inside a PROJECTION body), so any skip-index pruning has to happen
    //   against the main table. The projection cost estimator also compares
    //   marks BEFORE applying skip indexes, so owner_projection wins on raw
    //   size and forces a full scan. Disabling it lets id_bloom /
    //   tag_names_bloom / tag_values_bloom do their job, with
    //   owner_address_bloom pruning the owner dimension on the main table.
    //   Harmless on the unstable leg (no projections) but kept uniform so
    //   the wrapper is shape-identical across legs.
    // - `max_rows_to_read` as a hard guardrail: any GQL query that ends up
    //   scanning more than the configured threshold throws Code: 158
    //   instead of grinding through the whole table. Catches future
    //   regressions where a skip index is silently bypassed.
    const settings: string[] = [
      `max_rows_to_read = ${config.CLICKHOUSE_GQL_MAX_ROWS_TO_READ}`,
    ];
    if (ids.length > 0 || tags.length > 0) {
      settings.push('optimize_use_projections = 0');
    }
    const settingsClause = ` SETTINGS ${settings.join(', ')}`;
    return (
      `SELECT * FROM (${innerSql} LIMIT ${innerLimit})` +
      `${outerOrderByClause} ${dedupByPk} LIMIT ${pageSize + 1}` +
      settingsClause
    );
  }

  // Maps a CH row from either the stable or unstable transactions table
  // into the GraphQL transaction shape. The two tables project the same
  // columns (the unstable leg fills offset-family columns with NULL),
  // so a single mapper works for both.
  private mapTransactionRow(
    tx: any,
  ): GqlTransactionsResult['edges'][0]['node'] {
    return {
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
    };
  }

  /**
   * Composite GraphQL `transactions` query. Fans out across up to
   * three legs in parallel and merges the results with explicit
   * precedence:
   *
   * 1. **CH stable** (`transactions`) — primary path, fail-fast on
   *    rejection (slow/bad queries surface to the caller).
   * 2. **CH unstable** (`new_transactions ⨝ new_blocks`) — best-effort,
   *    only invoked when `queryUnstableHead` is true; rejection
   *    degrades to a `PARTIAL_RESULT` warning rather than failing the
   *    whole request.
   * 3. **SQLite fallback** — tight-timeout circuit-broken leg; skipped
   *    entirely when `skipSqliteReads` is true.
   *
   * Set-based dedup with stable > unstable > sqlite precedence handles
   * the stabilization-overlap window where the same `id` briefly lives
   * in both `transactions` and `new_transactions` until TTL drops the
   * unstable copy. JS-side sort + slice produces a deterministic page;
   * `hasNextPage` is computed against the deduped edge list (not the
   * raw concatenation) so cross-leg duplicates that collapse the page
   * don't falsely advertise more results.
   *
   * See `clickhouse-pipeline.md` and PR #699 for the design rationale.
   */
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
    // Encode id/recipient/owner/bundledIn lists and per-tag bytes
    // once and share across both CH legs — the work is the same per
    // leg and shows up on tag-heavy queries when streaming is on.
    const encodedFilters = this.prepareGqlFilterEncodings({
      ids,
      recipients,
      owners,
      bundledIn,
      tags,
    });

    // STABLE LEG — `transactions`. Always queried; this is CH's primary
    // role and any failure here surfaces to the caller (fail-fast).
    const stableQuery = this.getGqlTransactionsBaseSql();
    this.addGqlTransactionFilters({
      query: stableQuery,
      cursor,
      sortOrder,
      ids,
      recipients,
      owners,
      minHeight,
      maxHeight,
      bundledIn,
      tags,
      encoded: encodedFilters,
    });
    const stableSql = this.buildChTransactionsSql({
      innerSql: stableQuery.toString(),
      pageSize,
      sortOrder,
      recipients,
      owners,
      ids,
      tags,
    });

    this.log.debug('Querying ClickHouse stable transactions...', {
      sql: stableSql,
    });

    // Resolve the SQLite boundary from the *cached* ClickHouse max height
    // only, so we can launch both legs in parallel without a blocking
    // roundtrip. Cold cache → skip the optimization and let merge-time
    // dedupe absorb overlap.
    let sqliteMinHeight = minHeight;
    let skipSqliteByBoundary = false;
    if (this.sqliteMinHeightEnabled) {
      const cachedMax = this.getCachedClickHouseMaxHeight();
      if (cachedMax !== null) {
        const boundary = cachedMax - this.sqliteMinHeightBuffer;
        const candidate = boundary + 1;
        if (candidate > sqliteMinHeight) {
          sqliteMinHeight = candidate;
        }
        if (maxHeight >= 0 && sqliteMinHeight > maxHeight) {
          skipSqliteByBoundary = true;
        }
      }
    }

    const chStablePromise = (async () => {
      const row = await this.clickhouseClient.query({ query: stableSql });
      const jsonRow = await row.json();
      return jsonRow.data.map((tx: any) => this.mapTransactionRow(tx));
    })();

    // UNSTABLE LEG — `new_transactions` joined against `new_blocks` for
    // orphan filtering. Best-effort: rejection degrades to other legs,
    // doesn't fail the whole query. Skipped entirely when streaming is
    // disabled (the default), in which case behavior is identical to
    // the pre-streaming 2-leg path.
    const chUnstablePromise: Promise<
      GqlTransactionsResult['edges'][0]['node'][]
    > = this.queryUnstableHead
      ? (async () => {
          const unstableQuery = this.getGqlUnstableTransactionsBaseSql();
          this.addGqlTransactionFilters({
            query: unstableQuery,
            cursor,
            sortOrder,
            ids,
            recipients,
            owners,
            minHeight,
            maxHeight,
            bundledIn,
            tags,
            encoded: encodedFilters,
          });
          const unstableSql = this.buildChTransactionsSql({
            innerSql: unstableQuery.toString(),
            pageSize,
            sortOrder,
            recipients,
            owners,
            ids,
            tags,
          });
          this.log.debug('Querying ClickHouse unstable transactions...', {
            sql: unstableSql,
          });
          const row = await this.clickhouseClient.query({ query: unstableSql });
          const jsonRow = await row.json();
          return jsonRow.data.map((tx: any) => this.mapTransactionRow(tx));
        })()
      : Promise.resolve([]);

    // SQLITE LEG — degraded-mode fallback when streaming is enabled,
    // primary unstable-head source when streaming is disabled. Skipped
    // entirely when CLICKHOUSE_GQL_SKIP_SQLITE_READS is set, or when
    // the boundary optimization determined the leg's range is empty.
    const sqlitePromise: Promise<GqlTransactionsResult> =
      this.skipSqliteReads || skipSqliteByBoundary
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
            bundledIn,
            tags,
          });

    // Convert best-effort legs to settled-shape promises eagerly. This
    // both absorbs rejections (preventing unhandled-rejection noise if
    // the stable leg fails first and we bail before awaiting them) and
    // lets us await without nested try/catch.
    const unstableSettledPromise: Promise<
      PromiseSettledResult<GqlTransactionsResult['edges'][0]['node'][]>
    > = chUnstablePromise.then(
      (value) => ({ status: 'fulfilled', value }) as const,
      (reason) => ({ status: 'rejected', reason }) as const,
    );
    const sqliteSettledPromise: Promise<
      PromiseSettledResult<GqlTransactionsResult>
    > = sqlitePromise.then(
      (value) => ({ status: 'fulfilled', value }) as const,
      (reason) => ({ status: 'rejected', reason }) as const,
    );

    // Keep the boundary-optimization cache warm for future calls without
    // blocking this one. Cache hits short-circuit; misses dedupe via
    // maxHeightInFlight.
    if (this.sqliteMinHeightEnabled) {
      void this.getClickHouseMaxHeight();
    }

    // Await stable first and fail fast on rejection — slow/bad queries
    // should surface to whoever authored them without being gated on
    // the slower legs' timeouts. The other legs keep running in the
    // background; their rejections are already absorbed above.
    const stableTxs = await chStablePromise;

    const warnings: GqlWarning[] = [];

    // Unstable leg: rejection degrades to other-leg-only results with
    // a PARTIAL_RESULT warning so callers can surface it via GraphQL
    // `extensions`.
    const unstableSettled = await unstableSettledPromise;
    let unstableTxs: GqlTransactionsResult['edges'][0]['node'][] = [];
    if (unstableSettled.status === 'fulfilled') {
      unstableTxs = unstableSettled.value;
    } else if (this.queryUnstableHead) {
      const reason = unstableSettled.reason as {
        message?: string;
        code?: string;
      };
      this.log.warn(
        'Composite ClickHouse unstable GQL leg failed; ' +
          'returning results without unstable head',
        { message: reason?.message, code: reason?.code },
      );
      warnings.push({
        code: 'PARTIAL_RESULT',
        message: `clickhouse unstable unavailable: ${reason?.code ?? reason?.message ?? 'unknown'}`,
      });
    }

    // SQLite leg: rejection degrades same as today.
    const sqliteSettled = await sqliteSettledPromise;
    let sqliteEdges: GqlTransactionsResult['edges'] = [];
    if (sqliteSettled.status === 'fulfilled') {
      sqliteEdges = sqliteSettled.value.edges;
      if (
        sqliteSettled.value.warnings !== undefined &&
        sqliteSettled.value.warnings.length > 0
      ) {
        warnings.push(...sqliteSettled.value.warnings);
      }
    } else if (!this.skipSqliteReads && !skipSqliteByBoundary) {
      const reason = sqliteSettled.reason as {
        message?: string;
        code?: string;
      };
      this.log.warn(
        'Composite SQLite GQL leg failed; returning ClickHouse-only results',
        { message: reason?.message, code: reason?.code },
      );
      warnings.push({
        code: 'PARTIAL_RESULT',
        message: `sqlite unavailable: ${reason?.code ?? reason?.message ?? 'unknown'}`,
      });
    }

    // Precedence-aware dedup. Stable wins over unstable wins over SQLite
    // — when the same id appears on multiple legs (common in the
    // stabilization-overlap window: a row briefly exists in both
    // `transactions` and `new_transactions` until TTL drops the unstable
    // copy), the merge picks the leg with the most authoritative source.
    // O(n) Set lookups; the prior implementation's O(n²) `some()` scan
    // was tolerable for two legs but doesn't scale to three.
    const seenIds = new Set<string>();
    const edges: GqlTransactionsResult['edges'] = [];
    for (const tx of stableTxs) {
      if (seenIds.has(tx.id)) continue;
      seenIds.add(tx.id);
      edges.push({ cursor: encodeTransactionGqlCursor(tx), node: tx });
    }
    for (const tx of unstableTxs) {
      if (seenIds.has(tx.id)) continue;
      seenIds.add(tx.id);
      edges.push({ cursor: encodeTransactionGqlCursor(tx), node: tx });
    }
    for (const edge of sqliteEdges) {
      if (seenIds.has(edge.node.id)) continue;
      seenIds.add(edge.node.id);
      edges.push(edge);
    }

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
