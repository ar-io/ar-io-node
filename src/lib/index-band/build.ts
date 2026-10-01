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
   * same ID appears more than once, the higher height wins: a re-bundled item
   * is retrievable from its later root.
   */
  height?: number;
  /** Offset of the item (header included) within the root TX data. */
  rootOffset?: number;
  /** Offset of the item's payload within the root TX data. */
  rootDataOffset?: number;
  /** Total item size, header and payload. */
  size?: number;
}

/** An entry with offsets, as sampled for the header check. */
export interface BandSampleEntry {
  id: string;
  rootTxId: string;
  rootOffset: number;
  rootDataOffset: number;
}

/** A band built and read back, not yet published. */
export interface StagedBand {
  id: string;
  /** Where the staged band is, for checks such as {@link checkBandHeaders}. */
  dir: string;
  records: number;
  /** A uniform sample of entries with offsets. */
  sample: BandSampleEntry[];
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
  /** Duplicate IDs resolved by height, offsets or, for a tie, record bytes. */
  duplicates: number;
  /** Records dropped as invalid (bad height or offsets). */
  dropped: number;
  /** Records kept without their size, because the size was invalid. */
  sizeDropped: number;
  heightRange: [number, number | null];
  supersedes: string[];
  /** A uniform sample of entries with offsets, for {@link checkBandHeaders}. */
  sample: BandSampleEntry[];
}

const KIND_PATTERN = /^[a-z0-9]{1,8}$/;
const ID_BYTES = 32;
/** A header this long is not a data item header. */
export const MAX_HEADER_BYTES = 1024 * 1024;

// One scattered record on disk: id, root, a presence byte, then height,
// offsets and size as doubles (exact for the safe integers they're checked to
// be). Presence bits rather than a sentinel, so no real value can collide.
const HAS_HEIGHT = 1;
const HAS_OFFSETS = 2;
const HAS_SIZE = 4;
const FRAME_BYTES = ID_BYTES * 2 + 1 + 8 * 4;
const FLAGS_AT = ID_BYTES * 2;
const NUMBERS_AT = FLAGS_AT + 1;
/**
 * Most a partition's frames file may hold: it is read into one buffer to be
 * sorted, and `fs.readFile` refuses files of 2 GiB or more. About 22 million
 * records per partition, so about 5.7 billion in a band.
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

/**
 * Validates a record and encodes it as a frame, or returns no frame when the
 * record is invalid: a height that isn't a non-negative safe integer, only one
 * offset, offsets that aren't non-negative safe integers, or a header span
 * (`rootDataOffset - rootOffset`) that is zero, negative or over
 * {@link MAX_HEADER_BYTES}. An invalid size is dropped and the offsets kept.
 */
function toFrame(record: BandRecord): FrameResult {
  if (record.id.length !== ID_BYTES || record.rootTxId.length !== ID_BYTES) {
    throw new Error('Band record IDs must be 32 bytes');
  }
  const invalid = { frame: undefined, sizeDropped: false } as const;
  const { height, rootOffset, rootDataOffset, size } = record;
  if (height !== undefined && !isOffset(height)) return invalid;

  let flags = height !== undefined ? HAS_HEIGHT : 0;
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
 * partition is then sorted by ID and deduplicated (the higher height wins;
 * at equal or missing heights an entry with offsets beats one without; any
 * remaining tie is broken by the record's bytes, so the result doesn't depend
 * on input order), written as its CDB64 file and finished before the next
 * begins, so memory is bounded by the largest partition (at most about 22
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
    try {
      for await (const record of records) {
        if (streamError !== undefined) throw streamError;
        const { frame, sizeDropped: lostSize } = toFrame(record);
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
    const readBack = new Reservoir<{ key: Buffer; value: Buffer }>(
      READ_BACK_SAMPLE,
      random,
    );
    const partitions: PartitionInfo[] = [];
    let written = 0;
    let rootOnly = 0;
    let duplicates = 0;

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
      for (let i = 0; i < count; i++) {
        const at = i * FRAME_BYTES;
        flagsOf[i] = bytes.readUInt8(at + FLAGS_AT);
        heights[i] =
          (flagsOf[i] & HAS_HEIGHT) !== 0
            ? bytes.readDoubleLE(at + NUMBERS_AT)
            : -1;
      }
      // Sorted by ID, then height, then offsets present, so the last frame
      // of each ID wins. Ties between different frames break on the frame
      // bytes, not input order, so the band (and its id) doesn't depend on
      // the order the records arrived in.
      const order = new Uint32Array(count);
      for (let i = 0; i < count; i++) order[i] = i;
      order.sort((a, b) => {
        const atA = a * FRAME_BYTES;
        const atB = b * FRAME_BYTES;
        return (
          bytes.compare(bytes, atB, atB + ID_BYTES, atA, atA + ID_BYTES) ||
          heights[a] - heights[b] ||
          (flagsOf[a] & HAS_OFFSETS) - (flagsOf[b] & HAS_OFFSETS) ||
          bytes.compare(
            bytes,
            atB + ID_BYTES,
            atB + FRAME_BYTES,
            atA + ID_BYTES,
            atA + FRAME_BYTES,
          )
        );
      });
      const frameAt = (i: number) =>
        bytes.subarray(order[i] * FRAME_BYTES, (order[i] + 1) * FRAME_BYTES);

      const filename = `${indexToPrefix(partition)}.cdb`;
      writer = new Cdb64Writer(path.join(bandDir, filename));
      await writer.open();
      let partitionRecords = 0;
      for (let i = 0; i < order.length; i++) {
        const frame = frameAt(i);
        const flags = flagsOf[order[i]];
        const id = frame.subarray(0, ID_BYTES);
        if (
          i + 1 < order.length &&
          frameAt(i + 1)
            .subarray(0, ID_BYTES)
            .equals(id)
        ) {
          duplicates += 1;
          continue;
        }
        const rootTxId = Buffer.from(frame.subarray(ID_BYTES, ID_BYTES * 2));
        let value: Buffer;
        if ((flags & HAS_OFFSETS) === 0) {
          value = encodeCdb64Value({ rootTxId });
          rootOnly += 1;
        } else {
          const rootOffset = frame.readDoubleLE(NUMBERS_AT + 8);
          const rootDataOffset = frame.readDoubleLE(NUMBERS_AT + 16);
          value = encodeCdb64Value({
            rootTxId,
            rootDataItemOffset: rootOffset,
            rootDataOffset,
            ...((flags & HAS_SIZE) !== 0
              ? { dataItemSize: frame.readDoubleLE(NUMBERS_AT + 24) }
              : {}),
          });
          sample.offer({
            id: toB64Url(id),
            rootTxId: toB64Url(rootTxId),
            rootOffset,
            rootDataOffset,
          });
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
        `Band would be empty: ${dropped} of the records given were invalid`,
      );
    }

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
      dropped,
      sizeDropped,
      heightRange,
      supersedes,
      sample: sample.items,
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
        sample: sample.items,
      });
      if (!decision.publish) {
        log.warn('Band not published: declined before publishing', {
          id,
          reasons: decision.reasons,
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
      log.info('Built band (dry run, not published)', { id, records: written });
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
      dropped,
      rootOnly,
      sizeDropped,
    });
    return { ...result, dir: target, published: true, unchanged: false };
  } finally {
    await writer?.abort().catch(() => undefined);
    await fs.rm(staging, { recursive: true, force: true });
  }
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
