/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { AddressInfo } from 'node:net';

import { buildTorrent } from '../torrent.js';
import {
  mapState,
  qbittorrentId,
  QBittorrentTransport,
} from './qbittorrent.js';

interface Seen {
  method: string;
  path: string;
  cookie?: string;
  body: string;
}

/**
 * A scripted stand-in for qBittorrent's Web API. Each test sets `handle`;
 * every request is recorded in `seen`.
 */
describe('QBittorrentTransport', () => {
  let server: http.Server;
  let url: string;
  let seen: Seen[];
  let handle: (req: Seen, res: http.ServerResponse) => void;

  beforeEach(async () => {
    seen = [];
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const entry: Seen = {
          method: req.method ?? 'GET',
          path: req.url ?? '/',
          ...(req.headers.cookie !== undefined
            ? { cookie: req.headers.cookie }
            : {}),
          body: Buffer.concat(chunks).toString('latin1'),
        };
        seen.push(entry);
        handle(entry, res);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('isAvailable', () => {
    it('is true for a Web API 2.x', async () => {
      handle = (_req, res) => res.end('2.15.1');
      assert.equal(await new QBittorrentTransport({ url }).isAvailable(), true);
    });

    it('is false, within two seconds, for an engine that accepts and never answers', async () => {
      handle = () => {
        // Hold the connection open: the case a closed port does not cover.
      };
      const started = Date.now();
      assert.equal(
        await new QBittorrentTransport({ url }).isAvailable(),
        false,
      );
      const elapsed = Date.now() - started;
      assert(elapsed < 2_500, `took ${elapsed} ms`);
    });

    it('is false when nothing listens', async () => {
      assert.equal(
        await new QBittorrentTransport({
          url: 'http://127.0.0.1:1',
        }).isAvailable(),
        false,
      );
    });

    it('is false for something that is not qBittorrent', async () => {
      handle = (_req, res) => res.end('<html>hello</html>');
      assert.equal(
        await new QBittorrentTransport({ url }).isAvailable(),
        false,
      );
    });
  });

  describe('auth', () => {
    it('explains a Host header rejection instead of trying to log in', async () => {
      // What qBittorrent 5.2.3 sends when its port is published under
      // another number: 401 to everything, the login included.
      handle = (_req, res) => res.writeHead(401).end('Unauthorized');
      await assert.rejects(
        new QBittorrentTransport({ url, username: 'u', password: 'p' }).status(
          'x',
        ),
        /Host header validation/,
      );
      assert.equal(
        seen.filter((s) => s.path === '/api/v2/auth/login').length,
        0,
        'a login cannot fix it, and failed logins get an address banned',
      );
    });

    it('logs in once on a 403 and retries with the cookie', async () => {
      handle = (req, res) => {
        if (req.path === '/api/v2/auth/login') {
          assert.match(req.body, /username=u&password=p/);
          // qBittorrent 5.2.3's success, verbatim.
          res.setHeader(
            'Set-Cookie',
            'QBT_SID_8080=abc123; HttpOnly; SameSite=Lax; path=/',
          );
          res.writeHead(204).end();
          return;
        }
        if (req.cookie !== 'QBT_SID_8080=abc123') {
          res.writeHead(403).end('Forbidden');
          return;
        }
        res.end('2.15.1');
      };
      const transport = new QBittorrentTransport({
        url,
        username: 'u',
        password: 'p',
      });
      assert.equal(await transport.isAvailable(), true);
      assert.deepEqual(
        seen.map((s) => s.path),
        [
          '/api/v2/app/webapiVersion',
          '/api/v2/auth/login',
          '/api/v2/app/webapiVersion',
        ],
      );
      // The cookie is kept: no second login.
      assert.equal(await transport.isAvailable(), true);
      assert.equal(
        seen.filter((s) => s.path === '/api/v2/auth/login').length,
        1,
      );
    });

    it('follows no redirect, so neither the password nor the cookie leaves the engine', async () => {
      handle = (req, res) => {
        if (req.path === '/elsewhere') {
          res.end('2.15.1');
          return;
        }
        if (req.path === '/api/v2/auth/login') {
          // 307 would resend the POST body, password and all.
          res.writeHead(307, { Location: '/elsewhere' }).end();
          return;
        }
        if (req.cookie === undefined) {
          res.writeHead(403).end('Forbidden');
          return;
        }
        res.writeHead(308, { Location: '/elsewhere' }).end();
      };
      const transport = new QBittorrentTransport({
        url,
        username: 'u',
        password: 'p',
      });
      assert.equal(await transport.isAvailable(), false);
      assert.deepEqual(
        seen.map((s) => s.path),
        ['/api/v2/app/webapiVersion', '/api/v2/auth/login'],
      );

      // With a session already held, an API call that redirects is not
      // followed either.
      seen = [];
      (transport as unknown as { cookie: string }).cookie = 'QBT_SID_8080=abc';
      assert.equal(await transport.isAvailable(), false);
      assert.deepEqual(
        seen.map((s) => s.path),
        ['/api/v2/app/webapiVersion'],
      );
    });

    it('accepts a 4.x login too', async () => {
      handle = (req, res) => {
        if (req.path === '/api/v2/auth/login') {
          res.setHeader('Set-Cookie', 'SID=x; path=/');
          res.end('Ok.');
          return;
        }
        if (req.cookie !== 'SID=x') {
          res.writeHead(403).end();
          return;
        }
        res.end('2.8.19');
      };
      assert.equal(
        await new QBittorrentTransport({
          url,
          username: 'u',
          password: 'p',
        }).isAvailable(),
        true,
      );
    });

    for (const [version, refuse] of [
      [
        '5.x',
        (res: http.ServerResponse) => res.writeHead(401).end('Unauthorized'),
      ],
      ['4.x', (res: http.ServerResponse) => res.end('Fails.')],
    ] as const) {
      it(`does not retry a refused ${version} login`, async () => {
        handle = (req, res) => {
          if (req.path === '/api/v2/auth/login') {
            refuse(res);
            return;
          }
          res.writeHead(403).end();
        };
        await assert.rejects(
          new QBittorrentTransport({
            url,
            username: 'u',
            password: 'bad',
          }).status('x'),
          /login refused/,
        );
        assert.equal(
          seen.filter((s) => s.path === '/api/v2/auth/login').length,
          1,
        );
      });
    }

    it('says so when the engine wants a login and none is configured', async () => {
      handle = (_req, res) => res.writeHead(403).end();
      await assert.rejects(
        new QBittorrentTransport({ url }).status('x'),
        /no credentials are configured/,
      );
    });
  });

  describe('add and seed', () => {
    let dir: string;

    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qbt-test-'));
      await fs.writeFile(path.join(dir, 'a.cdb'), Buffer.alloc(40_000, 1));
    });

    afterEach(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });

    it('adds without a subfolder and without automatic management, then waits for the listing', async () => {
      const built = await buildTorrent({
        dir,
        name: 'band-x',
        pieceLength: 16_384,
      });
      const id = qbittorrentId(built.torrent);
      let listed = false;
      let infoCalls = 0;
      handle = (req, res) => {
        if (req.path === '/api/v2/torrents/add') {
          // Listed only on the second look afterwards: adds are asynchronous.
          setTimeout(() => (listed = true), 150);
          res.end(
            JSON.stringify({ added_torrent_ids: [id], failure_count: 0 }),
          );
          return;
        }
        if (req.path.startsWith('/api/v2/torrents/info')) {
          infoCalls++;
          res.end(
            JSON.stringify(
              listed
                ? [
                    {
                      state: 'checkingUP',
                      progress: 0.5,
                      num_seeds: 0,
                      num_leechs: 0,
                    },
                  ]
                : [],
            ),
          );
          return;
        }
        res.writeHead(404).end();
      };
      const transport = new QBittorrentTransport({ url });
      const result = await transport.seed({
        torrent: built.torrent,
        dir: '/seed/band-x',
      });
      assert.equal(result.id, id);
      assert(infoCalls >= 2, 'waited for the listing');

      const add = seen.find((s) => s.path === '/api/v2/torrents/add')!;
      for (const [field, value] of [
        ['savepath', '/seed/band-x'],
        ['contentLayout', 'NoSubfolder'],
        ['autoTMM', 'false'],
      ]) {
        assert.match(
          add.body,
          new RegExp(`name="${field}"\\r\\n\\r\\n${value}\\r\\n`),
        );
      }
      assert(
        add.body.includes(built.torrent.toString('latin1')),
        'the torrent bytes are sent as is',
      );
    });

    it('does not add a torrent the engine already has', async () => {
      const built = await buildTorrent({
        dir,
        name: 'band-x',
        pieceLength: 16_384,
      });
      handle = (req, res) => {
        if (req.path.startsWith('/api/v2/torrents/info')) {
          res.end(JSON.stringify([{ state: 'stalledUP', progress: 1 }]));
          return;
        }
        res.writeHead(500).end();
      };
      await new QBittorrentTransport({ url }).add({
        torrent: built.torrent,
        downloadDir: '/incoming/x',
      });
      assert.equal(
        seen.filter((s) => s.path === '/api/v2/torrents/add').length,
        0,
      );
    });
  });

  describe('setWebSeeds', () => {
    it('removes what is no longer wanted and adds only what is missing', async () => {
      handle = (req, res) => {
        if (req.path.startsWith('/api/v2/torrents/webseeds')) {
          res.end(
            JSON.stringify([{ url: 'http://old/' }, { url: 'http://keep/' }]),
          );
          return;
        }
        res.end('');
      };
      await new QBittorrentTransport({ url }).setWebSeeds('abc', [
        'http://keep/',
        'http://new/',
      ]);
      const remove = seen.find(
        (s) => s.path === '/api/v2/torrents/removeWebSeeds',
      )!;
      const add = seen.find((s) => s.path === '/api/v2/torrents/addWebSeeds')!;
      assert.equal(new URLSearchParams(remove.body).get('urls'), 'http://old/');
      assert.equal(new URLSearchParams(add.body).get('urls'), 'http://new/');
    });

    it('makes no calls when nothing changes', async () => {
      handle = (_req, res) =>
        res.end(JSON.stringify([{ url: 'http://keep/' }]));
      await new QBittorrentTransport({ url }).setWebSeeds('abc', [
        'http://keep/',
      ]);
      assert.deepEqual(
        seen.map((s) => s.path),
        ['/api/v2/torrents/webseeds?hash=abc'],
      );
    });
  });

  describe('status', () => {
    it('maps the engine state and counts seeds and leechers as peers', async () => {
      handle = (_req, res) =>
        res.end(
          JSON.stringify([
            {
              state: 'stalledDL',
              progress: 0.25,
              num_seeds: 2,
              num_leechs: 3,
              downloaded: 10,
              uploaded: 4,
            },
          ]),
        );
      assert.deepEqual(await new QBittorrentTransport({ url }).status('abc'), {
        state: 'downloading',
        progress: 0.25,
        peers: 5,
        bytesDown: 10,
        bytesUp: 4,
      });
    });

    it('reports the session counters while the all-time ones lag', async () => {
      // What qBittorrent 5.2.3 reported for a seeder that had just served a band.
      handle = (_req, res) =>
        res.end(
          JSON.stringify([
            {
              state: 'stalledUP',
              progress: 1,
              uploaded: 0,
              uploaded_session: 24936448,
              downloaded: 0,
            },
          ]),
        );
      const status = await new QBittorrentTransport({ url }).status('abc');
      assert.equal(status?.bytesUp, 24936448);
    });

    it('reports an error state with what the engine called it', async () => {
      handle = (_req, res) =>
        res.end(JSON.stringify([{ state: 'missingFiles', progress: 0 }]));
      const status = await new QBittorrentTransport({ url }).status('abc');
      assert.equal(status?.state, 'error');
      assert.equal(status?.error, 'missingFiles');
    });
  });

  it('maps every known state, and anything unknown to error', () => {
    assert.equal(mapState('uploading'), 'seeding');
    assert.equal(mapState('checkingResumeData'), 'checking');
    assert.equal(mapState('stoppedUP'), 'stopped');
    assert.equal(mapState('somethingNew'), 'error');
  });

  it('identifies a hybrid torrent by its truncated v2 hash and a v1 torrent by its v1 hash', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qbt-id-'));
    try {
      await fs.writeFile(path.join(dir, 'a.cdb'), Buffer.alloc(20_000, 7));
      const hybrid = await buildTorrent({
        dir,
        name: 'x',
        pieceLength: 16_384,
      });
      const v1 = await buildTorrent({
        dir,
        name: 'x',
        pieceLength: 16_384,
        format: 'v1',
      });
      assert.equal(
        qbittorrentId(hybrid.torrent),
        hybrid.infohashV2!.slice(0, 40),
      );
      assert.equal(qbittorrentId(v1.torrent), v1.infohashV1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
