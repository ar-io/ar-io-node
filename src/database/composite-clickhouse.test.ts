/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';

import { createTestLogger } from '../../test/test-logger.js';
import * as metrics from '../metrics.js';
import {
  GqlQueryable,
  GqlTransaction,
  GqlTransactionsResult,
} from '../types.js';
import { b64UrlToHex, hexToB64Url } from '../lib/encoding.js';
import {
  CompositeClickHouseDatabase,
  encodeTransactionGqlCursor,
} from './composite-clickhouse.js';
import { NEW_TRANSACTION_COLUMNS } from '../workers/clickhouse-streamer.js';

const log = createTestLogger({ suite: 'CompositeClickHouseDatabase' });

// Sum of the `clickhouse_gql_too_many_rows_total` counter for a given
// `recovery` label (optionally narrowed to an `id_count` bucket). Used to
// assert the 158-audit counter fires with the right recovery outcome and
// id-count bucket on the windowed and fail-fast paths.
const tooManyRowsCount = async (
  recovery: 'windowed' | 'none',
  idCount?: string,
): Promise<number> => {
  const out = await metrics.clickhouseGqlTooManyRowsTotal.get();
  return out.values
    .filter(
      (v) =>
        v.labels.recovery === recovery &&
        (idCount === undefined || v.labels.id_count === idCount),
    )
    .reduce((sum, v) => sum + v.value, 0);
};

// Canonicalize a test label into a base64url id that round-trips cleanly
// through `b64UrlToHex` / `hexToB64Url`. The composite's CH mapper goes
// through both, and a non-canonical id (one whose last char carries
// non-zero bits past the byte boundary) gets normalized — so id('stable1')
// would round-trip to 'stable0' and break id-equality checks. Producing
// an 8-char id (6 bytes, no trailing-bit ambiguity) sidesteps the issue.
function id(label: string): string {
  const padded = (label + 'AAAAAAAA').slice(0, 8);
  // Pin to canonical form via the same encoding round-trip the composite
  // uses; if the input is already canonical, this is the identity.
  return hexToB64Url(b64UrlToHex(padded));
}

// Helper to build CH-shaped row objects (post-hex / post-formatting) that
// mimic what ClickHouse returns to the composite's mapper. The composite
// expects hex-encoded ids so we honor that here.
function chRow(params: {
  id: string;
  height: number;
  blockTransactionIndex?: number;
  isDataItem?: boolean;
  indexedAt?: number;
}): Record<string, unknown> {
  const {
    id,
    height,
    blockTransactionIndex = 0,
    isDataItem = false,
    indexedAt = 1,
  } = params;
  return {
    height,
    block_transaction_index: blockTransactionIndex,
    is_data_item: isDataItem,
    id: b64UrlToHex(id),
    anchor: null,
    target: null,
    owner_address: '00',
    owner_size: null,
    owner_offset: null,
    parent_id: null,
    block_indep_hash: null,
    block_timestamp: null,
    block_previous_block: null,
    indexed_at: indexedAt,
    reward: '0',
    quantity: '0',
    data_size: '0',
    content_type: null,
    signature_size: null,
    signature_offset: null,
    signature_type: null,
    tags_count: 0,
    tags: [],
  };
}

function sqliteEdge(tx: GqlTransaction): GqlTransactionsResult['edges'][0] {
  return { cursor: encodeTransactionGqlCursor(tx), node: tx };
}

function sqliteTx(params: {
  id: string;
  height: number;
  blockTransactionIndex?: number;
  isDataItem?: boolean;
  indexedAt?: number;
}): GqlTransaction {
  const {
    id,
    height,
    blockTransactionIndex = 0,
    isDataItem = false,
    indexedAt = 1,
  } = params;
  return {
    id,
    anchor: null,
    signature: null,
    signatureType: null,
    signatureSize: null,
    signatureOffset: null,
    recipient: null,
    ownerAddress: '',
    ownerKey: null,
    ownerSize: null,
    ownerOffset: null,
    fee: '0',
    quantity: '0',
    dataSize: '0',
    contentType: null,
    blockIndepHash: null,
    blockTimestamp: null,
    height,
    blockPreviousBlock: null,
    parentId: null,
    blockTransactionIndex,
    dataItemId: isDataItem ? id : null,
    tags: [],
    indexedAt,
    isDataItem,
  };
}

// SQLite stub implementing the parts of GqlQueryable the composite needs.
// `transactions` is an array of edges that simulates a SQLite leg result;
// `reject` makes the `getGqlTransactions` call throw so the composite's
// circuit breaker observes a failure.
function makeSqliteStub(opts: {
  transactions?: GqlTransactionsResult;
  reject?: Error;
}): GqlQueryable {
  return {
    async getGqlTransactions(): Promise<GqlTransactionsResult> {
      if (opts.reject !== undefined) throw opts.reject;
      return (
        opts.transactions ?? { pageInfo: { hasNextPage: false }, edges: [] }
      );
    },
    async getGqlTransaction(): Promise<GqlTransaction | null> {
      return null;
    },
    async getGqlBlock() {
      return undefined;
    },
    async getGqlBlocks() {
      return { pageInfo: { hasNextPage: false }, edges: [] };
    },
  };
}

// Builds a composite with a stubbed CH client. `chRowsByLeg` is keyed by
// table-name substring so we can differentiate the stable
// (`FROM transactions`) and unstable (`FROM new_transactions`) queries
// the composite issues. `chReject` injects a failure on the matching leg
// to exercise the degraded-mode paths.
function buildComposite({
  sqlite,
  queryUnstableHead = false,
  skipSqliteReads = false,
  ownerProjectionRoutingEnabled = false,
  ownerProjectionEntityTypes = ['drive', 'folder', 'snapshot'],
  chRowsByLeg,
  chReject,
}: {
  sqlite: GqlQueryable;
  queryUnstableHead?: boolean;
  skipSqliteReads?: boolean;
  ownerProjectionRoutingEnabled?: boolean;
  ownerProjectionEntityTypes?: string[];
  chRowsByLeg: { stable?: any[]; unstable?: any[] };
  chReject?: { stable?: Error; unstable?: Error };
}): CompositeClickHouseDatabase {
  const composite = new CompositeClickHouseDatabase({
    log,
    gqlQueryable: sqlite,
    url: 'http://localhost:0',
    queryUnstableHead,
    skipSqliteReads,
    ownerProjectionRoutingEnabled,
    ownerProjectionEntityTypes,
    sqliteCircuitBreakerOptions: {
      // Tight breaker so a thrown error trips the breaker for this test
      // run without slowing the suite. The composite's behavior under a
      // tripped breaker is what we're verifying — not the breaker timing
      // itself.
      timeout: 1_000,
      errorThresholdPercentage: 1,
      rollingCountTimeout: 1_000,
      resetTimeout: 1_000,
    },
  });

  // Replace the live CH client (which would attempt HTTP calls) with a
  // stub that returns rows based on which table the SQL targets.
  (composite as any).clickhouseClient = {
    async query({ query: sql }: { query: string }) {
      const isUnstable = sql.includes('FROM new_transactions');
      const isStable = !isUnstable && sql.includes('FROM transactions');
      if (isUnstable && chReject?.unstable !== undefined) {
        throw chReject.unstable;
      }
      if (isStable && chReject?.stable !== undefined) {
        throw chReject.stable;
      }
      const rows = isUnstable
        ? (chRowsByLeg.unstable ?? [])
        : (chRowsByLeg.stable ?? []);
      return { json: async () => ({ data: rows }) };
    },
  };

  return composite;
}

describe('CompositeClickHouseDatabase', () => {
  let sqlite: GqlQueryable;

  beforeEach(() => {
    sqlite = makeSqliteStub({});
  });

  describe('three-leg merge', () => {
    it('merges stable + unstable + sqlite into a single sorted page', async () => {
      sqlite = makeSqliteStub({
        transactions: {
          pageInfo: { hasNextPage: false },
          edges: [sqliteEdge(sqliteTx({ id: id('sqliteOnly'), height: 102 }))],
        },
      });
      const composite = buildComposite({
        sqlite,
        queryUnstableHead: true,
        chRowsByLeg: {
          stable: [chRow({ id: id('stable1'), height: 100 })],
          unstable: [chRow({ id: id('unstable1'), height: 101 })],
        },
      });

      const result = await composite.getGqlTransactions({
        pageSize: 10,
        sortOrder: 'HEIGHT_ASC',
      });

      assert.equal(result.edges.length, 3);
      assert.deepEqual(
        result.edges.map((e) => e.node.id),
        [id('stable1'), id('unstable1'), id('sqliteOnly')],
      );
      assert.equal(result.pageInfo.hasNextPage, false);
    });

    it('dedupes by id with stable winning over unstable', async () => {
      const composite = buildComposite({
        sqlite,
        queryUnstableHead: true,
        chRowsByLeg: {
          // Stable's height is the authoritative one (102); unstable
          // has the same id but a stale denormalized height (101). We
          // assert stable's value wins.
          stable: [chRow({ id: id('shared'), height: 102, indexedAt: 999 })],
          unstable: [chRow({ id: id('shared'), height: 101, indexedAt: 1 })],
        },
      });

      const result = await composite.getGqlTransactions({ pageSize: 10 });

      assert.equal(result.edges.length, 1);
      assert.equal(result.edges[0].node.id, id('shared'));
      assert.equal(result.edges[0].node.height, 102);
      assert.equal(result.edges[0].node.indexedAt, 999);
    });

    it('dedupes by id with unstable winning over sqlite', async () => {
      sqlite = makeSqliteStub({
        transactions: {
          pageInfo: { hasNextPage: false },
          edges: [sqliteEdge(sqliteTx({ id: id('shared'), height: 50 }))],
        },
      });
      const composite = buildComposite({
        sqlite,
        queryUnstableHead: true,
        chRowsByLeg: {
          stable: [],
          unstable: [chRow({ id: id('shared'), height: 200 })],
        },
      });

      const result = await composite.getGqlTransactions({ pageSize: 10 });

      assert.equal(result.edges.length, 1);
      assert.equal(result.edges[0].node.height, 200);
    });

    it('handles same id on all three legs (stable wins)', async () => {
      sqlite = makeSqliteStub({
        transactions: {
          pageInfo: { hasNextPage: false },
          edges: [sqliteEdge(sqliteTx({ id: id('shared'), height: 1 }))],
        },
      });
      const composite = buildComposite({
        sqlite,
        queryUnstableHead: true,
        chRowsByLeg: {
          stable: [chRow({ id: id('shared'), height: 100 })],
          unstable: [chRow({ id: id('shared'), height: 50 })],
        },
      });

      const result = await composite.getGqlTransactions({ pageSize: 10 });

      assert.equal(result.edges.length, 1);
      assert.equal(result.edges[0].node.height, 100);
    });
  });

  describe('sort order', () => {
    it('sorts HEIGHT_DESC by default', async () => {
      const composite = buildComposite({
        sqlite,
        queryUnstableHead: true,
        chRowsByLeg: {
          stable: [
            chRow({ id: id('low'), height: 10 }),
            chRow({ id: id('high'), height: 100 }),
          ],
          unstable: [chRow({ id: id('mid'), height: 50 })],
        },
      });

      const result = await composite.getGqlTransactions({ pageSize: 10 });
      assert.deepEqual(
        result.edges.map((e) => e.node.id),
        [id('high'), id('mid'), id('low')],
      );
    });

    it('sorts HEIGHT_ASC when requested', async () => {
      const composite = buildComposite({
        sqlite,
        queryUnstableHead: true,
        chRowsByLeg: {
          stable: [
            chRow({ id: id('low'), height: 10 }),
            chRow({ id: id('high'), height: 100 }),
          ],
          unstable: [chRow({ id: id('mid'), height: 50 })],
        },
      });

      const result = await composite.getGqlTransactions({
        pageSize: 10,
        sortOrder: 'HEIGHT_ASC',
      });
      assert.deepEqual(
        result.edges.map((e) => e.node.id),
        [id('low'), id('mid'), id('high')],
      );
    });
  });

  describe('hasNextPage', () => {
    it('is true when combined results exceed pageSize', async () => {
      const composite = buildComposite({
        sqlite,
        queryUnstableHead: true,
        chRowsByLeg: {
          stable: [
            chRow({ id: id('s1'), height: 1 }),
            chRow({ id: id('s2'), height: 2 }),
          ],
          unstable: [chRow({ id: id('u1'), height: 3 })],
        },
      });

      const result = await composite.getGqlTransactions({ pageSize: 2 });
      assert.equal(result.pageInfo.hasNextPage, true);
      assert.equal(result.edges.length, 2);
    });

    it('is false when all legs are exhausted', async () => {
      const composite = buildComposite({
        sqlite,
        queryUnstableHead: true,
        chRowsByLeg: {
          stable: [chRow({ id: id('s1'), height: 1 })],
          unstable: [chRow({ id: id('u1'), height: 2 })],
        },
      });

      const result = await composite.getGqlTransactions({ pageSize: 10 });
      assert.equal(result.pageInfo.hasNextPage, false);
    });

    it('counts cross-leg duplicates only once for hasNextPage', async () => {
      // Two unique ids ('a' duped across legs, 'b' on stable only).
      // pageSize=2 should fit both — hasNextPage MUST be false even
      // though the pre-dedup edge count was 3.
      const composite = buildComposite({
        sqlite,
        queryUnstableHead: true,
        chRowsByLeg: {
          stable: [
            chRow({ id: id('a'), height: 1 }),
            chRow({ id: id('b'), height: 2 }),
          ],
          unstable: [chRow({ id: id('a'), height: 1 })],
        },
      });

      const result = await composite.getGqlTransactions({ pageSize: 2 });
      assert.equal(result.edges.length, 2);
      assert.equal(result.pageInfo.hasNextPage, false);
    });

    it('is true when a full leg collapses to pageSize after id-dedup (PE-9124)', async () => {
      // A single leg returns its full `pageSize + 1` rows, but a stale
      // duplicate (same id, different block_transaction_index — the SQL's
      // full-key `LIMIT 1 BY` does not fold it) collapses the deduped set to
      // exactly `pageSize`. hasNextPage MUST stay true: the leg came back full,
      // so more matching rows exist beyond this page. Counting deduped edges
      // alone would report `2 > 2 == false` and silently strand every later
      // page.
      const composite = buildComposite({
        sqlite,
        chRowsByLeg: {
          stable: [
            chRow({
              id: id('dupitem'),
              height: 1,
              blockTransactionIndex: 0,
              isDataItem: true,
            }),
            chRow({
              id: id('dupitem'),
              height: 1,
              blockTransactionIndex: 12,
              isDataItem: true,
            }),
            chRow({ id: id('itemb'), height: 2 }),
          ],
        },
      });

      const result = await composite.getGqlTransactions({
        pageSize: 2,
        sortOrder: 'HEIGHT_ASC',
      });
      assert.equal(result.edges.length, 2);
      assert.deepEqual(
        result.edges.map((e) => e.node.id),
        [id('dupitem'), id('itemb')],
      );
      assert.equal(result.pageInfo.hasNextPage, true);
    });
  });

  describe('SQLite fallback behavior', () => {
    it('returns CH-only with PARTIAL_RESULT warning when SQLite breaker rejects', async () => {
      sqlite = makeSqliteStub({ reject: new Error('sqlite down') });
      const composite = buildComposite({
        sqlite,
        queryUnstableHead: true,
        chRowsByLeg: {
          stable: [chRow({ id: id('stable1'), height: 100 })],
          unstable: [chRow({ id: id('unstable1'), height: 101 })],
        },
      });

      const result = await composite.getGqlTransactions({ pageSize: 10 });
      assert.equal(result.edges.length, 2);
      assert.ok(result.warnings !== undefined);
      assert.ok(
        result.warnings!.some(
          (w) => w.code === 'PARTIAL_RESULT' && w.message.includes('sqlite'),
        ),
      );
    });

    it('does not query SQLite when skipSqliteReads=true', async () => {
      let sqliteCalled = false;
      sqlite = {
        async getGqlTransactions() {
          sqliteCalled = true;
          return { pageInfo: { hasNextPage: false }, edges: [] };
        },
        async getGqlTransaction() {
          return null;
        },
        async getGqlBlock() {
          return undefined;
        },
        async getGqlBlocks() {
          return { pageInfo: { hasNextPage: false }, edges: [] };
        },
      };
      const composite = buildComposite({
        sqlite,
        queryUnstableHead: true,
        skipSqliteReads: true,
        chRowsByLeg: {
          stable: [chRow({ id: id('stable1'), height: 100 })],
        },
      });

      const result = await composite.getGqlTransactions({ pageSize: 10 });
      assert.equal(sqliteCalled, false);
      assert.equal(result.edges.length, 1);
      assert.equal(result.warnings, undefined);
    });
  });

  describe('owner-window fallback (hack 5)', () => {
    it('retries an owner-filtered query with height-windowing on Code 158', async () => {
      const composite = buildComposite({
        sqlite,
        ownerProjectionRoutingEnabled: true,
        chRowsByLeg: {},
      });

      const queries: string[] = [];
      let stableCalls = 0;
      (composite as any).clickhouseClient = {
        async query({ query: sqlStr }: { query: string }) {
          queries.push(sqlStr);
          if (sqlStr.includes('FROM new_transactions')) {
            return { json: async () => ({ data: [] }) };
          }
          // Stable leg. First call is the single-shot query, which we make
          // trip max_rows_to_read; later calls are the windowed retries.
          stableCalls += 1;
          if (stableCalls === 1) {
            const err: any = new Error(
              'Code: 158. DB::Exception: Limit for rows exceeded: TOO_MANY_ROWS',
            );
            err.code = '158';
            throw err;
          }
          return {
            json: async () => ({
              data: [
                chRow({ id: id('w1'), height: 95000 }),
                chRow({ id: id('w2'), height: 94000 }),
                chRow({ id: id('w3'), height: 93000 }),
              ],
            }),
          };
        },
      };

      const beforeWindowed = await tooManyRowsCount('windowed');
      const result = await composite.getGqlTransactions({
        pageSize: 2,
        owners: [id('owner')],
        tags: [{ name: 'Entity-Type', values: ['drive'] }],
        maxHeight: 100_000,
      });

      // The 158 audit counter fires with recovery=windowed for the recovered
      // (owner-projection) path.
      assert.equal(
        (await tooManyRowsCount('windowed')) - beforeWindowed,
        1,
        'expected clickhouse_gql_too_many_rows_total{recovery="windowed"} to increment',
      );
      // The single-shot threw 158, then at least one windowed retry ran.
      assert.ok(
        stableCalls >= 2,
        `expected a windowed retry after Code 158, saw ${stableCalls} stable calls`,
      );
      // Owner queries route through owner_projection (read-in-order disabled).
      assert.ok(
        queries.some((q) => q.includes('optimize_read_in_order = 0')),
        'expected owner-projection settings on the stable query',
      );
      // The retry is height-bounded (a window); the single-shot is not.
      const windowSql = queries[1];
      assert.ok(
        windowSql !== undefined && windowSql.includes('FROM transactions'),
        'expected a windowed retry query',
      );
      assert.match(windowSql, />=\s*\d/);
      assert.doesNotMatch(queries[0], />=\s*\d/);
      // Page is filled from the window; hasNextPage reflects the extra row.
      assert.equal(result.edges.length, 2);
      assert.equal(result.pageInfo.hasNextPage, true);
    });

    it('does not window a non-owner query on Code 158 (fail-fast)', async () => {
      const composite = buildComposite({
        sqlite,
        ownerProjectionRoutingEnabled: true,
        chRowsByLeg: {},
      });
      let stableCalls = 0;
      (composite as any).clickhouseClient = {
        async query({ query: sqlStr }: { query: string }) {
          if (sqlStr.includes('FROM new_transactions')) {
            return { json: async () => ({ data: [] }) };
          }
          stableCalls += 1;
          const err: any = new Error('Code: 158. TOO_MANY_ROWS');
          err.code = '158';
          throw err;
        },
      };

      const beforeNone = await tooManyRowsCount('none');
      await assert.rejects(
        composite.getGqlTransactions({
          pageSize: 2,
          tags: [{ name: 'Entity-Type', values: ['drive'] }],
        }),
        /158|TOO_MANY_ROWS/,
      );
      // No windowing retries for a tag-only (ownerless) query.
      assert.equal(stableCalls, 1);
      // The 158 audit counter fires with recovery=none for the fail-fast path,
      // even though the error still surfaces to the caller.
      assert.equal(
        (await tooManyRowsCount('none')) - beforeNone,
        1,
        'expected clickhouse_gql_too_many_rows_total{recovery="none"} to increment',
      );
    });

    it('buckets id-count on the 158 counter for a multi-id fail-fast query', async () => {
      const composite = buildComposite({
        sqlite,
        ownerProjectionRoutingEnabled: true,
        chRowsByLeg: {},
      });
      (composite as any).clickhouseClient = {
        async query({ query: sqlStr }: { query: string }) {
          if (sqlStr.includes('FROM new_transactions')) {
            return { json: async () => ({ data: [] }) };
          }
          const err: any = new Error('Code: 158. TOO_MANY_ROWS');
          err.code = '158';
          throw err;
        },
      };

      // 4 ids → the `3-5` bucket. Ids-only (no owner) → fail-fast (recovery=none).
      const before = await tooManyRowsCount('none', '3-5');
      await assert.rejects(
        composite.getGqlTransactions({
          pageSize: 2,
          ids: [id('a'), id('b'), id('c'), id('d')],
          tags: [],
        }),
        /158|TOO_MANY_ROWS/,
      );
      assert.equal(
        (await tooManyRowsCount('none', '3-5')) - before,
        1,
        'expected the 158 counter to increment with id_count="3-5"',
      );
    });

    it('does not window when the feature is disabled (default)', async () => {
      const composite = buildComposite({ sqlite, chRowsByLeg: {} });
      const queries: string[] = [];
      let stableCalls = 0;
      (composite as any).clickhouseClient = {
        async query({ query: sqlStr }: { query: string }) {
          queries.push(sqlStr);
          if (sqlStr.includes('FROM new_transactions')) {
            return { json: async () => ({ data: [] }) };
          }
          stableCalls += 1;
          const err: any = new Error('Code: 158. TOO_MANY_ROWS');
          err.code = '158';
          throw err;
        },
      };

      await assert.rejects(
        composite.getGqlTransactions({
          pageSize: 2,
          owners: [id('owner')],
          tags: [{ name: 'Entity-Type', values: ['drive'] }],
        }),
        /158|TOO_MANY_ROWS/,
      );
      // Disabled: single-shot fails fast, no windowing, and the query plans
      // exactly as before (projections disabled for the tag filter).
      assert.equal(stableCalls, 1);
      assert.ok(
        queries.some((q) => q.includes('optimize_use_projections = 0')),
      );
      assert.ok(!queries.some((q) => q.includes('optimize_read_in_order = 0')));
    });

    it('excludes Entity-Type=file from the feature (allowlist)', async () => {
      const composite = buildComposite({
        sqlite,
        ownerProjectionRoutingEnabled: true,
        chRowsByLeg: {},
      });
      const queries: string[] = [];
      let stableCalls = 0;
      (composite as any).clickhouseClient = {
        async query({ query: sqlStr }: { query: string }) {
          queries.push(sqlStr);
          if (sqlStr.includes('FROM new_transactions')) {
            return { json: async () => ({ data: [] }) };
          }
          stableCalls += 1;
          const err: any = new Error('Code: 158. TOO_MANY_ROWS');
          err.code = '158';
          throw err;
        },
      };

      await assert.rejects(
        composite.getGqlTransactions({
          pageSize: 2,
          owners: [id('owner')],
          tags: [{ name: 'Entity-Type', values: ['file'] }],
        }),
        /158|TOO_MANY_ROWS/,
      );
      // `file` is not in the allowlist: no projection routing, no windowing —
      // the query plans exactly as it does without the feature.
      assert.equal(stableCalls, 1);
      assert.ok(
        queries.some((q) => q.includes('optimize_use_projections = 0')),
      );
      assert.ok(!queries.some((q) => q.includes('optimize_read_in_order = 0')));
    });

    it('excludes owner + Entity-Type + another tag (owner+other-tag)', async () => {
      const composite = buildComposite({
        sqlite,
        ownerProjectionRoutingEnabled: true,
        chRowsByLeg: {},
      });
      const queries: string[] = [];
      let stableCalls = 0;
      (composite as any).clickhouseClient = {
        async query({ query: sqlStr }: { query: string }) {
          queries.push(sqlStr);
          if (sqlStr.includes('FROM new_transactions')) {
            return { json: async () => ({ data: [] }) };
          }
          stableCalls += 1;
          const err: any = new Error('Code: 158. TOO_MANY_ROWS');
          err.code = '158';
          throw err;
        },
      };

      await assert.rejects(
        composite.getGqlTransactions({
          pageSize: 2,
          owners: [id('owner')],
          tags: [
            { name: 'Entity-Type', values: ['drive'] },
            { name: 'App-Name', values: ['ArDrive'] },
          ],
        }),
        /158|TOO_MANY_ROWS/,
      );
      // An extra non-Entity-Type tag disqualifies the query: no projection
      // settings, no windowing — it plans as it would without the feature.
      assert.equal(stableCalls, 1);
      assert.ok(
        queries.some((q) => q.includes('optimize_use_projections = 0')),
      );
      assert.ok(!queries.some((q) => q.includes('optimize_read_in_order = 0')));
    });

    it('routes owner + ids through the projection', async () => {
      const composite = buildComposite({
        sqlite,
        ownerProjectionRoutingEnabled: true,
        chRowsByLeg: {},
      });
      const queries: string[] = [];
      (composite as any).clickhouseClient = {
        async query({ query: sqlStr }: { query: string }) {
          queries.push(sqlStr);
          if (sqlStr.includes('FROM new_transactions')) {
            return { json: async () => ({ data: [] }) };
          }
          return {
            json: async () => ({
              data: [
                chRow({ id: id('a'), height: 100 }),
                chRow({ id: id('b'), height: 99 }),
              ],
            }),
          };
        },
      };

      const result = await composite.getGqlTransactions({
        pageSize: 100,
        owners: [id('owner')],
        ids: [id('a'), id('b'), id('c')],
      });

      // owner+ids is bounded by the id list, so it routes through the
      // projection regardless of tags (no Entity-Type allowlist gate).
      const stableQ = queries.find((q) => q.includes('FROM transactions'));
      assert.ok(
        stableQ !== undefined &&
          stableQ.includes('optimize_use_projections = 1'),
        'owner+ids should route through the projection',
      );
      assert.equal(result.edges.length, 2);
    });

    it('does not window owner+ids on 158 (fails fast)', async () => {
      const composite = buildComposite({
        sqlite,
        ownerProjectionRoutingEnabled: true,
        chRowsByLeg: {},
      });
      let stableCalls = 0;
      (composite as any).clickhouseClient = {
        async query({ query: sqlStr }: { query: string }) {
          if (sqlStr.includes('FROM new_transactions')) {
            return { json: async () => ({ data: [] }) };
          }
          stableCalls += 1;
          const err: any = new Error('Code: 158. TOO_MANY_ROWS');
          err.code = '158';
          throw err;
        },
      };

      await assert.rejects(
        composite.getGqlTransactions({
          pageSize: 100,
          owners: [id('owner')],
          ids: [id('a'), id('b')],
        }),
        /158|TOO_MANY_ROWS/,
      );
      // Height-windowing is height-ordered and needs a cursor predicate, which
      // id queries don't carry — so owner+ids does NOT window; the 158 surfaces.
      assert.equal(stableCalls, 1);
    });

    it('does not route ids without an owner', async () => {
      const composite = buildComposite({
        sqlite,
        ownerProjectionRoutingEnabled: true,
        chRowsByLeg: {},
      });
      const queries: string[] = [];
      (composite as any).clickhouseClient = {
        async query({ query: sqlStr }: { query: string }) {
          queries.push(sqlStr);
          return { json: async () => ({ data: [] }) };
        },
      };

      await composite.getGqlTransactions({
        pageSize: 100,
        ids: [id('a'), id('b')],
      });

      // Ownerless id queries have nothing to seek on — they stay on the
      // id_bloom main-table path (projections off), unchanged by the feature.
      const stableQ = queries.find((q) => q.includes('FROM transactions'));
      assert.ok(
        stableQ !== undefined &&
          stableQ.includes('optimize_use_projections = 0'),
        'ids without an owner should use the id_bloom main-table path',
      );
      assert.ok(!queries.some((q) => q.includes('optimize_read_in_order = 0')));
    });

    it('drains a dense window via cursor instead of stranding rows', async () => {
      const composite = buildComposite({
        sqlite,
        ownerProjectionRoutingEnabled: true,
        chRowsByLeg: {},
      });
      const queries: string[] = [];
      let stableCalls = 0;
      (composite as any).clickhouseClient = {
        async query({ query: sqlStr }: { query: string }) {
          queries.push(sqlStr);
          if (sqlStr.includes('FROM new_transactions')) {
            return { json: async () => ({ data: [] }) };
          }
          stableCalls += 1;
          if (stableCalls === 1) {
            const err: any = new Error('Code: 158. TOO_MANY_ROWS');
            err.code = '158';
            throw err;
          }
          if (stableCalls === 2) {
            // A full target-sized batch (pageSize + 1 = 3) whose dedup leaves
            // only 2 distinct ids — the old code advanced past the window here,
            // stranding the rows below.
            return {
              json: async () => ({
                data: [
                  chRow({
                    id: id('p'),
                    height: 95000,
                    blockTransactionIndex: 0,
                  }),
                  chRow({
                    id: id('p'),
                    height: 95000,
                    blockTransactionIndex: 1,
                  }),
                  chRow({ id: id('q'), height: 94000 }),
                ],
              }),
            };
          }
          // Continuation within the SAME window, below the advanced cursor.
          return {
            json: async () => ({
              data: [
                chRow({ id: id('r'), height: 93000 }),
                chRow({ id: id('s'), height: 92000 }),
              ],
            }),
          };
        },
      };

      const result = await composite.getGqlTransactions({
        pageSize: 2,
        owners: [id('owner')],
        tags: [{ name: 'Entity-Type', values: ['drive'] }],
        maxHeight: 100000,
      });

      // The dense first window forced a cursor-driven continuation (>=3 stable
      // calls), and the continuation resumed BELOW the prior batch's last row
      // (height 94000) rather than jumping to a fresh window — so the rows that
      // would otherwise be stranded stay reachable.
      assert.ok(stableCalls >= 3, `expected continuation, saw ${stableCalls}`);
      const stableQs = queries.filter((q) => q.includes('FROM transactions'));
      assert.ok(
        stableQs.slice(1).some((q) => q.includes('94000')),
        'expected a continuation query carrying the advanced cursor (94000)',
      );
      assert.equal(result.edges.length, 2);
      assert.equal(result.pageInfo.hasNextPage, true);
    });
  });

  describe('streaming-disabled (queryUnstableHead=false)', () => {
    it('does not query the unstable leg', async () => {
      let unstableQueried = false;
      const composite = new CompositeClickHouseDatabase({
        log,
        gqlQueryable: sqlite,
        url: 'http://localhost:0',
        queryUnstableHead: false,
      });
      (composite as any).clickhouseClient = {
        async query({ query: sql }: { query: string }) {
          if (sql.includes('FROM new_transactions')) {
            unstableQueried = true;
          }
          return { json: async () => ({ data: [] }) };
        },
      };

      await composite.getGqlTransactions({ pageSize: 10 });
      assert.equal(unstableQueried, false);
    });
  });

  describe('streamer regressions', () => {
    it('includes inserted_at in new_transactions INSERT columns', () => {
      // Without this column in the INSERT list the streamer's bulk inserts
      // ship with `inserted_at = 0` (epoch), and the table's TTL of
      // `inserted_at + INTERVAL N MINUTE` immediately puts every row past
      // its expiry — a background merge then drops them silently. Caught
      // end-to-end during smoke testing on 2026-05-01.
      assert.ok(NEW_TRANSACTION_COLUMNS.includes('inserted_at'));
    });
  });

  describe('PARTIAL_RESULT for unstable leg failure', () => {
    it('warns + degrades when the unstable CH leg rejects', async () => {
      const composite = buildComposite({
        sqlite,
        queryUnstableHead: true,
        chRowsByLeg: {
          stable: [chRow({ id: id('stable1'), height: 100 })],
          unstable: [],
        },
        chReject: { unstable: new Error('unstable boom') },
      });

      const result = await composite.getGqlTransactions({ pageSize: 10 });
      assert.equal(result.edges.length, 1);
      assert.equal(result.edges[0].node.id, id('stable1'));
      assert.ok(result.warnings !== undefined);
      assert.ok(
        result.warnings!.some(
          (w) =>
            w.code === 'PARTIAL_RESULT' &&
            w.message.includes('clickhouse unstable'),
        ),
      );
    });
  });
});
