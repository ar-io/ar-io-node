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
 */
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import Sqlite from 'better-sqlite3';

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
  fromGateway: number;
  /** Owners left out of `wallets`: no key whose hash is their address. */
  withoutKey: number;
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

export class OwnerKeys {
  private readonly keys = new Map<string, Buffer>();
  private readonly pending = new Map<string, KeyCandidate[]>();
  private readonly stats: OwnerKeyStats = {
    owners: 0,
    fromSource: 0,
    fromWalletsDb: 0,
    fromGateway: 0,
    withoutKey: 0,
    withoutKeySample: [],
    rejectedKeys: 0,
  };

  constructor(
    private readonly walletsDb?: {
      get: (address: Buffer) => Buffer | undefined;
    },
  ) {}

  /**
   * An item's owner: its address, the key its source row holds (if any),
   * and where its key sits in the root, for a located item.
   */
  note(address: Buffer, sourceKey?: Buffer, candidate?: KeyCandidate): void {
    const k = address.toString('latin1');
    if (this.keys.has(k)) return;
    let candidates = this.pending.get(k);
    const first = candidates === undefined;
    if (first) this.stats.owners += 1;
    if (sourceKey !== undefined && sourceKey.length > 0) {
      if (sha256(sourceKey).equals(address)) {
        this.keys.set(k, sourceKey);
        this.pending.delete(k);
        this.stats.fromSource += 1;
        return;
      }
      this.stats.rejectedKeys += 1;
    }
    if (candidates === undefined) {
      const fromDb = this.walletsDb?.get(address);
      if (fromDb !== undefined) {
        if (sha256(fromDb).equals(address)) {
          this.keys.set(k, fromDb);
          this.stats.fromWalletsDb += 1;
          return;
        }
        this.stats.rejectedKeys += 1;
      }
      candidates = [];
      this.pending.set(k, candidates);
    }
    if (candidate !== undefined && candidates.length < KEY_CANDIDATES) {
      candidates.push(candidate);
    }
  }

  /**
   * Reads the keys no index held from the roots, then gives every key, by
   * address. An owner whose candidates all read as something else (or
   * past the root) has no key.
   *
   * @throws ReadUnavailableError / ReadBudgetError from the reads.
   */
  async resolve(
    reads?: GatewayReads,
  ): Promise<{ keys: Map<string, Buffer>; stats: OwnerKeyStats }> {
    const owners = [...this.pending.keys()].sort();
    await Promise.all(
      owners.map(async (k) => {
        const address = Buffer.from(k, 'latin1');
        for (const candidate of this.pending.get(k) ?? []) {
          if (reads === undefined) break;
          const bytes = await reads.read(
            candidate.rootTxId,
            candidate.offset,
            candidate.size,
          );
          if (bytes !== undefined && sha256(bytes).equals(address)) {
            this.keys.set(k, bytes);
            this.stats.fromGateway += 1;
            return;
          }
        }
      }),
    );
    for (const k of owners) {
      if (this.keys.has(k)) continue;
      this.stats.withoutKey += 1;
      if (this.stats.withoutKeySample.length < SAMPLE) {
        this.stats.withoutKeySample.push(toB64Url(Buffer.from(k, 'latin1')));
      }
    }
    this.pending.clear();
    return { keys: this.keys, stats: this.stats };
  }
}
