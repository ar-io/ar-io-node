/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { before, describe, it, mock } from 'node:test';

import { createTestLogger } from '../../test/test-logger.js';
import { TxBoundary, TxBoundarySource } from '../types.js';
import { CompositeTxBoundarySource } from './composite-tx-boundary-source.js';

const OFFSET = 51530681327863n;
const B64_DATA_ROOT = 'wRq6f05oRupfTW_M5dcYBtwK5P8rSNYu20vC6D_o-M4';

const boundary = (id: string): TxBoundary => ({
  id,
  dataRoot: B64_DATA_ROOT,
  dataSize: 256000,
  weaveOffset: Number(OFFSET) + 255999,
});

const sourceReturning = (result: TxBoundary | null): TxBoundarySource => ({
  getTxBoundary: mock.fn(async () => result),
});

const sourceThrowing = (message: string): TxBoundarySource => ({
  getTxBoundary: mock.fn(async () => {
    throw new Error(message);
  }),
});

let log: ReturnType<typeof createTestLogger>;

before(() => {
  log = createTestLogger({ suite: 'CompositeTxBoundarySource' });
});

describe('CompositeTxBoundarySource', () => {
  describe('source attribution', () => {
    // The `source` label is what tells a caller whether resolution stayed
    // local. CHUNK_PEER_ORIGIN_MODE=shadow classifies outcomes by it, so a
    // wrong label silently corrupts that measurement.
    it('labels a database hit as db and consults nothing else', async () => {
      const anchorSource = sourceReturning(boundary('anchor-tx'));
      const composite = new CompositeTxBoundarySource({
        log,
        dbSource: sourceReturning(boundary('db-tx')),
        anchorSource,
        txPathSource: sourceReturning(boundary('txpath-tx')),
        chainSource: sourceReturning(boundary('chain-tx')),
      });

      const result = await composite.getTxBoundary(OFFSET);

      assert.equal(result?.source, 'db');
      assert.equal(result?.id, 'db-tx');
      assert.equal((anchorSource.getTxBoundary as any).mock.callCount(), 0);
    });

    it('labels an anchor hit as anchor when the database misses', async () => {
      const composite = new CompositeTxBoundarySource({
        log,
        dbSource: sourceReturning(null),
        anchorSource: sourceReturning(boundary('anchor-tx')),
        txPathSource: sourceReturning(boundary('txpath-tx')),
      });

      const result = await composite.getTxBoundary(OFFSET);

      assert.equal(result?.source, 'anchor');
      assert.equal(result?.id, 'anchor-tx');
    });

    it('labels a tx_path hit as tx_path', async () => {
      const composite = new CompositeTxBoundarySource({
        log,
        dbSource: sourceReturning(null),
        anchorSource: sourceReturning(null),
        txPathSource: sourceReturning(boundary('txpath-tx')),
        chainSource: sourceReturning(boundary('chain-tx')),
      });

      const result = await composite.getTxBoundary(OFFSET);

      assert.equal(result?.source, 'tx_path');
      assert.equal(result?.id, 'txpath-tx');
    });

    it('labels a chain hit as chain', async () => {
      const composite = new CompositeTxBoundarySource({
        log,
        dbSource: sourceReturning(null),
        anchorSource: sourceReturning(null),
        txPathSource: sourceReturning(null),
        chainSource: sourceReturning(boundary('chain-tx')),
      });

      const result = await composite.getTxBoundary(OFFSET);

      assert.equal(result?.source, 'chain');
      assert.equal(result?.id, 'chain-tx');
    });

    it('falls past a throwing source and labels the one that answers', async () => {
      const composite = new CompositeTxBoundarySource({
        log,
        dbSource: sourceThrowing('db unavailable'),
        anchorSource: sourceReturning(boundary('anchor-tx')),
      });

      const result = await composite.getTxBoundary(OFFSET);

      assert.equal(result?.source, 'anchor');
    });

    it('returns null when every source misses', async () => {
      const composite = new CompositeTxBoundarySource({
        log,
        dbSource: sourceReturning(null),
        anchorSource: sourceReturning(null),
        txPathSource: sourceReturning(null),
        chainSource: sourceReturning(null),
      });

      assert.equal(await composite.getTxBoundary(OFFSET), null);
    });
  });

  describe('localSourcesOnly', () => {
    const localOnly = { hops: 1, clientIps: [], localSourcesOnly: true };

    it('still uses the database source, which needs no network', async () => {
      const anchorSource = sourceReturning(boundary('anchor-tx'));
      const composite = new CompositeTxBoundarySource({
        log,
        dbSource: sourceReturning(boundary('db-tx')),
        anchorSource,
      });

      const result = await composite.getTxBoundary(
        OFFSET,
        undefined,
        localOnly,
      );

      assert.equal(result?.source, 'db');
      assert.equal((anchorSource.getTxBoundary as any).mock.callCount(), 0);
    });

    it('returns null rather than reaching the network when the database misses', async () => {
      const anchorSource = sourceReturning(boundary('anchor-tx'));
      const txPathSource = sourceReturning(boundary('txpath-tx'));
      const chainSource = sourceReturning(boundary('chain-tx'));
      const composite = new CompositeTxBoundarySource({
        log,
        dbSource: sourceReturning(null),
        anchorSource,
        txPathSource,
        chainSource,
      });

      const result = await composite.getTxBoundary(
        OFFSET,
        undefined,
        localOnly,
      );

      // Each of these is a network call: a HEAD to a peer, an unvalidated
      // chunk fetch from AR.IO peers, and a chain binary search.
      assert.equal(result, null);
      assert.equal((anchorSource.getTxBoundary as any).mock.callCount(), 0);
      assert.equal((txPathSource.getTxBoundary as any).mock.callCount(), 0);
      assert.equal((chainSource.getTxBoundary as any).mock.callCount(), 0);
    });

    it('leaves the remote sources in play when the flag is absent', async () => {
      const anchorSource = sourceReturning(boundary('anchor-tx'));
      const composite = new CompositeTxBoundarySource({
        log,
        dbSource: sourceReturning(null),
        anchorSource,
      });

      const result = await composite.getTxBoundary(OFFSET, undefined, {
        hops: 1,
        clientIps: [],
      });

      assert.equal(result?.source, 'anchor');
      assert.equal((anchorSource.getTxBoundary as any).mock.callCount(), 1);
    });
  });

  describe('cancellation', () => {
    it('propagates an AbortError rather than falling through', async () => {
      const anchorSource = sourceReturning(boundary('anchor-tx'));
      const composite = new CompositeTxBoundarySource({
        log,
        dbSource: {
          getTxBoundary: mock.fn(async () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            throw error;
          }),
        },
        anchorSource,
      });

      await assert.rejects(
        () => composite.getTxBoundary(OFFSET),
        (error: any) => error.name === 'AbortError',
      );
      assert.equal((anchorSource.getTxBoundary as any).mock.callCount(), 0);
    });
  });
});
