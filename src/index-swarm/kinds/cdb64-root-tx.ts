/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The `cdb64-root-tx` artifact kind: a partitioned CDB64 root-transaction
 * index, as one band.
 *
 * A band is a directory holding a `manifest.json` and up to 256 partition
 * files named by key prefix. The gateway loads it through its collection
 * source, which keys off the manifest: the manifest appearing is what makes a
 * band live, and the manifest disappearing is what takes it out of service.
 * Every operation here is ordered around that fact.
 */
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import pLimit from 'p-limit';
import { Logger } from 'winston';

import { BandDescriptor, BandFile } from '../../lib/index-publication.js';
import { Cdb64Reader, verifyCdb64File } from '../../lib/cdb64.js';
import { FileByteRangeSource } from '../../lib/byte-range-source.js';
import { parseManifest } from '../../lib/cdb64-manifest.js';
import { InstalledBand } from '../state.js';
import {
  ArtifactKind,
  InstallRequest,
  InstalledSet,
  RetireRequest,
  SweepRequest,
} from './types.js';

export const CDB64_ROOT_TX_KIND = 'cdb64-root-tx';

/** The manifest is part of the band and travels with it. */
export const MANIFEST_FILE = 'manifest.json';

/** Partition files are named for the key prefix they hold. */
const PARTITION_NAME_PATTERN = /^[0-9a-f]{2}\.cdb$/;

/**
 * Concurrency for the per-file work in describe and validate.
 *
 * Deliberately low. Both walk up to 256 files that can total several
 * gigabytes, and a gateway's index volume is often a spinning disk that is
 * also serving reads. Going wider buys little on such a disk and competes
 * with the traffic the gateway is there to serve.
 */
const DEFAULT_FILE_CONCURRENCY = 4;

/** Root-transaction index keys are 32-byte transaction and data item IDs. */
const ROOT_TX_KEY_LENGTH = 32;

/**
 * Largest value a root-transaction record may carry (64 KiB).
 *
 * Values are MessagePack objects: a root ID, optional offsets, and at most a
 * path of IDs from root to parent. With bundles nested at most ten deep that
 * is well under a kilobyte; 64 KiB leaves ample headroom for new fields while
 * refusing a file that declares values of a size no real index writes.
 */
export const MAX_ROOT_TX_VALUE_LENGTH = 64 * 1024;

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/** Refuse a manifest with any partition that is not a local file. */
function rejectRemotePartitions(
  manifest: ReturnType<typeof parseManifest>,
  where: string,
): void {
  for (const partition of manifest.partitions) {
    if (partition.location.type !== 'file') {
      throw new Error(
        `${where}: partition ${partition.prefix} has a ${partition.location.type} location; a published band may only carry local files`,
      );
    }
  }
}

export class Cdb64RootTxKind implements ArtifactKind {
  readonly kind = CDB64_ROOT_TX_KIND;
  private readonly log: Logger;
  private readonly fileConcurrency: number;

  constructor({
    log,
    fileConcurrency = DEFAULT_FILE_CONCURRENCY,
  }: {
    log: Logger;
    fileConcurrency?: number;
  }) {
    this.log = log.child({ class: 'Cdb64RootTxKind' });
    this.fileConcurrency = fileConcurrency;
  }

  async describe(dir: string): Promise<BandDescriptor> {
    const manifestPath = path.join(dir, MANIFEST_FILE);
    let manifestRaw: string;
    try {
      manifestRaw = await fs.readFile(manifestPath, 'utf8');
    } catch {
      throw new Error(`Not a CDB64 band: ${manifestPath} is missing`);
    }

    // parseManifest validates the structure and throws with a reason.
    const manifest = parseManifest(manifestRaw);

    // A published band is a directory of bytes and nothing else. A manifest
    // with even one partition elsewhere (HTTP, Arweave) describes an index
    // this node reads remotely; publishing it would hand subscribers a
    // location to fetch rather than bytes they can check, and they refuse it.
    rejectRemotePartitions(manifest, manifestPath);

    const partitionNames = manifest.partitions
      .filter((partition) => partition.location.type === 'file')
      .map((partition) =>
        partition.location.type === 'file' ? partition.location.filename : '',
      )
      .filter((name) => name.length > 0);

    if (partitionNames.length === 0) {
      throw new Error(
        `Not a publishable CDB64 band: ${manifestPath} names no local partition files`,
      );
    }

    const names = [MANIFEST_FILE, ...partitionNames].sort();
    const limit = pLimit(this.fileConcurrency);
    const files: BandFile[] = await Promise.all(
      names.map((name) =>
        limit(async () => {
          const filePath = path.join(dir, name);
          let stat;
          try {
            stat = await fs.stat(filePath);
          } catch {
            // Raw ENOENT here reads as a filesystem fault; the real fault is
            // a manifest that names a partition the directory does not hold.
            throw new Error(
              `CDB64 band at ${dir} names ${name}, which is not present`,
            );
          }
          return {
            name,
            size: stat.size,
            sha256: await sha256File(filePath),
          };
        }),
      ),
    );

    const metadata = manifest.metadata ?? {};
    const heightRange = normalizeHeightRange(metadata.heightRange);

    const descriptor: BandDescriptor = {
      id: path.basename(dir),
      records: manifest.totalRecords,
      files,
    };
    if (heightRange !== undefined) {
      descriptor.heightRange = heightRange;
    }
    // Carried through so a subscriber knows which band this one replaces
    // without having to infer it from height ranges.
    if (metadata.supersedes !== undefined) {
      descriptor.metadata = { supersedes: metadata.supersedes };
    }

    this.log.debug('Described CDB64 band', {
      dir,
      id: descriptor.id,
      fileCount: files.length,
      records: descriptor.records,
    });

    return descriptor;
  }

  async validate(band: BandDescriptor, dir: string): Promise<void> {
    const declared = new Map(band.files.map((file) => [file.name, file]));

    if (!declared.has(MANIFEST_FILE)) {
      throw new Error(`Band ${band.id} does not include ${MANIFEST_FILE}`);
    }

    // Names come from a remote publisher and become file names on disk. The
    // publication schema already rejects separators and traversal; this is
    // the kind's own, narrower rule about what a CDB64 band may contain.
    for (const name of declared.keys()) {
      if (name !== MANIFEST_FILE && !PARTITION_NAME_PATTERN.test(name)) {
        throw new Error(
          `Band ${band.id} contains ${JSON.stringify(name)}, which is neither ${MANIFEST_FILE} nor a partition file`,
        );
      }
    }

    // Everything the manifest names must be present at the declared size.
    const limit = pLimit(this.fileConcurrency);
    await Promise.all(
      band.files.map((file) =>
        limit(async () => {
          const filePath = path.join(dir, file.name);
          let stat;
          try {
            stat = await fs.stat(filePath);
          } catch {
            throw new Error(`Band ${band.id} is missing ${file.name}`);
          }
          if (stat.size !== file.size) {
            throw new Error(
              `Band ${band.id}: ${file.name} is ${stat.size} bytes, expected ${file.size}`,
            );
          }
        }),
      ),
    );

    const manifest = parseManifest(
      await fs.readFile(path.join(dir, MANIFEST_FILE), 'utf8'),
    );

    // The gateway's partitioned reader follows HTTP and Arweave locations.
    // Every other check here covers only local files, so a manifest naming a
    // remote partition would make the subscriber's gateway fetch a location
    // the publisher chose, unchecked by any digest: a server-side request
    // the publisher controls. A published band carries its bytes or nothing.
    rejectRemotePartitions(manifest, `Band ${band.id}`);

    // The manifest and the file set have to agree, or the gateway would open
    // a reader expecting partitions that are not there.
    const manifestNames = new Set(
      manifest.partitions
        .filter((partition) => partition.location.type === 'file')
        .map((partition) =>
          partition.location.type === 'file' ? partition.location.filename : '',
        ),
    );
    const fileNames = new Set(
      [...declared.keys()].filter((name) => name !== MANIFEST_FILE),
    );
    for (const name of manifestNames) {
      if (!fileNames.has(name)) {
        throw new Error(
          `Band ${band.id}: manifest names ${name}, which the band does not carry`,
        );
      }
    }
    for (const name of fileNames) {
      if (!manifestNames.has(name)) {
        throw new Error(
          `Band ${band.id}: carries ${name}, which the manifest does not name`,
        );
      }
    }

    // Finally, prove each partition really is the index it claims to be,
    // rather than merely bytes of the right length. Opening it catches a
    // malformed header; comparing the record count against the manifest
    // catches the case a size or digest check cannot see, a file that is the
    // right length but zero-filled, which parses as a perfectly valid empty
    // database. Then a full structural walk (verifyCdb64File) proves every
    // pointer and length a lookup would trust stays inside the file. It is
    // one sequential read of the partition, bounded to one buffer of memory.
    const declaredRecords = new Map(
      manifest.partitions
        .filter((partition) => partition.location.type === 'file')
        .map((partition) => [
          partition.location.type === 'file' ? partition.location.filename : '',
          partition.recordCount,
        ]),
    );

    await Promise.all(
      [...fileNames].map((name) =>
        limit(async () => {
          const filePath = path.join(dir, name);
          const source = new FileByteRangeSource(filePath);
          const reader = Cdb64Reader.fromSource(source, true);
          let actualRecords: number;
          try {
            await reader.open();
            actualRecords = reader.getRecordCount();
          } catch (error: any) {
            throw new Error(
              `Band ${band.id}: ${name} is not a readable CDB64 file: ${error?.message ?? 'open failed'}`,
            );
          } finally {
            if (reader.isOpen()) {
              await reader.close();
            }
          }

          const expected = declaredRecords.get(name);
          if (expected !== undefined && actualRecords !== expected) {
            throw new Error(
              `Band ${band.id}: ${name} holds ${actualRecords} records, but the manifest declares ${expected}`,
            );
          }

          // The header only says how many slots there are. A lookup follows
          // table pointers, slots and record headers the publisher wrote, so
          // walk all of them once here: a band whose structure would send a
          // reader outside the file, or ask it for a record of absurd size,
          // is refused before it is ever installed.
          let walkedRecords: number;
          try {
            ({ records: walkedRecords } = await verifyCdb64File(filePath, {
              maxKeyLength: ROOT_TX_KEY_LENGTH,
              maxValueLength: MAX_ROOT_TX_VALUE_LENGTH,
            }));
          } catch (error: any) {
            throw new Error(
              `Band ${band.id}: ${name} is not a well-formed CDB64 file: ${error?.message ?? 'verification failed'}`,
            );
          }
          if (walkedRecords !== actualRecords) {
            throw new Error(
              `Band ${band.id}: ${name} holds ${walkedRecords} records, but its header declares ${actualRecords}`,
            );
          }
        }),
      ),
    );

    this.log.debug('Validated CDB64 band', {
      id: band.id,
      dir,
      fileCount: band.files.length,
    });
  }

  async install({
    band,
    sourceDir,
    targetDir,
    current,
  }: InstallRequest): Promise<InstalledSet> {
    await fs.mkdir(path.dirname(targetDir), { recursive: true });

    // A directory left from an interrupted attempt would make the rename
    // fail, or worse, nest inside it.
    await fs.rm(targetDir, { recursive: true, force: true });

    // One rename, so the gateway's watcher never sees a partially populated
    // band. Both paths are on the shared volume, which is what makes this
    // atomic rather than a copy.
    try {
      await fs.rename(sourceDir, targetDir);
    } catch (error: any) {
      if (error?.code === 'EXDEV') {
        throw new Error(
          `Cannot install band ${band.id}: ${sourceDir} and ${targetDir} are on different filesystems, so the move would not be atomic`,
        );
      }
      throw error;
    }

    const installed: InstalledBand = {
      dir: targetDir,
      files: band.files,
      installedAt: new Date().toISOString(),
    };

    this.log.info('Installed CDB64 band', {
      id: band.id,
      dir: targetDir,
      fileCount: band.files.length,
    });

    return { ...current, [band.id]: installed };
  }

  async retire({ bandId, dir, current }: RetireRequest): Promise<InstalledSet> {
    const existing = current[bandId];

    // Removing the manifest is what takes the band out of service: the
    // gateway's collection watcher drops the reader on that event. The
    // partition files stay until the sweep, so a reader mid-lookup keeps the
    // bytes it already has open.
    try {
      await fs.unlink(path.join(dir, MANIFEST_FILE));
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }

    this.log.info('Retired CDB64 band', { id: bandId, dir });

    return {
      ...current,
      [bandId]: {
        ...(existing ?? { dir, files: [], installedAt: '' }),
        dir,
        retiredAt: new Date().toISOString(),
      },
    };
  }

  async sweepRetired({
    current,
    dirFor,
    graceMs,
  }: SweepRequest): Promise<InstalledSet> {
    const now = Date.now();
    const next: InstalledSet = {};

    for (const [bandId, band] of Object.entries(current)) {
      if (band.retiredAt === undefined) {
        next[bandId] = band;
        continue;
      }

      const retiredAt = Date.parse(band.retiredAt);
      // An unparseable timestamp would otherwise keep the band forever.
      const elapsed = Number.isNaN(retiredAt) ? graceMs : now - retiredAt;
      if (elapsed < graceMs) {
        next[bandId] = band;
        continue;
      }

      const dir = band.dir.length > 0 ? band.dir : dirFor(bandId);
      try {
        await fs.rm(dir, { recursive: true, force: true });
        this.log.info('Removed retired CDB64 band', { id: bandId, dir });
      } catch (error: any) {
        // Keep the entry so the next sweep tries again, rather than losing
        // track of a directory still on disk.
        this.log.warn('Could not remove retired CDB64 band; will retry', {
          id: bandId,
          dir,
          error: error?.message,
        });
        next[bandId] = band;
      }
    }

    return next;
  }
}

/** Accept a height range only in the shape the publication schema allows. */
function normalizeHeightRange(
  value: unknown,
): [number, number | null] | undefined {
  if (!Array.isArray(value) || value.length !== 2) {
    return undefined;
  }
  const [start, end] = value;
  if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0) {
    return undefined;
  }
  if (end === null) {
    return [start, null];
  }
  if (typeof end !== 'number' || !Number.isSafeInteger(end) || end < start) {
    return undefined;
  }
  return [start, end];
}
