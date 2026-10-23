/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The owners' keys of a `parquet-l2` band, one per distinct
 * `owner_address`, from the first place that has one:
 *
 * 1. the item source's own row (ClickHouse keeps `owner` for keys of at
 *    most 64 bytes, so not an Arweave RSA modulus);
 * 2. the gateway's `bundles.db` `wallets` table, opened read-only;
 * 3. the root transaction, read through the header-check gateway at a
 *    located item's owner offset (`root_parent_offset + owner_offset`,
 *    `owner_size` bytes).
 *
 * A key is kept only when its SHA-256 is the address. An owner with none is
 * counted and left out of `wallets`: the band still builds. A read the
 * gateway couldn't serve stops the band instead (see `gateway-reads.ts`),
 * so whether a key is in the band never depends on the network.
 *
 * Each window's owners are noted ({@link OwnerNotes}) into the build's
 * database, and resolved once from there ({@link resolveOwnerKeys}), so
 * memory follows a window, not the band's owners.
 */
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import Sqlite from 'better-sqlite3';
import type { Database } from 'duckdb-async';

import { toB64Url } from '../../../lib/encoding.js';
import type { GatewayReads } from './gateway-reads.js';

const sha256 = (bytes: Buffer) =>
  crypto.createHash('sha256').update(bytes).digest();

/** Where an owner's key could be read from the root. */
export interface KeyCandidate {
  rootTxId: Buffer;
  /** In the root's data. */
  offset: number;
  size: number;
}

/** Candidate reads kept per owner without a key. */
export const KEY_CANDIDATES = 3;
const SAMPLE = 20;

export interface OwnerKeyStats {
  owners: number;
  fromSource: number;
  fromWalletsDb: number;
  /** Keys taken from the `wallets` tables of the bands this one replaces. */
  fromReplaced: number;
  fromGateway: number;
  /** Owners left out of `wallets`: no key whose hash is their address. */
  withoutKey: number;
  /**
   * Why: a place to read it was `unreadable` (its root a 404); every place
   * read held something `wrong` (another key, or past the root); or there
   * was `nowhere` to read it (no located item of theirs).
   */
  withoutKeyBy: { unreadable: number; wrong: number; nowhere: number };
  withoutKeySample: string[];
  /** Keys a source held that don't hash to their address: ignored. */
  rejectedKeys: number;
}

/** The `bundles.db` lookup, or undefined when there is no such file. */
export function openWalletsDb(
  path: string | undefined,
):
  | { get: (address: Buffer) => Buffer | undefined; close: () => void }
  | undefined {
  if (path === undefined || !fs.existsSync(path)) return undefined;
  let db: Sqlite.Database;
  try {
    db = new Sqlite(path, { readonly: true, fileMustExist: true });
  } catch (error) {
    // A WAL database is read through the gateway's -wal and -shm files.
    throw new Error(
      `Cannot open ${path} read-only for owners' keys (INDEX_EXPORT_L2_WALLETS_DB): ${(error as Error).message}`,
    );
  }
  const statement = db
    .prepare('SELECT public_modulus FROM wallets WHERE address = ?')
    .pluck();
  return {
    get: (address) => {
      const key = statement.get(address) as Buffer | null | undefined;
      return key === null || key === undefined ? undefined : Buffer.from(key);
    },
    close: () => db.close(),
  };
}

/** The columns an owner note is stored with, in the build's database. */
export const OWNER_NOTE_COLUMNS = [
  { name: 'address', type: 'BLOB' },
  { name: 'key', type: 'BLOB' },
  { name: 'root', type: 'BLOB' },
  { name: 'offset', type: 'UBIGINT' },
  { name: 'size', type: 'UBIGINT' },
];

/**
 * One window's owners: per address, a key the source holds whose hash is
 * the address, or up to {@link KEY_CANDIDATES} places to read it from. A
 * window's notes go to the build's database (`rows`), so memory follows a
 * window, not the band.
 */
export class OwnerNotes {
  /** Keys a source held that don't hash to their address: ignored. */
  rejectedKeys = 0;
  private readonly notes = new Map<
    string,
    { key?: Buffer; candidates: KeyCandidate[] }
  >();

  /**
   * An item's owner: its address, the key its source row holds (if any),
   * and where its key sits in the root, for a located item.
   */
  note(address: Buffer, sourceKey?: Buffer, candidate?: KeyCandidate): void {
    const k = address.toString('latin1');
    let entry = this.notes.get(k);
    if (entry === undefined) {
      entry = { candidates: [] };
      this.notes.set(k, entry);
    }
    if (entry.key !== undefined) return;
    if (sourceKey !== undefined && sourceKey.length > 0) {
      if (sha256(sourceKey).equals(address)) {
        entry.key = sourceKey;
        entry.candidates = [];
        return;
      }
      this.rejectedKeys += 1;
    }
    if (candidate !== undefined && entry.candidates.length < KEY_CANDIDATES) {
      entry.candidates.push(candidate);
    }
  }

  /** The notes as rows of {@link OWNER_NOTE_COLUMNS}. */
  rows(): unknown[][] {
    const rows: unknown[][] = [];
    for (const [k, entry] of this.notes) {
      const address = Buffer.from(k, 'latin1');
      if (entry.key !== undefined) {
        rows.push([address, entry.key, null, null, null]);
      } else if (entry.candidates.length === 0) {
        rows.push([address, null, null, null, null]);
      } else {
        for (const c of entry.candidates) {
          rows.push([address, null, c.rootTxId, c.offset, c.size]);
        }
      }
    }
    return rows;
  }
}

/**
 * Every owner's key, from the notes in the build's database (`notes`, of
 * {@link OWNER_NOTE_COLUMNS}): the source's where one hashed to the
 * address, else `bundles.db`'s, else the first place in a root that reads
 * as it. Owners are streamed from the database and resolved a few at a
 * time, so memory doesn't follow the band's owners. Each key found is
 * handed to `write`, in batches.
 *
 * @throws ReadUnavailableError / ReadBudgetError from the reads.
 */
/**
 * The owners' keys the bands a build replaces hold, as a key source like
 * `bundles.db`'s: a key verifies itself (its SHA-256 is the address), so one
 * a published band carries is as good as one read from the root, and it
 * costs no read. A re-settle therefore keeps every key the bands it
 * replaces had, whatever the gateway can serve that day.
 */
export async function loadReplacedWallets(
  duck: Database,
  walletsFiles: string[],
): Promise<{ get: (address: Buffer) => Buffer | undefined; size: number }> {
  const keys = new Map<string, Buffer>();
  if (walletsFiles.length > 0) {
    const files = walletsFiles
      .map((file) => `'${file.replace(/'/g, "''")}'`)
      .join(', ');
    const rows = await duck.stream(
      `SELECT address, public_modulus FROM read_parquet([${files}])`,
    );
    for await (const row of rows) {
      const { address, public_modulus } = row as {
        address: Buffer;
        public_modulus: Buffer;
      };
      keys.set(
        Buffer.from(address).toString('latin1'),
        Buffer.from(public_modulus),
      );
    }
  }
  return {
    get: (address) => keys.get(address.toString('latin1')),
    size: keys.size,
  };
}

export async function resolveOwnerKeys(
  duck: Database,
  notes: string,
  {
    walletsDb,
    replaced,
    reads,
    write,
    concurrency = 32,
    batch = 10_000,
  }: {
    walletsDb?: { get: (address: Buffer) => Buffer | undefined };
    /** The replaced bands' keys ({@link loadReplacedWallets}), tried after `walletsDb`, before the roots. */
    replaced?: { get: (address: Buffer) => Buffer | undefined };
    reads?: GatewayReads;
    write: (rows: unknown[][]) => Promise<void>;
    concurrency?: number;
    batch?: number;
  },
): Promise<Omit<OwnerKeyStats, 'rejectedKeys'>> {
  const stats: Omit<OwnerKeyStats, 'rejectedKeys'> = {
    owners: 0,
    fromSource: 0,
    fromWalletsDb: 0,
    fromReplaced: 0,
    fromGateway: 0,
    withoutKey: 0,
    withoutKeyBy: { unreadable: 0, wrong: 0, nowhere: 0 },
    withoutKeySample: [],
  };
  let found: unknown[][] = [];
  const flush = async (force = false) => {
    if (found.length === 0 || (!force && found.length < batch)) return;
    const rows = found;
    found = [];
    await write(rows);
  };

  // The source's keys, whole.
  const sourceKeys = await duck.stream(
    `SELECT address, min("key") AS "key" FROM ${notes} WHERE "key" IS NOT NULL GROUP BY address`,
  );
  for await (const row of sourceKeys) {
    const { address, key } = row as { address: Buffer; key: Buffer };
    stats.owners += 1;
    stats.fromSource += 1;
    found.push([Buffer.from(address), Buffer.from(key)]);
    await flush();
  }

  // The rest, each with its first places to read a key from.
  const pending = await duck.stream(`
    WITH keyed AS (
      SELECT DISTINCT address FROM ${notes} WHERE "key" IS NOT NULL),
    pending AS (
      SELECT DISTINCT n.address FROM ${notes} n
      ANTI JOIN keyed k ON k.address = n.address),
    places AS (
      SELECT address, root, "offset", size FROM (
        SELECT DISTINCT address, root, "offset", size FROM ${notes}
        WHERE root IS NOT NULL)
      QUALIFY row_number() OVER (
        PARTITION BY address ORDER BY root, "offset", size) <= ${KEY_CANDIDATES})
    SELECT p.address, c.root, c."offset", c.size
    FROM pending p LEFT JOIN places c ON c.address = p.address
    ORDER BY p.address, c.root NULLS LAST, c."offset", c.size`);
  const inFlight = new Set<Promise<void>>();
  const resolve = async (address: Buffer, places: KeyCandidate[]) => {
    const fromDb = walletsDb?.get(address);
    if (fromDb !== undefined && sha256(fromDb).equals(address)) {
      stats.fromWalletsDb += 1;
      found.push([address, fromDb]);
      return;
    }
    const fromReplaced = replaced?.get(address);
    if (fromReplaced !== undefined && sha256(fromReplaced).equals(address)) {
      stats.fromReplaced += 1;
      found.push([address, fromReplaced]);
      return;
    }
    let unreadable = false;
    for (const place of places) {
      if (reads === undefined) break;
      const bytes = await reads.read(place.rootTxId, place.offset, place.size);
      if (bytes === 'not_found') {
        // The root is gone for this run: try the owner's next place.
        unreadable = true;
        continue;
      }
      if (bytes !== 'out_of_range' && sha256(bytes).equals(address)) {
        stats.fromGateway += 1;
        found.push([address, Buffer.from(bytes)]);
        return;
      }
    }
    stats.withoutKey += 1;
    stats.withoutKeyBy[
      unreadable ? 'unreadable' : places.length > 0 ? 'wrong' : 'nowhere'
    ] += 1;
    if (stats.withoutKeySample.length < SAMPLE) {
      stats.withoutKeySample.push(toB64Url(address));
    }
  };
  const start = async (address: Buffer, places: KeyCandidate[]) => {
    stats.owners += 1;
    const task: Promise<void> = resolve(address, places).finally(() =>
      inFlight.delete(task),
    );
    inFlight.add(task);
    if (inFlight.size >= concurrency) await Promise.race(inFlight);
    await flush();
  };
  let current: { address: Buffer; places: KeyCandidate[] } | undefined;
  for await (const row of pending) {
    const { address, root, offset, size } = row as {
      address: Buffer;
      root: Buffer | null;
      offset: bigint | number | null;
      size: bigint | number | null;
    };
    if (current === undefined || !current.address.equals(address)) {
      if (current !== undefined) await start(current.address, current.places);
      current = { address: Buffer.from(address), places: [] };
    }
    if (root !== null && offset !== null && size !== null) {
      current.places.push({
        rootTxId: Buffer.from(root),
        offset: Number(offset),
        size: Number(size),
      });
    }
  }
  if (current !== undefined) await start(current.address, current.places);
  await Promise.all(inFlight);
  await flush(true);
  return stats;
}
