/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * A closed BitTorrent HTTP tracker (BEP 3, with BEP 23 compact and BEP 7
 * IPv6 peer lists), for the bands this node publishes and nothing else.
 *
 * Closed is the point. qBittorrent's embedded tracker, the obvious
 * alternative, tracks any infohash anyone announces: on a published port it
 * would make every gateway a free public tracker for arbitrary swarms, and
 * the gateway's address would appear in them. This one answers only for the
 * infohashes the publisher is offering right now and refuses the rest with
 * the standard "unregistered torrent" failure.
 *
 * State is in memory and rebuilt by announces: after a restart, peers are
 * back within one announce interval, and subscribers turn on the WebSeed if
 * a download stalls meanwhile.
 */
import * as http from 'node:http';
import { Logger } from 'winston';

import { bencode } from '../lib/bencode.js';
import { isIpInCidr } from '../lib/ip-utils.js';
import { isPrivateAddress } from './torrent.js';
import { trackerAnnounces, trackerPeers } from './metrics.js';

export interface ClosedTrackerOptions {
  log: Logger;
  /**
   * The infohashes this tracker answers for, as 40-character lowercase hex:
   * the v1 infohash and, for a hybrid torrent, the first 20 bytes of the v2
   * one, since a hybrid torrent is announced under both. Consulted on every
   * announce, so it can change as bands come and go.
   */
  allowed: () => Set<string>;
  /** Seconds between announces asked of clients. */
  intervalSeconds?: number;
  /** Most peers returned per announce. */
  maxPeers?: number;
  /**
   * Most peers kept per torrent; the least recently seen goes first. The
   * port is published to the internet, and each entry costs memory and a
   * share of every response, so the table must not grow on demand.
   */
  maxPeersPerSwarm?: number;
  /**
   * Most ports one address may hold in one torrent's peer list. An IPv6
   * address counts by its /64, which one host can hold whole.
   */
  maxPortsPerIp?: number;
  /**
   * Announces one address (an IPv6 /64) may make per minute for one
   * torrent before it is refused. Per torrent, because an honest engine
   * announces each torrent it holds separately.
   */
  maxAnnouncesPerMinute?: number;
  /**
   * This node's address as peers reach it: the host of its tracker URL.
   * An announce from a private address is this node's own engine, reached
   * back through Docker's NAT, and is recorded under this address instead;
   * otherwise the publisher, often the only seeder, would be handed out at a
   * Docker network address nobody can reach.
   */
  selfAddress?: () => string | undefined;
  /**
   * Proxies (IPs or CIDRs) whose `X-Forwarded-For` is believed, for a
   * tracker served behind a load balancer. Without it every peer would
   * appear at the proxy's address.
   */
  trustedProxies?: string[];
  now?: () => number;
}

interface Peer {
  ip: string;
  port: number;
  seeding: boolean;
  seenAt: number;
}

/**
 * Parse a query string without text-decoding it: `info_hash` and `peer_id`
 * are raw bytes, which URL parsers decode as UTF-8 and corrupt.
 */
export function parseAnnounceQuery(query: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const part of query.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    let key: string;
    try {
      key = decodeURIComponent(eq < 0 ? part : part.slice(0, eq));
    } catch {
      continue;
    }
    const raw = eq < 0 ? '' : part.slice(eq + 1);
    const bytes: number[] = [];
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (
        c === '%' &&
        i + 2 < raw.length &&
        /^[0-9a-fA-F]{2}$/.test(raw.slice(i + 1, i + 3))
      ) {
        bytes.push(parseInt(raw.slice(i + 1, i + 3), 16));
        i += 2;
      } else if (c === '+') {
        bytes.push(0x20);
      } else {
        bytes.push(c.charCodeAt(0) & 0xff);
      }
    }
    out.set(key, Buffer.from(bytes));
  }
  return out;
}

const failure = (reason: string) => bencode({ 'failure reason': reason });

/** Strip the IPv4-mapped IPv6 prefix Node reports for IPv4 clients. */
function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function compactPeer(peer: Peer): { v4?: Buffer; v6?: Buffer } {
  const port = Buffer.alloc(2);
  port.writeUInt16BE(peer.port);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(peer.ip)) {
    return {
      v4: Buffer.concat([Buffer.from(peer.ip.split('.').map(Number)), port]),
    };
  }
  // Expand an IPv6 address to its 16 bytes.
  const [head, tail = ''] = peer.ip.split('::');
  const h = head === '' ? [] : head.split(':');
  const t = tail === '' ? [] : tail.split(':');
  const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  if (groups.length !== 8) return {};
  const bytes = Buffer.alloc(16);
  groups.forEach((g, i) => bytes.writeUInt16BE(parseInt(g, 16) || 0, i * 2));
  return { v6: Buffer.concat([bytes, port]) };
}

/**
 * What rate limits and port caps count by: an IPv4 address, or an IPv6
 * address's /64, since one host is routinely given a whole /64.
 */
function addressBucket(ip: string): string {
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.split('::');
  const h = head === '' ? [] : head.split(':');
  const t = tail === '' ? [] : tail.split(':');
  const groups = [
    ...h,
    ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'),
    ...t,
  ];
  return groups
    .slice(0, 4)
    .map((g) => (parseInt(g, 16) || 0).toString(16))
    .join(':');
}

export class ClosedTracker {
  private readonly log: Logger;
  private readonly allowed: () => Set<string>;
  private readonly intervalSeconds: number;
  private readonly maxPeers: number;
  private readonly maxPeersPerSwarm: number;
  private readonly maxPortsPerIp: number;
  private readonly maxAnnouncesPerMinute: number;
  private readonly selfAddress: () => string | undefined;
  private readonly trustedProxies: string[];
  private readonly now: () => number;
  /**
   * infohash hex, then `ip:port`, to the peer. Each map is in the order
   * peers were last seen, oldest first, which is what eviction relies on.
   */
  private readonly swarms = new Map<string, Map<string, Peer>>();
  /** Announces per address in the current minute. */
  private readonly announcesByIp = new Map<string, number>();
  private windowStartedAt = 0;
  private lastExpiredAt = 0;

  constructor(options: ClosedTrackerOptions) {
    this.log = options.log.child({ class: 'ClosedTracker' });
    this.allowed = options.allowed;
    this.intervalSeconds = options.intervalSeconds ?? 300;
    this.maxPeers = options.maxPeers ?? 50;
    this.maxPeersPerSwarm = options.maxPeersPerSwarm ?? 2000;
    this.maxPortsPerIp = options.maxPortsPerIp ?? 4;
    this.maxAnnouncesPerMinute = options.maxAnnouncesPerMinute ?? 10;
    this.selfAddress = options.selfAddress ?? (() => undefined);
    this.trustedProxies = options.trustedProxies ?? [];
    this.now = options.now ?? (() => Date.now());
  }

  /** Answer one announce. Returns the bencoded body. */
  announce(query: string, remoteAddress: string): Buffer {
    const params = parseAnnounceQuery(query);
    const infoHash = params.get('info_hash');
    const portRaw = params.get('port')?.toString('latin1');
    const port = portRaw !== undefined ? Number(portRaw) : NaN;
    if (infoHash === undefined || infoHash.length !== 20) {
      trackerAnnounces.inc({ result: 'malformed' });
      return failure('invalid info_hash');
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      trackerAnnounces.inc({ result: 'malformed' });
      return failure('invalid port');
    }
    const hex = infoHash.toString('hex');
    if (!this.allowed().has(hex)) {
      // The closed part: whatever anyone announces, only our bands are
      // tracked.
      trackerAnnounces.inc({ result: 'unregistered' });
      return failure('unregistered torrent');
    }
    let ip = normalizeIp(remoteAddress);
    if (isPrivateAddress(ip)) {
      const self = this.selfAddress();
      if (self !== undefined) ip = normalizeIp(self);
    }
    const bucket = addressBucket(ip);

    const now = this.now();
    if (now - this.windowStartedAt >= 60_000) {
      this.windowStartedAt = now;
      this.announcesByIp.clear();
    }
    const rateKey = `${bucket}|${hex}`;
    const count = (this.announcesByIp.get(rateKey) ?? 0) + 1;
    this.announcesByIp.set(rateKey, count);
    if (count > this.maxAnnouncesPerMinute) {
      trackerAnnounces.inc({ result: 'rate_limited' });
      return failure('slow down');
    }
    // Expiry walks every peer, so not on every announce.
    if (now - this.lastExpiredAt >= 30_000) {
      this.lastExpiredAt = now;
      this.expire(now);
    }
    let swarm = this.swarms.get(hex);
    if (swarm === undefined) {
      swarm = new Map();
      this.swarms.set(hex, swarm);
    }
    const key = `${ip}:${port}`;
    const event = params.get('event')?.toString('latin1');
    const left = Number(params.get('left')?.toString('latin1') ?? '1');
    // Deleted first either way, so a re-announce moves the peer to the end:
    // the map stays in last-seen order.
    swarm.delete(key);
    if (event !== 'stopped') {
      const sameIp = [...swarm.entries()].filter(
        ([, p]) => addressBucket(p.ip) === bucket,
      );
      const excess = Math.max(0, sameIp.length - this.maxPortsPerIp + 1);
      for (const [k] of sameIp.slice(0, excess)) {
        swarm.delete(k);
      }
      // Full: the least recently seen leecher goes first, so a flood of
      // fresh entries cannot push out the seeders a band depends on.
      while (swarm.size >= this.maxPeersPerSwarm) {
        let victim: string | undefined;
        for (const [k, p] of swarm) {
          if (!p.seeding) {
            victim = k;
            break;
          }
        }
        victim ??= swarm.keys().next().value;
        if (victim === undefined) break;
        swarm.delete(victim);
      }
      swarm.set(key, { ip, port, seeding: left === 0, seenAt: now });
    }

    // A random sample, so early entries cannot occupy every response.
    // A peer asking from the internet can use no private address.
    const askerPublic = !isPrivateAddress(ip);
    const pool = [...swarm.entries()]
      .filter(([k]) => k !== key)
      .map(([, p]) => p)
      .filter((p) => !askerPublic || !isPrivateAddress(p.ip));
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const others = pool.slice(0, this.maxPeers);
    const v4: Buffer[] = [];
    const v6: Buffer[] = [];
    for (const peer of others) {
      const c = compactPeer(peer);
      if (c.v4 !== undefined) v4.push(c.v4);
      if (c.v6 !== undefined) v6.push(c.v6);
    }
    const seeders = [...swarm.values()].filter((p) => p.seeding).length;
    trackerAnnounces.inc({ result: 'ok' });
    this.reportPeers();
    return bencode({
      complete: seeders,
      incomplete: swarm.size - seeders,
      interval: this.intervalSeconds,
      'min interval': Math.max(30, Math.floor(this.intervalSeconds / 4)),
      peers: Buffer.concat(v4),
      ...(v6.length > 0 ? { peers6: Buffer.concat(v6) } : {}),
    });
  }

  /** Forget peers that have missed two announces, and swarms no longer offered. */
  private expire(now: number): void {
    const allowed = this.allowed();
    const ttlMs = (this.intervalSeconds * 2 + 60) * 1000;
    for (const [hex, swarm] of this.swarms) {
      if (!allowed.has(hex)) {
        this.swarms.delete(hex);
        continue;
      }
      for (const [key, peer] of swarm) {
        if (now - peer.seenAt > ttlMs) swarm.delete(key);
      }
      if (swarm.size === 0) this.swarms.delete(hex);
    }
  }

  private reportPeers(): void {
    let total = 0;
    for (const swarm of this.swarms.values()) total += swarm.size;
    trackerPeers.set(total);
  }

  /**
   * The announcing peer's address: the socket's, or, from a trusted proxy,
   * the nearest `X-Forwarded-For` hop that is not itself a trusted proxy.
   */
  clientAddress(
    socketAddress: string,
    forwardedFor: string | string[] | undefined,
  ): string {
    const trusted = (ip: string) =>
      this.trustedProxies.some((cidr) =>
        cidr.includes('/') ? isIpInCidr(ip, cidr) : normalizeIp(cidr) === ip,
      );
    const socketIp = normalizeIp(socketAddress);
    if (!trusted(socketIp) || forwardedFor === undefined) return socketIp;
    const hops = (
      Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor
    )
      .split(',')
      .map((h) => normalizeIp(h.trim()))
      .filter((h) => h.length > 0);
    for (let i = hops.length - 1; i >= 0; i--) {
      if (!trusted(hops[i])) return hops[i];
    }
    return socketIp;
  }

  /** Serve it: `/announce` only; everything else is a 404. */
  listen(host: string, port: number): Promise<http.Server> {
    const server = http.createServer((req, res) => {
      const url = req.url ?? '/';
      const q = url.indexOf('?');
      const pathname = q < 0 ? url : url.slice(0, q);
      if (req.method !== 'GET' || pathname !== '/announce') {
        res.writeHead(404).end();
        return;
      }
      const body = this.announce(
        q < 0 ? '' : url.slice(q + 1),
        this.clientAddress(
          req.socket.remoteAddress ?? '',
          req.headers['x-forwarded-for'],
        ),
      );
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Length': String(body.length),
      });
      res.end(body);
    });
    // A published port: bound what any one client can hold open.
    server.maxConnections = 512;
    server.headersTimeout = 10_000;
    server.requestTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        this.log.info('Closed tracker listening', { host, port });
        resolve(server);
      });
    });
  }
}

/**
 * The infohashes a tracker should answer for, from a publication's bands:
 * each torrent's v1 infohash and the 20-byte prefix of its v2 infohash.
 */
export function trackedInfohashes(
  bands: Array<{ torrent?: { infohashV1: string; infohashV2?: string } }>,
): Set<string> {
  const out = new Set<string>();
  for (const band of bands) {
    if (band.torrent === undefined) continue;
    out.add(band.torrent.infohashV1);
    if (band.torrent.infohashV2 !== undefined) {
      out.add(band.torrent.infohashV2.slice(0, 40));
    }
  }
  return out;
}
