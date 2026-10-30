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
import {
  CompositeTxBoundarySource,
  TxBoundaryUnavailableError,
} from './composite-tx-boundary-source.js';

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
    // local. CHUNK_PEER_ORIGIN_MODE=audit classifies outcomes by it, so a
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

    it('propagates a database failure rather than reporting a miss', async () => {
      // With no fallback available, swallowing the error would present a
      // SQLite failure as "this offset does not exist".
      const anchorSource = sourceReturning(boundary('anchor-tx'));
      const composite = new CompositeTxBoundarySource({
        log,
        dbSource: sourceThrowing('SQLITE_IOERR: disk I/O error'),
        anchorSource,
      });

      await assert.rejects(
        () => composite.getTxBoundary(OFFSET, undefined, localOnly),
        /disk I\/O error/,
      );
      assert.equal((anchorSource.getTxBoundary as any).mock.callCount(), 0);
    });

    it('leaves the remote sources in play when the flag is absent', async () => {
      const anchorSource = sourceReturning(boundary('anchor-tx'));
      const composite = new CompositeTxBoundarySource({
        log,
        dbSource: sourceReturning(null),
        anchorSource,
      });

      // hops 0: a client's request. (A forwarded one, hops >= 1, is local
      // only regardless of the flag; see 'forwarded requests'.)
      const result = await composite.getTxBoundary(OFFSET, undefined, {
        hops: 0,
        clientIps: [],
      });

      assert.equal(result?.source, 'anchor');
      assert.equal((anchorSource.getTxBoundary as any).mock.callCount(), 1);
    });
  });

  describe('forwarded requests', () => {
    it('answers a request another gateway forwarded from the database only', async () => {
      // Resolving it over the network would spend this gateway's anchor
      // probe, AR.IO peer fetches and chain-search slots for the asker, and
      // the first two re-enter the AR.IO network past the one-hop limit.
      const anchorSource = sourceReturning(boundary('anchor-tx'));
      const txPathSource = sourceReturning(boundary('txpath-tx'));
      const chainSource = sourceReturning(boundary('chain-tx'));
      const dbSource = sourceReturning(null);
      const composite = new CompositeTxBoundarySource({
        log,
        dbSource,
        anchorSource,
        txPathSource,
        chainSource,
      });

      assert.equal(
        await composite.getTxBoundary(OFFSET, undefined, {
          hops: 1,
          clientIps: [],
        }),
        null,
      );
      assert.equal((dbSource.getTxBoundary as any).mock.callCount(), 1);
      for (const remote of [anchorSource, txPathSource, chainSource]) {
        assert.equal((remote.getTxBoundary as any).mock.callCount(), 0);
      }
    });

    it('keeps the chain search for a request that must not reach AR.IO peers', async () => {
      // skipRemoteForwarding covers the AR.IO peer layer (the anchor and
      // tx_path), not Arweave nodes.
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

      const result = await composite.getTxBoundary(OFFSET, undefined, {
        hops: 0,
        clientIps: [],
        skipRemoteForwarding: true,
      });

      assert.equal(result?.source, 'chain');
      assert.equal((anchorSource.getTxBoundary as any).mock.callCount(), 0);
      assert.equal((txPathSource.getTxBoundary as any).mock.callCount(), 0);
    });

    it('propagates a database failure on a forwarded request rather than reporting a miss', async () => {
      const failure = new Error('SQLITE_IOERR');
      const composite = new CompositeTxBoundarySource({
        log,
        dbSource: {
          getTxBoundary: mock.fn(async () => {
            throw failure;
          }),
        },
        chainSource: sourceReturning(boundary('chain-tx')),
      });

      await assert.rejects(
        composite.getTxBoundary(OFFSET, undefined, { hops: 1, clientIps: [] }),
        failure,
      );
    });

    it('still answers a forwarded request the database knows', async () => {
      const composite = new CompositeTxBoundarySource({
        log,
        dbSource: sourceReturning(boundary('db-tx')),
        anchorSource: sourceReturning(boundary('anchor-tx')),
      });
      const result = await composite.getTxBoundary(OFFSET, undefined, {
        hops: 1,
        clientIps: [],
      });
      assert.equal(result?.source, 'db');
    });

    it("hands a client's request attributes to the network sources", async () => {
      const client = { hops: 0, clientIps: [] };
      const anchorSource = sourceReturning(null);
      const txPathSource = sourceReturning(null);
      const composite = new CompositeTxBoundarySource({
        log,
        dbSource: sourceReturning(null),
        anchorSource,
        txPathSource,
      });

      await composite.getTxBoundary(OFFSET, undefined, client);

      for (const source of [anchorSource, txPathSource]) {
        const calls = (source.getTxBoundary as any).mock.calls;
        assert.equal(calls.length, 1);
        assert.equal(calls[0].arguments[2], client);
      }
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

  describe('chain fallback at its concurrency limit (#917)', () => {
    it('says it is unavailable rather than that the offset has no boundary', async () => {
      let release: () => void = () => undefined;
      const slowChain: TxBoundarySource = {
        getTxBoundary: () =>
          new Promise((resolve) => {
            release = () => resolve(boundary('chain-tx'));
          }),
      };
      const composite = new CompositeTxBoundarySource({
        log,
        dbSource: sourceReturning(null),
        chainSource: slowChain,
        chainFallbackConcurrencyLimit: 1,
      });

      const first = composite.getTxBoundary(OFFSET);
      await new Promise((resolve) => setImmediate(resolve));
      await assert.rejects(
        composite.getTxBoundary(OFFSET + 1n),
        TxBoundaryUnavailableError,
      );
      release();
      assert.equal((await first)?.id, 'chain-tx');
    });

    it('still answers null when every source, chain included, missed', async () => {
      const composite = new CompositeTxBoundarySource({
        log,
        dbSource: sourceReturning(null),
        chainSource: sourceReturning(null),
        chainFallbackConcurrencyLimit: 1,
      });
      assert.equal(await composite.getTxBoundary(OFFSET), null);
    });
  });
});
