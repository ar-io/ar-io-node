/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Artifact kinds: the seam that keeps the swarm independent of what it moves.
 *
 * Everything outside this interface, discovering publishers, verifying
 * signatures, fetching bytes, chaining sequences, is the same whether the
 * payload is a CDB64 root-tx index, a Parquet export or a moderation list.
 * A kind supplies only the four operations that genuinely differ: how to read
 * a band off disk, what makes one valid beyond its digests, how to make it
 * live, and how to retire it.
 *
 * The publication manifest's `kind` field selects the implementation, and an
 * unknown kind is skipped and counted rather than treated as an error, so a
 * publisher can offer a kind this node does not understand without breaking
 * the subscription.
 */
import { BandDescriptor } from '../../lib/index-publication.js';
import { InstalledBand } from '../state.js';

/** Bands of one index that are installed here, keyed by band id. */
export type InstalledSet = Record<string, InstalledBand>;

export interface InstallRequest {
  band: BandDescriptor;
  /** Where the verified files are now, normally under `incoming/`. */
  sourceDir: string;
  /** Where they must end up for the gateway to load them. */
  targetDir: string;
  current: InstalledSet;
}

export interface RetireRequest {
  /** Band id to retire. */
  bandId: string;
  /** Where that band is installed. */
  dir: string;
  current: InstalledSet;
}

export interface SweepRequest {
  current: InstalledSet;
  /** Resolve a band id to the directory holding it. */
  dirFor: (bandId: string) => string;
  /**
   * How long a retired band's files stay on disk after its manifest is
   * removed, giving the gateway time to notice and close its reader.
   */
  graceMs: number;
}

export interface ArtifactKind {
  /** Value of the manifest's `kind` field this implementation handles. */
  readonly kind: string;

  /**
   * Read a band directory and describe it for publication: its files, their
   * sizes and digests, and whatever metadata the kind carries.
   *
   * Publisher side. Hashing a band is the expensive part of publishing, so
   * callers are expected to cache the result against the files' size and
   * mtime rather than re-describing an unchanged band.
   */
  describe(dir: string): Promise<BandDescriptor>;

  /**
   * Check a downloaded band beyond its per-file digests.
   *
   * Subscriber side, and the last gate before bytes from a remote publisher
   * become live. Digests prove the bytes are the ones the manifest named;
   * this proves they are the shape this kind can actually serve.
   *
   * @throws with a message naming what failed.
   */
  validate(band: BandDescriptor, dir: string): Promise<void>;

  /** Make a validated band live. Must be atomic from a reader's point of view. */
  install(request: InstallRequest): Promise<InstalledSet>;

  /**
   * Take a band out of service.
   *
   * Returns as soon as the band has stopped being readable, marking it for
   * later removal rather than waiting out the grace period, so a caller's
   * loop is never blocked on cleanup. {@link sweepRetired} does the deleting.
   */
  retire(request: RetireRequest): Promise<InstalledSet>;

  /**
   * Delete the files of bands retired longer ago than the grace period.
   *
   * Split from {@link retire} so the wait survives a restart: a pending
   * deletion held only in a timer would be lost, leaving an orphaned band
   * directory on disk forever.
   */
  sweepRetired(request: SweepRequest): Promise<InstalledSet>;
}
