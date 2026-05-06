/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import type { AxiosInstance } from 'axios';

import { createTestLogger } from '../../test/test-logger.js';
import { ChunkMetadataAnchorSource } from './chunk-metadata-anchor-source.js';

const log = createTestLogger({ suite: 'ChunkMetadataAnchorSource' });

const txId = 'T3DcnZlZg_FqOQUf9MSZXQ5j7_ETc04OEqbkX-MZRnc';
const dataRoot = 'qoQEdVyTqjLpkybZAgkIgtNawXUHUd5TJZwkWx0Vo-A';
const txStartOffset = 108631448658167n;
const txDataSize = 42724169n;
const txEndOffset = txStartOffset + txDataSize - 1n;
const inRangeOffset = 108631449706743n; // chunkStartOffset within [start, end]

function chunkHeaders(
  overrides: Record<string, string | string[] | undefined> = {},
): Record<string, string | string[] | undefined> {
  return {
    'x-arweave-chunk-tx-id': txId,
    'x-arweave-chunk-tx-start-offset': txStartOffset.toString(),
    'x-arweave-chunk-tx-data-size': txDataSize.toString(),
    'x-arweave-chunk-data-root': dataRoot,
    'x-arweave-chunk-data-path': 'E2OKmVV7k4k',
    'x-arweave-chunk-tx-path': 'H9gNFx8dbHj',
    'x-arweave-chunk-start-offset': inRangeOffset.toString(),
    'x-arweave-chunk-relative-start-offset': '1048576',
    ...overrides,
  };
}

const matchingChainOffset = {
  size: txDataSize.toString(),
  offset: txEndOffset.toString(),
};

// Stub AxiosInstance: track every call, return caller-controlled
// status + headers. Each test seeds the next response via setNext().
function makeAxiosStub(): {
  axios: AxiosInstance;
  calls: { method: 'head' | 'get'; url: string }[];
  setNextHead: (status: number, headers: Record<string, unknown>) => void;
  setNextGet: (status: number, headers: Record<string, unknown>) => void;
  setHeadThrows: (err: unknown) => void;
} {
  const calls: { method: 'head' | 'get'; url: string }[] = [];
  let nextHead: { status: number; headers: Record<string, unknown> } = {
    status: 200,
    headers: {},
  };
  let nextGet: { status: number; headers: Record<string, unknown> } = {
    status: 206,
    headers: {},
  };
  let headError: unknown | undefined;

  const axios = {
    head: async (url: string) => {
      calls.push({ method: 'head', url });
      if (headError !== undefined) {
        const e = headError;
        headError = undefined;
        throw e;
      }
      return nextHead;
    },
    get: async (url: string) => {
      calls.push({ method: 'get', url });
      return nextGet;
    },
  } as unknown as AxiosInstance;

  return {
    axios,
    calls,
    setNextHead: (status, headers) => {
      nextHead = { status, headers };
    },
    setNextGet: (status, headers) => {
      nextGet = { status, headers };
    },
    setHeadThrows: (err) => {
      headError = err;
    },
  };
}

function makeSource({
  axiosInstance,
  fetchTxOffset = async () => matchingChainOffset,
  fetchTransaction = async () => ({ data_root: dataRoot }),
  peerUrls = ['https://ref.example'],
  cacheTtlMs = 60_000,
}: {
  axiosInstance: AxiosInstance;
  fetchTxOffset?: (
    txId: string,
    signal?: AbortSignal,
  ) => Promise<{ size: string; offset: string }>;
  fetchTransaction?: (
    txId: string,
    signal?: AbortSignal,
  ) => Promise<{ data_root: string }>;
  peerUrls?: string[];
  cacheTtlMs?: number;
}): ChunkMetadataAnchorSource {
  return new ChunkMetadataAnchorSource({
    log,
    peerUrls,
    requestTimeoutMs: 1000,
    cacheSize: 32,
    cacheTtlMs,
    fetchTxOffset,
    fetchTransaction,
    axiosInstance,
  });
}

describe('ChunkMetadataAnchorSource', () => {
  afterEach(() => {
    // Tests construct fresh sources; nothing to tear down between cases.
  });

  describe('constructor', () => {
    it('throws when no peer URLs are provided', () => {
      assert.throws(
        () =>
          makeSource({ axiosInstance: makeAxiosStub().axios, peerUrls: [] }),
        /at least one peer/,
      );
    });
  });

  describe('happy path', () => {
    it('returns the chain-anchored TxBoundary on a clean HEAD + cross-check', async () => {
      const stub = makeAxiosStub();
      stub.setNextHead(200, chunkHeaders());

      let txOffsetCalls = 0;
      let txCalls = 0;
      const source = makeSource({
        axiosInstance: stub.axios,
        fetchTxOffset: async () => {
          txOffsetCalls++;
          return matchingChainOffset;
        },
        fetchTransaction: async () => {
          txCalls++;
          return { data_root: dataRoot };
        },
      });

      const result = await source.getTxBoundary(inRangeOffset);

      assert.notEqual(result, null);
      assert.strictEqual(result!.id, txId);
      assert.strictEqual(result!.dataRoot, dataRoot);
      assert.strictEqual(result!.dataSize, Number(txDataSize));
      assert.strictEqual(result!.weaveOffset, Number(txEndOffset));
      assert.strictEqual(txOffsetCalls, 1);
      assert.strictEqual(txCalls, 1);
      assert.deepEqual(stub.calls, [
        {
          method: 'head',
          url: `https://ref.example/chunk/${inRangeOffset}/data`,
        },
      ]);
    });

    it('caches per-tx so a second probe of the same tx skips the chain', async () => {
      const stub = makeAxiosStub();
      stub.setNextHead(200, chunkHeaders());

      let txOffsetCalls = 0;
      let txCalls = 0;
      const source = makeSource({
        axiosInstance: stub.axios,
        fetchTxOffset: async () => {
          txOffsetCalls++;
          return matchingChainOffset;
        },
        fetchTransaction: async () => {
          txCalls++;
          return { data_root: dataRoot };
        },
      });

      // First probe — full path.
      const r1 = await source.getTxBoundary(inRangeOffset);
      assert.notEqual(r1, null);

      // Second probe of a different chunk WITHIN the same tx —
      // headers say the same tx; cache should short-circuit the chain
      // calls. Pick an offset still within [txStartOffset, txEndOffset].
      const secondOffset = txStartOffset + 1000n;
      stub.setNextHead(
        200,
        chunkHeaders({
          'x-arweave-chunk-start-offset': secondOffset.toString(),
        }),
      );

      const r2 = await source.getTxBoundary(secondOffset);
      assert.notEqual(r2, null);
      assert.strictEqual(r2!.id, txId);
      assert.strictEqual(txOffsetCalls, 1, 'chain offset fetched only once');
      assert.strictEqual(txCalls, 1, 'chain tx fetched only once');
    });
  });

  describe('trust-model invariants — peer headers are untrusted', () => {
    it('returns null (falls through) when peer omits required headers', async () => {
      const stub = makeAxiosStub();
      stub.setNextHead(200, {}); // no x-arweave-chunk-* headers
      // Peer chunk-header fetch needs a usable response — stub the
      // fallback GET too so we still observe metadata_missing rather
      // than `error`.
      stub.setNextGet(206, {}); // also no chunk headers

      let txOffsetCalls = 0;
      const source = makeSource({
        axiosInstance: stub.axios,
        fetchTxOffset: async () => {
          txOffsetCalls++;
          return matchingChainOffset;
        },
      });

      const result = await source.getTxBoundary(inRangeOffset);
      assert.strictEqual(result, null);
      assert.strictEqual(
        txOffsetCalls,
        0,
        'must not consult chain when peer headers are missing',
      );
    });

    it('returns null when chain disagrees with peer on txDataSize', async () => {
      const stub = makeAxiosStub();
      stub.setNextHead(200, chunkHeaders());

      const source = makeSource({
        axiosInstance: stub.axios,
        fetchTxOffset: async () => ({
          // Lie: chain says size is +1 byte off.
          size: (txDataSize + 1n).toString(),
          offset: (txEndOffset + 1n).toString(),
        }),
      });

      const result = await source.getTxBoundary(inRangeOffset);
      assert.strictEqual(result, null);
    });

    it('returns null when chain disagrees with peer on data_root', async () => {
      const stub = makeAxiosStub();
      stub.setNextHead(200, chunkHeaders());

      const source = makeSource({
        axiosInstance: stub.axios,
        fetchTransaction: async () => ({
          data_root: 'DIFFERENT-DATA-ROOT',
        }),
      });

      const result = await source.getTxBoundary(inRangeOffset);
      assert.strictEqual(result, null);
    });

    it('returns null when probed offset is outside chain-derived range', async () => {
      const stub = makeAxiosStub();
      stub.setNextHead(200, chunkHeaders());

      const source = makeSource({ axiosInstance: stub.axios });

      // Probe an offset past txEndOffset — chain cross-check rejects.
      const outOfRange = txEndOffset + 100n;
      const result = await source.getTxBoundary(outOfRange);
      assert.strictEqual(result, null);
    });

    it('cached entry rejects an out-of-range probe without re-checking chain', async () => {
      const stub = makeAxiosStub();
      stub.setNextHead(200, chunkHeaders());

      let txOffsetCalls = 0;
      const source = makeSource({
        axiosInstance: stub.axios,
        fetchTxOffset: async () => {
          txOffsetCalls++;
          return matchingChainOffset;
        },
      });

      // First call seeds cache.
      const r1 = await source.getTxBoundary(inRangeOffset);
      assert.notEqual(r1, null);

      // Second call: peer claims SAME tx-id, but probed offset is
      // outside the chain-anchored range. Cache should reject without
      // a chain round-trip.
      stub.setNextHead(
        200,
        chunkHeaders({
          'x-arweave-chunk-start-offset': (txEndOffset + 100n).toString(),
        }),
      );
      const r2 = await source.getTxBoundary(txEndOffset + 100n);
      assert.strictEqual(r2, null);
      assert.strictEqual(txOffsetCalls, 1, 'cache hit must not re-fetch chain');
    });
  });

  describe('HEAD-not-supported fallback', () => {
    it('falls back to range-GET when HEAD throws', async () => {
      const stub = makeAxiosStub();
      stub.setHeadThrows(
        Object.assign(new Error('head not allowed'), { isAxiosError: true }),
      );
      stub.setNextGet(206, chunkHeaders());

      const source = makeSource({ axiosInstance: stub.axios });
      const result = await source.getTxBoundary(inRangeOffset);

      assert.notEqual(result, null);
      assert.strictEqual(result!.id, txId);
      // Both calls should have happened: HEAD threw, GET returned headers.
      assert.strictEqual(stub.calls.length, 2);
      assert.strictEqual(stub.calls[0].method, 'head');
      assert.strictEqual(stub.calls[1].method, 'get');
    });

    it('falls back to range-GET when HEAD returns 200 with no chunk headers', async () => {
      const stub = makeAxiosStub();
      // HEAD returns 200 but with no usable chunk headers (some peers
      // strip them on HEAD even though GET would set them).
      stub.setNextHead(200, { 'content-type': 'application/octet-stream' });
      stub.setNextGet(206, chunkHeaders());

      const source = makeSource({ axiosInstance: stub.axios });
      const result = await source.getTxBoundary(inRangeOffset);

      assert.notEqual(result, null);
      assert.strictEqual(stub.calls.length, 2);
      assert.strictEqual(stub.calls[1].method, 'get');
    });

    it('returns null when both HEAD and GET fail', async () => {
      const stub = makeAxiosStub();
      stub.setHeadThrows(new Error('connect ECONNREFUSED'));
      // get stub will also throw when invoked (override below)
      const failingAxios = {
        head: async () => {
          throw new Error('connect ECONNREFUSED');
        },
        get: async () => {
          throw new Error('connect ECONNREFUSED');
        },
      } as unknown as AxiosInstance;

      const source = makeSource({ axiosInstance: failingAxios });
      const result = await source.getTxBoundary(inRangeOffset);
      assert.strictEqual(result, null);
    });
  });

  describe('abort propagation', () => {
    it('throws AbortError when signal is already aborted', async () => {
      const stub = makeAxiosStub();
      stub.setNextHead(200, chunkHeaders());
      const source = makeSource({ axiosInstance: stub.axios });

      const ac = new AbortController();
      ac.abort();

      await assert.rejects(source.getTxBoundary(inRangeOffset, ac.signal));
    });
  });
});
