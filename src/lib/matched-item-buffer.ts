/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Buffer + scheduled drainer for high-rate cross-thread firehoses
 * (originally the `ANS104_DATA_ITEM_MATCHED` flow under bundle ingest).
 *
 * Why this exists: an unbundler worker thread can post thousands of
 * matched-item messages per second when processing 15k-item bundles.
 * Doing the per-item indexer enqueue work synchronously inside the
 * `eventEmitter` handler monopolizes the JS thread and starves other
 * I/O (HTTP, GraphQL, SQLite-worker replies), wedging fastq drain
 * (PE-9089 incident on 2026-05-08).
 *
 * Pushes are O(1). Items are processed in batches via the supplied
 * scheduler (production: `setImmediate`). The scheduler boundary
 * between batches gives the event loop a chance to service everything
 * else.
 *
 * The buffer uses a moving head pointer rather than `splice(0, n)` per
 * drain so each drain is O(batch), not O(buffer.length). Compaction is
 * amortized: a single `splice` reclaims dead slots only when the head
 * crosses `COMPACTION_HEAD_THRESHOLD` AND those dead slots account for
 * at least half the buffer length. Net work per drained item stays
 * bounded.
 *
 * Lives in its own module so tests can exercise the drain/compaction
 * logic without booting `system.ts` and the entire gateway. See
 * `matched-item-buffer.test.ts`.
 */

export interface MatchedItemBuffer<T> {
  /** Append an item; schedule a drain if one isn't already pending. */
  push(item: T): void;
  /** Number of items still waiting to be drained (excludes already-drained). */
  depth(): number;
}

/** Head must cross this before we'll consider compacting dead slots. */
export const COMPACTION_HEAD_THRESHOLD = 4096;

/**
 * Default scheduler. Wrapped in a thunk so tests don't have to mock
 * `setImmediate` itself; they can pass a synchronous capturing scheduler
 * via `opts.scheduler` instead.
 */
const defaultScheduler = (cb: () => void): void => {
  setImmediate(cb);
};

export function createMatchedItemBuffer<T>(opts: {
  /** Maximum items to dispatch to `onDrain` per scheduled drain cycle. */
  drainBatch: number;
  /** Called for each item in FIFO order during a drain. */
  onDrain: (item: T) => void;
  /** Drain scheduler. Defaults to `setImmediate`. Override for tests. */
  scheduler?: (cb: () => void) => void;
}): MatchedItemBuffer<T> {
  if (!Number.isInteger(opts.drainBatch) || opts.drainBatch <= 0) {
    throw new Error(
      `drainBatch must be a positive integer; got ${opts.drainBatch}`,
    );
  }
  const schedule = opts.scheduler ?? defaultScheduler;
  const buffer: T[] = [];
  let head = 0;
  let scheduled = false;

  const drain = (): void => {
    scheduled = false;
    const drainUntil = Math.min(buffer.length, head + opts.drainBatch);
    for (; head < drainUntil; head++) {
      opts.onDrain(buffer[head]);
    }

    if (head === buffer.length) {
      // Fully drained — reset both pointers cheaply, no memmove.
      buffer.length = 0;
      head = 0;
    } else if (head >= COMPACTION_HEAD_THRESHOLD && head * 2 >= buffer.length) {
      // Reclaim dead slots at the front. Single splice amortized across
      // many prior drains; net cost stays O(1) per drained item.
      buffer.splice(0, head);
      head = 0;
    }

    if (head < buffer.length) {
      scheduled = true;
      schedule(drain);
    }
  };

  return {
    push(item: T): void {
      buffer.push(item);
      if (!scheduled) {
        scheduled = true;
        schedule(drain);
      }
    },
    depth(): number {
      return buffer.length - head;
    },
  };
}
