/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The grid layout's re-settle gate: a fingerprint of what each source would
 * give for a band's heights, recorded when the band settles and compared
 * when it is due again. Equal fingerprints mean the sources give the same
 * records, and a band rebuilt from its own entries and the same records is
 * the band itself, so it isn't rebuilt.
 *
 * A fingerprint is kept per source and per 5,000-height sub-range of the
 * band, so an `h` rolled from twenty `d` bands takes theirs whole.
 *
 * - ClickHouse: one aggregate query over the rows its record query reads
 *   (see `CLICKHOUSE_FINGERPRINT_QUERY`).
 * - A CSV overlay or a peer's files: the files covering the heights, by
 *   name, size and SHA-256.
 * - Any other source (SQLite): a digest of the records it gives, read in
 *   full but neither built nor compared.
 *
 * Each also carries the source's name, rank and identity (its URL or path)
 * and {@link FINGERPRINT_VERSION}, so a source renamed, re-ranked or pointed
 * elsewhere, or a release that reads rows differently, is a change.
 */
import crypto from 'node:crypto';

import { l1SubRangeOf } from '../../../lib/parquet-l1/layout.js';
import type { BandRecord } from '../../../lib/index-band/build.js';
import type { RecordSource } from './sources/rows.js';

/**
 * Bump when the same rows could give other records: a source's query or
 * row repair, or the band merge. Every band is then rebuilt once.
 */
export const FINGERPRINT_VERSION = 1;

/** One source's fingerprint of a band's heights. */
export interface SourceFingerprint {
  /** Its name, rank and identity. */
  identity: string;
  /** Digests by the start of each 5,000-height sub-range. */
  ranges: Record<string, string>;
}

/** What a band settled against, by source name. */
export interface BandFingerprint {
  version: number;
  sources: Record<string, SourceFingerprint>;
}

/** Why a due band is or isn't rebuilt. */
export type GateVerdict =
  /** Every source gives what it gave when the band settled: not rebuilt. */
  | 'same_sources'
  /** A source's rows, files or settings changed, or one was added or removed. */
  | 'changed'
  /** No fingerprint (adopted, built before this, or under an older version). */
  | 'unrecorded'
  /** Only sources down this run differ: nothing to rebuild with yet. */
  | 'source_down';

/** The 5,000-height sub-ranges of a band's heights. */
export function subRanges(from: number, to: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (let start = from; start <= to; ) {
    const end = Math.min(to, l1SubRangeOf(start)[1]);
    ranges.push([start, end]);
    start = end + 1;
  }
  return ranges;
}

export const sourceIdentity = (source: RecordSource): string =>
  `${source.name} rank ${source.rank} ${source.identity ?? ''}`.trim();

const MASK = (1n << 64n) - 1n;

/**
 * The records a source gives, digested: their count, and the XOR and sum
 * of a hash of every field the band merge reads.
 */
export async function recordsDigest(
  records: AsyncIterable<BandRecord>,
): Promise<string> {
  let count = 0;
  let xor = 0n;
  let sum = 0n;
  for await (const record of records) {
    const hash = crypto
      .createHash('sha256')
      .update(record.id)
      .update(record.rootTxId)
      .update(
        JSON.stringify([
          record.height ?? null,
          record.rootOffset ?? null,
          record.rootDataOffset ?? null,
          record.size ?? null,
          record.rank ?? 0,
          record.coverageTo ?? null,
          record.folded === true,
          record.source ?? null,
          record.sampleTag ?? null,
        ]),
      )
      .digest()
      .readBigUInt64BE(0);
    count += 1;
    xor ^= hash;
    sum = (sum + hash) & MASK;
  }
  return `records ${count} xor ${xor} sum ${sum}`;
}

/** One source's digest of some heights. */
export async function rangeDigest(
  source: RecordSource,
  from: number,
  to: number,
): Promise<string> {
  return source.fingerprint !== undefined
    ? source.fingerprint(from, to)
    : recordsDigest(source.records(from, to));
}

/**
 * Fingerprints a band's heights in every source, sub-range by sub-range.
 * A source that fails is left out and named in `failed`.
 */
export async function fingerprintBand(
  sources: RecordSource[],
  from: number,
  to: number,
): Promise<{ fingerprint: BandFingerprint; failed: Record<string, string> }> {
  const fingerprint: BandFingerprint = {
    version: FINGERPRINT_VERSION,
    sources: {},
  };
  const failed: Record<string, string> = {};
  for (const source of sources) {
    try {
      const ranges: Record<string, string> = {};
      for (const [start, end] of subRanges(from, to)) {
        ranges[start] = await rangeDigest(source, start, end);
      }
      fingerprint.sources[source.name] = {
        identity: sourceIdentity(source),
        ranges,
      };
    } catch (error) {
      failed[source.name] =
        error instanceof Error ? error.message : String(error);
    }
  }
  return { fingerprint, failed };
}

const sameRanges = (a: SourceFingerprint, b: SourceFingerprint) => {
  const keys = Object.keys(a.ranges);
  return (
    a.identity === b.identity &&
    keys.length === Object.keys(b.ranges).length &&
    keys.every((key) => a.ranges[key] === b.ranges[key])
  );
};

/**
 * Compares a band's recorded fingerprint with the sources now.
 *
 * - `unrecorded`: none recorded, or under another version.
 * - `changed`: a source fingerprinted now differs from its record, is not
 *   in it, or could not be fingerprinted; or a recorded source is no longer
 *   configured (one fewer source can settle a conflict).
 * - `source_down`: the only difference is recorded sources that are
 *   configured but down this run. A rebuild without them can only add what
 *   the others give, and they give what they gave.
 * - `same_sources`: every source as recorded.
 */
export function compareFingerprints(
  recorded: BandFingerprint | undefined,
  current: BandFingerprint,
  {
    failed = {},
    down = [],
  }: { failed?: Record<string, string>; down?: string[] } = {},
): { verdict: GateVerdict; detail?: string } {
  if (recorded === undefined) {
    return { verdict: 'unrecorded', detail: 'no fingerprint recorded' };
  }
  if (recorded.version !== current.version) {
    return {
      verdict: 'unrecorded',
      detail: `recorded under fingerprint version ${recorded.version}, now ${current.version}`,
    };
  }
  const changed: string[] = [];
  for (const [name, now] of Object.entries(current.sources)) {
    const was = recorded.sources[name];
    if (was === undefined) changed.push(`${name} is new`);
    else if (!sameRanges(was, now)) changed.push(`${name} changed`);
  }
  for (const [name, error] of Object.entries(failed)) {
    changed.push(`${name} could not be fingerprinted: ${error}`);
  }
  const absent = Object.keys(recorded.sources).filter(
    (name) => current.sources[name] === undefined && failed[name] === undefined,
  );
  const gone = absent.filter((name) => !down.includes(name));
  for (const name of gone) changed.push(`${name} is no longer a source`);
  if (changed.length > 0) {
    return { verdict: 'changed', detail: changed.join('; ') };
  }
  if (absent.length > 0) {
    return { verdict: 'source_down', detail: `${absent.join(', ')} down` };
  }
  return { verdict: 'same_sources' };
}

/**
 * A rolled band's fingerprint, from the bands it was rolled from: each
 * source's sub-ranges together, for the sources every band recorded with
 * one identity under this version. Undefined when one has none.
 */
export function combineFingerprints(
  parts: Array<BandFingerprint | undefined>,
): BandFingerprint | undefined {
  if (
    parts.length === 0 ||
    parts.some(
      (part) => part === undefined || part.version !== FINGERPRINT_VERSION,
    )
  ) {
    return undefined;
  }
  const bands = parts as BandFingerprint[];
  const combined: BandFingerprint = {
    version: FINGERPRINT_VERSION,
    sources: {},
  };
  for (const [name, first] of Object.entries(bands[0].sources)) {
    if (
      bands.every((band) => band.sources[name]?.identity === first.identity)
    ) {
      combined.sources[name] = {
        identity: first.identity,
        ranges: Object.assign(
          {},
          ...bands.map((band) => band.sources[name].ranges),
        ) as Record<string, string>,
      };
    }
  }
  return combined;
}

/** A fingerprint less some sources (ones a build read otherwise than fingerprinted). */
export function withoutSources(
  fingerprint: BandFingerprint,
  names: string[],
): BandFingerprint {
  return {
    version: fingerprint.version,
    sources: Object.fromEntries(
      Object.entries(fingerprint.sources).filter(
        ([name]) => !names.includes(name),
      ),
    ),
  };
}
