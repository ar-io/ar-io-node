/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Installing, retiring and removing a band that is a directory of files,
 * shared by the kinds that have one. A band is live while its `liveFile`
 * (the manifest or description a reader opens first) is in its directory.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Logger } from 'winston';

import { InstalledBand } from '../state.js';
import {
  InstallRequest,
  InstalledSet,
  RetireRequest,
  SweepRequest,
} from './types.js';

export interface BandLifecycle {
  log: Logger;
  /** For log lines: "CDB64", "Parquet L1". */
  label: string;
  /** The file whose removal takes a band out of service. */
  liveFile: string;
}

/** Moves a verified band into place in one rename. */
export async function installBand(
  { band, sourceDir, targetDir, current }: InstallRequest,
  { log, label }: BandLifecycle,
): Promise<InstalledSet> {
  await fs.mkdir(path.dirname(targetDir), { recursive: true });

  // A directory left from an interrupted attempt would make the rename
  // fail, or worse, nest inside it.
  await fs.rm(targetDir, { recursive: true, force: true });

  // One rename, so a reader never sees a partially populated band. Both
  // paths are on the shared volume, which is what makes this atomic rather
  // than a copy.
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

  log.info(`Installed ${label} band`, {
    id: band.id,
    dir: targetDir,
    fileCount: band.files.length,
  });

  return { ...current, [band.id]: installed };
}

/**
 * Takes a band out of service by removing its live file. The other files
 * stay until the sweep, so a reader mid-read keeps the bytes it has open.
 */
export async function retireBand(
  { bandId, dir, current }: RetireRequest,
  { log, label, liveFile }: BandLifecycle,
): Promise<InstalledSet> {
  const existing = current[bandId];
  try {
    await fs.unlink(path.join(dir, liveFile));
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  log.info(`Retired ${label} band`, { id: bandId, dir });

  return {
    ...current,
    [bandId]: {
      ...(existing ?? { dir, files: [], installedAt: '' }),
      dir,
      retiredAt: new Date().toISOString(),
    },
  };
}

/** Deletes the files of bands retired longer ago than the grace period. */
export async function sweepRetiredBands(
  { current, dirFor, graceMs }: SweepRequest,
  { log, label }: BandLifecycle,
): Promise<InstalledSet> {
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
      log.info(`Removed retired ${label} band`, { id: bandId, dir });
    } catch (error: any) {
      // Keep the entry so the next sweep tries again, rather than losing
      // track of a directory still on disk.
      log.warn(`Could not remove retired ${label} band; will retry`, {
        id: bandId,
        dir,
        error: error?.message,
      });
      next[bandId] = band;
    }
  }

  return next;
}
