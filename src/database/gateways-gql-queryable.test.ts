/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import axios from 'axios';
import { OperationDefinitionNode, SelectionSetNode, parse } from 'graphql';

import { createTestLogger } from '../../test/test-logger.js';
import {
  GqlBlock,
  GqlBlocksResult,
  GqlQueryable,
  GqlTransaction,
  GqlTransactionsResult,
} from '../types.js';
import { fromB64Url } from '../lib/encoding.js';
import {
  decodeTransactionGqlCursor,
  encodeBlockGqlCursor,
  encodeTransactionGqlCursor,
} from './standalone-sqlite.js';
import {
  GatewaysGqlQueryable,
  __test as fanoutInternals,
} from './gateways-gql-queryable.js';

function nodeSelection(query: string): SelectionSetNode {
  const doc = parse(query);
  const op = doc.definitions.find((d) => d.kind === 'OperationDefinition') as
    | OperationDefinitionNode
    | undefined;
  if (op === undefined) throw new Error('no operation definition in query');
  const field = op.selectionSet.selections.find(
    (s) => s.kind === 'Field' && s.name.value === 'transactions',
  ) as { selectionSet: SelectionSetNode };
  const edges = field.selectionSet.selections.find(
    (s) => s.kind === 'Field' && s.name.value === 'edges',
  ) as { selectionSet: SelectionSetNode };
  const node = edges.selectionSet.selections.find(
    (s) => s.kind === 'Field' && s.name.value === 'node',
  ) as { selectionSet: SelectionSetNode };
  return node.selectionSet;
}

function canon(s: string | undefined): string | undefined {
  return s?.replace(/\s+/g, ' ').trim();
}

const log = createTestLogger({ suite: 'GatewaysGqlQueryable' });

function txAt(params: {
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
    indexedAt = 0,
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
    dataItemId: isDataItem ? id : 'AA',
    tags: [],
    indexedAt,
    isDataItem,
  };
}

function cursorFor(tx: GqlTransaction): string {
  return encodeTransactionGqlCursor({
    height: tx.height,
    blockTransactionIndex: tx.blockTransactionIndex,
    dataItemId: tx.dataItemId,
    id: tx.id,
    indexedAt: tx.indexedAt,
  });
}

function blockCursorFor(b: GqlBlock): string {
  return encodeBlockGqlCursor({ height: b.height });
}

class FakeQueryable implements GqlQueryable {
  constructor(
    private readonly data: {
      transactions?: GqlTransaction[];
      blocks?: GqlBlock[];
      throws?: Error;
    },
  ) {}

  async getGqlTransaction({
    id,
  }: {
    id: string;
  }): Promise<GqlTransaction | null> {
    if (this.data.throws) throw this.data.throws;
    return this.data.transactions?.find((t) => t.id === id) ?? null;
  }

  async getGqlTransactions(args: {
    pageSize: number;
    cursor?: string;
    sortOrder?: 'HEIGHT_DESC' | 'HEIGHT_ASC';
  }): Promise<GqlTransactionsResult> {
    if (this.data.throws) throw this.data.throws;
    const all = this.data.transactions ?? [];
    const sign = args.sortOrder === 'HEIGHT_ASC' ? 1 : -1;
    // Sort exactly like SQL/ClickHouse: (height, bti, data_item_id,
    // indexed_at, id), all in the same direction. id and data_item_id are
    // sorted as raw bytes (BLOB), so decode before comparing.
    const compareBySortKey = (
      a: {
        height: number | null;
        blockTransactionIndex: number;
        dataItemId: string | null;
        indexedAt: number;
        id: string;
      },
      b: {
        height: number | null;
        blockTransactionIndex: number;
        dataItemId: string | null;
        indexedAt: number;
        id: string;
      },
    ): number => {
      const hDiff = (a.height ?? 0) - (b.height ?? 0);
      if (hDiff) return sign * Math.sign(hDiff);
      const btiDiff = a.blockTransactionIndex - b.blockTransactionIndex;
      if (btiDiff) return sign * Math.sign(btiDiff);
      const diCmp = Buffer.compare(
        fromB64Url(a.dataItemId ?? ''),
        fromB64Url(b.dataItemId ?? ''),
      );
      if (diCmp) return sign * diCmp;
      const iaDiff = a.indexedAt - b.indexedAt;
      if (iaDiff) return sign * Math.sign(iaDiff);
      return sign * Buffer.compare(fromB64Url(a.id), fromB64Url(b.id));
    };
    const sorted = [...all].sort(compareBySortKey);
    let startIndex = 0;
    if (args.cursor !== undefined) {
      // The cursor is a full sort-key tuple, not just an id. Skip all rows
      // whose sort key is <= the cursor, matching SQL's lex compare.
      const decoded = decodeTransactionGqlCursor(args.cursor);
      const cursorKey = {
        height: decoded.height,
        blockTransactionIndex: decoded.blockTransactionIndex ?? 0,
        dataItemId: decoded.dataItemId ?? 'AA',
        indexedAt: decoded.indexedAt ?? 0,
        id: decoded.id ?? '',
      };
      startIndex = sorted.findIndex((t) => compareBySortKey(t, cursorKey) > 0);
      if (startIndex < 0) startIndex = sorted.length;
    }
    const page = sorted.slice(startIndex, startIndex + args.pageSize);
    return {
      pageInfo: {
        hasNextPage: sorted.length > startIndex + args.pageSize,
      },
      edges: page.map((tx) => ({ cursor: cursorFor(tx), node: tx })),
    };
  }

  async getGqlBlock({ id }: { id: string }): Promise<GqlBlock | undefined> {
    if (this.data.throws) throw this.data.throws;
    return this.data.blocks?.find((b) => b.id === id);
  }

  async getGqlBlocks(args: {
    pageSize: number;
    sortOrder?: 'HEIGHT_DESC' | 'HEIGHT_ASC';
  }): Promise<GqlBlocksResult> {
    if (this.data.throws) throw this.data.throws;
    const all = this.data.blocks ?? [];
    const sorted = [...all].sort((a, b) =>
      args.sortOrder === 'HEIGHT_ASC'
        ? a.height - b.height
        : b.height - a.height,
    );
    const page = sorted.slice(0, args.pageSize);
    return {
      pageInfo: { hasNextPage: sorted.length > args.pageSize },
      edges: page.map((b) => ({ cursor: blockCursorFor(b), node: b })),
    };
  }
}

function makeMerger(sources: GqlQueryable[]): GatewaysGqlQueryable {
  return GatewaysGqlQueryable.forTesting({ log, sources });
}

// Axios adapter that lets a test control the next response or error and
// count how many requests actually reached the transport.
function makeControlledAxios() {
  let callCount = 0;
  let mode: 'ok' | 'error' = 'error';
  let okPayload: unknown = { data: {} };
  const instance = axios.create({
    adapter: async (cfg) => {
      callCount++;
      if (mode === 'error') throw new Error('boom');
      return {
        data: okPayload,
        status: 200,
        statusText: 'OK',
        headers: {},
        config: cfg,
      } as any;
    },
  });
  return {
    instance,
    getCallCount: () => callCount,
    setMode: (m: 'ok' | 'error', payload?: unknown) => {
      mode = m;
      if (payload !== undefined) okPayload = payload;
    },
  };
}

describe('renderTransactionNodeSelection', () => {
  const render = fanoutInternals.renderTransactionNodeSelection;

  it('renders a minimal selection unchanged', () => {
    const sel = nodeSelection(`{ transactions { edges { node { id } } } }`);
    assert.equal(canon(render(sel)), 'id');
  });

  it('injects id at the top level when absent', () => {
    const sel = nodeSelection(
      `{ transactions { edges { node { anchor signature } } } }`,
    );
    assert.equal(canon(render(sel)), 'id anchor signature');
  });

  it('preserves nested sub-selections without injecting id inside them', () => {
    const sel = nodeSelection(
      `{ transactions { edges { node { id block { height } owner { address } } } } }`,
    );
    // Nested types like Owner have no `id` field; injecting one would cause a
    // schema validation 400 at the upstream.
    assert.equal(canon(render(sel)), 'id block { height } owner { address }');
  });

  it('dedupes repeated top-level selections of the same field', () => {
    const sel = nodeSelection(
      `{ transactions { edges { node { id anchor anchor } } } }`,
    );
    assert.equal(canon(render(sel)), 'id anchor');
  });

  it('falls back to undefined when encountering fragment spreads', () => {
    const sel = nodeSelection(
      `fragment F on Transaction { id }
       { transactions { edges { node { ...F } } } }`,
    );
    assert.equal(render(sel), undefined);
  });
});

describe('resolveNodeFields', () => {
  it('returns the default field list when no selection is provided', () => {
    assert.equal(
      fanoutInternals.resolveNodeFields(undefined),
      fanoutInternals.DEFAULT_TRANSACTION_NODE_FIELDS,
    );
  });

  it('falls back to default when rendering bails out', () => {
    const sel = nodeSelection(
      `fragment F on Transaction { id }
       { transactions { edges { node { ...F } } } }`,
    );
    assert.equal(
      fanoutInternals.resolveNodeFields(sel),
      fanoutInternals.DEFAULT_TRANSACTION_NODE_FIELDS,
    );
  });
});

describe('GatewaysGqlQueryable', () => {
  describe('constructor', () => {
    it('throws when no urls and no localGqlQueryable', () => {
      assert.throws(() => new GatewaysGqlQueryable({ log, urls: [] }));
    });

    it('accepts only a local source', () => {
      const merger = new GatewaysGqlQueryable({
        log,
        urls: [],
        localGqlQueryable: new FakeQueryable({}),
      });
      assert.equal(merger instanceof GatewaysGqlQueryable, true);
    });
  });

  describe('getGqlTransaction (single record)', () => {
    it('returns the first non-null result', async () => {
      const tx = txAt({ id: 'a', height: 10 });
      const merger = makeMerger([
        new FakeQueryable({ transactions: [] }),
        new FakeQueryable({ transactions: [tx] }),
      ]);
      const result = await merger.getGqlTransaction({ id: 'a' });
      assert.equal(result?.id, 'a');
    });

    it('returns null when no source has the transaction', async () => {
      const merger = makeMerger([new FakeQueryable({}), new FakeQueryable({})]);
      assert.equal(await merger.getGqlTransaction({ id: 'x' }), null);
    });

    it('tolerates a failing source', async () => {
      const tx = txAt({ id: 'a', height: 10 });
      const merger = makeMerger([
        new FakeQueryable({ throws: new Error('boom') }),
        new FakeQueryable({ transactions: [tx] }),
      ]);
      assert.equal((await merger.getGqlTransaction({ id: 'a' }))?.id, 'a');
    });

    it('fails when every source fails', async () => {
      const merger = makeMerger([
        new FakeQueryable({ throws: new Error('a') }),
        new FakeQueryable({ throws: new Error('b') }),
      ]);
      await assert.rejects(() => merger.getGqlTransaction({ id: 'a' }));
    });
  });

  describe('getGqlTransactions (connection merge)', () => {
    it('merges disjoint ranges in HEIGHT_DESC order', async () => {
      const aTxs = [
        txAt({ id: 'a1', height: 100, blockTransactionIndex: 0 }),
        txAt({ id: 'a2', height: 99, blockTransactionIndex: 0 }),
      ];
      const bTxs = [
        txAt({ id: 'b1', height: 50, blockTransactionIndex: 0 }),
        txAt({ id: 'b2', height: 49, blockTransactionIndex: 0 }),
      ];
      const merger = makeMerger([
        new FakeQueryable({ transactions: aTxs }),
        new FakeQueryable({ transactions: bTxs }),
      ]);
      const result = await merger.getGqlTransactions({
        pageSize: 10,
        sortOrder: 'HEIGHT_DESC',
        tags: [],
      });
      assert.deepEqual(
        result.edges.map((e) => e.node.id),
        ['a1', 'a2', 'b1', 'b2'],
      );
      assert.equal(result.pageInfo.hasNextPage, false);
    });

    it('merges overlapping ranges and dedupes by id', async () => {
      // Same logical tx x at height 100 on both sources (different indexedAt
      // on each source — simulates indexed_at skew).
      const shared = txAt({
        id: 'x',
        height: 100,
        blockTransactionIndex: 1,
      });
      const aShared = { ...shared, indexedAt: 100 };
      const bShared = { ...shared, indexedAt: 500 };
      const aOnly = txAt({ id: 'a', height: 100, blockTransactionIndex: 0 });
      const bOnly = txAt({ id: 'b', height: 100, blockTransactionIndex: 2 });

      const merger = makeMerger([
        new FakeQueryable({ transactions: [aOnly, aShared] }),
        new FakeQueryable({ transactions: [bShared, bOnly] }),
      ]);

      const result = await merger.getGqlTransactions({
        pageSize: 10,
        sortOrder: 'HEIGHT_DESC',
        tags: [],
      });
      // HEIGHT_DESC applies to every tuple position, so higher
      // blockTransactionIndex comes first at the same height.
      assert.deepEqual(
        result.edges.map((e) => e.node.id),
        ['b', 'x', 'a'],
      );
    });

    it('honors HEIGHT_ASC', async () => {
      const aTxs = [
        txAt({ id: 'a1', height: 1, blockTransactionIndex: 0 }),
        txAt({ id: 'a2', height: 3, blockTransactionIndex: 0 }),
      ];
      const bTxs = [
        txAt({ id: 'b1', height: 2, blockTransactionIndex: 0 }),
        txAt({ id: 'b2', height: 4, blockTransactionIndex: 0 }),
      ];
      const merger = makeMerger([
        new FakeQueryable({ transactions: aTxs }),
        new FakeQueryable({ transactions: bTxs }),
      ]);
      const result = await merger.getGqlTransactions({
        pageSize: 10,
        sortOrder: 'HEIGHT_ASC',
        tags: [],
      });
      assert.deepEqual(
        result.edges.map((e) => e.node.id),
        ['a1', 'b1', 'a2', 'b2'],
      );
    });

    it('respects pageSize and reports hasNextPage', async () => {
      const aTxs = [
        txAt({ id: 'a1', height: 100, blockTransactionIndex: 0 }),
        txAt({ id: 'a2', height: 99, blockTransactionIndex: 0 }),
        txAt({ id: 'a3', height: 98, blockTransactionIndex: 0 }),
      ];
      const bTxs = [txAt({ id: 'b1', height: 97, blockTransactionIndex: 0 })];
      const merger = makeMerger([
        new FakeQueryable({ transactions: aTxs }),
        new FakeQueryable({ transactions: bTxs }),
      ]);
      const result = await merger.getGqlTransactions({
        pageSize: 2,
        sortOrder: 'HEIGHT_DESC',
        tags: [],
      });
      assert.deepEqual(
        result.edges.map((e) => e.node.id),
        ['a1', 'a2'],
      );
      assert.equal(result.pageInfo.hasNextPage, true);
    });

    it('forwards cursors so pagination round-trips across upstreams', async () => {
      const aTxs = [
        txAt({ id: 'a1', height: 100, blockTransactionIndex: 0 }),
        txAt({ id: 'a2', height: 98, blockTransactionIndex: 0 }),
      ];
      const bTxs = [
        txAt({ id: 'b1', height: 99, blockTransactionIndex: 0 }),
        txAt({ id: 'b2', height: 97, blockTransactionIndex: 0 }),
      ];
      const merger = makeMerger([
        new FakeQueryable({ transactions: aTxs }),
        new FakeQueryable({ transactions: bTxs }),
      ]);

      const page1 = await merger.getGqlTransactions({
        pageSize: 2,
        sortOrder: 'HEIGHT_DESC',
        tags: [],
      });
      assert.deepEqual(
        page1.edges.map((e) => e.node.id),
        ['a1', 'b1'],
      );
      assert.equal(page1.pageInfo.hasNextPage, true);

      const page2 = await merger.getGqlTransactions({
        pageSize: 2,
        cursor: page1.edges[page1.edges.length - 1].cursor,
        sortOrder: 'HEIGHT_DESC',
        tags: [],
      });
      assert.deepEqual(
        page2.edges.map((e) => e.node.id),
        ['a2', 'b2'],
      );
      assert.equal(page2.pageInfo.hasNextPage, false);
    });

    it('returns partial results when one source fails', async () => {
      const aTxs = [txAt({ id: 'a1', height: 100 })];
      const merger = makeMerger([
        new FakeQueryable({ transactions: aTxs }),
        new FakeQueryable({ throws: new Error('boom') }),
      ]);
      const result = await merger.getGqlTransactions({
        pageSize: 10,
        sortOrder: 'HEIGHT_DESC',
        tags: [],
      });
      assert.deepEqual(
        result.edges.map((e) => e.node.id),
        ['a1'],
      );
    });

    it('includes the local queryable when provided', async () => {
      const local = new FakeQueryable({
        transactions: [txAt({ id: 'local-1', height: 100 })],
      });
      const remote = new FakeQueryable({
        transactions: [txAt({ id: 'remote-1', height: 99 })],
      });
      const merger = makeMerger([local, remote]);
      const result = await merger.getGqlTransactions({
        pageSize: 10,
        sortOrder: 'HEIGHT_DESC',
        tags: [],
      });
      assert.deepEqual(
        result.edges.map((e) => e.node.id),
        ['local-1', 'remote-1'],
      );
    });

    it('orders ids by binary bytes, not base64url ASCII', async () => {
      // Two ids whose binary and base64url ASCII orderings disagree:
      //   aAAA... (binary first byte 0x68) vs -AAA... (binary first byte 0xF8)
      // Binary: 0x68 < 0xF8, so 'a...' comes first in ASC.
      // String: '-' (45) < 'a' (97), so '-...' would come first if we used
      // ASCII — wrong, and desynced from SQLite/ClickHouse BLOB sort.
      const ID_A = `a${'A'.repeat(42)}`;
      const ID_B = `-${'A'.repeat(42)}`;
      const txA = txAt({ id: ID_A, height: 100, blockTransactionIndex: 0 });
      const txB = txAt({ id: ID_B, height: 100, blockTransactionIndex: 0 });
      const merger = makeMerger([
        new FakeQueryable({ transactions: [txA] }),
        new FakeQueryable({ transactions: [txB] }),
      ]);
      const result = await merger.getGqlTransactions({
        pageSize: 10,
        sortOrder: 'HEIGHT_ASC',
        tags: [],
      });
      assert.deepEqual(
        result.edges.map((e) => e.node.id),
        [ID_A, ID_B],
      );
    });

    it('reports hasNextPage=false when all remaining are cross-source dupes', async () => {
      // Shared tx x. pageSize=1. Both upstreams return [x]. After emitting x,
      // the remaining buffered x on the second upstream is a dupe — nothing
      // real is left to page into.
      const shared = txAt({ id: 'x', height: 100 });
      const merger = makeMerger([
        new FakeQueryable({ transactions: [shared] }),
        new FakeQueryable({ transactions: [shared] }),
      ]);
      const result = await merger.getGqlTransactions({
        pageSize: 1,
        sortOrder: 'HEIGHT_DESC',
        tags: [],
      });
      assert.deepEqual(
        result.edges.map((e) => e.node.id),
        ['x'],
      );
      assert.equal(result.pageInfo.hasNextPage, false);
    });

    it('reports hasNextPage=true when a real distinct item remains', async () => {
      const shared = txAt({ id: 'x', height: 100 });
      const more = txAt({ id: 'y', height: 99 });
      const merger = makeMerger([
        new FakeQueryable({ transactions: [shared, more] }),
        new FakeQueryable({ transactions: [shared] }),
      ]);
      const result = await merger.getGqlTransactions({
        pageSize: 1,
        sortOrder: 'HEIGHT_DESC',
        tags: [],
      });
      assert.deepEqual(
        result.edges.map((e) => e.node.id),
        ['x'],
      );
      assert.equal(result.pageInfo.hasNextPage, true);
    });
  });

  describe('getGqlBlocks', () => {
    it('merges block results in HEIGHT_DESC order', async () => {
      const aBlocks: GqlBlock[] = [
        { id: 'a100', height: 100, timestamp: 0, previous: '' },
        { id: 'a99', height: 99, timestamp: 0, previous: '' },
      ];
      const bBlocks: GqlBlock[] = [
        { id: 'b98', height: 98, timestamp: 0, previous: '' },
        { id: 'b97', height: 97, timestamp: 0, previous: '' },
      ];
      const merger = makeMerger([
        new FakeQueryable({ blocks: aBlocks }),
        new FakeQueryable({ blocks: bBlocks }),
      ]);
      const result = await merger.getGqlBlocks({
        pageSize: 10,
        sortOrder: 'HEIGHT_DESC',
      });
      assert.deepEqual(
        result.edges.map((e) => e.node.id),
        ['a100', 'a99', 'b98', 'b97'],
      );
    });

    it('dedupes blocks by id (same block across upstreams)', async () => {
      const shared: GqlBlock = {
        id: 'h100',
        height: 100,
        timestamp: 0,
        previous: '',
      };
      const merger = makeMerger([
        new FakeQueryable({ blocks: [shared] }),
        new FakeQueryable({ blocks: [shared] }),
      ]);
      const result = await merger.getGqlBlocks({
        pageSize: 10,
        sortOrder: 'HEIGHT_DESC',
      });
      assert.equal(result.edges.length, 1);
    });
  });

  describe('getGqlBlock (single record)', () => {
    it('returns first non-null', async () => {
      const block: GqlBlock = {
        id: 'b1',
        height: 1,
        timestamp: 0,
        previous: '',
      };
      const merger = makeMerger([
        new FakeQueryable({}),
        new FakeQueryable({ blocks: [block] }),
      ]);
      assert.equal((await merger.getGqlBlock({ id: 'b1' }))?.id, 'b1');
    });
  });
});

describe('RemoteGqlQueryable circuit breaker', () => {
  const { RemoteGqlQueryable } = fanoutInternals;

  // Tight options so the breaker opens deterministically within the test.
  const breakerOptions = {
    timeout: 500,
    errorThresholdPercentage: 1,
    rollingCountTimeout: 10_000,
    resetTimeout: 10_000,
    volumeThreshold: 2,
  };

  it('opens after repeated failures and short-circuits further calls', async () => {
    const http = makeControlledAxios();
    const remote = new RemoteGqlQueryable(
      'http://unreachable.example',
      http.instance,
      breakerOptions,
      log,
    );

    for (let i = 0; i < 3; i++) {
      await assert.rejects(() => remote.getGqlBlock({ id: 'x' }));
    }
    const callsAfterOpen = http.getCallCount();

    await assert.rejects(
      () => remote.getGqlBlock({ id: 'x' }),
      (err: any) => err?.code === 'EOPENBREAKER',
    );
    assert.equal(
      http.getCallCount(),
      callsAfterOpen,
      'open breaker must not reach axios',
    );
  });

  it("fan-out returns partial results when one peer's breaker is open", async () => {
    const failing = makeControlledAxios();
    const failingRemote = new RemoteGqlQueryable(
      'http://unreachable.example',
      failing.instance,
      breakerOptions,
      log,
    );
    // Trip the breaker.
    for (let i = 0; i < 3; i++) {
      await assert.rejects(() => failingRemote.getGqlBlock({ id: 'x' }));
    }

    const healthy = new FakeQueryable({
      transactions: [txAt({ id: 'a1', height: 100 })],
    });
    const merger = GatewaysGqlQueryable.forTesting({
      log,
      sources: [healthy, failingRemote],
      labels: ['<local>', 'http://unreachable.example'],
    });

    const result = await merger.getGqlTransactions({
      pageSize: 10,
      sortOrder: 'HEIGHT_DESC',
      tags: [],
    });
    assert.deepEqual(
      result.edges.map((e) => e.node.id),
      ['a1'],
    );
  });
});
