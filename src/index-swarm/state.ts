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

import { BandDescriptor, BandFile } from '../lib/index-publication.js';

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
}

export interface SwarmState {
  version: number;
  /** Keyed by publisher wallet address. */
  subscriptions: Record<string, SubscriptionState>;
  /** Keyed by index name, then band id. */
  installed: Record<string, Record<string, InstalledBand>>;
  /** What this node last published. One document covers every index. */
  published?: PublicationState;
  /** Describe results, keyed by band directory. */
  describeCache: Record<string, DescribedBand>;
}

export function emptyState(): SwarmState {
  return {
    version: SWARM_STATE_VERSION,
    subscriptions: {},
    installed: {},
    describeCache: {},
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
    describeCache: obj.describeCache ?? base.describeCache,
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
      await fs.writeFile(tmpPath, serialized, 'utf8');
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
