/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, before, describe, it, mock } from 'node:test';
import { LRUCache } from 'lru-cache';
import { createTestLogger } from '../../test/test-logger.js';
import {
  GraphQLRootTxBatcher,
  BatchEndpoint,
  LeafResult,
  NOT_FOUND,
} from './graphql-root-tx-batcher.js';

let log: ReturnType<typeof createTestLogger>;

const EP = (url: string, priority = 1, maxBatchSize = 100): BatchEndpoint => ({
  url,
  priority,
  maxBatchSize,
});

// Always-grant token, unless overridden per test.
const alwaysToken = async () => true;

before(() => {
  log = createTestLogger({ suite: 'GraphQLRootTxBatcher' });
});

afterEach(() => mock.restoreAll());

describe('GraphQLRootTxBatcher', () => {
  it('coalesces concurrent lookups into a single batched query', async () => {
    const fetchBatch = mock.fn(
      async (_url: string, ids: string[]) =>
        new Map(ids.map((id) => [id, { bundleId: `parent-${id}` }])),
    );
    const batcher = new GraphQLRootTxBatcher({
      log,
      endpoints: [EP('http://gw1')],
      fetchBatch,
      acquireToken: alwaysToken,
      windowMs: 10,
      maxBatchSize: 100,
      maxQueueDepth: 1000,
    });

    const results = await Promise.all([
      batcher.lookup('a'),
      batcher.lookup('b'),
      batcher.lookup('c'),
    ]);

    assert.equal(fetchBatch.mock.callCount(), 1);
    assert.deepEqual(fetchBatch.mock.calls[0].arguments[1].sort(), [
      'a',
      'b',
      'c',
    ]);
    assert.deepEqual(results, [
      { bundleId: 'parent-a' },
      { bundleId: 'parent-b' },
      { bundleId: 'parent-c' },
    ]);
  });

  it('dedups concurrent lookups of the same id into one batch entry', async () => {
    const fetchBatch = mock.fn(
      async (_url: string, ids: string[]) =>
        new Map(ids.map((id) => [id, { bundleId: 'p' }])),
    );
    const batcher = new GraphQLRootTxBatcher({
      log,
      endpoints: [EP('http://gw1')],
      fetchBatch,
      acquireToken: alwaysToken,
      windowMs: 10,
      maxBatchSize: 100,
      maxQueueDepth: 1000,
    });

    const [r1, r2] = await Promise.all([
      batcher.lookup('dup'),
      batcher.lookup('dup'),
    ]);

    assert.equal(fetchBatch.mock.callCount(), 1);
    assert.deepEqual(fetchBatch.mock.calls[0].arguments[1], ['dup']);
    assert.deepEqual(r1, { bundleId: 'p' });
    assert.deepEqual(r2, { bundleId: 'p' });
  });

  // Exactly fills the batch with a huge window: only an eager (at-fill) flush
  // can resolve these. The 2s test timeout fails fast if eager flush regresses
  // (the lookups would otherwise hang on the 60s window).
  it(
    'flushes eagerly when the batch fills, without waiting the window',
    {
      timeout: 2000,
    },
    async () => {
      const fetchBatch = mock.fn(
        async (_url: string, ids: string[]) =>
          new Map(ids.map((id) => [id, { bundleId: 'p' }])),
      );
      const batcher = new GraphQLRootTxBatcher({
        log,
        endpoints: [EP('http://gw1')],
        fetchBatch,
        acquireToken: alwaysToken,
        windowMs: 60_000,
        maxBatchSize: 2,
        maxQueueDepth: 1000,
      });

      const results = await Promise.all([
        batcher.lookup('a'),
        batcher.lookup('b'),
      ]);

      assert.equal(fetchBatch.mock.callCount(), 1);
      assert.deepEqual(fetchBatch.mock.calls[0].arguments[1].sort(), [
        'a',
        'b',
      ]);
      assert.deepEqual(results, [{ bundleId: 'p' }, { bundleId: 'p' }]);
    },
  );

  it('drains the remainder across rounds when more than one batch is queued', async () => {
    const fetchBatch = mock.fn(
      async (_url: string, ids: string[]) =>
        new Map(ids.map((id) => [id, { bundleId: 'p' }])),
    );
    const batcher = new GraphQLRootTxBatcher({
      log,
      endpoints: [EP('http://gw1')],
      fetchBatch,
      acquireToken: alwaysToken,
      windowMs: 20,
      maxBatchSize: 2,
      maxQueueDepth: 1000,
    });

    const results = await Promise.all([
      batcher.lookup('a'),
      batcher.lookup('b'),
      batcher.lookup('c'),
    ]);

    // [a,b] eager at fill; [c] drains on the next round.
    assert.equal(fetchBatch.mock.callCount(), 2);
    assert.deepEqual(
      results,
      ['a', 'b', 'c'].map(() => ({ bundleId: 'p' })),
    );
  });

  it('sheds lookups (NOT_FOUND) when the queue is at max depth', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fetchBatch = mock.fn(async (_url: string, ids: string[]) => {
      await gate; // keep IDs in-flight so the queue stays full
      return new Map(ids.map((id) => [id, { bundleId: 'p' }]));
    });
    const batcher = new GraphQLRootTxBatcher({
      log,
      endpoints: [EP('http://gw1')],
      fetchBatch,
      acquireToken: alwaysToken,
      windowMs: 5,
      maxBatchSize: 100,
      maxQueueDepth: 2,
    });

    const p1 = batcher.lookup('a');
    const p2 = batcher.lookup('b');
    // a + b now occupy the queue (pending/in-flight); c must be shed.
    const shed = await batcher.lookup('c');
    assert.equal(shed, NOT_FOUND);

    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.deepEqual(r1, { bundleId: 'p' });
    assert.deepEqual(r2, { bundleId: 'p' });
  });

  it('falls through to the next endpoint for IDs missing from the first', async () => {
    const fetchBatch = mock.fn(async (url: string, ids: string[]) => {
      if (url === 'http://gw1') {
        // gw1 only knows about 'a'
        return new Map(
          ids.filter((i) => i === 'a').map((i) => [i, { bundleId: 'pa' }]),
        );
      }
      // gw2 knows 'b'
      return new Map(
        ids.filter((i) => i === 'b').map((i) => [i, { bundleId: 'pb' }]),
      );
    });
    const batcher = new GraphQLRootTxBatcher({
      log,
      endpoints: [EP('http://gw1', 1), EP('http://gw2', 2)],
      fetchBatch,
      acquireToken: alwaysToken,
      windowMs: 10,
      maxBatchSize: 100,
      maxQueueDepth: 1000,
    });

    const [ra, rb] = await Promise.all([
      batcher.lookup('a'),
      batcher.lookup('b'),
    ]);

    assert.deepEqual(ra, { bundleId: 'pa' });
    assert.deepEqual(rb, { bundleId: 'pb' });
    // gw1 queried with both; gw2 queried with only the missing 'b'.
    assert.equal(fetchBatch.mock.calls[0].arguments[0], 'http://gw1');
    assert.deepEqual(fetchBatch.mock.calls[0].arguments[1].sort(), ['a', 'b']);
    assert.equal(fetchBatch.mock.calls[1].arguments[0], 'http://gw2');
    assert.deepEqual(fetchBatch.mock.calls[1].arguments[1], ['b']);
  });

  it('resolves NOT_FOUND only after all endpoints miss; distinguishes root tx', async () => {
    const fetchBatch = mock.fn(async (_url: string, ids: string[]) => {
      const out = new Map<string, LeafResult>();
      // 'root' exists and is a root tx (bundleId undefined); 'ghost' never appears.
      if (ids.includes('root')) out.set('root', { bundleId: undefined });
      return out;
    });
    const batcher = new GraphQLRootTxBatcher({
      log,
      endpoints: [EP('http://gw1', 1), EP('http://gw2', 2)],
      fetchBatch,
      acquireToken: alwaysToken,
      windowMs: 10,
      maxBatchSize: 100,
      maxQueueDepth: 1000,
    });

    const [root, ghost] = await Promise.all([
      batcher.lookup('root'),
      batcher.lookup('ghost'),
    ]);

    assert.deepEqual(root, { bundleId: undefined }); // found, is a root tx
    assert.equal(ghost, NOT_FOUND); // absent from every endpoint
  });

  it('carries IDs to the next endpoint when a token cannot be acquired', async () => {
    const acquireToken = mock.fn(async (..._args: unknown[]) => true);
    // First call (gw1) fails to get a token, second (gw2) succeeds.
    acquireToken.mock.mockImplementationOnce(async () => false, 0);

    const fetchBatch = mock.fn(
      async (_url: string, ids: string[]) =>
        new Map(ids.map((id) => [id, { bundleId: 'p' }])),
    );
    const batcher = new GraphQLRootTxBatcher({
      log,
      endpoints: [EP('http://gw1', 1), EP('http://gw2', 2)],
      fetchBatch,
      acquireToken,
      windowMs: 10,
      maxBatchSize: 100,
      maxQueueDepth: 1000,
    });

    const r = await batcher.lookup('a');
    assert.deepEqual(r, { bundleId: 'p' });
    // gw1 never issued a query (no token); only gw2 did.
    assert.equal(fetchBatch.mock.callCount(), 1);
    assert.equal(fetchBatch.mock.calls[0].arguments[0], 'http://gw2');
  });

  it('returns cached results without issuing a batch', async () => {
    const cache = new LRUCache<string, LeafResult>({ max: 100 });
    cache.set('cached', { bundleId: 'pc', contentType: 'text/plain' });
    const fetchBatch = mock.fn(async () => new Map<string, LeafResult>());
    const batcher = new GraphQLRootTxBatcher({
      log,
      endpoints: [EP('http://gw1')],
      fetchBatch,
      acquireToken: alwaysToken,
      windowMs: 10,
      maxBatchSize: 100,
      maxQueueDepth: 1000,
      cache,
    });

    const r = await batcher.lookup('cached');
    assert.deepEqual(r, { bundleId: 'pc', contentType: 'text/plain' });
    assert.equal(fetchBatch.mock.callCount(), 0);
  });

  it('chunks a round to each endpoint max batch size', async () => {
    const fetchBatch = mock.fn(
      async (_url: string, ids: string[]) =>
        new Map(ids.map((id) => [id, { bundleId: 'p' }])),
    );
    const batcher = new GraphQLRootTxBatcher({
      log,
      endpoints: [EP('http://gw1', 1, 2)], // endpoint caps batches at 2
      fetchBatch,
      acquireToken: alwaysToken,
      windowMs: 10,
      maxBatchSize: 100, // round can take all 3...
      maxQueueDepth: 1000,
    });

    await Promise.all([
      batcher.lookup('a'),
      batcher.lookup('b'),
      batcher.lookup('c'),
    ]);

    // ...but the endpoint's max-2 forces two chunked queries (2 + 1).
    assert.equal(fetchBatch.mock.callCount(), 2);
    const sizes = fetchBatch.mock.calls
      .map((c) => (c.arguments[1] as string[]).length)
      .sort();
    assert.deepEqual(sizes, [1, 2]);
  });
});
