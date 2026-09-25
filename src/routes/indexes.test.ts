/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it, before, after } from 'node:test';
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import { readdirSync, readlinkSync } from 'node:fs';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as path from 'node:path';
import * as os from 'node:os';
import express from 'express';
import request from 'supertest';

import { createIndexesRouter } from './indexes.js';
import { Publisher } from '../index-swarm/publisher.js';
import { StateStore } from '../index-swarm/state.js';
import { createKindRegistry } from '../index-swarm/kinds/registry.js';
import { PartitionedCdb64Writer } from '../lib/partitioned-cdb64-writer.js';
import { encodeCdb64Value } from '../lib/cdb64-encoding.js';
import {
  IndexPublication,
  parseIndexPublication,
  torrentNameForFiles,
} from '../lib/index-publication.js';
import { bdecode } from '../lib/bencode.js';
import { createHttpSigMiddleware } from '../middleware/httpsig.js';
import { deriveKeyId, getSolanaAddress } from '../lib/httpsig.js';
import { createTestLogger } from '../../test/test-logger.js';

const log = createTestLogger({ suite: 'indexes routes' });

const txId = (seed: number): Buffer => {
  const buf = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) buf[i] = (seed + i) % 256;
  return buf;
};

describe('/ar-io/indexes routes', () => {
  let tempDir: string;
  let publishedDir: string;
  let publication: IndexPublication;
  let app: express.Express;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'indexes-routes-'));
    publishedDir = path.join(tempDir, 'published');

    // A real band, published by the real sidecar publisher, so these tests
    // exercise the document the gateway will actually be handed.
    const bandDir = path.join(publishedDir, 'root-tx-index', 'band-a');
    const writer = new PartitionedCdb64Writer(bandDir);
    await writer.open();
    for (let i = 0; i < 40; i++) {
      await writer.add(
        txId(i * 6),
        encodeCdb64Value({ rootTxId: txId(100 + i) }),
      );
    }
    await writer.finalize();

    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    await new Publisher({
      log,
      state: new StateStore({
        log,
        filePath: path.join(tempDir, 'state.json'),
      }),
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

    publication = parseIndexPublication(
      await fs.readFile(path.join(publishedDir, 'publication.json')),
    );

    // Something in the directory that no publication lists, which must stay
    // unreachable however it is asked for.
    await fs.writeFile(path.join(publishedDir, 'secret.txt'), 'not yours');
    await fs.writeFile(
      path.join(publishedDir, 'root-tx-index', 'band-a', 'stray.cdb'),
      'not published',
    );

    app = express();
    app.use(createIndexesRouter({ log, publishedDir }));
  });

  after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const firstFile = () => publication.indexes[0].bands[0].files[0];
  const partitionFile = () =>
    publication.indexes[0].bands[0].files.find((f) => f.name.endsWith('.cdb'))!;

  describe('the publication document', () => {
    it('serves the document with its digest and the signing trigger', async () => {
      const res = await request(app).get('/ar-io/indexes').expect(200);

      assert.match(res.headers['content-type'], /application\/json/);
      assert.equal(res.headers['x-ar-io-index-publication'], '1');
      assert.match(
        res.headers['content-digest'],
        /^sha-256=:[A-Za-z0-9+/]+=*:$/,
      );
      assert.equal(res.headers['cache-control'], 'public, max-age=60');

      const served = parseIndexPublication(
        Buffer.from(JSON.stringify(res.body)),
      );
      assert.equal(served.sequence, publication.sequence);
    });

    it('answers a matching If-None-Match with 304', async () => {
      const first = await request(app).get('/ar-io/indexes').expect(200);
      await request(app)
        .get('/ar-io/indexes')
        .set('If-None-Match', first.headers.etag)
        .expect(304);
    });

    it('is 404 when nothing has been published', async () => {
      const empty = express();
      empty.use(
        createIndexesRouter({
          log,
          publishedDir: path.join(tempDir, 'nothing-here'),
        }),
      );
      await request(empty).get('/ar-io/indexes').expect(404);
    });
  });

  describe('bytes by name', () => {
    it('serves a published file whole, with every digest header', async () => {
      const file = partitionFile();
      const res = await request(app)
        .get(`/ar-io/indexes/root-tx-index/band-a/${file.name}`)
        .buffer(true)
        .parse((response, done) => {
          const chunks: Buffer[] = [];
          response.on('data', (c: Buffer) => chunks.push(c));
          response.on('end', () => done(null, Buffer.concat(chunks)));
        })
        .expect(200);

      const body = res.body as Buffer;
      assert.equal(body.length, file.size);
      assert.equal(
        crypto.createHash('sha256').update(body).digest('hex'),
        file.sha256,
        'the bytes are the ones the publication names',
      );
      assert.equal(res.headers.etag, `"${file.sha256}"`);
      assert.equal(res.headers['accept-ranges'], 'bytes');
      // Names are reused when a band is rebuilt, so caches must revalidate.
      assert.equal(res.headers['cache-control'], 'public, no-cache');
      const expected = `sha-256=:${Buffer.from(file.sha256, 'hex').toString('base64')}:`;
      assert.equal(res.headers['repr-digest'], expected);
      assert.equal(res.headers['content-digest'], expected);
    });

    it('serves a range as 206 without a Content-Digest', async () => {
      const file = partitionFile();
      const res = await request(app)
        .get(`/ar-io/indexes/root-tx-index/band-a/${file.name}`)
        .set('Range', 'bytes=0-99')
        .expect(206);

      assert.equal(res.headers['content-length'], '100');
      assert.equal(res.headers['content-range'], `bytes 0-99/${file.size}`);
      // Repr-Digest describes the whole file and is true of a range too;
      // Content-Digest would describe this partial body, which is not hashed.
      assert.ok(res.headers['repr-digest'] !== undefined);
      assert.equal(res.headers['content-digest'], undefined);
    });

    it('rejects an unsatisfiable range with 416', async () => {
      const file = partitionFile();
      await request(app)
        .get(`/ar-io/indexes/root-tx-index/band-a/${file.name}`)
        .set('Range', `bytes=${file.size + 10}-`)
        .expect(416);
    });

    it('answers HEAD with headers and no body', async () => {
      const file = partitionFile();
      const res = await request(app)
        .head(`/ar-io/indexes/root-tx-index/band-a/${file.name}`)
        .expect(200);
      assert.equal(res.headers['content-length'], String(file.size));
    });

    it('serves nothing the publication does not list', async () => {
      // Present on disk, in a published band's directory, but never listed.
      await request(app)
        .get('/ar-io/indexes/root-tx-index/band-a/stray.cdb')
        .expect(404);
      // A real index and band, but a file name nobody published.
      await request(app)
        .get('/ar-io/indexes/root-tx-index/band-a/ff.cdb')
        .expect(404);
      await request(app)
        .get('/ar-io/indexes/root-tx-index/no-such-band/00.cdb')
        .expect(404);
    });

    it('rejects traversal before anything is looked up', async () => {
      for (const attempt of [
        '/ar-io/indexes/root-tx-index/band-a/..%2F..%2Fsecret.txt',
        '/ar-io/indexes/root-tx-index/..%2F..%2F/secret.txt',
        '/ar-io/indexes/..%2F/band-a/00.cdb',
        '/ar-io/indexes/ROOT/band-a/00.cdb',
      ]) {
        const res = await request(app).get(attempt);
        assert.ok(
          res.status === 400 || res.status === 404,
          `${attempt} returned ${res.status}`,
        );
        assert.notEqual(res.text, 'not yours');
      }
    });

    it('refuses to serve a file whose size no longer matches its publication', async () => {
      const file = partitionFile();
      const filePath = path.join(
        publishedDir,
        'root-tx-index',
        'band-a',
        file.name,
      );
      const original = await fs.readFile(filePath);
      try {
        await fs.writeFile(
          filePath,
          Buffer.concat([original, Buffer.from('x')]),
        );
        const res = await request(app)
          .get(`/ar-io/indexes/root-tx-index/band-a/${file.name}`)
          .expect(503);
        assert.equal(res.headers['retry-after'], '60');
      } finally {
        await fs.writeFile(filePath, original);
      }
    });

    it('serves the listed digest’s bytes after the named file is rebuilt at the same size', async () => {
      // The response is signed with the listed digest, so the bytes must be
      // the ones that digest was taken over, not whatever the name now holds.
      const file = partitionFile();
      const named = path.join(
        publishedDir,
        'root-tx-index',
        'band-a',
        file.name,
      );
      const original = await fs.readFile(named);
      const rebuilt = Buffer.from(original);
      rebuilt[rebuilt.length - 1] ^= 0xff;
      await fs.writeFile(`${named}.rebuild`, rebuilt);
      await fs.rename(`${named}.rebuild`, named); // a new inode, as a rebuild writes
      try {
        const res = await request(app)
          .get(`/ar-io/indexes/root-tx-index/band-a/${file.name}`)
          .buffer(true)
          .parse((r, cb) => {
            const chunks: Buffer[] = [];
            r.on('data', (c: Buffer) => chunks.push(c));
            r.on('end', () => cb(null, Buffer.concat(chunks)));
          })
          .expect(200);
        assert.equal(
          crypto
            .createHash('sha256')
            .update(res.body as Buffer)
            .digest('hex'),
          file.sha256,
          'the bytes match the digest the response is signed with',
        );
        assert.equal(res.headers['x-ar-io-index-file'], file.sha256);
      } finally {
        await fs.writeFile(named, original);
      }
    });

    it('refuses a name whose digest the publisher has no link for', async () => {
      const file = partitionFile();
      const link = path.join(publishedDir, 'blobs', file.sha256);
      const saved = await fs.readFile(link);
      await fs.rm(link);
      try {
        const res = await request(app)
          .get(`/ar-io/indexes/root-tx-index/band-a/${file.name}`)
          .expect(503);
        assert.equal(res.headers['retry-after'], '60');
        assert.equal(res.headers['cache-control'], 'no-store');
        assert.equal(res.headers['x-ar-io-index-file'], undefined);
      } finally {
        await fs.writeFile(link, saved);
      }
    });
  });

  describe('bytes by content address', () => {
    it('serves any published file by its digest, as immutable', async () => {
      const file = firstFile();
      const res = await request(app)
        .get(`/ar-io/indexes/blob/${file.sha256}`)
        .expect(200);
      assert.equal(res.headers.etag, `"${file.sha256}"`);
      assert.match(res.headers['cache-control'], /immutable/);
    });

    it('is 404 for a digest nothing was published under', async () => {
      await request(app)
        .get(`/ar-io/indexes/blob/${'0'.repeat(64)}`)
        .expect(404);
    });

    it('keeps serving a digest’s own bytes after the named file is rebuilt', async () => {
      // A band rebuilt under the same id, before the next scan updates the
      // document: same name, same size, different bytes.
      const file = partitionFile();
      const named = path.join(
        publishedDir,
        'root-tx-index',
        'band-a',
        file.name,
      );
      const original = await fs.readFile(named);
      const rebuilt = Buffer.from(original);
      rebuilt[rebuilt.length - 1] ^= 0xff;
      const tmp = `${named}.rebuild`;
      await fs.writeFile(tmp, rebuilt);
      await fs.rename(tmp, named); // a new inode, as a rebuild writes
      try {
        const res = await request(app)
          .get(`/ar-io/indexes/blob/${file.sha256}`)
          .buffer(true)
          .parse((r, cb) => {
            const chunks: Buffer[] = [];
            r.on('data', (c: Buffer) => chunks.push(c));
            r.on('end', () => cb(null, Buffer.concat(chunks)));
          })
          .expect(200);
        const served = crypto
          .createHash('sha256')
          .update(res.body as Buffer)
          .digest('hex');
        assert.equal(served, file.sha256, 'the bytes match the URL');
      } finally {
        await fs.writeFile(named, original);
      }
    });

    it('refuses a digest the publisher has no link for, rather than read the name', async () => {
      // With no link, only the named file is left, and a same-size rebuild
      // may already have replaced it; serving it would put the wrong bytes
      // under an immutable digest URL.
      const file = partitionFile();
      const link = path.join(publishedDir, 'blobs', file.sha256);
      const named = path.join(
        publishedDir,
        'root-tx-index',
        'band-a',
        file.name,
      );
      const saved = await fs.readFile(link);
      await fs.rm(link);
      const rebuilt = Buffer.from(saved);
      rebuilt[rebuilt.length - 1] ^= 0xff;
      await fs.writeFile(`${named}.rebuild`, rebuilt);
      await fs.rename(`${named}.rebuild`, named);
      try {
        const res = await request(app)
          .get(`/ar-io/indexes/blob/${file.sha256}`)
          .expect(503);
        assert.equal(res.headers['retry-after'], '60');
        assert.equal(res.headers['cache-control'], 'no-store');
      } finally {
        await fs.writeFile(named, saved);
        await fs.link(named, link);
      }
    });

    it('does not treat a non-digest as a blob request', async () => {
      // Falls through to the named routes, where "blob" is just an index
      // name that happens not to exist.
      await request(app).get('/ar-io/indexes/blob/not-a-digest').expect(404);
    });
  });

  // Most gateways sit behind nginx, often caching, with rules such as
  // `proxy_cache_valid 404 30s`. An upstream Cache-Control overrides those
  // rules, so every error must say no-store, and only 200, 206 and 304 may
  // say anything cacheable.
  describe('behind a caching proxy', () => {
    const cacheControl = async (
      target: express.Express,
      url: string,
      status: number,
      headers: Record<string, string> = {},
    ): Promise<string | undefined> => {
      const req = request(target).get(url);
      for (const [k, v] of Object.entries(headers)) req.set(k, v);
      const res = await req.expect(status);
      return res.headers['cache-control'];
    };

    it('marks every error uncacheable', async () => {
      const file = partitionFile();
      const empty = express();
      empty.use(
        createIndexesRouter({
          log,
          publishedDir: path.join(tempDir, 'nothing-here'),
        }),
      );
      const cases: Array<
        [string, express.Express, string, number, Record<string, string>?]
      > = [
        ['an unpublished document', empty, '/ar-io/indexes', 404],
        [
          'an unknown digest',
          app,
          `/ar-io/indexes/blob/${'0'.repeat(64)}`,
          404,
        ],
        [
          'an unknown file',
          app,
          '/ar-io/indexes/root-tx-index/band-a/nope.cdb',
          404,
        ],
        ['a bad name', app, '/ar-io/indexes/Bad_Name/band-a/x.cdb', 400],
        [
          'an unsatisfiable range',
          app,
          `/ar-io/indexes/blob/${file.sha256}`,
          416,
          { Range: `bytes=${file.size + 10}-` },
        ],
        [
          'a malformed range',
          app,
          `/ar-io/indexes/blob/${file.sha256}`,
          400,
          { Range: 'garbage' },
        ],
      ];
      for (const [what, target, url, status, headers] of cases) {
        assert.equal(
          await cacheControl(target, url, status, headers),
          'no-store',
          what,
        );
      }
    });

    it('keeps the cacheable values on success', async () => {
      const file = partitionFile();
      const blob = `/ar-io/indexes/blob/${file.sha256}`;
      const immutable = 'public, max-age=31536000, immutable';
      assert.equal(await cacheControl(app, blob, 200), immutable);
      assert.equal(
        await cacheControl(app, blob, 206, { Range: 'bytes=0-9' }),
        immutable,
      );
      assert.equal(
        await cacheControl(app, blob, 304, {
          'If-None-Match': `"${file.sha256}"`,
        }),
        immutable,
      );
      assert.equal(
        await cacheControl(
          app,
          `/ar-io/indexes/root-tx-index/band-a/${file.name}`,
          200,
        ),
        'public, no-cache',
      );
      assert.equal(
        await cacheControl(app, '/ar-io/indexes', 200),
        'public, max-age=60',
      );
    });

    it('marks bytes private when only payments meter them', async () => {
      // x402 without a rate limiter still meters, so a shared cache must not
      // keep the bytes either; a 304 is answered before the meter is asked.
      const file = partitionFile();
      const paid = express();
      paid.use(
        createIndexesRouter({
          log,
          publishedDir,
          paymentProcessor: {} as never,
        }),
      );
      assert.equal(
        await cacheControl(paid, `/ar-io/indexes/blob/${file.sha256}`, 304, {
          'If-None-Match': `"${file.sha256}"`,
        }),
        'private, max-age=31536000, immutable',
      );
      assert.equal(
        await cacheControl(
          paid,
          `/ar-io/indexes/root-tx-index/band-a/${file.name}`,
          304,
          { 'If-None-Match': `"${file.sha256}"` },
        ),
        'private, no-cache',
      );
      assert.equal(
        await cacheControl(paid, '/ar-io/indexes', 200),
        'public, max-age=60',
      );
    });
  });

  describe('a client that disconnects mid-download', () => {
    const openHandlesTo = (file: string): number => {
      let count = 0;
      for (const fd of readdirSync('/proc/self/fd')) {
        try {
          if (readlinkSync(`/proc/self/fd/${fd}`) === file) count++;
        } catch {
          // Closed between readdir and readlink.
        }
      }
      return count;
    };

    it(
      'stops reading and releases the file within half a second',
      { skip: process.platform !== 'linux' },
      async () => {
        // Large enough that reading it to the end takes seconds (it is
        // sparse, so it costs no disk): an aborted download must stop
        // reading rather than drain the rest of the file into nothing.
        const big = path.join(tempDir, 'big.bin');
        await fs.writeFile(big, '');
        await fs.truncate(big, 8 * 1024 ** 3);
        const sha256 = 'a'.repeat(64);
        const entry = { filePath: big, size: 8 * 1024 ** 3, sha256 };
        const view = {
          raw: Buffer.from('{}'),
          sha256: 'b'.repeat(64),
          names: ['root-tx-index'],
          files: new Map(),
          blobs: new Map([[sha256, entry]]),
          mtimeMs: 0,
          byteSize: 2,
        };
        const served = express();
        served.use(
          createIndexesRouter({
            log,
            publishedIndexes: {
              current: async () => view,
              publishedDir: tempDir,
            } as never,
          }),
        );
        const server = served.listen(0);
        await new Promise((resolve) => server.once('listening', resolve));
        const port = (server.address() as AddressInfo).port;
        try {
          await new Promise<void>((resolve, reject) => {
            const req = http.get(
              `http://127.0.0.1:${port}/ar-io/indexes/blob/${sha256}`,
              (res) => {
                res.once('data', () => {
                  // Some bytes arrived: the file is open. Walk away.
                  req.destroy();
                  resolve();
                });
              },
            );
            req.on('error', (error: any) => {
              if (error?.code !== 'ECONNRESET') reject(error);
            });
          });
          let open = openHandlesTo(big);
          for (let i = 0; i < 25 && open > 0; i++) {
            await new Promise((resolve) => setTimeout(resolve, 20));
            open = openHandlesTo(big);
          }
          assert.equal(
            open,
            0,
            'the aborted download still holds the file, still reading it',
          );
        } finally {
          server.closeAllConnections();
          await new Promise((resolve) => server.close(resolve));
        }
      },
    );
  });

  describe('torrent metainfo', () => {
    it('is 404 for a published band with no torrent yet', async () => {
      const res = await request(app)
        .get('/ar-io/indexes/root-tx-index/band-a.torrent')
        .expect(404);
      assert.equal(res.headers['cache-control'], 'no-store');
    });

    it('does not serve a torrent for a band the document offers over HTTP only', async () => {
      // band-a is published without torrents; a stray file must not be served.
      const torrentPath = path.join(
        publishedDir,
        'root-tx-index',
        'band-a.torrent',
      );
      await fs.writeFile(torrentPath, 'd4:infod4:name6:band-aee');
      try {
        await request(app)
          .get('/ar-io/indexes/root-tx-index/band-a.torrent')
          .expect(404);
      } finally {
        await fs.rm(torrentPath);
      }
    });

    it('does not serve a torrent for a band no publication lists', async () => {
      const torrentPath = path.join(
        publishedDir,
        'root-tx-index',
        'band-x.torrent',
      );
      await fs.writeFile(torrentPath, 'd4:infod4:name6:band-xee');
      try {
        await request(app)
          .get('/ar-io/indexes/root-tx-index/band-x.torrent')
          .expect(404);
      } finally {
        await fs.rm(torrentPath);
      }
    });

    it('answers a malformed band name 400, uncacheable', async () => {
      const res = await request(app)
        .get('/ar-io/indexes/root-tx-index/..%2Fx.torrent')
        .expect(400);
      assert.equal(res.headers['cache-control'], 'no-store');
    });
  });

  describe('HTTPSIG', () => {
    const signedApp = () => {
      const { privateKey } = crypto.generateKeyPairSync('ed25519');
      const signed = express();
      signed.use(
        createHttpSigMiddleware({
          privateKey,
          keyId: deriveKeyId(crypto.createPublicKey(privateKey)),
          bindRequest: false,
        }),
      );
      signed.use(createIndexesRouter({ log, publishedDir }));
      return signed;
    };
    const covered = (res: { headers: Record<string, string> }) =>
      res.headers['signature-input'] ?? '';

    it('signs the publication, covering its Content-Digest', async () => {
      const doc = await request(signedApp()).get('/ar-io/indexes').expect(200);
      assert.ok(doc.headers.signature !== undefined, 'the document is signed');
      assert.match(covered(doc), /"content-digest"/);
      assert.match(covered(doc), /"x-ar-io-index-publication"/);
    });

    it('signs a band file by name and by digest, binding its Content-Digest', async () => {
      const file = partitionFile();
      const signed = signedApp();
      for (const url of [
        `/ar-io/indexes/root-tx-index/band-a/${file.name}`,
        `/ar-io/indexes/blob/${file.sha256}`,
      ]) {
        const res = await request(signed).get(url).expect(200);
        assert.equal(res.headers['x-ar-io-index-file'], file.sha256, url);
        assert.ok(res.headers.signature !== undefined, `${url} is signed`);
        assert.match(covered(res), /"x-ar-io-index-file"/);
        assert.match(covered(res), /"content-digest"/);
        assert.match(covered(res), /"repr-digest"/);
      }
    });

    it('signs a range with the whole file’s Repr-Digest, and a HEAD with its Content-Digest', async () => {
      const file = partitionFile();
      const signed = signedApp();
      const url = `/ar-io/indexes/blob/${file.sha256}`;

      const range = await request(signed)
        .get(url)
        .set('Range', 'bytes=0-9')
        .expect(206);
      assert.equal(range.headers['content-digest'], undefined);
      assert.match(covered(range), /"repr-digest"/);
      assert.doesNotMatch(covered(range), /"content-digest"/);

      const head = await request(signed).head(url).expect(200);
      assert.ok(head.headers.signature !== undefined, 'HEAD is signed');
      assert.match(covered(head), /"content-digest"/);
    });

    it('leaves a 304 and a 404 unsigned', async () => {
      const file = partitionFile();
      const signed = signedApp();
      const notModified = await request(signed)
        .get(`/ar-io/indexes/blob/${file.sha256}`)
        .set('If-None-Match', `"${file.sha256}"`)
        .expect(304);
      assert.equal(notModified.headers.signature, undefined);
      const missing = await request(signed)
        .get(`/ar-io/indexes/blob/${'0'.repeat(64)}`)
        .expect(404);
      assert.equal(missing.headers.signature, undefined);
    });
  });

  describe('republication', () => {
    it('picks up a new document without a restart', async () => {
      const first = await request(app).get('/ar-io/indexes').expect(200);
      const publicationPath = path.join(publishedDir, 'publication.json');
      const original = await fs.readFile(publicationPath);

      // Make the view stale by rewriting the file with different bytes.
      const doc = JSON.parse(original.toString());
      doc.indexes[0].bands = [];
      await new Promise((resolve) => setTimeout(resolve, 20));
      await fs.writeFile(publicationPath, JSON.stringify(doc));
      try {
        const second = await request(app).get('/ar-io/indexes').expect(200);
        assert.notEqual(second.headers.etag, first.headers.etag);
        // The band it no longer lists is no longer served.
        const file = partitionFile();
        await request(app)
          .get(`/ar-io/indexes/root-tx-index/band-a/${file.name}`)
          .expect(404);
      } finally {
        await fs.writeFile(publicationPath, original);
      }
    });
  });
});

describe('/ar-io/indexes/webseed', () => {
  let tempDir: string;
  let publishedDir: string;
  let publication: IndexPublication;
  let app: express.Express;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'indexes-webseed-'));
    publishedDir = path.join(tempDir, 'published');
    for (const bandId of ['band-t']) {
      const writer = new PartitionedCdb64Writer(
        path.join(publishedDir, 'root-tx-index', bandId),
      );
      await writer.open();
      for (let i = 0; i < 20; i++) {
        await writer.add(
          txId(i * 9),
          encodeCdb64Value({ rootTxId: txId(50 + i) }),
        );
      }
      await writer.finalize();
    }
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    // Torrents on, no engine: the publication carries torrent entries.
    await new Publisher({
      log,
      state: new StateStore({
        log,
        filePath: path.join(tempDir, 'state.json'),
      }),
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
      torrents: { trackers: [], privateSwarm: false },
    }).scanOnce();
    publication = parseIndexPublication(
      await fs.readFile(path.join(publishedDir, 'publication.json')),
    );
    app = express();
    app.use(createIndexesRouter({ log, publishedDir }));
  });

  after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('serves a band file under the name its torrent carries, as immutable', async () => {
    const band = publication.indexes[0].bands[0];
    // The name a client will use is the one inside the .torrent itself.
    const torrent = await fs.readFile(
      path.join(publishedDir, 'root-tx-index', `${band.id}.torrent`),
    );
    const info = (bdecode(torrent) as any).info;
    const name = (info.name as Buffer).toString();
    assert.equal(name, torrentNameForFiles(band.files));

    const file = band.files.find((f) => f.name.endsWith('.cdb'))!;
    const res = await request(app)
      .get(`/ar-io/indexes/webseed/${name}/${file.name}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    assert.equal(
      crypto
        .createHash('sha256')
        .update(res.body as Buffer)
        .digest('hex'),
      file.sha256,
    );
    assert.match(res.headers['cache-control'], /immutable/);
  });

  it('serves the torrent of a band the document offers as one', async () => {
    const band = publication.indexes[0].bands[0];
    const res = await request(app)
      .get(`/ar-io/indexes/root-tx-index/${band.id}.torrent`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    assert.equal(res.headers['content-type'], 'application/x-bittorrent');
    assert.equal(res.headers['cache-control'], 'public, max-age=60');
    assert.deepEqual(
      res.body,
      await fs.readFile(
        path.join(publishedDir, 'root-tx-index', `${band.id}.torrent`),
      ),
    );
  });

  it('answers a range, as WebSeed clients ask', async () => {
    const band = publication.indexes[0].bands[0];
    const name = torrentNameForFiles(band.files);
    const file = band.files.find((f) => f.name.endsWith('.cdb'))!;
    const res = await request(app)
      .get(`/ar-io/indexes/webseed/${name}/${file.name}`)
      .set('Range', 'bytes=0-99')
      .expect(206);
    assert.equal(res.headers['content-range'], `bytes 0-99/${file.size}`);
  });

  it('is 404 for a file or name no torrent offers', async () => {
    const band = publication.indexes[0].bands[0];
    const name = torrentNameForFiles(band.files);
    const res = await request(app)
      .get(`/ar-io/indexes/webseed/${name}/nope.cdb`)
      .expect(404);
    assert.equal(res.headers['cache-control'], 'no-store');
    await request(app)
      .get(`/ar-io/indexes/webseed/${'0'.repeat(16)}/00.cdb`)
      .expect(404);
  });

  it('marks WebSeed bytes private when the gateway meters', async () => {
    const metered = express();
    metered.use(
      createIndexesRouter({
        log,
        publishedDir,
        paymentProcessor: {} as never,
      }),
    );
    const band = publication.indexes[0].bands[0];
    const name = torrentNameForFiles(band.files);
    const file = band.files.find((f) => f.name.endsWith('.cdb'))!;
    // A 304 is answered before the meter is asked, so it shows the scope.
    const res = await request(metered)
      .get(`/ar-io/indexes/webseed/${name}/${file.name}`)
      .set('If-None-Match', `"${file.sha256}"`)
      .expect(304);
    assert.equal(
      res.headers['cache-control'],
      'private, max-age=31536000, immutable',
    );
  });

  it('leaves anything that is not a torrent name to the other routes', async () => {
    // An index named "webseed" is still reachable by name.
    await request(app).get('/ar-io/indexes/webseed/band-t/00.cdb').expect(404);
  });
});
