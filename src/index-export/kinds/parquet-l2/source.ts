/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * What a `parquet-l2` exporter reads from an index: the data items a
 * selection takes, with their tags and the rows of every nested bundle
 * above them, a window of heights at a time; and, where the source holds
 * L1 rows, where each root transaction sits on the chain.
 *
 * ClickHouse implements it (`clickhouse.ts`). A SQLite (`bundles.db`)
 * source would give the same rows from `stable_data_items`, its tags and
 * `wallets`; it is a follow-up (see docs/index-export.md).
 */
import type { ParquetL2Selection } from '../../../lib/parquet-l2/layout.js';
import type { ItemTag } from '../../../lib/parquet-l2/selection.js';

/**
 * One data item row as the index holds it. Offsets and sizes the index
 * doesn't hold are undefined (ClickHouse stores them as 0, and none of them
 * is 0 when known); `rootParentOffset` and `dataSize` are as stored.
 */
export interface L2SourceRow {
  id: Buffer;
  parentId?: Buffer;
  rootTxId?: Buffer;
  /** The height the index files the row under. Never written: a band takes its root's. */
  height: number;
  offset?: number;
  size?: number;
  dataOffset?: number;
  ownerOffset?: number;
  ownerSize?: number;
  signatureOffset?: number;
  signatureSize?: number;
  rootParentOffset?: number;
  dataSize?: number;
  /** Undefined where the index didn't record it (ClickHouse: 0). */
  signatureType?: number;
  ownerAddress?: Buffer;
  /** The owner's key, where the index keeps it. */
  owner?: Buffer;
  /** Undefined when the item carries none. */
  target?: Buffer;
  anchor?: Buffer;
  /** In tag order. Items only; a bundle row above them needs none. */
  tags?: ItemTag[];
}

/** One window of heights: the selected items, and every bundle above them. */
export interface L2SourceWindow {
  from: number;
  to: number;
  /** Selected items with their source height in `[from, to]`. */
  items: L2SourceRow[];
  /**
   * Rows of the nested bundles the items are in, and the bundles those are
   * in, up to their roots, from the same heights: an item's bundles share
   * its root, so its height.
   */
  ancestors: L2SourceRow[];
}

/** Where a root transaction sits on the chain. */
export interface RootPosition {
  id: Buffer;
  height: number;
  blockTransactionIndex: number;
}

export interface L2ItemSource {
  /** Names the source in reports and logs. */
  readonly name: string;
  /** The highest height the source holds whole. */
  stableHeight(): Promise<number>;
  /** The selected items of `[from, to]`, in windows of ascending heights. */
  windows(
    from: number,
    to: number,
    selection: ParquetL2Selection,
  ): AsyncIterable<L2SourceWindow>;
  /**
   * The source's own L1 rows for these roots in `[from, to]`: every
   * position found, so a root held at two is seen as such. Absent on a
   * source without L1 rows.
   */
  rootPositions?(
    roots: Buffer[],
    from: number,
    to: number,
  ): Promise<RootPosition[]>;
  /** The time of the block at `height`, in seconds, when the source knows it. */
  blockTime?(height: number): Promise<number | undefined>;
  /** Where the source reads (a URL and user), for a fingerprint's identity. */
  readonly identity?: string;
  /**
   * A digest of every row the windows of `[from, to]` read: the selected
   * items, the bundles above them, the L1 rows of their roots. Equal
   * digests mean the same rows. Absent: the exporter digests the windows.
   */
  fingerprint?(
    from: number,
    to: number,
    selection: ParquetL2Selection,
  ): Promise<string>;
  /**
   * How many selected items `[from, to]` holds, for the band size cap: one
   * cheap query, read before a whole range is frozen as one band. Absent:
   * the cap is applied only where band sizes are already known.
   */
  count?(
    from: number,
    to: number,
    selection: ParquetL2Selection,
  ): Promise<number>;
  /** The distinct owner addresses of the selected items of `[from, to]`. */
  owners?(
    from: number,
    to: number,
    selection: ParquetL2Selection,
  ): AsyncIterable<Buffer>;
  close(): Promise<void>;
}
