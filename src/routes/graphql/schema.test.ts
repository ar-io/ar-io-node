/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * GraphQL as a client sees it: real queries through Apollo, the real schema
 * and resolvers, against a migrated SQLite database seeded from the chain
 * fixtures (#572). Nothing is mocked but the owner and signature fetchers,
 * which would otherwise read the network, and the node is not booted.
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { ApolloServer } from '@apollo/server';

import {
  bundlesDbPath,
  chunksDbPath,
  coreDbPath,
  dataDbPath,
  moderationDbPath,
} from '../../../test/sqlite-helpers.js';
import {
  ArweaveChainSourceStub,
  stubAns104Bundle,
} from '../../../test/stubs.js';
import { createTestLogger } from '../../../test/test-logger.js';
import { StandaloneSqliteDatabase } from '../../database/standalone-sqlite.js';
import { normalizeAns104DataItem } from '../../lib/ans-104.js';
import { processBundleStream } from '../../lib/bundles.js';
import { GraphQLContext, typeDefs } from './index.js';
import { resolvers } from './resolvers.js';

const log = createTestLogger({ suite: 'GraphQL schema' });

/** Heights of the chain fixtures with every transaction on file. */
const HEIGHTS = [34, 42, 982575];

describe('GraphQL over SQLite', () => {
  let db: StandaloneSqliteDatabase;
  let server: ApolloServer<GraphQLContext>;
  let l1Ids: string[];
  let bundleId: string;
  let itemIds: string[];

  const run = async (query: string, variables?: Record<string, unknown>) => {
    const response = await server.executeOperation(
      { query, variables },
      {
        contextValue: {
          db,
          ownerFetcher: {
            getDataItemOwner: async () => undefined,
            getTransactionOwner: async () => undefined,
          },
          signatureFetcher: {
            getDataItemSignature: async () => undefined,
            getTransactionSignature: async () => undefined,
          },
          warnings: [],
          signal: new AbortController().signal,
          signalState: { responseSent: false },
        },
      },
    );
    assert.equal(response.body.kind, 'single');
    const result = (response.body as any).singleResult;
    assert.equal(result.errors, undefined, JSON.stringify(result.errors));
    return result.data;
  };

  /** Every page of a `transactions` query, following its cursors. */
  const walk = async (args: string, first: number) => {
    const ids: string[] = [];
    let after: string | null = null;
    for (let page = 0; page < 50; page++) {
      const data = await run(
        `query($after: String) {
           transactions(${args} first: ${first}, after: $after) {
             pageInfo { hasNextPage }
             edges { cursor node { id } }
           }
         }`,
        { after },
      );
      const { edges, pageInfo } = data.transactions;
      ids.push(...edges.map((e: any) => e.node.id));
      if (!pageInfo.hasNextPage) return ids;
      assert.ok(edges.length > 0, 'hasNextPage with an empty page');
      after = edges[edges.length - 1].cursor;
    }
    throw new Error('did not finish');
  };

  before(async () => {
    db = new StandaloneSqliteDatabase({
      log,
      coreDbPath,
      dataDbPath,
      moderationDbPath,
      bundlesDbPath,
      chunksDbPath,
      tagSelectivity: {},
    });
    server = new ApolloServer<GraphQLContext>({ typeDefs, resolvers });
    await server.start();
  });

  after(async () => {
    await server.stop();
    await db.stop();
  });

  // The helpers clear every table after each test, so each test seeds.
  const seed = async () => {
    const chain = new ArweaveChainSourceStub();
    l1Ids = [];
    for (const height of HEIGHTS) {
      const { block, txs, missingTxIds } =
        await chain.getBlockAndTxsByHeight(height);
      await db.saveBlockAndTxs(block, txs, missingTxIds);
      l1Ids.push(...txs.map((tx) => tx.id));
    }
    // The fixture bundle's items, as if unbundled from the last L1 tx.
    bundleId = l1Ids[l1Ids.length - 1];
    itemIds = [];
    const items = await processBundleStream(await stubAns104Bundle());
    let index = 0;
    for await (const [, item] of items.entries()) {
      const normalized = normalizeAns104DataItem({
        rootTxId: bundleId,
        parentId: bundleId,
        parentIndex: -1,
        index: index++,
        ans104DataItem: item,
        filter: '',
        dataHash: '',
        rootParentOffset: 0,
      });
      await db.saveDataItem(normalized);
      itemIds.push(normalized.id);
    }
    // Guard the fixtures, so no test passes vacuously.
    assert.equal(l1Ids.length, 5);
    assert.ok(itemIds.length >= 2, `${itemIds.length} items`);
  };

  it('pages through everything exactly once, in both orders', async () => {
    await seed();
    const all = [...l1Ids, ...itemIds].sort();
    for (const sort of ['HEIGHT_DESC', 'HEIGHT_ASC']) {
      for (const first of [1, 2, 3]) {
        const ids = await walk(`sort: ${sort}`, first);
        assert.equal(new Set(ids).size, ids.length, `${sort}/${first} dupes`);
        assert.deepEqual([...ids].sort(), all, `${sort}/${first}`);
      }
    }
  });

  it('orders L1 transactions by height in the asked direction', async () => {
    await seed();
    const heights = async (sort: string) =>
      (
        await run(`{ transactions(sort: ${sort}, first: 100, bundledIn: null) {
          edges { node { block { height } } } } }`)
      ).transactions.edges.map((e: any) => e.node.block.height);
    const asc = await heights('HEIGHT_ASC');
    assert.ok(new Set(asc).size > 1, 'need several heights to test order');
    assert.deepEqual(
      asc,
      [...asc].sort((a, b) => a - b),
    );
    assert.deepEqual(await heights('HEIGHT_DESC'), [...asc].reverse());
  });

  it('filters by bundledIn, and bundledIn: null means L1 only', async () => {
    await seed();
    const items = await run(
      `query($b: [ID!]) { transactions(bundledIn: $b, first: 100) {
         edges { node { id bundledIn { id } parent { id } } } } }`,
      { b: [bundleId] },
    );
    const nodes = items.transactions.edges.map((e: any) => e.node);
    assert.deepEqual(nodes.map((n: any) => n.id).sort(), [...itemIds].sort());
    for (const n of nodes) {
      assert.equal(n.bundledIn.id, bundleId);
      assert.equal(n.parent.id, bundleId);
    }
    const l1 = await run(
      `{ transactions(bundledIn: null, first: 100) { edges { node { id } } } }`,
    );
    assert.deepEqual(
      l1.transactions.edges.map((e: any) => e.node.id).sort(),
      [...l1Ids].sort(),
    );
  });

  it('combines filters: block range, ids and tags narrow together', async () => {
    await seed();
    const ranged = await run(
      `{ transactions(block: { min: 40, max: 50 }, first: 100) {
           edges { node { id block { height } } } } }`,
    );
    const heights = ranged.transactions.edges.map(
      (e: any) => e.node.block.height,
    );
    assert.ok(heights.length > 0);
    assert.ok(heights.every((h: number) => h >= 40 && h <= 50));

    const [first, second] = l1Ids;
    const byIds = await run(
      `query($ids: [ID!]) { transactions(ids: $ids, first: 100) {
         edges { node { id } } } }`,
      { ids: [first, second] },
    );
    assert.deepEqual(
      byIds.transactions.edges.map((e: any) => e.node.id).sort(),
      [first, second].sort(),
    );

    // The KYVE fixture at 982575 carries Application: KYVE.
    const tagged = await run(
      `{ transactions(tags: [{ name: "Application", values: ["KYVE"] }],
                      first: 100) {
           edges { node { id tags { name value } } } } }`,
    );
    const nodes = tagged.transactions.edges.map((e: any) => e.node);
    assert.ok(nodes.length > 0);
    for (const n of nodes) {
      assert.ok(
        n.tags.some((t: any) => t.name === 'Application' && t.value === 'KYVE'),
      );
    }
    const both = await run(
      `{ transactions(tags: [{ name: "Application", values: ["KYVE"] }],
                      block: { min: 0, max: 100 }, first: 100) {
           edges { node { id } } } }`,
    );
    assert.equal(both.transactions.edges.length, 0, 'filters intersect');
  });

  it('answers aliased and repeated fields, fragments and amounts (#1111)', async () => {
    await seed();
    const data = await run(
      `fragment F on Transaction { id quantity { ar } }
       query($id: ID!) {
         transaction(id: $id) {
           ...F
           a: tags { name }
           b: tags { value }
           data { type size }
           fee { ar }
           owner { address }
         }
       }`,
      { id: l1Ids[l1Ids.length - 1] },
    );
    const tx = data.transaction;
    assert.equal(tx.id, l1Ids[l1Ids.length - 1]);
    assert.equal(typeof tx.quantity.ar, 'string');
    assert.equal(typeof tx.fee.ar, 'string');
    assert.equal(tx.a.length, tx.b.length);
    assert.ok(tx.a.length > 0);
    assert.ok(tx.a.every((t: any) => typeof t.name === 'string'));
    assert.ok(tx.b.every((t: any) => typeof t.value === 'string'));
    assert.equal(typeof tx.owner.address, 'string');
  });

  it('answers block queries by id and by height range', async () => {
    await seed();
    const blocks = await run(
      `{ blocks(height: { min: 30, max: 50 }, first: 10, sort: HEIGHT_ASC) {
           edges { node { id height } } } }`,
    );
    const nodes = blocks.blocks.edges.map((e: any) => e.node);
    assert.deepEqual(
      nodes.map((n: any) => n.height),
      [34, 42],
    );
    const one = await run(`query($id: String!) { block(id: $id) { height } }`, {
      id: nodes[0].id,
    });
    assert.equal(one.block.height, 34);
  });
});
