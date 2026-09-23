/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The index byte routes are the metered tier, so they must actually spend
 * rate-limit tokens. The shared limiter helper is gated on
 * ENABLE_RATE_LIMITER, read when config first loads, so it is set before the
 * modules are imported. The test runner gives each file its own process,
 * which keeps this from leaking into any other suite.
 */
import { strict as assert } from 'node:assert';
import { describe, it, before, after } from 'node:test';
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import express from 'express';
import request from 'supertest';

process.env.ENABLE_RATE_LIMITER = 'true';

describe('/ar-io/indexes rate limiting', () => {
  let tempDir: string;
  let app: express.Express;
  let rateLimiter: any;
  let fileName: string;
  let fileSize: number;

  before(async () => {
    const { createIndexesRouter } = await import('./indexes.js');
    const { MemoryRateLimiter } = await import(
      '../limiter/memory-rate-limiter.js'
    );
    const { Publisher } = await import('../index-swarm/publisher.js');
    const { StateStore } = await import('../index-swarm/state.js');
    const { createKindRegistry } = await import(
      '../index-swarm/kinds/registry.js'
    );
    const { PartitionedCdb64Writer } = await import(
      '../lib/partitioned-cdb64-writer.js'
    );
    const { encodeCdb64Value } = await import('../lib/cdb64-encoding.js');
    const { getSolanaAddress } = await import('../lib/httpsig.js');
    const { parseIndexPublication } = await import(
      '../lib/index-publication.js'
    );
    const { createTestLogger } = await import('../../test/test-logger.js');
    const log = createTestLogger({ suite: 'indexes rate limit' });

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'indexes-rl-'));
    const publishedDir = path.join(tempDir, 'published');
    const writer = new PartitionedCdb64Writer(
      path.join(publishedDir, 'root-tx-index', 'band-a'),
    );
    await writer.open();
    for (let i = 0; i < 400; i++) {
      await writer.add(
        crypto.createHash('sha256').update(`k${i}`).digest(),
        encodeCdb64Value({ rootTxId: crypto.randomBytes(32) }),
      );
    }
    await writer.finalize();

    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    await new Publisher({
      log,
      state: new StateStore({ log, filePath: path.join(tempDir, 's.json') }),
      kinds: createKindRegistry({ log }),
      signer: {
        privateKey,
        keyId: getSolanaAddress(publicKey),
        wallet: getSolanaAddress(publicKey),
      },
      publish: [{ name: 'root-tx-index', kind: 'cdb64-root-tx' }],
      publishedDir,
      blobsDir: path.join(publishedDir, 'blobs'),
      publicationFile: path.join(publishedDir, 'publication.json'),
      ttlMs: 86_400_000,
      supersedeGraceMs: 0,
    }).scanOnce();

    const doc = parseIndexPublication(
      await fs.readFile(path.join(publishedDir, 'publication.json')),
    );
    const partition = doc.indexes[0].bands[0].files
      .filter((f) => f.name.endsWith('.cdb'))
      .sort((a, b) => b.size - a.size)[0];
    fileName = partition.name;
    fileSize = partition.size;

    // An IP bucket that holds one copy of the file and not two, and refills
    // too slowly to matter within the test.
    const tokensForFile = Math.ceil(fileSize / 1024);
    rateLimiter = new MemoryRateLimiter({
      resourceCapacity: tokensForFile * 100,
      resourceRefillRate: 0.001,
      ipCapacity: Math.ceil(tokensForFile * 1.5),
      ipRefillRate: 0.001,
      limitsEnabled: true,
      ipAllowlist: [],
      capacityMultiplier: 10,
    });

    app = express();
    app.use(createIndexesRouter({ log, publishedDir, rateLimiter }));
  });

  after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('spends tokens for bytes served and refuses once the bucket is empty', async () => {
    const url = `/ar-io/indexes/root-tx-index/band-a/${fileName}`;

    await request(app).get(url).expect(200);

    // Give the post-response token adjustment a moment to land.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const second = await request(app).get(url);
    assert.equal(
      second.status,
      429,
      'a second full copy does not fit in the bucket, so it is refused',
    );
  });

  it('does not meter the publication document itself', async () => {
    // Small, and needed to discover what to fetch; metering it would make an
    // exhausted client unable even to learn what it could have paid for.
    await request(app).get('/ar-io/indexes').expect(200);
    await request(app).get('/ar-io/indexes').expect(200);
  });
});
