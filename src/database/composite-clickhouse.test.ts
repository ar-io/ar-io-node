/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';

import { createTestLogger } from '../../test/test-logger.js';
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
  chRowsByLeg,
  chReject,
}: {
  sqlite: GqlQueryable;
  queryUnstableHead?: boolean;
  skipSqliteReads?: boolean;
  chRowsByLeg: { stable?: any[]; unstable?: any[] };
  chReject?: { stable?: Error; unstable?: Error };
}): CompositeClickHouseDatabase {
  const composite = new CompositeClickHouseDatabase({
    log,
    gqlQueryable: sqlite,
    url: 'http://localhost:0',
    queryUnstableHead,
    skipSqliteReads,
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
