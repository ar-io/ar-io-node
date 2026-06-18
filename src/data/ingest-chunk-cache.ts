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

/**
 * Decide whether a posted chunk is eligible for optimistic caching, and under
 * which origin. Returns null when caching is disabled or the poster is not
 * allowlisted (caching gated, not posting — the broadcast relay is unaffected).
 *
 * - Caching disabled        -> null
 * - Allowlist empty         -> OPEN  (any valid chunk is cached)
 * - Poster IP in allowlist  -> ALLOWLISTED
 * - Allowlist set, no match -> null  (relay only, no cache)
 */
export function ingestCacheOrigin(req: Request): number | null {
  if (!config.CHUNK_INGEST_CACHE_ENABLED) {
    return null;
  }
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
  const relativeOffset = parseInt(body.offset, 10);
  const dataSize = parseInt(body.data_size, 10);

  if (!Number.isInteger(relativeOffset) || !Number.isInteger(dataSize)) {
    metrics.chunkIngestCacheCounter.inc({ result: 'invalid' });
    return;
  }

  const chunkBuf = fromB64Url(body.chunk);
  const dataPathBuf = fromB64Url(body.data_path);
  const dataRootBuf = fromB64Url(body.data_root);

  // Verify-first. validateChunk throws on a hash or data_path mismatch.
  try {
    await validateChunk(
      dataSize,
      { chunk: chunkBuf, data_path: dataPathBuf },
      dataRootBuf,
      relativeOffset,
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

  metrics.chunkIngestCacheCounter.inc({
    result:
      origin === CHUNK_INGEST_ORIGIN_ALLOWLISTED
        ? 'cached_allowlisted'
        : 'cached',
  });
}
