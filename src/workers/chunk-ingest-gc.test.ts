/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createTestLogger } from '../../test/test-logger.js';
import { ChunkIngestGcWorker } from './chunk-ingest-gc.js';
import {
  ChunkDataStore,
  ChunkMetadataStore,
  ChunkPlacementIndex,
  ChunkPlacementRef,
} from '../types.js';

const log = createTestLogger();

type Recorder = {
  dataDel: Array<[string, number]>;
  metaDel: Array<[string, number]>;
  placementDel: Array<[string, number]>;
};

const ref = (
  dataRoot: string,
  relativeOffset: number,
  chunkSize: number,
): ChunkPlacementRef => ({ dataRoot, relativeOffset, chunkSize });

function makeDeps({
  expired = [],
  oldest = [],
  pendingBytes = 0,
}: {
  expired?: ChunkPlacementRef[];
  oldest?: ChunkPlacementRef[];
  pendingBytes?: number;
}) {
  const rec: Recorder = { dataDel: [], metaDel: [], placementDel: [] };
  const chunkDataStore = {
    async del(dr: string, ro: number) {
      rec.dataDel.push([dr, ro]);
    },
  } as unknown as ChunkDataStore;
  const chunkMetadataStore = {
    async del(dr: string, ro: number) {
      rec.metaDel.push([dr, ro]);
    },
  } as unknown as ChunkMetadataStore;
  const chunkPlacementIndex = {
    async selectExpiredUnconfirmedChunkPlacements() {
      return expired;
    },
    async selectOldestPendingChunkPlacements() {
      return oldest;
    },
    async deleteChunkPlacement(dr: string, ro: number) {
      rec.placementDel.push([dr, ro]);
    },
    async sumPendingChunkBytes() {
      return pendingBytes;
    },
  } as unknown as ChunkPlacementIndex;
  return { rec, chunkDataStore, chunkMetadataStore, chunkPlacementIndex };
}

describe('ChunkIngestGcWorker', () => {
  it('evicts expired unconfirmed placements from data, metadata and ledger', async () => {
    const { rec, ...deps } = makeDeps({
      expired: [ref('root-a', 0, 100), ref('root-b', 256, 200)],
    });
    const worker = new ChunkIngestGcWorker({
      log,
      ...deps,
      maxPendingBytes: 0, // disable disk-cap so only TTL eviction runs
    });

    await worker.sweep();

    assert.deepEqual(rec.dataDel, [
      ['root-a', 0],
      ['root-b', 256],
    ]);
    assert.deepEqual(rec.metaDel, [
      ['root-a', 0],
      ['root-b', 256],
    ]);
    assert.deepEqual(rec.placementDel, [
      ['root-a', 0],
      ['root-b', 256],
    ]);
  });

  it('evicts oldest pending when pending bytes exceed the disk cap', async () => {
    const { rec, ...deps } = makeDeps({
      expired: [],
      pendingBytes: 1000,
      oldest: [ref('a', 0, 400), ref('b', 0, 400), ref('c', 0, 400)],
    });
    const worker = new ChunkIngestGcWorker({
      log,
      ...deps,
      maxPendingBytes: 500,
    });

    await worker.sweep();

    // 1000 -400=600 (>500) -400=200 (<=500): evicts a and b, stops before c.
    assert.deepEqual(rec.placementDel, [
      ['a', 0],
      ['b', 0],
    ]);
  });

  it('does not evict on the disk cap when under the threshold', async () => {
    const { rec, ...deps } = makeDeps({
      expired: [],
      pendingBytes: 300,
      oldest: [ref('a', 0, 400)],
    });
    const worker = new ChunkIngestGcWorker({
      log,
      ...deps,
      maxPendingBytes: 500,
    });

    await worker.sweep();

    assert.deepEqual(rec.placementDel, []);
  });
});
