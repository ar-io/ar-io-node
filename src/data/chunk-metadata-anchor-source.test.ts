/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
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
  /** The headers each call sent, in call order. */
  sentHeaders: (Record<string, string> | undefined)[];
  setNextHead: (status: number, headers: Record<string, unknown>) => void;
  setNextGet: (status: number, headers: Record<string, unknown>) => void;
  setHeadThrows: (err: unknown) => void;
} {
  const calls: { method: 'head' | 'get'; url: string }[] = [];
  const sentHeaders: (Record<string, string> | undefined)[] = [];
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
    head: async (
      url: string,
      config?: { headers?: Record<string, string> },
    ) => {
      calls.push({ method: 'head', url });
      sentHeaders.push(config?.headers);
      if (headError !== undefined) {
        const e = headError;
        headError = undefined;
        throw e;
      }
      return nextHead;
    },
    get: async (url: string, config?: { headers?: Record<string, string> }) => {
      calls.push({ method: 'get', url });
      sentHeaders.push(config?.headers);
      return nextGet;
    },
  } as unknown as AxiosInstance;

  return {
    axios,
    calls,
    sentHeaders,
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
  missCacheTtlMs = 0,
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
  missCacheTtlMs?: number;
}): ChunkMetadataAnchorSource {
  return new ChunkMetadataAnchorSource({
    log,
    peerUrls,
    requestTimeoutMs: 1000,
    cacheSize: 32,
    cacheTtlMs,
    missCacheTtlMs,
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

    // #882: a non-2xx HEAD used to fall through to the ranged GET regardless of
    // status, so a peer answering 404 or 429 received two requests instead of
    // one. `validateStatus: () => true` means these arrive as responses rather
    // than thrown errors, which is why the old `status >= 200` check let them
    // through. Escalation is now limited to statuses a GET could actually
    // improve on.
    for (const status of [404, 429, 402, 401, 500, 502, 503]) {
      it(`does NOT escalate to GET when HEAD returns ${status}`, async () => {
        const stub = makeAxiosStub();
        stub.setNextHead(status, {});
        // Armed deliberately: if the implementation regresses and escalates,
        // the GET would succeed and the assertions below would catch it as a
        // spurious success rather than as a missing stub.
        stub.setNextGet(206, chunkHeaders());

        const source = makeSource({ axiosInstance: stub.axios });
        const result = await source.getTxBoundary(inRangeOffset);

        assert.strictEqual(result, null);
        assert.strictEqual(
          stub.calls.length,
          1,
          `expected HEAD only for status ${status}, got ${stub.calls
            .map((c) => c.method)
            .join(',')}`,
        );
        assert.strictEqual(stub.calls[0].method, 'head');
      });
    }

    // 400/403 join 405/501 because an intermediary refusing the *method*
    // rarely says so cleanly: WAFs and CDNs commonly answer 403, and some
    // answer 400, where a GET to the same URL still succeeds. Flagged by
    // CodeRabbit, which is right that HEAD handling is inconsistent across
    // proxies even though the ar-io-node peers we actually probe answer
    // HEAD and GET identically.
    for (const status of [400, 403, 405, 501]) {
      it(`still escalates to GET when HEAD returns ${status} (method refused)`, async () => {
        const stub = makeAxiosStub();
        stub.setNextHead(status, {});
        stub.setNextGet(206, chunkHeaders());

        const source = makeSource({ axiosInstance: stub.axios });
        const result = await source.getTxBoundary(inRangeOffset);

        assert.notEqual(result, null);
        assert.strictEqual(result!.id, txId);
        assert.strictEqual(stub.calls.length, 2);
        assert.strictEqual(stub.calls[1].method, 'get');
      });
    }

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

  describe('loop guard: hops and the miss cache', () => {
    it('does not probe for a request another gateway forwarded', async () => {
      const stub = makeAxiosStub();
      stub.setNextHead(200, chunkHeaders());
      const source = makeSource({ axiosInstance: stub.axios });
      const result = await source.getTxBoundary(inRangeOffset, undefined, {
        hops: 1,
        clientIps: [],
      });
      assert.equal(result, null);
      assert.equal(stub.calls.length, 0, 'no request to the reference peer');
    });

    it('does not probe for a request that asks not to be forwarded', async () => {
      const stub = makeAxiosStub();
      stub.setNextHead(200, chunkHeaders());
      const source = makeSource({ axiosInstance: stub.axios });
      const result = await source.getTxBoundary(inRangeOffset, undefined, {
        hops: 0,
        clientIps: [],
        skipRemoteForwarding: true,
      });
      assert.equal(result, null);
      assert.equal(stub.calls.length, 0);
    });

    it("sends only the hop count, none of the client's request", async () => {
      const stub = makeAxiosStub();
      stub.setNextHead(200, chunkHeaders());
      const source = makeSource({ axiosInstance: stub.axios });
      await source.getTxBoundary(inRangeOffset, undefined, {
        hops: 0,
        clientIps: ['203.0.113.9'],
        arnsName: 'someone',
        origin: 'client.example',
        rootTransactionIdHint: txId,
      });
      // No X-AR-IO-Node-Release either: peers' nginx limits key on it.
      assert.deepEqual(stub.sentHeaders[0], { 'X-AR-IO-Hops': '1' });
    });

    it('marks the probe one hop on with no request attributes, and on the GET fallback', async () => {
      const stub = makeAxiosStub();
      stub.setNextHead(405, {});
      stub.setNextGet(206, chunkHeaders());
      const source = makeSource({ axiosInstance: stub.axios });
      await source.getTxBoundary(inRangeOffset);
      assert.deepEqual(
        stub.calls.map((c) => c.method),
        ['head', 'get'],
      );
      assert.deepEqual(
        stub.sentHeaders.map((h) => h?.['X-AR-IO-Hops']),
        ['1', '1'],
      );
      assert.equal(stub.sentHeaders[1]?.Range, 'bytes=0-0');
    });

    it('does not probe an offset again while its miss is remembered', async () => {
      const stub = makeAxiosStub();
      stub.setNextHead(404, {});
      const source = makeSource({
        axiosInstance: stub.axios,
        missCacheTtlMs: 60_000,
      });
      assert.equal(await source.getTxBoundary(inRangeOffset), null);
      assert.equal(await source.getTxBoundary(inRangeOffset), null);
      assert.equal(stub.calls.length, 1, 'the second lookup asked no one');
      // Another offset is still probed.
      await source.getTxBoundary(inRangeOffset + 1n);
      assert.equal(stub.calls.length, 2);
    });

    it('probes again once the miss is forgotten (TTL 0: never remembered)', async () => {
      const stub = makeAxiosStub();
      stub.setNextHead(404, {});
      const source = makeSource({
        axiosInstance: stub.axios,
        missCacheTtlMs: 0,
      });
      await source.getTxBoundary(inRangeOffset);
      await source.getTxBoundary(inRangeOffset);
      assert.equal(stub.calls.length, 2);
    });

    it('does not remember a hit as a miss', async () => {
      const stub = makeAxiosStub();
      stub.setNextHead(200, chunkHeaders());
      const source = makeSource({
        axiosInstance: stub.axios,
        missCacheTtlMs: 60_000,
      });
      assert.notEqual(await source.getTxBoundary(inRangeOffset), null);
      assert.notEqual(await source.getTxBoundary(inRangeOffset), null);
    });

    it('shares one probe between concurrent lookups of an offset', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const calls: string[] = [];
      const axiosInstance = {
        head: async (url: string) => {
          calls.push(url);
          await gate;
          return { status: 404, headers: {} };
        },
        get: async () => {
          throw new Error('no GET expected');
        },
      } as unknown as AxiosInstance;
      const source = makeSource({ axiosInstance });
      const lookups = Array.from({ length: 10 }, () =>
        source.getTxBoundary(inRangeOffset),
      );
      release();
      assert.deepEqual(await Promise.all(lookups), Array(10).fill(null));
      assert.equal(calls.length, 1, 'one probe for ten lookups');
    });

    it("lets a caller stop waiting without failing the others' shared probe", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const axiosInstance = {
        head: async () => {
          await gate;
          return { status: 200, headers: chunkHeaders() };
        },
        get: async () => {
          throw new Error('no GET expected');
        },
      } as unknown as AxiosInstance;
      const source = makeSource({ axiosInstance });
      const controller = new AbortController();
      const first = source.getTxBoundary(inRangeOffset, controller.signal);
      const second = source.getTxBoundary(inRangeOffset);
      controller.abort();
      await assert.rejects(first, { name: 'AbortError' });
      release();
      assert.notEqual(await second, null, 'the other caller still gets it');
    });
  });

  describe('shared probe cancellation', () => {
    // A peer that answers only when released, and honours the request's
    // signal the way axios does (rejecting with CanceledError).
    function makeGatedPeer(response: {
      status: number;
      headers: Record<string, unknown>;
    }) {
      const signals: (AbortSignal | undefined)[] = [];
      const releases: (() => void)[] = [];
      const axiosInstance = {
        head: (_url: string, config?: { signal?: AbortSignal }) => {
          const signal = config?.signal;
          signals.push(signal);
          return new Promise((resolve, reject) => {
            releases.push(() => resolve(response));
            signal?.addEventListener(
              'abort',
              () =>
                reject(
                  Object.assign(new Error('canceled'), {
                    code: 'ERR_CANCELED',
                    name: 'CanceledError',
                  }),
                ),
              { once: true },
            );
          });
        },
        get: async () => {
          throw new Error('no GET expected');
        },
      } as unknown as AxiosInstance;
      return {
        axiosInstance,
        signals,
        release: (i: number) => releases[i](),
      };
    }

    it('aborts the probe when every caller has aborted', async () => {
      const peer = makeGatedPeer({ status: 200, headers: chunkHeaders() });
      const source = makeSource({ axiosInstance: peer.axiosInstance });
      const a = new AbortController();
      const b = new AbortController();
      const first = source.getTxBoundary(inRangeOffset, a.signal);
      const second = source.getTxBoundary(inRangeOffset, b.signal);
      assert.equal(peer.signals.length, 1, 'one probe for two lookups');
      a.abort();
      await assert.rejects(first, { name: 'AbortError' });
      assert.equal(peer.signals[0]?.aborted, false, 'one caller still waits');
      b.abort();
      await assert.rejects(second, { name: 'AbortError' });
      assert.equal(peer.signals[0]?.aborted, true, 'the HEAD saw the abort');
    });

    it('keeps probing for the caller still waiting when one aborts', async () => {
      const peer = makeGatedPeer({ status: 200, headers: chunkHeaders() });
      let chainSignal: AbortSignal | undefined;
      const source = makeSource({
        axiosInstance: peer.axiosInstance,
        fetchTxOffset: async (_txId, signal) => {
          chainSignal = signal;
          return matchingChainOffset;
        },
      });
      const a = new AbortController();
      const b = new AbortController();
      const first = source.getTxBoundary(inRangeOffset, a.signal);
      const second = source.getTxBoundary(inRangeOffset, b.signal);
      a.abort();
      await assert.rejects(first, { name: 'AbortError' });
      peer.release(0);
      const boundary = await second;
      assert.equal(boundary?.id, txId);
      assert.equal(peer.signals[0]?.aborted, false);
      assert.equal(chainSignal?.aborted, false, 'chain check not aborted');
    });

    it('starts a fresh probe for a caller after a full abort', async () => {
      const peer = makeGatedPeer({ status: 200, headers: chunkHeaders() });
      const source = makeSource({ axiosInstance: peer.axiosInstance });
      const a = new AbortController();
      const first = source.getTxBoundary(inRangeOffset, a.signal);
      a.abort();
      await assert.rejects(first, { name: 'AbortError' });
      const second = source.getTxBoundary(inRangeOffset);
      assert.equal(peer.signals.length, 2, 'did not join the aborted probe');
      assert.equal(peer.signals[1]?.aborted, false);
      peer.release(1);
      assert.equal((await second)?.id, txId);
      // The aborted probe's late cleanup must not drop the new one: a
      // third concurrent lookup would otherwise start yet another probe.
      const third = source.getTxBoundary(inRangeOffset, a.signal);
      await assert.rejects(third, { name: 'AbortError' });
      assert.equal(peer.signals.length, 2);
    });

    it('does not remember an aborted probe as a miss', async () => {
      const peer = makeGatedPeer({ status: 404, headers: {} });
      const source = makeSource({
        axiosInstance: peer.axiosInstance,
        missCacheTtlMs: 60_000,
      });
      const a = new AbortController();
      const first = source.getTxBoundary(inRangeOffset, a.signal);
      a.abort();
      await assert.rejects(first, { name: 'AbortError' });
      // Let the aborted probe settle so its cleanup has run.
      await new Promise((resolve) => setImmediate(resolve));
      const second = source.getTxBoundary(inRangeOffset);
      assert.equal(peer.signals.length, 2, 'probed again, not miss_cached');
      peer.release(1);
      assert.equal(await second, null);
      // A real miss is remembered.
      assert.equal(await source.getTxBoundary(inRangeOffset), null);
      assert.equal(peer.signals.length, 2);
    });

    it('never aborts a probe a caller without a signal waits on', async () => {
      const peer = makeGatedPeer({ status: 200, headers: chunkHeaders() });
      const source = makeSource({ axiosInstance: peer.axiosInstance });
      const unsignalled = source.getTxBoundary(inRangeOffset);
      const a = new AbortController();
      const signalled = source.getTxBoundary(inRangeOffset, a.signal);
      a.abort();
      await assert.rejects(signalled, { name: 'AbortError' });
      assert.equal(peer.signals[0]?.aborted, false);
      peer.release(0);
      assert.equal((await unsignalled)?.id, txId);
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

    it("normalizes Axios's CanceledError (ERR_CANCELED) into AbortError", async () => {
      // Axios 1.15.0 rejects an AbortSignal cancellation as
      // CanceledError with code='ERR_CANCELED', NOT AbortError. The
      // source must normalize via lib/http-utils.normalizeAbortError
      // so the abort propagates instead of being demoted to
      // 'error' and the canonical lookup running anyway.
      const stub = makeAxiosStub();
      stub.setHeadThrows(
        Object.assign(new Error('canceled'), {
          code: 'ERR_CANCELED',
          name: 'CanceledError',
        }),
      );
      // GET fallback should also reject with ERR_CANCELED — same
      // normalization must apply there.
      stub.axios.get = async () => {
        throw Object.assign(new Error('canceled'), {
          code: 'ERR_CANCELED',
          name: 'CanceledError',
        });
      };
      const source = makeSource({ axiosInstance: stub.axios });

      await assert.rejects(
        source.getTxBoundary(inRangeOffset),
        (err: any) => err?.name === 'AbortError',
      );
    });

    it('normalizes Axios CanceledError raised during chain cross-check', async () => {
      // The second catch site lives around the anchorChunkMetadata
      // call. If the chain fetcher rejects with ERR_CANCELED, the
      // source must propagate it as AbortError, not log+swallow.
      const stub = makeAxiosStub();
      stub.setNextHead(200, chunkHeaders());
      const source = makeSource({
        axiosInstance: stub.axios,
        fetchTxOffset: async () => {
          throw Object.assign(new Error('canceled'), {
            code: 'ERR_CANCELED',
            name: 'CanceledError',
          });
        },
      });

      await assert.rejects(
        source.getTxBoundary(inRangeOffset),
        (err: any) => err?.name === 'AbortError',
      );
    });
  });

  describe('safe-integer offset guard', () => {
    it('falls through (returns null) when absoluteOffset exceeds Number.MAX_SAFE_INTEGER', async () => {
      // Cache + chain cross-check both consume the offset as `number`.
      // A bigint past the safe-integer ceiling can't round-trip without
      // precision loss and could yield a wrong tx boundary. The source
      // must skip itself and let the canonical chain binary search take
      // over for these (rare) probes.
      const stub = makeAxiosStub();
      stub.setNextHead(200, chunkHeaders());
      const source = makeSource({ axiosInstance: stub.axios });

      const unsafeOffset = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
      const result = await source.getTxBoundary(unsafeOffset);

      assert.strictEqual(result, null);
      // Must NOT have hit the peer or chain — bail before any I/O.
      assert.strictEqual(stub.calls.length, 0);
    });

    it('falls through for negative offsets too', async () => {
      // BigInt arithmetic can produce negatives. Defensive: never
      // probe the peer with a negative offset.
      const stub = makeAxiosStub();
      const source = makeSource({ axiosInstance: stub.axios });

      const result = await source.getTxBoundary(-1n);

      assert.strictEqual(result, null);
      assert.strictEqual(stub.calls.length, 0);
    });

    it('accepts MAX_SAFE_INTEGER itself (boundary inclusive)', async () => {
      // Sanity: the guard uses `> MAX_SAFE_OFFSET_BIGINT`, so the
      // MAX_SAFE_INTEGER value itself is allowed through. Any in-flight
      // attempt requires an actually-fitting tx range, so we use a
      // chain cross-check that fails and confirm the source did at
      // least attempt the peer call (proves the guard didn't skip it).
      const stub = makeAxiosStub();
      stub.setNextHead(200, chunkHeaders());
      const source = makeSource({
        axiosInstance: stub.axios,
        fetchTxOffset: async () => ({
          // Make the chain say the tx ends at MAX_SAFE_INTEGER too,
          // so the offset is in-range and the anchor succeeds.
          size: '1',
          offset: String(Number.MAX_SAFE_INTEGER),
        }),
        fetchTransaction: async () => ({ data_root: dataRoot }),
      });

      // Build headers consistent with the chain answer.
      stub.setNextHead(
        200,
        chunkHeaders({
          'x-arweave-chunk-tx-data-size': '1',
          'x-arweave-chunk-tx-start-offset': String(Number.MAX_SAFE_INTEGER),
          'x-arweave-chunk-start-offset': String(Number.MAX_SAFE_INTEGER),
        }),
      );

      const result = await source.getTxBoundary(
        BigInt(Number.MAX_SAFE_INTEGER),
      );
      // The peer was queried (proves guard didn't skip), and the
      // chain cross-check succeeded.
      assert.strictEqual(stub.calls.length, 1);
      assert.notStrictEqual(result, null);
    });
  });

  describe('range-GET fallback against a real server', () => {
    /**
     * A peer whose HEAD carries no chunk headers, so every probe takes the
     * range-GET fallback. Records each request's client port so tests can
     * tell whether connections were reused.
     */
    const startPeer = async (onGet: (res: http.ServerResponse) => void) => {
      const clientPorts: number[] = [];
      const server = http.createServer((req, res) => {
        clientPorts.push(req.socket.remotePort ?? -1);
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Length': '0' });
          res.end();
          return;
        }
        onGet(res);
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const { port } = server.address() as AddressInfo;
      return {
        url: `http://127.0.0.1:${port}`,
        clientPorts,
        close: async () => {
          server.closeAllConnections();
          await new Promise((resolve) => server.close(resolve));
        },
      };
    };

    /** A source using its own real axios instance. */
    const makeRealSource = (peerUrl: string) =>
      new ChunkMetadataAnchorSource({
        log,
        peerUrls: [peerUrl],
        requestTimeoutMs: 5000,
        cacheSize: 32,
        cacheTtlMs: 60_000,
        fetchTxOffset: async () => matchingChainOffset,
        fetchTransaction: async () => ({ data_root: dataRoot }),
      });

    it('does not download the whole body when the peer ignores the range', async () => {
      const total = 64 * 1024 * 1024;
      const progress = { written: 0, finished: false };
      const peer = await startPeer((res) => {
        res.writeHead(200, {
          'Content-Length': String(total),
          ...(chunkHeaders() as Record<string, string>),
        });
        const chunk = Buffer.alloc(64 * 1024);
        const write = () => {
          while (progress.written < total) {
            progress.written += chunk.length;
            if (!res.write(chunk)) {
              res.once('drain', write);
              return;
            }
          }
          res.end();
          progress.finished = true;
        };
        write();
      });
      try {
        const result = await makeRealSource(peer.url).getTxBoundary(
          inRangeOffset,
        );

        assert.notEqual(result, null);
        assert.strictEqual(result!.id, txId);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(progress.finished, false);
        assert.ok(
          progress.written < total / 2,
          `peer sent ${progress.written} of ${total} bytes`,
        );
      } finally {
        await peer.close();
      }
    });

    it('keeps reusing the connection when the peer honours the range', async () => {
      const peer = await startPeer((res) => {
        res.writeHead(206, {
          'Content-Length': '1',
          'Content-Range': 'bytes 0-0/262144',
          ...(chunkHeaders() as Record<string, string>),
        });
        res.end(Buffer.from('x'));
      });
      try {
        const source = makeRealSource(peer.url);
        assert.notEqual(await source.getTxBoundary(inRangeOffset), null);
        assert.notEqual(await source.getTxBoundary(inRangeOffset + 1n), null);

        // HEAD and GET for each probe, all over one keep-alive connection.
        assert.equal(peer.clientPorts.length, 4);
        assert.equal(new Set(peer.clientPorts).size, 1);
      } finally {
        await peer.close();
      }
    });
  });
});
