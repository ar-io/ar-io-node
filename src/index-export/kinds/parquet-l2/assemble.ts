/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Turns one window of a source's rows into what a `parquet-l2` band holds,
 * short of the roots' positions on the chain (the exporter's to assign):
 * each selected item with its tags, the columns it derives from them, and
 * its location in its root (`item-location.ts`); every located nested
 * bundle between it and its root; and its owner, for `wallets`.
 *
 * A nested bundle is looked up by id within the item's root. When the
 * index holds it more than once there, the copies are compared by where
 * they place it: one place, and its children are placed under it; two, and
 * its children are left unlocated (`parent_two_places`), since which one
 * holds them is unknown. None (every copy of the parent's row is
 * inconsistent), and its children are left unlocated too (`no_parent`): a
 * band never locates an item under a parent `parents` does not describe.
 */
import {
  AmbiguousCandidate,
  ItemLocation,
  ItemPlacement,
  LocatableItem,
  locateItem,
  locateParent,
  ParentLocation,
  PlacementClass,
  resolveAmbiguous,
  UnlocatedReason,
} from '../root-tx/sources/item-location.js';
import type { ParentRow } from '../root-tx/sources/rows.js';
import { BandTag, firstTagValue } from '../../../lib/parquet-l1/layout.js';
import type { ItemTag } from './selection.js';
import type { L2SourceRow, L2SourceWindow } from './source.js';
import type { KeyCandidate } from './wallets.js';

const ID_BYTES = 32;

/** A selected item, ready for its root's position. */
export interface AssembledItem {
  id: Buffer;
  rootTxId: Buffer;
  parentId: Buffer;
  /** The height the source filed it under: where to look for its root first. */
  sourceHeight: number;
  ownerAddress: Buffer;
  target: Buffer | null;
  anchor: Buffer | null;
  signatureType: number | null;
  dataSize: number;
  contentType: string | null;
  contentEncoding: string | null;
  tags: ItemTag[];
  location: ItemLocation | null;
  /** Set when unlocated. */
  unlocated?: UnlocatedReason;
  /** Set when located. */
  placement?: PlacementClass;
  normalised: boolean;
  /** The owner's key as the source row holds it. */
  ownerKey?: Buffer;
}

/** A located nested bundle, for `parents`. */
export interface AssembledParent {
  id: Buffer;
  rootTxId: Buffer;
  location: ParentLocation;
}

/** Rows a window holds that no band can take: the band is refused over them. */
export interface RowFaults {
  /** Selected items without a 32-byte root id. */
  noRoot: string[];
  /** Selected items without a 32-byte parent id or owner address. */
  badRow: string[];
  /** Rows the source gave that the selection doesn't take. */
  notSelected: string[];
}

export interface AssembledWindow {
  items: AssembledItem[];
  parents: AssembledParent[];
  /** Selected items whose root is the item itself: not data items. */
  rootIsItem: number;
  faults: RowFaults;
  /** Ambiguous items, by how their header reads settled them. */
  proofs: L2Proofs;
}

/**
 * Ambiguous items, by how their header reads settled them: located as
 * `relative` or `absolute`; left unlocated when `none` or `both` readings
 * are the item's header, or `unproven` when the root couldn't be read (a
 * 404).
 */
export interface L2Proofs {
  relative: number;
  absolute: number;
  none: number;
  both: number;
  unproven: number;
}

/**
 * Reads a header from a root: whether the bytes at `rootOffset` are item
 * `id`'s, or `unreadable` when the gateway has no such root.
 */
export type HeaderProbe = (
  rootTxId: Buffer,
  rootOffset: number,
  headerBytes: number,
  id: Buffer,
) => Promise<boolean | 'unreadable'>;

const hex = (bytes: Buffer) => bytes.toString('hex');
const key = (id: Buffer, root: Buffer) => `${hex(id)}:${hex(root)}`;
const nullIfEmpty = (bytes: Buffer | undefined) =>
  bytes === undefined || bytes.length === 0 ? null : bytes;

/** ClickHouse's 0 for a missing number, as `undefined`, for placePayload. */
const knownNumber = (value: number | undefined) =>
  value === undefined || value === 0 ? undefined : value;

/** What a row's placement reads of its own fields, for comparing copies. */
const rawPlace = (row: L2SourceRow) =>
  JSON.stringify([
    row.parentId?.toString('hex') ?? null,
    row.offset ?? null,
    row.size ?? null,
    row.dataOffset ?? null,
    row.dataSize ?? null,
    row.rootParentOffset ?? null,
  ]);

const placeKey = (location: ParentLocation) =>
  `${location.rootParentOffset}:${location.offset}:${location.size}:${location.dataOffset}`;

/** A nested bundle as one root holds it: its copies, and where they place it. */
interface BundleInRoot {
  /** The copy its children are placed under; undefined when not in the index. */
  row?: L2SourceRow;
  /** Its distinct located places. */
  places: ParentLocation[];
}

/**
 * The nested bundles of one window, by id within a root, placed level by
 * level up to the root, each once.
 */
class Bundles {
  private readonly copies = new Map<string, L2SourceRow[]>();
  private readonly placed = new Map<string, BundleInRoot>();

  constructor(ancestors: L2SourceRow[]) {
    for (const row of ancestors) {
      if (row.rootTxId === undefined) continue;
      const k = key(row.id, row.rootTxId);
      const held = this.copies.get(k) ?? [];
      // Copies that differ only in what placement doesn't read are one.
      if (!held.some((other) => rawPlace(other) === rawPlace(row))) {
        held.push(row);
      }
      this.copies.set(k, held);
    }
    for (const held of this.copies.values()) {
      held.sort((a, b) => (rawPlace(a) < rawPlace(b) ? -1 : 1));
    }
  }

  /** The bundle `id` in `root`, placed, or not in the index. */
  get(id: Buffer, root: Buffer, depth = 0): BundleInRoot {
    const k = key(id, root);
    const done = this.placed.get(k);
    if (done !== undefined) return done;
    // A cycle or a chain past any real nesting: not placeable.
    if (depth > 64) return { places: [] };
    // Held while placing, so a cycle ends here.
    this.placed.set(k, { places: [] });
    const copies = this.copies.get(k) ?? [];
    const located: Array<{ row: L2SourceRow; location: ParentLocation }> = [];
    for (const row of copies) {
      const result = locateParent(this.locatable(row, root, depth));
      if (result.located) located.push({ row, location: result.location });
    }
    const places = [
      ...new Map(
        located.map((l) => [placeKey(l.location), l.location]),
      ).values(),
    ];
    const bundle: BundleInRoot = {
      // One copy, or the first that places it where every placed copy does.
      row: copies.length === 1 ? copies[0] : (located[0]?.row ?? copies[0]),
      places,
    };
    this.placed.set(k, bundle);
    return bundle;
  }

  /** A row with its parent's copy, as `placePayload` reads it. */
  locatable(row: L2SourceRow, root: Buffer, depth: number): LocatableItem {
    const item: LocatableItem = {
      id: row.id,
      parentId: row.parentId,
      rootTxId: root,
      height: row.height,
      isDataItem: true,
      offset: row.offset,
      dataOffset: row.dataOffset,
      size: row.size,
      rootParentOffset: row.rootParentOffset,
      ownerOffset: row.ownerOffset,
      ownerSize: row.ownerSize,
      signatureOffset: row.signatureOffset,
      signatureSize: row.signatureSize,
      dataSize: row.dataSize,
    };
    if (row.parentId !== undefined && !row.parentId.equals(root)) {
      const parent = this.get(row.parentId, root, depth + 1).row;
      if (parent !== undefined) item.parent = parentRow(parent);
    }
    return item;
  }
}

/** A bundle's row as `placePayload` reads a parent: 0 is unknown, as root-TX reads it. */
function parentRow(row: L2SourceRow): ParentRow {
  return {
    parentId: row.parentId,
    dataOffset: knownNumber(row.dataOffset),
    dataSize: knownNumber(row.dataSize),
    rootParentOffset: row.rootParentOffset,
  };
}

/**
 * Assembles a window: locates every selected item (settling ambiguous ones
 * with `probe`, in parallel as it allows), derives its tag columns, and
 * gathers the located bundles above it.
 */
export async function assembleWindow(
  window: L2SourceWindow,
  {
    selected,
    probe,
  }: {
    /** The selection, checked again on every row the source gives. */
    selected: (tags: readonly ItemTag[]) => boolean;
    probe: HeaderProbe;
  },
): Promise<AssembledWindow> {
  const bundles = new Bundles(window.ancestors);
  const faults: RowFaults = { noRoot: [], badRow: [], notSelected: [] };
  const proofs: L2Proofs = {
    relative: 0,
    absolute: 0,
    none: 0,
    both: 0,
    unproven: 0,
  };
  const items: AssembledItem[] = [];
  const parents = new Map<string, AssembledParent>();
  let rootIsItem = 0;
  const pending: Array<Promise<void>> = [];

  for (const row of window.items) {
    const name = row.id.toString('base64url');
    const tags = row.tags ?? [];
    if (!selected(tags)) {
      faults.notSelected.push(name);
      continue;
    }
    const root = row.rootTxId;
    if (root === undefined || root.length !== ID_BYTES) {
      faults.noRoot.push(name);
      continue;
    }
    if (root.equals(row.id)) {
      rootIsItem += 1;
      continue;
    }
    if (
      row.parentId === undefined ||
      row.parentId.length !== ID_BYTES ||
      row.ownerAddress === undefined ||
      row.ownerAddress.length !== ID_BYTES
    ) {
      faults.badRow.push(name);
      continue;
    }

    const nested = !row.parentId.equals(root);
    const parent = nested ? bundles.get(row.parentId, root) : undefined;
    let placement: ItemPlacement = locateItem(bundles.locatable(row, root, 0));
    if (
      parent !== undefined &&
      parent.places.length > 1 &&
      placement.located !== false
    ) {
      placement = {
        located: false,
        reason: 'parent_two_places',
        normalised: placement.normalised,
      };
    }

    const bandTags: BandTag[] = tags.map((tag, index) => ({
      index,
      name: tag.name,
      value: tag.value,
    }));
    const item: AssembledItem = {
      id: row.id,
      rootTxId: root,
      parentId: row.parentId,
      sourceHeight: row.height,
      ownerAddress: row.ownerAddress,
      target: nullIfEmpty(row.target),
      anchor: nullIfEmpty(row.anchor),
      signatureType: row.signatureType ?? null,
      dataSize: row.dataSize ?? 0,
      contentType: firstTagValue(bandTags, 'Content-Type'),
      contentEncoding: firstTagValue(bandTags, 'Content-Encoding'),
      tags,
      location: null,
      normalised: placement.normalised,
      ...(row.owner !== undefined ? { ownerKey: row.owner } : {}),
    };
    items.push(item);

    const settle = (
      settled: Exclude<ItemPlacement, { located: 'ambiguous' }>,
    ) => {
      if (!settled.located) {
        item.unlocated = settled.reason;
        return;
      }
      // A nested item can be placed from its own row (an absolute offset)
      // while its parent bundle cannot be placed at all: every copy of the
      // parent's row is inconsistent (offsets taken from another copy of
      // the bundle, the #937 class). The band would then locate the item
      // under a parent `parents` does not describe, which a reader cannot
      // check. It is left unlocated as `no_parent` until the parent's row
      // is repaired; a resettle then locates it.
      if (nested && (parent === undefined || parent.places.length === 0)) {
        item.unlocated = 'no_parent';
        return;
      }
      item.location = settled.location;
      item.placement = settled.placement;
    };
    if (placement.located === 'ambiguous') {
      const ambiguous = placement;
      pending.push(
        (async () => {
          const matches = await Promise.all(
            ambiguous.candidates.map((candidate: AmbiguousCandidate) =>
              probe(root, candidate.rootOffset, ambiguous.headerBytes, row.id),
            ),
          );
          // The root unreadable (a 404): neither reading can be told.
          if (matches.includes('unreadable')) {
            proofs.unproven += 1;
            settle({
              located: false,
              reason: 'unproven',
              normalised: ambiguous.normalised,
            });
            return;
          }
          const read = matches as boolean[];
          const matched = ambiguous.candidates.filter((_, i) => read[i]);
          if (matched.length === 1) proofs[matched[0].reading] += 1;
          else if (matched.length === 0) proofs.none += 1;
          else proofs.both += 1;
          settle(resolveAmbiguous(ambiguous, read));
        })(),
      );
    } else {
      settle(placement);
    }

    // Every located bundle between the item and its root, once.
    let at = row.parentId;
    for (let depth = 0; depth < 64 && !at.equals(root); depth++) {
      const bundle = bundles.get(at, root);
      for (const location of bundle.places) {
        const k = `${key(at, root)}:${placeKey(location)}`;
        if (!parents.has(k)) {
          parents.set(k, { id: at, rootTxId: root, location });
        }
      }
      if (bundle.row?.parentId === undefined) break;
      at = bundle.row.parentId;
    }
  }
  await Promise.all(pending);
  return {
    items,
    parents: [...parents.values()],
    rootIsItem,
    faults,
    proofs,
  };
}

/** Where a located item's owner key sits in its root's data. */
export function keyCandidate(item: AssembledItem): KeyCandidate | undefined {
  const location = item.location;
  if (location === null) return undefined;
  return {
    rootTxId: item.rootTxId,
    offset: location.rootParentOffset + location.ownerOffset,
    size: location.ownerSize,
  };
}
