/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import {
  CanonicalBlock,
  CanonicalDataItem,
  CanonicalTag,
  CanonicalTransaction,
  Discrepancy,
} from './types.js';

// Data item fields
const DATA_ITEM_COMMON_FIELDS: (keyof CanonicalDataItem)[] = [
  'id',
  'parentId',
  'height',
  'ownerAddress',
  'target',
  'anchor',
  'dataSize',
  'contentType',
];

const DATA_ITEM_EXTENDED_FIELDS: (keyof CanonicalDataItem)[] = [
  'rootTransactionId',
  'dataOffset',
  'offset',
  'size',
  'ownerOffset',
  'ownerSize',
  'signatureOffset',
  'signatureSize',
  'rootParentOffset',
  'signatureType',
];

// Bundle parser can't determine rootParentOffset from raw data
const DATA_ITEM_SOURCE_EXCLUDED_FIELDS: Record<string, Set<string>> = {
  'bundle-parser': new Set(['rootParentOffset']),
};

// Block fields
const BLOCK_FIELDS: (keyof CanonicalBlock)[] = [
  'indepHash',
  'height',
  'previousBlock',
  'nonce',
  'hash',
  'blockTimestamp',
  'txCount',
  'blockSize',
];

// Transaction fields
const TRANSACTION_FIELDS: (keyof CanonicalTransaction)[] = [
  'id',
  'height',
  'blockTransactionIndex',
  'target',
  'quantity',
  'reward',
  'anchor',
  'dataSize',
  'contentType',
  'format',
  'ownerAddress',
  'dataRoot',
  'offset',
];

interface SourceData<T extends { id: string; tags: CanonicalTag[] }> {
  name: string;
  itemsById: Map<string, T>;
}

function compareItems<T extends { id: string; tags: CanonicalTag[] }>({
  sources,
  fields,
  excludedFields = {},
  entityType,
}: {
  sources: { name: string; items: T[] }[];
  fields: string[];
  excludedFields?: Record<string, Set<string>>;
  entityType: 'data_item' | 'transaction' | 'block';
}): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];
  const entityLabel =
    entityType === 'data_item'
      ? 'Data item'
      : entityType === 'transaction'
        ? 'Transaction'
        : 'Block';

  const sourceData: SourceData<T>[] = sources.map((s) => ({
    name: s.name,
    itemsById: new Map(s.items.map((item) => [item.id, item])),
  }));

  // Phase 1: Count check
  const counts: Record<string, number> = {};
  for (const s of sources) {
    counts[s.name] = s.items.length;
  }
  const uniqueCounts = new Set(Object.values(counts));
  if (uniqueCounts.size > 1) {
    discrepancies.push({
      type: 'count_mismatch',
      entityType,
      sources: counts,
      details: `${entityLabel} counts differ across sources`,
    });
  }

  // Phase 2: ID set comparison
  const allIds = new Set<string>();
  for (const s of sourceData) {
    for (const id of s.itemsById.keys()) {
      allIds.add(id);
    }
  }

  for (const id of allIds) {
    for (const s of sourceData) {
      if (!s.itemsById.has(id)) {
        discrepancies.push({
          type: 'missing_in_source',
          entityType,
          itemId: id,
          sources: { missing: s.name },
          details: `${entityLabel} ${id} missing from ${s.name}`,
        });
      }
    }
  }

  // Phase 3: Field-by-field comparison
  for (const id of allIds) {
    const presentSources = sourceData.filter((s) => s.itemsById.has(id));
    if (presentSources.length < 2) continue;

    for (const field of fields) {
      const comparableSources = presentSources.filter(
        (s) => !excludedFields[s.name]?.has(field),
      );

      if (comparableSources.length < 2) continue;

      const values: Record<string, unknown> = {};
      let mismatch = false;
      let firstValue: unknown = undefined;
      let firstSource: string | undefined;

      for (const s of comparableSources) {
        const item = s.itemsById.get(id)!;
        const value = (item as Record<string, unknown>)[field];
        values[s.name] = value;

        if (firstSource === undefined) {
          firstValue = value;
          firstSource = s.name;
        } else if (!valuesEqual(firstValue, value)) {
          mismatch = true;
        }
      }

      if (mismatch) {
        discrepancies.push({
          type: 'field_mismatch',
          entityType,
          itemId: id,
          field,
          sources: values,
        });
      }
    }

    // Phase 4: Tag comparison
    if (presentSources.length >= 2) {
      const tagDiscrepancies = compareTags(id, entityType, presentSources);
      discrepancies.push(...tagDiscrepancies);
    }
  }

  return discrepancies;
}

export function compareAllSources(
  sources: { name: string; items: CanonicalDataItem[] }[],
): Discrepancy[] {
  return compareItems({
    sources,
    fields: [...DATA_ITEM_COMMON_FIELDS, ...DATA_ITEM_EXTENDED_FIELDS],
    excludedFields: DATA_ITEM_SOURCE_EXCLUDED_FIELDS,
    entityType: 'data_item',
  });
}

export function compareAllTransactions(
  sources: { name: string; items: CanonicalTransaction[] }[],
): Discrepancy[] {
  return compareItems({
    sources,
    fields: [...TRANSACTION_FIELDS],
    entityType: 'transaction',
  });
}

export function compareAllBlocks(
  sources: { name: string; items: CanonicalBlock[] }[],
): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];

  const sourceData = sources.map((s) => ({
    name: s.name,
    blocksByHeight: new Map(s.items.map((b) => [b.height, b])),
  }));

  // Count check
  const counts: Record<string, number> = {};
  for (const s of sources) {
    counts[s.name] = s.items.length;
  }
  if (new Set(Object.values(counts)).size > 1) {
    discrepancies.push({
      type: 'count_mismatch',
      entityType: 'block',
      sources: counts,
      details: 'Block counts differ across sources',
    });
  }

  // Height set comparison
  const allHeights = new Set<number>();
  for (const s of sourceData) {
    for (const h of s.blocksByHeight.keys()) {
      allHeights.add(h);
    }
  }

  for (const height of allHeights) {
    for (const s of sourceData) {
      if (!s.blocksByHeight.has(height)) {
        discrepancies.push({
          type: 'missing_in_source',
          entityType: 'block',
          itemId: String(height),
          sources: { missing: s.name },
          details: `Block at height ${height} missing from ${s.name}`,
        });
      }
    }

    // Field-by-field comparison
    const presentSources = sourceData.filter((s) =>
      s.blocksByHeight.has(height),
    );
    if (presentSources.length < 2) continue;

    for (const field of BLOCK_FIELDS) {
      let mismatch = false;
      let firstValue: unknown = undefined;
      let firstSet = false;
      const values: Record<string, unknown> = {};

      for (const s of presentSources) {
        const block = s.blocksByHeight.get(height)!;
        const value = (block as Record<string, unknown>)[field];
        values[s.name] = value;

        if (!firstSet) {
          firstValue = value;
          firstSet = true;
        } else if (!valuesEqual(firstValue, value)) {
          mismatch = true;
        }
      }

      if (mismatch) {
        discrepancies.push({
          type: 'field_mismatch',
          entityType: 'block',
          itemId: String(height),
          field,
          sources: values,
        });
      }
    }
  }

  return discrepancies;
}

function compareTags<T extends { id: string; tags: CanonicalTag[] }>(
  itemId: string,
  entityType: 'data_item' | 'transaction' | 'block',
  sources: SourceData<T>[],
): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];

  const firstSource = sources[0];
  const firstItem = firstSource.itemsById.get(itemId)!;
  const firstTags = firstItem.tags;

  for (let i = 1; i < sources.length; i++) {
    const otherSource = sources[i];
    const otherItem = otherSource.itemsById.get(itemId)!;
    const otherTags = otherItem.tags;

    if (firstTags.length !== otherTags.length) {
      discrepancies.push({
        type: 'tag_mismatch',
        entityType,
        itemId,
        sources: {
          [firstSource.name]: firstTags.length,
          [otherSource.name]: otherTags.length,
        },
        details: `Tag count mismatch: ${firstSource.name}=${firstTags.length} vs ${otherSource.name}=${otherTags.length}`,
      });
      continue;
    }

    for (let j = 0; j < firstTags.length; j++) {
      const t1 = firstTags[j];
      const t2 = otherTags[j];

      if (t1.name !== t2.name) {
        discrepancies.push({
          type: 'tag_mismatch',
          entityType,
          itemId,
          tagIndex: j,
          field: 'name',
          sources: {
            [firstSource.name]: t1.name,
            [otherSource.name]: t2.name,
          },
        });
      }

      if (t1.value !== t2.value) {
        discrepancies.push({
          type: 'tag_mismatch',
          entityType,
          itemId,
          tagIndex: j,
          field: 'value',
          sources: {
            [firstSource.name]: t1.value,
            [otherSource.name]: t2.value,
          },
        });
      }
    }
  }

  return discrepancies;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  // Handle numeric string vs number comparison
  if (typeof a === 'number' && typeof b === 'string') {
    return a === Number(b);
  }
  if (typeof a === 'string' && typeof b === 'number') {
    return Number(a) === b;
  }
  // Empty string and null are treated as equivalent for optional fields
  if ((a === '' && b === null) || (a === null && b === '')) return true;
  return false;
}
