/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it, before, after } from 'node:test';
import crypto from 'node:crypto';
import http from 'node:http';
import { AddressInfo } from 'node:net';

import {
  FetchDocument,
  UpstreamPublishedIndexes,
  indexNamesToAdvertise,
} from './upstream-published-indexes.js';
import {
  IndexPublication,
  serializeIndexPublication,
  signIndexPublication,
} from '../lib/index-publication.js';
import { getSolanaAddress } from '../lib/httpsig.js';
import { createTestLogger } from '../../test/test-logger.js';

const log = createTestLogger({ suite: 'upstream published indexes' });

// The operator's key: on a fleet, the signing node's observer key, whose
// address is also the wallet every node reports.
const operator = crypto.generateKeyPairSync('ed25519');
const WALLET = getSolanaAddress(operator.publicKey);
const stranger = crypto.generateKeyPairSync('ed25519');
const STRANGER = getSolanaAddress(stranger.publicKey);

const publicationOf = (
  names: string[],
  { publisher = WALLET }: { publisher?: string } = {},
): IndexPublication => ({
  version: 1,
  publisher,
  sequence: 1,
  previousManifestSha256: null,
  issuedAt: '2026-09-30T00:00:00Z',
  expiresAt: '2026-10-01T00:00:00Z',
  indexes: names.map((name) => ({
    name,
    kind: 'cdb64-root-tx',
    bands: [
      {
        id: 'band-a',
        files: [{ name: '00.cdb', size: 1, sha256: 'a'.repeat(64) }],
      },
    ],
  })),
});

const signed = (
  names: string[],
  {
    publisher = WALLET,
    key = operator.privateKey,
    keyId = WALLET,
  }: { publisher?: string; key?: crypto.KeyObject; keyId?: string } = {},
): Buffer =>
  Buffer.from(
    serializeIndexPublication(
      signIndexPublication(publicationOf(names, { publisher }), key, keyId),
    ),
  );

/** A fetch answering from a queue of responses, recording each call. */
const scripted = (
  ...responses: ({ status: number; body?: Buffer } | Error)[]
): FetchDocument & { calls: string[] } => {
  const calls: string[] = [];
  const fetch: FetchDocument = async (url) => {
    calls.push(url);
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (next instanceof Error) throw next;
    return { status: next!.status, body: next!.body ?? Buffer.alloc(0) };
  };
  return Object.assign(fetch, { calls });
};

describe('UpstreamPublishedIndexes', () => {
  const make = (
    fetchDocument: FetchDocument,
    clock = { t: 0 },
    overrides: { staleMs?: number } = {},
  ) =>
    new UpstreamPublishedIndexes({
      log,
      url: 'http://signer.internal:4000/',
      wallet: WALLET,
      staleMs: overrides.staleMs ?? 300_000,
      fetchDocument,
      now: () => clock.t,
    });

  it('advertises nothing before the first fetch has answered', () => {
    assert.strictEqual(
      make(scripted({ status: 200, body: signed(['x']) })).names(),
      undefined,
    );
  });

  it("advertises the signing node's index names, sorted", async () => {
    const fetch = scripted({
      status: 200,
      body: signed(['tx-index', 'root-tx-index']),
    });
    const upstream = make(fetch);

    await upstream.refresh();

    assert.deepStrictEqual(upstream.names(), ['root-tx-index', 'tx-index']);
    // The configured base URL, trailing slash and all, gets the route.
    assert.deepStrictEqual(fetch.calls, [
      'http://signer.internal:4000/ar-io/indexes',
    ]);
  });

  it('withdraws at once when the signing node publishes nothing', async () => {
    const upstream = make(
      scripted(
        { status: 200, body: signed(['root-tx-index']) },
        { status: 404 },
      ),
    );
    await upstream.refresh();
    assert.deepStrictEqual(upstream.names(), ['root-tx-index']);

    await upstream.refresh();

    assert.strictEqual(upstream.names(), undefined);
  });

  for (const [what, body] of [
    ['not JSON', Buffer.from('<html>gateway error</html>')],
    [
      'not a publication',
      Buffer.from(JSON.stringify({ version: 1, publisher: WALLET })),
    ],
    [
      'unsigned',
      Buffer.from(serializeIndexPublication(publicationOf(['root-tx-index']))),
    ],
    [
      'tampered after signing',
      Buffer.from(
        signed(['root-tx-index'])
          .toString()
          .replace('"root-tx-index"', '"other-index"'),
      ),
    ],
    [
      'signed by a key its keyId does not name',
      signed(['root-tx-index'], { key: stranger.privateKey }),
    ],
    [
      "another operator's publication",
      signed(['root-tx-index'], {
        publisher: STRANGER,
        key: stranger.privateKey,
        keyId: STRANGER,
      }),
    ],
  ] as const) {
    it(`never advertises a document that is ${what}, and withdraws what it had`, async () => {
      const upstream = make(
        scripted(
          { status: 200, body: signed(['root-tx-index']) },
          {
            status: 200,
            body,
          },
        ),
      );
      await upstream.refresh();
      assert.deepStrictEqual(upstream.names(), ['root-tx-index']);

      await upstream.refresh();

      assert.strictEqual(upstream.names(), undefined);
    });
  }

  it('keeps the names through failed fetches until they go stale', async () => {
    const clock = { t: 0 };
    const upstream = make(
      scripted(
        { status: 200, body: signed(['root-tx-index']) },
        { status: 502 },
        new Error('connect ECONNREFUSED'),
      ),
      clock,
      { staleMs: 300_000 },
    );
    await upstream.refresh();

    clock.t = 60_000;
    await upstream.refresh(); // 502
    assert.deepStrictEqual(upstream.names(), ['root-tx-index']);
    clock.t = 120_000;
    await upstream.refresh(); // refused
    assert.deepStrictEqual(upstream.names(), ['root-tx-index']);

    // Five minutes after the last confirmation, with no answer since.
    clock.t = 300_001;
    assert.strictEqual(upstream.names(), undefined);
  });

  it('a later confirmation restarts the stale clock', async () => {
    const clock = { t: 0 };
    const body = signed(['root-tx-index']);
    const upstream = make(
      scripted({ status: 200, body }, { status: 503 }, { status: 200, body }),
      clock,
    );
    await upstream.refresh();
    clock.t = 200_000;
    await upstream.refresh(); // 503
    clock.t = 250_000;
    await upstream.refresh(); // same document again

    clock.t = 500_000;
    assert.deepStrictEqual(upstream.names(), ['root-tx-index']);
  });

  it('picks up a republished document and advertises again after a withdrawal', async () => {
    const upstream = make(
      scripted(
        { status: 200, body: signed(['root-tx-index']) },
        { status: 404 },
        { status: 200, body: signed(['root-tx-index', 'tx-index']) },
      ),
    );
    await upstream.refresh();
    await upstream.refresh();
    assert.strictEqual(upstream.names(), undefined);

    await upstream.refresh();

    assert.deepStrictEqual(upstream.names(), ['root-tx-index', 'tx-index']);
  });

  it('refreshes on its timer until stopped', async () => {
    const fetch = scripted({ status: 200, body: signed(['root-tx-index']) });
    const upstream = new UpstreamPublishedIndexes({
      log,
      url: 'http://signer.internal:4000',
      wallet: WALLET,
      refreshMs: 20,
      fetchDocument: fetch,
    });

    upstream.start();
    upstream.start(); // a second start does not add a second timer
    await new Promise((resolve) => setTimeout(resolve, 150));
    upstream.stop();
    const atStop = fetch.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 100));

    // One at start, then one per tick: about 8 in 150 ms, never 2 per tick.
    assert.ok(atStop >= 3 && atStop <= 9, `fetched ${atStop} times`);
    assert.strictEqual(fetch.calls.length, atStop, 'no fetch after stop');
    assert.deepStrictEqual(upstream.names(), ['root-tx-index']);
  });

  it('shares one fetch among concurrent refreshes', async () => {
    const fetch = scripted({ status: 200, body: signed(['root-tx-index']) });
    const upstream = make(fetch);

    await Promise.all([upstream.refresh(), upstream.refresh()]);

    assert.strictEqual(fetch.calls.length, 1);
  });
});

describe('UpstreamPublishedIndexes over HTTP', () => {
  let server: http.Server;
  let baseUrl: string;
  let respond: (res: http.ServerResponse) => void;

  before(async () => {
    server = http.createServer((req, res) => {
      assert.strictEqual(req.url, '/ar-io/indexes');
      respond(res);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const serve = (status: number, body: Buffer) => {
    respond = (res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body);
    };
  };

  it('fetches, verifies and advertises a real response', async () => {
    serve(200, signed(['root-tx-index']));
    const upstream = new UpstreamPublishedIndexes({
      log,
      url: baseUrl,
      wallet: WALLET,
    });

    await upstream.refresh();

    assert.deepStrictEqual(upstream.names(), ['root-tx-index']);
  });

  it('gives up on a signing node that does not answer, keeping what it had', async () => {
    serve(200, signed(['root-tx-index']));
    const upstream = new UpstreamPublishedIndexes({
      log,
      url: baseUrl,
      wallet: WALLET,
      timeoutMs: 200,
    });
    await upstream.refresh();

    respond = () => {}; // accepts, never answers
    const started = Date.now();
    await upstream.refresh();

    assert.ok(Date.now() - started < 5_000, 'the fetch timed out');
    assert.deepStrictEqual(upstream.names(), ['root-tx-index']);
  });

  it('abandons a fetch in flight when stopped', async () => {
    respond = () => {}; // never answers
    const upstream = new UpstreamPublishedIndexes({
      log,
      url: baseUrl,
      wallet: WALLET,
      refreshMs: 60_000,
    });

    upstream.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const refreshing = upstream.refresh(); // joins the fetch start() began
    upstream.stop();

    await refreshing;
    assert.strictEqual(upstream.names(), undefined);
  });
});

describe('indexNamesToAdvertise', () => {
  it("prefers the node's own publication", () => {
    assert.deepStrictEqual(
      indexNamesToAdvertise({ published: ['own'], upstream: ['upstream'] }),
      ['own'],
    );
  });

  it("falls back to the signing node's names", () => {
    assert.deepStrictEqual(
      indexNamesToAdvertise({ published: undefined, upstream: ['upstream'] }),
      ['upstream'],
    );
  });

  it('advertises nothing when neither has names', () => {
    assert.strictEqual(
      indexNamesToAdvertise({ published: undefined, upstream: undefined }),
      undefined,
    );
  });
});
