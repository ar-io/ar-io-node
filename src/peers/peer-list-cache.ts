/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import fs from 'node:fs';
import path from 'node:path';

const CACHE_VERSION = 1;

/**
 * What the gateway registry says about a peer, kept from the same read that
 * supplies its URL. Public on-chain data, surfaced so that a consumer of the
 * peer list (the index-swarm sidecar, a client choosing gateways) does not
 * have to read the registry again itself.
 */
export interface PeerRegistryRecord {
  /** The gateway's registered wallet. */
  wallet: string;
  /** The key the gateway observes and signs with. */
  observerAddress?: string;
  /** The operator's own stake, as the registry reports it. */
  operatorStake?: number;
  status?: string;
}

/**
 * The AR.IO peer list as last fetched from the gateway registry, kept on
 * disk so a gateway that restarts while the registry is unreachable starts
 * with its previous peers instead of none.
 */
export interface PeerListSnapshot {
  /** When the list was fetched, in ms since the epoch. */
  writtenAt: number;
  /** Peer URL by wallet. */
  peers: Record<string, string>;
  /** Registry fields by wallet. */
  records: Record<string, PeerRegistryRecord>;
  /** This node's own registry entry, when its wallet was registered. */
  self?: PeerRegistryRecord & { url: string };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPeerUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function parseRecord(
  wallet: string,
  value: unknown,
): PeerRegistryRecord | undefined {
  if (!isObject(value) || value.wallet !== wallet) return undefined;
  return {
    wallet,
    ...(typeof value.observerAddress === 'string'
      ? { observerAddress: value.observerAddress }
      : {}),
    ...(typeof value.operatorStake === 'number'
      ? { operatorStake: value.operatorStake }
      : {}),
    ...(typeof value.status === 'string' ? { status: value.status } : {}),
  };
}

/**
 * Parse a cache file's contents. Returns undefined for anything that is not
 * a version-1 snapshot; within one, entries that are malformed (a URL that is
 * not http(s), a record for another wallet) are dropped rather than failing
 * the whole file.
 */
export function parsePeerListSnapshot(
  text: string,
): PeerListSnapshot | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    !isObject(value) ||
    value.version !== CACHE_VERSION ||
    typeof value.writtenAt !== 'number' ||
    !Number.isFinite(value.writtenAt) ||
    !isObject(value.peers)
  ) {
    return undefined;
  }

  const peers: Record<string, string> = {};
  const records: Record<string, PeerRegistryRecord> = {};
  const rawRecords = isObject(value.records) ? value.records : {};
  for (const [wallet, url] of Object.entries(value.peers)) {
    if (!isPeerUrl(url)) continue;
    peers[wallet] = url;
    const record = parseRecord(wallet, rawRecords[wallet]);
    if (record !== undefined) records[wallet] = record;
  }

  let self: PeerListSnapshot['self'];
  if (isObject(value.self) && typeof value.self.wallet === 'string') {
    const record = parseRecord(value.self.wallet, value.self);
    if (record !== undefined && isPeerUrl(value.self.url)) {
      self = { ...record, url: value.self.url };
    }
  }

  return {
    writtenAt: value.writtenAt,
    peers,
    records,
    ...(self !== undefined ? { self } : {}),
  };
}

/**
 * Read the snapshot at `filePath`. A missing, unreadable or malformed file
 * reads as undefined: the cache is only ever a fallback.
 */
export function readPeerListSnapshot(
  filePath: string,
): PeerListSnapshot | undefined {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
  return parsePeerListSnapshot(text);
}

/**
 * Write the snapshot to `filePath` atomically: to a temporary file in the
 * same directory, then renamed over the old one, so a crash mid-write
 * leaves the previous file rather than a truncated one.
 */
export async function writePeerListSnapshot(
  filePath: string,
  snapshot: PeerListSnapshot,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const body = JSON.stringify({ version: CACHE_VERSION, ...snapshot });
  try {
    await fs.promises.writeFile(tmpPath, body);
    await fs.promises.rename(tmpPath, filePath);
  } catch (error) {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Remove temporary files a crash left between writing and renaming. Each
 * write uses a unique name, so without this they would accumulate. Errors are
 * ignored: this is housekeeping.
 */
export function removeStalePeerListTempFiles(filePath: string): void {
  const dir = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.`;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(prefix) && name.endsWith('.tmp')) {
      try {
        fs.rmSync(path.join(dir, name), { force: true });
      } catch {
        // Ignored, see above.
      }
    }
  }
}
