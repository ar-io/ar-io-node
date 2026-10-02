/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import crypto from 'node:crypto';
import { createWriteStream, WriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { once } from 'node:events';
import { canonicalize } from 'json-canonicalize';
import { Logger } from 'winston';

import { encodeCdb64Value, isValidDataItemSize } from '../cdb64-encoding.js';
import { Cdb64Writer, verifyCdb64File } from '../cdb64.js';
import {
  Cdb64Manifest,
  indexToPrefix,
  parseManifest,
  PartitionInfo,
  serializeManifest,
} from '../cdb64-manifest.js';
import { PartitionedCdb64Reader } from '../partitioned-cdb64-reader.js';
import { isValidPathSegment } from '../index-publication.js';
import { toB64Url } from '../encoding.js';
import { sha256File } from '../sha256-file.js';

/** One root-TX index entry to put in a band. */
export interface BandRecord {
  /** The data item ID, 32 bytes. */
  id: Buffer;
  /** The root transaction ID, 32 bytes. */
  rootTxId: Buffer;
  /**
   * The block height the item was found at, a non-negative integer. When the
   * same ID appears more than once, the higher height wins at equal rank: a
   * re-bundled item is retrievable from its later root.
   */
  height?: number;
  /** Offset of the item (header included) within the root TX data. */
  rootOffset?: number;
  /** Offset of the item's payload within the root TX data. */
  rootDataOffset?: number;
  /** Total item size, header and payload. */
  size?: number;
  /**
   * 1 for a record from an authoritative overlay (such as a bundler's own
   * offsets), which beats every rank-0 record for its ID whatever their
   * heights; 0 (the default) for everything else. The source decides what
   * its authority covers: a row outside the height range an overlay declares
   * must be left out, not given rank 1, or a stale extract would beat a later
   * re-bundle.
   */
  rank?: 0 | 1;
  /**
   * The top of the height range a rank-1 record's source vouches for (an
   * overlay file's coverage). A rank-0 record from a source above it, a
   * re-bundle the overlay couldn't know of, is not outranked: it competes
   * on height. Folded entries are always outranked.
   */
  coverageTo?: number;
  /**
   * True for an entry read back from an earlier band (see
   * {@link openBandRecords}). Its `height` is that band's top, since bands
   * store no heights. At equal rank and height it beats a record that isn't
   * folded, so a correction already folded in is not undone by a source
   * re-exporting the old row; it never takes part in a conflict.
   */
  folded?: boolean;
  /**
   * The source the record came from, one of a small fixed set (a build takes
   * at most 65,535). Two records for one ID from different sources that
   * agree on rank, height and root but not on their offsets or size are a
   * conflict (see {@link BuiltBand.conflicts}). Records without a source
   * never conflict. A source should give each ID once.
   */
  source?: string;
  /**
   * Puts the entry in its own sample for the header check, sized by
   * {@link BuildBandOptions.sampleSizes}, e.g. `repaired` for offsets a
   * source corrected. One of a small fixed set (a build takes at most 255);
   * {@link OVERLAY_CHANGED_TAG} is reserved for the build.
   */
  sampleTag?: string;
}

/** Two sources disagreeing about one item, as sampled for the operator. */
export interface BandConflict {
  id: string;
  rootTxId: string;
  /** The two sources that disagreed. */
  sources: [string, string];
  /** True when an earlier record was used instead; false when the ID was left out. */
  fallback: boolean;
}

/**
 * The sample tag the build gives an overlay record that replaced another
 * record's root or offsets, the entries most worth checking.
 */
export const OVERLAY_CHANGED_TAG = 'overlay-changed';

/** An entry with offsets, as sampled for the header check. */
export interface BandSampleEntry {
  id: string;
  rootTxId: string;
  rootOffset: number;
  rootDataOffset: number;
  /** The entry's sample tag; absent for the general sample. */
  tag?: string;
}

/** A band built and read back, not yet published. */
export interface StagedBand {
  id: string;
  /** Where the staged band is, for checks such as {@link checkBandHeaders}. */
  dir: string;
  records: number;
  /** Uniform samples of entries with offsets, the general one first. */
  sample: BandSampleEntry[];
  /** As {@link BuiltBand}, so a check can refuse a band with too many. */
  conflicts: number;
  conflictSample: BandConflict[];
  dropped: number;
  duplicates: number;
}

/** What `beforePublish` decides. */
export interface PublishDecision {
  publish: boolean;
  /** Why not, when `publish` is false. */
  reasons?: string[];
}

export interface BuildBandOptions {
  log: Logger;
  records: AsyncIterable<BandRecord> | Iterable<BandRecord>;
  /** Where the finished band is renamed to, e.g. `data/indexes/published/root-tx-index`. */
  publishDir: string;
  /**
   * Scratch space for the build, on the same filesystem as `publishDir` (the
   * band is moved into place with a rename) and not inside it.
   */
  workDir: string;
  /** The publishing gateway's wallet; makes band ids unique per publisher. */
  publisher: string;
  /** A short band kind, e.g. `d` (delta), `r` (recent) or `h` (history). */
  kind: string;
  /**
   * Block heights the band covers; `to` is null for a band at the tip. It is
   * the caller's declaration: records' heights are not checked against it.
   */
  heightRange: [number, number | null];
  /** Ids of bands this one replaces. */
  supersedes?: string[];
  /** Further manifest metadata. `heightRange` and `supersedes` are reserved. */
  metadata?: Record<string, unknown>;
  /**
   * Runs on the staged band before it is renamed into `publishDir`, e.g. the
   * header check. A band it declines is discarded, never published.
   */
  beforePublish?: (band: StagedBand) => Promise<PublishDecision>;
  /** Build, read back and run `beforePublish`, but don't publish. */
  dryRun?: boolean;
  /** How many entries with offsets to sample for the header check. */
  sampleSize?: number;
  /**
   * How many to sample per {@link BandRecord.sampleTag} (and for
   * {@link OVERLAY_CHANGED_TAG}), each in its own sample, on top of
   * `sampleSize`. Sizes are positive; an entry whose tag is not listed goes
   * in the general sample.
   */
  sampleSizes?: Record<string, number>;
  /** Random source for sampling, in [0, 1). */
  random?: () => number;
}

export interface BuiltBand {
  id: string;
  /**
   * Digest of the partition files alone, without metadata. Two builds with
   * the same entries share it even when their `supersedes` differ, so a
   * scheduler can skip publishing a band whose content hasn't changed.
   */
  contentDigest: string;
  /** Where the band now lives; undefined unless published or unchanged. */
  dir?: string;
  /** True when the band was renamed into `publishDir`. */
  published: boolean;
  /** True when a band with the same id, and so the same content, already existed. */
  unchanged: boolean;
  /** Set when `beforePublish` declined the band. */
  rejected?: string[];
  /** Entries written. */
  records: number;
  /** Entries written without offsets (root transaction only). */
  rootOnly: number;
  /**
   * Records that lost to a better one for the same ID: higher rank, then
   * height, then folded, then offsets, then (a tie) record bytes. Records
   * set aside in a conflict are not counted.
   */
  duplicates: number;
  /**
   * IDs whose best records conflicted (see {@link BandRecord.source}). The
   * best record below the conflicting ones is used if there is one;
   * otherwise the ID is left out.
   */
  conflicts: number;
  /** A sample of the conflicts, for the operator. */
  conflictSample: BandConflict[];
  /**
   * IDs one source gave more than once: a source that should give one
   * record per ID didn't.
   */
  sameSourceDuplicates: number;
  /** IDs whose best records named different roots, settled by the tie-break. */
  rootTies: number;
  /** Root-only winners that took offsets from another record for the same root. */
  filledOffsets: number;
  /** Overlay entries that changed the root or offsets another source gave. */
  overlayChanged: number;
  /**
   * IDs where an overlay record stepped aside for a peer's row above the
   * overlay's coverage (see {@link BandRecord.coverageTo}).
   */
  overlayOutranked: number;
  /** Records dropped as invalid (bad height or offsets). */
  dropped: number;
  /** Records kept without their size, because the size was invalid. */
  sizeDropped: number;
  heightRange: [number, number | null];
  supersedes: string[];
  /**
   * Uniform samples of entries with offsets, for {@link checkBandHeaders}:
   * the general one, then one per tag in `sampleSizes`, by tag name.
   */
  sample: BandSampleEntry[];
}

const KIND_PATTERN = /^[a-z0-9]{1,8}$/;
const ID_BYTES = 32;
/** A header this long is not a data item header. */
export const MAX_HEADER_BYTES = 1024 * 1024;

// One scattered record on disk: id, root, a presence byte, then height,
// offsets and size as doubles (exact for the safe integers they're checked to
// be). Presence bits rather than a sentinel, so no real value can collide.
// Then the record's rank, its source and its sample tag, as small numbers
// standing for this build's sources and tags (0 for none). Those numbers
// follow input order, so they are left out of the tie-break.
const HAS_HEIGHT = 1;
const HAS_OFFSETS = 2;
const HAS_SIZE = 4;
const IS_FOLDED = 8;
const HAS_COVERAGE = 16;
const FLAGS_AT = ID_BYTES * 2;
const NUMBERS_AT = FLAGS_AT + 1;
const ENTRY_BYTES = NUMBERS_AT + 8 * 4;
const RANK_AT = ENTRY_BYTES;
const SOURCE_AT = RANK_AT + 1;
const TAG_AT = SOURCE_AT + 2;
const COVERAGE_AT = TAG_AT + 1;
const FRAME_BYTES = COVERAGE_AT + 8;
const MAX_SOURCES = 0xffff;
const MAX_TAGS = 0xff;
const CONFLICT_SAMPLE = 20;
/**
 * Most a partition's frames file may hold: it is read into one buffer to be
 * sorted, and `fs.readFile` refuses files of 2 GiB or more. About 21 million
 * records per partition, so about 5.4 billion in a band. That counts records
 * given, not distinct IDs: a fold that merges a band with several sources
 * gives some IDs two to four times.
 */
const MAX_PARTITION_FRAME_BYTES =
  Math.floor((2 ** 31 - 1) / FRAME_BYTES) * FRAME_BYTES;
const READ_BACK_SAMPLE = 64;

const isOffset = (value: number | undefined): value is number =>
  value !== undefined && Number.isSafeInteger(value) && value >= 0;

function assertHeightRange([from, to]: [number, number | null]): void {
  if (!Number.isSafeInteger(from) || from < 0) {
    throw new Error(
      `heightRange start must be a non-negative integer: ${from}`,
    );
  }
  if (to !== null && (!Number.isSafeInteger(to) || to < from)) {
    throw new Error(`heightRange end must be null or an integer >= ${from}`);
  }
}

/** Whether `inner` is `outer` or a path inside it. */
function isWithin(outer: string, inner: string): boolean {
  const relative = path.relative(path.resolve(outer), path.resolve(inner));
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

type FrameResult =
  | { frame: Buffer; sizeDropped: boolean }
  | { frame: undefined; sizeDropped: false };

/** Numbers a build's sources or tags, 1 up, in the order first seen. */
class Names {
  private readonly numbers = new Map<string, number>();
  readonly names: string[] = [];

  constructor(
    private readonly what: string,
    private readonly max: number,
  ) {}

  number(name: string | undefined): number {
    if (name === undefined) return 0;
    let number = this.numbers.get(name);
    if (number === undefined) {
      if (this.names.length >= this.max) {
        throw new Error(
          `A band build takes at most ${this.max} ${this.what}; ${JSON.stringify(name)} is one too many`,
        );
      }
      this.names.push(name);
      number = this.names.length;
      this.numbers.set(name, number);
    }
    return number;
  }

  name(number: number): string | undefined {
    return number === 0 ? undefined : this.names[number - 1];
  }
}

/**
 * Validates a record and encodes it as a frame, or returns no frame when the
 * record is invalid: a height that isn't a non-negative safe integer, only one
 * offset, offsets that aren't non-negative safe integers, or a header span
 * (`rootDataOffset - rootOffset`) that is zero, negative or over
 * {@link MAX_HEADER_BYTES}. An invalid size is dropped and the offsets kept.
 */
function toFrame(record: BandRecord, sources: Names, tags: Names): FrameResult {
  if (record.id.length !== ID_BYTES || record.rootTxId.length !== ID_BYTES) {
    throw new Error('Band record IDs must be 32 bytes');
  }
  const rank = record.rank ?? 0;
  if (rank !== 0 && rank !== 1) {
    throw new Error(
      `Band record ${toB64Url(record.id)}: rank must be 0 or 1, not ${String(rank)}`,
    );
  }
  const folded = record.folded === true;
  // A folded entry's height is its band's top; without one it would lose to
  // every row and undo what it holds.
  if (folded && record.height === undefined) {
    throw new Error(
      `Band record ${toB64Url(record.id)}: a folded record needs the height of its band`,
    );
  }
  const { coverageTo } = record;
  if (coverageTo !== undefined) {
    if (rank !== 1 || !isOffset(coverageTo)) {
      throw new Error(
        `Band record ${toB64Url(record.id)}: coverageTo is for rank-1 records, a non-negative integer`,
      );
    }
    if (record.height === undefined || record.height > coverageTo) {
      throw new Error(
        `Band record ${toB64Url(record.id)}: height ${String(record.height)} is outside its coverage (to ${coverageTo})`,
      );
    }
  }
  if (record.sampleTag === OVERLAY_CHANGED_TAG) {
    throw new Error(
      `Band record ${toB64Url(record.id)}: the sample tag ${OVERLAY_CHANGED_TAG} is the build's own`,
    );
  }
  const invalid = { frame: undefined, sizeDropped: false } as const;
  const { height, rootOffset, rootDataOffset, size } = record;
  if (height !== undefined && !isOffset(height)) return invalid;

  let flags =
    (height !== undefined ? HAS_HEIGHT : 0) |
    (folded ? IS_FOLDED : 0) |
    (coverageTo !== undefined ? HAS_COVERAGE : 0);
  let sizeDropped = false;
  if (rootOffset !== undefined || rootDataOffset !== undefined) {
    if (!isOffset(rootOffset) || !isOffset(rootDataOffset)) return invalid;
    const header = rootDataOffset - rootOffset;
    if (header <= 0 || header > MAX_HEADER_BYTES) return invalid;
    flags |= HAS_OFFSETS;
    if (size !== undefined) {
      if (isValidDataItemSize(size, rootOffset, rootDataOffset)) {
        flags |= HAS_SIZE;
      } else {
        sizeDropped = true;
      }
    }
  }

  const frame = Buffer.alloc(FRAME_BYTES);
  record.id.copy(frame, 0);
  record.rootTxId.copy(frame, ID_BYTES);
  frame.writeUInt8(flags, FLAGS_AT);
  frame.writeDoubleLE(height ?? 0, NUMBERS_AT);
  frame.writeDoubleLE(rootOffset ?? 0, NUMBERS_AT + 8);
  frame.writeDoubleLE(rootDataOffset ?? 0, NUMBERS_AT + 16);
  frame.writeDoubleLE(size ?? 0, NUMBERS_AT + 24);
  frame.writeUInt8(rank, RANK_AT);
  frame.writeUInt16LE(sources.number(record.source), SOURCE_AT);
  frame.writeUInt8(tags.number(record.sampleTag), TAG_AT);
  frame.writeDoubleLE(coverageTo ?? 0, COVERAGE_AT);
  return { frame, sizeDropped };
}

/**
 * Keeps a uniform random sample of a stream of unknown length (reservoir
 * sampling, Algorithm R), so the header check draws from every partition in
 * one pass.
 */
export class Reservoir<T> {
  readonly items: T[] = [];
  private seen = 0;

  constructor(
    private readonly size: number,
    private readonly random: () => number,
  ) {}

  offer(item: T): void {
    this.seen += 1;
    if (this.items.length < this.size) {
      this.items.push(item);
      return;
    }
    const slot = Math.floor(this.random() * this.seen);
    if (slot < this.size) this.items[slot] = item;
  }
}

/**
 * Builds one root-TX index band, checks it, and moves it into the publish
 * directory.
 *
 * Records are validated as they arrive (see {@link toFrame}; invalid ones
 * are dropped before deduplication, so an invalid newer record never hides a
 * valid older one) and scattered to one scratch file per partition. Each
 * partition is then sorted by ID and deduplicated (the higher rank wins, then
 * the higher height, then a folded entry, then an entry with offsets; any
 * remaining tie is broken by the record's bytes, so the result doesn't depend
 * on input order; conflicts between sources are set aside, see
 * {@link resolveGroup}), written as its CDB64 file and finished before the
 * next begins, so memory is bounded by the largest partition (at most about 22
 * million records; see {@link MAX_PARTITION_FRAME_BYTES}).
 *
 * The band is read back (every partition verified and counted, a sample
 * looked up), named `<kind>-h<from>-<to|tip>-<publisher tag>-<digest>`, and
 * handed to `beforePublish`; only then is it renamed into `publishDir`. The
 * publisher tag keeps publishers' ids apart; the digest covers the partition
 * files and the metadata. An existing band is never overwritten, a band with
 * no entries is refused, and scratch files are always removed.
 */
export async function buildBand({
  log: parentLog,
  records,
  publishDir,
  workDir,
  publisher,
  kind,
  heightRange,
  supersedes = [],
  metadata = {},
  beforePublish,
  dryRun = false,
  sampleSize = 150,
  sampleSizes = {},
  random = Math.random,
}: BuildBandOptions): Promise<BuiltBand> {
  const log = parentLog.child({ function: 'buildBand' });
  if (!KIND_PATTERN.test(kind)) {
    throw new Error(`Band kind must match ${KIND_PATTERN}: ${kind}`);
  }
  assertHeightRange(heightRange);
  for (const id of supersedes) {
    if (!isValidPathSegment(id)) {
      throw new Error(`Not a valid band id in supersedes: ${id}`);
    }
  }
  if ('heightRange' in metadata || 'supersedes' in metadata) {
    throw new Error('metadata may not set heightRange or supersedes');
  }
  if (publisher.length === 0) {
    throw new Error('publisher is required');
  }
  for (const [tag, size] of Object.entries(sampleSizes)) {
    if (tag.length === 0 || !Number.isSafeInteger(size) || size < 1) {
      throw new Error(
        `sampleSizes needs non-empty tags and positive integer sizes: ${JSON.stringify(tag)}: ${size}`,
      );
    }
  }
  if (isWithin(publishDir, workDir)) {
    throw new Error(
      `workDir (${workDir}) must not be inside publishDir (${publishDir}), where the publisher would find the build`,
    );
  }

  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(publishDir, { recursive: true });
  const [workStat, publishStat] = await Promise.all([
    fs.stat(workDir),
    fs.stat(publishDir),
  ]);
  if (workStat.dev !== publishStat.dev) {
    throw new Error(
      `workDir (${workDir}) and publishDir (${publishDir}) must be on the same filesystem`,
    );
  }

  await sweepStaleStaging(workDir, log);
  const staging = await fs.mkdtemp(path.join(workDir, STAGING_PREFIX));
  let writer: Cdb64Writer | undefined;
  try {
    // Scatter, validating as records arrive.
    const scatterDir = path.join(staging, 'scatter');
    await fs.mkdir(scatterDir);
    const streams = new Map<number, WriteStream>();
    let streamError: Error | undefined;
    let dropped = 0;
    let sizeDropped = 0;
    const sources = new Names('sources', MAX_SOURCES);
    const tags = new Names('sample tags', MAX_TAGS);
    try {
      for await (const record of records) {
        if (streamError !== undefined) throw streamError;
        const { frame, sizeDropped: lostSize } = toFrame(record, sources, tags);
        if (frame === undefined) {
          dropped += 1;
          continue;
        }
        if (lostSize) sizeDropped += 1;
        const partition = record.id[0];
        let stream = streams.get(partition);
        if (stream === undefined) {
          stream = createWriteStream(
            path.join(scatterDir, `${indexToPrefix(partition)}.frames`),
          );
          // Without a listener, an error while not awaiting 'drain' (ENOSPC,
          // EACCES, EMFILE) would be an unhandled 'error' event and crash
          // the process.
          stream.on('error', (error) => {
            streamError ??= error;
          });
          streams.set(partition, stream);
        }
        if (!stream.write(frame)) await once(stream, 'drain');
      }
      await Promise.all(
        [...streams.values()].map(
          (stream) =>
            new Promise<void>((resolve, reject) => {
              stream.end((error?: Error | null) =>
                error ? reject(error) : resolve(),
              );
            }),
        ),
      );
      if (streamError !== undefined) throw streamError;
    } catch (error) {
      for (const stream of streams.values()) stream.destroy();
      throw error;
    }

    // Sort, deduplicate and write, one partition at a time.
    const bandDir = path.join(staging, 'band');
    await fs.mkdir(bandDir);
    const sample = new Reservoir<BandSampleEntry>(sampleSize, random);
    const tagSamples = new Map(
      Object.entries(sampleSizes).map(([tag, size]) => [
        tag,
        new Reservoir<BandSampleEntry>(size, random),
      ]),
    );
    const readBack = new Reservoir<{ key: Buffer; value: Buffer }>(
      READ_BACK_SAMPLE,
      random,
    );
    const partitions: PartitionInfo[] = [];
    let written = 0;
    let rootOnly = 0;
    let duplicates = 0;
    let conflicts = 0;
    let sameSourceDuplicates = 0;
    let rootTies = 0;
    let filledOffsets = 0;
    let overlayChangedCount = 0;
    let overlayOutranked = 0;
    const conflictSample = new Reservoir<BandConflict>(CONFLICT_SAMPLE, random);

    for (const partition of [...streams.keys()].sort((a, b) => a - b)) {
      const framesPath = path.join(
        scatterDir,
        `${indexToPrefix(partition)}.frames`,
      );
      const framesSize = (await fs.stat(framesPath)).size;
      if (framesSize > MAX_PARTITION_FRAME_BYTES) {
        throw new Error(
          `Partition ${indexToPrefix(partition)} has ${framesSize / FRAME_BYTES} records, more than one partition can hold in memory (${MAX_PARTITION_FRAME_BYTES / FRAME_BYTES}); build the range as several bands`,
        );
      }
      const bytes = await fs.readFile(framesPath);
      const count = bytes.length / FRAME_BYTES;
      // Sort indices over the one buffer rather than an object per record:
      // a partition can hold millions of records.
      const heights = new Float64Array(count);
      const flagsOf = new Uint8Array(count);
      const ranks = new Uint8Array(count);
      for (let i = 0; i < count; i++) {
        const at = i * FRAME_BYTES;
        flagsOf[i] = bytes.readUInt8(at + FLAGS_AT);
        heights[i] =
          (flagsOf[i] & HAS_HEIGHT) !== 0
            ? bytes.readDoubleLE(at + NUMBERS_AT)
            : -1;
        ranks[i] = bytes.readUInt8(at + RANK_AT);
      }
      // Sorted by ID, then by precedence (rank, height, folded, offsets
      // present), so the last frame of each ID wins. Ties between different
      // frames break on the entry bytes, not input order, so the band (and
      // its id) doesn't depend on the order the records arrived in.
      const order = new Uint32Array(count);
      for (let i = 0; i < count; i++) order[i] = i;
      order.sort((a, b) => {
        const atA = a * FRAME_BYTES;
        const atB = b * FRAME_BYTES;
        return (
          bytes.compare(bytes, atB, atB + ID_BYTES, atA, atA + ID_BYTES) ||
          ranks[a] - ranks[b] ||
          heights[a] - heights[b] ||
          (flagsOf[a] & IS_FOLDED) - (flagsOf[b] & IS_FOLDED) ||
          (flagsOf[a] & HAS_OFFSETS) - (flagsOf[b] & HAS_OFFSETS) ||
          bytes.compare(
            bytes,
            atB + ID_BYTES,
            atB + ENTRY_BYTES,
            atA + ID_BYTES,
            atA + ENTRY_BYTES,
          )
        );
      });
      const frameAt = (i: number) =>
        bytes.subarray(order[i] * FRAME_BYTES, (order[i] + 1) * FRAME_BYTES);
      const frames: Frames = {
        bytes,
        heights,
        flagsOf,
        ranks,
        sourceName: (i) =>
          sources.name(bytes.readUInt16LE(i * FRAME_BYTES + SOURCE_AT)),
      };

      const filename = `${indexToPrefix(partition)}.cdb`;
      writer = new Cdb64Writer(path.join(bandDir, filename));
      await writer.open();
      let partitionRecords = 0;
      for (let first = 0; first < order.length; ) {
        const id = frameAt(first).subarray(0, ID_BYTES);
        let end = first + 1;
        while (
          end < order.length &&
          frameAt(end).subarray(0, ID_BYTES).equals(id)
        ) {
          end += 1;
        }
        const group = order.subarray(first, end);
        first = end;
        const resolved = resolveGroup(frames, group, conflictSample);
        if (resolved.conflict) conflicts += 1;
        if (resolved.sameSource) sameSourceDuplicates += 1;
        if (resolved.rootTie) rootTies += 1;
        if (resolved.overlayOutranked) overlayOutranked += 1;
        if (resolved.entry === undefined) continue;
        duplicates += resolved.kept - 1;
        if (resolved.filled) filledOffsets += 1;
        if (resolved.overlayChanged) overlayChangedCount += 1;

        const entry = resolved.entry;
        const offsetsFrom = resolved.offsetsFrom;
        const rootTxId = Buffer.from(
          bytes.subarray(
            entry * FRAME_BYTES + ID_BYTES,
            entry * FRAME_BYTES + ID_BYTES * 2,
          ),
        );
        let value: Buffer;
        if (offsetsFrom === undefined) {
          value = encodeCdb64Value({ rootTxId });
          rootOnly += 1;
        } else {
          const at = offsetsFrom * FRAME_BYTES + NUMBERS_AT;
          const rootOffset = bytes.readDoubleLE(at + 8);
          const rootDataOffset = bytes.readDoubleLE(at + 16);
          value = encodeCdb64Value({
            rootTxId,
            rootDataItemOffset: rootOffset,
            rootDataOffset,
            ...((flagsOf[offsetsFrom] & HAS_SIZE) !== 0
              ? { dataItemSize: bytes.readDoubleLE(at + 24) }
              : {}),
          });
          const tag = resolved.overlayChanged
            ? OVERLAY_CHANGED_TAG
            : tags.name(bytes.readUInt8(entry * FRAME_BYTES + TAG_AT));
          const tagSample = tag === undefined ? undefined : tagSamples.get(tag);
          const sampled = {
            id: toB64Url(id),
            rootTxId: toB64Url(rootTxId),
            rootOffset,
            rootDataOffset,
          };
          if (tagSample !== undefined) {
            tagSample.offer({ ...sampled, tag });
          } else {
            sample.offer(sampled);
          }
        }
        const key = Buffer.from(id);
        await writer.add(key, value);
        readBack.offer({ key, value });
        partitionRecords += 1;
      }
      await writer.finalize();
      writer = undefined;
      await fs.rm(framesPath, { force: true });

      const stat = await fs.stat(path.join(bandDir, filename));
      partitions.push({
        prefix: indexToPrefix(partition),
        location: { type: 'file', filename },
        recordCount: partitionRecords,
        size: stat.size,
      });
      written += partitionRecords;
    }

    if (written === 0) {
      throw new Error(
        dropped === 0 && conflicts === 0
          ? 'Band would be empty: no records were given'
          : `Band would be empty: ${dropped} of the records given were invalid${conflicts > 0 ? `, and ${conflicts} IDs conflicted with nothing to fall back on` : ''}`,
      );
    }
    const samples = [
      ...sample.items,
      ...[...tagSamples.keys()]
        .sort()
        .flatMap((tag) => tagSamples.get(tag)?.items ?? []),
    ];

    const bandMetadata: Record<string, unknown> = {
      ...metadata,
      heightRange,
      ...(supersedes.length > 0 ? { supersedes } : {}),
    };
    const manifest: Cdb64Manifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      totalRecords: written,
      partitions,
      metadata: bandMetadata,
    };
    await fs.writeFile(
      path.join(bandDir, 'manifest.json'),
      serializeManifest(manifest),
      'utf-8',
    );
    // The partitions are synced by their writer; make the manifest and the
    // directory durable too, so a power cut can't publish an empty manifest.
    await syncPath(path.join(bandDir, 'manifest.json'));
    await syncPath(bandDir);

    // Read back.
    for (const partition of partitions) {
      if (partition.location.type !== 'file') continue;
      const { records: found } = await verifyCdb64File(
        path.join(bandDir, partition.location.filename),
      );
      if (found !== partition.recordCount) {
        throw new Error(
          `Band read-back failed: ${partition.location.filename} holds ${found} records, expected ${partition.recordCount}`,
        );
      }
    }
    const reader = new PartitionedCdb64Reader({
      manifest,
      baseDir: bandDir,
      log,
    });
    await reader.open();
    try {
      for (const { key, value } of readBack.items) {
        const found = await reader.get(key);
        if (found === undefined || !found.equals(value)) {
          throw new Error(
            `Band read-back failed: ${toB64Url(key)} does not return what was written`,
          );
        }
      }
    } finally {
      await reader.close();
    }

    // Name.
    const content = crypto.createHash('sha256');
    for (const partition of partitions) {
      if (partition.location.type !== 'file') continue;
      const name = partition.location.filename;
      content.update(
        `${name}\0${await sha256File(path.join(bandDir, name))}\n`,
      );
    }
    const contentDigest = content.digest('hex');
    const idDigest = crypto
      .createHash('sha256')
      .update(contentDigest)
      .update(canonicalize(bandMetadata))
      .digest('hex')
      .slice(0, 12);
    const publisherTag = crypto
      .createHash('sha256')
      .update(publisher)
      .digest('hex')
      .slice(0, 8);
    const id = [
      kind,
      `h${heightRange[0]}`,
      heightRange[1] === null ? 'tip' : String(heightRange[1]),
      publisherTag,
      idDigest,
    ].join('-');

    const result = {
      id,
      contentDigest,
      records: written,
      rootOnly,
      duplicates,
      conflicts,
      conflictSample: conflictSample.items,
      sameSourceDuplicates,
      rootTies,
      filledOffsets,
      overlayChanged: overlayChangedCount,
      overlayOutranked,
      dropped,
      sizeDropped,
      heightRange,
      supersedes,
      sample: samples,
    };
    const merge = {
      duplicates,
      conflicts,
      sameSourceDuplicates,
      rootTies,
      filledOffsets,
      overlayChanged: overlayChangedCount,
      overlayOutranked,
      dropped,
    };

    // The id is derived from the content, so a band already published under
    // it is this band: nothing to check or publish again.
    const target = path.join(publishDir, id);
    // A band is a directory whose manifest parses; an empty or torn manifest
    // (after a crash elsewhere) is not, so it is refused rather than taken
    // as already published.
    const isBand = async () =>
      fs
        .readFile(path.join(target, 'manifest.json'), 'utf8')
        .then((text) => {
          parseManifest(text);
          return true;
        })
        .catch(() => false);
    if (await isBand()) {
      log.info('Identical band already published', { id });
      return { ...result, dir: target, published: false, unchanged: true };
    }

    if (beforePublish !== undefined) {
      const decision = await beforePublish({
        id,
        dir: bandDir,
        records: written,
        sample: samples,
        conflicts,
        conflictSample: conflictSample.items,
        dropped,
        duplicates,
      });
      if (!decision.publish) {
        log.warn('Band not published: declined before publishing', {
          id,
          reasons: decision.reasons,
          ...merge,
          conflictSample: describeConflicts(conflictSample.items),
        });
        return {
          ...result,
          published: false,
          unchanged: false,
          rejected: decision.reasons ?? [],
        };
      }
    }

    if (dryRun) {
      log.info('Built band (dry run, not published)', {
        id,
        records: written,
        ...merge,
        conflictSample: describeConflicts(conflictSample.items),
      });
      return { ...result, published: false, unchanged: false };
    }

    // Publish, never over an existing band.
    const occupied = await fs.stat(target).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      },
    );
    if (occupied) {
      // Another build of the same id may have published between the check
      // above and this one.
      if (await isBand()) {
        log.info('Identical band already published', { id });
        return { ...result, dir: target, published: false, unchanged: true };
      }
      throw new Error(
        `${target} exists but is not a band (no readable manifest.json); remove it before publishing`,
      );
    }
    try {
      await fs.rename(bandDir, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Another build of the same id got there first.
      if ((code === 'ENOTEMPTY' || code === 'EEXIST') && (await isBand())) {
        return { ...result, dir: target, published: false, unchanged: true };
      }
      throw error;
    }
    await syncPath(publishDir);
    log.info('Published band', {
      id,
      records: written,
      rootOnly,
      sizeDropped,
      ...merge,
      ...(conflicts > 0
        ? { conflictSample: describeConflicts(conflictSample.items) }
        : {}),
    });
    return { ...result, dir: target, published: true, unchanged: false };
  } finally {
    await writer?.abort().catch(() => undefined);
    await fs.rm(staging, { recursive: true, force: true });
  }
}

/** A partition's scattered frames and the sort keys read from them. */
interface Frames {
  bytes: Buffer;
  heights: Float64Array;
  flagsOf: Uint8Array;
  ranks: Uint8Array;
  sourceName: (frame: number) => string | undefined;
}

interface ResolvedGroup {
  /** The frame whose root the entry takes; undefined when the ID is left out. */
  entry?: number;
  /** The frame whose offsets and size it takes, if any. */
  offsetsFrom?: number;
  /** Records the choice was made among (the conflicting ones excluded). */
  kept: number;
  conflict: boolean;
  /** Offsets came from another record with the same root. */
  filled: boolean;
  overlayChanged: boolean;
  /** One source gave the ID more than once. */
  sameSource: boolean;
  /** The best records named different roots and the tie-break chose. */
  rootTie: boolean;
  /** An overlay record lost to a peer's later height above its coverage. */
  overlayOutranked: boolean;
}

const sameRoot = (bytes: Buffer, a: number, b: number) =>
  bytes.compare(
    bytes,
    b * FRAME_BYTES + ID_BYTES,
    b * FRAME_BYTES + ID_BYTES * 2,
    a * FRAME_BYTES + ID_BYTES,
    a * FRAME_BYTES + ID_BYTES * 2,
  ) === 0;

const sourceOf = (bytes: Buffer, frame: number) =>
  bytes.readUInt16LE(frame * FRAME_BYTES + SOURCE_AT);

/** Whether two frames' offsets (both present) or sizes (both present) differ. */
function fieldsDiffer(frames: Frames, a: number, b: number): boolean {
  const { bytes, flagsOf } = frames;
  const both = flagsOf[a] & flagsOf[b];
  const at = (i: number, field: number) =>
    bytes.readDoubleLE(i * FRAME_BYTES + NUMBERS_AT + field);
  if (
    (both & HAS_OFFSETS) !== 0 &&
    (at(a, 8) !== at(b, 8) || at(a, 16) !== at(b, 16))
  ) {
    return true;
  }
  return (both & HAS_SIZE) !== 0 && at(a, 24) !== at(b, 24);
}

/**
 * Chooses an ID's entry from its records, sorted so the best is last.
 *
 * - **Conflict:** among the best records (the winner's rank and height, the
 *   winner not folded), two from different sources that name the same root
 *   but differ on a field both carry. Neither can be trusted, so they are set
 *   aside and the best record below them is used instead, if there is one: a
 *   folded entry or an earlier root, which was right where it came from.
 * - **Offsets:** a winner without offsets takes them, and the size, from the
 *   best record with offsets for the same root. A different root's offsets
 *   are never borrowed.
 * - **Overlay changed:** an overlay winner whose root or offsets differ from
 *   the record that would have won without the overlay.
 */
function resolveGroup(
  frames: Frames,
  group: Uint32Array,
  conflictSample: Reservoir<BandConflict>,
): ResolvedGroup {
  const { bytes, heights, flagsOf, ranks } = frames;
  const result: ResolvedGroup = {
    entry: group[group.length - 1],
    kept: group.length,
    conflict: false,
    filled: false,
    overlayChanged: false,
    sameSource: false,
    rootTie: false,
    overlayOutranked: false,
  };
  if (group.length === 1) {
    if ((flagsOf[group[0]] & HAS_OFFSETS) !== 0) result.offsetsFrom = group[0];
    return result;
  }

  for (let x = 0; x < group.length && !result.sameSource; x++) {
    const source = sourceOf(bytes, group[x]);
    if (source === 0) continue;
    for (let y = x + 1; y < group.length; y++) {
      if (sourceOf(bytes, group[y]) === source) {
        result.sameSource = true;
        break;
      }
    }
  }

  // An overlay vouches only for heights up to its coverage: a peer's row
  // above it is a re-bundle the overlay couldn't know of, and the overlay's
  // records step aside for the rank-0 ones (sorted first).
  const all = group;
  const top = group[group.length - 1];
  if (ranks[top] > 0 && (flagsOf[top] & HAS_COVERAGE) !== 0) {
    const coverageTo = bytes.readDoubleLE(top * FRAME_BYTES + COVERAGE_AT);
    let firstRanked = group.length;
    let later = false;
    for (let x = 0; x < group.length; x++) {
      const i = group[x];
      if (ranks[i] > 0) {
        firstRanked = Math.min(firstRanked, x);
      } else if ((flagsOf[i] & IS_FOLDED) === 0 && heights[i] > coverageTo) {
        later = true;
      }
    }
    if (later) {
      group = group.subarray(0, firstRanked);
      result.overlayOutranked = true;
      result.entry = group[group.length - 1];
    }
  }
  const last = group.length - 1;
  const outranked = all.length - group.length;

  // The best records: the run at the end sharing the winner's rank and
  // height (contiguous, given the sort order).
  let winner = group[last];
  let tierStart = last;
  while (
    tierStart > 0 &&
    ranks[group[tierStart - 1]] === ranks[winner] &&
    heights[group[tierStart - 1]] === heights[winner]
  ) {
    tierStart -= 1;
  }
  let usable = group.length;
  if ((flagsOf[winner] & IS_FOLDED) === 0) {
    for (let x = tierStart; x <= last; x++) {
      if (!sameRoot(bytes, group[x], winner)) result.rootTie = true;
    }
    conflict: for (let x = tierStart; x <= last; x++) {
      const a = group[x];
      const sourceA = sourceOf(bytes, a);
      if (sourceA === 0) continue;
      for (let y = x + 1; y <= last; y++) {
        const b = group[y];
        const sourceB = sourceOf(bytes, b);
        if (sourceB === 0 || sourceB === sourceA) continue;
        if (!sameRoot(bytes, a, b) || !fieldsDiffer(frames, a, b)) continue;
        result.conflict = true;
        conflictSample.offer({
          id: toB64Url(
            bytes.subarray(a * FRAME_BYTES, a * FRAME_BYTES + ID_BYTES),
          ),
          rootTxId: toB64Url(
            bytes.subarray(
              a * FRAME_BYTES + ID_BYTES,
              a * FRAME_BYTES + ID_BYTES * 2,
            ),
          ),
          sources: [frames.sourceName(a) ?? '', frames.sourceName(b) ?? ''],
          fallback: tierStart > 0,
        });
        break conflict;
      }
    }
  }
  if (result.conflict) {
    usable = tierStart;
    result.rootTie = false;
    if (usable === 0) {
      return { ...result, entry: undefined, kept: 0 };
    }
    winner = group[usable - 1];
    result.entry = winner;
    result.kept = usable + outranked;
  }

  if ((flagsOf[winner] & HAS_OFFSETS) !== 0) {
    result.offsetsFrom = winner;
  } else {
    for (let x = usable - 2; x >= 0; x--) {
      const candidate = group[x];
      if (
        (flagsOf[candidate] & HAS_OFFSETS) !== 0 &&
        sameRoot(bytes, candidate, winner)
      ) {
        result.offsetsFrom = candidate;
        result.filled = true;
        break;
      }
    }
  }

  if (ranks[winner] > 0) {
    // The record that would have won without the overlay: the last one
    // ranked lower (records are sorted by rank first).
    let below = -1;
    for (let x = usable - 2; x >= 0; x--) {
      if (ranks[group[x]] < ranks[winner]) {
        below = group[x];
        break;
      }
    }
    if (below !== -1) {
      const mine = result.offsetsFrom;
      const theirs = (flagsOf[below] & HAS_OFFSETS) !== 0 ? below : undefined;
      const offsetsAt = (i: number) => i * FRAME_BYTES + NUMBERS_AT + 8;
      result.overlayChanged =
        !sameRoot(bytes, winner, below) ||
        (mine === undefined) !== (theirs === undefined) ||
        (mine !== undefined &&
          theirs !== undefined &&
          bytes.compare(
            bytes,
            offsetsAt(theirs),
            offsetsAt(theirs) + 16,
            offsetsAt(mine),
            offsetsAt(mine) + 16,
          ) !== 0);
    }
  }
  return result;
}

/** Conflicts as log lines: item, root and the two sources. */
function describeConflicts(conflicts: BandConflict[]): string[] {
  return conflicts.map(
    (c) =>
      `${c.id} in ${c.rootTxId}: ${c.sources.join(' vs ')}${c.fallback ? ' (fell back)' : ' (left out)'}`,
  );
}

/**
 * Staging directories older than this are from a build that was killed
 * (a signal skips the cleanup in `finally`), not one still running.
 */
export const STALE_STAGING_MS = 24 * 60 * 60 * 1000;

const STAGING_PREFIX = '.band-build-';

/**
 * Removes staging directories that interrupted builds left in `workDir`: a
 * band's scratch copy can be gigabytes. Only ones in which nothing has been
 * written for {@link STALE_STAGING_MS}, so a build running beside this one is
 * left alone, however long it has run: it writes into subdirectories, which
 * doesn't touch the staging directory's own mtime, so the newest mtime in the
 * whole tree is what counts.
 */
async function sweepStaleStaging(workDir: string, log: Logger): Promise<void> {
  const entries = await fs.readdir(workDir).catch(() => [] as string[]);
  const now = Date.now();
  for (const name of entries) {
    if (!name.startsWith(STAGING_PREFIX)) continue;
    const dir = path.join(workDir, name);
    const newest = await newestMtimeMs(dir);
    if (newest === undefined || now - newest < STALE_STAGING_MS) continue;
    log.warn('Removing a staging directory an interrupted build left', { dir });
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * The newest mtime of a directory and everything in it (a few hundred files).
 * `lstat`, so a symlink is a leaf: the walk never follows one out of the tree
 * or round a loop.
 */
async function newestMtimeMs(dir: string): Promise<number | undefined> {
  const stat = await fs.lstat(dir).catch(() => undefined);
  if (stat === undefined) return undefined;
  let newest = stat.mtimeMs;
  if (stat.isDirectory()) {
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      const child = await newestMtimeMs(path.join(dir, name));
      if (child !== undefined && child > newest) newest = child;
    }
  }
  return newest;
}

/** Flushes a file or directory to disk (directories so renames persist). */
async function syncPath(target: string): Promise<void> {
  const handle = await fs.open(target, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
