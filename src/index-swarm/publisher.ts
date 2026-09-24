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
  IndexEntry,
  IndexPublication,
  manifestSha256,
  serializeIndexPublication,
  signIndexPublication,
} from '../lib/index-publication.js';
import { isCdb64TempDirName } from '../lib/cdb64-manifest.js';
import {
  getSolanaAddress,
  loadSolanaKeypair,
  loadSolanaKeypairFromBase58,
} from '../lib/httpsig.js';
import * as config from './config.js';
import { applyBandChanges, StateStore } from './state.js';
import { ArtifactKind } from './kinds/types.js';
import {
  publishBands,
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

/** Name, size and mtime of every file in a band, as one digest. */
async function fingerprintBand(dir: string): Promise<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const parts: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue;
    const stat = await fs.stat(path.join(dir, entry.name));
    parts.push(`${entry.name}:${stat.size}:${stat.mtimeMs}`);
  }
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
}

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
  /** Injectable for tests. */
  now?: () => Date;
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
    return entries
      .filter((entry) => entry.isDirectory() && !isCdb64TempDirName(entry.name))
      .map((entry) => path.join(indexDir, entry.name))
      .sort();
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

  /** Build the entry for one configured index, retiring superseded bands. */
  private async collectIndex(
    entry: config.PublishConfig,
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
      if (band !== undefined) described.push({ dir, band });
    }

    // A band can name the one it replaces, so the publisher can stop offering
    // the old one without an operator having to delete it by hand.
    const superseded = new Set<string>();
    for (const { band } of described) {
      const claim = band.metadata?.supersedes;
      if (typeof claim === 'string') superseded.add(claim);
      else if (Array.isArray(claim)) {
        for (const id of claim) {
          if (typeof id === 'string') superseded.add(id);
        }
      }
    }

    const live = described.filter(({ band }) => !superseded.has(band.id));

    for (const { dir, band } of described) {
      if (!superseded.has(band.id)) continue;
      await this.retireBand(kind, entry.name, dir, band.id);
    }

    publishBands.set({ index: entry.name }, live.length);

    const indexEntry: IndexEntry = {
      name: entry.name,
      kind: entry.kind,
      bands: live.map(({ band }) => ({
        ...band,
        http: { baseUrl: `/ar-io/indexes/${entry.name}/${band.id}/` },
      })),
    };
    if (entry.filter !== undefined) {
      indexEntry.filter = entry.filter;
    }
    return indexEntry;
  }

  /** Stop offering a band, and forget its cached description. */
  private async retireBand(
    kind: ArtifactKind,
    indexName: string,
    dir: string,
    bandId: string,
  ): Promise<void> {
    const state = await this.state.load();
    const retired = state.publishedBands[indexName] ?? {};
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
      const current = state.publishedBands[entry.name];
      if (kind === undefined || current === undefined) continue;

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
      this.inFlight = this.scan().finally(() => {
        this.inFlight = undefined;
      });
    }
    return this.inFlight;
  }

  private async scan(): Promise<boolean> {
    const indexes: IndexEntry[] = [];
    for (const entry of this.publish) {
      const collected = await this.collectIndex(entry);
      if (collected !== undefined) indexes.push(collected);
    }

    await this.sweep();

    const current = await this.currentDocument();
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

    if (!contentChanged && !stale) {
      // The document stands, but its links must still be there: one deleted
      // since (by hand, or by a failed earlier scan) would otherwise stay
      // missing until the next republish. An existing link costs an EEXIST.
      await this.linkBlobs(indexes);
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
      reason: contentChanged ? 'content changed' : 'refreshing before expiry',
      indexes: indexes.map((index) => `${index.name}:${index.bands.length}`),
    });

    return true;
  }
}
