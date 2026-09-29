/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it, after, beforeEach, afterEach, mock } from 'node:test';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { default as Arweave } from 'arweave';

import { ArweaveCompositeClient } from './composite-client.js';
import { toB64Url } from '../lib/encoding.js';
import { UniformFailureSimulator } from '../lib/chaos.js';
import { ArweavePeerManager } from '../peers/arweave-peer-manager.js';
import * as config from '../config.js';
import * as metrics from '../metrics.js';
import log from '../log.js';

describe('ArweaveCompositeClient', () => {
  // TEMPORARY DIAGNOSTIC — remove once the leak is identified.
  //
  // This file's assertions all pass in ~350ms, then its process fails to exit,
  // so node's runner waits on the child forever. Before --test-timeout was
  // added that silently consumed the job's full 60-minute budget and skipped
  // the `images` job that publishes release containers. A lingering handle
  // emits nothing by definition, which is why four occurrences produced no
  // usable logs.
  //
  // It does not reproduce locally: this file passes alone on Node 20.11.1 and
  // 22.13.0, passes paired with the file that follows it, and the full
  // `test:ci` completes under c8 and pinned to two cores. It only leaks inside
  // the full suite on CI, so asking the process what it still holds is the
  // remaining way to identify it.
  after(async () => {
    const immediate = process.getActiveResourcesInfo();
    // close() is asynchronous: a handle can still be listed while it is being
    // torn down. Sample again after the loop has had a chance to reap them, so
    // a genuine leak is distinguishable from one merely in flight.
    await new Promise((r) => setTimeout(r, 250));
    const settled = process.getActiveResourcesInfo();
    const count = (a: string[]) =>
      a.reduce<Record<string, number>>(
        (m, k) => ({ ...m, [k]: (m[k] ?? 0) + 1 }),
        {},
      );

    console.log(
      `[leak-probe] immediate=${JSON.stringify(count(immediate))} settled=${JSON.stringify(count(settled))}`,
    );
  });

  let mockBlockStore: any;
  let mockTxStore: any;
  let mockPeerManager: any;
  let failureSimulator: UniformFailureSimulator;
  let arweave: Arweave;
  let originalSetInterval: typeof setInterval;
  let mockSetInterval: any;
  let createdClients: ArweaveCompositeClient[];

  beforeEach(() => {
    // Mock setInterval to prevent timers from starting
    originalSetInterval = global.setInterval;
    mockSetInterval = mock.fn(() => ({ unref: mock.fn() }));
    global.setInterval = mockSetInterval;
    createdClients = [];

    mockBlockStore = {
      get: mock.fn(),
      getByHeight: mock.fn(),
      set: mock.fn(),
      delByHeight: mock.fn(),
      delByHash: mock.fn(),
    };

    mockTxStore = {
      get: mock.fn(),
      set: mock.fn(),
      del: mock.fn(),
    };

    mockPeerManager = {
      getPeers: mock.fn(() => ({})),
      getPeerUrls: mock.fn((category?: string) => {
        if (category === 'getChunk') {
          return ['http://peer1.example.com', 'http://peer2.example.com'];
        }
        return [];
      }),
      selectPeers: mock.fn((category: string, count: number) => {
        if (category === 'getChunk') {
          return ['http://peer1.example.com', 'http://peer2.example.com'].slice(
            0,
            count,
          );
        }
        if (category === 'postChunk') {
          return [
            'http://tip-2.arweave.xyz',
            'http://tip-3.arweave.xyz',
            'http://tip-4.arweave.xyz',
          ].slice(0, count);
        }
        return [];
      }),
      isPreferredChunkPostPeer: mock.fn(() => false),
      reportSuccess: mock.fn(),
      reportFailure: mock.fn(),
      startAutoRefresh: mock.fn(),
      stopAutoRefresh: mock.fn(),
      refreshPeers: mock.fn(),
      initializeDnsResolution: mock.fn(),
      destroy: mock.fn(),
    };

    failureSimulator = new UniformFailureSimulator({ failureRate: 0 });
    arweave = Arweave.init({});
  });

  afterEach(() => {
    // Guarantee client teardown even when an assertion throws before an
    // explicit cleanup, so timers/queues never leak into later tests.
    for (const client of createdClients) {
      try {
        client.cleanup();
      } catch {
        // best-effort teardown
      }
    }
    // Restore setInterval
    global.setInterval = originalSetInterval;
    mock.restoreAll();
  });

  // Helper function to create a client with mocked network dependencies.
  // Every client is registered for teardown in afterEach.
  const createTestClient = (
    options: { preferredChunkGetUrls?: string[] } = {},
  ) => {
    const client = new ArweaveCompositeClient({
      log,
      arweave,
      trustedNodeUrl: 'https://test.example.com',
      blockStore: mockBlockStore,
      txStore: mockTxStore,
      failureSimulator,
      peerManager: mockPeerManager,
      requestTimeout: 100, // Short timeout for tests
      maxConcurrentRequests: 1,
      ...options,
    });
    createdClients.push(client);
    return client;
  };

  describe('AbortSignal threading', () => {
    // Note: setInterval is mocked in beforeEach so the rate-limit bucket
    // filler never runs. trustedNodeRequestBucket therefore starts at 0,
    // which lets us deterministically exercise the bucket-wait code path.

    it('rejects with AbortError when caller aborts while bucket is empty (the pivotal regression case)', async () => {
      const client = createTestClient();

      // Replace trustedNodeAxios with a mock so we can detect whether it was
      // ever called. Under the bug, an aborted caller would still wait for
      // bucket tokens and eventually issue the HTTP request.
      const axiosMock = mock.fn(() => Promise.resolve({ data: 'unused' }));
      (client as any).trustedNodeAxios = axiosMock;

      // Bucket is empty — confirm.
      assert.equal((client as any).trustedNodeRequestBucket, 0);

      const controller = new AbortController();

      // Fire the request, then abort almost immediately. The bucket will
      // never have tokens (filler is mocked off), so the only way for the
      // request to terminate is by honoring the abort signal.
      const requestPromise = client.getTxOffset(
        'test-tx-id',
        controller.signal,
      );

      // Give the worker a tick to enter the bucket-wait loop, then abort.
      await new Promise((resolve) => setImmediate(resolve));
      controller.abort();

      await assert.rejects(requestPromise, (error: any) => {
        return (
          error.name === 'AbortError' ||
          error.message?.includes('aborted') ||
          error.message?.includes('Aborted')
        );
      });

      // The HTTP call must NOT have been made — we aborted before any
      // tokens were available.
      assert.equal(
        axiosMock.mock.callCount(),
        0,
        'trustedNodeAxios should not have been called for an aborted request',
      );
    });

    it('rejects immediately when signal is already aborted at call time', async () => {
      const client = createTestClient();
      const axiosMock = mock.fn(() => Promise.resolve({ data: 'unused' }));
      (client as any).trustedNodeAxios = axiosMock;

      const controller = new AbortController();
      controller.abort();

      await assert.rejects(
        client.getTxOffset('test-tx-id', controller.signal),
        (error: any) => error.name === 'AbortError',
      );
      await assert.rejects(
        client.getTxField('test-tx-id', 'data_root', controller.signal),
        (error: any) => error.name === 'AbortError',
      );

      assert.equal(
        axiosMock.mock.callCount(),
        0,
        'No HTTP call should be made for a pre-aborted request',
      );
    });

    it('passes signal through to axios so the HTTP request itself is cancellable', async () => {
      const client = createTestClient();
      // Manually pre-fill the bucket so the request can proceed past the
      // rate-limit gate without waiting on the (mocked) filler.
      (client as any).trustedNodeRequestBucket = 10;

      const receivedConfigs: any[] = [];
      (client as any).trustedNodeAxios = mock.fn((cfg: any) => {
        receivedConfigs.push(cfg);
        return Promise.resolve({ data: { offset: '1', size: '2' } });
      });

      const controller = new AbortController();
      await client.getTxOffset('test-tx-id', controller.signal);

      assert.equal(receivedConfigs.length, 1);
      assert.ok(
        receivedConfigs[0].signal instanceof AbortSignal,
        'axios call should receive an AbortSignal in its config',
      );
      assert.equal(receivedConfigs[0].signal, controller.signal);
    });

    it('one caller aborting getChunkByAny does not abort the shared cached fetch', async () => {
      const client = createTestClient();

      // Replace peerGetChunk with a slow mock so the cache promise stays
      // pending long enough for both callers to share it.
      let resolveChunk!: (chunk: any) => void;
      const sharedChunk = {
        tx_path: Buffer.from(''),
        data_root: Buffer.from(''),
        data_size: 1000,
        data_path: Buffer.from(''),
        offset: 0,
        hash: Buffer.from(''),
        chunk: Buffer.from('payload'),
      };
      let peerGetChunkCalls = 0;
      (client as any).peerGetChunk = mock.fn(() => {
        peerGetChunkCalls++;
        return new Promise((resolve) => {
          resolveChunk = resolve;
        });
      });

      const params = {
        txSize: 1000,
        absoluteOffset: 0,
        dataRoot: 'test-root',
        relativeOffset: 0,
      };

      const aborterA = new AbortController();
      const aborterB = new AbortController();

      // Two concurrent callers — they should share the same underlying
      // cached promise (peerGetChunk should only be invoked once).
      const promiseA = client.getChunkByAny(params, aborterA.signal);
      const promiseB = client.getChunkByAny(params, aborterB.signal);

      // Yield so promise initialization runs.
      await new Promise((resolve) => setImmediate(resolve));

      // Caller A bails out — caller B should still be able to receive the
      // chunk once the underlying fetch completes.
      aborterA.abort();

      await assert.rejects(
        promiseA,
        (error: any) => error.name === 'AbortError',
      );

      // Now resolve the underlying fetch. Caller B should still get the chunk.
      resolveChunk(sharedChunk);

      const result = await promiseB;
      assert.equal(result.chunk.toString(), 'payload');

      // The underlying fetch ran exactly once thanks to dedup.
      assert.equal(peerGetChunkCalls, 1);
    });

    it('honors abort during the bucket-wait loop even after the bucket later refills', async () => {
      const client = createTestClient();
      const axiosMock = mock.fn(() => Promise.resolve({ data: 'unused' }));
      (client as any).trustedNodeAxios = axiosMock;

      // Bucket is empty — request will spin in the bucket-wait loop.
      assert.equal((client as any).trustedNodeRequestBucket, 0);

      const controller = new AbortController();
      const requestPromise = client.getTxField(
        'test-tx-id',
        'data_root',
        controller.signal,
      );

      // Let the worker enter the wait loop.
      await new Promise((resolve) => setImmediate(resolve));

      // Abort first, then refill the bucket. The worker must still bail
      // out because the abort signal was raised before/during its wait,
      // not silently consume a token and proceed with HTTP.
      controller.abort();
      (client as any).trustedNodeRequestBucket = 100;

      await assert.rejects(requestPromise, (error: any) => {
        return error.name === 'AbortError';
      });
      assert.equal(
        axiosMock.mock.callCount(),
        0,
        'trustedNodeAxios should not run when the request was aborted in the bucket-wait loop',
      );
    });
  });

  describe('Preferred Chunk GET URLs', () => {
    it('should initialize with preferred chunk GET URLs', () => {
      const preferredChunkGetUrls = [
        'http://peer1.example.com',
        'http://peer2.example.com',
      ];

      const client = createTestClient({ preferredChunkGetUrls });

      // Test that peer manager's getPeerUrls is called correctly
      const getChunkPeers = mockPeerManager.getPeerUrls('getChunk');
      assert.equal(getChunkPeers.length, 2);
      assert.equal(getChunkPeers[0], 'http://peer1.example.com');
      assert.equal(getChunkPeers[1], 'http://peer2.example.com');
    });

    it('should only affect chunk GET peers, not chain peers', () => {
      const preferredChunkGetUrls = [
        'http://peer1.example.com',
        'http://peer2.example.com',
      ];

      const client = createTestClient({ preferredChunkGetUrls });

      // Test that different peer categories return different results
      const getChunkPeers = mockPeerManager.getPeerUrls('getChunk');
      const chainPeers = mockPeerManager.getPeerUrls('chain');
      const postChunkPeers = mockPeerManager.getPeerUrls('postChunk');

      // Only chunk GET peers should be initialized with preferred URLs
      assert.equal(getChunkPeers.length, 2);
      assert.equal(chainPeers.length, 0);
      // POST peers now have defaults (tip-2, tip-3, tip-4)
      assert.equal(postChunkPeers.length, 0);
    });

    it('should work without preferred chunk GET URLs', () => {
      // Update mock to return empty array when no preferred URLs
      mockPeerManager.getPeerUrls = mock.fn((category?: string) => {
        return [];
      });

      const client = createTestClient();

      // Test that no peers are returned when none are configured
      const getChunkPeers = mockPeerManager.getPeerUrls('getChunk');
      assert.equal(getChunkPeers.length, 0);
    });

    it('should select peers from preferred URLs when available', () => {
      const preferredChunkGetUrls = [
        'http://peer1.example.com',
        'http://peer2.example.com',
      ];

      const client = createTestClient({ preferredChunkGetUrls });

      const selectedPeers = client.peerManager.selectPeers('getChunk', 1);

      assert.equal(selectedPeers.length, 1);
      assert.ok(preferredChunkGetUrls.includes(selectedPeers[0]));

      // Verify that peerManager.selectPeers was called correctly
      assert.ok(mockPeerManager.selectPeers.mock.calls.length > 0);
      const call =
        mockPeerManager.selectPeers.mock.calls[
          mockPeerManager.selectPeers.mock.calls.length - 1
        ];
      assert.equal(call.arguments[0], 'getChunk');
      assert.equal(call.arguments[1], 1);
    });

    it('should handle empty peer selection gracefully', () => {
      // Update mock to return empty arrays for selectPeers
      mockPeerManager.selectPeers = mock.fn(() => []);

      const client = createTestClient();

      const selectedPeers = client.peerManager.selectPeers('getChunk', 5);

      assert.equal(selectedPeers.length, 0);
    });

    it('should not use trusted node for chunk retrieval', async () => {
      const preferredChunkGetUrls = ['http://peer1.example.com'];

      const client = createTestClient({ preferredChunkGetUrls });

      // Mock peerGetChunk to fail so we can verify trusted node is not used
      const originalPeerGetChunk = (client as any).peerGetChunk;
      (client as any).peerGetChunk = mock.fn(() => {
        throw new Error('No peers available');
      });

      try {
        await client.getChunkByAny({
          txSize: 1000,
          absoluteOffset: 0,
          dataRoot: 'test-root',
          relativeOffset: 0,
        });
        assert.fail('Should have thrown an error');
      } catch (error: any) {
        // Should fail with peer error, not try trusted node
        assert.ok(
          error.message.includes(
            'Unable to fetch chunk from any available peers',
          ),
        );
        assert.ok(!error.message.includes('trusted node'));
      }

      // Restore original method
      (client as any).peerGetChunk = originalPeerGetChunk;
    });
  });

  // Exercises the real axios POST path (no mocking) against a loopback server so
  // the validateStatus wiring is covered end-to-end. An arweave node replies 200
  // when it will store the chunk long-term and 303 ("temporary") when it accepted
  // and persisted the chunk into its disk pool but is not the long-term home for
  // that offset. Both are successful propagations; everything else is a failure.
  describe('postChunkToPeer status handling', () => {
    let server: http.Server;
    let baseUrl: string;
    let respond: (res: http.ServerResponse) => void;

    beforeEach(async () => {
      respond = (res) => res.writeHead(200).end();
      server = http.createServer((_req, res) => respond(res));
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve()),
      );
      const { port } = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${port}`;
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const post = (client: any) =>
      client.postChunkToPeer({
        peer: baseUrl,
        chunk: {} as any,
        abortTimeout: 1000,
        responseTimeout: 1000,
        headers: {},
      });

    it('treats HTTP 200 as a successful, non-temporary post', async () => {
      respond = (res) => res.writeHead(200).end();
      const client = createTestClient();
      const result = await post(client);
      assert.equal(result.success, true);
      assert.equal(result.statusCode, 200);
      assert.equal(result.temporary, false);
    });

    it('treats HTTP 303 ("temporary") as a successful post flagged temporary', async () => {
      // 303 with no Location header, mirroring ar_disk_pool:add_chunk/6 ->
      // {303, #{}, <<>>} (there is nothing to redirect to).
      respond = (res) => res.writeHead(303).end();
      const client = createTestClient();
      const result = await post(client);
      assert.equal(result.success, true);
      assert.equal(result.statusCode, 303);
      assert.equal(result.temporary, true);
    });

    it('treats HTTP 400 as a failed post', async () => {
      respond = (res) => res.writeHead(400).end();
      const client = createTestClient();
      const result = await post(client);
      assert.equal(result.success, false);
      assert.equal(result.statusCode, 400);
    });

    it('treats HTTP 500 as a failed post', async () => {
      respond = (res) => res.writeHead(500).end();
      const client = createTestClient();
      const result = await post(client);
      assert.equal(result.success, false);
      assert.equal(result.statusCode, 500);
    });

    // The failure counter is what an operator reads when a peer starts
    // rejecting chunks. Without a reason, a peer refusing the chunk (400), one
    // rate-limiting us (429) and one we cannot reach are indistinguishable,
    // and each calls for a different response.
    const failReasonCount = async (endpoint: string, reason: string) => {
      const { values } = await metrics.arweaveChunkPostCounter.get();
      const sample = values.find(
        (v: any) =>
          v.labels.endpoint === endpoint &&
          v.labels.status === 'fail' &&
          v.labels.reason === reason,
      );
      return sample?.value ?? 0;
    };

    it('labels a peer-rejected post with the peer’s status code', async () => {
      respond = (res) => res.writeHead(429).end();
      const client = createTestClient();
      const before = await failReasonCount(baseUrl, '429');
      await post(client);
      assert.equal(await failReasonCount(baseUrl, '429'), before + 1);
    });

    // The abort deadline is normally the LOWER of the two, so this is the common
    // timeout path. AbortSignal.timeout() surfaces as ERR_CANCELED, which would
    // otherwise be reported as a caller cancellation — and aggregateStatusCode()
    // turns that into 499 (Client Closed Request), blaming the uploader for our
    // own deadline.
    it('reports our own abort deadline as a timeout, not a cancellation', async () => {
      respond = () => undefined; // never answer
      const client: any = createTestClient();
      const before = await failReasonCount(baseUrl, 'timeout');
      const result = await client.postChunkToPeer({
        peer: baseUrl,
        chunk: {} as any,
        abortTimeout: 50, // fires first
        responseTimeout: 5000,
        headers: {},
      });
      assert.equal(result.success, false);
      assert.equal(result.timedOut, true);
      assert.equal(result.canceled, false);
      assert.equal(await failReasonCount(baseUrl, 'timeout'), before + 1);
    });

    it('labels accepted posts with the status the peer returned', async () => {
      const successReasonCount = async (endpoint: string, reason: string) => {
        const { values } = await metrics.arweaveChunkPostCounter.get();
        const s = values.find(
          (v: any) =>
            v.labels.endpoint === endpoint &&
            v.labels.status === 'success' &&
            v.labels.reason === reason,
        );
        return s?.value ?? 0;
      };
      respond = (res) => res.writeHead(303).end();
      const client = createTestClient();
      const before = await successReasonCount(baseUrl, '303');
      await post(client);
      assert.equal(await successReasonCount(baseUrl, '303'), before + 1);
    });

    it('labels a post the peer never answers as a timeout, not a status code', async () => {
      // Never respond: the request must hit responseTimeout rather than any
      // HTTP status, so the reason has to come from the error, not a response.
      respond = () => undefined;
      const client: any = createTestClient();
      const before = await failReasonCount(baseUrl, 'timeout');
      const result = await client.postChunkToPeer({
        peer: baseUrl,
        chunk: {} as any,
        abortTimeout: 5000,
        responseTimeout: 50,
        headers: {},
      });
      assert.equal(result.success, false);
      assert.equal(result.timedOut, true);
      assert.equal(result.statusCode, undefined);
      assert.equal(await failReasonCount(baseUrl, 'timeout'), before + 1);
    });
  });

  // Verifies the CHUNK_POST_CONTINUE_PAST_THRESHOLD behavior against real
  // loopback peers: by default the broadcast stops once the success threshold is
  // met, and with continuePastThreshold it keeps posting to every peer.
  describe('broadcastChunk propagation width', () => {
    let servers: http.Server[] = [];
    let deadServers: http.Server[] = [];
    let urls: string[] = [];

    const startServers = async (count: number, status = 200) => {
      servers = [];
      urls = [];
      for (let i = 0; i < count; i++) {
        const s = http.createServer((_req, res) => res.writeHead(status).end());
        await new Promise<void>((resolve) =>
          s.listen(0, '127.0.0.1', () => resolve()),
        );
        const { port } = s.address() as AddressInfo;
        servers.push(s);
        urls.push(`http://127.0.0.1:${port}`);
      }
      mockPeerManager.getPeerUrls = mock.fn(() => urls);
      mockPeerManager.selectPeers = mock.fn(() => urls);
      mockPeerManager.isPreferredChunkPostPeer = mock.fn(() => false);
    };

    afterEach(async () => {
      // close() alone leaves the handle alive until every connection ends, and
      // the dead peers here are deliberately destroying sockets mid-request, so
      // some are always in flight when a test finishes. Drop the connections
      // first, then wait for the listener itself.
      const all = [...servers, ...deadServers];
      for (const s of all) {
        s.closeAllConnections?.();
      }
      await Promise.all(
        all.map(
          (s) => new Promise<void>((resolve) => s.close(() => resolve())),
        ),
      );
      // `servers` was never cleared, so each afterEach re-closed every server
      // from every earlier test in this describe.
      servers = [];
      deadServers = [];
    });

    const broadcast = (client: any, continuePastThreshold: boolean) =>
      client.broadcastChunk({
        chunk: {} as any,
        originAndHopsHeaders: {},
        chunkPostMinSuccessCount: 2,
        chunkPostMinPreferredSuccessCount: 0,
        continuePastThreshold,
      });

    // Reserve real ports with listeners that immediately drop every connection,
    // so a POST to them fails fast (ECONNRESET) while the port stays bound.
    // (Closing the listener to "free" the port would let the OS reassign it to a
    // subsequently-created live server, silently turning a dead peer live.)
    // The listeners are tracked in deadServers and closed in afterEach.
    const makeDeadUrls = async (count: number) => {
      const dead: string[] = [];
      for (let i = 0; i < count; i++) {
        const s = http.createServer();
        s.on('connection', (socket) => socket.destroy());
        await new Promise<void>((resolve) =>
          s.listen(0, '127.0.0.1', () => resolve()),
        );
        const { port } = s.address() as AddressInfo;
        deadServers.push(s);
        dead.push(`http://127.0.0.1:${port}`);
      }
      return dead;
    };

    it('stops at the success threshold by default (fewer than all peers)', async () => {
      await startServers(6, 200);
      const client = createTestClient();
      const result = await broadcast(client, false);
      assert.ok(
        result.successCount >= 2,
        `expected at least the threshold, got ${result.successCount}`,
      );
      assert.ok(
        result.successCount < urls.length,
        `expected fewer than all ${urls.length} peers, got ${result.successCount}`,
      );
    });

    it('posts to every peer when continuePastThreshold is true', async () => {
      await startServers(6, 200);
      const client = createTestClient();
      const result = await broadcast(client, true);
      assert.equal(result.successCount, urls.length);
    });

    // successCount alone cannot tell "peers that will keep this chunk" from
    // "peers that parked it in a disk pool they will drain", because a 303 is
    // counted as a success (correctly — it is still propagation). The split is
    // reported so callers can see which they got.
    it('splits successes into long-term (200) and temporary (303)', async () => {
      await startServers(2, 200);
      const longTerm = [...urls];
      // startServers resets `servers`/`urls`, so hold on to the first batch and
      // restore both lists afterwards — otherwise afterEach never closes those
      // listeners and this file leaks handles.
      const longTermServers = [...servers];
      await startServers(3, 303);
      const temporary = [...urls];
      servers = [...longTermServers, ...servers];
      urls = [...longTerm, ...temporary];
      mockPeerManager.getPeerUrls = mock.fn(() => urls);
      mockPeerManager.selectPeers = mock.fn(() => urls);

      const client = createTestClient();
      const result = await broadcast(client, true);

      assert.equal(result.successCount, urls.length);
      assert.equal(result.longTermSuccessCount, longTerm.length);
      assert.equal(result.temporarySuccessCount, temporary.length);
      assert.equal(
        result.longTermSuccessCount + result.temporarySuccessCount,
        result.successCount,
      );
    });

    it('counts a broadcast accepted only into disk pools as entirely temporary', async () => {
      await startServers(4, 303);
      const client = createTestClient();
      const result = await broadcast(client, true);

      assert.equal(result.successCount, urls.length);
      assert.equal(result.temporarySuccessCount, urls.length);
      assert.equal(result.longTermSuccessCount, 0);
    });

    it('bails out of the dead peer tail in continuePastThreshold mode', async () => {
      const deadUrls = await makeDeadUrls(25);
      // Three live peers first, then a long dead tail.
      await startServers(3, 200);
      const live = [...urls];
      urls = [...live, ...deadUrls];
      mockPeerManager.getPeerUrls = mock.fn(() => urls);
      mockPeerManager.selectPeers = mock.fn(() => urls);

      const client = createTestClient();
      const result = await broadcast(client, true);

      // All live peers were posted to...
      assert.equal(result.successCount, live.length);
      // ...but the dead tail was bailed out of after roughly the configured
      // consecutive-failure limit, not merely "fewer than all 25". The bound is
      // CHUNK_POST_MAX_CONSECUTIVE_FAILURES plus at most (concurrency - 1) peers
      // already in flight when the guard trips.
      const maxDeadAttempts =
        config.CHUNK_POST_MAX_CONSECUTIVE_FAILURES +
        config.CHUNK_POST_PEER_CONCURRENCY;
      assert.ok(
        result.failureCount <= maxDeadAttempts,
        `expected to bail within ${maxDeadAttempts} dead attempts (limit ` +
          `${config.CHUNK_POST_MAX_CONSECUTIVE_FAILURES} + concurrency ` +
          `${config.CHUNK_POST_PEER_CONCURRENCY}), got ${result.failureCount}`,
      );
    });

    it('still seeds through a dead prefix before the threshold is met', async () => {
      // Dead peers FIRST, then live peers. The dead-tail guard must NOT bail
      // before the success threshold is reached, otherwise a run of dead peers
      // early in the list would stop us from reaching healthy peers that can
      // satisfy the threshold. (Regression guard for the CodeRabbit finding.)
      const deadUrls = await makeDeadUrls(8);
      await startServers(3, 200);
      const live = [...urls];
      urls = [...deadUrls, ...live];
      mockPeerManager.getPeerUrls = mock.fn(() => urls);
      mockPeerManager.selectPeers = mock.fn(() => urls);

      const client = createTestClient();
      const result = await broadcast(client, true);

      // Despite 8 dead peers ahead of them, all live peers were reached and the
      // threshold (2) was satisfied — the guard did not bail during seeding.
      assert.ok(
        result.successCount >= 2,
        `expected the threshold to be met through the dead prefix, got ${result.successCount}`,
      );
      assert.equal(result.successCount, live.length);
    });
  });

  describe('getData', () => {
    const BASE_URL = 'https://test.example.com';

    /** A client whose trusted node answers /data and /data_size as given. */
    const clientAnswering = (
      data: { status: number; data: unknown },
      dataSize: { status: number; data: unknown },
    ) => {
      const client = createTestClient();
      (client as any).trustedNodeRequestBucket = 10;
      (client as any).trustedNodeAxios = mock.fn(
        async (request: { url: string }) => ({
          ...(request.url.endsWith('/data_size') ? dataSize : data),
          config: { baseURL: BASE_URL },
        }),
      );
      return client;
    };

    const readAll = async (stream: NodeJS.ReadableStream) => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk as Buffer));
      }
      return Buffer.concat(chunks);
    };

    const payload = Buffer.from('hello world');

    it('serves a mined transaction and lets later end listeners run', async () => {
      // axios parses the plain-number /data_size body as JSON.
      const client = clientAnswering(
        { status: 200, data: toB64Url(payload) },
        { status: 200, data: payload.length },
      );

      const result = await client.getData({ id: 'mined-tx' });
      let laterEndListenerRan = false;
      result.stream.on('end', () => {
        laterEndListenerRan = true;
      });

      assert.equal(result.size, payload.length);
      assert.deepEqual(await readAll(result.stream), payload);
      assert.equal(laterEndListenerRan, true);
    });

    it('serves the requested region of a mined transaction', async () => {
      const client = clientAnswering(
        { status: 200, data: toB64Url(payload) },
        { status: 200, data: String(payload.length) },
      );

      const result = await client.getData({
        id: 'mined-tx',
        region: { offset: 6, size: 5 },
      });

      assert.equal(result.size, 5);
      assert.equal((await readAll(result.stream)).toString(), 'world');
    });

    it('keeps later end listeners running when a region size is not finite', async () => {
      // Recording NaN would throw from inside the 'end' listener, and a
      // throwing listener stops the ones registered after it.
      const client = clientAnswering(
        { status: 200, data: toB64Url(payload) },
        { status: 200, data: payload.length },
      );

      const result = await client.getData({
        id: 'mined-tx',
        region: { offset: 0, size: Number.NaN },
      });
      let laterEndListenerRan = false;
      result.stream.on('end', () => {
        laterEndListenerRan = true;
      });
      await readAll(result.stream);

      assert.equal(laterEndListenerRan, true);
    });

    it('rejects a transaction the node reports as pending', async () => {
      // An unmined transaction: the node answers 202 with the text "Pending"
      // on both routes. Serving it would yield junk bytes and a NaN size.
      const client = clientAnswering(
        { status: 202, data: 'Pending' },
        { status: 202, data: 'Pending' },
      );

      await assert.rejects(
        client.getData({ id: 'pending-tx' }),
        /Transaction data unavailable \(data 202, data_size 202\)/,
      );
    });

    it('rejects a size that is not a non-negative integer', async () => {
      const client = clientAnswering(
        { status: 200, data: toB64Url(payload) },
        { status: 200, data: 'not-a-number' },
      );

      await assert.rejects(
        client.getData({ id: 'mined-tx' }),
        /Invalid transaction data size: not-a-number/,
      );
    });

    it('rejects data whose length differs from data_size', async () => {
      const client = clientAnswering(
        { status: 200, data: toB64Url(payload) },
        { status: 200, data: payload.length + 1 },
      );

      await assert.rejects(
        client.getData({ id: 'mined-tx' }),
        /Transaction data is 11 bytes but data_size is 12/,
      );
    });
  });
});
