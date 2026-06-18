/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import crypto from 'node:crypto';
import { Request } from 'express';
import { Logger } from 'winston';

import * as config from '../config.js';
import * as metrics from '../metrics.js';
import { fromB64Url, toB64Url } from '../lib/encoding.js';
import { validateChunk } from '../lib/validation.js';
import { extractAllClientIPs, isAnyIpAllowlisted } from '../lib/ip-utils.js';
import {
  ChunkData,
  ChunkDataStore,
  ChunkMetadata,
  ChunkMetadataStore,
  ChunkPlacementIndex,
  JsonChunkPost,
} from '../types.js';

// `origin` values stored on chunk_placements. Drive the tiered GC leash:
// open-ingest chunks get the short leash, allowlisted posters the long one.
export const CHUNK_INGEST_ORIGIN_OPEN = 1;
export const CHUNK_INGEST_ORIGIN_ALLOWLISTED = 2;

// In-process estimate of pending (unconfirmed) ingest-cached bytes, used to
// enforce CHUNK_INGEST_MAX_PENDING_BYTES *synchronously* at ingest (not just via
// the periodic GC sweep, which a burst could overrun between sweeps).
// Incremented on each cache write; the GC worker resyncs it to the authoritative
// on-disk total each sweep, so it self-corrects as placements confirm or evict.
let pendingBytesEstimate = 0;
export function getPendingBytesEstimate(): number {
  return pendingBytesEstimate;
}
export function resyncPendingBytesEstimate(actualPendingBytes: number): void {
  pendingBytesEstimate = Math.max(0, actualPendingBytes);
}

/**
 * Decide the caching origin for a posted chunk, assuming the feature is enabled
 * (the caller checks `CHUNK_INGEST_CACHE_ENABLED`). Returns null when the poster
 * is not allowlisted — the caller emits the `skipped_not_allowlisted` metric so
 * gated posts are observable.
 *
 * - Allowlist empty         -> OPEN  (any valid chunk is cached)
 * - Poster IP in allowlist  -> ALLOWLISTED
 * - Allowlist set, no match -> null  (relay only, no cache)
 */
export function ingestCacheOrigin(req: Request): number | null {
  const allowlist = config.CHUNK_INGEST_CACHE_ALLOWLIST;
  if (allowlist.length === 0) {
    return CHUNK_INGEST_ORIGIN_OPEN;
  }
  const { clientIps } = extractAllClientIPs(req);
  if (isAnyIpAllowlisted(clientIps, allowlist)) {
    return CHUNK_INGEST_ORIGIN_ALLOWLISTED;
  }
  return null;
}

/**
 * Verify a posted chunk against its asserted data_root and, if valid, write it
 * through to the local chunk stores and record a pending placement row.
 *
 * Safe under open ingest: validateChunk proves the bytes hash into data_root's
 * merkle tree at the given offset, so a real transaction cannot be poisoned —
 * only the genuine bytes validate. Chunks under a data_root that never confirms
 * on-chain are unaddressable (no GET-by-data_root endpoint) and are reclaimed
 * by the GC sweep.
 *
 * Intended to be called fire-and-forget; never throws into the request path.
 */
export async function validateAndCacheIngestedChunk({
  chunkDataStore,
  chunkMetadataStore,
  chunkPlacementIndex,
  body,
  origin,
  log,
}: {
  chunkDataStore: ChunkDataStore;
  chunkMetadataStore: ChunkMetadataStore;
  chunkPlacementIndex: ChunkPlacementIndex;
  body: JsonChunkPost;
  origin: number;
  log: Logger;
}): Promise<void> {
  const endOffset = parseInt(body.offset, 10);
  const dataSize = parseInt(body.data_size, 10);

  // Bound the asserted metadata so a poster can't persist a nonsensical
  // data_size / end offset into chunk_placements. The merkle END offset is
  // maxByteRange - 1, so for any genuine chunk 0 <= endOffset < dataSize.
  if (
    !Number.isInteger(endOffset) ||
    !Number.isInteger(dataSize) ||
    dataSize <= 0 ||
    endOffset >= dataSize
  ) {
    metrics.chunkIngestCacheCounter.inc({ result: 'invalid' });
    return;
  }

  const chunkBuf = fromB64Url(body.chunk);

  // The chunk stores and placement index MUST be keyed by the chunk's START
  // offset within the transaction — that is the value every read path
  // (TxChunksDataSource, range streaming, the unbundler) looks chunks up by.
  // body.offset is the Arweave chunk-POST END offset (maxByteRange - 1), so the
  // start is end - size + 1. (validateChunk keeps using the END offset, which is
  // what the merkle proof is computed against.)
  const relativeOffset = endOffset - chunkBuf.length + 1;
  if (relativeOffset < 0) {
    metrics.chunkIngestCacheCounter.inc({ result: 'invalid' });
    return;
  }

  // Hard disk bound, enforced synchronously here so a burst of posts cannot
  // overrun the disk between GC sweeps. Reject (cheaply, before validation or
  // storage work) once the pending total would exceed the cap.
  const maxPendingBytes = config.CHUNK_INGEST_MAX_PENDING_BYTES;
  if (
    maxPendingBytes > 0 &&
    pendingBytesEstimate + chunkBuf.length > maxPendingBytes
  ) {
    metrics.chunkIngestCacheCounter.inc({ result: 'skipped_disk_full' });
    return;
  }

  // Reserve the bytes synchronously *before* the async validation/storage path,
  // so concurrent ingests count this chunk against the cap immediately. The
  // reservation is released in the finally on any non-cache outcome.
  pendingBytesEstimate += chunkBuf.length;
  let cached = false;
  try {
    const dataPathBuf = fromB64Url(body.data_path);
    const dataRootBuf = fromB64Url(body.data_root);

    // Verify-first. validateChunk throws on a hash or data_path mismatch.
    try {
      await validateChunk(
        dataSize,
        { chunk: chunkBuf, data_path: dataPathBuf },
        dataRootBuf,
        endOffset,
      );
    } catch (error: any) {
      metrics.chunkIngestCacheCounter.inc({ result: 'invalid' });
      log.debug('Rejected invalid ingested chunk', {
        dataRoot: body.data_root,
        relativeOffset,
        message: error?.message,
      });
      return;
    }

    const hash = crypto.createHash('sha256').update(chunkBuf).digest();
    const metadata: ChunkMetadata = {
      data_root: dataRootBuf,
      data_size: dataSize,
      data_path: dataPathBuf,
      offset: relativeOffset,
      chunk_size: chunkBuf.length,
      hash,
    };
    const chunkData: ChunkData = { hash, chunk: chunkBuf };

    // Write the metadata + data pair, then record the ledger row. The stores
    // swallow their own errors, so a partial write reads back as a cache miss
    // (safe fallthrough) rather than serving wrong bytes.
    await chunkMetadataStore.set(metadata);
    await chunkDataStore.set(body.data_root, relativeOffset, chunkData);
    await chunkPlacementIndex.saveChunkPlacement({
      dataRoot: body.data_root,
      relativeOffset,
      dataSize,
      chunkSize: chunkBuf.length,
      hash: toB64Url(hash),
      dataPath: body.data_path,
      txPath: undefined,
      origin,
      cachedAt: Math.floor(Date.now() / 1000),
      confirmedAt: undefined,
    });

    cached = true;
    metrics.chunkIngestCacheCounter.inc({
      result:
        origin === CHUNK_INGEST_ORIGIN_ALLOWLISTED
          ? 'cached_allowlisted'
          : 'cached',
    });
  } finally {
    if (!cached) {
      pendingBytesEstimate = Math.max(
        0,
        pendingBytesEstimate - chunkBuf.length,
      );
    }
  }
}
