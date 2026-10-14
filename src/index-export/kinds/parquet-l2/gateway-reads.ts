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
 * What a band holds must not depend on how the network behaved. So a read
 * has three outcomes: the bytes; a definite no (the range runs past the
 * root, a 416 or a short read); or, once its retries are spent, a failure
 * that stops the band ({@link ReadUnavailableError}), retried with the next
 * run, rather than writing an item unlocated, or an owner without its key,
 * because a gateway timed out.
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

const isOutOfRange = (error: unknown) =>
  error instanceof ShortRangeReadError ||
  (error as { response?: { status?: number } } | null)?.response?.status ===
    416;

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
  /**
   * Headers {@link headerIs} accepted although their tag count field
   * disagrees with their tag bytes: malformed items, located right.
   */
  malformedTags = 0;
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
   * `size` bytes of a root's data at `offset`, or `undefined` when the range
   * runs past the root.
   *
   * @throws ReadUnavailableError when the gateway can't serve it.
   * @throws ReadBudgetError past the band's budget.
   */
  async read(
    rootTxId: Buffer,
    offset: number,
    size: number,
  ): Promise<Buffer | undefined> {
    this.reads += 1;
    if (this.reads > this.options.maxReads) {
      throw new ReadBudgetError(
        `more than ${this.options.maxReads} reads from the gateway for one band (INDEX_EXPORT_L2_MAX_READS)`,
      );
    }
    return this.limit(async () => {
      const root = toB64Url(rootTxId);
      for (let attempt = 0; ; attempt++) {
        const source = this.openRoot(root);
        try {
          return await source.read(offset, size);
        } catch (error) {
          if (isOutOfRange(error)) return undefined;
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
    });
  }

  /**
   * Whether the bytes at `rootOffset` are the header of item `id`, exactly
   * `headerBytes` long: they decode, and the signature hashes to the id.
   * Bytes that don't decode, or run past the root, are not. The header ends
   * where its tag bytes' length says: a tag count field that disagrees with
   * the tags those bytes hold makes the item malformed, not this reading
   * wrong (as the header check rules, `checkBandHeaders`), and is counted.
   */
  async headerIs(
    rootTxId: Buffer,
    rootOffset: number,
    headerBytes: number,
    id: Buffer,
  ): Promise<boolean> {
    if (headerBytes <= 0 || headerBytes > MAX_HEADER_BYTES) return false;
    const bytes = await this.read(rootTxId, rootOffset, headerBytes);
    if (bytes === undefined) return false;
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
