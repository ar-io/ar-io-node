/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The bytes a `parquet-l2` export reads from root transactions through the
 * header-check gateway: an ambiguous item's header at each candidate
 * offset, and an owner's key where no index holds it.
 *
 * What a band holds must not depend on how the network behaved, so a read
 * has four outcomes:
 *
 * - the bytes;
 * - `out_of_range`: the range runs past the root (a 416, or a short read):
 *   these offsets are wrong;
 * - `not_found`: the gateway has no such root (a 404), the answer for this
 *   run: the root is remembered as unreadable, and every later read of it is
 *   answered so without asking again. Old roots that no node serves any
 *   more are common (about half of those of 2023 heights), so an item there
 *   is written unproven, and an owner without its key, rather than stop the
 *   band;
 * - otherwise (a timeout, a 5xx, a 429, a connection that failed), once
 *   its retries are spent, a failure that stops the band
 *   ({@link ReadUnavailableError}), retried with the next run, rather than
 *   write an item unlocated, or an owner without its key, because a gateway
 *   was slow.
 */
import pLimit from 'p-limit';

import { decodeDataItemHeader } from '../../../lib/ans104-bundle-scan.js';
import { MAX_HEADER_BYTES } from '../../../lib/index-band/build.js';
import type { RootSourceFactory } from '../../../lib/index-band/verify.js';
import { toB64Url } from '../../../lib/encoding.js';
import { ShortRangeReadError } from '../../../lib/http-byte-range-source.js';

/** A read the gateway couldn't serve, after retries: the band waits. */
export class ReadUnavailableError extends Error {}

/** More reads than a band may make: the band is refused, for an operator. */
export class ReadBudgetError extends Error {}

const statusOf = (error: unknown) =>
  (error as { response?: { status?: number } } | null)?.response?.status;

const isOutOfRange = (error: unknown) =>
  error instanceof ShortRangeReadError || statusOf(error) === 416;

/** What a read of a root came to, short of its bytes. */
export type ReadMiss = 'out_of_range' | 'not_found';

export interface GatewayReadOptions {
  /** The most reads one band may make ({@link ReadBudgetError} past it). */
  maxReads: number;
  /** Reads in flight at once (default 8). */
  concurrency?: number;
  /** Further tries of a read that failed in transport (default 2). */
  retries?: number;
  /** Pause before the first retry, doubling after (default 2,000 ms). */
  retryDelayMs?: number;
}

export class GatewayReads {
  /** Reads made, retries not counted. */
  reads = 0;
  /** Reads answered 404, and reads of those roots answered without asking. */
  notFound = 0;
  notFoundRemembered = 0;
  /** Reads past the end of their root. */
  outOfRange = 0;
  /**
   * Headers {@link headerIs} accepted although their tag count field
   * disagrees with their tag bytes: malformed items, located right.
   */
  malformedTags = 0;
  /** Roots the gateway answered 404 for: unreadable for this run. */
  private readonly unreadable = new Set<string>();
  /** Roots the gateway has answered for with bytes, or a range past them. */
  private readonly answered = new Set<string>();
  /** The first read of a root not yet heard from, while it is in flight. */
  private readonly asking = new Map<string, Promise<unknown>>();
  private readonly limit: ReturnType<typeof pLimit>;
  private readonly retries: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly openRoot: RootSourceFactory,
    private readonly options: GatewayReadOptions,
  ) {
    this.limit = pLimit(options.concurrency ?? 8);
    this.retries = options.retries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 2000;
  }

  /**
   * `size` bytes of a root's data at `offset`; `out_of_range` when the range
   * runs past the root; `not_found` when the gateway has no such root (and
   * from then on for that root, without asking).
   *
   * @throws ReadUnavailableError when the gateway can't serve it.
   * @throws ReadBudgetError past the band's budget.
   */
  async read(
    rootTxId: Buffer,
    offset: number,
    size: number,
  ): Promise<Buffer | ReadMiss> {
    const root = toB64Url(rootTxId);
    // A root not yet heard from is asked once at a time: its other reads
    // wait, so a root that is gone costs one request, not one a row.
    for (;;) {
      if (this.unreadable.has(root)) {
        this.notFoundRemembered += 1;
        return 'not_found';
      }
      const first = this.asking.get(root);
      if (this.answered.has(root) || first === undefined) break;
      await first.catch(() => undefined);
    }
    this.reads += 1;
    if (this.reads > this.options.maxReads) {
      throw new ReadBudgetError(
        `more than ${this.options.maxReads} reads from the gateway for one band (INDEX_EXPORT_L2_MAX_READS)`,
      );
    }
    const reading = this.limit(() => this.request(root, offset, size));
    if (!this.answered.has(root)) {
      this.asking.set(root, reading);
      void reading
        .catch(() => undefined)
        .finally(() => {
          if (this.asking.get(root) === reading) this.asking.delete(root);
        });
    }
    return reading;
  }

  /** One read, retried in transport; remembers what the root answered. */
  private async request(
    root: string,
    offset: number,
    size: number,
  ): Promise<Buffer | ReadMiss> {
    for (let attempt = 0; ; attempt++) {
      const source = this.openRoot(root);
      try {
        const bytes = await source.read(offset, size);
        this.answered.add(root);
        return bytes;
      } catch (error) {
        if (isOutOfRange(error)) {
          this.answered.add(root);
          this.outOfRange += 1;
          return 'out_of_range';
        }
        if (statusOf(error) === 404) {
          this.notFound += 1;
          this.unreadable.add(root);
          return 'not_found';
        }
        if (attempt >= this.retries) {
          throw new ReadUnavailableError(
            `root ${root} at ${offset} (${size} bytes): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      } finally {
        await source.close?.().catch(() => undefined);
      }
      await new Promise((resolve) =>
        setTimeout(resolve, this.retryDelayMs * 2 ** attempt),
      );
    }
  }

  /**
   * Whether the bytes at `rootOffset` are the header of item `id`, exactly
   * `headerBytes` long: they decode, and the signature hashes to the id.
   * Bytes that don't decode, or run past the root, are not. The header ends
   * where its tag bytes' length says: a tag count field that disagrees with
   * the tags those bytes hold makes the item malformed, not this reading
   * wrong (as the header check rules, `checkBandHeaders`), and is counted.
   * `unreadable` when the gateway has no such root: neither yes nor no.
   */
  async headerIs(
    rootTxId: Buffer,
    rootOffset: number,
    headerBytes: number,
    id: Buffer,
  ): Promise<boolean | 'unreadable'> {
    if (headerBytes <= 0 || headerBytes > MAX_HEADER_BYTES) return false;
    const bytes = await this.read(rootTxId, rootOffset, headerBytes);
    if (bytes === 'not_found') return 'unreadable';
    if (bytes === 'out_of_range') return false;
    try {
      const decoded = decodeDataItemHeader(bytes, {
        allowTagCountMismatch: true,
      });
      const matches =
        decoded.complete &&
        decoded.header.headerSize === headerBytes &&
        decoded.header.id === toB64Url(id);
      if (
        matches &&
        decoded.complete &&
        decoded.header.tagCountMismatch !== undefined
      ) {
        this.malformedTags += 1;
      }
      return matches;
    } catch {
      return false;
    }
  }
}
