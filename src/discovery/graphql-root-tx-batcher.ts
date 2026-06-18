/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';
import { LRUCache } from 'lru-cache';
import { shuffleArray } from '../lib/random.js';

// Sentinel meaning "this ID was not found at any endpoint" (vs. found-and-root,
// which is a LeafResult with bundleId === undefined).
export const NOT_FOUND = Symbol('NOT_FOUND');

// The per-ID result of a single GraphQL `transaction` lookup, projected to the
// fields the root-tx traversal needs.
export interface LeafResult {
  bundleId?: string; // undefined => this tx is not bundled (i.e. a root tx)
  contentType?: string;
  size?: string;
}

export type LookupResult = LeafResult | typeof NOT_FOUND;

export interface BatchEndpoint {
  url: string;
  priority: number; // lower = higher priority
  maxBatchSize: number;
}

/**
 * Issues one batched `transactions(ids: [...])` query against `url` and returns
 * a map of ONLY the IDs that were found (missing IDs are simply absent, which
 * the batcher treats as "try the next endpoint"). Must reject only on transport
 * errors — a successful query with some IDs absent should resolve with whatever
 * was found.
 */
export type FetchBatch = (
  url: string,
  ids: string[],
) => Promise<Map<string, LeafResult>>;

/**
 * Resolves to true if a rate-limiter token was acquired within the configured
 * cap, false if it gave up waiting (the batch is then carried to the next
 * endpoint, or shed as NOT_FOUND if none remain).
 */
export type AcquireToken = () => Promise<boolean>;

export interface BatcherMetrics {
  batchesIssued?: (endpoint: string, size: number) => void;
  shed?: () => void;
  tokenWaitTimeout?: (endpoint: string) => void;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Coalesces many concurrent single-ID GraphQL lookups into batched
 * `transactions(ids: [...])` queries. Callers `await lookup(id)`; the batcher
 * collects IDs over a short window (or until a batch fills), issues one query
 * per batch (consuming one rate-limiter token per outbound request rather than
 * one per ID), and resolves each caller's promise from its slice of the
 * response.
 *
 * Two maps track in-progress IDs so concurrent duplicate lookups share a single
 * result: `pending` (queued, not yet sent) and `inFlight` (sent, awaiting
 * response). The window timer — not any particular caller — drives the flush.
 */
export class GraphQLRootTxBatcher {
  private readonly log: winston.Logger;
  private readonly endpointsByPriority: BatchEndpoint[][];
  private readonly fetchBatch: FetchBatch;
  private readonly acquireToken: AcquireToken;
  private readonly windowMs: number;
  private readonly maxBatchSize: number;
  private readonly maxQueueDepth: number;
  private readonly cache?: LRUCache<string, LeafResult>;
  private readonly metrics?: BatcherMetrics;

  private readonly pending = new Map<string, Deferred<LookupResult>>();
  private readonly inFlight = new Map<string, Deferred<LookupResult>>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor({
    log,
    endpoints,
    fetchBatch,
    acquireToken,
    windowMs,
    maxBatchSize,
    maxQueueDepth,
    cache,
    metrics,
  }: {
    log: winston.Logger;
    endpoints: BatchEndpoint[];
    fetchBatch: FetchBatch;
    acquireToken: AcquireToken;
    windowMs: number;
    maxBatchSize: number;
    maxQueueDepth: number;
    cache?: LRUCache<string, LeafResult>;
    metrics?: BatcherMetrics;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.fetchBatch = fetchBatch;
    this.acquireToken = acquireToken;
    this.windowMs = windowMs;
    this.maxBatchSize = maxBatchSize;
    this.maxQueueDepth = maxQueueDepth;
    this.cache = cache;
    this.metrics = metrics;

    // Group endpoints by priority (ascending) so a flush walks tiers in order
    // and shuffles within a tier for load distribution.
    const byPriority = new Map<number, BatchEndpoint[]>();
    for (const e of endpoints) {
      const tier = byPriority.get(e.priority) ?? [];
      tier.push(e);
      byPriority.set(e.priority, tier);
    }
    this.endpointsByPriority = Array.from(byPriority.keys())
      .sort((a, b) => a - b)
      .map((p) => byPriority.get(p) as BatchEndpoint[]);
  }

  async lookup(id: string): Promise<LookupResult> {
    // An empty/blank ID can never match a transaction, and goldsky's
    // Elasticsearch backend rejects the *entire* `transactions(ids:[...])`
    // query with HTTP 400 ("Ids can't be empty") if any ID in the batch is
    // empty — which would fail every other ID sharing that batch. Short-
    // circuit here so a stray empty ID can never poison a batch.
    if (!id || id.trim() === '') {
      return NOT_FOUND;
    }

    const cached = this.cache?.get(id);
    if (cached !== undefined) {
      return cached;
    }

    // Join an existing in-progress lookup for the same ID (dedup).
    const existing = this.inFlight.get(id) ?? this.pending.get(id);
    if (existing !== undefined) {
      return existing.promise;
    }

    // Shed rather than queue unbounded. Resolving as NOT_FOUND mirrors the
    // pre-batching behavior of skipping a rate-limited lookup (→ 404), so the
    // failure mode under overload is unchanged.
    if (this.pending.size + this.inFlight.size >= this.maxQueueDepth) {
      this.metrics?.shed?.();
      this.log.debug('Shedding lookup; batch queue at max depth', {
        id,
        maxQueueDepth: this.maxQueueDepth,
      });
      return NOT_FOUND;
    }

    const deferred = createDeferred<LookupResult>();
    this.pending.set(id, deferred);
    this.scheduleFlush();
    return deferred.promise;
  }

  private scheduleFlush(): void {
    if (this.pending.size >= this.maxBatchSize) {
      // Don't wait out the window on a full batch.
      this.flush();
    } else if (this.flushTimer === null) {
      // Not unref'd: the timer is short-lived (windowMs) and cleared on flush,
      // so it won't meaningfully delay shutdown, and unref'ing it makes the
      // window-driven flush flaky under test runners that resolve an otherwise
      // idle loop before it fires.
      this.flushTimer = setTimeout(() => this.flush(), this.windowMs);
    }
  }

  private flush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pending.size === 0) {
      return;
    }

    // Drain up to maxBatchSize IDs into this round, moving them pending →
    // inFlight (so concurrent duplicate lookups still join, but the next flush
    // won't re-take them).
    const roundIds: string[] = [];
    for (const [id, deferred] of this.pending) {
      if (roundIds.length >= this.maxBatchSize) break;
      roundIds.push(id);
      this.pending.delete(id);
      this.inFlight.set(id, deferred);
    }

    // Fire the round without blocking; rounds run concurrently.
    void this.resolveRound(roundIds);

    // If more IDs are still queued than one round could take, drain the
    // remainder immediately (another concurrent round).
    if (this.pending.size > 0) {
      this.scheduleFlush();
    }
  }

  private orderedEndpoints(): BatchEndpoint[] {
    // Priority order across tiers; shuffled within each tier.
    return this.endpointsByPriority.flatMap((tier) =>
      tier.length > 1 ? shuffleArray([...tier]) : tier,
    );
  }

  private async resolveRound(roundIds: string[]): Promise<void> {
    const remaining = new Set(roundIds);

    for (const endpoint of this.orderedEndpoints()) {
      if (remaining.size === 0) break;

      const chunks = chunk([...remaining], endpoint.maxBatchSize);
      await Promise.all(
        chunks.map(async (ids) => {
          const gotToken = await this.acquireToken();
          if (!gotToken) {
            this.metrics?.tokenWaitTimeout?.(endpoint.url);
            this.log.debug(
              'Gave up waiting for rate-limit token; carrying IDs',
              {
                endpoint: endpoint.url,
                count: ids.length,
              },
            );
            return; // carry these IDs to the next endpoint
          }

          let found: Map<string, LeafResult>;
          try {
            found = await this.fetchBatch(endpoint.url, ids);
            this.metrics?.batchesIssued?.(endpoint.url, ids.length);
          } catch (error: any) {
            this.log.debug(
              'Batch query failed; carrying IDs to next endpoint',
              {
                endpoint: endpoint.url,
                count: ids.length,
                error: error?.message,
              },
            );
            return; // carry these IDs to the next endpoint
          }

          for (const [id, result] of found) {
            if (!remaining.has(id)) continue;
            this.cache?.set(id, result);
            this.resolveId(id, result);
            remaining.delete(id);
          }
        }),
      );
    }

    // Anything unresolved after all endpoints is genuinely not found (or no
    // endpoint could answer). Do not cache negatives — preserves prior behavior.
    for (const id of remaining) {
      this.resolveId(id, NOT_FOUND);
    }
  }

  private resolveId(id: string, result: LookupResult): void {
    const deferred = this.inFlight.get(id);
    if (deferred !== undefined) {
      this.inFlight.delete(id);
      deferred.resolve(result);
    }
  }
}
