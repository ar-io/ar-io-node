/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The publisher loop.
 *
 * Turns band directories an operator's build job drops into
 * `published/<index>/<band>/` into one signed document that other gateways
 * can discover, verify and fetch from.
 *
 * Three things shape the design:
 *
 * - **Hashing is the expensive part.** A full index is tens of gigabytes on a
 *   disk that is also serving traffic, so a band is described only when its
 *   files' sizes or mtimes change, and the result is persisted so a restart
 *   does not re-read everything.
 * - **The document is the contract.** Subscribers compare `sequence` to
 *   decide whether they have seen it, and alarm once `expiresAt` passes. So
 *   a new document is written when the content changes *or* when the current
 *   one is halfway through its life, because a publisher whose bands are
 *   simply quiet must not look dead.
 * - **Signing proves who, not what.** The key is the gateway's registered
 *   observer key. Without one there is nothing a subscriber could check the
 *   signature against, so publishing refuses to start rather than emitting
 *   documents nobody can verify.
 */
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { canonicalize } from 'json-canonicalize';
import { Logger } from 'winston';

import {
  BandDescriptor,
  BandTorrent,
  IndexEntry,
  IndexPublication,
  isValidPathSegment,
  manifestSha256,
  serializeIndexPublication,
  signIndexPublication,
  torrentNameForFiles,
  verifyIndexPublication,
} from '../lib/index-publication.js';
import { isCdb64TempDirName } from '../lib/cdb64-manifest.js';
import {
  getSolanaAddress,
  loadSolanaKeypair,
  loadSolanaKeypairFromBase58,
} from '../lib/httpsig.js';
import * as config from './config.js';
import { applyBandChanges, SeededBand, StateStore } from './state.js';
import { ArtifactKind } from './kinds/types.js';
import { buildTorrent } from './torrent.js';
import { TorrentTransport } from './transport/types.js';
import {
  engineAvailable,
  publishBands,
  publishSeedingBands,
  publishDescribeDuration,
  publishManifestAge,
  publishSequence,
  publishTotal,
} from './metrics.js';

export interface PublisherSigner {
  privateKey: crypto.KeyObject;
  /** The registered observer address, which is what signs. */
  keyId: string;
  /**
   * The gateway's registered wallet, which is what identifies the publisher.
   * A subscriber resolves this in the registry to find the URL to fetch from
   * and the observer address the signature must carry.
   */
  wallet: string;
}

/**
 * Load the signing identity.
 *
 * Returns undefined when no registry-bound key is configured. The auto
 * generated PEM the gateway falls back to for HTTPSIG is deliberately not
 * accepted here: it is not registered anywhere, so a subscriber would have
 * nothing to check a signature against.
 */
export function loadPublisherSigner({
  keypairPath,
  privateKeyBase58,
  wallet,
}: {
  keypairPath?: string;
  privateKeyBase58?: string;
  wallet?: string;
}): PublisherSigner | undefined {
  if (keypairPath !== undefined && privateKeyBase58 !== undefined) {
    throw new Error(
      'Set OBSERVER_KEYPAIR_PATH or OBSERVER_PRIVATE_KEY, not both',
    );
  }

  let privateKey: crypto.KeyObject | undefined;
  if (keypairPath !== undefined) {
    privateKey = loadSolanaKeypair(keypairPath);
  } else if (privateKeyBase58 !== undefined) {
    privateKey = loadSolanaKeypairFromBase58(
      privateKeyBase58,
      'OBSERVER_PRIVATE_KEY',
    );
  }

  if (privateKey === undefined) {
    return undefined;
  }

  const keyId = getSolanaAddress(crypto.createPublicKey(privateKey));

  return {
    privateKey,
    keyId,
    // Falling back to the observer address covers the common case of one key
    // serving both roles. Where they differ, a document naming the wrong
    // identity is unresolvable: a subscriber would look up the observer
    // address in the registry and find no gateway.
    wallet: wallet ?? keyId,
  };
}

/**
 * Name, size and mtime of every file in a band, as one digest.
 *
 * @throws for a symlink in the band. An edit behind one would never change
 *   the fingerprint, and a hard link to it in `blobs/` would resolve
 *   relative to the wrong directory, so a band carries only its own files.
 */
async function fingerprintBand(dir: string): Promise<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const parts: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) {
      throw new Error(
        `${entry.name} is a symlink; a band holds only its own files`,
      );
    }
    if (!entry.isFile()) continue;
    const stat = await fs.stat(path.join(dir, entry.name));
    parts.push(`${entry.name}:${stat.size}:${stat.mtimeMs}`);
  }
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
}

/**
 * The band ids that other bands in the set supersede.
 *
 * A self-reference is ignored, and so is every claim in a cycle (A replaces
 * B, B replaces A): honouring them would retire, then delete, every band in
 * it. A chain (C replaces B, B replaces A) retires A and B as intended.
 */
export function supersededBands(
  bands: BandDescriptor[],
  warn: (message: string, fields: Record<string, unknown>) => void = () =>
    undefined,
): Set<string> {
  const ids = new Set(bands.map((band) => band.id));
  const claims = new Map<string, string[]>();
  for (const band of bands) {
    const claim = band.metadata?.supersedes;
    const targets = (
      typeof claim === 'string' ? [claim] : Array.isArray(claim) ? claim : []
    ).filter((id): id is string => typeof id === 'string');
    const valid = targets.filter((id) => {
      if (id === band.id) {
        warn('Band supersedes itself; ignoring that', { band: band.id });
        return false;
      }
      return true;
    });
    if (valid.length > 0) claims.set(band.id, valid);
  }

  // Drop every claim on a cycle among bands present in this set.
  const onCycle = new Set<string>();
  for (const start of claims.keys()) {
    const stack: Array<{ id: string; path: string[] }> = [
      { id: start, path: [start] },
    ];
    while (stack.length > 0) {
      const { id, path: trail } = stack.pop()!;
      for (const next of claims.get(id) ?? []) {
        if (next === start) {
          for (const member of trail) onCycle.add(member);
        } else if (ids.has(next) && !trail.includes(next)) {
          stack.push({ id: next, path: [...trail, next] });
        }
      }
    }
  }
  if (onCycle.size > 0) {
    warn('Bands supersede each other in a cycle; ignoring those claims', {
      bands: [...onCycle].sort(),
    });
  }

  const superseded = new Set<string>();
  for (const [claimer, targets] of claims) {
    if (onCycle.has(claimer)) continue;
    for (const id of targets) superseded.add(id);
  }
  return superseded;
}

/**
 * Scans a published band may fail to describe before it is withdrawn: ten
 * minutes at the default scan interval, long enough for a transient error.
 */
export const MAX_HELD_SCANS = 10;

export interface PublisherOptions {
  log: Logger;
  state: StateStore;
  kinds: Map<string, ArtifactKind>;
  signer: PublisherSigner;
  publish: config.PublishConfig[];
  publishedDir: string;
  blobsDir: string;
  publicationFile: string;
  ttlMs: number;
  supersedeGraceMs: number;
  /**
   * Offer bands as torrents too. Unset, the publication carries no torrent
   * entries, which is right when no engine is running: a torrent nobody
   * seeds only makes subscribers wait before falling back to HTTP.
   */
  torrents?: PublisherTorrents;
  /** Injectable for tests. */
  now?: () => Date;
}

export interface PublisherTorrents {
  /** The engine that seeds them. Unset builds and advertises without seeding. */
  transport?: TorrentTransport;
  /** Announce URLs, written into every torrent. */
  trackers: string[];
  /** BEP 27 private flag. Part of the infohash, so publishers must agree. */
  privateSwarm: boolean;
}

/**
 * Where the engine seeds a band from: one directory per torrent under
 * `published/.seed/`, holding a hard link per file to `blobs/<sha256>`.
 *
 * Not the band directory itself. A band rebuilt in place under the same id
 * changes the bytes behind its names while the engine is still serving the
 * old torrent, and peers would be handed pieces that fail their hashes. A
 * link pins the bytes that were hashed, as it does for the blob route. The
 * leading dot keeps the directory clear of every valid index name.
 */
export const SEED_DIR = '.seed';

/** A magnet link naming both infohashes, so v1 and v2 clients find the swarm. */
export function magnetFor(
  name: string,
  infohashV1: string,
  infohashV2: string | undefined,
  trackers: string[],
): string {
  const parts = [`xt=urn:btih:${infohashV1}`];
  if (infohashV2 !== undefined) parts.push(`xt=urn:btmh:1220${infohashV2}`);
  parts.push(`dn=${encodeURIComponent(name)}`);
  for (const tracker of trackers) {
    parts.push(`tr=${encodeURIComponent(tracker)}`);
  }
  return `magnet:?${parts.join('&')}`;
}

export class Publisher {
  private readonly log: Logger;
  private readonly state: StateStore;
  private readonly kinds: Map<string, ArtifactKind>;
  private readonly signer: PublisherSigner;
  private readonly publish: config.PublishConfig[];
  private readonly publishedDir: string;
  private readonly blobsDir: string;
  private readonly publicationFile: string;
  private readonly ttlMs: number;
  private readonly supersedeGraceMs: number;
  private readonly torrents?: PublisherTorrents;
  private readonly now: () => Date;

  constructor(options: PublisherOptions) {
    this.log = options.log.child({ class: 'Publisher' });
    this.state = options.state;
    this.kinds = options.kinds;
    this.signer = options.signer;
    this.publish = options.publish;
    this.publishedDir = options.publishedDir;
    this.blobsDir = options.blobsDir;
    this.publicationFile = options.publicationFile;
    this.ttlMs = options.ttlMs;
    this.supersedeGraceMs = options.supersedeGraceMs;
    if (options.torrents !== undefined) this.torrents = options.torrents;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Band directories of one index: immediate subdirectories holding a
   * manifest. A `.tmp` suffix marks one still being written, so a build job
   * can assemble a band in place and rename it in without it being picked up
   * half-formed.
   */
  private async bandDirs(indexName: string): Promise<string[]> {
    const indexDir = path.join(this.publishedDir, indexName);
    let entries;
    try {
      entries = await fs.readdir(indexDir, { withFileTypes: true });
    } catch (error: any) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const dirs: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || isCdb64TempDirName(entry.name)) continue;
      // The directory name becomes the band id in the signed document, and
      // one invalid id would make every subscriber reject the whole thing.
      if (!isValidPathSegment(entry.name)) {
        this.log.warn('Band directory name is not a valid band id; skipping', {
          index: indexName,
          dir: entry.name,
        });
        continue;
      }
      dirs.push(path.join(indexDir, entry.name));
    }
    return dirs.sort();
  }

  /** Describe a band, reusing the cached result while its files are untouched. */
  private async describeBand(
    kind: ArtifactKind,
    indexName: string,
    dir: string,
  ): Promise<BandDescriptor | undefined> {
    let fingerprint: string;
    try {
      fingerprint = await fingerprintBand(dir);
    } catch (error: any) {
      this.log.warn('Could not read band directory; skipping', {
        dir,
        error: error?.message,
      });
      return undefined;
    }

    const state = await this.state.load();
    const cached = state.describeCache[dir];
    if (cached?.fingerprint === fingerprint) {
      return cached.band;
    }

    const end = publishDescribeDuration.startTimer({ index: indexName });
    let band: BandDescriptor;
    try {
      band = await kind.describe(dir);
    } catch (error: any) {
      // A band that cannot be described is not publishable, but it must not
      // stop the indexes that can be.
      this.log.warn('Could not describe band; leaving it out', {
        dir,
        error: error?.message,
      });
      return undefined;
    } finally {
      end();
    }

    await this.state.update((draft) => {
      draft.describeCache[dir] = { fingerprint, band };
    });

    this.log.info('Described band', {
      index: indexName,
      id: band.id,
      files: band.files.length,
    });

    return band;
  }

  /**
   * Build the entry for one configured index, retiring superseded bands.
   *
   * @param publishedIds band ids the current document offers for this index.
   * @throws when one of them is still on disk but can't be described: a
   *   transient read error must not withdraw a live band, which every
   *   subscriber would retire and later download in full again. The scan
   *   fails, the current document stands, and the next scan tries again.
   */
  private async collectIndex(
    entry: config.PublishConfig,
    publishedIds: ReadonlySet<string>,
  ): Promise<IndexEntry | undefined> {
    const kind = this.kinds.get(entry.kind);
    if (kind === undefined) {
      this.log.warn('No implementation for configured kind; skipping index', {
        index: entry.name,
        kind: entry.kind,
      });
      publishTotal.inc({ index: entry.name, result: 'failed' });
      return undefined;
    }

    const dirs = await this.bandDirs(entry.name);
    const described: Array<{ dir: string; band: BandDescriptor }> = [];
    for (const dir of dirs) {
      const band = await this.describeBand(kind, entry.name, dir);
      if (band !== undefined) {
        this.describeFailures.delete(dir);
        described.push({ dir, band });
      } else if (
        await this.isTransientlyUnreadable(entry.name, dir, publishedIds)
      ) {
        throw new Error(
          `Published band ${entry.name}/${path.basename(dir)} could not be described; keeping the current document`,
        );
      }
    }

    // A band can name the one it replaces, so the publisher can stop offering
    // the old one without an operator having to delete it by hand.
    const superseded = supersededBands(
      described.map(({ band }) => band),
      (message, fields) =>
        this.log.warn(message, { index: entry.name, ...fields }),
    );

    const live = described.filter(({ band }) => !superseded.has(band.id));

    for (const { dir, band } of described) {
      if (!superseded.has(band.id)) continue;
      await this.retireBand(kind, entry.name, dir, band.id);
    }

    publishBands.set({ index: entry.name }, live.length);

    const bands: BandDescriptor[] = [];
    for (const { dir, band } of live) {
      const offered: BandDescriptor = {
        ...band,
        http: { baseUrl: `/ar-io/indexes/${entry.name}/${band.id}/` },
      };
      const torrent = await this.torrentFor(entry.name, dir, band);
      if (torrent !== undefined) offered.torrent = torrent;
      bands.push(offered);
    }

    const indexEntry: IndexEntry = {
      name: entry.name,
      kind: entry.kind,
      bands,
    };
    if (entry.filter !== undefined) {
      indexEntry.filter = entry.filter;
    }
    return indexEntry;
  }

  private torrentPath(indexName: string, bandId: string): string {
    return path.join(this.publishedDir, indexName, `${bandId}.torrent`);
  }

  /**
   * The band's torrent entry, building the torrent only when the band's
   * files or the torrent settings changed since the last build.
   *
   * The `.torrent` goes to `published/<index>/<band>.torrent`, next to the
   * band rather than inside it, so it is never one of the band's own files.
   * Nothing in it depends on which publisher built it: no creation date, no
   * WebSeed (subscribers add the publisher's WebSeed themselves, and only
   * when peers stall), so two publishers of the same bytes with the same
   * trackers write byte-identical files.
   */
  private async torrentFor(
    indexName: string,
    dir: string,
    band: BandDescriptor,
  ): Promise<BandTorrent | undefined> {
    if (this.torrents === undefined) return undefined;
    const { trackers, privateSwarm } = this.torrents;
    const name = torrentNameForFiles(band.files);
    const key = JSON.stringify({ name, trackers, privateSwarm });
    const file = this.torrentPath(indexName, band.id);

    const state = await this.state.load();
    const cached = state.describeCache[dir]?.torrent;
    if (cached?.key === key) {
      const onDisk = await fs.stat(file).catch(() => undefined);
      if (onDisk !== undefined) return cached.torrent;
    }

    let built;
    try {
      built = await buildTorrent({
        dir,
        name,
        files: band.files.map((f) => f.name),
        trackers,
        private: privateSwarm,
      });
    } catch (error: any) {
      // Still offered over HTTP; only the swarm is missing for it.
      this.log.warn('Could not build a torrent for band', {
        index: indexName,
        band: band.id,
        error: error?.message,
      });
      return undefined;
    }

    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, built.torrent);
    await fs.rename(tmp, file);

    const torrent: BandTorrent = {
      infohashV1: built.infohashV1,
      ...(built.infohashV2 !== undefined
        ? { infohashV2: built.infohashV2 }
        : {}),
      magnet: magnetFor(
        built.name,
        built.infohashV1,
        built.infohashV2,
        trackers,
      ),
      torrentUrl: `/ar-io/indexes/${indexName}/${band.id}.torrent`,
    };
    await this.state.update((draft) => {
      const described = draft.describeCache[dir];
      if (described !== undefined) described.torrent = { key, torrent };
    });
    this.log.info('Built torrent for band', {
      index: indexName,
      band: band.id,
      infohashV1: built.infohashV1,
      pieces: built.pieces,
    });
    return torrent;
  }

  /**
   * Make the engine seed exactly the bands offered, from pinned links, and
   * remove what is no longer offered: `.torrent` files, seed directories
   * and the engine's torrents.
   *
   * Runs after the blobs are linked, since the seed directories link to
   * them. Seeding an already-seeded torrent is a status check, so an
   * unchanged scan costs one call per band. An engine that is down is not an
   * error: the next scan catches up, and subscribers fall back to HTTP.
   */
  private async reconcileSeeding(indexes: IndexEntry[]): Promise<void> {
    if (this.torrents === undefined) return;

    const seedRoot = path.join(this.publishedDir, SEED_DIR);
    const wantedDirs = new Map<
      string,
      { index: string; band: BandDescriptor }
    >();
    for (const index of indexes) {
      const offered = new Set<string>();
      for (const band of index.bands) {
        if (band.torrent === undefined) continue;
        offered.add(`${band.id}.torrent`);
        wantedDirs.set(torrentNameForFiles(band.files), {
          index: index.name,
          band,
        });
      }
      const dir = path.join(this.publishedDir, index.name);
      const names = await fs.readdir(dir).catch(() => [] as string[]);
      for (const name of names) {
        if (name.endsWith('.torrent') && !offered.has(name)) {
          await fs.rm(path.join(dir, name), { force: true });
        }
      }
    }

    // Seed directories: one per offered torrent, each file a link to its
    // blob. An existing link is kept; the name is derived from the digests,
    // so a directory that exists already holds these bytes.
    for (const [name, { band }] of wantedDirs) {
      const seedDir = path.join(seedRoot, name);
      await fs.mkdir(seedDir, { recursive: true });
      for (const file of band.files) {
        try {
          await fs.link(
            path.join(this.blobsDir, file.sha256),
            path.join(seedDir, file.name),
          );
        } catch (error: any) {
          if (error?.code !== 'EEXIST') throw error;
        }
      }
    }

    const transport = this.torrents.transport;
    let available = false;
    if (transport !== undefined) {
      available = await transport.isAvailable();
      // Also checked on its own schedule; updating it here keeps it from
      // reading 0 while the publisher is visibly seeding.
      engineAvailable.set(available ? 1 : 0);
    }

    const wanted = new Map<string, SeededBand>();
    if (transport !== undefined && available) {
      const seedingByIndex = new Map<string, number>();
      for (const [name, { index, band }] of wantedDirs) {
        const dir = path.join(seedRoot, name);
        try {
          const torrent = await fs.readFile(this.torrentPath(index, band.id));
          const { id } = await transport.seed({ torrent, dir });
          wanted.set(id, { index, band: band.id, dir, owner: 'publisher' });
          seedingByIndex.set(index, (seedingByIndex.get(index) ?? 0) + 1);
        } catch (error: any) {
          this.log.warn('Could not seed band', {
            index,
            band: band.id,
            error: error?.message,
          });
        }
      }
      for (const index of indexes) {
        publishSeedingBands.set(
          { index: index.name },
          seedingByIndex.get(index.name) ?? 0,
        );
      }

      const state = await this.state.load();
      // Only the publisher's own: the subscriber seeds installed bands too.
      for (const [id, seeded] of Object.entries(state.seeding)) {
        if (seeded.owner !== 'publisher' || wanted.has(id)) continue;
        try {
          await transport.remove(id);
        } catch (error: any) {
          this.log.warn('Could not stop seeding a band', {
            id,
            error: error?.message,
          });
          wanted.set(id, seeded); // try again next scan
        }
      }
      await this.state.update((draft) => {
        for (const [id, seeded] of Object.entries(draft.seeding)) {
          if (seeded.owner === 'publisher' && !wanted.has(id)) {
            delete draft.seeding[id];
          }
        }
        for (const [id, seeded] of wanted) draft.seeding[id] = seeded;
      });
    }

    // Seed directories nothing offers any more. Only once the engine has
    // let go of them, or when there is no engine to hold them.
    const stillSeeded = new Set(
      Object.values((await this.state.load()).seeding)
        .filter((seeded) => seeded.owner === 'publisher')
        .map((seeded) => seeded.dir),
    );
    if (transport !== undefined && !available) return;
    const existing = await fs.readdir(seedRoot).catch(() => [] as string[]);
    for (const name of existing) {
      const dir = path.join(seedRoot, name);
      if (wantedDirs.has(name) || stillSeeded.has(dir)) continue;
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  /** Consecutive scans each band directory has failed to describe. */
  private readonly describeFailures = new Map<string, number>();

  /**
   * Whether a band that failed to describe should hold the current document
   * rather than be withdrawn from it.
   *
   * Only a band the document offers, whose manifest is still there, that
   * this publisher has not itself retired, and only for a bounded number of
   * scans. A band with no manifest was withdrawn (by an operator, or by a
   * supersede), and holding the document for it would stop this publisher
   * publishing for good; so would a band that stays broken.
   */
  private async isTransientlyUnreadable(
    indexName: string,
    dir: string,
    publishedIds: ReadonlySet<string>,
  ): Promise<boolean> {
    const bandId = path.basename(dir);
    if (!publishedIds.has(bandId)) return false;
    const retired = (await this.state.load()).publishedBands[indexName];
    if (
      retired !== undefined &&
      Object.prototype.hasOwnProperty.call(retired, bandId) &&
      retired[bandId].retiredAt !== undefined
    ) {
      return false;
    }
    try {
      await fs.stat(path.join(dir, 'manifest.json'));
    } catch (error: any) {
      if (error?.code === 'ENOENT') return false;
      // Any other error (EACCES, EIO) is the kind of trouble that passes.
    }
    const failures = (this.describeFailures.get(dir) ?? 0) + 1;
    this.describeFailures.set(dir, failures);
    if (failures > MAX_HELD_SCANS) {
      this.log.error(
        'Published band has been unreadable too long; withdrawing it',
        {
          index: indexName,
          band: bandId,
          scans: failures,
        },
      );
      return false;
    }
    return true;
  }

  /** Stop offering a band, and forget its cached description. */
  private async retireBand(
    kind: ArtifactKind,
    indexName: string,
    dir: string,
    bandId: string,
  ): Promise<void> {
    const state = await this.state.load();
    const retired = { ...(state.publishedBands[indexName] ?? {}) };
    if (
      Object.prototype.hasOwnProperty.call(retired, bandId) &&
      retired[bandId].retiredAt !== undefined
    ) {
      return;
    }

    const next = await kind.retire({ bandId, dir, current: retired });
    await this.state.update((draft) => {
      applyBandChanges(draft.publishedBands, indexName, retired, next);
      delete draft.describeCache[dir];
    });
    this.log.info('Retired superseded band', { index: indexName, id: bandId });
  }

  /** Delete the files of bands retired longer ago than the grace period. */
  private async sweep(): Promise<void> {
    const state = await this.state.load();
    for (const entry of this.publish) {
      const kind = this.kinds.get(entry.kind);
      const live = state.publishedBands[entry.name];
      if (kind === undefined || live === undefined) continue;
      const current = { ...live };

      const next = await kind.sweepRetired({
        current,
        dirFor: (bandId) => path.join(this.publishedDir, entry.name, bandId),
        graceMs: this.supersedeGraceMs,
      });
      if (Object.keys(next).length !== Object.keys(current).length) {
        await this.state.update((draft) => {
          applyBandChanges(draft.publishedBands, entry.name, current, next);
        });
      }
    }
  }

  /**
   * Hard-link every published file under its own digest.
   *
   * Hard links rather than copies: the bytes exist once on disk however many
   * names point at them, so the content-addressed route costs nothing beyond
   * a directory entry. Both paths are on the same volume, which is what makes
   * that possible. A link also pins the bytes that were hashed: a band
   * rebuilt under the same name gets a new inode, and the link keeps the old.
   *
   * @throws when any link could not be made. The gateway answers 503 for a
   *   digest with no link and subscribers fetch by digest, so a document
   *   naming one would advertise a file nobody can get; the scan fails
   *   instead, and the next one tries again.
   */
  private async linkBlobs(indexes: IndexEntry[]): Promise<void> {
    await fs.mkdir(this.blobsDir, { recursive: true });
    let failed = 0;
    for (const [digest, source] of this.blobSources(indexes)) {
      const target = path.join(this.blobsDir, digest);
      try {
        await fs.link(source, target);
      } catch (error: any) {
        if (error?.code === 'EEXIST') continue;
        failed++;
        this.log.error('Could not link blob; its digest cannot be served', {
          digest,
          source,
          error: error?.message,
        });
      }
    }
    if (failed > 0) {
      throw new Error(
        `Could not link ${failed} blob(s) under ${this.blobsDir}; not publishing`,
      );
    }
  }

  /** Drop links to digests the publication no longer names. */
  private async pruneBlobs(indexes: IndexEntry[]): Promise<void> {
    const wanted = this.blobSources(indexes);
    let existing: string[];
    try {
      existing = await fs.readdir(this.blobsDir);
    } catch {
      return;
    }
    for (const name of existing) {
      if (wanted.has(name)) continue;
      try {
        await fs.unlink(path.join(this.blobsDir, name));
      } catch {
        // Left behind; the next scan tries again.
      }
    }
  }

  /** Each digest the indexes name, with the named file it came from. */
  private blobSources(indexes: IndexEntry[]): Map<string, string> {
    const sources = new Map<string, string>();
    for (const index of indexes) {
      for (const band of index.bands) {
        for (const file of band.files) {
          sources.set(
            file.sha256,
            path.join(this.publishedDir, index.name, band.id, file.name),
          );
        }
      }
    }
    return sources;
  }

  /** The bytes currently served, so the next document chains to exactly them. */
  private async currentDocument(): Promise<
    { digest: string; publication: IndexPublication } | undefined
  > {
    try {
      const raw = await fs.readFile(this.publicationFile);
      return {
        digest: manifestSha256(raw),
        publication: JSON.parse(raw.toString('utf8')) as IndexPublication,
      };
    } catch {
      return undefined;
    }
  }

  private inFlight: Promise<boolean> | undefined;

  /**
   * Run one scan. A call while a scan is still running joins it: describing
   * a large band takes minutes, longer than the scan interval, and two scans
   * at once would hash the same files twice and race to sign and write the
   * document.
   *
   * @returns whether a new document was written.
   */
  /** Wait for a scan in progress to finish, as a shutdown does. */
  async drain(): Promise<void> {
    await this.inFlight?.catch(() => undefined);
  }

  scanOnce(): Promise<boolean> {
    if (this.inFlight === undefined) {
      this.inFlight = this.scan()
        .catch((error: unknown) => {
          // Counted here so every way a scan can fail reaches the metric,
          // not only the ones collectIndex anticipates.
          for (const entry of this.publish) {
            publishTotal.inc({ index: entry.name, result: 'failed' });
          }
          throw error;
        })
        .finally(() => {
          this.inFlight = undefined;
        });
    }
    return this.inFlight;
  }

  private async scan(): Promise<boolean> {
    const current = await this.currentDocument();
    const indexes: IndexEntry[] = [];
    try {
      for (const entry of this.publish) {
        const publishedIds = new Set(
          (
            current?.publication.indexes.find((i) => i.name === entry.name)
              ?.bands ?? []
          ).map((band) => band.id),
        );
        const collected = await this.collectIndex(entry, publishedIds);
        if (collected !== undefined) indexes.push(collected);
      }
    } finally {
      // Even when collecting fails: a retired band must still be removed
      // once its grace has passed, or its directory stays forever.
      await this.sweep();
    }

    const now = this.now();

    // Content is compared on its own, because issuedAt moves every scan and
    // comparing whole documents would republish every time.
    //
    // Canonically, not with JSON.stringify: the document on disk was written
    // in canonical form, so its keys come back sorted, while a freshly built
    // one carries insertion order. Comparing the two as plain strings always
    // differs, which would rewrite the document and bump the sequence on
    // every scan, churning subscribers and making the sequence meaningless.
    const contentChanged =
      current === undefined ||
      canonicalize(current.publication.indexes) !== canonicalize(indexes);

    // Republish a quiet publisher before its document expires, or a
    // subscriber would read "nothing has changed" as "this publisher is
    // dead". Half the TTL leaves a full half-life of margin for a scan that
    // fails or a node that is down.
    const ageMs =
      current === undefined
        ? Number.POSITIVE_INFINITY
        : now.getTime() - Date.parse(current.publication.issuedAt);
    const stale = Number.isNaN(ageMs) || ageMs >= this.ttlMs / 2;

    // A served document this key can no longer vouch for is republished at
    // once rather than at the next refresh: one signed in an older format
    // after an upgrade, or by the previous observer key after a rotation.
    // Subscribers refuse it, so leaving it up would stall them for half a
    // TTL.
    const signatureCurrent =
      current !== undefined &&
      current.publication.signature?.keyId === this.signer.keyId &&
      verifyIndexPublication(
        current.publication,
        crypto.createPublicKey(this.signer.privateKey),
      ).ok;

    if (!contentChanged && !stale && signatureCurrent) {
      // The document stands, but its links must still be there: one deleted
      // since (by hand, or by a failed earlier scan) would otherwise stay
      // missing until the next republish. An existing link costs an EEXIST.
      await this.linkBlobs(indexes);
      await this.reconcileSeeding(indexes);
      for (const entry of this.publish) {
        publishTotal.inc({ index: entry.name, result: 'unchanged' });
      }
      publishManifestAge.set(ageMs / 1000);
      return false;
    }

    const state = await this.state.load();
    // The served document is the authority on what subscribers have seen.
    // State is re-derivable and can be lost or reset to empty while
    // publication.json survives; counting from state alone would restart at
    // 1 below the sequence every subscriber holds, and they would refuse
    // every new document until the counter caught up.
    const servedSequence = current?.publication.sequence ?? 0;
    const previousSequence = Math.max(
      state.published?.sequence ?? 0,
      servedSequence,
    );

    const document: IndexPublication = {
      version: 1,
      publisher: this.signer.wallet,
      sequence: previousSequence + 1,
      previousManifestSha256: current?.digest ?? null,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      indexes,
    };

    const signed = signIndexPublication(
      document,
      this.signer.privateKey,
      this.signer.keyId,
    );
    const serialized = serializeIndexPublication(signed);

    await fs.mkdir(path.dirname(this.publicationFile), { recursive: true });
    const tmpPath = `${this.publicationFile}.tmp`;
    // Link first: the blob route refuses a digest it has no link for, so
    // every digest the document names must have one before it is served.
    // Links to digests it no longer names go only once it is in place.
    await this.linkBlobs(indexes);
    await fs.writeFile(tmpPath, serialized, 'utf8');
    await fs.rename(tmpPath, this.publicationFile);
    await this.pruneBlobs(indexes);
    await this.reconcileSeeding(indexes);

    await this.state.update((draft) => {
      draft.published = {
        sequence: document.sequence,
        manifestSha256: manifestSha256(serialized),
        updatedAt: now.toISOString(),
      };
    });

    publishSequence.set(document.sequence);
    publishManifestAge.set(0);
    for (const entry of this.publish) {
      publishTotal.inc({ index: entry.name, result: 'published' });
    }

    this.log.info('Published index manifest', {
      sequence: document.sequence,
      reason: contentChanged
        ? 'content changed'
        : !signatureCurrent
          ? 'signature no longer verifies'
          : 'refreshing before expiry',
      indexes: indexes.map((index) => `${index.name}:${index.bands.length}`),
    });

    return true;
  }
}
