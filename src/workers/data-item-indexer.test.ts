/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import EventEmitter from 'node:events';
import { afterEach, beforeEach, describe, it } from 'node:test';

import * as metrics from '../metrics.js';
import { DataItemIndexWriter, NormalizedDataItem } from '../types.js';
import { createTestLogger } from '../../test/test-logger.js';
import { DataItemIndexer } from './data-item-indexer.js';

const makeItem = (id: string): NormalizedDataItem =>
  ({
    id,
    parent_id: 'parent',
    root_tx_id: 'root',
  }) as unknown as NormalizedDataItem;

class BlockingIndexWriter implements DataItemIndexWriter {
  release: () => void = () => {};
  saveCalls = 0;
  private gate: Promise<void>;
  constructor() {
    this.gate = new Promise((resolve) => {
      this.release = resolve;
    });
  }
  async saveDataItem(): Promise<void> {
    this.saveCalls++;
    await this.gate;
  }
}

const droppedValue = async (): Promise<number> => {
  const out = await metrics.dataItemsDroppedCounter.get();
  const sample = out.values.find(
    (v) => v.labels.queue_name === 'dataItemIndexer',
  );
  return sample?.value ?? 0;
};

describe('DataItemIndexer', () => {
  const log = createTestLogger({ suite: 'DataItemIndexer' });
  let writer: BlockingIndexWriter;
  let indexer: DataItemIndexer;

  beforeEach(() => {
    metrics.dataItemsDroppedCounter.reset();
    writer = new BlockingIndexWriter();
  });

  afterEach(async () => {
    writer.release();
    await indexer.stop();
  });

  it('drops non-prioritized items when the queue is at maxQueueSize', async () => {
    indexer = new DataItemIndexer({
      log,
      eventEmitter: new EventEmitter(),
      indexWriter: writer,
      workerCount: 1,
      maxQueueSize: 1,
    });
    const before = await droppedValue();

    // 1: admitted; depth=1 (in-flight item counts toward depth).
    await indexer.queueDataItem(makeItem('a'));
    // 2: dropped (depth=1 < maxQueueSize=1 is false).
    await indexer.queueDataItem(makeItem('b'));
    // 3: also dropped.
    await indexer.queueDataItem(makeItem('c'));

    assert.equal(indexer.queueDepth(), 1);
    assert.equal(await droppedValue(), before + 2);
  });

  it('does not drop when maxQueueSize is 0 (unlimited)', async () => {
    indexer = new DataItemIndexer({
      log,
      eventEmitter: new EventEmitter(),
      indexWriter: writer,
      workerCount: 1,
      maxQueueSize: 0,
    });
    const before = await droppedValue();

    for (let i = 0; i < 50; i++) {
      await indexer.queueDataItem(makeItem(`item-${i}`));
    }

    assert.equal(await droppedValue(), before);
    // All 50 counted: 1 in-flight + 49 queued; depth tracks both.
    assert.equal(indexer.queueDepth(), 50);
  });

  it('prioritized items bypass the cap', async () => {
    indexer = new DataItemIndexer({
      log,
      eventEmitter: new EventEmitter(),
      indexWriter: writer,
      workerCount: 1,
      maxQueueSize: 1,
    });
    const before = await droppedValue();

    // 'inflight' admitted; depth=1.
    await indexer.queueDataItem(makeItem('inflight'));
    // 'queued' would be dropped (depth=1 not < 1), so use a prioritized
    // push to confirm it lands via unshift() regardless of cap.
    await indexer.queueDataItem(makeItem('priority'), /* isPrioritized */ true);

    assert.equal(await droppedValue(), before);
    // 'inflight' (running) + 'priority' (queued); depth tracks both.
    assert.equal(indexer.queueDepth(), 2);
  });
});
