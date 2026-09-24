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
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import pLimit from 'p-limit';
import { Logger } from 'winston';

import {
  BandDescriptor,
  BandFile,
  IndexEntry,
  IndexPublication,
  INDEX_PUBLICATION_MAX_BYTES,
  parseIndexPublicationDocument,
  verifyIndexPublication,
} from '../lib/index-publication.js';
import { publicKeyFromSolanaAddress } from '../lib/httpsig.js';
import {
  DownloadHttpError,
  DownloadIntegrityError,
  downloadFile,
} from '../lib/http-file-download.js';
import { SubscribeConfig } from './config.js';
import { StateStore } from './state.js';
import { ArtifactKind } from './kinds/types.js';
import { GatewayRegistry, PublisherRecord } from './gateway-registry.js';
import {
  installedBands,
  subscriptionBytes,
  subscriptionManifestAge,
  subscriptionSequence,
  subscriptionTotal,
} from './metrics.js';

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
): string {
  if (/^https?:\/\//i.test(baseUrl)) {
    return new URL(`${baseUrl}${file.name}`).toString();
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
  | 'signature_failed'
  | 'verify_failed'
  | 'download_failed'
  | 'skipped_disk_budget'
  | 'unknown_kind'
  | 'unreachable'
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
  now?: () => Date;
}

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
    this.now = options.now ?? (() => new Date());
  }

  private inFlight: Promise<void> | undefined;

  /**
   * Poll every configured publisher once. A call while a poll is still
   * running joins it rather than starting a second: downloading a large band
   * outlasts the poll interval, and two polls over the same band write the
   * same `.tmp` files at once, corrupting them, and race to install into
   * the same directory.
   */
  pollOnce(): Promise<void> {
    if (this.inFlight === undefined) {
      this.inFlight = this.poll().finally(() => {
        this.inFlight = undefined;
      });
    }
    return this.inFlight;
  }

  private async poll(): Promise<void> {
    for (const subscription of this.subscribe) {
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
    }
    await this.sweep();
    await this.reportInstalled();
  }

  private count(
    publisher: string,
    index: string,
    result: SubscriptionResult,
    transport = 'http',
  ): void {
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
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
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
    const seen = state.subscriptions[publisher]?.sequence ?? 0;

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
      if (await this.reconcileIndex(publisher, record.url, index, kind)) {
        installedAnything = true;
      }
    }

    await this.state.update((draft) => {
      draft.subscriptions[publisher] = {
        sequence: Math.max(document.sequence, seen),
        manifestSha256: document.signature?.sig ?? '',
        updatedAt: this.now().toISOString(),
      };
    });

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
      subscriptionManifestAge.set(
        { publisher },
        Math.max(0, (this.now().getTime() - issued) / 1000),
      );
    }
  }

  /** Bytes held by every installed band, for the disk budget. */
  private async installedBytes(): Promise<number> {
    const state = await this.state.load();
    let total = 0;
    for (const bands of Object.values(state.installed)) {
      for (const band of Object.values(bands)) {
        for (const file of band.files) total += file.size;
      }
    }
    return total;
  }

  /** Install what is new in this index, and retire what the publisher dropped. */
  private async reconcileIndex(
    publisher: string,
    origin: string,
    index: IndexEntry,
    kind: ArtifactKind,
  ): Promise<boolean> {
    let installedAnything = false;

    for (const band of index.bands) {
      const state = await this.state.load();
      const existing = state.installed[index.name]?.[band.id];
      // Matching on the id alone would pin a subscriber to the first copy of
      // a band the publisher rebuilds under the same id, which the rolling
      // tip band always is. A band is its files, so compare those.
      if (
        existing !== undefined &&
        existing.retiredAt === undefined &&
        sameFiles(existing.files, band.files)
      ) {
        continue;
      }

      const installed = await this.installBand(
        publisher,
        origin,
        index,
        band,
        kind,
      );
      if (installed) installedAnything = true;
    }

    // Anything this publisher installed here but no longer offers is retired.
    // Scoped by publisher, so one publisher dropping a band does not remove
    // the copy another publisher still offers.
    const offered = new Set(index.bands.map((band) => band.id));
    const state = await this.state.load();
    const current = state.installed[index.name] ?? {};
    for (const [bandId, band] of Object.entries(current)) {
      if (offered.has(bandId)) continue;
      if (band.publisher !== publisher) continue;
      if (band.retiredAt !== undefined) continue;

      // Retire against the map as it is now, not as it was before the loop:
      // retire returns a copy of what it is given, so passing the stale map
      // would undo the band retired on the previous iteration.
      const latest = (await this.state.load()).installed[index.name] ?? {};
      const next = await kind.retire({
        bandId,
        dir: band.dir,
        current: latest,
      });
      await this.state.update((draft) => {
        draft.installed[index.name] = next;
      });
      this.log.info('Retired a band the publisher no longer offers', {
        publisher,
        index: index.name,
        band: bandId,
      });
    }

    return installedAnything;
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
  ): Promise<boolean> {
    const bandBytes = band.files.reduce((sum, file) => sum + file.size, 0);
    if (this.maxDiskBytes !== undefined) {
      const used = await this.installedBytes();
      if (used + bandBytes > this.maxDiskBytes) {
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

    const incoming = path.join(this.incomingDir, index.name, band.id);
    await fs.mkdir(incoming, { recursive: true });

    const limit = pLimit(this.downloadConcurrency);
    try {
      await Promise.all(
        band.files.map((file) =>
          limit(async () => {
            const url = fileUrl(origin, baseUrl, file);
            const result = await downloadFile({
              url,
              destPath: path.join(incoming, file.name),
              expectedSize: file.size,
              expectedSha256: file.sha256,
              resume: true,
              idleTimeoutMs: this.downloadStallTimeoutMs,
              ...(this.downloadRateLimitBytesPerSec !== undefined
                ? { maxBytesPerSecond: this.downloadRateLimitBytesPerSec }
                : {}),
            });
            subscriptionBytes.inc(
              { transport: 'http' },
              result.bytesWritten - result.resumedFrom,
            );
          }),
        ),
      );
    } catch (error: any) {
      // Partial files are deliberately left in place: the next poll resumes
      // from them rather than starting the band over.
      // Bytes that do not match what was signed say something about the
      // source; everything else (timeouts, 402s, 429s, a publisher mid-swap)
      // is the network or the meter, and must not be read as tampering.
      const integrity = error instanceof DownloadIntegrityError;
      this.log.warn(
        integrity
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
        },
      );
      this.count(
        publisher,
        index.name,
        integrity ? 'verify_failed' : 'download_failed',
      );
      return false;
    }

    try {
      await kind.validate(band, incoming);
    } catch (error: any) {
      // Bytes that match their digests but are not the shape this kind can
      // serve must not reach the gateway, and must not be resumed onto.
      this.log.warn('Band failed validation; discarding', {
        publisher,
        index: index.name,
        band: band.id,
        error: error?.message,
      });
      await fs.rm(incoming, { recursive: true, force: true });
      this.count(publisher, index.name, 'verify_failed');
      return false;
    }

    const targetDir = path.join(this.installedDir, index.name, band.id);
    const state = await this.state.load();
    const current = state.installed[index.name] ?? {};
    const next = await kind.install({
      band,
      sourceDir: incoming,
      targetDir,
      current,
    });
    next[band.id] = { ...next[band.id], publisher };

    await this.state.update((draft) => {
      draft.installed[index.name] = next;
    });

    this.count(publisher, index.name, 'installed');
    this.log.info('Installed a band', {
      publisher,
      index: index.name,
      band: band.id,
      bytes: bandBytes,
    });
    return true;
  }

  /** Delete the files of bands retired longer ago than the grace period. */
  private async sweep(): Promise<void> {
    const state = await this.state.load();
    for (const [indexName, current] of Object.entries(state.installed)) {
      // Any kind can sweep, but the entries were installed by one; use the
      // first that recognises the index rather than guessing.
      const kind = this.kinds.values().next().value;
      if (kind === undefined) continue;

      const next = await kind.sweepRetired({
        current,
        dirFor: (bandId) => path.join(this.installedDir, indexName, bandId),
        graceMs: this.supersedeGraceMs,
      });
      if (Object.keys(next).length !== Object.keys(current).length) {
        await this.state.update((draft) => {
          draft.installed[indexName] = next;
        });
      }
    }
  }

  private async reportInstalled(): Promise<void> {
    const state = await this.state.load();
    for (const [indexName, bands] of Object.entries(state.installed)) {
      const live = Object.values(bands).filter(
        (band) => band.retiredAt === undefined,
      ).length;
      installedBands.set({ index: indexName }, live);
    }
  }
}
