/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Parses a `POST /ar-io/admin/prune-stable-data-items` body.
 *
 * Exactly one threshold: `stableAtThreshold` (a `maxStableDataItemStableAt`
 * read before exporting the range) deletes only rows the export saw;
 * `indexedAtThreshold` is kept for older callers. Passing the one given, and
 * only that one, is the whole point: a caller sending `stableAtThreshold`
 * whose value reached the prune as `indexedAtThreshold` would silently get
 * the old, racy behaviour back.
 *
 * Pure (no I/O) so it is unit-testable; the handler maps an error to a 400.
 */
import type { PruneStableDataItemsParams } from '../database/standalone-sqlite.js';

export type PruneStableDataItemsParse =
  | { ok: true; params: PruneStableDataItemsParams }
  | { ok: false; message: string };

const isNonNegativeInteger = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0;

export function parsePruneStableDataItemsParams(
  body: unknown,
): PruneStableDataItemsParse {
  const { indexedAtThreshold, stableAtThreshold, startHeight, endHeight } =
    (body ?? {}) as Record<string, unknown>;

  if (
    (indexedAtThreshold === undefined) ===
    (stableAtThreshold === undefined)
  ) {
    return {
      ok: false,
      message: 'Give exactly one of stableAtThreshold or indexedAtThreshold',
    };
  }
  const [thresholdName, threshold] =
    stableAtThreshold !== undefined
      ? ['stableAtThreshold', stableAtThreshold]
      : ['indexedAtThreshold', indexedAtThreshold];
  if (!isNonNegativeInteger(threshold)) {
    return {
      ok: false,
      message: `Invalid ${thresholdName} - must be a positive integer`,
    };
  }

  if (!isNonNegativeInteger(startHeight)) {
    return {
      ok: false,
      message: 'Invalid startHeight - must be a positive integer',
    };
  }

  if (!isNonNegativeInteger(endHeight) || endHeight < startHeight) {
    return {
      ok: false,
      message:
        'Invalid endHeight - must be a positive integer greater than or equal to startHeight',
    };
  }

  return {
    ok: true,
    params:
      stableAtThreshold !== undefined
        ? { stableAtThreshold: threshold, startHeight, endHeight }
        : { indexedAtThreshold: threshold, startHeight, endHeight },
  };
}
