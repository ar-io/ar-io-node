/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import {
  GenericContainer,
  StartedTestContainer,
  Network,
  StartedNetwork,
  Wait,
} from 'testcontainers';
import axios from 'axios';

import { getCoreContainer } from './utils.js';

const KUBO_IMAGE = 'ipfs/kubo:v0.32.1';
const SEED_CONTENT = 'hello-fleet-durability-peer-fetch';

// A tiny HTTP server (run on the built `core` image so no extra image is pulled)
// that plays a LYING peer: it answers every /ipfs/... request with 200 + a CAR
// that does NOT hash to the requested CID, and counts how many times it was
// asked so tests can prove (a) the fleet fell through past it, and (b) local-only
// requests never recurse to it.
const MALICIOUS_PEER_SCRIPT = `
const http = require('http');
let carHits = 0;
http.createServer((req, res) => {
  if (req.url.startsWith('/__count')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ carHits }));
    return;
  }
  if (req.url.startsWith('/ipfs/')) {
    carHits++;
    res.writeHead(200, { 'content-type': 'application/vnd.ipld.car' });
    res.end('not-a-valid-car-block-'.repeat(64));
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(3000, '0.0.0.0', () => console.log('malicious peer listening on 3000'));
`;

const extractCid = (execOutput: string): string => {
  const match = execOutput.match(/\bba[a-z2-7]{20,}\b/);
  if (match === null) {
    throw new Error(`could not parse CID from: ${execOutput}`);
  }
  return match[0];
};

// Heavy: builds the core image and starts 2 core + 2 kubo + 1 malicious-peer
// containers. Gated behind `test:e2e`. Proves fleet durability independent of
// public IPFS (kubos run --offline, so a 200 on the cold node can ONLY have come
// from a peer), trustless import (a lying peer is rejected), the holding flip
// (local-only 404 -> 200 after a fetch), and the recursion guard.
describe('IPFS peer-fetch durability layer', () => {
  let network: StartedNetwork;
  let kuboA: StartedTestContainer;
  let kuboB: StartedTestContainer;
  let coreA: StartedTestContainer;
  let coreB: StartedTestContainer;
  let malicious: StartedTestContainer;
  let coreAUrl: string;
  let coreBUrl: string;
  let maliciousUrl: string;
  let cid: string;
  let unheldCid: string;

  before(async () => {
    network = await new Network().start();

    // Two Kubo nodes, both --offline so they CANNOT reach public IPFS. The only
    // way cold kubo-b can obtain content is an HTTP CAR fetch from a peer gateway.
    const startKubo = (alias: string) =>
      new GenericContainer(KUBO_IMAGE)
        .withNetwork(network)
        .withNetworkAliases(alias)
        .withCommand(['daemon', '--offline'])
        .withWaitStrategy(Wait.forLogMessage(/Daemon is ready/))
        .withStartupTimeout(120_000)
        .start();

    [kuboA, kuboB] = await Promise.all([
      startKubo('kubo-a'),
      startKubo('kubo-b'),
    ]);

    // Seed CID X into kubo-a only.
    const add = await kuboA.exec([
      'sh',
      '-c',
      `echo -n "${SEED_CONTENT}" | ipfs add -q --cid-version=1`,
    ]);
    cid = extractCid(add.output);

    // A valid CID that was never added anywhere (for the recursion-guard test).
    const onlyHash = await kuboB.exec([
      'sh',
      '-c',
      `echo -n "never-added-to-any-node-xyz" | ipfs add -qn --cid-version=1`,
    ]);
    unheldCid = extractCid(onlyHash.output);

    // Build the core image from the worktree (includes the peer-fetch changes)
    // and tag it `core`; reused for both cores and the malicious peer.
    await getCoreContainer();

    const baseCoreEnv = {
      START_WRITERS: 'false',
      ADMIN_API_KEY: 'secret',
      IPFS_ENABLED: 'true',
      LOG_LEVEL: 'info',
    };

    coreA = await new GenericContainer('core')
      .withEnvironment({
        ...baseCoreEnv,
        IPFS_KUBO_URL: 'http://kubo-a:8080',
        IPFS_KUBO_API_URL: 'http://kubo-a:5001',
        // core-a only serves what it holds locally; no peer-fetch needed.
        IPFS_PEER_FETCH_ENABLED: 'false',
      })
      .withNetwork(network)
      .withNetworkAliases('core-a')
      .withExposedPorts(4000)
      .withWaitStrategy(Wait.forHttp('/ar-io/info', 4000))
      .withStartupTimeout(180_000)
      .start();

    malicious = await new GenericContainer('core')
      // The core image is distroless (no node on PATH); use the absolute path
      // its own entrypoint uses.
      .withEntrypoint(['/nodejs/bin/node', '-e', MALICIOUS_PEER_SCRIPT])
      .withNetwork(network)
      .withNetworkAliases('malicious')
      .withExposedPorts(3000)
      // forListeningPorts() does an internal port probe via a shell command the
      // distroless image can't run; wait on the readiness log line instead.
      .withWaitStrategy(Wait.forLogMessage(/malicious peer listening/))
      .withStartupTimeout(60_000)
      .start();

    coreB = await new GenericContainer('core')
      .withEnvironment({
        ...baseCoreEnv,
        IPFS_KUBO_URL: 'http://kubo-b:8080',
        IPFS_KUBO_API_URL: 'http://kubo-b:5001',
        IPFS_PEER_FETCH_ENABLED: 'true',
        // The lying peer is tried FIRST, then the honest core-a. A correct
        // result therefore also proves the untrusted peer is rejected safely.
        IPFS_PEER_FETCH_STATIC_PEERS:
          'http://malicious:3000,http://core-a:4000',
        IPFS_PEER_FETCH_TIMEOUT_MS: '20000',
      })
      .withNetwork(network)
      .withNetworkAliases('core-b')
      .withExposedPorts(4000)
      .withWaitStrategy(Wait.forHttp('/ar-io/info', 4000))
      .withStartupTimeout(180_000)
      .start();

    coreAUrl = `http://localhost:${coreA.getMappedPort(4000)}`;
    coreBUrl = `http://localhost:${coreB.getMappedPort(4000)}`;
    maliciousUrl = `http://localhost:${malicious.getMappedPort(3000)}`;
  });

  after(async () => {
    await coreB?.stop();
    await malicious?.stop();
    await coreA?.stop();
    await kuboB?.stop();
    await kuboA?.stop();
    await network?.stop();
  });

  const maliciousCarHits = async (): Promise<number> => {
    const res = await axios.get(`${maliciousUrl}/__count`);
    return res.data.carHits as number;
  };

  it('core-a holds and serves the seeded CID; core-b does not hold it yet', async () => {
    // core-a serves it (it holds it locally).
    const onA = await axios.get(`${coreAUrl}/ipfs/${cid}`, {
      responseType: 'text',
      validateStatus: () => true,
    });
    assert.equal(onA.status, 200);
    assert.equal(onA.data, SEED_CONTENT);

    // core-b, probed local-only, does NOT hold it yet → 404.
    const probeBefore = await axios.get(`${coreBUrl}/ipfs/${cid}`, {
      headers: { 'X-Ar-Io-Local-Only': 'true' },
      validateStatus: () => true,
    });
    assert.equal(probeBefore.status, 404);
  });

  it('core-b peer-fetches the CID from the fleet, past a lying peer, and serves correct bytes', async () => {
    const hitsBefore = await maliciousCarHits();

    const res = await axios.get(`${coreBUrl}/ipfs/${cid}`, {
      responseType: 'text',
      validateStatus: () => true,
    });

    // Correct bytes — even though kubo-b is offline (no public IPFS), so this
    // could ONLY have come from the fleet (core-a).
    assert.equal(res.status, 200);
    assert.equal(res.data, SEED_CONTENT);

    // The lying peer was tried first (its tampered CAR failed Kubo's import
    // verification) and the fleet fell through to the honest peer.
    const hitsAfter = await maliciousCarHits();
    assert.ok(
      hitsAfter > hitsBefore,
      'expected the malicious peer to have been tried and rejected',
    );
  });

  it('core-b now holds the CID: the local-only probe flips 404 → 200', async () => {
    const probeAfter = await axios.get(`${coreBUrl}/ipfs/${cid}`, {
      headers: { 'X-Ar-Io-Local-Only': 'true' },
      responseType: 'text',
      validateStatus: () => true,
    });
    assert.equal(probeAfter.status, 200);
    assert.equal(probeAfter.data, SEED_CONTENT);
    // The server honored local-only (echoed the marker).
    assert.equal(probeAfter.headers['x-ar-io-local-only'], 'true');
  });

  it('recursion guard: a local-only miss returns 404 and never contacts peers', async () => {
    const hitsBefore = await maliciousCarHits();

    const res = await axios.get(`${coreBUrl}/ipfs/${unheldCid}`, {
      headers: { 'X-Ar-Io-Local-Only': 'true' },
      validateStatus: () => true,
    });
    assert.equal(res.status, 404);

    // A local-only request must run tier 1 ONLY — no outbound peer fetch.
    const hitsAfter = await maliciousCarHits();
    assert.equal(hitsAfter, hitsBefore);
  });
});
