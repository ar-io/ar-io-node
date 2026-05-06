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
import {
  ContiguousDataIndex,
  NestedDataIndexWriter,
  NormalizedDataItem,
} from '../types.js';
import { createTestLogger } from '../../test/test-logger.js';
import { Ans104DataIndexer } from './ans104-data-indexer.js';

const makeItem = (id: string): NormalizedDataItem =>
  ({
    id,
    parent_id: 'parent',
    root_tx_id: 'root',
    data_offset: 0,
    data_size: 1,
    offset: 0,
    size: 1,
    data_hash: 'hash',
  }) as unknown as NormalizedDataItem;

class BlockingNestedWriter implements NestedDataIndexWriter {
  release: () => void = () => {};
  private gate: Promise<void>;
  constructor() {
    this.gate = new Promise((resolve) => {
      this.release = resolve;
    });
  }
  async saveNestedDataId(): Promise<void> {
    await this.gate;
  }
  async saveNestedDataHash(): Promise<void> {
    await this.gate;
  }
}

class BlockingContiguousIndex implements Partial<ContiguousDataIndex> {
  release: () => void = () => {};
  private gate: Promise<void>;
  constructor() {
    this.gate = new Promise((resolve) => {
      this.release = resolve;
    });
  }
  async saveDataContentAttributes(): Promise<void> {
    await this.gate;
  }
}

const droppedValue = async (): Promise<number> => {
  const out = await metrics.dataItemsDroppedCounter.get();
  const sample = out.values.find(
    (v) => v.labels.queue_name === 'ans104DataIndexer',
  );
  return sample?.value ?? 0;
};

describe('Ans104DataIndexer', () => {
  const log = createTestLogger({ suite: 'Ans104DataIndexer' });
  let writer: BlockingNestedWriter;
  let contiguousDataIndex: BlockingContiguousIndex;
  let indexer: Ans104DataIndexer;

  beforeEach(() => {
    metrics.dataItemsDroppedCounter.reset();
    writer = new BlockingNestedWriter();
    contiguousDataIndex = new BlockingContiguousIndex();
  });

  afterEach(async () => {
    writer.release();
    contiguousDataIndex.release();
    await indexer.stop();
  });

  it('drops items when the queue is at maxQueueSize', async () => {
    indexer = new Ans104DataIndexer({
      log,
      eventEmitter: new EventEmitter(),
      indexWriter: writer,
      contiguousDataIndex:
        contiguousDataIndex as unknown as ContiguousDataIndex,
      workerCount: 1,
      maxQueueSize: 1,
    });
    const before = await droppedValue();

    // Worker pulls 'a' immediately and blocks inside saveDataContentAttributes.
    await indexer.queueDataItem(makeItem('a'));
    // Length=0 (worker has 'a' in flight) → 0<1 OK → 'b' queues, length=1.
    await indexer.queueDataItem(makeItem('b'));
    // Length=1 → 1<1 false → 'c' dropped.
    await indexer.queueDataItem(makeItem('c'));
    // Length=1 → 'd' also dropped.
    await indexer.queueDataItem(makeItem('d'));

    assert.equal(indexer.queueDepth(), 1);
    assert.equal(await droppedValue(), before + 2);
  });

  it('does not drop when maxQueueSize is 0 (unlimited)', async () => {
    indexer = new Ans104DataIndexer({
      log,
      eventEmitter: new EventEmitter(),
      indexWriter: writer,
      contiguousDataIndex:
        contiguousDataIndex as unknown as ContiguousDataIndex,
      workerCount: 1,
      maxQueueSize: 0,
    });
    const before = await droppedValue();

    for (let i = 0; i < 50; i++) {
      await indexer.queueDataItem(makeItem(`item-${i}`));
    }

    assert.equal(await droppedValue(), before);
    // Worker has one item in flight; the rest sit in queue.
    assert.equal(indexer.queueDepth(), 49);
  });
});
