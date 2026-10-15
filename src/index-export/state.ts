/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { Cdb64Manifest, parseManifest } from '../lib/cdb64-manifest.js';
import { bandPublisherTag } from '../lib/index-band/build.js';
import { supersededBands } from '../lib/index-publication.js';
import type { BandFingerprint } from './kinds/root-tx/fingerprint.js';

/**
 * A band's role in the plan: history, recent (folded weekly) or delta
 * (daily); and, in the grid layout, `tip`, the band above the frozen ones.
 */
export type BandRole = 'h' | 'r' | 'd' | 'tip';

/** The roles a layout's own bands can have; `tip` is the grid layout's alone. */
export const LEGACY_ROLES: readonly BandRole[] = ['h', 'r', 'd'];
export const GRID_ROLES: readonly BandRole[] = ['h', 'r', 'd', 'tip'];

/** A band this service built, or adopted, and still offers. */
export interface OwnBand {
  id: string;
  dir: string;
  role: BandRole;
  from: number;
  /** Null for a band open at the tip. */
  to: number | null;
  /**
   * The highest height it vouches for: `to`, or for an adopted band open at
   * the tip, the top recorded at adoption. A folded entry takes this height.
   */
  top: number;
  adopted: boolean;
  manifest: Cdb64Manifest;
}

/** An existing band recorded as this service's own (turbo's, at first). */
export interface Adoption {
  as: BandRole;
  /** Its top height; required for a band open at the tip. */
  top: number;
  adoptedAt: string;
}

/** What the service remembers about one index between runs. */
export interface IndexState {
  adoptions: Record<string, Adoption>;
  /** When the last fold of the recent band published. */
  lastFoldAt?: string;
  /**
   * When a fold was last rejected: folds wait for an operator (a `--once`
   * run) rather than being rebuilt and rejected every day.
   */
  foldRejectedAt?: string;
  /** Last success per role (published, unchanged, or nothing to publish). */
  lastSuccess: Partial<Record<BandRole, string>>;
  /** A pending retry after a run that couldn't check. */
  retry?: { at: string; attempts: number; reason: string };
  /** The latest rejection, for an operator. */
  lastRejection?: {
    at: string;
    role: BandRole;
    reasons: string[];
    /** The rejected band's heights, where only that band waits for an operator. */
    heightRange?: [number, number];
  };
  /**
   * The last run; `running` while one is (or died) in progress. `detail`
   * says why, when it didn't succeed.
   */
  lastRun?: { at: string; outcome: string; detail?: string };
  /** When each overlay's newest file was written, as of the last run. */
  overlayNewest?: Record<string, string>;
  /**
   * Ids of bands this service superseded, newest last, per role. A new band
   * names them too, so a subscriber that missed an intermediate band still
   * keeps its old one until the new one installs.
   */
  supersededHistory?: Partial<Record<BandRole, string[]>>;
  /**
   * Bands written to an older layout that this service rebuilt under a newer
   * one and found identical (the same id), with the layout they were
   * confirmed against. Their files are left alone, since a subscriber
   * already holds that id; this is what stops them being rebuilt every run.
   */
  layoutConfirmed?: Record<string, string>;
  /**
   * Grid layout: when each frozen band was last re-settled and found
   * unchanged, or rejected, by band id. A band is due again an interval
   * after this or its own creation, whichever is later.
   */
  resettledAt?: Record<string, string>;
  /**
   * Grid layout: what each live frozen band settled against, per source,
   * by band id; a due band whose sources still match is not rebuilt.
   */
  fingerprints?: Record<string, BandFingerprint>;
}

/** What the service remembers between runs, per index; the rest is derived from disk. */
export interface StateFile {
  version: 1;
  indexes: Record<string, IndexState>;
}

export const emptyIndexState = (): IndexState => ({
  adoptions: {},
  lastSuccess: {},
});

export const emptyState = (): StateFile => ({ version: 1, indexes: {} });

/** The state of one index, created empty when absent. */
export function indexState(state: StateFile, index: string): IndexState {
  state.indexes[index] ??= emptyIndexState();
  return state.indexes[index];
}

/** Reads `state.json`; a missing or unreadable file is an empty state. */
export async function loadState(file: string): Promise<StateFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as StateFile;
    if (
      parsed.version !== 1 ||
      typeof parsed.indexes !== 'object' ||
      parsed.indexes === null
    ) {
      return emptyState();
    }
    for (const [name, value] of Object.entries(parsed.indexes)) {
      parsed.indexes[name] = { ...emptyIndexState(), ...value };
    }
    return parsed;
  } catch {
    return emptyState();
  }
}

/** Writes `state.json` atomically. */
export async function saveState(file: string, state: StateFile): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`);
  await fs.rename(temp, file);
}

/**
 * Applies a change to one index's state as it is on disk now, keeping what
 * another writer (an adoption) saved since this run read it.
 */
export async function updateIndexState(
  file: string,
  index: string,
  change: (state: IndexState) => void,
): Promise<void> {
  const state = await loadState(file);
  change(indexState(state, index));
  await saveState(file, state);
}

const BAND_ID = /^([a-z0-9]{1,8})-h(\d+)-(\d+|tip)-([0-9a-f]{8})-[0-9a-f]{12}$/;

/**
 * The role a band id has for this publisher, or undefined when the band is
 * someone else's: its id must carry the publisher's tag and one of the
 * layout's roles, unless it was adopted. Independent of supersession, so a
 * band of this publisher's that another supersedes is still its own.
 */
export function ownBandRole(
  id: string,
  publisher: string,
  adoptions: Record<string, Adoption>,
  roles: readonly BandRole[] = LEGACY_ROLES,
): BandRole | undefined {
  const adoption = adoptions[id];
  if (adoption !== undefined) return adoption.as;
  const match = BAND_ID.exec(id);
  if (match === null || match[4] !== bandPublisherTag(publisher))
    return undefined;
  return (roles as readonly string[]).includes(match[1])
    ? (match[1] as BandRole)
    : undefined;
}

/**
 * This publisher's bands as published: every directory in `publishDir`
 * holding a manifest (one without is being retired), less the ones another
 * band supersedes. A band is this publisher's when its id carries the
 * publisher's tag and its kind is one of the layout's roles (h, r or d; and
 * tip in the grid layout), or when it was adopted.
 */
export async function deriveOwnBands(
  publishDir: string,
  publisher: string,
  adoptions: Record<string, Adoption>,
  roles: readonly BandRole[] = LEGACY_ROLES,
): Promise<OwnBand[]> {
  const names = await fs.readdir(publishDir).catch(() => [] as string[]);
  const all: Array<{ id: string; dir: string; manifest: Cdb64Manifest }> = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const dir = path.join(publishDir, name);
    let manifest: Cdb64Manifest;
    try {
      manifest = parseManifest(
        await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'),
      );
    } catch {
      continue;
    }
    all.push({ id: name, dir, manifest });
  }
  const superseded = supersededBands(
    all.map(({ id, manifest }) => ({
      id,
      files: [],
      ...(manifest.metadata !== undefined
        ? { metadata: manifest.metadata }
        : {}),
    })),
  );

  const own: OwnBand[] = [];
  for (const { id, dir, manifest } of all) {
    if (superseded.has(id)) continue;
    const range = manifest.metadata?.heightRange;
    if (
      !Array.isArray(range) ||
      typeof range[0] !== 'number' ||
      (range[1] !== null && typeof range[1] !== 'number')
    ) {
      continue;
    }
    const [from, to] = range as [number, number | null];
    const role = ownBandRole(id, publisher, adoptions, roles);
    if (role === undefined) continue;
    own.push({
      id,
      dir,
      role,
      from,
      to,
      top: to ?? adoptions[id]?.top ?? from,
      adopted: adoptions[id] !== undefined,
      manifest,
    });
  }
  return own.sort((a, b) => a.from - b.from || a.top - b.top);
}
