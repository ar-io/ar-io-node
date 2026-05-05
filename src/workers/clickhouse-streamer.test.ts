/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { EventEmitter } from 'node:events';

import { createTestLogger } from '../../test/test-logger.js';
import * as events from '../events.js';
import {
  NormalizedBundleDataItem,
  PartialJsonBlock,
  PartialJsonTransaction,
} from '../types.js';
import {
  ClickHouseStreamer,
  NEW_TRANSACTION_COLUMNS,
} from './clickhouse-streamer.js';

const log = createTestLogger({ suite: 'ClickHouseStreamer' });

// Minimal ClickHouseClient stub. validateSchema() goes through `query` and
// reads a JSON list of table names; INSERTs and ALTER TABLE go through
// `command`. Both are mocked here so tests can drive the SQL surface
// without a live CH instance and assert on emitted statements.
function makeChClient(
  opts: {
    schemaTables?: string[];
    queryReject?: Error;
    commandReject?: Error;
    // Resolve `command` only when this signal fires — lets tests synchronize
    // with a flush that's been kicked off but not yet finished, so we can
    // assert ordering against handleReorg's drain step.
    commandGate?: Promise<void>;
  } = {},
) {
  const tables = opts.schemaTables ?? ['new_blocks', 'new_transactions'];
  const commands: string[] = [];
  return {
    commands,
    async query() {
      if (opts.queryReject) throw opts.queryReject;
      return {
        async json() {
          return tables.map((name) => ({ name }));
        },
      };
    },
    async command({ query }: { query: string }) {
      commands.push(query);
      if (opts.commandGate) await opts.commandGate;
      if (opts.commandReject) throw opts.commandReject;
    },
  };
}

// 43-char base64url id, deterministic per label. Long enough that the
// streamer's `fromB64Url` Buffer round-trip yields a stable byte string,
// short enough to keep test assertions readable.
function id(label: string): string {
  return (label + 'A'.repeat(43)).slice(0, 43);
}

function makeBlock(
  overrides: Partial<PartialJsonBlock> = {},
): PartialJsonBlock {
  return {
    indep_hash: id('block'),
    height: 100,
    nonce: '',
    hash: '',
    previous_block: id('prev'),
    timestamp: 1_700_000_000,
    diff: '0',
    reward_addr: '',
    reward_pool: '0',
    block_size: '0',
    weave_size: '0',
    wallet_list: '',
    tx_root: '',
    tags: [],
    txs: [],
    ...overrides,
  };
}

function makeTx(
  overrides: Partial<PartialJsonTransaction> = {},
): PartialJsonTransaction {
  return {
    id: id('tx1'),
    signature: id('sig'),
    format: 2,
    last_tx: id('anch'),
    owner: id('owner'),
    target: '',
    quantity: '0',
    reward: '0',
    data_size: '0',
    data_root: '',
    tags: [],
    ...overrides,
  };
}

function makeDataItem(
  overrides: Partial<NormalizedBundleDataItem> = {},
): NormalizedBundleDataItem {
  return {
    anchor: id('anch'),
    data_hash: null,
    data_offset: 0,
    data_size: 0,
    id: id('di1'),
    index: 0,
    offset: 0,
    owner: id('owner'),
    owner_address: id('owner_address'),
    owner_offset: 0,
    owner_size: 0,
    parent_id: id('tx1'),
    parent_index: 0,
    root_parent_offset: 0,
    root_tx_id: id('tx1'),
    signature: id('sig'),
    signature_offset: 0,
    signature_size: 0,
    signature_type: 1,
    size: 0,
    tags: [],
    target: '',
    ...overrides,
  };
}

// Streamer factory with safe defaults — flushIntervalMs is large enough
// that the background timer won't fire during a synchronous test, and
// maxQueueSize is big enough that capacity tests opt-in via override.
function makeStreamer({
  chClient,
  eventEmitter,
  batchSize = 1_000_000,
  flushIntervalMs = 1_000_000,
  maxQueueSize = 1_000_000,
}: {
  chClient: ReturnType<typeof makeChClient>;
  eventEmitter: EventEmitter;
  batchSize?: number;
  flushIntervalMs?: number;
  maxQueueSize?: number;
}): ClickHouseStreamer {
  return new ClickHouseStreamer({
    log,
    eventEmitter,
    clickhouseClient: chClient as any,
    batchSize,
    flushIntervalMs,
    maxQueueSize,
  });
}

// Yield to the microtask queue so `void this.handle*()` in event listeners
// (and `void this.flush()` from the cap-check) gets a chance to execute.
const tick = () => new Promise((r) => setImmediate(r));

describe('ClickHouseStreamer', () => {
  let eventEmitter: EventEmitter;
  let chClient: ReturnType<typeof makeChClient>;
  let streamer: ClickHouseStreamer;

  beforeEach(() => {
    eventEmitter = new EventEmitter();
    chClient = makeChClient();
    streamer = makeStreamer({ chClient, eventEmitter });
  });

  afterEach(async () => {
    await streamer.stop().catch(() => {});
  });

  describe('start() / schema validation', () => {
    it('throws when new_blocks is missing', async () => {
      chClient = makeChClient({ schemaTables: ['new_transactions'] });
      streamer = makeStreamer({ chClient, eventEmitter });
      await assert.rejects(
        () => streamer.start(),
        /required table\(s\) missing.*new_blocks/,
      );
    });

    it('throws when new_transactions is missing', async () => {
      chClient = makeChClient({ schemaTables: ['new_blocks'] });
      streamer = makeStreamer({ chClient, eventEmitter });
      await assert.rejects(
        () => streamer.start(),
        /required table\(s\) missing.*new_transactions/,
      );
    });

    it('throws when both tables are missing', async () => {
      chClient = makeChClient({ schemaTables: [] });
      streamer = makeStreamer({ chClient, eventEmitter });
      await assert.rejects(
        () => streamer.start(),
        /new_blocks, new_transactions/,
      );
    });

    it('starts cleanly when both tables exist', async () => {
      await streamer.start();
      assert.equal(eventEmitter.listenerCount(events.BLOCK_INDEXED), 1);
      assert.equal(eventEmitter.listenerCount(events.BLOCK_TX_INDEXED), 1);
      assert.equal(
        eventEmitter.listenerCount(events.ANS104_DATA_ITEM_INDEXED),
        1,
      );
      assert.equal(eventEmitter.listenerCount(events.CHAIN_REORG), 1);
    });

    it('is idempotent: a second start() does not register duplicate listeners', async () => {
      await streamer.start();
      await streamer.start();
      assert.equal(eventEmitter.listenerCount(events.BLOCK_INDEXED), 1);
      assert.equal(eventEmitter.listenerCount(events.CHAIN_REORG), 1);
    });
  });

  describe('stop()', () => {
    it('removes listeners so subsequent emits do not buffer rows', async () => {
      await streamer.start();
      await streamer.stop();
      assert.equal(eventEmitter.listenerCount(events.BLOCK_INDEXED), 0);
      eventEmitter.emit(events.BLOCK_INDEXED, makeBlock());
      await tick();
      assert.equal(streamer.queueDepth(), 0);
    });

    it('is idempotent: a second stop() is a no-op', async () => {
      await streamer.start();
      await streamer.stop();
      // Second call must not throw and must not attempt removeListener
      // on a now-empty registry (would still be safe, but we also check
      // no extra command emissions).
      const before = chClient.commands.length;
      await streamer.stop();
      assert.equal(chClient.commands.length, before);
    });

    it('issues a final flush so buffered rows are not lost on shutdown', async () => {
      await streamer.start();
      eventEmitter.emit(events.BLOCK_INDEXED, makeBlock({ height: 42 }));
      await tick();
      assert.equal(streamer.queueDepth(), 1);
      await streamer.stop();
      assert.ok(
        chClient.commands.some((c) => c.startsWith('INSERT INTO new_blocks')),
        'expected a final new_blocks INSERT during stop()',
      );
    });
  });

  describe('BLOCK_INDEXED', () => {
    beforeEach(async () => {
      await streamer.start();
    });

    it('buffers a new_blocks row and increments queueDepth', async () => {
      eventEmitter.emit(events.BLOCK_INDEXED, makeBlock({ height: 100 }));
      await tick();
      assert.equal(streamer.queueDepth(), 1);
    });
  });

  describe('BLOCK_TX_INDEXED', () => {
    beforeEach(async () => {
      await streamer.start();
    });

    it('buffers a new_transactions row when its tx is in the current block', async () => {
      const txId = id('tx1');
      eventEmitter.emit(
        events.BLOCK_INDEXED,
        makeBlock({ height: 100, txs: [txId] }),
      );
      await tick();
      eventEmitter.emit(events.BLOCK_TX_INDEXED, makeTx({ id: txId }));
      await tick();
      // 1 block row + 1 tx row.
      assert.equal(streamer.queueDepth(), 2);
    });

    it('skips silently when no BLOCK_INDEXED has been seen yet', async () => {
      eventEmitter.emit(events.BLOCK_TX_INDEXED, makeTx({ id: id('tx1') }));
      await tick();
      assert.equal(streamer.queueDepth(), 0);
    });

    it('skips and logs a warning when tx.id is not in currentBlock.txs', async () => {
      eventEmitter.emit(
        events.BLOCK_INDEXED,
        makeBlock({ height: 100, txs: [id('different')] }),
      );
      await tick();
      eventEmitter.emit(events.BLOCK_TX_INDEXED, makeTx({ id: id('tx1') }));
      await tick();
      // Block row buffered; the orphaned tx row was skipped.
      assert.equal(streamer.queueDepth(), 1);
    });
  });

  describe('ANS104_DATA_ITEM_INDEXED', () => {
    beforeEach(async () => {
      await streamer.start();
    });

    it('buffers a data-item row inheriting parent tx context', async () => {
      const txId = id('tx1');
      eventEmitter.emit(
        events.BLOCK_INDEXED,
        makeBlock({ height: 100, txs: [txId] }),
      );
      await tick();
      eventEmitter.emit(events.BLOCK_TX_INDEXED, makeTx({ id: txId }));
      await tick();
      eventEmitter.emit(
        events.ANS104_DATA_ITEM_INDEXED,
        makeDataItem({ root_tx_id: txId, parent_id: txId }),
      );
      await tick();
      // block + L1 tx + data item.
      assert.equal(streamer.queueDepth(), 3);
    });

    it('skips data items whose parent tx is not cached (cold-start gap)', async () => {
      // No BLOCK_INDEXED first → no parent context.
      eventEmitter.emit(
        events.ANS104_DATA_ITEM_INDEXED,
        makeDataItem({ root_tx_id: id('tx1') }),
      );
      await tick();
      assert.equal(streamer.queueDepth(), 0);
    });

    it('skips optimistic data items (root_tx_id null)', async () => {
      // Optimistic items use the NormalizedOptimisticDataItem variant; we
      // exercise the same nullish-root_tx_id branch by overriding here.
      eventEmitter.emit(
        events.ANS104_DATA_ITEM_INDEXED,
        makeDataItem({ root_tx_id: null as any }),
      );
      await tick();
      assert.equal(streamer.queueDepth(), 0);
    });
  });

  describe('flush triggering', () => {
    it('flushes when batchSize is reached', async () => {
      // batchSize=2 ⇒ a single BLOCK_INDEXED + BLOCK_TX_INDEXED hits the
      // threshold and triggers a flush.
      streamer = makeStreamer({
        chClient,
        eventEmitter,
        batchSize: 2,
      });
      await streamer.start();
      const txId = id('tx1');
      eventEmitter.emit(
        events.BLOCK_INDEXED,
        makeBlock({ height: 1, txs: [txId] }),
      );
      await tick();
      eventEmitter.emit(events.BLOCK_TX_INDEXED, makeTx({ id: txId }));
      await tick();
      // Wait for the void-async flush to complete.
      await tick();
      const blocksInsert = chClient.commands.find((c) =>
        c.startsWith('INSERT INTO new_blocks'),
      );
      const txsInsert = chClient.commands.find((c) =>
        c.startsWith('INSERT INTO new_transactions'),
      );
      assert.ok(blocksInsert !== undefined, 'expected a new_blocks INSERT');
      assert.ok(txsInsert !== undefined, 'expected a new_transactions INSERT');
      // Buffers should be drained.
      assert.equal(streamer.queueDepth(), 0);
    });

    it('does not issue a CH command when there is nothing to flush', async () => {
      await streamer.start();
      const before = chClient.commands.length;
      await (streamer as any).flush();
      assert.equal(chClient.commands.length, before);
    });

    it('emits the new_transactions INSERT using NEW_TRANSACTION_COLUMNS positional ordering', async () => {
      streamer = makeStreamer({
        chClient,
        eventEmitter,
        batchSize: 2,
      });
      await streamer.start();
      const txId = id('tx1');
      eventEmitter.emit(
        events.BLOCK_INDEXED,
        makeBlock({ height: 1, txs: [txId] }),
      );
      await tick();
      eventEmitter.emit(events.BLOCK_TX_INDEXED, makeTx({ id: txId }));
      await tick();
      await tick();
      const txsInsert = chClient.commands.find((c) =>
        c.startsWith('INSERT INTO new_transactions'),
      );
      assert.ok(txsInsert !== undefined);
      // Column list is positional — guard against silent reordering by
      // asserting the literal column block matches NEW_TRANSACTION_COLUMNS.
      assert.ok(
        txsInsert.includes(`(${NEW_TRANSACTION_COLUMNS.join(', ')})`),
        'INSERT column list must match NEW_TRANSACTION_COLUMNS',
      );
    });

    it('swallows insert errors so streaming stays best-effort', async () => {
      chClient = makeChClient({ commandReject: new Error('CH down') });
      streamer = makeStreamer({
        chClient,
        eventEmitter,
        batchSize: 1,
      });
      await streamer.start();
      eventEmitter.emit(events.BLOCK_INDEXED, makeBlock({ height: 1 }));
      await tick();
      // Wait for flush to settle. If the error escaped the IIFE it would
      // surface as an unhandled rejection and fail the test runner.
      await tick();
      await tick();
      assert.equal(streamer.queueDepth(), 0);
    });
  });

  describe('queue cap (maxQueueSize)', () => {
    it('drops oldest tx rows when the buffer exceeds maxQueueSize', async () => {
      streamer = makeStreamer({
        chClient,
        eventEmitter,
        // Big batch so the cap-check path runs without flushing.
        batchSize: 1_000_000,
        maxQueueSize: 2,
      });
      await streamer.start();
      const txs = [id('tx1'), id('tx2'), id('tx3')];
      eventEmitter.emit(events.BLOCK_INDEXED, makeBlock({ height: 1, txs }));
      await tick();
      for (const txId of txs) {
        eventEmitter.emit(events.BLOCK_TX_INDEXED, makeTx({ id: txId }));
        await tick();
      }
      // 3 tx rows queued, cap is 2 — the oldest got dropped at cap-check
      // time. Plus the 1 block row → queueDepth is 3 (1 block + 2 txs).
      assert.equal(streamer.queueDepth(), 3);
    });
  });

  describe('CHAIN_REORG', () => {
    beforeEach(async () => {
      await streamer.start();
    });

    it('issues an ALTER TABLE DELETE for new_blocks', async () => {
      await (streamer as any).handleReorg({ forkHeight: 50 });
      assert.ok(
        chClient.commands.some((c) =>
          /^ALTER TABLE new_blocks DELETE WHERE height > 50$/.test(c),
        ),
        'expected an ALTER TABLE new_blocks DELETE for forkHeight=50',
      );
    });

    it('drops in-memory state above forkHeight and keeps state at or below', async () => {
      // Seed the streamer's in-memory caches by emitting events for two
      // blocks: one at the fork boundary (kept) and one above (pruned).
      eventEmitter.emit(
        events.BLOCK_INDEXED,
        makeBlock({ indep_hash: id('keep'), height: 50, txs: [id('keepTx')] }),
      );
      await tick();
      eventEmitter.emit(events.BLOCK_TX_INDEXED, makeTx({ id: id('keepTx') }));
      await tick();
      eventEmitter.emit(
        events.BLOCK_INDEXED,
        makeBlock({
          indep_hash: id('drop'),
          height: 51,
          txs: [id('dropTx')],
        }),
      );
      await tick();
      eventEmitter.emit(events.BLOCK_TX_INDEXED, makeTx({ id: id('dropTx') }));
      await tick();

      assert.equal(streamer.queueDepth(), 4);
      const blocksByHeight = (streamer as any).blocksByHeight as Map<
        number,
        unknown
      >;
      assert.ok(blocksByHeight.has(50));
      assert.ok(blocksByHeight.has(51));

      await (streamer as any).handleReorg({ forkHeight: 50 });

      // In-memory pruning: heights > 50 are gone, heights ≤ 50 survive.
      assert.ok(blocksByHeight.has(50));
      assert.ok(!blocksByHeight.has(51));
      const txContexts = (streamer as any).txContextsById as Map<
        string,
        { height: number }
      >;
      assert.ok(txContexts.has(id('keepTx')));
      assert.ok(!txContexts.has(id('dropTx')));
      // Buffers: only the forked rows are filtered out.
      // (1 block@50 + 1 tx@50 = 2 rows kept; height=51 rows dropped.)
      assert.equal(streamer.queueDepth(), 2);
    });

    it('clears currentBlock when its height is past forkHeight', async () => {
      eventEmitter.emit(events.BLOCK_INDEXED, makeBlock({ height: 100 }));
      await tick();
      assert.notEqual((streamer as any).currentBlock, null);
      await (streamer as any).handleReorg({ forkHeight: 50 });
      assert.equal((streamer as any).currentBlock, null);
    });

    it('preserves currentBlock when its height is at or below forkHeight', async () => {
      eventEmitter.emit(events.BLOCK_INDEXED, makeBlock({ height: 30 }));
      await tick();
      await (streamer as any).handleReorg({ forkHeight: 50 });
      assert.notEqual((streamer as any).currentBlock, null);
      assert.equal((streamer as any).currentBlock.height, 30);
    });

    it('swallows DELETE failures so the streamer survives a CH outage during reorg', async () => {
      // Replace the client with one that rejects the ALTER TABLE command.
      // Pre-existing listeners hold the old reference; tests only call
      // handleReorg directly here, so swapping the field is sufficient.
      const failing = makeChClient({
        commandReject: new Error('CH unavailable'),
      });
      (streamer as any).clickhouseClient = failing;
      // Should NOT throw — best-effort streaming.
      await (streamer as any).handleReorg({ forkHeight: 0 });
      assert.equal(failing.commands.length, 1);
    });
  });

  describe('queueDepth()', () => {
    it('reflects the sum of pending block + tx buffers', async () => {
      await streamer.start();
      assert.equal(streamer.queueDepth(), 0);
      const txId = id('tx1');
      eventEmitter.emit(
        events.BLOCK_INDEXED,
        makeBlock({ height: 1, txs: [txId] }),
      );
      await tick();
      assert.equal(streamer.queueDepth(), 1);
      eventEmitter.emit(events.BLOCK_TX_INDEXED, makeTx({ id: txId }));
      await tick();
      assert.equal(streamer.queueDepth(), 2);
    });
  });

  describe('NEW_TRANSACTION_COLUMNS', () => {
    it('includes inserted_at — without it CH defaults the column to epoch 0 and the TTL drops every row on the next merge', () => {
      assert.ok(NEW_TRANSACTION_COLUMNS.includes('inserted_at'));
    });
  });
});
