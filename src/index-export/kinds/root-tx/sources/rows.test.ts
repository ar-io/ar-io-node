/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  isNested,
  ItemRow,
  newSourceStats,
  ParentRow,
  REPAIRED_TAG,
  SourceStats,
  toBandRecord,
} from './rows.js';

const id = (seed: number) => Buffer.alloc(32, seed);
const ROOT = id(1);
const PARENT = id(2);
const ITEM = id(3);

/** A top-level bundle item: payload at 1,000, 50,000 bytes. */
const parent: ParentRow = {
  parentId: ROOT,
  dataOffset: 1000,
  dataSize: 50000,
  rootParentOffset: 0,
};

const nested = (more: Partial<ItemRow> = {}): ItemRow => ({
  id: ITEM,
  parentId: PARENT,
  rootTxId: ROOT,
  height: 500,
  isDataItem: true,
  offset: 200,
  dataOffset: 300,
  size: 400,
  rootParentOffset: 0,
  parent,
  ...more,
});

const place = (row: ItemRow, stats: SourceStats = newSourceStats()) =>
  toBandRecord(row, 'gw1', stats);

describe('toBandRecord', () => {
  it('places a top-level item by its offsets', () => {
    const stats = newSourceStats();
    const record = place(
      {
        ...nested({ parentId: ROOT, parent: undefined }),
        offset: 64,
        dataOffset: 164,
      },
      stats,
    );
    assert.deepEqual(record, {
      id: ITEM,
      rootTxId: ROOT,
      height: 500,
      source: 'gw1',
      rootOffset: 64,
      rootDataOffset: 164,
      size: 400,
    });
    assert.equal(stats.records, 1);
    assert.equal(stats.rowsRead, 1);
  });

  it('uses a root_parent_offset that matches the parent payload', () => {
    const record = place(nested({ rootParentOffset: 1000 }));
    assert.equal(record?.rootOffset, 1200);
    assert.equal(record?.rootDataOffset, 1300);
    assert.equal(record?.sampleTag, undefined);
  });

  it('repairs provably relative offsets (below the payload, and fitting it)', () => {
    const stats = newSourceStats();
    for (const rootParentOffset of [0, undefined]) {
      const record = place(nested({ rootParentOffset }), stats);
      assert.equal(record?.rootOffset, 1200);
      assert.equal(record?.rootDataOffset, 1300);
      assert.equal(record?.sampleTag, REPAIRED_TAG);
    }
    assert.equal(stats.repaired, 2);
  });

  it('repairs relative offsets when the parent payload size is unknown', () => {
    const record = place(
      nested({ parent: { ...parent, dataSize: undefined } }),
    );
    assert.equal(record?.rootOffset, 1200);
  });

  it('keeps provably absolute offsets (on-demand rows) as they are', () => {
    // Inside the payload as absolute; past its end as relative.
    const stats = newSourceStats();
    const record = place(
      nested({ offset: 49800, dataOffset: 49900, size: 400 }),
      stats,
    );
    assert.equal(record?.rootOffset, 49800);
    assert.equal(record?.sampleTag, undefined);
    assert.equal(stats.repaired, 0);
  });

  it('gives the root only when the offsets could be either, or neither', () => {
    const stats = newSourceStats();
    const rows: ItemRow[] = [
      // Fits as relative and as absolute.
      nested({ offset: 2000, dataOffset: 2100 }),
      // Below the payload, but as relative it runs past the payload's end
      // (payload 2,000 + 1,500; item 1,000 + 800).
      nested({
        offset: 1000,
        dataOffset: 1100,
        size: 800,
        parent: { ...parent, dataOffset: 2000, dataSize: 1500 },
      }),
      // As absolute, it runs past the payload's end.
      nested({ offset: 50900, dataOffset: 51000, size: 400 }),
      // Absolute can't be proven without both sizes.
      nested({ offset: 49800, dataOffset: 49900, size: undefined }),
      nested({
        offset: 49800,
        dataOffset: 49900,
        parent: { ...parent, dataSize: undefined },
      }),
    ];
    for (const row of rows) {
      const record = place(row, stats);
      assert.ok(record !== undefined, 'the root is kept');
      assert.equal(record.rootOffset, undefined);
      assert.ok(record.rootTxId.equals(ROOT));
    }
    assert.deepEqual(stats.unrepaired, { ambiguous: 5 });
    assert.equal(stats.rootOnly, 5);
    assert.equal(stats.records, 5);
  });

  it('gives the root only when the parent is unknown', () => {
    const stats = newSourceStats();
    place(nested({ parent: undefined }), stats);
    place(nested({ parent: { ...parent, dataOffset: undefined } }), stats);
    place(nested({ parentId: undefined, parent: undefined }), stats);
    assert.deepEqual(stats.unrepaired, { no_parent: 3 });
  });

  it('gives the root only for a root_parent_offset that matches nothing', () => {
    const stats = newSourceStats();
    // Nested one level, neither the payload offset nor 0.
    place(nested({ rootParentOffset: 777 }), stats);
    // Top-level, but not 0.
    place(
      nested({ parentId: ROOT, rootParentOffset: 64, parent: undefined }),
      stats,
    );
    assert.deepEqual(stats.unrepaired, { inconsistent: 2 });
  });

  it('trusts deeper nesting only along an unbroken chain', () => {
    // G (top-level, payload at 1,000) > P (payload at 300 within G's) > Q.
    const deepParent: ParentRow = {
      parentId: id(9),
      dataOffset: 300,
      dataSize: 5000,
      rootParentOffset: 1000,
    };
    const stats = newSourceStats();
    const chained = place(
      nested({ parent: deepParent, rootParentOffset: 1300 }),
      stats,
    );
    assert.equal(chained?.rootOffset, 1500);
    // #907 zeroed P's root_parent_offset, so Q's 0 + 300 misses G's 1,000.
    const broken = place(
      nested({
        parent: { ...deepParent, rootParentOffset: 0 },
        rootParentOffset: 300,
      }),
      stats,
    );
    assert.equal(broken?.rootOffset, undefined);
    const zero = place(
      nested({ parent: deepParent, rootParentOffset: 0 }),
      stats,
    );
    assert.equal(zero?.rootOffset, undefined);
    assert.deepEqual(stats.unrepaired, { deep: 2 });
  });

  it('gives the root only without offsets', () => {
    const stats = newSourceStats();
    const record = place(
      nested({ offset: undefined, dataOffset: undefined }),
      stats,
    );
    assert.equal(record?.rootOffset, undefined);
    assert.equal(stats.rootOnly, 1);
    assert.deepEqual(stats.unrepaired, {});
  });

  it('leaves out rows the band builder would refuse, by reason', () => {
    const stats = newSourceStats();
    const rows: ItemRow[] = [
      nested({ isDataItem: false }),
      nested({ rootTxId: undefined }),
      nested({ rootTxId: Buffer.alloc(8) }),
      nested({ rootTxId: ITEM }),
      nested({ size: 0 }),
    ];
    for (const row of rows) assert.equal(place(row, stats), undefined);
    assert.deepEqual(stats.dropped, {
      not_data_item: 1,
      no_root: 2,
      root_is_item: 1,
      zero_size: 1,
    });
    assert.equal(stats.records, 0);
    assert.equal(stats.rowsRead, 5);
  });
});

describe('isNested', () => {
  it('is true when the parent is not the root', () => {
    assert.equal(isNested(nested()), true);
    assert.equal(isNested(nested({ parentId: ROOT })), false);
    assert.equal(isNested(nested({ parentId: undefined })), false);
  });
});
