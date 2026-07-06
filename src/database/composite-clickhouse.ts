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
import {
  GqlTransactionsResult,
  GqlQueryable,
  GqlWarning,
  ItemFilter,
} from '../types.js';
import { isL1OnlyQuery } from './gql-l1-routing.js';

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
    'hex(anchor) AS anchor',
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

// Tag name carrying the ArDrive entity type (drive / folder / file / snapshot).
// The owner_projection routing feature keys off this tag's values.
const ENTITY_TYPE_TAG_NAME = 'Entity-Type';

// ClickHouse `Code: 158 TOO_MANY_ROWS` — raised when a GQL query would scan
// more than `max_rows_to_read`. The @clickhouse/client surfaces server errors
// with a numeric `.code` (string or number) and a message of the form
// `Code: 158. DB::Exception: ...TOO_MANY_ROWS...`.
function isClickHouseTooManyRowsError(err: unknown): boolean {
  const e = err as { code?: string | number; message?: string } | null;
  if (e == null) return false;
  if (e.code === '158' || e.code === 158) return true;
  return /\bcode:\s*158\b|TOO_MANY_ROWS/i.test(e.message ?? '');
}

// Low-cardinality descriptor of which filter families a GQL query used, for
// the `filter` label on `clickhouse_gql_too_many_rows_total`. Bounded to the
// 32 combinations of the five filter families (plus `none`), so it's safe as a
// Prometheus label. The paired warn log carries the concrete filter values.
function describeGqlFilterShape(args: {
  ids: string[];
  owners: string[];
  recipients: string[];
  bundledIn?: string[] | null;
  tags: { name: string; values: string[] }[];
}): string {
  const families: string[] = [];
  if (args.ids.length > 0) families.push('ids');
  if (args.owners.length > 0) families.push('owners');
  if (args.recipients.length > 0) families.push('recipients');
  if (args.bundledIn != null && args.bundledIn.length > 0)
    families.push('bundledIn');
  if (args.tags.length > 0) families.push('tags');
  return families.length > 0 ? families.join('+') : 'none';
}

// Coarse id-count bucket for the `id_count` label on
// `clickhouse_gql_too_many_rows_total`. The dominant 158 source is multi-id
// `transactions(ids:[...])` lookups whose id_bloom scatter scales ~linearly
// with id count (each id ≈ 1% of granules as false positives), so the number
// of ids is the load-bearing dimension — but the raw count is too
// high-cardinality for a label. Buckets chosen around the observed
// max_rows_to_read boundary (single-id safe, ~2 marginal, 3+ over the cap).
function bucketIdCount(n: number): string {
  if (n === 0) return '0';
  if (n === 1) return '1';
  if (n === 2) return '2';
  if (n <= 5) return '3-5';
  if (n <= 20) return '6-20';
  return '21+';
}

// Reactive fallback (hack 5) for owner-filtered GQL queries whose owner
// footprint is so large it still trips `max_rows_to_read` even via
// owner_projection (a "whale" owner). When the single-shot stable query throws
// Code 158, we re-run it as a walk over height windows, each small enough to
// stay under the cap, in sort order, accumulating until we have a full page.
// See docs/drafts/2026-06-25-clickhouse-gql-owner-filter-too-many-rows.md.
// The whole feature is gated by `ownerProjectionRoutingEnabled`
// (config.CLICKHOUSE_GQL_OWNER_PROJECTION_ROUTING_ENABLED, default off). The
// span-tuning values below are deliberately module-level constants for a first
// cut; promote to env config (CLICKHOUSE_GQL_OWNER_WINDOW_*) if operators need
// to tune them.
// Number of windows the initial span aims to divide the walked range into.
const OWNER_WINDOW_INITIAL_DIVISIONS = 8;
// Smallest height span a window may shrink to before we stop subdividing. A
// span this small still exceeding the cap is pathological and signals the data
// needs the dedicated owner-ordered table rather than reactive windowing.
const OWNER_WINDOW_MIN_SPAN = 10_000;
// Safety cap on total windows per fallback so a sparse-/no-match whale walk
// can't scan the whole chain unbounded.
const OWNER_WINDOW_MAX_WINDOWS = 256;

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
  // When true, owner-filtered GQL queries are routed through
  // `owner_projection` and gain the reactive height-windowing fallback on
  // `max_rows_to_read`. Off by default — see
  // config.CLICKHOUSE_GQL_OWNER_PROJECTION_ROUTING_ENABLED.
  private ownerProjectionRoutingEnabled: boolean;
  // Allowlist of `Entity-Type` values eligible for owner_projection routing
  // (e.g. drive/folder/snapshot). `file` is intentionally absent — see
  // ownerProjectionApplies and config.CLICKHOUSE_GQL_OWNER_PROJECTION_ENTITY_TYPES.
  private ownerProjectionEntityTypes: Set<string>;
  // When set, GQL `transactions` queries provably confined to L1 by this
  // (monotone) filter are served from the L1-only SQLite index, skipping
  // ClickHouse entirely — see gql-l1-routing.ts and
  // config.GQL_L1_ONLY_ROUTING_FILTER.
  private l1OnlyRoutingFilter: ItemFilter | undefined;

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
    ownerProjectionRoutingEnabled = false,
    ownerProjectionEntityTypes = [],
    l1OnlyRoutingFilter,
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
    ownerProjectionRoutingEnabled?: boolean;
    ownerProjectionEntityTypes?: string[];
    // Monotone filter classifying L1-only-routable queries. Omit (or pass a
    // NeverMatch) to disable routing.
    l1OnlyRoutingFilter?: ItemFilter;
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
    this.ownerProjectionRoutingEnabled = ownerProjectionRoutingEnabled;
    this.ownerProjectionEntityTypes = new Set(ownerProjectionEntityTypes);
    this.l1OnlyRoutingFilter = l1OnlyRoutingFilter;

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
        metrics.clickhouseMaxImportedHeight.set(value);
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
  // Whether a GQL transactions query is eligible for owner_projection routing
  // (and its 158 windowing fallback). Requires the feature enabled, an
  // `owners` filter, no `ids` filter (id lookups have their own selective
  // path), and an `Entity-Type` tag filter whose values are ALL in the
  // configured allowlist. The Entity-Type gate is what excludes `file`
  // (large per-owner result → an expensive full sort per page under
  // read-in-order=0) as well as bare-owner and owner+other-tag queries.
  private ownerProjectionApplies(
    owners: string[],
    ids: string[],
    tags: { name: string; values: string[] }[],
  ): boolean {
    if (!this.ownerProjectionRoutingEnabled) return false;
    if (owners.length === 0) return false;
    // Owner + ids: the id list bounds the result to at most `ids.length` rows,
    // so seek the owner's slice via the projection and filter the ids within —
    // regardless of any tag filters. On the main table a multi-id `id IN (...)`
    // lights up most of id_bloom's granules (≈ a half-table scan), so even with
    // an owner filter ~100 ids reads >10M rows and trips the cap; through the
    // projection it's an owner-footprint read (measured ~556K rows vs 308M
    // ids-only / 13.6M ids+owner on the main table).
    if (ids.length > 0) return true;
    // Owner + allowlisted Entity-Type, no ids: require an Entity-Type filter and
    // NO other tag types. An additional non-Entity-Type tag (e.g. App-Name) only
    // narrows the result, but it's an untested shape and the agreed contract
    // excludes owner+other-tag queries, so fall back to the default plan.
    const entityTypeTags = tags.filter(
      (tag) => tag.name === ENTITY_TYPE_TAG_NAME,
    );
    if (entityTypeTags.length === 0 || entityTypeTags.length !== tags.length) {
      return false;
    }
    return entityTypeTags.every(
      (tag) =>
        tag.values.length > 0 &&
        tag.values.every((value) => this.ownerProjectionEntityTypes.has(value)),
    );
  }

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
    // Owner-filtered queries (the dominant ArDrive access pattern, e.g.
    // `owners:[x], tags:[Entity-Type=drive]`) are routed through
    // `owner_projection`, the owner-ordered copy of the data. The main
    // `transactions` table is height-ordered, so a sparse owner's rows are
    // smeared ~8-per-granule across the full height range; finding a page
    // there scans tens of millions of rows and trips `max_rows_to_read`
    // (measured: an owner with 22k total rows / 46 drives forced a 12.1M-row
    // read → Code 158). The projection seeks straight to the owner's
    // contiguous slice (measured 451K rows for the same query). ClickHouse
    // won't route a top-N `ORDER BY ... LIMIT` to a normal projection while
    // read-in-order is enabled, so it's disabled here; the matched set is
    // small (bounded by the owner's footprint) and sorted in memory instead.
    //
    // Scoped to owner-without-id queries and applied uniformly across tag
    // values (no per-`Entity-Type` special-casing):
    //  - id lookups have their own selective `id_bloom` path on the main
    //    table; the owner ordering doesn't help them.
    //  - tag-/recipient-only queries (no owner) have nothing to seek on in
    //    the owner-ordered projection, so enabling it there forces a full
    //    projection scan — which is why projections stay disabled for those.
    // Harmless on the unstable leg (`new_transactions` has no projection).
    if (this.ownerProjectionApplies(owners, ids, tags)) {
      settings.push(
        'optimize_use_projections = 1',
        'optimize_read_in_order = 0',
      );
    } else if (ids.length > 0 || tags.length > 0) {
      settings.push('optimize_use_projections = 0');
    }
    const settingsClause = ` SETTINGS ${settings.join(', ')}`;
    return (
      `SELECT * FROM (${innerSql} LIMIT ${innerLimit})` +
      `${outerOrderByClause} ${dedupByPk} LIMIT ${pageSize + 1}` +
      settingsClause
    );
  }

  // Runs one window of the owner-window fallback: the standard stable-leg
  // query restricted to a `[windowMinHeight, windowMaxHeight]` slice. Reuses
  // the normal filter + wrapper builders, so the owner_projection settings and
  // `max_rows_to_read` cap apply per window (a window that still exceeds the
  // cap throws Code 158, which the walk catches and subdivides).
  private async queryStableWindow({
    pageSize,
    cursor,
    sortOrder,
    ids,
    recipients,
    owners,
    windowMinHeight,
    windowMaxHeight,
    bundledIn,
    tags,
    encoded,
  }: {
    pageSize: number;
    cursor?: string;
    sortOrder: 'HEIGHT_DESC' | 'HEIGHT_ASC';
    ids: string[];
    recipients: string[];
    owners: string[];
    windowMinHeight: number;
    windowMaxHeight: number;
    bundledIn?: string[] | null;
    tags: { name: string; values: string[] }[];
    encoded: EncodedGqlFilters;
  }): Promise<GqlTransactionsResult['edges'][0]['node'][]> {
    const query = this.getGqlTransactionsBaseSql();
    this.addGqlTransactionFilters({
      query,
      cursor,
      sortOrder,
      ids,
      recipients,
      owners,
      minHeight: windowMinHeight,
      maxHeight: windowMaxHeight,
      bundledIn,
      tags,
      encoded,
    });
    const windowSql = this.buildChTransactionsSql({
      innerSql: query.toString(),
      pageSize,
      sortOrder,
      recipients,
      owners,
      ids,
      tags,
    });
    const row = await this.clickhouseClient.query({ query: windowSql });
    const jsonRow = await row.json();
    return (jsonRow.data as any[]).map((tx: any) => this.mapTransactionRow(tx));
  }

  /**
   * Reactive fallback (hack 5) for an owner-filtered stable-leg query that
   * tripped `max_rows_to_read` (Code 158) — i.e. a whale owner whose footprint
   * exceeds the cap even through owner_projection. Walks the requested height
   * range in windows small enough to stay under the cap, in `sortOrder`,
   * accumulating up to `pageSize + 1` rows so the caller's `hasNextPage` logic
   * is unchanged. Window span adapts: a window that still trips 158 is halved
   * and retried at the same leading edge.
   *
   * The returned rows are re-sorted with the other legs in `getGqlTransactions`,
   * so the walk only needs to find the correct *set* of top rows, not emit them
   * in perfect order. Windows are disjoint height ranges walked from the
   * leading edge, so once `pageSize + 1` rows are collected the remaining
   * (further-from-leading-edge) windows cannot contain a higher-priority row.
   */
  private async queryStableTransactionsWindowed({
    pageSize,
    cursor,
    sortOrder,
    ids,
    recipients,
    owners,
    minHeight,
    maxHeight,
    bundledIn,
    tags,
    encoded,
  }: {
    pageSize: number;
    cursor?: string;
    sortOrder: 'HEIGHT_DESC' | 'HEIGHT_ASC';
    ids: string[];
    recipients: string[];
    owners: string[];
    minHeight: number;
    maxHeight: number;
    bundledIn?: string[] | null;
    tags: { name: string; values: string[] }[];
    encoded: EncodedGqlFilters;
  }): Promise<GqlTransactionsResult['edges'][0]['node'][]> {
    const target = pageSize + 1;

    // Resolve concrete [lo, hi] height bounds for the walk. The caller's
    // min/max and the cached CH max height bound the range; the cursor (when
    // present) tightens the leading edge.
    let lo = minHeight > 0 ? minHeight : 0;
    let hi = maxHeight >= 0 ? maxHeight : await this.getClickHouseMaxHeight();
    if (hi == null) {
      // No upper bound to size windows against — surface the failure.
      throw new Error(
        'owner-window fallback: unable to resolve ClickHouse max height',
      );
    }
    const { height: cursorHeight } = decodeTransactionGqlCursor(cursor);
    if (cursorHeight != null) {
      if (sortOrder === 'HEIGHT_DESC') {
        hi = Math.min(hi, cursorHeight);
      } else {
        lo = Math.max(lo, cursorHeight);
      }
    }
    if (hi < lo) return [];

    let span = Math.max(
      OWNER_WINDOW_MIN_SPAN,
      Math.ceil((hi - lo + 1) / OWNER_WINDOW_INITIAL_DIVISIONS),
    );

    const collected: GqlTransactionsResult['edges'][0]['node'][] = [];
    const seen = new Set<string>();
    const descending = sortOrder === 'HEIGHT_DESC';
    // Current leading height (inclusive): top of the range for DESC, bottom
    // for ASC. Walks toward the trailing edge as windows are drained.
    let edge = descending ? hi : lo;
    // Running cursor: starts at the request cursor and advances to the last
    // row returned. A window holds at most `target` raw rows per fetch, so if
    // it contains more matching rows than that, the advanced cursor drains the
    // remainder across iterations instead of stranding them when we move on.
    let runningCursor = cursor;
    let windowCount = 0;

    while (
      collected.length < target &&
      (descending ? edge >= lo : edge <= hi)
    ) {
      if (windowCount >= OWNER_WINDOW_MAX_WINDOWS) {
        throw new Error(
          `owner-window fallback exceeded ${OWNER_WINDOW_MAX_WINDOWS} windows ` +
            'without filling a page; this owner footprint needs the dedicated ' +
            'owner-ordered table',
        );
      }

      const windowLo = descending ? Math.max(lo, edge - span + 1) : edge;
      const windowHi = descending ? edge : Math.min(hi, edge + span - 1);

      let rows: GqlTransactionsResult['edges'][0]['node'][];
      try {
        rows = await this.queryStableWindow({
          pageSize,
          cursor: runningCursor,
          sortOrder,
          ids,
          recipients,
          owners,
          windowMinHeight: windowLo,
          windowMaxHeight: windowHi,
          bundledIn,
          tags,
          encoded,
        });
      } catch (err) {
        // Window still too dense: halve the span and retry the same edge.
        if (isClickHouseTooManyRowsError(err) && span > OWNER_WINDOW_MIN_SPAN) {
          span = Math.max(OWNER_WINDOW_MIN_SPAN, Math.floor(span / 2));
          continue;
        }
        throw err;
      }

      for (const tx of rows) {
        if (seen.has(tx.id)) continue;
        seen.add(tx.id);
        collected.push(tx);
      }
      windowCount += 1;

      // Advance the cursor to the last (lowest-priority) row so a partially
      // consumed window resumes below it next iteration.
      if (rows.length > 0) {
        runningCursor = encodeTransactionGqlCursor(rows[rows.length - 1]);
      }

      // Only drop to the next window once this one is drained. A full
      // `target`-sized batch means there may be more matching rows below the
      // cursor in the SAME window (dedup can leave collected < target), so keep
      // the edge and let the advanced cursor pull the rest. A short batch means
      // the window beyond the cursor is exhausted.
      if (rows.length < target) {
        edge = descending ? windowLo - 1 : windowHi + 1;
      }
    }

    return collected.slice(0, target);
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
   * unstable copy. JS-side sort + slice produces a deterministic page.
   * `hasNextPage` is derived from each leg's raw result *before*
   * cross-leg id-dedup: a leg returning more than `pageSize` rows has
   * more matching data to give. Computing it against the deduped edge
   * count instead would falsely signal completeness whenever duplicate
   * ids collapse the merged page to `pageSize` or fewer (see PE-9124).
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
    // L1-only routing: when the operator-configured filter provably confines
    // this query to base-layer transactions, serve it from the L1 SQLite index
    // alone — a tag-name+value PK seek that sidesteps ClickHouse's row-scan cap
    // — and skip ClickHouse entirely. The original `minHeight` is used (not the
    // ClickHouse-boundary-adjusted one) so the L1 index serves the full history.
    if (
      this.l1OnlyRoutingFilter !== undefined &&
      isL1OnlyQuery({
        filter: this.l1OnlyRoutingFilter,
        ids,
        owners,
        recipients,
        tags,
        bundledIn,
      })
    ) {
      metrics.graphqlL1OnlyRoutingCounter.inc();
      this.log.debug('Routing GQL transactions query to L1-only SQLite index', {
        owners,
        recipients,
        tags,
      });
      return this.gqlQueryable.getGqlTransactions({
        pageSize,
        cursor,
        sortOrder,
        ids,
        recipients,
        owners,
        minHeight,
        maxHeight,
        bundledIn,
        tags,
        l1Only: true,
      });
    }

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
      try {
        const row = await this.clickhouseClient.query({ query: stableSql });
        const jsonRow = await row.json();
        return jsonRow.data.map((tx: any) => this.mapTransactionRow(tx));
      } catch (err) {
        // Every stable-leg Code 158 (TOO_MANY_ROWS) is recorded here — at the
        // origin, for both the recovered and the failing path — so operators can
        // audit which query shapes trip `max_rows_to_read`. The counter carries a
        // low-cardinality filter descriptor; the warn carries the concrete query
        // shape needed to reproduce it.
        if (isClickHouseTooManyRowsError(err)) {
          // Hack 5: an owner-filtered query that still trips max_rows_to_read
          // through owner_projection means a whale whose footprint exceeds the
          // cap. Re-run as an adaptive height-windowed walk instead of failing.
          //
          // Restricted to non-id queries: the windowing walk is height-ordered
          // and relies on the cursor predicate to drain a window, but id queries
          // carry no ORDER BY or cursor predicate (see addGqlTransactionFilters /
          // buildTransactionOrderBy), so the walk can't make per-window progress.
          // owner+ids only reaches the cap for whale owners (>10M footprint) — a
          // rare case left to surface the 158, no worse than before this feature.
          const willRetryWindowed =
            this.ownerProjectionApplies(owners, ids, tags) && ids.length === 0;
          metrics.clickhouseGqlTooManyRowsTotal.inc({
            filter: describeGqlFilterShape({
              ids,
              owners,
              recipients,
              bundledIn,
              tags,
            }),
            recovery: willRetryWindowed ? 'windowed' : 'none',
            id_count: bucketIdCount(ids.length),
          });
          this.log.warn(
            'ClickHouse GQL stable query tripped max_rows_to_read ' +
              '(Code 158 TOO_MANY_ROWS)',
            {
              recovery: willRetryWindowed
                ? 'adaptive-height-windowing'
                : 'none',
              maxRowsToRead: config.CLICKHOUSE_GQL_MAX_ROWS_TO_READ,
              idCount: ids.length,
              ids,
              owners,
              recipients,
              bundledIn,
              tags,
              minHeight,
              maxHeight,
              pageSize,
              sortOrder,
            },
          );
          if (willRetryWindowed) {
            return this.queryStableTransactionsWindowed({
              pageSize,
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
          }
        }
        throw err;
      }
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
    let sqliteHasNextPage = false;
    if (sqliteSettled.status === 'fulfilled') {
      sqliteEdges = sqliteSettled.value.edges;
      sqliteHasNextPage = sqliteSettled.value.pageInfo.hasNextPage;
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

    // `hasNextPage` must reflect whether any leg has rows BEYOND this page,
    // derived from each leg's RAW result before the cross-leg id-dedup above.
    // Both ClickHouse legs fetch `pageSize + 1` rows (see buildChTransactionsSql),
    // so a leg that comes back with more than `pageSize` rows has more matching
    // data to give. Relying on the deduped `edges.length > pageSize` alone
    // under-reports: when duplicate ids collapse the merged set to `pageSize` or
    // fewer — e.g. stale rows that share an `id` but differ on
    // `block_transaction_index`, which the SQL's full-key `LIMIT 1 BY` does not
    // fold — the page falsely signals completeness and every later page is
    // silently stranded. Erring toward `true` is safe: the worst case is one
    // extra page fetch that comes back empty.
    const hasNextPage =
      edges.length > pageSize ||
      stableTxs.length > pageSize ||
      unstableTxs.length > pageSize ||
      sqliteHasNextPage;

    return {
      pageInfo: {
        hasNextPage,
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
