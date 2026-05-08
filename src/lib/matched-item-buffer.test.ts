/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';

import {
  COMPACTION_HEAD_THRESHOLD,
  createMatchedItemBuffer,
  MatchedItemBuffer,
} from './matched-item-buffer.js';

/**
 * Tests inject a synchronous scheduler that captures pending drains in
 * an array, so we can step through the drain cycle deterministically
 * without relying on `setImmediate` and `await` plumbing. The
 * production path uses `setImmediate`; that's exercised in integration.
 */
describe('createMatchedItemBuffer', () => {
  let drained: number[];
  let scheduled: Array<() => void>;
  let buf: MatchedItemBuffer<number>;
  const scheduler = (cb: () => void): void => {
    scheduled.push(cb);
  };

  beforeEach(() => {
    drained = [];
    scheduled = [];
    buf = createMatchedItemBuffer<number>({
      drainBatch: 3,
      onDrain: (n) => drained.push(n),
      scheduler,
    });
  });

  it('drains pushed items in FIFO order', () => {
    buf.push(1);
    buf.push(2);
    buf.push(3);
    assert.equal(buf.depth(), 3);
    assert.equal(scheduled.length, 1);

    scheduled.shift()!();
    assert.deepEqual(drained, [1, 2, 3]);
    assert.equal(buf.depth(), 0);
  });

  it('processes only drainBatch items per cycle and re-schedules for the rest', () => {
    for (let i = 0; i < 10; i++) buf.push(i);
    assert.equal(buf.depth(), 10);

    // Cycle 1: 0,1,2 → 7 left, 1 re-scheduled
    scheduled.shift()!();
    assert.deepEqual(drained, [0, 1, 2]);
    assert.equal(buf.depth(), 7);
    assert.equal(scheduled.length, 1);

    // Cycle 2: 3,4,5
    scheduled.shift()!();
    assert.deepEqual(drained, [0, 1, 2, 3, 4, 5]);
    assert.equal(buf.depth(), 4);

    // Cycle 3: 6,7,8
    scheduled.shift()!();
    assert.deepEqual(drained, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(buf.depth(), 1);

    // Cycle 4: 9 (last one); no re-schedule
    scheduled.shift()!();
    assert.deepEqual(drained, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.equal(buf.depth(), 0);
    assert.equal(scheduled.length, 0);
  });

  it('coalesces multiple pushes into a single scheduled drain', () => {
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4);
    buf.push(5);
    // Five pushes, one scheduled drain — that's the whole point of the
    // `scheduled` flag. Without coalescing the unbundler firehose would
    // schedule a setImmediate per item.
    assert.equal(scheduled.length, 1);
  });

  it('schedules a fresh drain after the buffer was previously fully drained', () => {
    buf.push(1);
    scheduled.shift()!();
    assert.equal(buf.depth(), 0);

    // After full drain, the next push should schedule a NEW drain.
    buf.push(2);
    assert.equal(scheduled.length, 1);
    scheduled.shift()!();
    assert.deepEqual(drained, [1, 2]);
  });

  it('depth() reports undrained count, not total pushes', () => {
    for (let i = 0; i < 5; i++) buf.push(i);
    assert.equal(buf.depth(), 5);

    // Drain 3 of 5 (head moves from 0 → 3 without compaction since
    // head < COMPACTION_HEAD_THRESHOLD).
    scheduled.shift()!();
    assert.equal(buf.depth(), 2);
    scheduled.shift()!();
    assert.equal(buf.depth(), 0);
  });

  it('does not compact below COMPACTION_HEAD_THRESHOLD', () => {
    // Push more than drainBatch but well under threshold. Verify that
    // intermediate drains accumulate `head` without compacting (which
    // would zero `head`). We can't observe the internal head directly,
    // but we can check that the FIFO order is preserved across many
    // partial drains — a compaction bug would either lose items or
    // re-emit them.
    const N = 1000;
    for (let i = 0; i < N; i++) buf.push(i);
    while (scheduled.length > 0) scheduled.shift()!();
    assert.equal(drained.length, N);
    for (let i = 0; i < N; i++) assert.equal(drained[i], i);
  });

  it('compacts when head crosses threshold AND head*2 >= length, preserving FIFO', () => {
    // Use a drainBatch larger than the threshold so a single drain
    // pushes head past it. Then push exactly enough items so dead
    // slots account for half the buffer (triggering compaction), and
    // afterwards add more items to verify FIFO survives compaction.
    drained = [];
    scheduled = [];
    const big = createMatchedItemBuffer<number>({
      drainBatch: COMPACTION_HEAD_THRESHOLD + 1000, // 5096
      onDrain: (n) => drained.push(n),
      scheduler,
    });

    // Push 10000 items.
    for (let i = 0; i < 10000; i++) big.push(i);
    assert.equal(big.depth(), 10000);

    // Cycle 1: head moves 0 → 5096. After loop: head=5096, length=10000.
    // Compaction condition: head >= 4096 && head*2 (10192) >= length (10000) → triggers.
    // After compaction: buffer=[5096..9999] (length=4904), head=0.
    scheduled.shift()!();
    assert.equal(drained.length, 5096);
    assert.equal(big.depth(), 4904);

    // Push another 6000 items so we can verify FIFO survived compaction
    // (the compacted buffer's slot 0 was previously slot 5096, so a bug
    // in the head reset would surface as out-of-order or duplicate items).
    for (let i = 10000; i < 16000; i++) big.push(i);
    assert.equal(big.depth(), 4904 + 6000);

    while (scheduled.length > 0) scheduled.shift()!();
    assert.equal(big.depth(), 0);
    assert.equal(drained.length, 16000);
    for (let i = 0; i < 16000; i++) assert.equal(drained[i], i);
  });

  it('does not compact when head*2 < length (live items still dominate)', () => {
    // Cross COMPACTION_HEAD_THRESHOLD on the first cycle, but make the
    // remaining live tail more than half the buffer so compaction is
    // skipped. We verify by checking that pushing more items keeps
    // FIFO across many subsequent cycles.
    drained = [];
    scheduled = [];
    const big = createMatchedItemBuffer<number>({
      drainBatch: COMPACTION_HEAD_THRESHOLD + 100, // 4196
      onDrain: (n) => drained.push(n),
      scheduler,
    });

    // 15000 items: cycle 1 drains 4196, leaving 10804 live with 4196 dead.
    // 4196*2 = 8392 < 15000 → compaction skipped.
    for (let i = 0; i < 15000; i++) big.push(i);
    scheduled.shift()!();
    assert.equal(drained.length, 4196);
    assert.equal(big.depth(), 10804);

    while (scheduled.length > 0) scheduled.shift()!();
    assert.equal(big.depth(), 0);
    assert.equal(drained.length, 15000);
    for (let i = 0; i < 15000; i++) assert.equal(drained[i], i);
  });

  it('handles burst-push interleaved with drain (FIFO preserved)', () => {
    buf.push(1);
    buf.push(2);
    // Drain partial: 1,2 → all
    scheduled.shift()!();
    assert.deepEqual(drained, [1, 2]);

    // Burst-push more
    buf.push(3);
    buf.push(4);
    buf.push(5);
    buf.push(6);
    // Cycle: 3,4,5 → 1 left, re-scheduled
    scheduled.shift()!();
    assert.deepEqual(drained, [1, 2, 3, 4, 5]);
    assert.equal(buf.depth(), 1);

    // Push more during the in-flight cycle
    buf.push(7);
    buf.push(8);
    // Cycle: 6,7,8 → done
    scheduled.shift()!();
    assert.deepEqual(drained, [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(buf.depth(), 0);
  });

  it('rejects invalid drainBatch values', () => {
    assert.throws(
      () =>
        createMatchedItemBuffer({
          drainBatch: 0,
          onDrain: () => {},
        }),
      /must be a positive integer/,
    );
    assert.throws(() =>
      createMatchedItemBuffer({
        drainBatch: -1,
        onDrain: () => {},
      }),
    );
    assert.throws(() =>
      createMatchedItemBuffer({
        drainBatch: 1.5,
        onDrain: () => {},
      }),
    );
    assert.throws(() =>
      createMatchedItemBuffer({
        drainBatch: NaN,
        onDrain: () => {},
      }),
    );
  });

  it('uses setImmediate by default when no scheduler is supplied', async () => {
    let onDrainCalls = 0;
    const def = createMatchedItemBuffer<number>({
      drainBatch: 10,
      onDrain: () => onDrainCalls++,
    });
    def.push(1);
    def.push(2);
    def.push(3);
    // Synchronously: nothing drained yet (setImmediate is async).
    assert.equal(onDrainCalls, 0);
    // After awaiting one event-loop turn, the drainer should have run.
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(onDrainCalls, 3);
  });
});
