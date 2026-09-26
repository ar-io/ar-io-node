/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * An in-memory torrent engine, for tests.
 *
 * Transports attached to one `MemorySwarm` see each other: a torrent added on
 * one completes by copying the files of any transport seeding it, the way a
 * swarm of real engines would. A WebSeed can be simulated too, so tests can
 * exercise "no peers, so turn the WebSeed on". What it does not do is hash
 * pieces: a real engine rejects bad pieces, this copies whatever the seeder
 * holds, which is fine because the sidecar checks every file's SHA-256
 * against the signed publication after any transport, and tests that tamper
 * rely on exactly that.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { bdecode, BencodeValue } from '../../lib/bencode.js';
import { qbittorrentId } from './qbittorrent.js';
import { TorrentState, TorrentStatus, TorrentTransport } from './types.js';

interface TorrentFile {
  name: string;
  length: number;
}

interface Entry {
  role: 'seed' | 'download';
  dir: string;
  files: TorrentFile[];
  webSeeds: string[];
  state: TorrentState;
  bytesDown: number;
  bytesUp: number;
  error?: string;
}

/** The files a torrent names, pad files excluded, in torrent order. */
export function torrentFiles(torrent: Buffer): TorrentFile[] {
  const top = bdecode(torrent) as { [k: string]: BencodeValue };
  const info = top.info as { [k: string]: BencodeValue };
  const list = info.files as { [k: string]: BencodeValue }[] | undefined;
  if (list === undefined) {
    return [
      { name: (info.name as Buffer).toString(), length: info.length as number },
    ];
  }
  return list
    .filter((f) => (f.attr as Buffer | undefined)?.toString() !== 'p')
    .map((f) => ({
      name: (f.path as Buffer[]).map((p) => p.toString()).join('/'),
      length: f.length as number,
    }));
}

function webSeedsOf(torrent: Buffer): string[] {
  const top = bdecode(torrent) as { [k: string]: BencodeValue };
  const list = top['url-list'];
  if (list === undefined) return [];
  return (Array.isArray(list) ? list : [list]).map((u) =>
    (u as Buffer).toString(),
  );
}

export interface MemorySwarmOptions {
  /**
   * Serves a file from a WebSeed: given the WebSeed URL, the torrent name and
   * the file name, the bytes, or undefined when that WebSeed does not have
   * it. Unset, WebSeeds never deliver.
   */
  webSeed?: (
    url: string,
    torrentName: string,
    file: string,
  ) => Promise<Buffer | undefined>;
}

export class MemorySwarm {
  readonly transports = new Set<MemoryTransport>();

  constructor(readonly options: MemorySwarmOptions = {}) {}

  /** A seeding copy of `id` somewhere in the swarm, other than `except`. */
  seederOf(id: string, except: MemoryTransport): Entry | undefined {
    for (const transport of this.transports) {
      if (transport === except || !transport.available) continue;
      const entry = transport.entry(id);
      if (entry?.state === 'seeding') return entry;
    }
    return undefined;
  }
}

export class MemoryTransport implements TorrentTransport {
  /** qBittorrent's rule, so tests catch any mix-up of id and v1 infohash. */
  idFor(torrent: Buffer): string {
    return qbittorrentId(torrent);
  }

  /** Set false to simulate the engine being down. */
  available = true;
  private readonly torrents = new Map<string, Entry & { name: string }>();

  constructor(private readonly swarm: MemorySwarm = new MemorySwarm()) {
    swarm.transports.add(this);
  }

  entry(id: string): Entry | undefined {
    return this.torrents.get(id);
  }

  private down(): never {
    throw new Error('engine unavailable');
  }

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async seed({ torrent, dir }: { torrent: Buffer; dir: string }) {
    if (!this.available) this.down();
    const id = qbittorrentId(torrent);
    if (this.torrents.has(id)) return { id };

    const files = torrentFiles(torrent);
    const entry = {
      role: 'seed' as const,
      dir,
      files,
      name: nameOf(torrent),
      webSeeds: webSeedsOf(torrent),
      state: 'checking' as TorrentState,
      bytesDown: 0,
      bytesUp: 0,
    } as Entry & { name: string };
    this.torrents.set(id, entry);

    // What a real engine's verification would catch at the file level.
    for (const file of files) {
      const stat = await fs
        .stat(path.join(dir, file.name))
        .catch(() => undefined);
      if (stat === undefined || stat.size !== file.length) {
        entry.state = 'error';
        entry.error = `missing or wrong-sized file: ${file.name}`;
        return { id };
      }
    }
    entry.state = 'seeding';
    return { id };
  }

  async add({
    torrent,
    downloadDir,
  }: {
    torrent: Buffer;
    downloadDir: string;
  }) {
    if (!this.available) this.down();
    const id = qbittorrentId(torrent);
    if (this.torrents.has(id)) return { id };

    this.torrents.set(id, {
      role: 'download',
      dir: downloadDir,
      files: torrentFiles(torrent),
      name: nameOf(torrent),
      webSeeds: webSeedsOf(torrent),
      state: 'downloading',
      bytesDown: 0,
      bytesUp: 0,
    });
    // Start the transfer after returning, as a real engine does.
    setImmediate(() => void this.tryComplete(id));
    return { id };
  }

  /** Complete a download from a seeder or a WebSeed, if one can serve it. */
  private async tryComplete(id: string): Promise<void> {
    const entry = this.torrents.get(id);
    if (entry === undefined || entry.state !== 'downloading') return;

    const seeder = this.swarm.seederOf(id, this);
    const source = async (file: string): Promise<Buffer | undefined> => {
      if (seeder !== undefined) {
        return fs.readFile(path.join(seeder.dir, file)).catch(() => undefined);
      }
      for (const url of entry.webSeeds) {
        const bytes = await this.swarm.options.webSeed?.(url, entry.name, file);
        if (bytes !== undefined) return bytes;
      }
      return undefined;
    };

    const fetched: Array<[string, Buffer]> = [];
    for (const file of entry.files) {
      const bytes = await source(file.name);
      if (bytes === undefined) return; // stays downloading, like a stalled torrent
      fetched.push([file.name, bytes]);
    }
    await fs.mkdir(entry.dir, { recursive: true });
    for (const [name, bytes] of fetched) {
      await fs.writeFile(path.join(entry.dir, name), bytes);
      entry.bytesDown += bytes.length;
      if (seeder !== undefined) seeder.bytesUp += bytes.length;
    }
    if (this.torrents.get(id) === entry) entry.state = 'seeding';
  }

  /** The global upload limit last set, for tests; 0 is unlimited. */
  uploadLimit = 0;
  /** Added to the upload counter, for tests. */
  extraUploaded = 0;

  async uploadedBytes(): Promise<number> {
    if (!this.available) this.down();
    let total = this.extraUploaded;
    for (const entry of this.torrents.values()) total += entry.bytesUp;
    return total;
  }

  async setUploadLimit(bytesPerSecond: number): Promise<void> {
    if (!this.available) this.down();
    this.uploadLimit = bytesPerSecond;
  }

  async list(): Promise<Array<{ id: string; savePath: string }>> {
    if (!this.available) this.down();
    return [...this.torrents.entries()].map(([id, entry]) => ({
      id,
      savePath: entry.dir.replace(/\/+$/, ''),
    }));
  }

  async status(id: string): Promise<TorrentStatus | undefined> {
    if (!this.available) this.down();
    const entry = this.torrents.get(id);
    if (entry === undefined) return undefined;
    // A stalled download retries on every look, so a seeder or WebSeed that
    // appears later is picked up, as a real engine would.
    if (entry.state === 'downloading') await this.tryComplete(id);
    const total = entry.files.reduce((sum, f) => sum + f.length, 0);
    const have =
      entry.state === 'seeding'
        ? total
        : entry.role === 'seed'
          ? 0
          : entry.bytesDown;
    return {
      state: entry.state,
      progress: total === 0 ? 1 : have / total,
      peers: this.swarm.seederOf(id, this) !== undefined ? 1 : 0,
      bytesDown: entry.bytesDown,
      bytesUp: entry.bytesUp,
      ...(entry.error !== undefined ? { error: entry.error } : {}),
      savePath: entry.dir.replace(/\/+$/, ''),
    };
  }

  async setWebSeeds(id: string, urls: string[]): Promise<void> {
    if (!this.available) this.down();
    const entry = this.torrents.get(id);
    if (entry === undefined) throw new Error(`unknown torrent ${id}`);
    entry.webSeeds = [...urls];
  }

  /** The WebSeeds a torrent currently has, for tests. */
  webSeeds(id: string): string[] {
    return [...(this.torrents.get(id)?.webSeeds ?? [])];
  }

  async remove(id: string, opts: { deleteData?: boolean } = {}): Promise<void> {
    if (!this.available) this.down();
    const entry = this.torrents.get(id);
    if (entry === undefined) return;
    this.torrents.delete(id);
    if (opts.deleteData === true) {
      for (const file of entry.files) {
        await fs.rm(path.join(entry.dir, file.name), { force: true });
      }
    }
  }
}

function nameOf(torrent: Buffer): string {
  const top = bdecode(torrent) as { [k: string]: BencodeValue };
  return (
    (top.info as { [k: string]: BencodeValue }).name as Buffer
  ).toString();
}
