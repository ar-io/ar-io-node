/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The whole HTTP tier, with nothing standing in for anything.
 *
 * One gateway's sidecar publishes a band, that gateway's core serves it over
 * the real /ar-io/indexes routes, a second gateway's sidecar subscribes and
 * installs it, and the second gateway's core loads it through its collection
 * source and answers a lookup from it. If this passes, a data item ID resolved
 * on the first gateway resolves on the second without either being told
 * anything but the other's wallet.
 */
import { strict as assert } from 'node:assert';
import { describe, it, before, after } from 'node:test';
import crypto from 'node:crypto';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import express from 'express';

import { Publisher } from './publisher.js';
import { Subscriber } from './subscriber.js';
import { StateStore } from './state.js';
import { createKindRegistry } from './kinds/registry.js';
import { createIndexesRouter } from '../routes/indexes.js';
import { Cdb64RootTxIndex } from '../discovery/cdb64-root-tx-index.js';
import { PartitionedCdb64Writer } from '../lib/partitioned-cdb64-writer.js';
import { encodeCdb64Value } from '../lib/cdb64-encoding.js';
import { getSolanaAddress } from '../lib/httpsig.js';
import { toB64Url } from '../lib/encoding.js';
import { createTestLogger } from '../../test/test-logger.js';

const log = createTestLogger({ suite: 'index swarm end to end' });

describe('index swarm, end to end over HTTP', () => {
  let tempDir: string;
  let server: http.Server;
  let origin: string;
  let index: Cdb64RootTxIndex;

  /** Data item ID to the root transaction it lives in, as the index holds. */
  const entries = Array.from({ length: 500 }, (_unused, i) => ({
    dataItemId: crypto.createHash('sha256').update(`item-${i}`).digest(),
    rootTxId: crypto
      .createHash('sha256')
      .update(`root-${i % 17}`)
      .digest(),
  }));

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-e2e-'));
    const gatewayA = path.join(tempDir, 'gateway-a', 'indexes');
    const gatewayB = path.join(tempDir, 'gateway-b', 'indexes');
    const publishedDir = path.join(gatewayA, 'published');

    // --- Gateway A builds a band and its sidecar publishes it. ---
    const bandDir = path.join(publishedDir, 'root-tx-index', 'band-tip');
    const writer = new PartitionedCdb64Writer(bandDir);
    await writer.open();
    for (const entry of entries) {
      await writer.add(
        entry.dataItemId,
        encodeCdb64Value({ rootTxId: entry.rootTxId }),
      );
    }
    await writer.finalize();

    const wallet = crypto.generateKeyPairSync('ed25519');
    const observer = crypto.generateKeyPairSync('ed25519');
    const walletAddress = getSolanaAddress(wallet.publicKey);
    const observerAddress = getSolanaAddress(observer.publicKey);

    await new Publisher({
      log,
      state: new StateStore({
        log,
        filePath: path.join(gatewayA, 'state.json'),
      }),
      kinds: createKindRegistry({ log }),
      signer: {
        privateKey: observer.privateKey,
        keyId: observerAddress,
        wallet: walletAddress,
      },
      publish: [{ name: 'root-tx-index', kind: 'cdb64-root-tx' }],
      publishedDir,
      blobsDir: path.join(publishedDir, 'blobs'),
      publicationFile: path.join(publishedDir, 'publication.json'),
      ttlMs: 86_400_000,
      supersedeGraceMs: 0,
    }).scanOnce();

    // --- Gateway A's core serves it, on the real routes. ---
    const app = express();
    app.use(createIndexesRouter({ log, publishedDir }));
    server = http.createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    assert(address !== null && typeof address === 'object');
    origin = `http://127.0.0.1:${address.port}`;

    // --- Gateway B's sidecar subscribes, knowing only A's wallet. ---
    // The registry is the one stand-in, because a real one needs a
    // registered gateway on chain. It answers exactly what the chain would.
    await new Subscriber({
      log,
      state: new StateStore({
        log,
        filePath: path.join(gatewayB, 'state.json'),
      }),
      kinds: createKindRegistry({ log }),
      registry: {
        lookup: async (w) =>
          w === walletAddress
            ? { wallet: w, observerAddress, url: origin, status: 'joined' }
            : undefined,
      },
      subscribe: [{ publisher: walletAddress, name: 'root-tx-index' }],
      trustedPublishers: [],
      incomingDir: path.join(gatewayB, 'incoming'),
      installedDir: path.join(gatewayB, 'installed'),
      fetchTimeoutMs: 10_000,
      downloadConcurrency: 4,
      supersedeGraceMs: 0,
    }).pollOnce();

    // --- Gateway B's core loads what was installed. ---
    index = new Cdb64RootTxIndex({
      log,
      sources: [path.join(gatewayB, 'installed', 'root-tx-index')],
      watch: false,
    });
  });

  after(async () => {
    await index?.close();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('resolves every published data item on the subscribing gateway', async () => {
    let resolved = 0;
    for (const entry of entries) {
      const result = await index.getRootTx(toB64Url(entry.dataItemId));
      assert.equal(
        result?.rootTxId,
        toB64Url(entry.rootTxId),
        `item ${toB64Url(entry.dataItemId)} resolves to the right root`,
      );
      resolved++;
    }
    assert.equal(resolved, entries.length);
  });

  it('does not resolve an ID that was never published', async () => {
    const stranger = crypto.randomBytes(32);
    assert.equal(await index.getRootTx(toB64Url(stranger)), undefined);
  });
});
