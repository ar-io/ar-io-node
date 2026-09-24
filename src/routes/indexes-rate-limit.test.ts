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
  let fileName: string;
  let fileSize: number;
  let fileSha256: string;
  /** A router with a fresh limiter whose IP bucket holds 1.5 copies of the file. */
  let makeApp: (paymentProcessor?: unknown) => express.Express;

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
    // Enough records that a partition costs several tokens, so a HEAD priced
    // at full size is distinguishable from one priced at the minimum.
    for (let i = 0; i < 20_000; i++) {
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
    fileSha256 = partition.sha256;

    // An IP bucket that holds one copy of the file and not two, and refills
    // too slowly to matter within the test.
    const tokensForFile = Math.ceil(fileSize / 1024);
    assert.ok(tokensForFile >= 4, `a file costs ${tokensForFile} tokens`);
    makeApp = (paymentProcessor?: unknown) => {
      const rateLimiter = new MemoryRateLimiter({
        resourceCapacity: tokensForFile * 100,
        resourceRefillRate: 0.001,
        ipCapacity: Math.ceil(tokensForFile * 1.5),
        ipRefillRate: 0.001,
        limitsEnabled: true,
        ipAllowlist: [],
        capacityMultiplier: 10,
      });
      const made = express();
      made.use(
        createIndexesRouter({
          log,
          publishedDir,
          rateLimiter,
          ...(paymentProcessor !== undefined
            ? { paymentProcessor: paymentProcessor as never }
            : {}),
        }),
      );
      return made;
    };
    app = makeApp();
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
    // A cache in front of the gateway must not keep the refusal.
    assert.equal(second.headers['cache-control'], 'no-store');
  });

  it('does not meter the publication document itself', async () => {
    // Small, and needed to discover what to fetch; metering it would make an
    // exhausted client unable even to learn what it could have paid for.
    await request(app).get('/ar-io/indexes').expect(200);
    await request(app).get('/ar-io/indexes').expect(200);
  });

  // Let the post-response token adjustment land.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  it('prices a HEAD at nothing, as the data routes do', async () => {
    const fresh = makeApp();
    const url = `/ar-io/indexes/blob/${fileSha256}`;
    // More HEADs than the bucket could pay for at full size.
    for (let i = 0; i < 3; i++) {
      await request(fresh).head(url).expect(200);
      await settle();
    }
    // And the bucket still holds a full copy afterwards.
    await request(fresh).get(url).expect(200);
  });

  it('answers a revalidation with a free 304', async () => {
    const fresh = makeApp();
    const url = `/ar-io/indexes/blob/${fileSha256}`;
    for (let i = 0; i < 5; i++) {
      await request(fresh)
        .get(url)
        .set('If-None-Match', `"${fileSha256}"`)
        .expect(304);
    }
    await request(fresh).get(url).expect(200);
  });

  it('marks metered bytes private, so a shared cache cannot bypass the meter', async () => {
    // A shared cache replays what it stored without reaching the gateway, and
    // a 304 is free, so a public copy of a paid file would be free to anyone.
    const blob = `/ar-io/indexes/blob/${fileSha256}`;
    const immutable = 'private, max-age=31536000, immutable';

    const whole = await request(makeApp()).get(blob).expect(200);
    assert.equal(whole.headers['cache-control'], immutable);
    const range = await request(makeApp())
      .get(blob)
      .set('Range', 'bytes=0-9')
      .expect(206);
    assert.equal(range.headers['cache-control'], immutable);
    const revalidated = await request(makeApp())
      .get(blob)
      .set('If-None-Match', `"${fileSha256}"`)
      .expect(304);
    assert.equal(revalidated.headers['cache-control'], immutable);

    const named = await request(makeApp())
      .get(`/ar-io/indexes/root-tx-index/band-a/${fileName}`)
      .expect(200);
    assert.equal(named.headers['cache-control'], 'private, no-cache');

    // The document is never metered, so it stays shareable.
    const doc = await request(makeApp()).get('/ar-io/indexes').expect(200);
    assert.equal(doc.headers['cache-control'], 'public, max-age=60');
  });

  it('asks for payment rather than refusing when x402 is enabled', async () => {
    let asked = 0;
    const payments = {
      isBrowserRequest: () => false,
      calculateRequirements: () => ({}),
      extractPayment: () => undefined,
      verifyPayment: async () => ({ isValid: false }),
      settlePayment: async () => ({ success: false }),
      sendPaymentRequiredResponse: (_req: unknown, res: express.Response) => {
        asked++;
        res.status(402).json({ error: 'payment_required' });
      },
    };
    const paid = makeApp(payments);
    const url = `/ar-io/indexes/blob/${fileSha256}`;

    await request(paid).get(url).expect(200);
    await settle();
    const refused = await request(paid).get(url).expect(402);
    assert.equal(asked, 1);
    // This is a blob URL, whose success value is a year of immutable caching:
    // a cache that kept this 402 would keep refusing long after payment.
    assert.equal(refused.headers['cache-control'], 'no-store');
  });
});
