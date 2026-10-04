/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * What every root-TX record source shares: the {@link RecordSource}
 * contract, and turning an indexed data item row into a band record,
 * repairing its offsets only where the repair can be proven.
 */
import type { BandRecord } from '../../../../lib/index-band/build.js';

/** One source of band records for the root-TX index. */
export interface RecordSource {
  /** Names the source in conflicts, metrics and logs. */
  name: string;
  /** 1 for an overlay (authoritative within its coverage), 0 for a peer. */
  rank: 0 | 1;
  /** Highest height the source holds. Overlays don't take part in the run's minimum. */
  stableHeight(): Promise<number>;
  /**
   * Records with `from <= height <= to`. One per id per height: an item
   * re-bundled at another height may come again (the band merge keeps the
   * later root), so `sameSourceDuplicates` can be nonzero for a source.
   */
  records(from: number, to: number): AsyncIterable<BandRecord>;
  /**
   * What the source has given and left out since it was opened; open a
   * source per run for per-run counts.
   */
  readonly stats: SourceStats;
  /** Releases connections or handles. */
  close(): Promise<void>;
}

/** Why a source left a row out. */
export type DropReason =
  /** Not a data item (an L1 transaction). */
  | 'not_data_item'
  /** No root transaction, or not a 32-byte one. */
  | 'no_root'
  /** The root is the item itself. */
  | 'root_is_item'
  /** A size of zero. */
  | 'zero_size'
  /** An overlay row without a height. */
  | 'no_height'
  /** An overlay row outside the coverage of the file it came from. */
  | 'outside_coverage';

/** Why a record was given with its root only, its offsets unproven. */
export type UnrepairedReason =
  /** Nested, with `root_parent_offset` 0: could be relative or absolute. */
  | 'ambiguous'
  /** Nested, and the parent isn't in the index. */
  | 'no_parent'
  /** A `root_parent_offset` that doesn't match the parent's. */
  | 'inconsistent'
  /** Nested more than one level, without a consistent chain to prove it. */
  | 'deep';

export interface SourceStats {
  /** Rows read from the source. */
  rowsRead: number;
  /** Records given. */
  records: number;
  /** Records given without offsets, unrepaired ones included. */
  rootOnly: number;
  /** Records whose relative offsets were proven and repaired. */
  repaired: number;
  /** Records given root-only because their offsets couldn't be proven, by reason. */
  unrepaired: Partial<Record<UnrepairedReason, number>>;
  /** Rows left out, by reason. */
  dropped: Partial<Record<DropReason, number>>;
}

export const newSourceStats = (): SourceStats => ({
  rowsRead: 0,
  records: 0,
  rootOnly: 0,
  repaired: 0,
  unrepaired: {},
  dropped: {},
});

export function countDrop(stats: SourceStats, reason: DropReason): void {
  stats.dropped[reason] = (stats.dropped[reason] ?? 0) + 1;
}

/** The sample tag of a record whose offsets were repaired. */
export const REPAIRED_TAG = 'repaired';

/**
 * A data item as an index holds it. `offset` and `dataOffset` are relative to
 * the parent's payload; `rootParentOffset` is where that payload starts in
 * the root transaction's data. Unknown values are undefined.
 */
export interface ItemRow {
  id: Buffer;
  parentId?: Buffer;
  rootTxId?: Buffer;
  height: number;
  isDataItem: boolean;
  /** The item's offset, header included. */
  offset?: number;
  /** The item's payload offset. */
  dataOffset?: number;
  /** The whole item, header and payload. */
  size?: number;
  rootParentOffset?: number;
  /** The parent's row, for a nested item; undefined if not in the index. */
  parent?: ParentRow;
}

/** The parent of a nested item, as the index holds it. */
export interface ParentRow {
  parentId?: Buffer;
  dataOffset?: number;
  /** The parent's payload size. */
  dataSize?: number;
  rootParentOffset?: number;
}

const ID_BYTES = 32;

/** Whether a row is nested: its parent is a bundle inside the root. */
export function isNested(row: ItemRow): boolean {
  return (
    row.parentId !== undefined &&
    row.rootTxId !== undefined &&
    !row.parentId.equals(row.rootTxId)
  );
}

/**
 * Turns a row into a band record, or leaves it out and counts why.
 *
 * Offsets are placed in the root only when the row proves where its
 * parent's payload starts; otherwise the record carries its root alone
 * (counted in `unrepaired`), which the band merge never gives offsets from
 * another root.
 *
 * - **Top-level** (the parent is the root): `rootParentOffset` must be 0 or
 *   unknown.
 * - **Nested one level** (the parent is top-level): the payload starts at
 *   `parent.dataOffset`. A `rootParentOffset` equal to it is used. One of 0
 *   or unknown may hold relative offsets (unbundled before ar-io-node #907
 *   was fixed) or absolute ones (resolved on demand), so the item is tested
 *   against its parent's payload, `[P, P + parent.dataSize)` with
 *   `P = parent.dataOffset`:
 *   - **relative** when `offset < P` (an absolute offset lies inside the
 *     payload) and, read as relative, the item fits the payload: repaired to
 *     `P + offset`, tagged {@link REPAIRED_TAG};
 *   - **absolute** when, read as absolute, the item lies inside the payload
 *     and, read as relative, it would run past it: kept;
 *   - anything else is `ambiguous`.
 * - **Nested deeper:** used only when the parent's own `rootParentOffset` is
 *   set and this one equals it plus `parent.dataOffset`, the chain the
 *   unbundler writes; #907 broke that chain with a 0 a level up.
 */
export function toBandRecord(
  row: ItemRow,
  source: string,
  stats: SourceStats,
): BandRecord | undefined {
  stats.rowsRead += 1;
  const drop = (reason: DropReason) => {
    countDrop(stats, reason);
    return undefined;
  };
  if (!row.isDataItem) return drop('not_data_item');
  const { rootTxId } = row;
  if (rootTxId === undefined || rootTxId.length !== ID_BYTES) {
    return drop('no_root');
  }
  if (rootTxId.equals(row.id)) return drop('root_is_item');
  if (row.size === 0) return drop('zero_size');

  const record: BandRecord = {
    id: row.id,
    rootTxId,
    height: row.height,
    source,
  };
  stats.records += 1;
  const { offset, dataOffset } = row;
  if (offset === undefined || dataOffset === undefined) {
    stats.rootOnly += 1;
    return record;
  }
  const placed = placePayload(row, offset);
  if (typeof placed === 'string') {
    stats.unrepaired[placed] = (stats.unrepaired[placed] ?? 0) + 1;
    stats.rootOnly += 1;
    return record;
  }
  if (placed.repaired) {
    record.sampleTag = REPAIRED_TAG;
    stats.repaired += 1;
  }
  record.rootOffset = placed.base + offset;
  record.rootDataOffset = placed.base + dataOffset;
  if (row.size !== undefined) record.size = row.size;
  return record;
}

/**
 * Where a row's offsets start in the root, or why that can't be proven.
 */
function placePayload(
  row: ItemRow,
  offset: number,
): { base: number; repaired: boolean } | UnrepairedReason {
  const rpo = row.rootParentOffset;
  if (row.parentId === undefined) return 'no_parent';
  if (!isNested(row)) {
    return rpo === undefined || rpo === 0
      ? { base: 0, repaired: false }
      : 'inconsistent';
  }
  const { parent } = row;
  if (parent === undefined || parent.parentId === undefined) {
    return 'no_parent';
  }
  if (parent.dataOffset === undefined) return 'no_parent';
  const payload = parent.dataOffset;

  if (row.rootTxId !== undefined && !parent.parentId.equals(row.rootTxId)) {
    // Deeper: trust only an unbroken chain.
    const parentBase = parent.rootParentOffset;
    return parentBase !== undefined &&
      parentBase > 0 &&
      rpo === parentBase + payload
      ? { base: rpo, repaired: false }
      : 'deep';
  }

  if (rpo === payload) return { base: payload, repaired: false };
  if (rpo !== undefined && rpo !== 0) return 'inconsistent';

  const size = row.size;
  const dataSize = parent.dataSize;
  const fitsRelative =
    size === undefined || dataSize === undefined || offset + size <= dataSize;
  if (offset < payload && fitsRelative) {
    return { base: payload, repaired: true };
  }
  if (
    size !== undefined &&
    dataSize !== undefined &&
    dataSize > 0 &&
    offset >= payload &&
    offset + size <= payload + dataSize &&
    offset + size > dataSize
  ) {
    return { base: 0, repaired: false };
  }
  return 'ambiguous';
}
