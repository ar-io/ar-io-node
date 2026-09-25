/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Deterministic torrent construction for index bands.
 *
 * Two publishers that hold the same band must produce the same infohash, or
 * they seed two swarms for one set of bytes. Everything that goes into the
 * info dictionary is therefore a function of the files alone: files sorted by
 * name, a fixed piece length, no creation date, no "created by", and a name
 * the caller derives from the band. Trackers and WebSeeds sit outside the
 * info dictionary, so they can differ per publisher without changing it.
 *
 * Hybrid torrents (BEP 52 v2 plus a BEP 3 v1 view) are laid out exactly as
 * libtorrent 2 lays them out: every file, the last included, is followed by a
 * BEP 47 pad file up to the next piece boundary. The info dictionary this
 * produces is byte-identical to libtorrent 2.0.13's for the same files (the
 * tests pin infohashes libtorrent produced), so a band built here and one
 * built by libtorrent join the same swarm.
 *
 * Files are streamed, never read whole: a band partition can be a gigabyte.
 */
import crypto from 'node:crypto';
import * as net from 'node:net';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { bencode, BencodeValue, bdecodeWithSpans } from '../lib/bencode.js';

/** 4 MiB, the piece length the design fixes for every band. */
export const DEFAULT_PIECE_LENGTH = 4 * 1024 * 1024;

/** BEP 52 hashes files in 16 KiB blocks. */
const BLOCK = 16 * 1024;
const ZERO_HASH = Buffer.alloc(32);

export interface BuildTorrentOptions {
  /** Directory whose regular files, not subdirectories, make up the band. */
  dir: string;
  /** Torrent name. Part of the info dictionary, so part of the infohash. */
  name: string;
  /** `hybrid` (v1 + v2, the default) or `v1`. */
  format?: 'hybrid' | 'v1';
  pieceLength?: number;
  /** BEP 19 WebSeed URLs, outside the info dictionary. */
  webSeeds?: string[];
  /** Tracker URLs, outside the info dictionary. The first is `announce`. */
  trackers?: string[];
  /** Only these file names, when given; otherwise every file in `dir`. */
  files?: string[];
  /**
   * BEP 27 private flag. Inside the info dictionary, so it changes the
   * infohash: publishers that want one swarm must agree on it.
   */
  private?: boolean;
}

export interface TorrentIds {
  /** SHA-1 of the info dictionary, lowercase hex. */
  infohashV1: string;
  /** SHA-256 of the info dictionary, for a hybrid or v2 torrent. */
  infohashV2?: string;
}

export interface BuiltTorrent extends TorrentIds {
  torrent: Buffer;
  name: string;
  pieceLength: number;
  pieces: number;
}

/** Streams v1 pieces: SHA-1 over the concatenated files and pads. */
class V1Pieces {
  private readonly hashes: Buffer[] = [];
  private hash = crypto.createHash('sha1');
  private filled = 0;

  constructor(private readonly pieceLength: number) {}

  update(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      const take = Math.min(
        this.pieceLength - this.filled,
        chunk.length - offset,
      );
      this.hash.update(chunk.subarray(offset, offset + take));
      this.filled += take;
      offset += take;
      if (this.filled === this.pieceLength) this.flush();
    }
  }

  pad(length: number): void {
    // Pads are never longer than one piece, so this allocation is bounded.
    this.update(Buffer.alloc(length));
  }

  private flush(): void {
    this.hashes.push(this.hash.digest());
    this.hash = crypto.createHash('sha1');
    this.filled = 0;
  }

  finish(): Buffer {
    if (this.filled > 0) this.flush();
    return Buffer.concat(this.hashes);
  }
}

/**
 * BEP 52 per-file merkle tree over 16 KiB blocks. Leaves beyond the end of
 * the file are zero hashes, and the tree is padded to a power of two.
 *
 * Returns the root and, for a file longer than one piece, the piece layer:
 * the tree level whose nodes each cover one piece, trimmed to the file.
 */
function merkle(
  leaves: Buffer[],
  fileLength: number,
  pieceLength: number,
): { root: Buffer; pieceLayer?: Buffer } {
  const perPiece = pieceLength / BLOCK;
  let width = 1;
  while (width < leaves.length) width *= 2;
  let layer = leaves.concat(
    Array.from({ length: width - leaves.length }, () => ZERO_HASH),
  );
  let covered = 1;
  let pieceLayer: Buffer[] | undefined =
    covered === perPiece ? layer : undefined;
  while (layer.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      next.push(
        crypto
          .createHash('sha256')
          .update(layer[i])
          .update(layer[i + 1])
          .digest(),
      );
    }
    layer = next;
    covered *= 2;
    if (covered === perPiece) pieceLayer = layer;
  }
  if (fileLength <= pieceLength) return { root: layer[0] };
  const pieces = Math.ceil(fileLength / pieceLength);
  return {
    root: layer[0],
    pieceLayer: Buffer.concat((pieceLayer ?? []).slice(0, pieces)),
  };
}

/** Read one file once, feeding both the v1 pieces and its v2 leaves. */
async function hashFile(
  filePath: string,
  v1: V1Pieces,
  wantLeaves: boolean,
): Promise<{ length: number; leaves: Buffer[] }> {
  const leaves: Buffer[] = [];
  let block = crypto.createHash('sha256');
  let inBlock = 0;
  let length = 0;
  for await (const chunk of createReadStream(filePath, {
    highWaterMark: 1024 * 1024,
  }) as AsyncIterable<Buffer>) {
    v1.update(chunk);
    length += chunk.length;
    if (!wantLeaves) continue;
    let offset = 0;
    while (offset < chunk.length) {
      const take = Math.min(BLOCK - inBlock, chunk.length - offset);
      block.update(chunk.subarray(offset, offset + take));
      inBlock += take;
      offset += take;
      if (inBlock === BLOCK) {
        leaves.push(block.digest());
        block = crypto.createHash('sha256');
        inBlock = 0;
      }
    }
  }
  if (wantLeaves && (inBlock > 0 || leaves.length === 0)) {
    leaves.push(block.digest());
  }
  return { length, leaves };
}

/** Build a torrent for a band directory. */
export async function buildTorrent(
  options: BuildTorrentOptions,
): Promise<BuiltTorrent> {
  const format = options.format ?? 'hybrid';
  const pieceLength = options.pieceLength ?? DEFAULT_PIECE_LENGTH;
  if (pieceLength < BLOCK || (pieceLength & (pieceLength - 1)) !== 0) {
    throw new Error('piece length must be a power of two of at least 16 KiB');
  }

  let names = options.files;
  if (names === undefined) {
    const entries = await fs.readdir(options.dir, { withFileTypes: true });
    names = entries.filter((e) => e.isFile()).map((e) => e.name);
  }
  // Sorted by raw bytes, the order BEP 52's file tree imposes, so the v1
  // file list and the v2 tree describe the files in the same order.
  names = [...names].sort((a, b) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  );
  if (names.length === 0) throw new Error(`no files in ${options.dir}`);

  const hybrid = format === 'hybrid';
  const v1 = new V1Pieces(pieceLength);
  const files: BencodeValue[] = [];
  const fileTree: { [name: string]: BencodeValue } = {};
  const pieceLayers: { [root: string]: BencodeValue } = {};

  for (const name of names) {
    const { length, leaves } = await hashFile(
      path.join(options.dir, name),
      v1,
      hybrid,
    );
    files.push({ length, path: [name] });
    if (!hybrid) continue;

    const entry: { [key: string]: BencodeValue } = { length };
    if (length > 0) {
      const { root, pieceLayer } = merkle(leaves, length, pieceLength);
      entry['pieces root'] = root;
      if (pieceLayer !== undefined) {
        pieceLayers[root.toString('latin1')] = pieceLayer;
      }
    }
    fileTree[name] = { '': entry };

    const remainder = length % pieceLength;
    if (remainder !== 0) {
      const pad = pieceLength - remainder;
      v1.pad(pad);
      files.push({ attr: 'p', length: pad, path: ['.pad', String(pad)] });
    }
  }

  const info: { [key: string]: BencodeValue } = {
    files,
    name: options.name,
    'piece length': pieceLength,
    pieces: v1.finish(),
  };
  if (hybrid) {
    info['file tree'] = fileTree;
    info['meta version'] = 2;
  }
  if (options.private === true) info.private = 1;

  const torrent: { [key: string]: BencodeValue } = { info };
  const trackers = options.trackers ?? [];
  if (trackers.length > 0) {
    torrent.announce = trackers[0];
    if (trackers.length > 1)
      torrent['announce-list'] = trackers.map((t) => [t]);
  }
  if ((options.webSeeds ?? []).length > 0) {
    torrent['url-list'] = options.webSeeds as string[];
  }
  if (hybrid) torrent['piece layers'] = pieceLayers;

  const bytes = bencode(torrent);
  const ids = torrentIds(bytes);
  return {
    torrent: bytes,
    name: options.name,
    pieceLength,
    pieces: (info.pieces as Buffer).length / 20,
    ...ids,
  };
}

/**
 * The infohashes of a torrent, computed over the info dictionary exactly as
 * it appears in the file rather than as re-encoded, so a torrent built
 * elsewhere hashes the way every other client will hash it.
 */
export function torrentIds(torrent: Buffer): TorrentIds {
  const { value, spans } = bdecodeWithSpans(torrent);
  const span = spans.get('info');
  if (
    span === undefined ||
    typeof value !== 'object' ||
    Buffer.isBuffer(value)
  ) {
    throw new Error('not a torrent: no info dictionary');
  }
  const infoBytes = torrent.subarray(span[0], span[1]);
  const info = (value as { [key: string]: BencodeValue }).info as {
    [key: string]: BencodeValue;
  };
  const v2 = info['meta version'] === 2;
  return {
    infohashV1: crypto.createHash('sha1').update(infoBytes).digest('hex'),
    ...(v2
      ? {
          infohashV2: crypto
            .createHash('sha256')
            .update(infoBytes)
            .digest('hex'),
        }
      : {}),
  };
}

/** Whether a tracker URL may be handed to the engine. */
export function isAllowedTrackerUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (!['http:', 'https:', 'udp:'].includes(url.protocol)) return false;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    host.length === 0 ||
    host === 'localhost' ||
    host.endsWith('.localhost')
  ) {
    return false;
  }
  if (net.isIP(host) !== 0) return !isPrivateAddress(host);
  // A single-label name (`core`, `observer`) resolves on the compose
  // network, not on the internet.
  return (
    host.includes('.') &&
    !host.endsWith('.internal') &&
    !host.endsWith('.local')
  );
}

/** Loopback, private, link-local, CGNAT, unspecified and multicast ranges. */
function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  // IPv4-mapped, dotted or in the hex form the URL parser normalizes to.
  const dotted = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted !== null) return isPrivateAddress(dotted[1]);
  const hex = v6.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex !== null) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return isPrivateAddress(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  return /^(fc|fd|fe[89ab]|ff)/.test(v6);
}

/**
 * The part of a publisher's `.torrent` this node is willing to hand its
 * engine: the info dictionary and v2 piece layers, byte for byte, and only
 * the trackers on public hosts.
 *
 * Everything outside `info` is unsigned: the publication signs the
 * infohashes, which cover `info` and nothing else. So a hostile publisher
 * could otherwise point the engine's tracker announces or WebSeeds (BEP 19
 * `url-list`, BEP 17 `httpseeds`) at services on this node's network. The
 * subscriber adds the one WebSeed it trusts, the publisher's own, itself.
 *
 * @throws when the result's infohashes are not the expected ones, which
 *   would mean the info dictionary did not survive intact.
 */
export function sanitizeTorrent(
  torrent: Buffer,
  expected: TorrentIds,
  /**
   * Announce URLs kept even on a private host, exactly as written: an
   * operator's own tracker on a LAN or private network.
   */
  allowedTrackers: ReadonlySet<string> = new Set(),
): Buffer {
  const allowed = (u: string) =>
    allowedTrackers.has(u) || isAllowedTrackerUrl(u);
  const { value, spans } = bdecodeWithSpans(torrent);
  if (
    typeof value !== 'object' ||
    Buffer.isBuffer(value) ||
    Array.isArray(value)
  ) {
    throw new Error('not a torrent');
  }
  const top = value as { [key: string]: BencodeValue };
  const raw = (k: string): Buffer | undefined => {
    const span = spans.get(k);
    return span === undefined ? undefined : torrent.subarray(span[0], span[1]);
  };
  const info = raw('info');
  if (info === undefined) throw new Error('not a torrent: no info dictionary');

  const text = (v: BencodeValue | undefined): string | undefined =>
    Buffer.isBuffer(v) ? v.toString('utf8') : undefined;
  const announce = text(top['announce']);
  const tiers: string[][] = [];
  const list = top['announce-list'];
  if (Array.isArray(list)) {
    for (const tier of list) {
      if (!Array.isArray(tier)) continue;
      const kept = tier
        .map((entry) => text(entry))
        .filter((u): u is string => u !== undefined && allowed(u));
      if (kept.length > 0) tiers.push(kept);
    }
  }

  // Keys in sorted order, as bencode requires: announce, announce-list,
  // info, piece layers.
  const parts: Buffer[] = [Buffer.from('d')];
  if (announce !== undefined && allowed(announce)) {
    parts.push(bencode('announce'), bencode(Buffer.from(announce)));
  }
  if (tiers.length > 0) {
    parts.push(
      bencode('announce-list'),
      bencode(tiers.map((tier) => tier.map((u) => Buffer.from(u)))),
    );
  }
  parts.push(bencode('info'), info);
  const layers = raw('piece layers');
  if (layers !== undefined) parts.push(bencode('piece layers'), layers);
  parts.push(Buffer.from('e'));
  const out = Buffer.concat(parts);

  const ids = torrentIds(out);
  if (
    ids.infohashV1 !== expected.infohashV1 ||
    (expected.infohashV2 !== undefined &&
      ids.infohashV2 !== expected.infohashV2)
  ) {
    throw new Error('sanitizing changed the infohash');
  }
  return out;
}
