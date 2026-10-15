/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The `parquet-l2` re-settle gate: the root-TX grid's design
 * (`root-tx/fingerprint.ts`, whose types and comparison it reuses) for an
 * L2 index. A band's heights are fingerprinted per 5,000-height sub-range
 * when it is built from the source, and again when it is due: equal
 * fingerprints mean the same rows, so the same band, and it isn't rebuilt.
 *
 * Per sub-range, the digest covers:
 *
 * - every row the windows read, in one ClickHouse aggregate (the selected
 *   items, the nested bundles above them, the L1 rows of their roots; see
 *   `fingerprintQuery`), or a digest of what the windows give, for a
 *   source without one;
 * - the owners' keys' other source: `bundles.db`'s `wallets` rows for the
 *   band's owners, their count and XOR of hashes.
 *
 * The identity carries the source's name and where it reads, the
 * selection, what places the roots (this publisher's L1 bands by id, or the
 * source's own L1 rows), the `bundles.db` path, and
 * {@link L2_FINGERPRINT_VERSION}. What the gateway serves is not in it:
 * a band with reads it answered 404 is rebuilt now and then anyway
 * (`INDEX_EXPORT_L2_RECHECK_UNREADABLE_EVERY`).
 */
import crypto from 'node:crypto';

import { serializeSelection } from '../../../lib/parquet-l2/layout.js';
import type { ParquetL2Selection } from '../../../lib/parquet-l2/layout.js';
import type { L1PublishedBand } from '../parquet-l1/kind.js';
import { BandFingerprint, subRanges } from '../root-tx/fingerprint.js';
import { coveringL1Bands } from './roots.js';
import type { L2ItemSource } from './source.js';

/** Bump when the same rows could make another band: every band rebuilds once. */
export const L2_FINGERPRINT_VERSION = 1;

const MASK = (1n << 64n) - 1n;
const hash64 = (...parts: Array<Buffer | string>) => {
  const digest = crypto.createHash('sha256');
  for (const part of parts) {
    digest.update(typeof part === 'string' ? Buffer.from(part) : part);
    digest.update('\u0000');
  }
  return digest.digest().readBigUInt64BE(0);
};

/** A source without its own fingerprint: what its windows give, digested. */
async function windowsDigest(
  source: L2ItemSource,
  from: number,
  to: number,
  selection: ParquetL2Selection,
): Promise<string> {
  let count = 0;
  let xor = 0n;
  let sum = 0n;
  const add = (h: bigint) => {
    count += 1;
    xor ^= h;
    sum = (sum + h) & MASK;
  };
  const row = (r: Record<string, unknown>) =>
    JSON.stringify(r, (_, value) =>
      value?.type === 'Buffer' && Array.isArray(value.data)
        ? Buffer.from(value.data).toString('hex')
        : value,
    );
  for await (const window of source.windows(from, to, selection)) {
    for (const item of window.items) add(hash64('item', row({ ...item })));
    for (const bundle of window.ancestors) {
      add(hash64('bundle', row({ ...bundle })));
    }
  }
  return `windows ${count} xor ${xor} sum ${sum}`;
}

/**
 * The owners' keys `bundles.db` holds for the owners of some heights: how
 * many, and the XOR of a hash of each address and key.
 */
async function keysDigest(
  source: L2ItemSource,
  from: number,
  to: number,
  selection: ParquetL2Selection,
  walletsDb: { get: (address: Buffer) => Buffer | undefined } | undefined,
): Promise<string> {
  if (walletsDb === undefined || source.owners === undefined) return 'keys -';
  let count = 0;
  let xor = 0n;
  for await (const address of source.owners(from, to, selection)) {
    const key = walletsDb.get(address);
    if (key === undefined) continue;
    count += 1;
    xor ^= hash64(address, key);
  }
  return `keys ${count} xor ${xor}`;
}

/** What else a band's rows depend on besides the source's rows. */
export function l2Identity(
  source: L2ItemSource,
  {
    selection,
    l1Bands,
    walletsDbPath,
    from,
    to,
  }: {
    selection: ParquetL2Selection;
    l1Bands: L1PublishedBand[];
    walletsDbPath?: string;
    from: number;
    to: number;
  },
): string {
  const covering = coveringL1Bands(l1Bands, from, to);
  return [
    `l2 v${L2_FINGERPRINT_VERSION}`,
    `${source.name} ${source.identity ?? ''}`.trim(),
    `selection ${serializeSelection(selection)}`,
    `roots ${covering !== undefined ? covering.map((b) => b.id).join(',') : 'source'}`,
    `wallets ${walletsDbPath ?? '-'}`,
  ].join('; ');
}

/**
 * Fingerprints a band's heights, sub-range by sub-range. A failure is
 * returned in `failed`, the fingerprint left without the source.
 */
export async function fingerprintL2Band({
  source,
  selection,
  from,
  to,
  l1Bands,
  walletsDbPath,
  walletsDb,
}: {
  source: L2ItemSource;
  selection: ParquetL2Selection;
  from: number;
  to: number;
  l1Bands: L1PublishedBand[];
  walletsDbPath?: string;
  walletsDb?: { get: (address: Buffer) => Buffer | undefined };
}): Promise<{ fingerprint: BandFingerprint; failed: Record<string, string> }> {
  const fingerprint: BandFingerprint = {
    version: L2_FINGERPRINT_VERSION,
    sources: {},
  };
  try {
    const ranges: Record<string, string> = {};
    for (const [start, end] of subRanges(from, to)) {
      const rows =
        source.fingerprint !== undefined
          ? await source.fingerprint(start, end, selection)
          : await windowsDigest(source, start, end, selection);
      const keys = await keysDigest(source, start, end, selection, walletsDb);
      ranges[start] = `${rows}; ${keys}`;
    }
    fingerprint.sources[source.name] = {
      identity: l2Identity(source, {
        selection,
        l1Bands,
        ...(walletsDbPath !== undefined ? { walletsDbPath } : {}),
        from,
        to,
      }),
      ranges,
    };
    return { fingerprint, failed: {} };
  } catch (error) {
    return {
      fingerprint,
      failed: {
        [source.name]: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
