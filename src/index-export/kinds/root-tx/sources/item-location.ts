/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Where a data item sits in its root transaction, as a `parquet-l2` band
 * locates it: the root-TX placement rules ({@link placePayload}, the same
 * function, so both indexes place an item alike) plus what an L2 band's
 * eight location columns need on top:
 *
 * - **Item-relative header offsets.** Some rows hold `signature_offset` 2
 *   and an `owner_offset` counted from the item's own start; with an
 *   `offset` other than 0 they are moved into the parent's payload, like
 *   the rest ({@link normaliseHeaderOffsets}). `data_offset` already is.
 * - **The layout arithmetic.** An item is located only when its offsets
 *   describe one ANS-104 item: a size, a payload that ends where the item
 *   does, the signature 2 bytes in, the owner right after it and the
 *   payload after the owner ({@link itemLayoutValid}). Anything else, and
 *   every reason {@link placePayload} gives, leaves all eight columns null.
 * - **Parent-relative output.** A band stores offsets into the payload of
 *   the item's parent bundle and `root_parent_offset`, where that payload
 *   starts in the root. A row the index holds with absolute offsets (placed
 *   at base 0 though nested) is written the same way as a row holding
 *   relative ones: `root_parent_offset` is the parent's payload start and
 *   the offsets are less it. Two publishers holding the item either way
 *   write the same row.
 * - **Ambiguous rows** (nested one level, `root_parent_offset` 0 or unknown,
 *   and neither reading excluded by the sizes) come back with both
 *   candidate readings, for a header read from the root to decide
 *   ({@link resolveAmbiguous}).
 */
import {
  isNested,
  ItemRow,
  PayloadPlacement,
  placePayload,
  UnrepairedReason,
} from './rows.js';

/** An item's location as a band stores it: bytes into its parent's payload. */
export interface ItemLocation {
  /** Where the parent's payload starts in the root transaction's data. */
  rootParentOffset: number;
  offset: number;
  size: number;
  dataOffset: number;
  ownerOffset: number;
  ownerSize: number;
  signatureOffset: number;
  signatureSize: number;
}

/** A nested bundle's location, as a band's `parents` table stores it. */
export interface ParentLocation {
  rootParentOffset: number;
  offset: number;
  size: number;
  dataOffset: number;
}

/**
 * A data item as an index holds it, for locating it: the fields
 * {@link placePayload} reads, and its header's. Unknown values are
 * undefined.
 */
export interface LocatableItem extends ItemRow {
  ownerOffset?: number;
  ownerSize?: number;
  signatureOffset?: number;
  signatureSize?: number;
  /** The payload's size. */
  dataSize?: number;
}

/** Why an item is written without a location. */
export type UnlocatedReason =
  | UnrepairedReason
  /** An offset or size the index doesn't hold. */
  | 'no_offsets'
  /** Offsets that don't describe one data item. */
  | 'layout'
  /** Its parent bundle sits in two places in the root: which is unknown. */
  | 'parent_two_places'
  /** Ambiguous, and its root couldn't be read to settle it (a 404). */
  | 'unproven';

/** How a located item's offsets were placed. */
export type PlacementClass =
  /** Directly in the root. */
  | 'top'
  /** Nested, `root_parent_offset` as the index holds it. */
  | 'nested'
  /** Nested, relative offsets under a `root_parent_offset` of 0 (#907). */
  | 'repaired'
  /** Nested, absolute offsets: written parent-relative. */
  | 'absolute'
  /** Nested deeper, on an unbroken chain. */
  | 'deep'
  /** Ambiguous, settled by reading its header from the root. */
  | 'proven';

/** One reading of an ambiguous item's offsets. */
export interface AmbiguousCandidate {
  /** `relative`: from the parent's payload; `absolute`: from the root's data. */
  reading: 'relative' | 'absolute';
  /** Where the item's header starts in the root's data, read this way. */
  rootOffset: number;
  location: ItemLocation;
}

export type ItemPlacement =
  | {
      located: true;
      location: ItemLocation;
      placement: PlacementClass;
      /** Its header offsets were item-relative and were moved. */
      normalised: boolean;
    }
  | { located: false; reason: UnlocatedReason; normalised: boolean }
  | {
      located: 'ambiguous';
      /** The readings left once negative offsets are ruled out. */
      candidates: AmbiguousCandidate[];
      /** The header's length, the same either way. */
      headerBytes: number;
      normalised: boolean;
    };

/**
 * Header offsets counted from the item's own start, moved into its parent's
 * payload: a `signature_offset` of exactly 2 (the signature follows the
 * 2-byte signature type) with an `offset` other than 0 can only be
 * item-relative, since no item starts at 0 in a bundle's payload (its item
 * count and index come first). `data_offset` is parent-relative already.
 */
export function normaliseHeaderOffsets({
  offset,
  signatureOffset,
  ownerOffset,
}: {
  offset: number;
  signatureOffset: number;
  ownerOffset: number;
}): { signatureOffset: number; ownerOffset: number; normalised: boolean } {
  if (signatureOffset === 2 && offset !== 0) {
    return {
      signatureOffset: signatureOffset + offset,
      ownerOffset: ownerOffset + offset,
      normalised: true,
    };
  }
  return { signatureOffset, ownerOffset, normalised: false };
}

/**
 * Whether offsets describe one ANS-104 data item: a size, the payload ending
 * where the item does, the signature right after the 2-byte signature type,
 * the owner right after the signature, and the payload after the owner.
 * The same in any frame, so it is checked before an item is placed.
 */
export function itemLayoutValid(
  item: Omit<ItemLocation, 'rootParentOffset'>,
  dataSize: number,
): boolean {
  return (
    item.size > 0 &&
    item.dataOffset + dataSize === item.offset + item.size &&
    item.signatureOffset === item.offset + 2 &&
    item.ownerOffset === item.signatureOffset + item.signatureSize &&
    item.dataOffset >= item.ownerOffset + item.ownerSize
  );
}

/**
 * Where the payload of a placed row's parent starts in the root's data: 0
 * for the root itself, the parent's `data_offset` one level down (the
 * parent is in the root, so its offsets are the root's), and the proven
 * base deeper.
 */
export function payloadStart(row: ItemRow, placed: PayloadPlacement): number {
  if (!isNested(row)) return 0;
  const parent = row.parent;
  if (
    parent?.parentId !== undefined &&
    row.rootTxId !== undefined &&
    parent.parentId.equals(row.rootTxId) &&
    parent.dataOffset !== undefined
  ) {
    return parent.dataOffset;
  }
  return placed.base;
}

function classOf(row: ItemRow, placed: PayloadPlacement): PlacementClass {
  if (!isNested(row)) return 'top';
  const parent = row.parent;
  const oneLevel =
    parent?.parentId !== undefined &&
    row.rootTxId !== undefined &&
    parent.parentId.equals(row.rootTxId);
  if (!oneLevel) return 'deep';
  if (placed.repaired) return 'repaired';
  return placed.base === 0 ? 'absolute' : 'nested';
}

/** Offsets moved by `delta` under a payload that starts at `start`. */
function shifted(
  local: Omit<ItemLocation, 'rootParentOffset'>,
  start: number,
  delta: number,
): ItemLocation {
  return {
    rootParentOffset: start,
    offset: local.offset + delta,
    size: local.size,
    dataOffset: local.dataOffset + delta,
    ownerOffset: local.ownerOffset + delta,
    ownerSize: local.ownerSize,
    signatureOffset: local.signatureOffset + delta,
    signatureSize: local.signatureSize,
  };
}

/**
 * Locates a data item in its root, or says why it can't be, or, for an
 * ambiguous row, gives both readings for a header read to settle
 * ({@link resolveAmbiguous}). The checks, in order: every offset known,
 * header offsets normalised, the layout arithmetic, then
 * {@link placePayload}.
 */
export function locateItem(item: LocatableItem): ItemPlacement {
  const {
    offset,
    size,
    dataOffset,
    ownerOffset,
    ownerSize,
    signatureOffset,
    signatureSize,
    dataSize,
  } = item;
  if (
    offset === undefined ||
    size === undefined ||
    dataOffset === undefined ||
    ownerOffset === undefined ||
    ownerSize === undefined ||
    signatureOffset === undefined ||
    signatureSize === undefined ||
    dataSize === undefined
  ) {
    return { located: false, reason: 'no_offsets', normalised: false };
  }
  const header = normaliseHeaderOffsets({
    offset,
    signatureOffset,
    ownerOffset,
  });
  const { normalised } = header;
  const local = {
    offset,
    size,
    dataOffset,
    ownerOffset: header.ownerOffset,
    ownerSize,
    signatureOffset: header.signatureOffset,
    signatureSize,
  };
  if (!itemLayoutValid(local, dataSize)) {
    return { located: false, reason: 'layout', normalised };
  }
  const placed = placePayload(item, offset);
  if (placed === 'ambiguous') {
    // Only an item one level down is ambiguous, and only with its parent's
    // payload offset known.
    const start = item.parent?.dataOffset as number;
    const candidates: AmbiguousCandidate[] = [
      {
        reading: 'relative' as const,
        rootOffset: start + offset,
        location: shifted(local, start, 0),
      },
      {
        reading: 'absolute' as const,
        rootOffset: offset,
        location: shifted(local, start, -start),
      },
    ].filter((candidate) => candidate.location.offset >= 0);
    return {
      located: 'ambiguous',
      candidates,
      headerBytes: dataOffset - offset,
      normalised,
    };
  }
  if (typeof placed === 'string') {
    return { located: false, reason: placed, normalised };
  }
  const start = payloadStart(item, placed);
  return {
    located: true,
    location: shifted(local, start, placed.base - start),
    placement: classOf(item, placed),
    normalised,
  };
}

/**
 * Settles an ambiguous item by its header reads: `matches[i]` says whether
 * the header read at `candidates[i].rootOffset` is the item's (its id, and
 * `headerBytes` long). Exactly one match locates it; none, or both, leave it
 * unlocated.
 */
export function resolveAmbiguous(
  placement: Extract<ItemPlacement, { located: 'ambiguous' }>,
  matches: boolean[],
): Exclude<ItemPlacement, { located: 'ambiguous' }> {
  const matched = placement.candidates.filter((_, i) => matches[i] === true);
  if (matched.length !== 1) {
    return {
      located: false,
      reason: 'ambiguous',
      normalised: placement.normalised,
    };
  }
  return {
    located: true,
    location: matched[0].location,
    placement: 'proven',
    normalised: placement.normalised,
  };
}

/**
 * Locates a nested bundle for a band's `parents` table: placed by
 * {@link placePayload} (never by reading its header), and located only when
 * it has a size, its payload ends where it does, and its payload starts at
 * or after its start. Written parent-relative, as an item is.
 */
export function locateParent(
  row: LocatableItem,
):
  | { located: true; location: ParentLocation }
  | { located: false; reason: UnlocatedReason } {
  const { offset, size, dataOffset, dataSize } = row;
  if (
    offset === undefined ||
    size === undefined ||
    dataOffset === undefined ||
    dataSize === undefined
  ) {
    return { located: false, reason: 'no_offsets' };
  }
  if (
    !(
      size > 0 &&
      dataOffset + dataSize === offset + size &&
      dataOffset >= offset
    )
  ) {
    return { located: false, reason: 'layout' };
  }
  const placed = placePayload(row, offset);
  if (typeof placed === 'string') return { located: false, reason: placed };
  const start = payloadStart(row, placed);
  const delta = placed.base - start;
  return {
    located: true,
    location: {
      rootParentOffset: start,
      offset: offset + delta,
      size,
      dataOffset: dataOffset + delta,
    },
  };
}
