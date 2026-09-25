/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The subscriber loop.
 *
 * Keeps this node's installed bands equal to what its publishers offer,
 * verifying at every step. Nothing a publisher says is taken on trust: the
 * registry decides which key may sign, the signature decides whether the
 * document is authentic, the sequence decides whether it is current, the
 * digests decide whether the bytes are the ones named, and the artifact kind
 * decides whether they are the shape the gateway can serve. Only then does a
 * band become live.
 *
 * Failure is always toward keeping what works: a publisher that is
 * unreachable, lying, or behind leaves the bands already installed exactly
 * where they are.
 */
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import { constants as fsConstants, existsSync } from 'node:fs';
import * as path from 'node:path';
import pLimit from 'p-limit';
import { Logger } from 'winston';

import {
  BandDescriptor,
  BandFile,
  IndexEntry,
  IndexPublication,
  INDEX_PUBLICATION_MAX_BYTES,
  manifestSha256,
  parseIndexPublicationDocument,
  verifyIndexPublication,
} from '../lib/index-publication.js';
import { publicKeyFromSolanaAddress } from '../lib/httpsig.js';
import {
  completedFile,
  DownloadHttpError,
  DownloadIntegrityError,
  downloadFile,
} from '../lib/http-file-download.js';
import { SubscribeConfig } from './config.js';
import {
  applyBandChanges,
  InstalledBand,
  SeededBand,
  seedingKey,
  StateStore,
  SwarmDownload,
} from './state.js';
import { ArtifactKind } from './kinds/types.js';
import { GatewayRegistry, PublisherRecord } from './gateway-registry.js';
import { checkTorrentFiles, sanitizeTorrent, torrentIds } from './torrent.js';
import { TorrentTransport } from './transport/types.js';
import {
  engineAvailable,
  installedBands,
  subscriptionBytes,
  publicationIssuedAt,
  subscriptionSequence,
  subscriptionTotal,
} from './metrics.js';

/**
 * A publication's bands in the order to install them: newest heights first.
 *
 * Most lookups are for recent data, so the tip band does most of the work
 * (on the first turbo-gateway pull it answered 63% of lookups on its own).
 * Under a publisher's meter, which bands arrive first decides how soon a
 * subscription starts to pay off. Ordered by the top of each band's
 * `heightRange` (an open-ended tip band first), then by its bottom. Bands
 * with no range go last, and ties keep the publisher's order.
 */
export function bandsNewestFirst(bands: BandDescriptor[]): BandDescriptor[] {
  const top = (band: BandDescriptor): number =>
    band.heightRange === undefined
      ? -1
      : (band.heightRange[1] ?? Number.POSITIVE_INFINITY);
  const bottom = (band: BandDescriptor): number => band.heightRange?.[0] ?? -1;
  return bands
    .map((band, position) => ({ band, position }))
    .sort(
      (a, b) =>
        top(b.band) - top(a.band) ||
        bottom(b.band) - bottom(a.band) ||
        a.position - b.position,
    )
    .map(({ band }) => band);
}

/** Whether a publisher's meter has refused this subscriber during one poll. */
interface PollMeter {
  refused: boolean;
  /** Whether the torrent engine answered, once asked this poll. */
  engineUp?: boolean;
  /** When this poll stops watching torrents, shared by all its bands. */
  watchUntil?: number;
}

/**
 * How far past the last seen sequence a publisher's next document may be.
 * At one publish a minute that is nearly two years of headroom.
 */
export const MAX_SEQUENCE_JUMP = 1_000_000;

/** Distinct index names labelled per publisher on the result metric. */
export const MAX_INDEX_LABELS_PER_PUBLISHER = 16;

/** How long an untracked band directory must sit untouched to count as an orphan. */
const UNTRACKED_MIN_AGE_MS = 10 * 60_000;

/**
 * Separates a band id from its generation in an installed directory name.
 * A band id can't contain it, so no directory name is ambiguous.
 */
const GENERATION_SEPARATOR = '~';

/** A short digest of a band's files: its identity on disk. */
export function bandGeneration(band: BandDescriptor): string {
  const lines = band.files
    .map((file) => `${file.name}\0${file.size}\0${file.sha256}`)
    .sort();
  return crypto
    .createHash('sha256')
    .update(lines.join('\n'))
    .digest('hex')
    .slice(0, 12);
}

/** An entry of a remote-keyed map, never a prototype member. */
function ownEntry<T>(
  map: Record<string, T> | undefined,
  key: string,
): T | undefined {
  return map !== undefined && Object.prototype.hasOwnProperty.call(map, key)
    ? map[key]
    : undefined;
}

/** Total size of the regular files under `dir`; 0 if it doesn't exist. */
async function directoryBytes(dir: string): Promise<number> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directoryBytes(full);
    } else if (entry.isFile()) {
      try {
        total += (await fs.stat(full)).size;
      } catch {
        // Gone since the listing; nothing to count.
      }
    }
  }
  return total;
}

/** A band naming its files on a server this node won't fetch from. */
class DisallowedOriginError extends Error {
  constructor(baseUrl: string) {
    super(
      `band files are on ${baseUrl}, which is neither the publication's origin nor in INDEX_SWARM_ALLOWED_FILE_ORIGINS`,
    );
    this.name = 'DisallowedOriginError';
  }
}

/** A file not started because the publisher's meter already refused one. */
class MeteredError extends Error {
  constructor() {
    super('not started: the publisher is metering this subscriber');
    this.name = 'MeteredError';
  }
}

/**
 * Where to fetch one band file from.
 *
 * A band whose files live on the publisher's own gateway (a relative
 * `baseUrl`) is fetched by digest from the blob route rather than by name.
 * The blob address can never change meaning, so an edge cache or CDN in
 * front of the publisher may keep it indefinitely, whereas a name is reused
 * whenever a band is rebuilt and must be revalidated. An absolute `baseUrl`
 * names some other server, whose layout this cannot assume, so its files are
 * fetched as named.
 */
export function fileUrl(
  origin: string,
  baseUrl: string,
  file: BandFile,
  allowedOrigins: ReadonlySet<string> = new Set(),
): string | undefined {
  if (/^https?:\/\//i.test(baseUrl)) {
    // The document is signed, but a signed URL is still one the publisher
    // chose, and fetching it from inside the gateway's network is a request
    // to wherever it points: a metadata endpoint, ClickHouse, redis. The
    // digest check protects the bytes, not the request. So another server is
    // fetched only if it shares the publication's origin or the operator
    // listed it.
    let target: URL;
    try {
      target = new URL(`${baseUrl}${file.name}`);
    } catch {
      return undefined;
    }
    const sameOrigin = target.origin === new URL(origin).origin;
    if (!sameOrigin && !allowedOrigins.has(target.origin)) {
      return undefined;
    }
    return target.toString();
  }
  return new URL(`/ar-io/indexes/blob/${file.sha256}`, origin).toString();
}

/** True when two file lists name the same bytes, in any order. */
export function sameFiles(a: BandFile[], b: BandFile[]): boolean {
  if (a.length !== b.length) return false;
  const key = (file: BandFile) => `${file.name}\0${file.size}\0${file.sha256}`;
  const left = new Set(a.map(key));
  return b.every((file) => left.has(key(file)));
}

/** Every way a subscription can end, as reported on the result metric. */
export type SubscriptionResult =
  | 'installed'
  | 'unchanged'
  | 'replayed'
  | 'sequence_jump'
  | 'signature_failed'
  | 'verify_failed'
  | 'download_failed'
  | 'skipped_disk_budget'
  | 'band_conflict'
  | 'unknown_kind'
  | 'unreachable'
  | 'transport_fallback'
  | 'error';

export interface SubscriberOptions {
  log: Logger;
  state: StateStore;
  kinds: Map<string, ArtifactKind>;
  registry: GatewayRegistry;
  subscribe: SubscribeConfig[];
  trustedPublishers: string[];
  incomingDir: string;
  installedDir: string;
  fetchTimeoutMs: number;
  /**
   * Give up on a band file download once no bytes have arrived for this
   * long. A stall, not a cap on the whole transfer: band files are large and
   * links slow, and a download still moving is never cut off.
   */
  downloadStallTimeoutMs?: number;
  downloadConcurrency: number;
  supersedeGraceMs: number;
  maxDiskBytes?: number;
  downloadRateLimitBytesPerSec?: number;
  /**
   * Origins (`https://host[:port]`) a band may name for its files besides
   * the publication's own. See {@link fileUrl}.
   */
  allowedFileOrigins?: string[];
  /**
   * Sent on every request to a publisher, so a publisher can tell its
   * subscribers apart even when several share one IP.
   */
  userAgent?: string;
  /**
   * The least time an old copy of a band keeps serving after its
   * replacement is installed. The gateway loads a new band directory a
   * second or more after it appears (its watcher waits for writes to
   * settle, and a busy disk is slower), so retiring the old copy at once
   * would leave lookups to the band missing in between. The old copy is
   * retired by the first housekeeping after this, normally the next poll.
   * Costs only disk. Default 60 s.
   */
  replaceOverlapMs?: number;
  /**
   * How long a band directory no record points at must sit unchanged before
   * it is retired as an orphan. Default 10 minutes.
   */
  untrackedMinAgeMs?: number;
  /**
   * The torrent engine. Unset, or unavailable, every band moves over HTTP;
   * set, a band offered as a torrent is fetched from peers first and every
   * installed band that offers one is seeded.
   */
  transport?: TorrentTransport;
  /**
   * Where the engine downloads, one directory per torrent. The only place
   * the engine may write, and on the same filesystem as installedDir, so an
   * install is a rename. Default `<incomingDir>/../swarm`.
   */
  swarmDir?: string;
  /**
   * Checked `.torrent` files kept for seeding, by v1 infohash. Only the
   * sidecar reads them. Default `<incomingDir>/../torrents`.
   */
  torrentsDir?: string;
  /** Give up on a torrent and fetch over HTTP after this long. */
  torrentTimeoutMs?: number;
  /** Turn the publisher's WebSeed on once a torrent has not moved for this long. */
  webSeedAfterMs?: number;
  /** How long one poll watches a torrent before leaving it for the next. */
  torrentWatchMs?: number;
  /** How often a watched torrent is checked. */
  torrentCheckMs?: number;
  /**
   * The engine's user and group. The sidecar runs as root and the engine
   * does not, so a download directory is handed to the engine before use.
   */
  engineUid?: number;
  engineGid?: number;
  /**
   * Tracker announce URLs handed to the engine even though their host is
   * private, exactly as written. See {@link sanitizeTorrent}.
   */
  allowedTrackers?: string[];
  now?: () => Date;
}

/** Where a file copied out of the engine's directory is written first. */
function swarmPartialName(file: BandFile): string {
  return `${file.name}.${file.sha256.slice(0, 16)}.swarm.tmp`;
}

/** Largest `.torrent` accepted. A band of 1024 files is well under this. */
const MAX_TORRENT_BYTES = 16 * 1024 * 1024;

type TorrentOutcome =
  | { kind: 'pending' }
  | { kind: 'fallback' }
  | { kind: 'done'; dir: string };

export class Subscriber {
  private readonly log: Logger;
  private readonly state: StateStore;
  private readonly kinds: Map<string, ArtifactKind>;
  private readonly registry: GatewayRegistry;
  private readonly subscribe: SubscribeConfig[];
  private readonly trustedPublishers: Set<string>;
  private readonly incomingDir: string;
  private readonly installedDir: string;
  private readonly fetchTimeoutMs: number;
  private readonly downloadStallTimeoutMs: number;
  private readonly downloadConcurrency: number;
  private readonly supersedeGraceMs: number;
  private readonly maxDiskBytes?: number;
  private readonly downloadRateLimitBytesPerSec?: number;
  private readonly allowedFileOrigins: ReadonlySet<string>;
  private readonly requestHeaders: Record<string, string>;
  private readonly replaceOverlapMs: number;
  private readonly untrackedMinAgeMs: number;
  private readonly subscribedPublishers: ReadonlySet<string>;
  private readonly transport?: TorrentTransport;
  private readonly swarmDir: string;
  private readonly torrentsDir: string;
  private readonly torrentTimeoutMs: number;
  private readonly webSeedAfterMs: number;
  private readonly torrentWatchMs: number;
  private readonly torrentCheckMs: number;
  private readonly engineUid?: number;
  private readonly engineGid?: number;
  private readonly allowedTrackers: ReadonlySet<string>;
  private readonly now: () => Date;

  constructor(options: SubscriberOptions) {
    this.log = options.log.child({ class: 'Subscriber' });
    this.state = options.state;
    this.kinds = options.kinds;
    this.registry = options.registry;
    this.subscribe = options.subscribe;
    this.trustedPublishers = new Set(options.trustedPublishers);
    this.incomingDir = options.incomingDir;
    this.installedDir = options.installedDir;
    this.fetchTimeoutMs = options.fetchTimeoutMs;
    this.downloadStallTimeoutMs = options.downloadStallTimeoutMs ?? 60_000;
    this.downloadConcurrency = options.downloadConcurrency;
    this.supersedeGraceMs = options.supersedeGraceMs;
    this.maxDiskBytes = options.maxDiskBytes;
    this.downloadRateLimitBytesPerSec = options.downloadRateLimitBytesPerSec;
    this.allowedFileOrigins = new Set(
      (options.allowedFileOrigins ?? []).map((o) => new URL(o).origin),
    );
    this.requestHeaders =
      options.userAgent !== undefined
        ? { 'user-agent': options.userAgent }
        : {};
    this.replaceOverlapMs = options.replaceOverlapMs ?? 60_000;
    this.untrackedMinAgeMs = options.untrackedMinAgeMs ?? UNTRACKED_MIN_AGE_MS;
    this.subscribedPublishers = new Set(
      options.subscribe.map((subscription) => subscription.publisher),
    );
    if (options.transport !== undefined) this.transport = options.transport;
    const dataDir = path.dirname(options.incomingDir);
    this.swarmDir = options.swarmDir ?? path.join(dataDir, 'swarm');
    this.torrentsDir = options.torrentsDir ?? path.join(dataDir, 'torrents');
    this.torrentTimeoutMs = options.torrentTimeoutMs ?? 3_600_000;
    this.webSeedAfterMs = options.webSeedAfterMs ?? 120_000;
    this.torrentWatchMs = options.torrentWatchMs ?? 60_000;
    this.torrentCheckMs = options.torrentCheckMs ?? 1_000;
    if (options.engineUid !== undefined) this.engineUid = options.engineUid;
    if (options.engineGid !== undefined) this.engineGid = options.engineGid;
    this.allowedTrackers = new Set(options.allowedTrackers ?? []);
    this.now = options.now ?? (() => new Date());
  }

  /** The poll running for each publisher, if any. */
  private readonly polling = new Map<string, Promise<void>>();
  private maintaining: Promise<void> | undefined;
  /** `<index>/<band>` ids being installed right now, by any publisher. */
  private readonly installing = new Set<string>();
  /** v1 infohashes whose completed download is being staged right now. */
  private readonly finishing = new Set<string>();
  /**
   * Publishers whose document has been fetched, verified and reconciled at
   * least once since startup. Until every configured publisher is in here,
   * a band directory state doesn't know may simply not have been adopted
   * yet (after lost state, with a publisher down), so none is retired.
   */
  private readonly reconciledSinceStart = new Set<string>();

  /**
   * Poll every configured publisher once, each independently.
   *
   * A publisher whose poll is still running is joined rather than polled a
   * second time: downloading a large band outlasts the poll interval, and
   * two polls over the same band would race to install it. But a slow
   * publisher, or one trickling bytes under a meter, holds up only itself;
   * every other publisher is polled on schedule.
   */
  pollOnce(): Promise<void> {
    if (this.stopping.signal.aborted) return Promise.resolve();
    const polls = this.subscribe.map((subscription) => {
      let poll = this.polling.get(subscription.publisher);
      if (poll === undefined) {
        poll = this.pollSafely(subscription).finally(() => {
          this.polling.delete(subscription.publisher);
        });
        this.polling.set(subscription.publisher, poll);
      }
      return poll;
    });
    return Promise.all(polls).then(() => this.maintain());
  }

  /** When the last poll of any publisher finished, for the healthcheck. */
  lastPollCompletedAt: Date | undefined;

  private async pollSafely(subscription: SubscribeConfig): Promise<void> {
    try {
      await this.pollSubscription(subscription);
    } catch (error: any) {
      // One bad publisher must not stop the others.
      this.log.error('Subscription poll failed', {
        publisher: subscription.publisher,
        error: error?.message,
        stack: error?.stack,
      });
      this.count(subscription.publisher, '', 'error');
    }
    this.lastPollCompletedAt = this.now();
  }

  /** Housekeeping after polls: stale downloads, retired bands, gauges. */
  private maintain(): Promise<void> {
    if (this.maintaining === undefined) {
      this.maintaining = (async () => {
        await this.discardOrphanedDownloads();
        await this.retireDue();
        await this.retireUnsubscribed();
        await this.retireUntracked();
        await this.cleanSwarm();
        // Before the sweep, so the engine lets go of a retired copy before
        // its files are deleted.
        await this.reconcileSeeding();
        await this.sweep();
        await this.reportInstalled();
      })().finally(() => {
        this.maintaining = undefined;
      });
    }
    return this.maintaining;
  }

  private readonly stopping = new AbortController();

  /**
   * Stop for shutdown: abort downloads in progress (they resume on the next
   * start), start no new polls or installs, and wait for what is running to
   * finish. An install already under way completes, so shutdown never
   * leaves a band half-renamed.
   */
  async stop(): Promise<void> {
    this.stopping.abort();
    await Promise.allSettled([...this.polling.values()]);
    await this.maintaining?.catch(() => undefined);
  }

  /** Index names seen per publisher, for bounding the metric's labels. */
  private readonly labelledIndexes = new Map<string, Set<string>>();

  private count(
    publisher: string,
    index: string,
    result: SubscriptionResult,
    transport = 'http',
  ): void {
    // Index names come from the remote document, so a publisher rotating
    // names could otherwise grow this metric without bound.
    let seen = this.labelledIndexes.get(publisher);
    if (seen === undefined) {
      seen = new Set();
      this.labelledIndexes.set(publisher, seen);
    }
    if (!seen.has(index) && seen.size >= MAX_INDEX_LABELS_PER_PUBLISHER) {
      index = '(other)';
    } else {
      seen.add(index);
    }
    subscriptionTotal.inc({ publisher, index, transport, result });
  }

  /**
   * Fetch a publication, refusing an oversized body before it is buffered.
   *
   * The cap is checked against the declared length and again while reading,
   * because a hostile publisher controls both the header and the stream.
   */
  private async fetchPublication(url: string): Promise<Buffer> {
    const response = await fetch(`${url}/ar-io/indexes`, {
      signal: AbortSignal.timeout(this.fetchTimeoutMs),
      headers: { ...this.requestHeaders, accept: 'application/json' },
      // A redirect is a second request to wherever it points, chosen by
      // whoever answers: from inside the gateway's network that can be an
      // internal service. The publication has one address; nothing needs one.
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const declared = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > INDEX_PUBLICATION_MAX_BYTES) {
      throw new Error(
        `Publication declares ${declared} bytes, over the ${INDEX_PUBLICATION_MAX_BYTES} byte limit`,
      );
    }
    if (response.body === null) {
      throw new Error('Publication response had no body');
    }

    const chunks: Buffer[] = [];
    let total = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done === true) break;
      total += value.length;
      if (total > INDEX_PUBLICATION_MAX_BYTES) {
        await reader.cancel();
        throw new Error(
          `Publication exceeded the ${INDEX_PUBLICATION_MAX_BYTES} byte limit`,
        );
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }

  /** Resolve where to fetch from and which key must have signed. */
  private async resolvePublisher(
    subscription: SubscribeConfig,
  ): Promise<PublisherRecord | undefined> {
    if (
      this.trustedPublishers.size > 0 &&
      !this.trustedPublishers.has(subscription.publisher)
    ) {
      this.log.warn('Publisher is not on the trusted list; skipping', {
        publisher: subscription.publisher,
      });
      return undefined;
    }

    const record = await this.registry.lookup(subscription.publisher);
    if (record === undefined) {
      return undefined;
    }
    // The record must be the one asked for: every later check (the key, the
    // document's publisher) is against it, so a registry answering for some
    // other wallet would make that wallet's documents count as this one's.
    if (record.wallet !== subscription.publisher) {
      this.log.warn('Registry answered for a different wallet; skipping', {
        publisher: subscription.publisher,
        answered: record.wallet,
      });
      return undefined;
    }
    // A URL override changes only where the bytes come from. The key that
    // must have signed still comes from the registry, so pointing this at a
    // mirror cannot change whose documents are accepted.
    return subscription.url !== undefined
      ? { ...record, url: subscription.url }
      : record;
  }

  private async pollSubscription(subscription: SubscribeConfig): Promise<void> {
    const publisher = subscription.publisher;
    const record = await this.resolvePublisher(subscription);
    if (record === undefined) {
      this.count(publisher, '', 'unreachable');
      return;
    }

    let raw: Buffer;
    try {
      raw = await this.fetchPublication(record.url);
    } catch (error: any) {
      this.log.warn('Could not fetch publication', {
        publisher,
        url: record.url,
        error: error?.message,
      });
      this.count(publisher, '', 'unreachable');
      return;
    }

    let document: IndexPublication;
    let signed: IndexPublication;
    try {
      ({ publication: document, signed } = parseIndexPublicationDocument(raw));
    } catch (error: any) {
      this.log.warn('Publication is malformed', {
        publisher,
        error: error?.message,
      });
      this.count(publisher, '', 'verify_failed');
      return;
    }

    // Verified as parsed, unknown fields included; used as validated.
    if (!this.verifyDocument(signed, record)) {
      this.count(publisher, '', 'signature_failed');
      return;
    }

    const state = await this.state.load();
    const previous = state.subscriptions[publisher];
    const keyId = signed.signature?.keyId;
    // A sequence belongs to the key that signed it; a rotated key starts over.
    const sameKey = previous?.keyId === undefined || previous.keyId === keyId;
    if (previous !== undefined && !sameKey) {
      this.log.warn('Publisher signs with a new key; restarting its sequence', {
        publisher,
        previousKeyId: previous.keyId,
        keyId,
      });
    }
    const seen = sameKey ? (previous?.sequence ?? 0) : 0;

    // A publisher moves one sequence per publish. A document far ahead of
    // what has been seen would, once accepted, make every later genuine
    // document look like a replay, locking the subscription until someone
    // edited the state by hand: refuse it instead. First contact (nothing
    // seen) accepts any sequence.
    if (seen > 0 && document.sequence > seen + MAX_SEQUENCE_JUMP) {
      this.log.warn('Refusing a publication that jumps too far ahead', {
        publisher,
        offered: document.sequence,
        seen,
        maxJump: MAX_SEQUENCE_JUMP,
      });
      this.count(publisher, '', 'sequence_jump');
      return;
    }

    // The sequence guards against rollback and nothing else. It deliberately
    // does not gate the reconcile below, because it records what has been
    // *seen*, not what has been successfully installed: a band that failed to
    // download, was skipped by the disk budget, or belonged to a kind this
    // node could not handle yet would otherwise never be retried until the
    // publisher happened to publish again. On a twelve-hour cadence that is a
    // band missing for twelve hours with nothing trying to fix it.
    //
    // Reconciling is idempotent and costs a state comparison when everything
    // is already in place, so re-running it on every poll is what makes the
    // subscriber self-healing.
    if (document.sequence < seen) {
      this.log.warn('Refusing an older publication', {
        publisher,
        offered: document.sequence,
        installed: seen,
      });
      this.count(publisher, '', 'replayed');
      this.reportAge(publisher, document);
      return;
    }

    const expiresAt = Date.parse(document.expiresAt);
    if (!Number.isNaN(expiresAt) && expiresAt < this.now().getTime()) {
      // Worth saying, but not worth refusing: an expired document is a signal
      // that the publisher has gone quiet, and its bands are still valid.
      this.log.warn('Publication has expired; installing it anyway', {
        publisher,
        expiresAt: document.expiresAt,
      });
    }

    let installedAnything = false;
    // One per poll of this publisher: once its meter refuses a file, no
    // band of any of its indexes starts another until the next poll.
    const meter: PollMeter = { refused: false };
    for (const index of document.indexes) {
      if (subscription.name !== undefined && subscription.name !== index.name) {
        continue;
      }
      const kind = this.kinds.get(index.kind);
      if (kind === undefined) {
        // A publisher offering a kind this node does not understand is
        // normal; take the kinds that are usable and move on.
        this.log.debug('Skipping an index of an unknown kind', {
          publisher,
          index: index.name,
          kind: index.kind,
        });
        this.count(publisher, index.name, 'unknown_kind');
        continue;
      }
      if (
        await this.reconcileIndex(publisher, record.url, index, kind, meter)
      ) {
        installedAnything = true;
      }
    }

    // An index the publisher has dropped altogether never reaches
    // reconcileIndex, so its bands are retired here.
    const published = new Set(document.indexes.map((index) => index.name));
    const fallbackKind = this.kinds.values().next().value;
    if (fallbackKind !== undefined) {
      for (const indexName of Object.keys(
        (await this.state.load()).installed,
      )) {
        if (published.has(indexName)) continue;
        await this.retireUnoffered(
          publisher,
          indexName,
          new Set(),
          fallbackKind,
        );
      }
    }

    await this.state.update((draft) => {
      draft.subscriptions[publisher] = {
        sequence: Math.max(document.sequence, seen),
        ...(keyId !== undefined ? { keyId } : {}),
        // The digest of the bytes as served, the same value the publisher
        // records for its own document.
        manifestSha256: manifestSha256(raw),
        updatedAt: this.now().toISOString(),
      };
    });

    this.reconciledSinceStart.add(publisher);
    subscriptionSequence.set({ publisher }, document.sequence);
    this.reportAge(publisher, document);

    if (!installedAnything) {
      this.count(publisher, '', 'unchanged');
      return;
    }

    this.log.info('Subscription updated', {
      publisher,
      sequence: document.sequence,
      installed: installedAnything,
    });
  }

  /**
   * Check that the document was signed by the key the registry names for
   * this publisher.
   *
   * The registry is the anchor: a signature that verifies against some other
   * key proves only that somebody signed something.
   */
  private verifyDocument(
    document: IndexPublication,
    record: PublisherRecord,
  ): boolean {
    const signature = document.signature;
    if (signature === undefined) {
      this.log.warn('Publication is unsigned', { publisher: record.wallet });
      return false;
    }
    if (signature.keyId !== record.observerAddress) {
      this.log.warn('Publication was signed by an unregistered key', {
        publisher: record.wallet,
        signedBy: signature.keyId,
        registered: record.observerAddress,
      });
      return false;
    }
    if (document.publisher !== record.wallet) {
      this.log.warn('Publication names a different publisher', {
        expected: record.wallet,
        found: document.publisher,
      });
      return false;
    }

    let verifying;
    try {
      verifying = publicKeyFromSolanaAddress(signature.keyId);
    } catch (error: any) {
      this.log.warn('Publication key id is not an address', {
        publisher: record.wallet,
        error: error?.message,
      });
      return false;
    }

    const result = verifyIndexPublication(document, verifying);
    if (!result.ok) {
      this.log.warn('Publication signature did not verify', {
        publisher: record.wallet,
        reason: result.reason,
      });
      return false;
    }
    return true;
  }

  private reportAge(publisher: string, document: IndexPublication): void {
    const issued = Date.parse(document.issuedAt);
    if (!Number.isNaN(issued)) {
      // Only ever moves forward: a replayed older document must not make a
      // publisher look fresher than it is.
      const previous = publicationIssuedAt.get(publisher) ?? 0;
      publicationIssuedAt.set(publisher, Math.max(previous, issued));
    }
  }

  /**
   * Bytes the budget counts: every installed band (retired ones not yet
   * swept included) and everything in `incoming/`, where partial and
   * completed downloads wait. The live copy of a band being replaced is
   * left out, since it is retired as soon as its replacement is in:
   * counting it would stall a subscriber near its budget on a stale tip
   * forever.
   */
  /**
   * Bytes the subscriber holds on disk: installed copies, plus downloads in
   * progress.
   *
   * @param ownPartials this band's own partial downloads, left out: they
   *   are part of the band's size, which the caller adds, and counting them
   *   too would refuse a band that is already most of the way down.
   */
  private async diskBytes(
    replacing?: InstalledBand,
    ownPartials: string[] = [],
  ): Promise<number> {
    const state = await this.state.load();
    let total = 0;
    for (const bands of Object.values(state.installed)) {
      for (const band of Object.values(bands)) {
        if (band === replacing) continue;
        for (const file of band.files) total += file.size;
      }
    }
    let own = 0;
    for (const dir of ownPartials) own += await directoryBytes(dir);
    return (
      total +
      (await directoryBytes(this.incomingDir)) +
      (await directoryBytes(this.swarmDir)) -
      own
    );
  }

  /** Install what is new in this index, and retire what the publisher dropped. */
  private async reconcileIndex(
    publisher: string,
    origin: string,
    index: IndexEntry,
    kind: ArtifactKind,
    meter: PollMeter,
  ): Promise<boolean> {
    let installedAnything = false;

    for (const band of bandsNewestFirst(index.bands)) {
      const state = await this.state.load();
      const existing = ownEntry(state.installed[index.name], band.id);
      // Matching on the id alone would pin a subscriber to the first copy of
      // a band the publisher rebuilds under the same id, which the rolling
      // tip band always is. A band is its files, so compare those.
      if (
        existing !== undefined &&
        existing.retiredAt === undefined &&
        sameFiles(existing.files, band.files) &&
        // The record can outlive its files (a crash, an operator's rm);
        // reinstall rather than trust a record the gateway can't serve.
        existsSync(path.join(existing.dir, 'manifest.json'))
      ) {
        // However it was installed (over HTTP, adopted from disk), a band
        // the swarm can have is seeded once its torrent is kept.
        await this.keepTorrentFor(
          publisher,
          origin,
          index.name,
          band,
          existing,
        );
        continue;
      }

      const installed = await this.installBand(
        publisher,
        origin,
        index,
        band,
        kind,
        meter,
      );
      if (installed) installedAnything = true;
    }

    // Anything this publisher installed here but no longer offers is retired.
    // Scoped by publisher, so one publisher dropping a band does not remove
    // the copy another publisher still offers.
    await this.retireUnoffered(
      publisher,
      index.name,
      new Set(index.bands.map((band) => band.id)),
      kind,
    );

    return installedAnything;
  }

  /**
   * Retire the bands this publisher installed under `indexName` that are not
   * in `offered`, and discard its downloads of them. Called with an empty
   * set for an index the publisher no longer publishes at all.
   */
  private async retireUnoffered(
    publisher: string,
    indexName: string,
    offered: ReadonlySet<string>,
    kind: ArtifactKind,
  ): Promise<void> {
    await this.discardUnofferedDownloads(publisher, indexName, offered);
    const state = await this.state.load();
    const current = state.installed[indexName] ?? {};
    for (const [bandId, band] of Object.entries(current)) {
      if (offered.has(bandId)) continue;
      if (band.publisher !== publisher) continue;
      if (band.retiredAt !== undefined) continue;
      // A replaced copy on its way out is retired by housekeeping, not here.
      if (band.retireAfter !== undefined) continue;

      // Retire against the map as it is now, not as it was before the loop:
      // retire returns a copy of what it is given, so passing the stale map
      // would undo the band retired on the previous iteration.
      // A snapshot, not the live map: load() returns the cached state, which
      // other polls write to while this one awaits.
      const latest = {
        ...((await this.state.load()).installed[indexName] ?? {}),
      };
      const next = await kind.retire({
        bandId,
        dir: band.dir,
        current: latest,
      });
      await this.state.update((draft) => {
        applyBandChanges(draft.installed, indexName, latest, next);
      });
      this.log.info('Retired a band the publisher no longer offers', {
        publisher,
        index: indexName,
        band: bandId,
      });
    }
  }

  /**
   * @param origin where the publication was fetched from, which is where its
   *   relative band URLs resolve: the registry's URL for the publisher, or
   *   the subscription's override. Looking the publisher up again here would
   *   silently drop the override and fetch from the publisher's own host.
   */
  private async installBand(
    publisher: string,
    origin: string,
    index: IndexEntry,
    band: BandDescriptor,
    kind: ArtifactKind,
    meter: PollMeter,
  ): Promise<boolean> {
    // A band the swarm can bring is not held back by the meter: peers are
    // not metered. If it falls back to HTTP, it waits there instead.
    const viaSwarm = band.torrent !== undefined && this.transport !== undefined;
    if (meter.refused && !viaSwarm) {
      // Not a failure of this band: the publisher's meter has already said
      // no this poll, and asking again would only collect another refusal.
      this.log.debug('Publisher is metering this subscriber; band waits', {
        publisher,
        index: index.name,
        band: band.id,
      });
      return false;
    }
    const existing = ownEntry(
      (await this.state.load()).installed[index.name],
      band.id,
    );
    const live =
      existing !== undefined && existing.retiredAt === undefined
        ? existing
        : undefined;
    // A band id belongs to the publisher whose copy is live. Two publishers
    // offering different bytes under one id would otherwise replace each
    // other's copy on every poll, each paying a full download. A copy whose
    // publisher is no longer subscribed to can be taken over.
    if (
      live?.publisher !== undefined &&
      live.publisher !== publisher &&
      this.subscribedPublishers.has(live.publisher)
    ) {
      this.log.warn('Band id is held by another publisher; skipping', {
        publisher,
        index: index.name,
        band: band.id,
        heldBy: live.publisher,
      });
      this.count(publisher, index.name, 'band_conflict');
      return false;
    }

    // Two publishers polled in parallel could otherwise both install one
    // band id at once, leaving one copy on disk that state doesn't know.
    const installKey = `${index.name}/${band.id}`;
    if (this.installing.has(installKey)) return false;
    this.installing.add(installKey);
    try {
      return await this.installBandExclusive(
        publisher,
        origin,
        index,
        band,
        kind,
        meter,
        live,
      );
    } finally {
      this.installing.delete(installKey);
    }
  }

  private async installBandExclusive(
    publisher: string,
    origin: string,
    index: IndexEntry,
    band: BandDescriptor,
    kind: ArtifactKind,
    meter: PollMeter,
    live: InstalledBand | undefined,
  ): Promise<boolean> {
    const bandBytes = band.files.reduce((sum, file) => sum + file.size, 0);
    if (this.maxDiskBytes !== undefined) {
      // A band that may come over the swarm is copied out of the engine's
      // directory before install, so it needs its size twice for a while.
      const need =
        band.torrent !== undefined && this.transport !== undefined
          ? 2 * bandBytes
          : bandBytes;
      const used = await this.diskBytes(live, [
        path.join(this.incomingDir, publisher, index.name, band.id),
        ...(band.torrent !== undefined
          ? [path.join(this.swarmDir, band.torrent.infohashV1)]
          : []),
      ]);
      if (used + need > this.maxDiskBytes) {
        this.log.warn('Band would exceed the disk budget; skipping', {
          publisher,
          index: index.name,
          band: band.id,
          bandBytes,
          used,
          budget: this.maxDiskBytes,
        });
        this.count(publisher, index.name, 'skipped_disk_budget');
        return false;
      }
    }

    const baseUrl = band.http?.baseUrl;
    if (baseUrl === undefined) {
      this.log.warn('Band offers no HTTP location; skipping', {
        publisher,
        index: index.name,
        band: band.id,
      });
      this.count(publisher, index.name, 'unreachable');
      return false;
    }

    if (
      fileUrl(
        origin,
        baseUrl,
        band.files[0] ?? { name: '', size: 0, sha256: '' },
        this.allowedFileOrigins,
      ) === undefined
    ) {
      this.log.warn(
        'Band files are on a server this node does not fetch from; skipping',
        {
          publisher,
          index: index.name,
          band: band.id,
          baseUrl,
          hint: 'list its origin in INDEX_SWARM_ALLOWED_FILE_ORIGINS to allow it',
        },
      );
      this.count(publisher, index.name, 'unreachable');
      return false;
    }

    // Each generation of a band installs into its own directory, so the new
    // copy is loaded before the old one is retired: replacing in place left
    // a window of about a second where every lookup to the band missed.
    const generationDir = path.join(
      this.installedDir,
      index.name,
      `${band.id}${GENERATION_SEPARATOR}${bandGeneration(band)}`,
    );
    // A directory some retired or retiring record still points at will be
    // deleted by the sweep; installing into it (a rollback to a generation
    // retired moments ago) would have the live band deleted with it.
    const claimed = this.claimedDirs(
      (await this.state.load()).installed[index.name],
    );
    const targetDir = claimed.has(path.resolve(generationDir))
      ? `${generationDir}.${this.now().getTime()}`
      : generationDir;

    // A copy already on disk (state lost, or a crash between install and
    // the state write) is adopted rather than fetched again.
    const adopted = await this.adoptInstalledCopy(
      index.name,
      band,
      targetDir,
      claimed,
      kind,
    );
    if (adopted !== undefined) {
      await this.recordInstall(publisher, index.name, band, adopted, live);
      this.log.info('Adopted a band already on disk', {
        publisher,
        index: index.name,
        band: band.id,
        dir: adopted,
      });
      return true;
    }

    // Peers first, when the band is offered as a torrent. A torrent still
    // moving when this poll's watch window closes is picked up again next
    // poll; one that fails or times out falls through to HTTP right away.
    if (band.torrent !== undefined && this.transport !== undefined) {
      const outcome = await this.viaTorrent(
        publisher,
        origin,
        index,
        band,
        meter,
      );
      if (outcome.kind === 'pending') return false;
      if (outcome.kind === 'done') {
        return this.finishInstall({
          publisher,
          index,
          band,
          kind,
          sourceDir: outcome.dir,
          targetDir,
          live,
          bandBytes,
          transport: 'torrent',
        });
      }
      // Fell back. Over HTTP the meter applies again.
      if (meter.refused) return false;
    }

    // Per publisher, so two publishers' copies of one band id never resume
    // onto each other's partial files.
    const incoming = path.join(
      this.incomingDir,
      publisher,
      index.name,
      band.id,
    );
    await fs.mkdir(incoming, { recursive: true });
    await this.discardStaleFiles(incoming, band);

    // Every file is attempted and the whole band is waited on, so a file that
    // fails costs only itself: what completed stays on disk and is skipped
    // next poll, and nothing is still downloading after this returns. The
    // one exception is the publisher's meter. Once it answers 402 or 429,
    // starting more files would only collect more refusals.
    const limit = pLimit(this.downloadConcurrency);
    const results = await Promise.allSettled(
      band.files.map((file) =>
        limit(async () => {
          if (meter.refused) throw new MeteredError();
          const url = fileUrl(origin, baseUrl, file, this.allowedFileOrigins);
          if (url === undefined) throw new DisallowedOriginError(baseUrl);
          try {
            const result = await downloadFile({
              url,
              headers: this.requestHeaders,
              destPath: path.join(incoming, file.name),
              // Keyed by digest: a file rebuilt under the same name must
              // never resume onto the old version's bytes.
              partialPath: path.join(
                incoming,
                `${file.name}.${file.sha256.slice(0, 16)}.tmp`,
              ),
              expectedSize: file.size,
              expectedSha256: file.sha256,
              resume: true,
              idleTimeoutMs: this.downloadStallTimeoutMs,
              signal: this.stopping.signal,
              // The cap is for the band, and downloadConcurrency files move
              // at once, so each gets its share.
              ...(this.downloadRateLimitBytesPerSec !== undefined
                ? {
                    maxBytesPerSecond: Math.max(
                      1,
                      Math.floor(
                        this.downloadRateLimitBytesPerSec /
                          this.downloadConcurrency,
                      ),
                    ),
                  }
                : {}),
            });
            subscriptionBytes.inc(
              { transport: 'http' },
              result.bytesWritten - result.resumedFrom,
            );
          } catch (error) {
            if (
              error instanceof DownloadHttpError &&
              (error.status === 402 || error.status === 429)
            ) {
              meter.refused = true;
            }
            throw error;
          }
        }),
      ),
    );

    const failures = results.flatMap((r) =>
      r.status === 'rejected' && !(r.reason instanceof MeteredError)
        ? [r.reason as unknown]
        : [],
    );
    if (failures.length > 0) {
      // Bytes that do not match what was signed say something about the
      // source; everything else (timeouts, 402s, 429s, a publisher mid-swap)
      // is the network or the meter, and must not be read as tampering.
      const integrity = failures.find(
        (e) => e instanceof DownloadIntegrityError,
      );
      const error: any = integrity ?? failures[0];
      this.log.warn(
        integrity !== undefined
          ? 'Band bytes did not match their signed digests; will retry'
          : 'Band download failed; will retry',
        {
          publisher,
          index: index.name,
          band: band.id,
          error: error?.message,
          ...(error instanceof DownloadHttpError
            ? { status: error.status }
            : {}),
          failedFiles: failures.length,
          completeFiles: results.filter((r) => r.status === 'fulfilled').length,
          totalFiles: band.files.length,
        },
      );
      this.count(
        publisher,
        index.name,
        integrity !== undefined ? 'verify_failed' : 'download_failed',
      );
      return false;
    }

    return this.finishInstall({
      publisher,
      index,
      band,
      kind,
      sourceDir: incoming,
      targetDir,
      live,
      bandBytes,
      transport: 'http',
    });
  }

  /**
   * Validate and install a band whose files are complete in `sourceDir`,
   * however they got there.
   *
   * Either way the files in `sourceDir` were written by this process and
   * hashed as they were written: the HTTP downloader checks every digest,
   * and a torrent's files are copied out of the engine's directory and
   * hashed on the way (see {@link stageFromSwarm}).
   */
  private async finishInstall({
    publisher,
    index,
    band,
    kind,
    sourceDir,
    targetDir,
    live,
    bandBytes,
    transport,
  }: {
    publisher: string;
    index: IndexEntry;
    band: BandDescriptor;
    kind: ArtifactKind;
    sourceDir: string;
    targetDir: string;
    live: InstalledBand | undefined;
    bandBytes: number;
    transport: 'http' | 'torrent';
  }): Promise<boolean> {
    try {
      await kind.validate(band, sourceDir);
    } catch (error: any) {
      // Bytes that match their digests but are not the shape this kind can
      // serve must not reach the gateway, and must not be resumed onto.
      this.log.warn('Band failed validation; discarding', {
        publisher,
        index: index.name,
        band: band.id,
        error: error?.message,
      });
      await fs.rm(sourceDir, { recursive: true, force: true });
      this.count(publisher, index.name, 'verify_failed', transport);
      return false;
    }

    if (this.stopping.signal.aborted) return false;
    const state = await this.state.load();
    const current = { ...(state.installed[index.name] ?? {}) };
    const next = await kind.install({
      band,
      sourceDir,
      targetDir,
      current,
    });
    // A torrent-fetched band's torrent was kept when it was added, so the
    // copy can be seeded at once.
    const keptInfohash =
      band.torrent !== undefined &&
      existsSync(this.keptTorrentPath(band.torrent.infohashV1))
        ? band.torrent.infohashV1
        : undefined;
    next[band.id] = {
      ...next[band.id],
      publisher,
      ...(keptInfohash !== undefined ? { infohashV1: keptInfohash } : {}),
    };
    this.addPendingRetire(next, band.id, live, targetDir);

    await this.state.update((draft) => {
      applyBandChanges(draft.installed, index.name, current, next);
    });

    this.count(publisher, index.name, 'installed', transport);
    this.log.info('Installed a band', {
      publisher,
      index: index.name,
      band: band.id,
      bytes: bandBytes,
      transport,
    });
    return true;
  }

  /**
   * Find a verified copy of `band` already installed, at its generation's
   * directory or at the pre-generation `installed/<index>/<band>` layout.
   * Returns its directory, or undefined.
   */
  private async adoptInstalledCopy(
    indexName: string,
    band: BandDescriptor,
    targetDir: string,
    claimed: ReadonlySet<string>,
    kind: ArtifactKind,
  ): Promise<string | undefined> {
    // This generation's directory under any suffix, and the layout from
    // before generations, in that order.
    const indexDir = path.join(this.installedDir, indexName);
    const prefix = `${band.id}${GENERATION_SEPARATOR}${bandGeneration(band)}`;
    const onDisk = (await fs.readdir(indexDir).catch(() => [] as string[]))
      .filter((name) => name === prefix || name.startsWith(`${prefix}.`))
      .map((name) => path.join(indexDir, name));
    const candidates = [
      ...new Set([targetDir, ...onDisk, path.join(indexDir, band.id)]),
    ];
    for (const dir of candidates) {
      // Never adopt a directory already on its way out.
      if (claimed.has(path.resolve(dir))) continue;
      let complete = true;
      for (const file of band.files) {
        const size = await completedFile(
          path.join(dir, file.name),
          file.size,
          file.sha256,
        );
        if (size === undefined) {
          complete = false;
          break;
        }
      }
      if (!complete) continue;
      // The same gate a download passes: a copy left by an older build may
      // never have been checked this thoroughly.
      try {
        await kind.validate(band, dir);
      } catch (error: any) {
        this.log.warn('A copy on disk failed validation; not adopting it', {
          index: indexName,
          band: band.id,
          dir,
          error: error?.message,
        });
        continue;
      }
      return dir;
    }
    return undefined;
  }

  // --- The torrent transport -----------------------------------------------

  private keptTorrentPath(infohashV1: string): string {
    return path.join(this.torrentsDir, `${infohashV1}.torrent`);
  }

  /** Whether the engine answers, asked once per poll rather than per band. */
  private async engineUp(meter: PollMeter): Promise<boolean> {
    if (this.transport === undefined) return false;
    meter.engineUp ??= await this.transport.isAvailable();
    return meter.engineUp;
  }

  /**
   * Fetch a band's `.torrent`, check it is the one the signed publication
   * names and that it describes exactly the band's files, and strip what the
   * signature does not cover.
   *
   * The publication signs the infohashes and the infohash covers every
   * piece, so a torrent that matches them can only yield the signed bytes;
   * checking its file list keeps it from carrying anything else. The request
   * itself follows the same rules as a band file: only from the
   * publication's origin or an allowed one, no redirects, a bounded body.
   */
  private async fetchTorrent(
    origin: string,
    band: BandDescriptor,
  ): Promise<Buffer> {
    const signed = band.torrent!;
    let url: URL;
    try {
      url = new URL(signed.torrentUrl, origin);
    } catch {
      throw new DownloadIntegrityError(
        `torrent URL ${signed.torrentUrl} is not a URL`,
      );
    }
    if (
      url.origin !== new URL(origin).origin &&
      !this.allowedFileOrigins.has(url.origin)
    ) {
      throw new DisallowedOriginError(signed.torrentUrl);
    }
    const response = await fetch(url, {
      headers: { ...this.requestHeaders, 'accept-encoding': 'identity' },
      redirect: 'manual',
      signal: AbortSignal.any([
        AbortSignal.timeout(this.fetchTimeoutMs),
        this.stopping.signal,
      ]),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new DownloadHttpError(response.status, response.statusText);
    }
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > MAX_TORRENT_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new DownloadIntegrityError(`torrent is ${declared} bytes`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of response.body ?? []) {
      total += chunk.byteLength;
      if (total > MAX_TORRENT_BYTES) {
        throw new DownloadIntegrityError(
          `torrent exceeds ${MAX_TORRENT_BYTES} bytes`,
        );
      }
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);

    let ids;
    try {
      ids = torrentIds(bytes);
    } catch (error: any) {
      throw new DownloadIntegrityError(`not a torrent: ${error?.message}`);
    }
    if (
      ids.infohashV1 !== signed.infohashV1 ||
      (signed.infohashV2 !== undefined && ids.infohashV2 !== signed.infohashV2)
    ) {
      throw new DownloadIntegrityError(
        `torrent infohash ${ids.infohashV1} is not the signed ${signed.infohashV1}`,
      );
    }
    try {
      checkTorrentFiles(bytes, band.files);
      return sanitizeTorrent(
        bytes,
        {
          infohashV1: signed.infohashV1,
          ...(signed.infohashV2 !== undefined
            ? { infohashV2: signed.infohashV2 }
            : {}),
        },
        this.allowedTrackers,
      );
    } catch (error: any) {
      throw new DownloadIntegrityError(`torrent rejected: ${error?.message}`);
    }
  }

  /**
   * The band's checked torrent: the one kept on disk when it still names
   * the signed infohash, otherwise fetched and kept.
   */
  private async obtainTorrent(
    origin: string,
    band: BandDescriptor,
  ): Promise<Buffer> {
    const signed = band.torrent!;
    const file = this.keptTorrentPath(signed.infohashV1);
    try {
      const kept = await fs.readFile(file);
      if (torrentIds(kept).infohashV1 === signed.infohashV1) {
        // Checked again, not trusted for having been kept: an older build
        // may have kept it under weaker rules.
        checkTorrentFiles(kept, band.files);
        return sanitizeTorrent(
          kept,
          {
            infohashV1: signed.infohashV1,
            ...(signed.infohashV2 !== undefined
              ? { infohashV2: signed.infohashV2 }
              : {}),
          },
          this.allowedTrackers,
        );
      }
    } catch {
      // Not kept, unreadable or no longer acceptable: fetch it again.
    }
    const torrent = await this.fetchTorrent(origin, band);
    await fs.mkdir(this.torrentsDir, { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, torrent);
    await fs.rename(tmp, file);
    return torrent;
  }

  /**
   * Make `dir` a fresh, real directory owned by the engine's user.
   *
   * The engine can write the parent, so whatever is at that name may be its
   * doing: a symlink or a file there is removed rather than followed, and
   * only the directory itself is chowned (`lchown`, no walk), so nothing the
   * engine planted can redirect a root-run chown.
   */
  private async prepareSwarmDir(dir: string): Promise<void> {
    await fs.mkdir(this.swarmDir, { recursive: true });
    const existing = await fs.lstat(dir).catch(() => undefined);
    if (existing !== undefined && !existing.isDirectory()) {
      await fs.rm(dir, { force: true });
    }
    if (existing === undefined || !existing.isDirectory()) {
      await fs.mkdir(dir);
    }
    if (this.engineUid !== undefined) {
      await fs.lchown(dir, this.engineUid, this.engineGid ?? this.engineUid);
    }
  }

  /**
   * Copy a band's signed files from `sourceDir` into the band's incoming
   * directory, hashing each as it is copied, and return that directory.
   *
   * What the engine wrote, or a directory it may still hold open, is never
   * installed itself: a file it keeps a descriptor or a hard link to could
   * be rewritten after it was hashed. The copy is owned by this process and
   * is the bytes that were hashed. Each source is opened without following
   * links and must be a regular file of the signed size, so a symlink or a
   * FIFO in its place is refused rather than read.
   *
   * @throws DownloadIntegrityError when any file is missing or does not
   *   match its signed digest.
   */
  private async stageFromSwarm(
    publisher: string,
    indexName: string,
    band: BandDescriptor,
    sourceDir: string,
  ): Promise<string> {
    const incoming = path.join(this.incomingDir, publisher, indexName, band.id);
    await fs.mkdir(incoming, { recursive: true });
    // Everything the install renames goes into installed/, so nothing but
    // this band's own files may be left here.
    await this.discardStaleFiles(incoming, band);
    for (const file of band.files) {
      let handle;
      try {
        handle = await fs.open(
          path.join(sourceDir, file.name),
          fsConstants.O_RDONLY |
            fsConstants.O_NOFOLLOW |
            fsConstants.O_NONBLOCK,
        );
      } catch (error: any) {
        throw new DownloadIntegrityError(
          `${file.name} is not readable as a file: ${error?.code ?? error?.message}`,
        );
      }
      // Not the HTTP downloader's partial name, which a failed copy would
      // otherwise truncate and lose the resume point of.
      const partial = path.join(incoming, swarmPartialName(file));
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== file.size) {
          throw new DownloadIntegrityError(
            `${file.name} is not a ${file.size}-byte file`,
          );
        }
        const hash = crypto.createHash('sha256');
        const out = await fs.open(partial, 'w');
        try {
          let position = 0;
          const buffer = Buffer.alloc(1 << 20);
          for (;;) {
            if (this.stopping.signal.aborted) {
              throw new Error('stopping');
            }
            const { bytesRead } = await handle.read(
              buffer,
              0,
              buffer.length,
              position,
            );
            if (bytesRead === 0) break;
            const chunk = buffer.subarray(0, bytesRead);
            hash.update(chunk);
            await out.write(chunk);
            position += bytesRead;
            if (position > file.size) break;
          }
          if (position !== file.size || hash.digest('hex') !== file.sha256) {
            throw new DownloadIntegrityError(
              `${file.name} does not match its signed digest`,
            );
          }
        } finally {
          await out.close();
        }
        await fs.rename(partial, path.join(incoming, file.name));
      } catch (error) {
        await fs.rm(partial, { force: true });
        throw error;
      } finally {
        await handle.close();
      }
    }
    return incoming;
  }

  /**
   * Move one band forward through the engine, within this poll's watch
   * window.
   *
   * The window is shared by every band of the poll, so a poll never blocks
   * for long however many torrents are in flight: one still going when the
   * window closes is picked up on the next poll, its progress kept in state
   * so a restart resumes it rather than starting over. A torrent that errors,
   * or makes no progress for the timeout, is abandoned and the band fetched
   * over HTTP at once. Peers come first; the publisher's WebSeed, which is
   * its metered tier, is turned on only once nothing has moved for a while.
   */
  private async viaTorrent(
    publisher: string,
    origin: string,
    index: IndexEntry,
    band: BandDescriptor,
    meter: PollMeter,
  ): Promise<TorrentOutcome> {
    const transport = this.transport!;
    const infohashV1 = band.torrent!.infohashV1;
    const dir = path.join(this.swarmDir, infohashV1);
    meter.watchUntil ??= Date.now() + this.torrentWatchMs;

    // A rebuild of this band under the same id has a new infohash; the old
    // download is dropped rather than left running.
    for (const [other, download] of Object.entries(
      (await this.state.load()).downloads,
    )) {
      if (
        other !== infohashV1 &&
        download.publisher === publisher &&
        download.index === index.name &&
        download.band === band.id
      ) {
        await this.abandonDownload(other, download, 'the band was rebuilt');
      }
    }

    let download: SwarmDownload | undefined = (await this.state.load())
      .downloads[infohashV1];

    if (!(await this.engineUp(meter))) {
      // A download already under way waits for the engine to come back,
      // inside its timeout; a new one goes straight to HTTP.
      if (
        download !== undefined &&
        this.now().getTime() - download.lastProgressAt < this.torrentTimeoutMs
      ) {
        return { kind: 'pending' };
      }
      this.count(publisher, index.name, 'transport_fallback', 'torrent');
      return { kind: 'fallback' };
    }

    if (download === undefined) {
      let torrent: Buffer;
      try {
        torrent = await this.obtainTorrent(origin, band);
      } catch (error: any) {
        const integrity =
          error instanceof DownloadIntegrityError ||
          error instanceof DisallowedOriginError;
        this.log.warn(
          integrity
            ? 'Torrent does not match the signed publication; fetching over HTTP'
            : 'Could not fetch torrent; fetching over HTTP',
          {
            publisher,
            index: index.name,
            band: band.id,
            error: error?.message,
          },
        );
        this.count(
          publisher,
          index.name,
          integrity ? 'verify_failed' : 'download_failed',
          'torrent',
        );
        return { kind: 'fallback' };
      }

      try {
        const id = transport.idFor(torrent);
        const held = await transport.status(id);
        // A held torrent with no reported location is not assumed ours.
        if (
          held !== undefined &&
          (held.savePath === undefined ||
            path.resolve(held.savePath) !== path.resolve(dir))
        ) {
          if (held.savePath === undefined) {
            this.count(publisher, index.name, 'transport_fallback', 'torrent');
            return { kind: 'fallback' };
          }
          // The engine already holds these bytes: this node seeds them,
          // as a publisher or from another installed copy. Adding would only
          // return that torrent, so copy from where it lies instead, and
          // leave the engine alone.
          if (held.state !== 'seeding' || held.progress < 1) {
            this.count(publisher, index.name, 'transport_fallback', 'torrent');
            return { kind: 'fallback' };
          }
          return await this.finishFromSwarm(
            publisher,
            index,
            band,
            held.savePath,
            undefined,
          );
        }
        if (held === undefined) {
          await this.prepareSwarmDir(dir);
          await transport.add({ torrent, downloadDir: dir });
        }
        // Otherwise the engine already downloads into our own directory,
        // after state was lost: pick it up.
        const now = this.now().getTime();
        download = {
          id,
          publisher,
          index: index.name,
          band: band.id,
          startedAt: now,
          lastProgress: 0,
          lastProgressAt: now,
          webSeeded: false,
          lastSeenAt: now,
        };
        const record = download;
        await this.state.update((draft) => {
          draft.downloads[infohashV1] = record;
        });
        this.log.info('Fetching band through the torrent engine', {
          publisher,
          index: index.name,
          band: band.id,
          infohashV1,
        });
      } catch (error: any) {
        if (error instanceof DownloadIntegrityError) {
          this.count(publisher, index.name, 'verify_failed', 'torrent');
          return { kind: 'fallback' };
        }
        this.log.warn('Could not add torrent; fetching over HTTP', {
          publisher,
          index: index.name,
          band: band.id,
          error: error?.message,
        });
        this.count(publisher, index.name, 'transport_fallback', 'torrent');
        return { kind: 'fallback' };
      }
    }

    const pending: SwarmDownload = {
      ...download,
      lastSeenAt: this.now().getTime(),
    };
    const save = () =>
      this.state.update((draft) => {
        // Only while it is still ours to save: a concurrent abandon wins.
        if (draft.downloads[infohashV1] !== undefined) {
          draft.downloads[infohashV1] = { ...pending };
        }
      });

    for (;;) {
      if (this.stopping.signal.aborted) {
        await save();
        return { kind: 'pending' };
      }
      const now = this.now().getTime();
      let status;
      try {
        status = await transport.status(pending.id);
      } catch {
        // The engine may be restarting. Its torrent survives that, so keep
        // waiting until the timeout rather than starting the band over.
        if (now - pending.lastProgressAt >= this.torrentTimeoutMs) {
          return this.abandonDownload(
            infohashV1,
            pending,
            'no progress while the engine was unreachable',
          );
        }
        await save();
        return { kind: 'pending' };
      }
      if (status === undefined) {
        return this.abandonDownload(
          infohashV1,
          pending,
          'the engine no longer has the torrent',
        );
      }
      if (status.state === 'seeding' && status.progress >= 1) {
        if (
          status.savePath === undefined ||
          path.resolve(status.savePath) !== path.resolve(dir)
        ) {
          // Not our download after all; leave it be.
          await this.state.update((draft) => {
            delete draft.downloads[infohashV1];
          });
          this.count(publisher, index.name, 'transport_fallback', 'torrent');
          return { kind: 'fallback' };
        }
        subscriptionBytes.inc({ transport: 'torrent' }, status.bytesDown);
        return this.finishFromSwarm(publisher, index, band, dir, pending);
      }
      if (status.state === 'error') {
        return this.abandonDownload(
          infohashV1,
          pending,
          `engine reported an error: ${status.error ?? 'unknown'}`,
        );
      }
      if (status.progress > pending.lastProgress) {
        pending.lastProgress = status.progress;
        pending.lastProgressAt = now;
      }
      if (now - pending.lastProgressAt >= this.torrentTimeoutMs) {
        return this.abandonDownload(infohashV1, pending, 'no progress');
      }
      // The WebSeed was turned on and nothing has moved since either: it is
      // unreachable from the engine (a private origin under its IP filter,
      // say). HTTP from the sidecar is the next best thing; waiting out the
      // whole timeout helps nobody.
      if (
        pending.webSeeded &&
        now - pending.lastProgressAt >= 2 * this.webSeedAfterMs
      ) {
        return this.abandonDownload(
          infohashV1,
          pending,
          'neither peers nor the WebSeed are delivering',
        );
      }
      if (
        !pending.webSeeded &&
        now - pending.lastProgressAt >= this.webSeedAfterMs
      ) {
        try {
          await transport.setWebSeeds(pending.id, [
            new URL('/ar-io/indexes/webseed/', origin).toString(),
          ]);
          pending.webSeeded = true;
          this.log.info('Peers are not delivering; turning on the WebSeed', {
            publisher,
            index: index.name,
            band: band.id,
          });
        } catch (error: any) {
          this.log.warn('Could not turn on the WebSeed', {
            publisher,
            index: index.name,
            band: band.id,
            error: error?.message,
          });
        }
      }
      if (Date.now() >= meter.watchUntil) {
        await save();
        return { kind: 'pending' };
      }
      await new Promise((resolve) => setTimeout(resolve, this.torrentCheckMs));
    }
  }

  /**
   * Stage a completed torrent's files for install. For our own download,
   * the engine lets go of it first and its directory is deleted after; a
   * copy the engine is seeding for someone else is only read.
   */
  private async finishFromSwarm(
    publisher: string,
    index: IndexEntry,
    band: BandDescriptor,
    sourceDir: string,
    download: SwarmDownload | undefined,
  ): Promise<TorrentOutcome> {
    const infohashV1 = band.torrent!.infohashV1;
    this.finishing.add(infohashV1);
    try {
      // The engine keeps the torrent until the copy succeeds, so a copy cut
      // short (a restart, a full disk) is tried again next poll from a
      // download that is still complete. Its seeding cannot corrupt the
      // copy: the digest is of the bytes as written to it.
      let staged: string;
      try {
        staged = await this.stageFromSwarm(
          publisher,
          index.name,
          band,
          sourceDir,
        );
      } catch (error: any) {
        if (!(error instanceof DownloadIntegrityError)) {
          if (!this.stopping.signal.aborted) {
            this.log.warn(
              'Could not stage a torrent-fetched band; will retry',
              {
                publisher,
                index: index.name,
                band: band.id,
                error: error?.message,
              },
            );
          }
          return { kind: 'pending' };
        }
        this.log.warn(
          'A torrent-fetched band did not match its signed digests; fetching over HTTP',
          {
            publisher,
            index: index.name,
            band: band.id,
            error: error.message,
          },
        );
        this.count(publisher, index.name, 'verify_failed', 'torrent');
        if (download !== undefined) {
          await this.abandonDownload(infohashV1, download, 'bad bytes', false);
        }
        return { kind: 'fallback' };
      }
      if (download !== undefined) {
        await this.transport!.remove(download.id).catch(() => undefined);
        await fs.rm(sourceDir, { recursive: true, force: true });
        await this.state.update((draft) => {
          delete draft.downloads[infohashV1];
        });
      }
      return { kind: 'done', dir: staged };
    } finally {
      this.finishing.delete(infohashV1);
    }
  }

  /**
   * Drop a torrent download and its partial files. The engine is told to
   * forget it but never to delete data: the directory removed is always
   * the one this subscriber made for it.
   */
  private async abandonDownload(
    infohashV1: string,
    download: SwarmDownload,
    reason: string,
    count = true,
  ): Promise<TorrentOutcome> {
    await this.transport?.remove(download.id).catch(() => undefined);
    await fs.rm(path.join(this.swarmDir, infohashV1), {
      recursive: true,
      force: true,
    });
    await this.state.update((draft) => {
      delete draft.downloads[infohashV1];
    });
    this.log.warn('Abandoning torrent; fetching over HTTP', {
      publisher: download.publisher,
      index: download.index,
      band: download.band,
      reason,
    });
    if (count) {
      this.count(
        download.publisher,
        download.index,
        'transport_fallback',
        'torrent',
      );
    }
    return { kind: 'fallback' };
  }

  /**
   * Keep the torrent of an installed band that offers one, and record its
   * infohash on the copy, so housekeeping seeds it. A band fetched over HTTP
   * or adopted from disk has no kept torrent until this runs; a failure is
   * retried on the next poll. Only for this publisher's own copy, so two
   * publishers of one band id never take turns rewriting it.
   */
  private async keepTorrentFor(
    publisher: string,
    origin: string,
    indexName: string,
    band: BandDescriptor,
    installed: InstalledBand,
  ): Promise<void> {
    const signed = band.torrent;
    if (this.transport === undefined || signed === undefined) return;
    if (
      installed.publisher !== undefined &&
      installed.publisher !== publisher
    ) {
      return;
    }
    if (
      installed.infohashV1 === signed.infohashV1 &&
      existsSync(this.keptTorrentPath(signed.infohashV1))
    ) {
      return;
    }
    try {
      await this.obtainTorrent(origin, band);
    } catch (error: any) {
      // Retried every poll; not worth a warning each time.
      this.log.debug('Could not fetch the torrent of an installed band', {
        index: indexName,
        band: band.id,
        error: error?.message,
      });
      return;
    }
    await this.state.update((draft) => {
      const record = draft.installed[indexName]?.[band.id];
      // Only the copy that was checked: a newer install may have landed.
      if (record !== undefined && record.dir === installed.dir) {
        record.infohashV1 = signed.infohashV1;
      }
    });
  }

  /**
   * Make the engine seed every installed copy that has a kept torrent, and
   * nothing else of the subscriber's.
   *
   * Driven by state alone: a live copy (not retired) with an infohash and a
   * kept torrent is wanted, one directory per infohash. Runs before the
   * sweep, so the engine lets go of a retired copy before its files are
   * deleted, and re-adds anything a restarted or wiped engine lost or put
   * in error.
   */
  private async reconcileSeeding(): Promise<void> {
    const transport = this.transport;
    if (transport === undefined) return;
    const available = await transport.isAvailable();
    engineAvailable.set(available ? 1 : 0);
    if (!available) return;

    const state = await this.state.load();
    const wanted = new Map<
      string,
      { index: string; band: string; dir: string }
    >();
    for (const [indexName, bands] of Object.entries(state.installed)) {
      for (const [key, record] of Object.entries(bands)) {
        if (record.retiredAt !== undefined) continue;
        if (record.infohashV1 === undefined) continue;
        if (!existsSync(this.keptTorrentPath(record.infohashV1))) continue;
        if (!wanted.has(record.infohashV1)) {
          wanted.set(record.infohashV1, {
            index: indexName,
            band: key,
            dir: record.dir,
          });
        }
      }
    }

    const mine = Object.entries(state.seeding).filter(
      ([, seeded]) => seeded.owner === 'subscriber',
    );
    for (const [key, seeded] of mine) {
      const want =
        seeded.infohashV1 !== undefined
          ? wanted.get(seeded.infohashV1)
          : undefined;
      if (
        want !== undefined &&
        path.resolve(want.dir) === path.resolve(seeded.dir)
      ) {
        continue;
      }
      // Retired, or now seeded from another copy of the same bytes. The
      // engine's one copy of the torrent is taken back only if it runs from
      // this directory; the publisher, if it offers the same bytes, re-adds
      // it from its own on its next scan.
      try {
        const status = await transport.status(seeded.id);
        if (
          status !== undefined &&
          (status.savePath === undefined ||
            path.resolve(status.savePath) === path.resolve(seeded.dir))
        ) {
          await transport.remove(seeded.id);
        }
        await this.state.update((draft) => {
          delete draft.seeding[key];
        });
      } catch (error: any) {
        this.log.warn('Could not stop seeding a band', {
          index: seeded.index,
          band: seeded.band,
          error: error?.message,
        });
      }
    }

    const current = (await this.state.load()).seeding;
    for (const [infohashV1, want] of wanted) {
      const existing = Object.values(current).find(
        (seeded) =>
          seeded.owner === 'subscriber' && seeded.infohashV1 === infohashV1,
      );
      try {
        const status =
          existing !== undefined
            ? await transport.status(existing.id)
            : undefined;
        if (status !== undefined && status.state !== 'error') continue;
        if (status?.state === 'error') await transport.remove(existing!.id);
        const torrent = await fs.readFile(this.keptTorrentPath(infohashV1));
        const { id } = await transport.seed({ torrent, dir: want.dir });
        const entry: SeededBand = {
          id,
          infohashV1,
          index: want.index,
          band: want.band,
          dir: want.dir,
          owner: 'subscriber',
        };
        await this.state.update((draft) => {
          draft.seeding[seedingKey('subscriber', id)] = entry;
        });
        this.log.info(
          existing === undefined
            ? 'Seeding an installed band'
            : 'Re-seeding an installed band the engine had lost',
          { index: want.index, band: want.band, infohashV1 },
        );
      } catch (error: any) {
        this.log.warn('Could not seed an installed band', {
          index: want.index,
          band: want.band,
          error: error?.message,
        });
      }
    }
  }

  /**
   * Housekeeping for the swarm's own directories: abandon downloads no poll
   * has wanted for a whole torrent timeout (the publisher dropped the band,
   * or it was installed another way), delete download directories and kept
   * torrents nothing uses.
   *
   * A download is abandoned only once its publisher has been reconciled
   * since startup, so one a first poll would pick up again is never
   * mistaken for unwanted, and a publisher that is down holds up only its
   * own downloads. Anything on disk without a record must also have sat a
   * while, since a record is written just after its directory.
   */
  private async cleanSwarm(): Promise<void> {
    const now = this.now().getTime();
    const state = await this.state.load();
    for (const [infohashV1, download] of Object.entries(state.downloads)) {
      if (this.finishing.has(infohashV1)) continue;
      // One no longer subscribed to is never reconciled; its downloads go.
      if (
        this.subscribedPublishers.has(download.publisher) &&
        !this.reconciledSinceStart.has(download.publisher)
      ) {
        continue;
      }
      if (!this.subscribedPublishers.has(download.publisher)) {
        await this.abandonDownload(infohashV1, download, 'unsubscribed');
        continue;
      }
      if (now - download.lastSeenAt >= this.torrentTimeoutMs) {
        await this.abandonDownload(infohashV1, download, 'no longer wanted');
      }
    }

    const after = await this.state.load();
    // File times are wall-clock time, whatever clock the subscriber runs on.
    const oldEnough = async (target: string): Promise<boolean> => {
      const stat = await fs.lstat(target).catch(() => undefined);
      return (
        stat !== undefined &&
        Date.now() - stat.ctimeMs >= this.untrackedMinAgeMs
      );
    };
    const names = await fs.readdir(this.swarmDir).catch(() => [] as string[]);
    for (const name of names) {
      if (Object.prototype.hasOwnProperty.call(after.downloads, name)) continue;
      if (this.finishing.has(name)) continue;
      const target = path.join(this.swarmDir, name);
      if (!(await oldEnough(target))) continue;
      await fs.rm(target, { recursive: true, force: true });
    }

    const used = new Set<string>(Object.keys(after.downloads));
    for (const bands of Object.values(after.installed)) {
      for (const record of Object.values(bands)) {
        if (record.infohashV1 !== undefined) used.add(record.infohashV1);
      }
    }
    const kept = await fs.readdir(this.torrentsDir).catch(() => [] as string[]);
    for (const name of kept) {
      if (!name.endsWith('.torrent')) continue;
      if (used.has(name.slice(0, -'.torrent'.length))) continue;
      const target = path.join(this.torrentsDir, name);
      if (!(await oldEnough(target))) continue;
      await fs.rm(target, { force: true });
    }
  }

  /** Record an install of `band` at `dir`, retiring the copy it replaces. */
  private async recordInstall(
    publisher: string,
    indexName: string,
    band: BandDescriptor,
    dir: string,
    replaced: InstalledBand | undefined,
  ): Promise<void> {
    await this.state.update((draft) => {
      const map = (draft.installed[indexName] ??= {});
      map[band.id] = {
        dir,
        files: band.files,
        installedAt: this.now().toISOString(),
        publisher,
      };
      this.addPendingRetire(map, band.id, replaced, dir);
    });
  }

  /**
   * Record the copy a new install replaced as due for retirement, in the
   * same map (and so the same state write) as the install itself.
   */
  private addPendingRetire(
    map: Record<string, InstalledBand>,
    bandId: string,
    replaced: InstalledBand | undefined,
    newDir: string,
  ): void {
    if (
      replaced === undefined ||
      path.resolve(replaced.dir) === path.resolve(newDir)
    ) {
      return;
    }
    const now = this.now().getTime();
    map[`${bandId}${GENERATION_SEPARATOR}replaced-${now}`] = {
      ...replaced,
      retireAfter: new Date(now + this.replaceOverlapMs).toISOString(),
    };
  }

  /** Directories that a retired or retiring record points at. */
  private claimedDirs(
    map: Record<string, InstalledBand> | undefined,
  ): Set<string> {
    const claimed = new Set<string>();
    for (const band of Object.values(map ?? {})) {
      if (band.retiredAt !== undefined || band.retireAfter !== undefined) {
        claimed.add(path.resolve(band.dir));
      }
    }
    return claimed;
  }

  /**
   * Retire bands installed from a publisher no longer subscribed to.
   * Removing a subscription says that publisher is no longer trusted for
   * what the gateway serves; its bands should not outlive that.
   */
  private async retireUnsubscribed(): Promise<void> {
    const kind = this.kinds.values().next().value;
    if (kind === undefined) return;
    const state = await this.state.load();
    for (const [indexName, live] of Object.entries(state.installed)) {
      for (const [key, band] of Object.entries({ ...live })) {
        if (band.retiredAt !== undefined || band.retireAfter !== undefined) {
          continue;
        }
        if (
          band.publisher === undefined ||
          this.subscribedPublishers.has(band.publisher)
        ) {
          continue;
        }
        const current = {
          ...((await this.state.load()).installed[indexName] ?? {}),
        };
        const next = await kind.retire({ bandId: key, dir: band.dir, current });
        await this.state.update((draft) => {
          applyBandChanges(draft.installed, indexName, current, next);
        });
        this.log.info(
          'Retired a band from a publisher no longer subscribed to',
          {
            index: indexName,
            band: key,
            publisher: band.publisher,
          },
        );
      }
    }
  }

  /** Retire replaced copies whose overlap has passed. */
  private async retireDue(): Promise<void> {
    const kind = this.kinds.values().next().value;
    if (kind === undefined) return;
    const now = this.now().getTime();
    const state = await this.state.load();
    for (const [indexName, live] of Object.entries(state.installed)) {
      for (const [key, band] of Object.entries({ ...live })) {
        if (band.retireAfter === undefined || band.retiredAt !== undefined) {
          continue;
        }
        const due = Date.parse(band.retireAfter);
        if (!Number.isNaN(due) && due > now) continue;
        const current = {
          ...((await this.state.load()).installed[indexName] ?? {}),
        };
        const next = await kind.retire({ bandId: key, dir: band.dir, current });
        const { retireAfter: _done, ...retired } = next[key];
        next[key] = { ...retired, files: band.files };
        await this.state.update((draft) => {
          applyBandChanges(draft.installed, indexName, current, next);
        });
      }
    }
  }

  /**
   * Retire band directories under `installed/` that no record points at:
   * left by a crash, or by lost state. The gateway would otherwise serve
   * them forever, outside the budget and never swept. Only directories
   * untouched for a while, so an install renaming one in right now is
   * never mistaken for an orphan.
   */
  private async retireUntracked(): Promise<void> {
    const kind = this.kinds.values().next().value;
    if (kind === undefined) return;
    for (const publisher of this.subscribedPublishers) {
      if (!this.reconciledSinceStart.has(publisher)) return;
    }
    let indexes: string[];
    try {
      indexes = await fs.readdir(this.installedDir);
    } catch {
      return;
    }
    const now = this.now().getTime();
    for (const indexName of indexes) {
      const indexDir = path.join(this.installedDir, indexName);
      let names: string[];
      try {
        names = await fs.readdir(indexDir);
      } catch {
        continue;
      }
      const tracked = new Set(
        Object.values((await this.state.load()).installed[indexName] ?? {}).map(
          (band) => path.resolve(band.dir),
        ),
      );
      for (const name of names) {
        const dir = path.join(indexDir, name);
        if (tracked.has(path.resolve(dir))) continue;
        // Being installed or adopted right now: its record isn't written yet.
        const bandId = name.split(GENERATION_SEPARATOR)[0];
        if (this.installing.has(`${indexName}/${bandId}`)) continue;
        let stat;
        try {
          stat = await fs.stat(dir);
        } catch {
          continue;
        }
        if (!stat.isDirectory()) continue;
        // ctime, not mtime: a rename keeps a directory's mtime, so a band
        // renamed in a moment ago can carry an old one. Real time, not
        // this.now(): file times are real.
        if (Date.now() - stat.ctimeMs < this.untrackedMinAgeMs) continue;
        // Re-check against state as it is now, not as it was at the listing.
        const now_tracked = Object.values(
          (await this.state.load()).installed[indexName] ?? {},
        ).some((band) => path.resolve(band.dir) === path.resolve(dir));
        if (now_tracked) continue;
        const key = `${name}${GENERATION_SEPARATOR}untracked-${now}`;
        const current = {
          ...((await this.state.load()).installed[indexName] ?? {}),
        };
        const next = await kind.retire({ bandId: key, dir, current });
        await this.state.update((draft) => {
          applyBandChanges(draft.installed, indexName, current, next);
        });
        this.log.warn('Retired a band directory no record pointed at', {
          index: indexName,
          dir,
        });
      }
    }
  }

  /**
   * Remove anything in a band's download directory that isn't one of its
   * current files or their current partials: older generations' partial
   * and finished files would otherwise pile up (counted against the budget)
   * and be renamed into the installed band with it.
   */
  private async discardStaleFiles(
    dir: string,
    band: BandDescriptor,
  ): Promise<void> {
    const keep = new Set<string>();
    for (const file of band.files) {
      keep.add(file.name);
      keep.add(`${file.name}.${file.sha256.slice(0, 16)}.tmp`);
      keep.add(swarmPartialName(file));
    }
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (keep.has(name)) continue;
      await fs.rm(path.join(dir, name), { recursive: true, force: true });
    }
  }

  /**
   * Delete downloads in `incoming/` that can no longer complete: bands this
   * publisher no longer offers in this index. Without it, a band that failed
   * part-way and was then dropped would hold its files forever.
   */
  private async discardUnofferedDownloads(
    publisher: string,
    indexName: string,
    offered: ReadonlySet<string>,
  ): Promise<void> {
    const dir = path.join(this.incomingDir, publisher, indexName);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (offered.has(name)) continue;
      await fs.rm(path.join(dir, name), { recursive: true, force: true });
      this.log.info('Discarded a download the publisher no longer offers', {
        publisher,
        index: indexName,
        band: name,
      });
    }
  }

  /**
   * Delete `incoming/` entries that belong to no configured publisher: a
   * publisher unsubscribed from, or the per-index layout used before
   * downloads were kept per publisher.
   */
  private async discardOrphanedDownloads(): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.incomingDir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (this.subscribedPublishers.has(name)) continue;
      await fs.rm(path.join(this.incomingDir, name), {
        recursive: true,
        force: true,
      });
      this.log.info('Discarded downloads for no configured publisher', {
        entry: name,
      });
    }
  }

  /** Delete the files of bands retired longer ago than the grace period. */
  private async sweep(): Promise<void> {
    const state = await this.state.load();
    for (const [indexName, live] of Object.entries(state.installed)) {
      // Any kind can sweep, but the entries were installed by one; use the
      // first that recognises the index rather than guessing.
      const kind = this.kinds.values().next().value;
      if (kind === undefined) continue;
      // Snapshot before awaiting: the sweep's deletes take time, and polls
      // install into this map meanwhile.
      const current = { ...live };

      const next = await kind.sweepRetired({
        current,
        dirFor: (bandId) => path.join(this.installedDir, indexName, bandId),
        graceMs: this.supersedeGraceMs,
      });
      if (Object.keys(next).length !== Object.keys(current).length) {
        await this.state.update((draft) => {
          applyBandChanges(draft.installed, indexName, current, next);
        });
      }
    }
  }

  private async reportInstalled(): Promise<void> {
    const state = await this.state.load();
    for (const [indexName, bands] of Object.entries(state.installed)) {
      const live = Object.values(bands).filter(
        (band) =>
          band.retiredAt === undefined && band.retireAfter === undefined,
      ).length;
      installedBands.set({ index: indexName }, live);
    }
  }
}
