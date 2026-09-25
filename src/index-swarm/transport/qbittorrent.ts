/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * TorrentTransport over qBittorrent-nox's Web API (2.15.1, qBittorrent
 * 5.2.3 on libtorrent 2.0.13), the engine the sidecar runs beside it.
 *
 * Details established against the real engine, which is why this looks the
 * way it does:
 *
 * - **Ids.** qBittorrent identifies a hybrid torrent by its v2 infohash
 *   truncated to 40 hex characters, a v1 torrent by its v1 infohash, and
 *   `torrents/info?hashes=` matches nothing else, not even the full v2 hash.
 *   The id is computed here from the torrent's own bytes.
 * - **Layout.** `contentLayout=NoSubfolder` puts the files directly in the
 *   directory given, so the torrent's name need not match the band's.
 *   `autoTMM=false` stops qBittorrent's automatic management from moving
 *   them to its default save path.
 * - **Adds are asynchronous.** The add call returns before the torrent is
 *   listed, so both add and remove wait for the listing to agree.
 * - **Auth.** Either a cookie from `auth/login`, or none at all when the
 *   engine allows the sidecar's subnet without one. A 403 triggers one login
 *   and one retry; a 401 is the engine's Host header check, not a login
 *   problem, and is reported as that.
 */
import { Logger } from 'winston';

import { torrentIds } from '../torrent.js';
import { TorrentState, TorrentStatus, TorrentTransport } from './types.js';

/**
 * qBittorrent answers 403 to a request that needs a login, and 401 to one
 * its Host header validation refuses: a Host whose port or name differs from
 * what the Web UI listens on, which is what publishing its port under a
 * different number looks like. Seen from here the 401 is otherwise a
 * baffling "Unauthorized" on every call, including the login.
 */
const HOST_HEADER_REJECTED =
  'qBittorrent refused the request (HTTP 401) before checking credentials: it is ' +
  'being reached at a different host name or port than it listens on, which its ' +
  'Host header validation rejects. Reach it at its own port, or set ' +
  'WebUI\\ServerDomains or WebUI\\HostHeaderValidation in its configuration.';

/** qBittorrent's state strings, as of Web API 2.15, onto ours. */
const STATES: Record<string, TorrentState> = {
  allocating: 'downloading',
  downloading: 'downloading',
  metaDL: 'downloading',
  forcedMetaDL: 'downloading',
  forcedDL: 'downloading',
  stalledDL: 'downloading',
  queuedDL: 'downloading',
  uploading: 'seeding',
  forcedUP: 'seeding',
  stalledUP: 'seeding',
  queuedUP: 'seeding',
  checkingDL: 'checking',
  checkingUP: 'checking',
  checkingResumeData: 'checking',
  moving: 'checking',
  stoppedDL: 'stopped',
  stoppedUP: 'stopped',
  pausedDL: 'stopped',
  pausedUP: 'stopped',
  error: 'error',
  missingFiles: 'error',
  unknown: 'error',
};

export function mapState(state: string): TorrentState {
  return STATES[state] ?? 'error';
}

/** The id qBittorrent uses for a torrent, from the torrent's bytes. */
export function qbittorrentId(torrent: Buffer): string {
  const ids = torrentIds(torrent);
  return ids.infohashV2 !== undefined
    ? ids.infohashV2.slice(0, 40)
    : ids.infohashV1;
}

export interface QBittorrentTransportOptions {
  /** Base URL of the Web API, e.g. `http://index-swarm-engine:8080`. */
  url: string;
  username?: string;
  password?: string;
  log?: Logger;
  /** Per-request timeout for everything except the availability check. */
  requestTimeoutMs?: number;
  /** How long `isAvailable` waits before answering false. */
  availabilityTimeoutMs?: number;
  /** How long add and remove wait for the engine's listing to agree. */
  settleTimeoutMs?: number;
}

export class QBittorrentTransport implements TorrentTransport {
  private readonly base: string;
  private readonly username?: string;
  private readonly password?: string;
  private readonly log?: Logger;
  private readonly requestTimeoutMs: number;
  private readonly availabilityTimeoutMs: number;
  private readonly settleTimeoutMs: number;
  private cookie: string | undefined;

  constructor(options: QBittorrentTransportOptions) {
    this.base = options.url.replace(/\/+$/, '');
    this.username = options.username;
    this.password = options.password;
    this.log = options.log?.child({ class: 'QBittorrentTransport' });
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.availabilityTimeoutMs = options.availabilityTimeoutMs ?? 2_000;
    this.settleTimeoutMs = options.settleTimeoutMs ?? 10_000;
  }

  private async login(timeoutMs: number): Promise<void> {
    if (this.username === undefined || this.password === undefined) {
      throw new Error(
        'qBittorrent refused the request and no credentials are configured',
      );
    }
    const response = await fetch(`${this.base}/api/v2/auth/login`, {
      method: 'POST',
      body: new URLSearchParams({
        username: this.username,
        password: this.password,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await response.text()).trim();
    const setCookie = response.headers.get('set-cookie');
    // Success is 204 and a QBT_SID_<port> cookie on 5.x, 200 "Ok." and SID
    // on 4.x. A refusal is 401 on 5.x (wrong credentials, or the Host header
    // check) and 200 "Fails." on 4.x. None of it is retried: qBittorrent
    // bans an address after repeated failed logins.
    if (!response.ok || body === 'Fails.' || setCookie === null) {
      throw new Error(
        `qBittorrent login refused (HTTP ${response.status}): check ` +
          'INDEX_SWARM_ENGINE_AUTH, and that the engine is reached at the host ' +
          'name and port it listens on',
      );
    }
    this.cookie = setCookie.split(';')[0];
    this.log?.debug('Logged in to qBittorrent', { url: this.base });
  }

  /** One API call, logging in once if the engine asks for it. */
  private async call(
    path: string,
    init: { method?: 'GET' | 'POST'; body?: FormData | URLSearchParams } = {},
    timeoutMs = this.requestTimeoutMs,
  ): Promise<Response> {
    const attempt = () =>
      fetch(`${this.base}/api/v2/${path}`, {
        method: init.method ?? 'GET',
        ...(init.body !== undefined ? { body: init.body } : {}),
        headers: this.cookie !== undefined ? { cookie: this.cookie } : {},
        signal: AbortSignal.timeout(timeoutMs),
      });
    let response = await attempt();
    if (response.status === 401) {
      // Not a login problem, so logging in cannot fix it.
      await response.body?.cancel();
      throw new Error(HOST_HEADER_REJECTED);
    }
    if (response.status === 403) {
      await response.body?.cancel();
      await this.login(timeoutMs);
      response = await attempt();
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `qBittorrent ${path}: HTTP ${response.status} ${text.slice(0, 200)}`,
      );
    }
    return response;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await this.call(
        'app/webapiVersion',
        {},
        this.availabilityTimeoutMs,
      );
      return /^2\./.test((await response.text()).trim());
    } catch {
      return false;
    }
  }

  private async addTorrent(torrent: Buffer, savePath: string) {
    const id = qbittorrentId(torrent);
    if ((await this.status(id)) !== undefined) return { id };

    const form = new FormData();
    form.append(
      'torrents',
      new Blob([new Uint8Array(torrent)], { type: 'application/x-bittorrent' }),
      `${id}.torrent`,
    );
    form.append('savepath', savePath);
    form.append('contentLayout', 'NoSubfolder');
    form.append('autoTMM', 'false');
    form.append('stopped', 'false');
    const response = await this.call('torrents/add', {
      method: 'POST',
      body: form,
    });
    const text = await response.text();
    if (text.trim() === 'Fails.') {
      throw new Error('qBittorrent rejected the torrent');
    }

    await this.waitFor(id, (status) => status !== undefined);
    return { id };
  }

  idFor(torrent: Buffer): string {
    return qbittorrentId(torrent);
  }

  async add({
    torrent,
    downloadDir,
  }: {
    torrent: Buffer;
    downloadDir: string;
  }) {
    return this.addTorrent(torrent, downloadDir);
  }

  async seed({ torrent, dir }: { torrent: Buffer; dir: string }) {
    // Adding a torrent whose files are complete makes qBittorrent verify
    // them and then seed, which is exactly what seeding needs.
    return this.addTorrent(torrent, dir);
  }

  async status(id: string): Promise<TorrentStatus | undefined> {
    const response = await this.call(
      `torrents/info?hashes=${encodeURIComponent(id)}`,
    );
    const list = (await response.json()) as Array<Record<string, unknown>>;
    const t = list[0];
    if (t === undefined) return undefined;
    const state = mapState(String(t.state));
    return {
      state,
      progress: Number(t.progress),
      peers: Number(t.num_seeds ?? 0) + Number(t.num_leechs ?? 0),
      // The all-time counters are updated only when qBittorrent saves resume
      // data; the session ones move as bytes do. A seeder that had served a
      // whole band still reported 0 all-time uploaded, so take whichever
      // is larger.
      bytesDown: Math.max(
        Number(t.downloaded ?? 0),
        Number(t.downloaded_session ?? 0),
      ),
      bytesUp: Math.max(
        Number(t.uploaded ?? 0),
        Number(t.uploaded_session ?? 0),
      ),
      ...(state === 'error' ? { error: String(t.state) } : {}),
      ...(typeof t.save_path === 'string'
        ? { savePath: t.save_path.replace(/\/+$/, '') }
        : {}),
    };
  }

  async setWebSeeds(id: string, urls: string[]): Promise<void> {
    const response = await this.call(
      `torrents/webseeds?hash=${encodeURIComponent(id)}`,
    );
    const current = ((await response.json()) as Array<{ url: string }>).map(
      (w) => w.url,
    );
    const drop = current.filter((u) => !urls.includes(u));
    const add = urls.filter((u) => !current.includes(u));
    if (drop.length > 0) {
      await this.call('torrents/removeWebSeeds', {
        method: 'POST',
        body: new URLSearchParams({ hash: id, urls: drop.join('|') }),
      });
    }
    if (add.length > 0) {
      await this.call('torrents/addWebSeeds', {
        method: 'POST',
        body: new URLSearchParams({ hash: id, urls: add.join('|') }),
      });
    }
  }

  async remove(id: string, opts: { deleteData?: boolean } = {}): Promise<void> {
    await this.call('torrents/delete', {
      method: 'POST',
      body: new URLSearchParams({
        hashes: id,
        deleteFiles: opts.deleteData === true ? 'true' : 'false',
      }),
    });
    await this.waitFor(id, (status) => status === undefined);
  }

  private async waitFor(
    id: string,
    done: (status: TorrentStatus | undefined) => boolean,
  ): Promise<void> {
    const deadline = Date.now() + this.settleTimeoutMs;
    for (;;) {
      if (done(await this.status(id))) return;
      if (Date.now() > deadline) {
        throw new Error(`qBittorrent did not settle on torrent ${id}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
