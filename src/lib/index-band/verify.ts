/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import pLimit from 'p-limit';

import { decodeDataItemHeader } from '../ans104-bundle-scan.js';
import { ByteRangeSource } from '../byte-range-source.js';
import {
  getRootTxId,
  isCompleteValue,
  isPathCompleteValue,
} from '../cdb64-encoding.js';
import { toB64Url } from '../encoding.js';
import { createAgentPair } from '../http-agent.js';
import {
  createRangeHttpClient,
  HttpByteRangeSource,
  ShortRangeReadError,
} from '../http-byte-range-source.js';
import { MAX_HEADER_BYTES, Reservoir } from './build.js';
import type { BandSampleEntry } from './build.js';
import { bandEntries, readBandManifest } from './read.js';

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
  /** Root reads in flight at once (default 8). */
  concurrency?: number;
  /**
   * Further tries of a read that failed in transport (a timeout, a 429, a
   * 5xx), with a growing pause (default 2): a brief outage at the gateway
   * shouldn't leave the band unchecked. A wrong offset is never retried.
   */
  retries?: number;
  /** Pause before the first retry, doubling after (default 2,000 ms). */
  retryDelayMs?: number;
}

export interface HeaderCheckResult {
  passed: boolean;
  /** Why the check failed; empty when it passed. */
  reasons: string[];
  totalRecords: number;
  checked: number;
  ok: number;
  /** Entries whose header names another ID or ends somewhere else. */
  wrong: Array<{ id: string; reason: string; tag?: string }>;
  /** Entries that couldn't be checked (read failed, unknown signature type). */
  errors: Array<{ id: string; error: string; tag?: string }>;
  /**
   * The counts per sample tag (`''` for the general sample), so a check
   * over stratified samples can say which stratum failed.
   */
  byTag: Record<string, { checked: number; ok: number; wrong: number }>;
}

/**
 * Checks a band's offsets against the bytes they point at before it is
 * published.
 *
 * For each entry, the item header is read from the root transaction at
 * `rootOffset`, exactly `rootDataOffset - rootOffset` bytes. It passes when
 * the header decodes to exactly that length and its signature hashes to the
 * entry's ID. It is wrong when the bytes aren't a data item header (an
 * unknown signature type included), the header has another length or ID, or
 * the range runs past the root (416). Only a transport failure (a timeout, a
 * 5xx, a root the gateway can't find) leaves an entry unchecked.
 *
 * The band passes when no entry is wrong, at least `minOkRatio` of the
 * checked entries pass (an unchecked entry counts against it), and the band
 * holds at least `minRecords` entries: a signed band of wrong offsets would be
 * evidence against its publisher.
 *
 * Limits: only entries with offsets are checked, so a root-only entry's
 * `rootTxId` is not; nor is an item's size, which would need the whole item.
 */
export async function checkBandHeaders({
  entries,
  totalRecords,
  openRoot,
  minOkRatio = 0.8,
  minRecords = 1000,
  concurrency = 8,
  retries = 2,
  retryDelayMs = 2000,
}: HeaderCheckOptions): Promise<HeaderCheckResult> {
  const wrong: HeaderCheckResult['wrong'] = [];
  const errors: HeaderCheckResult['errors'] = [];
  let ok = 0;
  const byTag: HeaderCheckResult['byTag'] = {};
  const stratum = (entry: BandSampleEntry) =>
    (byTag[entry.tag ?? ''] ??= { checked: 0, ok: 0, wrong: 0 });
  const tagOf = (entry: BandSampleEntry) =>
    entry.tag !== undefined ? { tag: entry.tag } : {};
  for (const entry of entries) stratum(entry).checked += 1;

  const limit = pLimit(concurrency);
  await Promise.all(
    entries.map((entry) =>
      limit(async () => {
        const headerBytes = entry.rootDataOffset - entry.rootOffset;
        if (headerBytes <= 0 || headerBytes > MAX_HEADER_BYTES) {
          stratum(entry).wrong += 1;
          wrong.push({
            ...tagOf(entry),
            id: entry.id,
            reason: `offsets give a ${headerBytes}-byte header`,
          });
          return;
        }
        const source = openRoot(entry.rootTxId);
        let bytes: Buffer;
        try {
          bytes = await readWithRetries(
            () => source.read(entry.rootOffset, headerBytes),
            retries,
            retryDelayMs,
          );
        } catch (error) {
          // A range the root doesn't have means the offsets are wrong: a 416
          // when it starts past the end, or a trimmed (short) 206 when it
          // starts inside and runs past it. Anything else (a timeout, a 5xx,
          // a root the gateway can't find) means it couldn't be checked.
          if (
            error instanceof ShortRangeReadError ||
            (error as { response?: { status?: number } }).response?.status ===
              416
          ) {
            stratum(entry).wrong += 1;
            wrong.push({
              ...tagOf(entry),
              id: entry.id,
              reason: 'offsets run past the end of the root transaction',
            });
          } else {
            errors.push({
              ...tagOf(entry),
              id: entry.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          return;
        } finally {
          await source.close().catch(() => undefined);
        }

        let decoded: ReturnType<typeof decodeDataItemHeader>;
        try {
          decoded = decodeDataItemHeader(bytes);
        } catch (error) {
          // Bytes that don't decode as a header, an unknown signature type
          // included, are the commonest sign of a wrong offset: the first two
          // bytes of a payload are almost never a signature type.
          stratum(entry).wrong += 1;
          wrong.push({
            ...tagOf(entry),
            id: entry.id,
            reason: `no data item header at rootOffset: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
          return;
        }

        if (!decoded.complete) {
          stratum(entry).wrong += 1;
          wrong.push({
            ...tagOf(entry),
            id: entry.id,
            reason: `header runs past rootDataOffset (needs ${decoded.needBytes} bytes, offsets give ${headerBytes})`,
          });
        } else if (decoded.header.headerSize !== headerBytes) {
          stratum(entry).wrong += 1;
          wrong.push({
            ...tagOf(entry),
            id: entry.id,
            reason: `header is ${decoded.header.headerSize} bytes, offsets give ${headerBytes}`,
          });
        } else if (decoded.header.id !== entry.id) {
          stratum(entry).wrong += 1;
          wrong.push({
            ...tagOf(entry),
            id: entry.id,
            reason: `header at rootOffset is item ${decoded.header.id}`,
          });
        } else {
          ok += 1;
          stratum(entry).ok += 1;
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
  // When entries are wrong, that is the reason; the pass ratio adds nothing.
  if (wrong.length === 0 && checked > 0 && ok / checked < minOkRatio) {
    // Say why: an entry the gateway couldn't serve isn't a wrong one, and
    // the usual cause is a gateway that has to fetch the roots itself.
    const unchecked =
      errors.length > 0
        ? `; ${errors.length} could not be read from the gateway (most often: ${mostCommon(errors.map((e) => e.error))}), so try a gateway that has these root transactions`
        : '';
    reasons.push(
      `${ok} of ${checked} checked entries passed, under ${Math.round(minOkRatio * 100)}%${unchecked}`,
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
    byTag,
  };
}

/** A range that runs past the root: the offsets are wrong, not the network. */
const isWrongRange = (error: unknown) =>
  error instanceof ShortRangeReadError ||
  (error as { response?: { status?: number } }).response?.status === 416;

async function readWithRetries(
  read: () => Promise<Buffer>,
  retries: number,
  delayMs: number,
): Promise<Buffer> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (attempt >= retries || isWrongRange(error)) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, delayMs * 2 ** attempt),
      );
    }
  }
}

function mostCommon(values: string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
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
  const manifest = await readBandManifest(bandDir);
  const sample = new Reservoir<BandSampleEntry>(size, random);
  for await (const { key, value } of bandEntries(bandDir, manifest)) {
    if (!isCompleteValue(value) && !isPathCompleteValue(value)) continue;
    sample.offer({
      id: toB64Url(key),
      rootTxId: toB64Url(getRootTxId(value)),
      rootOffset: value.rootDataItemOffset,
      rootDataOffset: value.rootDataOffset,
    });
  }
  return { entries: sample.items, totalRecords: manifest.totalRecords };
}

/**
 * Reads root transactions through a gateway's `/raw/:id` range requests,
 * sharing one HTTP client (and its keep-alive connections) across every root.
 * Call `close` when done, or the idle connections keep the process alive.
 */
export function gatewayRootSource(
  gatewayUrl: string,
  timeoutMs = 30000,
): { openRoot: RootSourceFactory; close: () => void } {
  const base = gatewayUrl.replace(/\/+$/, '');
  const agents = createAgentPair({ client: 'index-band-verify' });
  const httpClient = createRangeHttpClient(timeoutMs, agents);
  return {
    openRoot: (rootTxId) =>
      new HttpByteRangeSource({ url: `${base}/raw/${rootTxId}`, httpClient }),
    close: () => {
      agents.httpAgent.destroy();
      agents.httpsAgent.destroy();
    },
  };
}
