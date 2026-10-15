/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  itemLayoutValid,
  ItemPlacement,
  LocatableItem,
  locateItem,
  locateParent,
  normaliseHeaderOffsets,
  resolveAmbiguous,
} from './item-location.js';
import { framesItself } from './rows.js';

const ROOT = Buffer.alloc(32, 1);
const BUNDLE = Buffer.alloc(32, 2);
const OUTER = Buffer.alloc(32, 4);
const ID = Buffer.alloc(32, 3);

/**
 * An item of `size` bytes at `offset` with a 200-byte header: signature
 * type, a 65-byte signature, a 65-byte owner, then the rest.
 */
function item(
  offset: number,
  more: Partial<LocatableItem> = {},
  size = 300,
): LocatableItem {
  return {
    id: ID,
    parentId: ROOT,
    rootTxId: ROOT,
    height: 10,
    isDataItem: true,
    offset,
    size,
    dataOffset: offset + 200,
    signatureOffset: offset + 2,
    signatureSize: 65,
    ownerOffset: offset + 67,
    ownerSize: 65,
    dataSize: size - 200,
    rootParentOffset: 0,
    ...more,
  };
}

/** A bundle in the root whose payload is [5000, 15000). */
const inBundle = (
  offset: number,
  more: Partial<LocatableItem> = {},
  size?: number,
) =>
  item(
    offset,
    {
      parentId: BUNDLE,
      parent: {
        parentId: ROOT,
        dataOffset: 5000,
        dataSize: 10_000,
        rootParentOffset: 0,
      },
      ...more,
    },
    size,
  );

const located = (placement: ItemPlacement) => {
  assert.equal(placement.located, true, JSON.stringify(placement));
  return placement as Extract<ItemPlacement, { located: true }>;
};
const reason = (placement: ItemPlacement) => {
  assert.equal(placement.located, false, JSON.stringify(placement));
  return (placement as Extract<ItemPlacement, { located: false }>).reason;
};

describe('locateItem', () => {
  it('places an item directly in its root at base 0', () => {
    const placed = located(locateItem(item(1000)));
    assert.equal(placed.placement, 'top');
    assert.deepEqual(placed.location, {
      rootParentOffset: 0,
      offset: 1000,
      size: 300,
      dataOffset: 1200,
      ownerOffset: 1067,
      ownerSize: 65,
      signatureOffset: 1002,
      signatureSize: 65,
    });
    // A top-level row can't claim its parent's payload starts elsewhere.
    assert.equal(
      reason(locateItem(item(1000, { rootParentOffset: 5 }))),
      'inconsistent',
    );
  });

  it('places a nested item under its parent payload, as the index says it', () => {
    const placed = located(
      locateItem(inBundle(500, { rootParentOffset: 5000 })),
    );
    assert.equal(placed.placement, 'nested');
    assert.equal(placed.location.rootParentOffset, 5000);
    assert.equal(placed.location.offset, 500);
    assert.equal(placed.location.dataOffset, 700);
  });

  it('repairs relative offsets under a root_parent_offset of 0 (#907)', () => {
    const placed = located(locateItem(inBundle(500)));
    assert.equal(placed.placement, 'repaired');
    assert.equal(placed.location.rootParentOffset, 5000);
    assert.equal(placed.location.offset, 500);
  });

  it('writes absolute offsets parent-relative', () => {
    // Read as relative it runs past the payload; as absolute it is inside.
    const placed = located(locateItem(inBundle(14_000, {}, 900)));
    assert.equal(placed.placement, 'absolute');
    assert.deepEqual(placed.location, {
      rootParentOffset: 5000,
      offset: 9000,
      size: 900,
      dataOffset: 9200,
      ownerOffset: 9067,
      ownerSize: 65,
      signatureOffset: 9002,
      signatureSize: 65,
    });
  });

  it('gives both readings of an ambiguous item, for its header to settle', () => {
    const placement = locateItem(inBundle(6000));
    assert.equal(placement.located, 'ambiguous');
    const ambiguous = placement as Extract<
      ItemPlacement,
      { located: 'ambiguous' }
    >;
    assert.equal(ambiguous.headerBytes, 200);
    assert.deepEqual(
      ambiguous.candidates.map((c) => [
        c.reading,
        c.rootOffset,
        c.location.offset,
        c.location.rootParentOffset,
      ]),
      [
        ['relative', 11_000, 6000, 5000],
        ['absolute', 6000, 1000, 5000],
      ],
    );
    const relative = located(resolveAmbiguous(ambiguous, [true, false]));
    assert.equal(relative.placement, 'proven');
    assert.equal(relative.location.offset, 6000);
    const absolute = located(resolveAmbiguous(ambiguous, [false, true]));
    assert.equal(absolute.location.offset, 1000);
    assert.equal(absolute.location.dataOffset, 1200);
    assert.equal(
      reason(resolveAmbiguous(ambiguous, [false, false])),
      'ambiguous',
    );
    assert.equal(
      reason(resolveAmbiguous(ambiguous, [true, true])),
      'ambiguous',
    );
  });

  it('leaves out an ambiguous reading that would put the item before its payload', () => {
    // Relative it doesn't fit the payload; absolute it starts before it.
    const placement = locateItem(
      inBundle(
        4900,
        {
          parent: {
            parentId: ROOT,
            dataOffset: 5000,
            dataSize: 5000,
            rootParentOffset: 0,
          },
        },
        300,
      ),
    );
    assert.equal(placement.located, 'ambiguous');
    const ambiguous = placement as Extract<
      ItemPlacement,
      { located: 'ambiguous' }
    >;
    assert.deepEqual(
      ambiguous.candidates.map((c) => c.reading),
      ['relative'],
    );
  });

  it('refuses a nested item whose root_parent_offset is neither its payload nor 0', () => {
    assert.equal(
      reason(locateItem(inBundle(500, { rootParentOffset: 3 }))),
      'inconsistent',
    );
  });

  it('refuses a nested item whose parent is not in the index', () => {
    assert.equal(
      reason(locateItem(inBundle(500, { parent: undefined }))),
      'no_parent',
    );
    assert.equal(
      reason(
        locateItem(inBundle(500, { parent: { parentId: ROOT, dataSize: 10 } })),
      ),
      'no_parent',
    );
  });

  it('places a deeper item only on an unbroken chain', () => {
    // The parent sits in OUTER, whose payload starts at 5000; the parent's
    // own payload starts 400 into that.
    const deep = (rootParentOffset: number, parentBase: number) =>
      locateItem(
        item(500, {
          parentId: BUNDLE,
          rootParentOffset,
          parent: {
            parentId: OUTER,
            dataOffset: 400,
            dataSize: 10_000,
            rootParentOffset: parentBase,
          },
        }),
      );
    const placed = located(deep(5400, 5000));
    assert.equal(placed.placement, 'deep');
    assert.equal(placed.location.rootParentOffset, 5400);
    assert.equal(placed.location.offset, 500);
    // Broken by a 0 here, or a level up.
    assert.equal(reason(deep(0, 5000)), 'deep');
    assert.equal(reason(deep(5400, 0)), 'deep');
    assert.equal(reason(deep(5401, 5000)), 'deep');
  });

  it('moves item-relative header offsets into the parent payload', () => {
    const placed = located(
      locateItem(item(1000, { signatureOffset: 2, ownerOffset: 67 })),
    );
    assert.equal(placed.normalised, true);
    assert.equal(placed.location.signatureOffset, 1002);
    assert.equal(placed.location.ownerOffset, 1067);
    assert.equal(placed.location.dataOffset, 1200);
    assert.deepEqual(
      normaliseHeaderOffsets({
        offset: 0,
        signatureOffset: 2,
        ownerOffset: 67,
      }),
      { signatureOffset: 2, ownerOffset: 67, normalised: false },
    );
    // Normalised offsets of a repaired item are moved with the rest.
    const repaired = located(
      locateItem(inBundle(500, { signatureOffset: 2, ownerOffset: 67 })),
    );
    assert.equal(repaired.normalised, true);
    assert.equal(repaired.location.signatureOffset, 502);
  });

  it("applies root-TX's shared layout rule: the row of h1123650 that can't frame itself is unlocated", () => {
    // pa77lXKnEMeMCUI1svtQlqaCRv8jGHSNPGGLAqzb2ss: offset 1762, size 1151,
    // data_offset 5543, data_size 3.
    const row = inBundle(1762, {
      size: 1151,
      dataOffset: 5543,
      dataSize: 3,
      signatureOffset: 1764,
      ownerOffset: 1764 + 65,
    });
    assert.equal(framesItself(row, 1762, 5543), false);
    assert.equal(reason(locateItem(row)), 'layout');
  });

  it('leaves unlocated an item whose offsets are unknown or describe no item', () => {
    assert.equal(
      reason(locateItem(item(1000, { size: undefined }))),
      'no_offsets',
    );
    assert.equal(
      reason(locateItem(item(1000, { ownerSize: undefined }))),
      'no_offsets',
    );
    assert.equal(
      reason(locateItem(item(1000, { dataSize: undefined }))),
      'no_offsets',
    );
    // Each rule of the arithmetic.
    assert.equal(reason(locateItem(item(1000, { dataSize: 99 }))), 'layout');
    assert.equal(
      reason(locateItem(item(1000, { signatureOffset: 1003 }))),
      'layout',
    );
    assert.equal(
      reason(locateItem(item(1000, { ownerOffset: 1068 }))),
      'layout',
    );
    assert.equal(
      reason(locateItem(item(1000, { ownerSize: 200, dataSize: 100 }))),
      'layout',
    );
    assert.equal(
      itemLayoutValid(
        {
          offset: 1000,
          size: 0,
          dataOffset: 1000,
          ownerOffset: 1067,
          ownerSize: 65,
          signatureOffset: 1002,
          signatureSize: 65,
        },
        0,
      ),
      false,
    );
    // The layout is checked before placement: an inconsistent row with
    // bad offsets is a layout fault.
    assert.equal(
      reason(locateItem(item(1000, { rootParentOffset: 5, dataSize: 1 }))),
      'layout',
    );
  });
});

describe('locateParent', () => {
  const bundle = (more: Partial<LocatableItem> = {}): LocatableItem => ({
    id: BUNDLE,
    parentId: ROOT,
    rootTxId: ROOT,
    height: 10,
    isDataItem: true,
    offset: 4800,
    size: 10_200,
    dataOffset: 5000,
    dataSize: 10_000,
    rootParentOffset: 0,
    ...more,
  });

  it('locates a bundle placed by placePayload whose sizes add up', () => {
    assert.deepEqual(locateParent(bundle()), {
      located: true,
      location: {
        rootParentOffset: 0,
        offset: 4800,
        size: 10_200,
        dataOffset: 5000,
      },
    });
  });

  it('never proves an ambiguous bundle, and refuses sizes that do not add up', () => {
    const nested = (offset: number) =>
      bundle({
        offset,
        dataOffset: offset + 200,
        size: 1200,
        dataSize: 1000,
        parentId: OUTER,
        parent: {
          parentId: ROOT,
          dataOffset: 300,
          dataSize: 50_000,
          rootParentOffset: 0,
        },
      });
    assert.deepEqual(locateParent(nested(1000)), {
      located: false,
      reason: 'ambiguous',
    });
    // Relative, before the payload's start: repaired, as an item is.
    assert.deepEqual(locateParent(nested(100)), {
      located: true,
      location: {
        rootParentOffset: 300,
        offset: 100,
        size: 1200,
        dataOffset: 300,
      },
    });
    assert.deepEqual(locateParent(bundle({ dataSize: 9999 })), {
      located: false,
      reason: 'layout',
    });
    assert.deepEqual(locateParent(bundle({ size: undefined })), {
      located: false,
      reason: 'no_offsets',
    });
    assert.deepEqual(
      locateParent(bundle({ dataOffset: 4700, size: 300, dataSize: 400 })),
      { located: false, reason: 'layout' },
    );
  });
});
