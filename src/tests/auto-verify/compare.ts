/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { CanonicalDataItem, Discrepancy } from './types.js';

// Fields available per source
const COMMON_FIELDS: (keyof CanonicalDataItem)[] = [
  'id',
  'parentId',
  'height',
  'ownerAddress',
  'target',
  'anchor',
  'dataSize',
  'contentType',
];

const EXTENDED_FIELDS: (keyof CanonicalDataItem)[] = [
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
const SOURCE_EXCLUDED_FIELDS: Record<string, Set<string>> = {
  'bundle-parser': new Set(['rootParentOffset']),
};

interface SourceData {
  name: string;
  itemsById: Map<string, CanonicalDataItem>;
}

export function compareAllSources(
  sources: { name: string; items: CanonicalDataItem[] }[],
): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];

  const sourceData: SourceData[] = sources.map((s) => ({
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
      sources: counts,
      details: `Data item counts differ across sources`,
    });
  }

  // Phase 2: ID set comparison - find IDs in one source but not another
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
          dataItemId: id,
          sources: { missing: s.name },
          details: `Data item ${id} missing from ${s.name}`,
        });
      }
    }
  }

  // Phase 3: Field-by-field comparison for items present in all sources
  for (const id of allIds) {
    const presentSources = sourceData.filter((s) => s.itemsById.has(id));
    if (presentSources.length < 2) continue;

    // Compare all fields across each pair of sources
    const allFields = [...COMMON_FIELDS, ...EXTENDED_FIELDS];

    for (const field of allFields) {
      const values: Record<string, unknown> = {};
      const comparableSources = presentSources.filter(
        (s) => !SOURCE_EXCLUDED_FIELDS[s.name]?.has(field),
      );

      if (comparableSources.length < 2) continue;

      let mismatch = false;
      let firstValue: unknown = undefined;
      let firstSource: string | undefined;

      for (const s of comparableSources) {
        const item = s.itemsById.get(id)!;
        const value = item[field as keyof CanonicalDataItem];
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
          dataItemId: id,
          field,
          sources: values,
        });
      }
    }

    // Phase 4: Tag comparison
    if (presentSources.length >= 2) {
      const tagDiscrepancies = compareTags(id, presentSources);
      discrepancies.push(...tagDiscrepancies);
    }
  }

  return discrepancies;
}

function compareTags(dataItemId: string, sources: SourceData[]): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];

  const firstSource = sources[0];
  const firstItem = firstSource.itemsById.get(dataItemId)!;
  const firstTags = firstItem.tags;

  for (let i = 1; i < sources.length; i++) {
    const otherSource = sources[i];
    const otherItem = otherSource.itemsById.get(dataItemId)!;
    const otherTags = otherItem.tags;

    // Tag count mismatch
    if (firstTags.length !== otherTags.length) {
      discrepancies.push({
        type: 'tag_mismatch',
        dataItemId,
        sources: {
          [firstSource.name]: firstTags.length,
          [otherSource.name]: otherTags.length,
        },
        details: `Tag count mismatch: ${firstSource.name}=${firstTags.length} vs ${otherSource.name}=${otherTags.length}`,
      });
      continue;
    }

    // Compare individual tags
    for (let j = 0; j < firstTags.length; j++) {
      const t1 = firstTags[j];
      const t2 = otherTags[j];

      if (t1.name !== t2.name) {
        discrepancies.push({
          type: 'tag_mismatch',
          dataItemId,
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
          dataItemId,
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
