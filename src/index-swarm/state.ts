/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Durable sidecar state.
 *
 * Holds what cannot be re-derived cheaply from the filesystem: the highest
 * publication sequence seen from each publisher, which bands are installed,
 * and what this node has published. The sequence is the load-bearing part,
 * because it is what stops a replayed or cached older manifest from rolling a
 * subscriber back to a stale band set.
 *
 * Writes are atomic (temp file, then rename) and serialised through one
 * promise chain, so two loops saving at once cannot interleave and leave a
 * half-written document. A corrupt or unreadable file is reported and
 * replaced with an empty state rather than crashing the process: everything
 * in it can be rebuilt by re-fetching, whereas a sidecar that will not start
 * fixes nothing.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Logger } from 'winston';

import {
  BandDescriptor,
  BandFile,
  BandTorrent,
} from '../lib/index-publication.js';

export const SWARM_STATE_VERSION = 1;

export interface InstalledBand {
  /** Absolute or data-dir-relative path the band was installed to. */
  dir: string;
  files: BandFile[];
  installedAt: string;
  /**
   * The publisher this band was installed from, when it came from one.
   *
   * Retirement is scoped by it: one publisher dropping a band must not
   * remove the copy another publisher still offers.
   */
  publisher?: string;
  /**
   * When the band stopped being readable, for one that has been retired but
   * whose files are still on disk. Held here rather than in a timer so the
   * pending deletion survives a restart instead of orphaning the directory.
   */
  retiredAt?: string;
  /**
   * For a copy that a newer install of the same band replaced: when it may
   * be retired. Recorded in the same write as that install, so the old copy
   * is never forgotten, even if the process dies before retiring it; until
   * then it keeps serving while the gateway loads its replacement.
   */
  retireAfter?: string;
  /**
   * The signed v1 infohash of this copy, once its `.torrent` has been
   * fetched, checked and kept, so the copy can be seeded. Absent for a band
   * offered over HTTP only, or whose torrent has not been fetched yet.
   */
  infohashV1?: string;
}

export interface SubscriptionState {
  /** Highest publication sequence seen from this publisher. */
  sequence: number;
  /**
   * The key that sequence was signed with. A sequence belongs to a key: a
   * publisher that rotates its observer key starts a new count, and must not
   * be refused forever because the old key's count was higher.
   */
  keyId?: string;
  /** Digest of the publication document that sequence came from. */
  manifestSha256: string;
  updatedAt: string;
}

export interface PublicationState {
  /**
   * Sequence of the document last written. Document-level, not per index:
   * one publication covers every index this node offers, and its sequence is
   * what a subscriber compares to decide whether it has seen this already.
   */
  sequence: number;
  /** Digest of that document, which the next one chains to. */
  manifestSha256: string | null;
  updatedAt: string;
}

/**
 * A band already described, keyed by its directory.
 *
 * Hashing a band is the expensive part of publishing: a full index is tens of
 * gigabytes, and a scan that re-read all of it every minute would be
 * pointless work on a disk that is also serving traffic. The fingerprint
 * covers each file's name, size and mtime, so any change to the bytes forces
 * a re-describe while an untouched band costs one stat per file.
 *
 * Persisted rather than held in memory, so a restart does not re-hash
 * everything on the next scan.
 */
export interface DescribedBand {
  fingerprint: string;
  band: BandDescriptor;
  /**
   * The band's torrent, built once per description: building one re-reads
   * every byte of the band. `key` records what it was built from (the file
   * digests, trackers and private flag), so a change to any rebuilds it.
   */
  torrent?: { key: string; torrent: BandTorrent };
}

/**
 * A band this node asked the engine to seed, keyed by `<owner>:<id>`. One
 * engine torrent can be wanted by both loops (a node publishing and
 * subscribing to the same bytes), so each keeps its own entry, and the
 * engine is told to drop a torrent only when no entry still names it.
 */
export interface SeededBand {
  /** The engine's id for the torrent. */
  id: string;
  /** The signed v1 infohash, which is how the subscriber finds its entries. */
  infohashV1?: string;
  index: string;
  band: string;
  /** The directory handed to the engine. */
  dir: string;
  /**
   * Which loop asked. Each reconciles only its own, or the publisher would
   * take back every band the subscriber seeds from installed/.
   */
  owner: 'publisher' | 'subscriber';
}

export interface SwarmState {
  version: number;
  /** Keyed by publisher wallet address. */
  subscriptions: Record<string, SubscriptionState>;
  /** Bands this node installed as a subscriber, by index name, then band id. */
  installed: Record<string, Record<string, InstalledBand>>;
  /**
   * Bands this node retired as a publisher (superseded ones awaiting their
   * sweep), kept apart from {@link installed} so that publishing and
   * subscribing to the same index name never overwrite each other's records.
   */
  publishedBands: Record<string, Record<string, InstalledBand>>;
  /** What this node last published. One document covers every index. */
  published?: PublicationState;
  /** Describe results, keyed by band directory. */
  describeCache: Record<string, DescribedBand>;
  /**
   * What this node has asked its engine to seed. Persisted so that after a
   * restart each loop can still take back a band it no longer wants.
   */
  seeding: Record<string, SeededBand>;
  /**
   * Torrent downloads in progress, by signed v1 infohash. Persisted so a
   * restart neither resets a download's timeout nor forgets its directory.
   */
  downloads: Record<string, SwarmDownload>;
}

/** One band being fetched through the engine. */
export interface SwarmDownload {
  /** The engine's id for the torrent. */
  id: string;
  publisher: string;
  index: string;
  band: string;
  startedAt: number;
  lastProgress: number;
  lastProgressAt: number;
  /** Whether the publisher's WebSeed has been turned on for it. */
  webSeeded: boolean;
  /** When a poll last wanted it; one no poll wants any more is abandoned. */
  lastSeenAt: number;
}

/** The key a seeding entry is stored under. */
export function seedingKey(owner: SeededBand['owner'], id: string): string {
  return `${owner}:${id}`;
}

/**
 * Write into `target` only what changed between `before` and `after`: set
 * entries added or changed, delete entries removed.
 *
 * Callers read a band map, hand it to a kind (install, retire, sweep) that
 * returns a new one, and write that back after awaiting. Assigning the whole
 * map would drop whatever another poll wrote in between; applying the
 * difference keeps both.
 */
export function applyBandChanges(
  target: Record<string, Record<string, InstalledBand>>,
  indexName: string,
  before: Record<string, InstalledBand>,
  after: Record<string, InstalledBand>,
): void {
  const map = (target[indexName] ??= {});
  for (const [bandId, band] of Object.entries(after)) {
    if (before[bandId] !== band) map[bandId] = band;
  }
  for (const bandId of Object.keys(before)) {
    if (!Object.prototype.hasOwnProperty.call(after, bandId))
      delete map[bandId];
  }
}

export function emptyState(): SwarmState {
  return {
    version: SWARM_STATE_VERSION,
    subscriptions: {},
    installed: {},
    publishedBands: {},
    describeCache: {},
    seeding: {},
    downloads: {},
  };
}

/** Fill in anything a reader expects, so an older file loads without special cases. */
function normalize(parsed: unknown): SwarmState {
  const base = emptyState();
  if (typeof parsed !== 'object' || parsed === null) {
    return base;
  }
  const obj = parsed as Partial<SwarmState>;
  return {
    version: typeof obj.version === 'number' ? obj.version : base.version,
    subscriptions: obj.subscriptions ?? base.subscriptions,
    installed: obj.installed ?? base.installed,
    publishedBands: obj.publishedBands ?? base.publishedBands,
    describeCache: obj.describeCache ?? base.describeCache,
    seeding: obj.seeding ?? base.seeding,
    downloads: obj.downloads ?? base.downloads,
    ...(obj.published !== undefined ? { published: obj.published } : {}),
  };
}

export class StateStore {
  private readonly log: Logger;
  private readonly filePath: string;
  private cache: SwarmState | undefined;
  /**
   * The in-flight load, memoised.
   *
   * Without this, callers racing the first `load()` each see an unset cache,
   * because it is only assigned after the read resolves. Each would then
   * build its own state object, mutate that, and the last one assigned would
   * win: every other update silently lost.
   */
  private loadPromise: Promise<SwarmState> | undefined;
  /** Serialises writes; every save appends to this chain. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor({ log, filePath }: { log: Logger; filePath: string }) {
    this.log = log.child({ class: 'StateStore' });
    this.filePath = filePath;
  }

  async load(): Promise<SwarmState> {
    if (this.cache !== undefined) {
      return this.cache;
    }
    if (this.loadPromise === undefined) {
      this.loadPromise = this.doLoad();
    }
    return this.loadPromise;
  }

  private async doLoad(): Promise<SwarmState> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        this.log.warn('Could not read sidecar state, starting empty', {
          path: this.filePath,
          error: error?.message,
        });
      }
      this.cache = emptyState();
      return this.cache;
    }

    try {
      this.cache = normalize(JSON.parse(raw));
    } catch (error: any) {
      // Everything here is re-derivable, so a bad file is not worth refusing
      // to start over. Keep it for inspection rather than overwriting blindly.
      this.log.error('Sidecar state is unreadable, starting empty', {
        path: this.filePath,
        error: error?.message,
      });
      await this.quarantine();
      this.cache = emptyState();
    }

    if (this.cache.version !== SWARM_STATE_VERSION) {
      this.log.warn('Sidecar state has an unexpected version', {
        found: this.cache.version,
        expected: SWARM_STATE_VERSION,
      });
    }

    return this.cache;
  }

  /**
   * Apply a mutation and persist it.
   *
   * The mutation runs against the in-memory copy while the write is queued,
   * so callers see their change immediately and the file catches up in order.
   */
  async update(mutate: (state: SwarmState) => void): Promise<SwarmState> {
    const state = await this.load();
    mutate(state);
    await this.save();
    return state;
  }

  async save(): Promise<void> {
    const state = this.cache;
    if (state === undefined) return;

    const write = this.writeChain.then(async () => {
      const serialized = JSON.stringify(state, null, 2);
      const tmpPath = `${this.filePath}.tmp`;
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      // Flushed before the rename: after a power loss the rename can
      // otherwise land on a file whose contents never reached the disk, which
      // reads back empty and is quarantined, losing every record.
      const handle = await fs.open(tmpPath, 'w');
      try {
        await handle.writeFile(serialized, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tmpPath, this.filePath);
    });

    // Keep the chain alive even if this write fails, or one rejection would
    // wedge every later save.
    this.writeChain = write.catch(() => undefined);
    await write;
  }

  private async quarantine(): Promise<void> {
    try {
      await fs.rename(this.filePath, `${this.filePath}.corrupt`);
    } catch {
      // Nothing useful to do; the empty state will be written over it.
    }
  }
}
