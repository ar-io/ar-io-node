/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
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
import { NotOnNodesError } from '../onchain/arweave-nodes.js';
import { MAX_HEADER_BYTES, Reservoir } from './build.js';
import type { BandSampleEntry } from './build.js';
import { bandEntries, readBandManifest } from './read.js';

/**
 * What a band says of a root, for a source that can check it: the height of
 * the block holding it.
 */
export interface RootExpectation {
  height?: number;
}

/**
 * Opens the data of a root transaction for range reads. A source that can
 * check `expect` refuses the root (an error with `refutes: true`) when the
 * chain disagrees with it.
 */
export type RootSourceFactory = (
  rootTxId: string,
  expect?: RootExpectation,
) => ByteRangeSource;

/**
 * Candidates a caller samples for each entry the check is to read, so that
 * entries under roots the network no longer has can be passed over (see
 * {@link HeaderCheckOptions.targets}).
 */
export const HEADER_CHECK_POOL_FACTOR = 10;
/** The fewest entries that must pass, unless the check aims at fewer. */
export const DEFAULT_MIN_VERIFIED = 50;

export interface HeaderCheckOptions {
  /**
   * Entries with offsets to check, e.g. {@link BuiltBand.sample}: with
   * `targets`, a pool of candidates larger than what is read.
   */
  entries: BandSampleEntry[];
  /**
   * How many entries of each stratum (by sample tag, `''` for the general
   * sample) to read. Each stratum's entries are walked in random order
   * until that many have been read (passed, wrong, or failed in transport),
   * passing over entries whose root the gateway doesn't have, or until they
   * run out. A stratum not named is read whole; with no targets, every
   * entry is.
   */
  targets?: Record<string, number>;
  /**
   * The fewest entries that must pass (default: `minOkRatio` of the
   * entries the check aims to read, at most {@link DEFAULT_MIN_VERIFIED},
   * rounded up), so it bites only when roots that are gone use the pool up.
   */
  minVerified?: number;
  /** Random source for the order a pool is walked in, in [0, 1). */
  random?: () => number;
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
  /** Entries read: passed, wrong, or failed in transport. */
  checked: number;
  ok: number;
  /**
   * Entries whose header names another ID or ends somewhere else, or whose
   * root the source refutes (an error with `refutes: true`).
   */
  wrong: Array<{ id: string; reason: string; tag?: string }>;
  /** Entries that couldn't be checked (read failed, unknown signature type). */
  errors: Array<{ id: string; error: string; tag?: string }>;
  /**
   * Entries under a root the gateway answered 404 for, gone network-wide:
   * neither passed nor wrong, and left out of the pass ratio. A root found
   * gone once is not asked for again.
   */
  unreadable: Array<{ id: string; rootTxId: string; tag?: string }>;
  /** Candidates handed to the check. */
  poolSize: number;
  /**
   * Unreadable entries among those tried (read or found gone): an estimate
   * of the share of the band's entries whose roots are gone.
   */
  unreadableShare: number;
  /**
   * Entries that passed (counted in `ok`) though their header's tag count
   * field disagrees with the tags its tag bytes hold: the item is
   * malformed, its location right.
   */
  malformedTags: number;
  malformed: Array<{ id: string; reason: string; tag?: string }>;
  /**
   * The counts per sample tag (`''` for the general sample), so a check
   * over stratified samples can say which stratum failed. `unreadable` and
   * `malformedTags` are there only where some were.
   */
  byTag: Record<
    string,
    {
      checked: number;
      ok: number;
      wrong: number;
      unreadable?: number;
      malformedTags?: number;
    }
  >;
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
 * the range runs past the root (416). A transport failure (a timeout, a
 * 429, a 5xx, a connection error) leaves an entry unchecked. A 404 (the
 * gateway doesn't have the root: history whose roots are gone
 * network-wide) makes it `unreadable`, neither; the root's other entries
 * are then passed over without a request.
 *
 * With `targets`, the entries are a pool walked in random order until each
 * stratum has had its target read, so roots that are gone don't shrink
 * what is verified while candidates last.
 *
 * The header's end is where its tag bytes' length field says. A tag count
 * field that disagrees with the tags those bytes hold (an early bundler
 * wrote the byte length into both, at height 789,458 for one) makes the item
 * malformed, not the offsets wrong: such an entry passes, and is counted in
 * `malformedTags`.
 *
 * The band passes when no entry is wrong, at least `minOkRatio` of the
 * entries read pass (an unchecked entry counts against it; an unreadable
 * one doesn't), at least `minVerified` pass, and the band holds at least
 * `minRecords` entries: a signed band of wrong offsets would be evidence
 * against its publisher.
 *
 * Limits: only entries with offsets are checked, so a root-only entry's
 * `rootTxId` is not; nor is an item's size, which would need the whole item.
 */
export async function checkBandHeaders({
  entries,
  totalRecords,
  openRoot,
  targets,
  minVerified,
  random = Math.random,
  minOkRatio = 0.8,
  minRecords = 1000,
  concurrency = 8,
  retries = 2,
  retryDelayMs = 2000,
}: HeaderCheckOptions): Promise<HeaderCheckResult> {
  const wrong: HeaderCheckResult['wrong'] = [];
  const errors: HeaderCheckResult['errors'] = [];
  const unreadable: HeaderCheckResult['unreadable'] = [];
  const malformed: HeaderCheckResult['malformed'] = [];
  let ok = 0;
  const byTag: HeaderCheckResult['byTag'] = {};
  const stratum = (entry: BandSampleEntry) =>
    (byTag[entry.tag ?? ''] ??= { checked: 0, ok: 0, wrong: 0 });
  const tagOf = (entry: BandSampleEntry) =>
    entry.tag !== undefined ? { tag: entry.tag } : {};

  // Each stratum's pool, in random order, and how many it is to read.
  const pools = new Map<string, BandSampleEntry[]>();
  for (const entry of entries) {
    const pool = pools.get(entry.tag ?? '') ?? [];
    pool.push(entry);
    pools.set(entry.tag ?? '', pool);
  }
  for (const pool of pools.values()) {
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
  }
  const want = (tag: string) => targets?.[tag] ?? Number.POSITIVE_INFINITY;
  const target = [...pools].reduce(
    (sum, [tag, pool]) => sum + Math.min(want(tag), pool.length),
    0,
  );
  const read = new Map<string, number>();
  const inFlight = new Map<string, number>();
  const gone = new Set<string>();
  // The next entry of a stratum still short of its target, if any.
  const next = (): BandSampleEntry | undefined => {
    for (const [tag, pool] of pools) {
      if (
        pool.length > 0 &&
        (read.get(tag) ?? 0) + (inFlight.get(tag) ?? 0) < want(tag)
      ) {
        return pool.pop();
      }
    }
    return undefined;
  };

  /** Reads one entry; true when it counts as read (anything but gone). */
  const check = async (entry: BandSampleEntry): Promise<boolean> => {
    const headerBytes = entry.rootDataOffset - entry.rootOffset;
    if (headerBytes <= 0 || headerBytes > MAX_HEADER_BYTES) {
      stratum(entry).wrong += 1;
      wrong.push({
        ...tagOf(entry),
        id: entry.id,
        reason: `offsets give a ${headerBytes}-byte header`,
      });
      return true;
    }
    const goneRoot = () => {
      const counts = stratum(entry);
      counts.unreadable = (counts.unreadable ?? 0) + 1;
      unreadable.push({
        ...tagOf(entry),
        id: entry.id,
        rootTxId: entry.rootTxId,
      });
      return false;
    };
    if (gone.has(entry.rootTxId)) return goneRoot();
    const source = openRoot(
      entry.rootTxId,
      entry.height !== undefined ? { height: entry.height } : undefined,
    );
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
      // starts inside and runs past it. A root (or chunk) the source doesn't have
      // (404) is gone; anything else (a timeout, a 429, a 5xx) means it
      // couldn't be checked.
      if (isWrongRange(error)) {
        stratum(entry).wrong += 1;
        wrong.push({
          ...tagOf(entry),
          id: entry.id,
          reason: 'offsets run past the end of the root transaction',
        });
        return true;
      }
      // A root the chain refutes (no data it signs, never mined, in another
      // block than the band says) is as wrong as a header that isn't the
      // item: definitive, never retried.
      if (isRefuted(error)) {
        stratum(entry).wrong += 1;
        wrong.push({
          ...tagOf(entry),
          id: entry.id,
          reason: `its root ${entry.rootTxId} is refuted: ${error instanceof Error ? error.message : String(error)}`,
        });
        return true;
      }
      if (isGone(error)) {
        // A missing chunk is this item's alone: other items of the root may
        // sit in chunks that are still held.
        if (!isChunkOnly(error)) gone.add(entry.rootTxId);
        return goneRoot();
      }
      errors.push({
        ...tagOf(entry),
        id: entry.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    } finally {
      await source.close().catch(() => undefined);
    }

    let decoded: ReturnType<typeof decodeDataItemHeader>;
    try {
      decoded = decodeDataItemHeader(bytes, {
        allowTagCountMismatch: true,
      });
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
      return true;
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
      const mismatch = decoded.header.tagCountMismatch;
      if (mismatch !== undefined) {
        const counts = stratum(entry);
        counts.malformedTags = (counts.malformedTags ?? 0) + 1;
        malformed.push({
          ...tagOf(entry),
          id: entry.id,
          reason: `its tag count field says ${mismatch.declared}, its tag bytes hold ${mismatch.decoded} tags`,
        });
      }
    }
    return true;
  };

  // Workers take the next entry a stratum still needs; one that finds none
  // waits while reads are in flight, since a root found gone frees a slot.
  let running = 0;
  let waiting: Array<() => void> = [];
  const worker = async () => {
    for (;;) {
      const entry = next();
      if (entry === undefined) {
        if (running === 0) return;
        await new Promise<void>((resolve) => waiting.push(resolve));
        continue;
      }
      const tag = entry.tag ?? '';
      running += 1;
      inFlight.set(tag, (inFlight.get(tag) ?? 0) + 1);
      try {
        if (await check(entry)) {
          stratum(entry).checked += 1;
          read.set(tag, (read.get(tag) ?? 0) + 1);
        }
      } finally {
        running -= 1;
        inFlight.set(tag, (inFlight.get(tag) ?? 0) - 1);
        const woken = waiting;
        waiting = [];
        for (const wake of woken) wake();
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, () => worker()),
  );

  const checked = ok + wrong.length + errors.length;
  const tried = checked + unreadable.length;
  const verifiedFloor =
    minVerified ??
    Math.ceil(minOkRatio * Math.min(target, DEFAULT_MIN_VERIFIED));
  const reasons: string[] = [];
  if (totalRecords < minRecords) {
    reasons.push(`band has ${totalRecords} entries, fewer than ${minRecords}`);
  }
  if (entries.length === 0) {
    reasons.push('no entries with offsets to check');
  }
  if (wrong.length > 0) {
    reasons.push(`${wrong.length} of ${checked} checked entries are wrong`);
  }
  // When entries are wrong, that is the reason; the counts add nothing.
  const underRatio = checked > 0 && ok / checked < minOkRatio;
  if (wrong.length === 0 && underRatio) {
    // Say why: an entry the gateway couldn't serve isn't a wrong one, and
    // the usual cause is a gateway that has to fetch the roots itself.
    const unchecked =
      errors.length > 0
        ? `; ${errors.length} could not be read from the root source (most often: ${mostCommon(errors.map((e) => e.error))}); rerun, or read through another source`
        : '';
    reasons.push(
      `${ok} of ${checked} checked entries passed, under ${Math.round(minOkRatio * 100)}%${unchecked}`,
    );
  }
  if (
    wrong.length === 0 &&
    !underRatio &&
    entries.length > 0 &&
    ok < verifiedFloor
  ) {
    reasons.push(
      `${ok} entries verified, fewer than ${verifiedFloor}: of the ${tried} tried, ${unreadable.length} are under roots or chunks the source doesn't have (404) and ${errors.length} could not be read${tried === entries.length ? '; the sample ran out' : ''}`,
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
    unreadable,
    poolSize: entries.length,
    unreadableShare: tried > 0 ? unreadable.length / tried : 0,
    malformedTags: malformed.length,
    malformed,
    byTag,
  };
}

/** A range that runs past the root: the offsets are wrong, not the network. */
const isWrongRange = (error: unknown) =>
  error instanceof ShortRangeReadError ||
  (error as { response?: { status?: number } }).response?.status === 416;

/** A root the chain refutes: counted wrong. */
const isRefuted = (error: unknown) =>
  (error as { refutes?: unknown } | undefined)?.refutes === true;

/** A root the gateway doesn't have: not to be retried, nor counted against. */
const isGone = (error: unknown) =>
  (error as { response?: { status?: number } }).response?.status === 404;

/** A 404 for one chunk of a root (from Arweave nodes), not the whole root. */
const isChunkOnly = (error: unknown) =>
  (error as { wholeRoot?: boolean }).wholeRoot === false;

async function readWithRetries(
  read: () => Promise<Buffer>,
  retries: number,
  delayMs: number,
): Promise<Buffer> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (
        attempt >= retries ||
        isWrongRange(error) ||
        isGone(error) ||
        isRefuted(error)
      ) {
        throw error;
      }
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

/** A read still in flight when a check's deadline passed. */
export class DeadlinePassedError extends Error {
  constructor() {
    super("the check's deadline passed during this read");
  }
}

/** Why a drawn entry could not be checked. */
export type UncheckedReason =
  /** Nodes busy, failing or unreachable; a root that couldn't be bound or placed. */
  | 'error'
  /** The chunk holding its header is held by no node that answered. */
  | 'unreadable'
  /** The check's deadline passed before it was read. */
  | 'deadline';

export interface DrawnCheckOptions {
  /**
   * The entries drawn for the check, and only those: each ends `ok`,
   * `wrong` or `unchecked`, and none is replaced by another.
   */
  entries: BandSampleEntry[];
  openRoot: RootSourceFactory;
  /**
   * Unchecked entries the check may leave and still pass (default 0): past
   * it the check is inconclusive.
   */
  maxUnchecked?: number;
  /** Root reads in flight at once (default 8). */
  concurrency?: number;
  /** Further tries of a read that failed in transport, per pass (default 2). */
  retries?: number;
  /** Pause before the first retry, doubling after (default 2,000 ms). */
  retryDelayMs?: number;
  /** Milliseconds the whole check may take; what is unread then is unchecked. */
  deadlineMs?: number;
}

export interface DrawnCheckResult {
  passed: boolean;
  /** No entry wrong, but more unchecked than allowed: neither pass nor refutation. */
  inconclusive: boolean;
  reasons: string[];
  drawn: number;
  ok: number;
  /**
   * Entries proven contrary: bytes under a proven root that aren't the
   * item, a root the chain refutes, or a root no node has (`missing`).
   */
  wrong: Array<{ id: string; reason: string; tag?: string; missing?: boolean }>;
  unchecked: Array<{
    id: string;
    reason: UncheckedReason;
    error: string;
    tag?: string;
  }>;
  uncheckedReasons: Partial<Record<UncheckedReason, number>>;
  /** A few distinct errors of the unchecked, so a band's can be judged. */
  errorSample: string[];
  malformed: Array<{ id: string; reason: string; tag?: string }>;
}

/**
 * The on-chain check of a verifier: one denominator, no substitution.
 *
 * Every drawn entry ends in exactly one of `ok` (its header, read from a
 * root the source bound and proved, hashes to its id), `wrong` (proven
 * contrary: another item there, a root the chain refutes, a root no node
 * has) or `unchecked` (anything else). No entry is ever replaced by another
 * draw because of how it ended: redrawing is what would let a fabricated
 * item hide behind a root or chunk nobody can read. After a first pass,
 * every unchecked entry is read once more, after the others.
 *
 * It passes with no entry wrong, at most `maxUnchecked` unchecked and at
 * least one ok; with none wrong and more unchecked, it is inconclusive.
 */
export async function checkDrawnHeaders({
  entries,
  openRoot,
  maxUnchecked = 0,
  concurrency = 8,
  retries = 2,
  retryDelayMs = 2000,
  deadlineMs,
}: DrawnCheckOptions): Promise<DrawnCheckResult> {
  if (!Number.isSafeInteger(maxUnchecked) || maxUnchecked < 0) {
    throw new Error(
      `maxUnchecked must be a whole number, 0 or above, not ${maxUnchecked}`,
    );
  }
  const deadline =
    deadlineMs !== undefined ? Date.now() + deadlineMs : undefined;
  // Set when the deadline's timer fires, so no read starts after it however
  // the clock and the timer disagree by a millisecond.
  let deadlinePassed = false;
  const pastDeadline = () =>
    deadlinePassed || (deadline !== undefined && Date.now() >= deadline);
  type Outcome =
    | { kind: 'ok'; malformed?: string }
    | { kind: 'wrong'; reason: string; missing?: boolean }
    | { kind: 'unchecked'; reason: UncheckedReason; error: string };

  const readOne = async (entry: BandSampleEntry): Promise<Outcome> => {
    const headerBytes = entry.rootDataOffset - entry.rootOffset;
    if (headerBytes <= 0 || headerBytes > MAX_HEADER_BYTES) {
      return {
        kind: 'wrong',
        reason: `offsets give a ${headerBytes}-byte header`,
      };
    }
    if (pastDeadline()) {
      return {
        kind: 'unchecked',
        reason: 'deadline',
        error: 'not read before the deadline',
      };
    }
    const source = openRoot(
      entry.rootTxId,
      entry.height !== undefined ? { height: entry.height } : undefined,
    );
    let bytes: Buffer;
    try {
      const reading = readWithRetries(
        () => source.read(entry.rootOffset, headerBytes),
        retries,
        retryDelayMs,
      );
      if (deadline === undefined) {
        bytes = await reading;
      } else {
        let timer: NodeJS.Timeout | undefined;
        reading.catch(() => undefined);
        try {
          bytes = await Promise.race([
            reading,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => {
                  deadlinePassed = true;
                  reject(new DeadlinePassedError());
                },
                Math.max(0, deadline - Date.now()),
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isWrongRange(error)) {
        return {
          kind: 'wrong',
          reason: 'offsets run past the end of the root transaction',
        };
      }
      if (isRefuted(error)) {
        return {
          kind: 'wrong',
          reason: `its root ${entry.rootTxId} is refuted: ${message}`,
        };
      }
      // A root no node has, as two machines or more say and none unheard:
      // the on-chain source's verdict, about the root itself.
      if (error instanceof NotOnNodesError) {
        if (error.wholeRoot) {
          return {
            kind: 'wrong',
            missing: true,
            reason: `its root ${entry.rootTxId} is missing: ${message}`,
          };
        }
        return { kind: 'unchecked', reason: 'unreadable', error: message };
      }
      if (error instanceof DeadlinePassedError) {
        return { kind: 'unchecked', reason: 'deadline', error: message };
      }
      return {
        kind: 'unchecked',
        reason: isGone(error) ? 'unreadable' : 'error',
        error: message,
      };
    } finally {
      await source.close().catch(() => undefined);
    }
    let decoded: ReturnType<typeof decodeDataItemHeader>;
    try {
      decoded = decodeDataItemHeader(bytes, { allowTagCountMismatch: true });
    } catch (error) {
      return {
        kind: 'wrong',
        reason: `no data item header at rootOffset: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!decoded.complete) {
      return {
        kind: 'wrong',
        reason: `header runs past rootDataOffset (needs ${decoded.needBytes} bytes, offsets give ${headerBytes})`,
      };
    }
    if (decoded.header.headerSize !== headerBytes) {
      return {
        kind: 'wrong',
        reason: `header is ${decoded.header.headerSize} bytes, offsets give ${headerBytes}`,
      };
    }
    if (decoded.header.id !== entry.id) {
      return {
        kind: 'wrong',
        reason: `header at rootOffset is item ${decoded.header.id}`,
      };
    }
    const mismatch = decoded.header.tagCountMismatch;
    return mismatch === undefined
      ? { kind: 'ok' }
      : {
          kind: 'ok',
          malformed: `its tag count field says ${mismatch.declared}, its tag bytes hold ${mismatch.decoded} tags`,
        };
  };

  const outcomes: Outcome[] = new Array(entries.length);
  const runPass = async (indexes: number[]) => {
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next;
        next += 1;
        if (i >= indexes.length) return;
        outcomes[indexes[i]] = await readOne(entries[indexes[i]]);
      }
    };
    await Promise.all(
      Array.from({ length: Math.max(1, concurrency) }, () => worker()),
    );
  };
  await runPass(entries.map((_, i) => i));
  // Every unchecked entry once more, after the others: busy nodes rested,
  // and roots not bound the first time asked again.
  const again = outcomes
    .map((o, i) => (o.kind === 'unchecked' && o.reason !== 'deadline' ? i : -1))
    .filter((i) => i >= 0);
  if (again.length > 0) await runPass(again);

  const tagOf = (entry: BandSampleEntry) =>
    entry.tag !== undefined ? { tag: entry.tag } : {};
  const wrong: DrawnCheckResult['wrong'] = [];
  const unchecked: DrawnCheckResult['unchecked'] = [];
  const malformed: DrawnCheckResult['malformed'] = [];
  const uncheckedReasons: DrawnCheckResult['uncheckedReasons'] = {};
  let ok = 0;
  outcomes.forEach((o, i) => {
    const entry = entries[i];
    if (o.kind === 'ok') {
      ok += 1;
      if (o.malformed !== undefined) {
        malformed.push({ ...tagOf(entry), id: entry.id, reason: o.malformed });
      }
    } else if (o.kind === 'wrong') {
      wrong.push({
        ...tagOf(entry),
        id: entry.id,
        reason: o.reason,
        ...(o.missing === true ? { missing: true } : {}),
      });
    } else {
      unchecked.push({
        ...tagOf(entry),
        id: entry.id,
        reason: o.reason,
        error: o.error,
      });
      uncheckedReasons[o.reason] = (uncheckedReasons[o.reason] ?? 0) + 1;
    }
  });
  const reasons: string[] = [];
  if (wrong.length > 0) {
    reasons.push(
      `${wrong.length} of ${entries.length} sampled entries are wrong`,
    );
  }
  // None wrong, but too much unchecked, or nothing verified at all (however
  // many may stay unchecked): neither a pass nor a refutation.
  const tooMany = unchecked.length > maxUnchecked;
  const inconclusive = wrong.length === 0 && (tooMany || ok === 0);
  if (inconclusive && entries.length > 0) {
    reasons.push(
      tooMany
        ? `inconclusive: ${unchecked.length} of ${entries.length} sampled entries could not be checked — rerun, or allow with --max-unchecked`
        : `inconclusive: none of the ${entries.length} sampled entries could be verified`,
    );
  }
  if (entries.length === 0) reasons.push('no entries drawn to check');
  return {
    passed: reasons.length === 0,
    inconclusive,
    reasons,
    drawn: entries.length,
    ok,
    wrong,
    unchecked,
    uncheckedReasons,
    errorSample: [...new Set(unchecked.map((u) => u.error))].slice(0, 3),
    malformed,
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
