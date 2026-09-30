/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import pLimit from 'p-limit';

import {
  decodeDataItemHeader,
  UnsupportedSignatureTypeError,
} from '../ans104-bundle-scan.js';
import { ByteRangeSource } from '../byte-range-source.js';
import { Cdb64Reader } from '../cdb64.js';
import {
  decodeCdb64Value,
  getRootTxId,
  isCompleteValue,
  isPathCompleteValue,
} from '../cdb64-encoding.js';
import { parseManifest } from '../cdb64-manifest.js';
import { toB64Url } from '../encoding.js';
import { HttpByteRangeSource } from '../http-byte-range-source.js';
import type { BandSampleEntry } from './build.js';

/** Opens the data of a root transaction for range reads. */
export type RootSourceFactory = (rootTxId: string) => ByteRangeSource;

export interface HeaderCheckOptions {
  /** Entries with offsets to check, e.g. {@link BuiltBand.sample}. */
  entries: BandSampleEntry[];
  /** Entries in the band, for the minimum-size rule. */
  totalRecords: number;
  openRoot: RootSourceFactory;
  /** Share of checked entries that must pass (default 0.8). */
  minOkRatio?: number;
  /** Smallest band worth publishing (default 1,000 entries). */
  minRecords?: number;
  concurrency?: number;
}

export interface HeaderCheckResult {
  passed: boolean;
  /** Why the check failed; empty when it passed. */
  reasons: string[];
  totalRecords: number;
  checked: number;
  ok: number;
  /** Entries whose header names another ID or ends somewhere else. */
  wrong: Array<{ id: string; reason: string }>;
  /** Entries that couldn't be checked (read failed, unknown signature type). */
  errors: Array<{ id: string; error: string }>;
}

// A header this long is not a data item header: signature, owner, target,
// anchor and tags together are at most a few kilobytes in practice.
const MAX_HEADER_BYTES = 1024 * 1024;

/**
 * Checks a band's offsets against the bytes they point at before it is
 * published.
 *
 * For each entry, the item header is read from the root transaction at
 * `rootOffset`, exactly `rootDataOffset - rootOffset` bytes. It passes when
 * the header decodes to exactly that length and its signature hashes to the
 * entry's ID. The band passes when no entry is wrong, at least `minOkRatio`
 * of the checked entries pass (a read that fails counts against it), and the
 * band holds at least `minRecords` entries: a signed band of wrong offsets
 * would be evidence against its publisher.
 */
export async function checkBandHeaders({
  entries,
  totalRecords,
  openRoot,
  minOkRatio = 0.8,
  minRecords = 1000,
  concurrency = 8,
}: HeaderCheckOptions): Promise<HeaderCheckResult> {
  const wrong: HeaderCheckResult['wrong'] = [];
  const errors: HeaderCheckResult['errors'] = [];
  let ok = 0;

  const limit = pLimit(concurrency);
  await Promise.all(
    entries.map((entry) =>
      limit(async () => {
        const headerBytes = entry.rootDataOffset - entry.rootOffset;
        if (headerBytes <= 0 || headerBytes > MAX_HEADER_BYTES) {
          wrong.push({
            id: entry.id,
            reason: `offsets give a ${headerBytes}-byte header`,
          });
          return;
        }
        const source = openRoot(entry.rootTxId);
        let bytes: Buffer;
        try {
          bytes = await source.read(entry.rootOffset, headerBytes);
        } catch (error) {
          errors.push({
            id: entry.id,
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        } finally {
          await source.close().catch(() => undefined);
        }

        let decoded: ReturnType<typeof decodeDataItemHeader>;
        try {
          decoded = decodeDataItemHeader(bytes);
        } catch (error) {
          // An unknown signature type can't be checked; anything else means
          // the bytes at rootOffset are not a data item header.
          if (error instanceof UnsupportedSignatureTypeError) {
            errors.push({ id: entry.id, error: error.message });
          } else {
            wrong.push({
              id: entry.id,
              reason: `no data item header at rootOffset: ${
                error instanceof Error ? error.message : String(error)
              }`,
            });
          }
          return;
        }

        if (!decoded.complete) {
          wrong.push({
            id: entry.id,
            reason: `header runs past rootDataOffset (needs ${decoded.needBytes} bytes, offsets give ${headerBytes})`,
          });
        } else if (decoded.header.headerSize !== headerBytes) {
          wrong.push({
            id: entry.id,
            reason: `header is ${decoded.header.headerSize} bytes, offsets give ${headerBytes}`,
          });
        } else if (decoded.header.id !== entry.id) {
          wrong.push({
            id: entry.id,
            reason: `header at rootOffset is item ${decoded.header.id}`,
          });
        } else {
          ok += 1;
        }
      }),
    ),
  );

  const checked = entries.length;
  const reasons: string[] = [];
  if (totalRecords < minRecords) {
    reasons.push(`band has ${totalRecords} entries, fewer than ${minRecords}`);
  }
  if (checked === 0) {
    reasons.push('no entries with offsets to check');
  }
  if (wrong.length > 0) {
    reasons.push(`${wrong.length} of ${checked} checked entries are wrong`);
  }
  if (checked > 0 && ok / checked < minOkRatio) {
    reasons.push(
      `${ok} of ${checked} checked entries passed, under ${Math.round(minOkRatio * 100)}%`,
    );
  }

  return {
    passed: reasons.length === 0,
    reasons,
    totalRecords,
    checked,
    ok,
    wrong,
    errors,
  };
}

/**
 * Draws a uniform sample of entries with offsets from a band on disk, for
 * checking a band that was not just built. Reads every partition once.
 */
export async function sampleBandEntries(
  bandDir: string,
  size: number,
  random: () => number = Math.random,
): Promise<{ entries: BandSampleEntry[]; totalRecords: number }> {
  const manifest = parseManifest(
    await fs.readFile(path.join(bandDir, 'manifest.json'), 'utf8'),
  );
  const entries: BandSampleEntry[] = [];
  let seen = 0;
  for (const partition of manifest.partitions) {
    if (partition.location.type !== 'file') {
      throw new Error(
        `Partition ${partition.prefix} is not a local file; only local bands can be checked`,
      );
    }
    const reader = new Cdb64Reader(
      path.join(bandDir, partition.location.filename),
    );
    await reader.open();
    try {
      for await (const { key, value } of reader.entries()) {
        const decoded = decodeCdb64Value(value);
        if (!isCompleteValue(decoded) && !isPathCompleteValue(decoded)) {
          continue;
        }
        const entry = {
          id: toB64Url(key),
          rootTxId: toB64Url(getRootTxId(decoded)),
          rootOffset: decoded.rootDataItemOffset,
          rootDataOffset: decoded.rootDataOffset,
        };
        seen += 1;
        if (entries.length < size) {
          entries.push(entry);
        } else {
          const slot = Math.floor(random() * seen);
          if (slot < size) entries[slot] = entry;
        }
      }
    } finally {
      await reader.close();
    }
  }
  return { entries, totalRecords: manifest.totalRecords };
}

/** Reads root transactions through a gateway's `/raw/:id` range requests. */
export function gatewayRootSource(
  gatewayUrl: string,
  timeoutMs = 30000,
): RootSourceFactory {
  const base = gatewayUrl.replace(/\/+$/, '');
  return (rootTxId) =>
    new HttpByteRangeSource({
      url: `${base}/raw/${rootTxId}`,
      timeout: timeoutMs,
    });
}
