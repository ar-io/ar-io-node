/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import crypto from 'node:crypto';
import { createReadStream, createWriteStream, WriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { once } from 'node:events';
import { canonicalize } from 'json-canonicalize';
import { Logger } from 'winston';

import { encodeCdb64Value } from '../cdb64-encoding.js';
import { verifyCdb64File } from '../cdb64.js';
import { indexToPrefix } from '../cdb64-manifest.js';
import { PartitionedCdb64Reader } from '../partitioned-cdb64-reader.js';
import { PartitionedCdb64Writer } from '../partitioned-cdb64-writer.js';
import { PATH_SEGMENT_PATTERN } from '../index-publication.js';
import { toB64Url } from '../encoding.js';

/** One root-TX index entry to put in a band. */
export interface BandRecord {
  /** The data item ID, 32 bytes. */
  id: Buffer;
  /** The root transaction ID, 32 bytes. */
  rootTxId: Buffer;
  /**
   * The block height the item was found at. When the same ID appears more
   * than once, the higher height wins: a re-bundled item is retrievable from
   * its later root.
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

export interface BuildBandOptions {
  log: Logger;
  records: AsyncIterable<BandRecord> | Iterable<BandRecord>;
  /** Where the finished band is renamed to, e.g. `data/indexes/published/root-tx-index`. */
  publishDir: string;
  /**
   * Scratch space for the build. It must be on the same filesystem as
   * `publishDir`, since the band is moved into place with a rename.
   */
  workDir: string;
  /** The publishing gateway's wallet; makes band ids unique per publisher. */
  publisher: string;
  /** A short band kind, e.g. `d` (delta), `r` (recent) or `h` (history). */
  kind: string;
  /** Block heights the band covers; `to` is null for a band at the tip. */
  heightRange: [number, number | null];
  /** Ids of bands this one replaces. */
  supersedes?: string[];
  /** Further manifest metadata. `heightRange` and `supersedes` are reserved. */
  metadata?: Record<string, unknown>;
  /** Build and check the band, but don't move it into `publishDir`. */
  dryRun?: boolean;
  /** How many entries with offsets to sample for the header check. */
  sampleSize?: number;
  /** Random source for sampling, in [0, 1). */
  random?: () => number;
}

export interface BuiltBand {
  id: string;
  /** Where the band now lives; undefined for a dry run. */
  dir?: string;
  /** False for a dry run, or when an identical band was already published. */
  published: boolean;
  /** True when a band with the same id, and so the same content, already existed. */
  unchanged: boolean;
  /** Entries written. */
  records: number;
  /** Entries written without offsets (root transaction only). */
  rootOnly: number;
  /** Duplicate IDs resolved by height or input order. */
  duplicates: number;
  /** Records dropped because their offsets or size were invalid. */
  dropped: number;
  heightRange: [number, number | null];
  supersedes: string[];
  /** A uniform sample of entries with offsets, for {@link checkBandHeaders}. */
  sample: BandSampleEntry[];
}

const KIND_PATTERN = /^[a-z0-9]{1,8}$/;
const ID_BYTES = 32;

// One scattered record on disk: id, root, height, three offsets or sizes.
// Numbers are doubles so any safe integer fits; -1 marks an absent value.
const FRAME_BYTES = ID_BYTES * 2 + 8 * 4;
const ABSENT = -1;
const READ_BACK_SAMPLE = 64;

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

function writeFrame(record: BandRecord): Buffer {
  if (record.id.length !== ID_BYTES || record.rootTxId.length !== ID_BYTES) {
    throw new Error('Band record IDs must be 32 bytes');
  }
  const frame = Buffer.alloc(FRAME_BYTES);
  record.id.copy(frame, 0);
  record.rootTxId.copy(frame, ID_BYTES);
  let pos = ID_BYTES * 2;
  for (const value of [
    record.height,
    record.rootOffset,
    record.rootDataOffset,
    record.size,
  ]) {
    frame.writeDoubleLE(value ?? ABSENT, pos);
    pos += 8;
  }
  return frame;
}

function readNumber(frame: Buffer, field: number): number | undefined {
  const value = frame.readDoubleLE(ID_BYTES * 2 + field * 8);
  return value === ABSENT ? undefined : value;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/**
 * Keeps a uniform random sample of a stream of unknown length (reservoir
 * sampling), so the header check can draw from every partition in one pass.
 */
class Reservoir<T> {
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
 * Builds one root-TX index band and moves it into the publish directory.
 *
 * Records are scattered to one scratch file per partition, then each
 * partition is sorted by ID and deduplicated: the higher height wins, and
 * among equal or missing heights the later record does. A record with both
 * offsets is written with them (and its size when valid); one with neither is
 * written as its root transaction alone; one with only one offset, or offsets
 * the encoding rejects, is dropped.
 *
 * The band is read back (every partition file verified, a sample looked up),
 * then named `<kind>-h<from>-<to|tip>-<publisher tag>-<content digest>`. The
 * publisher tag keeps two publishers' bands apart; the digest covers the
 * partition files and the metadata, so a rebuild with unchanged content gets
 * the same id and is not published again. An existing band is never
 * overwritten.
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
    if (!PATH_SEGMENT_PATTERN.test(id)) {
      throw new Error(`Not a valid band id in supersedes: ${id}`);
    }
  }
  if ('heightRange' in metadata || 'supersedes' in metadata) {
    throw new Error('metadata may not set heightRange or supersedes');
  }
  if (publisher.length === 0) {
    throw new Error('publisher is required');
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

  const staging = await fs.mkdtemp(path.join(workDir, '.band-build-'));
  try {
    // Scatter.
    const scatterDir = path.join(staging, 'scatter');
    await fs.mkdir(scatterDir);
    const streams = new Map<number, WriteStream>();
    try {
      for await (const record of records) {
        const frame = writeFrame(record);
        const partition = record.id[0];
        let stream = streams.get(partition);
        if (stream === undefined) {
          stream = createWriteStream(
            path.join(scatterDir, `${indexToPrefix(partition)}.frames`),
          );
          streams.set(partition, stream);
        }
        if (!stream.write(frame)) await once(stream, 'drain');
      }
    } catch (error) {
      for (const stream of streams.values()) stream.destroy();
      throw error;
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

    // Sort, deduplicate and write, one partition at a time.
    const bandMetadata: Record<string, unknown> = {
      ...metadata,
      heightRange,
      ...(supersedes.length > 0 ? { supersedes } : {}),
    };
    const bandDir = path.join(staging, 'band');
    const writer = new PartitionedCdb64Writer(bandDir, {
      metadata: bandMetadata,
    });
    await writer.open();

    const sample = new Reservoir<BandSampleEntry>(sampleSize, random);
    const readBack = new Reservoir<{ key: Buffer; value: Buffer }>(
      READ_BACK_SAMPLE,
      random,
    );
    let written = 0;
    let rootOnly = 0;
    let duplicates = 0;
    let dropped = 0;

    for (const partition of [...streams.keys()].sort((a, b) => a - b)) {
      const bytes = await fs.readFile(
        path.join(scatterDir, `${indexToPrefix(partition)}.frames`),
      );
      const count = bytes.length / FRAME_BYTES;
      const frames = Array.from({ length: count }, (_, index) =>
        bytes.subarray(index * FRAME_BYTES, (index + 1) * FRAME_BYTES),
      );
      // Sorted by ID, then height, then input order, so the last frame of
      // each ID is the winner.
      const order = frames
        .map((frame, index) => ({
          frame,
          index,
          height: readNumber(frame, 0) ?? -1,
        }))
        .sort(
          (a, b) =>
            Buffer.compare(
              a.frame.subarray(0, ID_BYTES),
              b.frame.subarray(0, ID_BYTES),
            ) ||
            a.height - b.height ||
            a.index - b.index,
        );

      for (let i = 0; i < order.length; i++) {
        const { frame } = order[i];
        const id = frame.subarray(0, ID_BYTES);
        if (
          i + 1 < order.length &&
          order[i + 1].frame.subarray(0, ID_BYTES).equals(id)
        ) {
          duplicates += 1;
          continue;
        }
        const rootTxId = Buffer.from(frame.subarray(ID_BYTES, ID_BYTES * 2));
        const rootOffset = readNumber(frame, 1);
        const rootDataOffset = readNumber(frame, 2);
        const size = readNumber(frame, 3);

        let value: Buffer;
        try {
          if (rootOffset === undefined && rootDataOffset === undefined) {
            value = encodeCdb64Value({ rootTxId });
            rootOnly += 1;
          } else if (rootOffset === undefined || rootDataOffset === undefined) {
            dropped += 1;
            continue;
          } else {
            value = encodeCdb64Value({
              rootTxId,
              rootDataItemOffset: rootOffset,
              rootDataOffset,
              ...(size !== undefined ? { dataItemSize: size } : {}),
            });
            sample.offer({
              id: toB64Url(id),
              rootTxId: toB64Url(rootTxId),
              rootOffset,
              rootDataOffset,
            });
          }
        } catch {
          dropped += 1;
          continue;
        }

        const key = Buffer.from(id);
        await writer.add(key, value);
        readBack.offer({ key, value });
        written += 1;
      }
    }
    const manifest = await writer.finalize();

    // Read back.
    if (manifest.totalRecords !== written) {
      throw new Error(
        `Band manifest counts ${manifest.totalRecords} records, but ${written} were written`,
      );
    }
    const partitionFiles: string[] = [];
    for (const partition of manifest.partitions) {
      if (partition.location.type !== 'file') continue;
      const file = path.join(bandDir, partition.location.filename);
      const { records: found } = await verifyCdb64File(file);
      if (found !== partition.recordCount) {
        throw new Error(
          `Band read-back failed: ${partition.location.filename} holds ${found} records, the manifest says ${partition.recordCount}`,
        );
      }
      partitionFiles.push(partition.location.filename);
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
    const digest = crypto.createHash('sha256');
    for (const name of partitionFiles.sort()) {
      digest.update(`${name}\0${await sha256File(path.join(bandDir, name))}\n`);
    }
    digest.update(canonicalize(bandMetadata));
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
      digest.digest('hex').slice(0, 12),
    ].join('-');

    const result = {
      id,
      records: written,
      rootOnly,
      duplicates,
      dropped,
      heightRange,
      supersedes,
      sample: sample.items,
    };

    if (dryRun) {
      log.info('Built band (dry run, not published)', { id, records: written });
      return { ...result, published: false, unchanged: false };
    }

    // Publish, never over an existing band.
    const target = path.join(publishDir, id);
    const existing = await fs.stat(target).catch(() => undefined);
    if (existing !== undefined) {
      log.info('Identical band already published', { id });
      return { ...result, dir: target, published: false, unchanged: true };
    }
    await fs.rename(bandDir, target);
    log.info('Published band', { id, records: written, dropped, rootOnly });
    return { ...result, dir: target, published: true, unchanged: false };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}
