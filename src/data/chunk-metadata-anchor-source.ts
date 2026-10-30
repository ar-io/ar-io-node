/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { default as axios, AxiosInstance } from 'axios';
import { LRUCache } from 'lru-cache';
import winston from 'winston';

import { RequestAttributes, TxBoundary, TxBoundarySource } from '../types.js';
import * as metrics from '../metrics.js';
import { parseChunkHeaderMetadata } from '../lib/chunk-header-parser.js';
import {
  AnchoredChunkMetadata,
  ChainAnchorMismatchError,
  anchorChunkMetadata,
} from '../lib/chunk-metadata-anchor.js';
import { createAgentPair } from '../lib/http-agent.js';
import { discardResponseBody, normalizeAbortError } from '../lib/http-utils.js';
import { generateRequestAttributes } from '../lib/request-attributes.js';

// Largest absolute weave offset this source will probe via the
// number-typed cache + chain cross-check path. The chain-anchored
// metadata is consumed as `number` downstream (TxBoundary.weaveOffset
// and the cache's txStart/txEndOffset bounds), so any offset past
// Number.MAX_SAFE_INTEGER cannot round-trip without precision loss.
// At weave-scale (~10^14 bytes today, MAX_SAFE_INTEGER is ~9×10^15)
// the cap is well above current weave size; this is defense in depth
// for the day the weave grows past 9 PB. Past the cap we fall through
// to the canonical chain binary search rather than risk returning a
// silently wrong tx boundary.
const MAX_SAFE_OFFSET_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

// How long a reference peer is skipped after it fails (unreachable, refusing
// with a capacity or server status, or contradicting the chain): this base,
// doubling with each consecutive failure up to the maximum.
const DEFAULT_PEER_BACKOFF_BASE_MS = 30_000;
const DEFAULT_PEER_BACKOFF_MAX_MS = 600_000;

// Returned by `probe` when every peer was backed off: nothing was asked, so
// the offset must not be remembered as a miss.
const NOT_PROBED = Symbol('not probed');

/**
 * Outcome label for {@link metrics.chunkMetadataAnchorTotal}. Mirrors
 * the observer's `observer_chunk_metadata_anchor_total` so dashboards
 * stay consistent across the two services.
 *
 * - `hit`              — peer headers parsed AND cross-checked against chain
 * - `cache_hit`        — same tx already anchored this run; offset in range
 * - `metadata_missing` — peer didn't return required headers
 * - `mismatch`         — chain disagreed with peer headers (caught + falls through)
 * - `error`            — HTTP/network/abort failure (falls through)
 * - `peer_origin`      — the request came from another gateway (hops >= 1):
 *                        not probed, so a peer's miss is never forwarded on
 * - `miss_cached`      — this offset missed within the miss cache's TTL:
 *                        not probed again
 * - `probe_shared`     — joined a probe of the same offset already in flight
 * - `peer_backoff`     — every reference peer was backed off: not probed
 */
type AnchorResult =
  | 'hit'
  | 'cache_hit'
  | 'metadata_missing'
  | 'mismatch'
  | 'peer_refused'
  | 'error'
  | 'peer_origin'
  | 'miss_cached'
  | 'probe_shared'
  | 'peer_backoff';

/**
 * Thrown when the reference peer answered HEAD with a status that a ranged GET
 * could not improve on: a refusal (404, 429, 402), an auth failure, or a server
 * fault. Distinguished from a transport error so the outcome is counted as
 * `peer_refused` rather than `error`, which is what tells an operator the peer
 * is answering and declining as opposed to being unreachable.
 */
class PeerRefusedHeadError extends Error {
  constructor(readonly status: number) {
    super(
      `Peer refused HEAD with status ${status}; a ranged GET would return the same result`,
    );
    this.name = 'PeerRefusedHeadError';
  }
}

/** A probe of one offset that concurrent lookups share. */
/** A reference peer's recent failures, for backoff. */
interface PeerHealth {
  failures: number;
  /** Skipped until this time (ms since the epoch). */
  until: number;
}

interface SharedProbe {
  /** Settles with the probe's result; rejects with AbortError if aborted. */
  promise: Promise<TxBoundary | null>;
  /** Aborts the probe's network requests once nobody is waiting. */
  controller: AbortController;
  /** Callers still waiting on {@link promise}. */
  waiters: number;
}

/**
 * The reference peers for chunk-metadata anchoring, in priority order (lower
 * number first): CHUNK_METADATA_ANCHOR_PEER_URLS when set (`{}` gives none,
 * which turns anchoring off), else the GATEWAYS_ROOT_TX_URLS pool, else every
 * TRUSTED_GATEWAYS_URLS entry. All entries are kept, not just the first: a
 * probe fails over to the next peer while one is backed off.
 */
export function resolveAnchorPeerUrls({
  explicit,
  rootTx,
  trusted,
}: {
  explicit: Record<string, number> | undefined;
  rootTx: Record<string, number>;
  trusted: Record<string, { priority: number }>;
}): string[] {
  const byPriority = (entries: [string, number][]) =>
    entries.sort(([, a], [, b]) => a - b).map(([url]) => url);
  if (explicit !== undefined) return byPriority(Object.entries(explicit));
  const fromRootTx = byPriority(Object.entries(rootTx));
  if (fromRootTx.length > 0) return fromRootTx;
  return byPriority(
    Object.entries(trusted).map(([url, { priority }]) => [url, priority]),
  );
}

/**
 * Resolves `offset → tx + data_root` by HEAD-ing a reference peer's
 * `/chunk/{offset}/data`, parsing the `X-Arweave-Chunk-*` headers, and
 * cross-checking the values against the chain (`/tx/{id}/offset` and
 * `/tx/{id}`). Drops the typical fallback cost from log₂(height) block
 * fetches plus per-block tx search to one HEAD per offset and two chain
 * lookups per unique tx (cached in an LRU keyed by tx-id).
 *
 * Slots into {@link CompositeTxBoundarySource} between the local DB
 * source and the existing tx_path / chain-binary-search fallbacks.
 *
 * Trust model: peer headers are **untrusted input**. Only values
 * returned after cross-check via {@link anchorChunkMetadata} are safe
 * to feed merkle proof validation. On any disagreement
 * ({@link ChainAnchorMismatchError}) this source returns `null` so the
 * composite falls through to the canonical chain binary search — never
 * trust the peer over the node.
 *
 * See architect-handoff/retrieval-hints.md and ar-io/ar-io-node#681.
 */
export class ChunkMetadataAnchorSource implements TxBoundarySource {
  private log: winston.Logger;
  private peerUrls: string[];
  private peerHealth = new Map<string, PeerHealth>();
  private peerBackoffBaseMs: number;
  private peerBackoffMaxMs: number;
  private now: () => number;
  private requestTimeoutMs: number;
  private axiosInstance: AxiosInstance;
  private cache: LRUCache<string, AnchoredChunkMetadata>;
  /** Offsets that just missed, so they are not probed again at once. */
  private misses: LRUCache<string, true> | undefined;
  /** Probes in flight, by offset: concurrent lookups share one. */
  private inFlight = new Map<string, SharedProbe>();
  private fetchTxOffset: (
    txId: string,
    signal?: AbortSignal,
  ) => Promise<{ size: string; offset: string }>;
  private fetchTransaction: (
    txId: string,
    signal?: AbortSignal,
  ) => Promise<{ data_root: string }>;

  constructor({
    log,
    peerUrls,
    requestTimeoutMs,
    cacheSize,
    cacheTtlMs,
    missCacheSize = 10_000,
    missCacheTtlMs = 60_000,
    fetchTxOffset,
    fetchTransaction,
    axiosInstance,
    peerBackoffBaseMs = DEFAULT_PEER_BACKOFF_BASE_MS,
    peerBackoffMaxMs = DEFAULT_PEER_BACKOFF_MAX_MS,
    now = Date.now,
  }: {
    log: winston.Logger;
    /**
     * Reference peers to query, in priority order. Each probe asks the first
     * one not backed off; a peer that fails is skipped for a while, so the
     * next one takes its probes instead of every lookup falling through.
     */
    peerUrls: string[];
    requestTimeoutMs: number;
    cacheSize: number;
    cacheTtlMs: number;
    /**
     * Offsets remembered after a miss (no headers, a refusal, an error or a
     * chain mismatch), and for how long; a TTL of 0 turns the miss cache off.
     * Every gateway on the defaults asks the same reference peer, so an
     * offset none can resolve would otherwise be re-probed on every request.
     */
    missCacheSize?: number;
    missCacheTtlMs?: number;
    /**
     * Chain `/tx/{id}/offset` fetcher. Returns `{ size, offset }` as
     * strings so they can round-trip through {@link BigInt} without
     * `Number.MAX_SAFE_INTEGER` loss for weave-scale offsets.
     */
    fetchTxOffset: (
      txId: string,
      signal?: AbortSignal,
    ) => Promise<{ size: string; offset: string }>;
    /** Chain `/tx/{id}` fetcher. Only `data_root` is consulted. */
    fetchTransaction: (
      txId: string,
      signal?: AbortSignal,
    ) => Promise<{ data_root: string }>;
    axiosInstance?: AxiosInstance;
    peerBackoffBaseMs?: number;
    peerBackoffMaxMs?: number;
    now?: () => number;
  }) {
    if (peerUrls.length === 0) {
      throw new Error(
        'ChunkMetadataAnchorSource requires at least one peer URL',
      );
    }
    this.log = log.child({ class: this.constructor.name });
    this.peerUrls = peerUrls;
    this.peerBackoffBaseMs = peerBackoffBaseMs;
    this.peerBackoffMaxMs = peerBackoffMaxMs;
    this.now = now;
    this.requestTimeoutMs = requestTimeoutMs;
    this.fetchTxOffset = fetchTxOffset;
    this.fetchTransaction = fetchTransaction;
    this.cache = new LRUCache<string, AnchoredChunkMetadata>({
      max: cacheSize,
      ttl: cacheTtlMs,
    });
    this.misses =
      missCacheTtlMs > 0 && missCacheSize > 0
        ? new LRUCache<string, true>({
            max: missCacheSize,
            ttl: missCacheTtlMs,
          })
        : undefined;
    this.axiosInstance =
      axiosInstance ??
      axios.create({
        timeout: requestTimeoutMs,
        ...createAgentPair({
          client: 'ChunkMetadataAnchorSource',
          log: this.log,
        }),
        // Don't throw on 4xx/5xx — let the parser decide whether the
        // headers are usable. Some peers may return 200 + headers even
        // when the chunk body itself is unavailable.
        validateStatus: () => true,
      });
  }

  async getTxBoundary(
    absoluteOffset: bigint,
    signal?: AbortSignal,
    requestAttributes?: RequestAttributes,
  ): Promise<TxBoundary | null> {
    signal?.throwIfAborted();
    const log = this.log.child({
      method: 'getTxBoundary',
      absoluteOffset: absoluteOffset.toString(),
    });

    // A chunk request another gateway forwarded is not probed for it. The
    // reference peer is a gateway too, and every gateway on the defaults
    // uses the same one, so probing here on a peer's behalf re-enters the
    // network past the one-hop limit the chunk sources keep: two gateways
    // missing the same chunk ask each other through the anchor without end.
    if (
      (requestAttributes?.hops ?? 0) >= 1 ||
      requestAttributes?.skipRemoteForwarding === true
    ) {
      this.recordResult('peer_origin');
      return null;
    }

    // Guard against unsafe bigint → number coercion. The downstream
    // cache uses number-typed bounds and `anchorChunkMetadata` accepts
    // `offset: number`, so a value past Number.MAX_SAFE_INTEGER would
    // silently lose precision and could return the wrong boundary.
    // Fall through to the canonical chain binary search instead.
    if (absoluteOffset < 0n || absoluteOffset > MAX_SAFE_OFFSET_BIGINT) {
      this.recordResult('error');
      log.warn('Absolute offset outside safe-integer range; falling through', {
        absoluteOffset: absoluteOffset.toString(),
      });
      return null;
    }
    const offsetNum = Number(absoluteOffset);
    const offsetKey = absoluteOffset.toString();
    if (this.misses?.has(offsetKey) === true) {
      this.recordResult('miss_cached');
      return null;
    }
    // Concurrent lookups of one offset share a probe: the incident's
    // pattern was the same missing offset asked for many times at once.
    // The shared probe has its own AbortController rather than any one
    // caller's signal, so one caller cancelling does not fail the others.
    // Waiters are counted: when the last one aborts, the probe is aborted
    // too, so a lookup nobody is waiting for stops using the network.
    let shared = this.inFlight.get(offsetKey);
    if (shared === undefined) {
      const controller = new AbortController();
      const entry: SharedProbe = {
        controller,
        waiters: 0,
        promise: this.probe(offsetNum, absoluteOffset, controller.signal, log)
          .then((boundary) => {
            // Neither an aborted probe nor one no peer was asked for is a
            // miss: nothing was learned about the offset, so the next caller
            // must be free to probe it.
            if (boundary === NOT_PROBED) return null;
            if (boundary === null && !controller.signal.aborted) {
              this.misses?.set(offsetKey, true);
            }
            return boundary;
          })
          .finally(() => this.dropInFlight(offsetKey, entry)),
      };
      // Once every waiter has aborted nobody awaits the probe, so its
      // AbortError would otherwise surface as an unhandled rejection.
      entry.promise.catch(() => undefined);
      this.inFlight.set(offsetKey, entry);
      shared = entry;
    } else {
      this.recordResult('probe_shared');
    }
    return this.waitFor(offsetKey, shared, signal);
  }

  /**
   * Waits on a shared probe on behalf of one caller. A caller without a
   * signal can never abort, so it holds its place until the probe settles.
   * A caller whose signal aborts rejects with an AbortError at once and
   * gives up its place; if it was the last waiter, the probe itself is
   * aborted and dropped from {@link inFlight}, so a later lookup starts a
   * fresh probe rather than joining one that is being torn down.
   */
  private waitFor(
    offsetKey: string,
    shared: SharedProbe,
    signal: AbortSignal | undefined,
  ): Promise<TxBoundary | null> {
    shared.waiters++;
    if (signal === undefined) return shared.promise;
    return new Promise<TxBoundary | null>((resolve, reject) => {
      const onAbort = () => {
        shared.waiters--;
        if (shared.waiters === 0) {
          this.dropInFlight(offsetKey, shared);
          shared.controller.abort();
        }
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        reject(error);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      shared.promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  /**
   * Removes `shared` from {@link inFlight} if it is still the entry for the
   * offset. A probe aborted by its last waiter is dropped at once, and a new
   * probe of the same offset may take its place before the old one settles;
   * the identity check stops the old probe's cleanup removing the new one.
   */
  private dropInFlight(offsetKey: string, shared: SharedProbe): void {
    if (this.inFlight.get(offsetKey) === shared) {
      this.inFlight.delete(offsetKey);
    }
  }

  /** The first reference peer not backed off, in priority order. */
  private selectPeer(): string | undefined {
    const now = this.now();
    return this.peerUrls.find(
      (peer) => (this.peerHealth.get(peer)?.until ?? 0) <= now,
    );
  }

  /** Back a peer off, for longer with each consecutive failure. */
  private markPeerFailed(peer: string, log: winston.Logger): void {
    const health = this.peerHealth.get(peer);
    // Probes already in flight when a peer goes down all fail together. Only
    // the first of them counts: one outage is one failure, not as many as
    // there were concurrent lookups, which would jump straight to the maximum.
    if (health !== undefined && health.until > this.now()) return;
    const failures = (health?.failures ?? 0) + 1;
    const delayMs = Math.min(
      this.peerBackoffBaseMs * 2 ** (failures - 1),
      this.peerBackoffMaxMs,
    );
    this.peerHealth.set(peer, { failures, until: this.now() + delayMs });
    log.debug('Backing off reference peer', { peer, failures, delayMs });
  }

  /** A peer that answered is healthy again. */
  private markPeerHealthy(peer: string): void {
    this.peerHealth.delete(peer);
  }

  /** One probe of a reference peer; null on any miss. */
  private async probe(
    offsetNum: number,
    absoluteOffset: bigint,
    signal: AbortSignal | undefined,
    log: winston.Logger,
  ): Promise<TxBoundary | null | typeof NOT_PROBED> {
    const peer = this.selectPeer();
    if (peer === undefined) {
      this.recordResult('peer_backoff');
      return NOT_PROBED;
    }
    const url = `${peer}/chunk/${absoluteOffset}/data`;
    // Only the hop count, one on: the peer then keeps its one-hop limit
    // and makes no network request for this probe. Only reached at hop 0
    // (forwarded requests return above), so this is always `1`. Nothing
    // else of the client's request (ArNS name, root hints, via) is sent,
    // and deliberately no X-AR-IO-Node-Release: peers' nginx limits key on
    // that header, and turbo-gateway.com's was one bucket for the whole
    // network, which would have refused nearly every anchor probe.
    const requestHeaders: Record<string, string> =
      generateRequestAttributes({ hops: 0, clientIps: [] })?.headers ?? {};

    let headers: Record<string, string | string[] | undefined>;
    try {
      headers = await this.fetchPeerChunkHeaders(url, signal, requestHeaders);
    } catch (err: any) {
      // Normalize Axios's CanceledError (code ERR_CANCELED) into a
      // plain AbortError so signal cancellations propagate instead of
      // being silently demoted to `'error'` and falling through.
      const normalized = normalizeAbortError(err);
      if (normalized?.name === 'AbortError') throw normalized;
      if (err instanceof PeerRefusedHeadError) {
        // 404 is a healthy peer without this chunk. Anything else it refuses
        // with (429, 402, 401, a server fault) will be refused again, so the
        // next peer takes the probes for a while.
        if (err.status === 404) {
          this.markPeerHealthy(peer);
        } else {
          this.markPeerFailed(peer, log);
        }
        this.recordResult('peer_refused');
        log.debug('Peer declined chunk-header probe; not escalating to GET', {
          url,
          status: err.status,
        });
        return null;
      }
      this.markPeerFailed(peer, log);
      this.recordResult('error');
      log.debug('Peer chunk-header fetch failed', {
        url,
        message: err?.message,
      });
      return null;
    }
    // A peer that answers is healthy again, unless what it says contradicts
    // the chain: only then do its failures keep adding up.
    const headerMetadata = parseChunkHeaderMetadata(headers);
    if (headerMetadata === null) {
      this.markPeerHealthy(peer);
      this.recordResult('metadata_missing');
      log.debug('Peer did not return required chunk headers', { url });
      return null;
    }

    // Cache hit: tx already anchored — just confirm the probed offset
    // lives inside the chain-derived range. A peer that lies on this
    // call is caught here without a chain round-trip.
    const cached = this.cache.get(headerMetadata.txId);
    if (cached !== undefined) {
      if (offsetNum < cached.txStartOffset || offsetNum > cached.txEndOffset) {
        // A peer that contradicts the chain is not asked again for a while.
        this.markPeerFailed(peer, log);
        this.recordResult('mismatch');
        log.debug('Cache offset-range mismatch', {
          txId: cached.txId,
          offsetNum,
          txStartOffset: cached.txStartOffset,
          txEndOffset: cached.txEndOffset,
        });
        return null;
      }
      this.markPeerHealthy(peer);
      this.recordResult('cache_hit');
      return this.toBoundary(cached);
    }

    let anchored: AnchoredChunkMetadata;
    try {
      anchored = await anchorChunkMetadata({
        headerMetadata,
        offset: offsetNum,
        fetchTxOffset: (txId) => this.fetchTxOffset(txId, signal),
        fetchTransaction: (txId) => this.fetchTransaction(txId, signal),
      });
    } catch (err: any) {
      const normalized = normalizeAbortError(err);
      if (normalized?.name === 'AbortError') throw normalized;
      if (err instanceof ChainAnchorMismatchError) {
        this.markPeerFailed(peer, log);
        this.recordResult('mismatch');
        log.warn('Chain anchor mismatch — falling through', {
          field: err.field,
          headerValue: err.headerValue,
          chainValue: err.chainValue,
          txId: headerMetadata.txId,
        });
        return null;
      }
      this.recordResult('error');
      log.debug('Chain anchor cross-check failed', {
        message: err?.message,
        txId: headerMetadata.txId,
      });
      return null;
    }

    this.cache.set(headerMetadata.txId, anchored);
    this.markPeerHealthy(peer);
    this.recordResult('hit');
    return this.toBoundary(anchored);
  }

  /**
   * HEAD `/chunk/{offset}/data` first; if the peer rejects HEAD (some
   * non-ar-io peers don't implement it on this route) fall back to a
   * zero-byte range GET so we still get the response headers without
   * pulling the body. Returns the raw header bag for the parser.
   *
   * The fallback is for cases where the *method* is the problem, not the
   * resource:
   * - HEAD threw (network error, peer down, peer doesn't support HEAD)
   * - HEAD returned 2xx but stripped the X-Arweave-Chunk-* headers
   *   (some proxies do this on HEAD even though GET sets them)
   * - HEAD returned 400, 403, 405 or 501. Proxies, WAFs and CDNs handle HEAD
   *   inconsistently: 405/501 are the honest "method not implemented"
   *   answers, but an intermediary that simply refuses the method often
   *   returns 403, and a few answer 400. In all four a GET may well succeed
   *   where the HEAD did not.
   *
   * A resource-or-capacity answer does NOT fall back. 404, 402, 429, 401 and
   * 5xx (other than 501) mean the peer answered about the thing being asked
   * for rather than about how it was asked, so a GET to the same URL repeats
   * the same answer and only doubles the request rate against a peer that is
   * already refusing or failing. Those throw PeerRefusedHeadError, which the
   * caller counts as `peer_refused`.
   *
   * 404 specifically was checked against live peers rather than assumed:
   * ar-io-node serves HEAD and GET from the same Express route, so the two
   * agree, and three independent gateways returned matching statuses for an
   * unresolvable offset (404/404, 503/503, 404/404).
   *
   * `validateStatus: () => true` on the shared instance means these statuses
   * arrive here as responses rather than as thrown errors, so the distinction
   * has to be made explicitly.
   *
   * GET errors propagate up — both methods failing means the peer is
   * unreachable and the composite should fall through to the next
   * source.
   */
  private async fetchPeerChunkHeaders(
    url: string,
    signal: AbortSignal | undefined,
    requestHeaders: Record<string, string>,
  ): Promise<Record<string, string | string[] | undefined>> {
    // Left undefined when HEAD throws, which is a genuine "HEAD didn't work"
    // and still earns the GET fallback. Set outside the catch below so the
    // refusal check can run after it: throwing from inside the `try` would be
    // caught by that same handler and fall through to the GET anyway.
    let headStatus: number | undefined;
    try {
      const headResponse = await this.axiosInstance.head(url, {
        signal,
        timeout: this.requestTimeoutMs,
        headers: requestHeaders,
      });
      headStatus = headResponse.status;
      if (
        headResponse.status >= 200 &&
        headResponse.status < 300 &&
        hasAnyChunkHeader(headResponse.headers)
      ) {
        return headResponse.headers as Record<
          string,
          string | string[] | undefined
        >;
      }
    } catch (err: any) {
      // Re-throw aborts so the caller's signal handling stays correct.
      // normalizeAbortError converts Axios's CanceledError (code
      // ERR_CANCELED, which Axios uses for signal cancellations) into
      // a plain AbortError; without this the cancellation would be
      // misclassified as a network failure and we'd waste a follow-up
      // GET attempt against an aborted signal.
      const normalized = normalizeAbortError(err);
      if (normalized?.name === 'AbortError') throw normalized;
      // Otherwise fall through to the GET fallback below.
    }

    // Escalate only where a GET could plausibly differ from the HEAD, i.e.
    // where the status is about the method rather than about the resource.
    // See the doc comment for why 404 is not in this set.
    const METHOD_PROBLEM_STATUSES = new Set([400, 403, 405, 501]);
    if (
      headStatus !== undefined &&
      !(headStatus >= 200 && headStatus < 300) &&
      !METHOD_PROBLEM_STATUSES.has(headStatus)
    ) {
      throw new PeerRefusedHeadError(headStatus);
    }

    // `bytes=0-0` is the smallest legal range; the server returns a 1-
    // byte body which we discard. Headers are the only thing we want. The
    // body arrives as a stream so a peer that ignores the range has its
    // connection closed instead of its whole response buffered.
    const getResponse = await this.axiosInstance.get(url, {
      signal,
      timeout: this.requestTimeoutMs,
      headers: { ...requestHeaders, Range: 'bytes=0-0' },
      responseType: 'stream',
    });
    await discardResponseBody(getResponse.data, {
      timeoutMs: this.requestTimeoutMs,
    });
    // A buffered read rejected when aborted mid-body; keep that behaviour now
    // that the body is discarded separately.
    signal?.throwIfAborted();
    return getResponse.headers as Record<string, string | string[] | undefined>;
  }

  private recordResult(result: AnchorResult): void {
    metrics.chunkMetadataAnchorTotal.inc({ result });
  }

  private toBoundary(anchored: AnchoredChunkMetadata): TxBoundary {
    return {
      id: anchored.txId,
      dataRoot: anchored.dataRoot.toString('base64url'),
      dataSize: anchored.txEndOffset - anchored.txStartOffset + 1,
      weaveOffset: anchored.txEndOffset,
    };
  }
}

function hasAnyChunkHeader(headers: unknown): boolean {
  if (headers === null || typeof headers !== 'object') return false;
  const lowered = Object.keys(headers as Record<string, unknown>).map((k) =>
    k.toLowerCase(),
  );
  return lowered.some((k) => k.startsWith('x-arweave-chunk-'));
}
