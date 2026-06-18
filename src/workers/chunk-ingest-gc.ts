/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Logger } from 'winston';

import * as config from '../config.js';
import * as metrics from '../metrics.js';
import {
  CHUNK_INGEST_ORIGIN_ALLOWLISTED,
  CHUNK_INGEST_ORIGIN_OPEN,
  resyncPendingBytesEstimate,
} from '../data/ingest-chunk-cache.js';
import {
  ChunkDataStore,
  ChunkMetadataStore,
  ChunkPlacementIndex,
} from '../types.js';

/**
 * Periodically evicts optimistically-cached chunks whose data_root never
 * confirmed on-chain (the "clean chunks that don't make it to chain" guarantee),
 * plus a disk-pressure backstop that evicts the oldest pending chunks when the
 * pending byte total exceeds CHUNK_INGEST_MAX_PENDING_BYTES.
 *
 * Confirmed placements are retained — they are the chunk metadata index. Only
 * still-pending (unconfirmed) placements past their tiered TTL are reclaimed.
 */
export class ChunkIngestGcWorker {
  private log: Logger;
  private chunkDataStore: ChunkDataStore;
  private chunkMetadataStore: ChunkMetadataStore;
  private chunkPlacementIndex: ChunkPlacementIndex;
  private intervalMs: number;
  private batchSize: number;
  private confirmationTimeoutSeconds: number;
  private allowlistConfirmationTimeoutSeconds: number;
  private maxPendingBytes: number;
  private timer: NodeJS.Timeout | undefined;
  private sweeping = false;

  constructor({
    log,
    chunkDataStore,
    chunkMetadataStore,
    chunkPlacementIndex,
    intervalMs = config.CHUNK_INGEST_GC_INTERVAL_MS,
    batchSize = config.CHUNK_INGEST_GC_BATCH_SIZE,
    confirmationTimeoutSeconds = config.CHUNK_INGEST_CONFIRMATION_TIMEOUT_SECONDS,
    allowlistConfirmationTimeoutSeconds = config.CHUNK_INGEST_ALLOWLIST_CONFIRMATION_TIMEOUT_SECONDS,
    maxPendingBytes = config.CHUNK_INGEST_MAX_PENDING_BYTES,
  }: {
    log: Logger;
    chunkDataStore: ChunkDataStore;
    chunkMetadataStore: ChunkMetadataStore;
    chunkPlacementIndex: ChunkPlacementIndex;
    intervalMs?: number;
    batchSize?: number;
    confirmationTimeoutSeconds?: number;
    allowlistConfirmationTimeoutSeconds?: number;
    maxPendingBytes?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.chunkDataStore = chunkDataStore;
    this.chunkMetadataStore = chunkMetadataStore;
    this.chunkPlacementIndex = chunkPlacementIndex;
    this.intervalMs = intervalMs;
    this.batchSize = batchSize;
    this.confirmationTimeoutSeconds = confirmationTimeoutSeconds;
    this.allowlistConfirmationTimeoutSeconds =
      allowlistConfirmationTimeoutSeconds;
    this.maxPendingBytes = maxPendingBytes;
  }

  start(): void {
    if (this.timer !== undefined) {
      return;
    }
    // Seed the synchronous ingest-side disk guard from the on-disk total, so a
    // restart with existing pending data enforces the cap immediately (before
    // the first sweep).
    void this.chunkPlacementIndex
      .sumPendingChunkBytes()
      .then((bytes) => resyncPendingBytesEstimate(bytes))
      .catch(() => undefined);
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.intervalMs);
    // Don't keep the event loop alive solely for the GC timer.
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async sweep(): Promise<void> {
    if (this.sweeping) {
      return; // never overlap sweeps
    }
    this.sweeping = true;
    try {
      const now = Math.floor(Date.now() / 1000);

      // 1. TTL eviction of unconfirmed placements (tiered by origin).
      const expired =
        await this.chunkPlacementIndex.selectExpiredUnconfirmedChunkPlacements({
          originIngest: CHUNK_INGEST_ORIGIN_OPEN,
          originIngestAllowlisted: CHUNK_INGEST_ORIGIN_ALLOWLISTED,
          openCutoff: now - this.confirmationTimeoutSeconds,
          allowCutoff: now - this.allowlistConfirmationTimeoutSeconds,
          limit: this.batchSize,
        });
      for (const placement of expired) {
        await this.evict(placement.dataRoot, placement.relativeOffset, 'ttl');
      }

      // 2. Disk-pressure backstop + pending-bytes gauge.
      let pendingBytes = await this.chunkPlacementIndex.sumPendingChunkBytes();
      if (this.maxPendingBytes > 0 && pendingBytes > this.maxPendingBytes) {
        const oldest =
          await this.chunkPlacementIndex.selectOldestPendingChunkPlacements(
            this.batchSize,
          );
        for (const placement of oldest) {
          if (pendingBytes <= this.maxPendingBytes) {
            break;
          }
          await this.evict(
            placement.dataRoot,
            placement.relativeOffset,
            'disk_pressure',
          );
          pendingBytes -= placement.chunkSize;
        }
      }
      const accuratePending = Math.max(0, pendingBytes);
      metrics.chunkIngestPendingBytesGauge.set(accuratePending);
      // Resync the synchronous ingest-side guard to the authoritative total so
      // it self-corrects as placements confirm or are evicted.
      resyncPendingBytesEstimate(accuratePending);
    } catch (error: unknown) {
      this.log.warn('Chunk ingest GC sweep failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.sweeping = false;
    }
  }

  private async evict(
    dataRoot: string,
    relativeOffset: number,
    reason: string,
  ): Promise<void> {
    await this.chunkDataStore.del(dataRoot, relativeOffset);
    await this.chunkMetadataStore.del(dataRoot, relativeOffset);
    await this.chunkPlacementIndex.deleteChunkPlacement(
      dataRoot,
      relativeOffset,
    );
    metrics.chunkIngestEvictedCounter.inc({ reason });
  }
}
