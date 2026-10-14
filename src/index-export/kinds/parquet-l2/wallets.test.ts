/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import Sqlite from 'better-sqlite3';

import { ByteRangeSource } from '../../../lib/byte-range-source.js';
import { toB64Url } from '../../../lib/encoding.js';
import { GatewayReads, ReadUnavailableError } from './gateway-reads.js';
import { KEY_CANDIDATES, openWalletsDb, OwnerKeys } from './wallets.js';

const sha256 = (bytes: Buffer) =>
  crypto.createHash('sha256').update(bytes).digest();
const key = (seed: number) => Buffer.alloc(512, seed);
const ROOT = Buffer.alloc(32, 9);

/** A root whose bytes at 1000 + 1000·n are key(n), 512 bytes each. */
function gateway(fail = false) {
  const bytes = Buffer.alloc(20_000);
  for (let n = 1; n <= 9; n++) key(n).copy(bytes, 1000 * n);
  let reads = 0;
  const openRoot = (): ByteRangeSource =>
    ({
      read: async (offset: number, size: number) => {
        reads += 1;
        if (fail) throw new Error('Request failed with status code 503');
        if (offset + size > bytes.length) {
          throw Object.assign(new Error('416'), { response: { status: 416 } });
        }
        return bytes.subarray(offset, offset + size);
      },
      close: async () => undefined,
    }) as unknown as ByteRangeSource;
  return {
    reads: () => reads,
    gateway: new GatewayReads(openRoot, {
      maxReads: 100,
      retryDelayMs: 1,
    }),
  };
}

const at = (n: number) => ({ rootTxId: ROOT, offset: 1000 * n, size: 512 });

describe('OwnerKeys', () => {
  it("keeps the first key whose hash is the owner's address: the source's, then bundles.db's, then the root's", async () => {
    const db = new Map<string, Buffer>([
      [sha256(key(2)).toString('hex'), key(2)],
      // Under owner 3's address, a key that isn't owner 3's.
      [sha256(key(3)).toString('hex'), key(8)],
    ]);
    const owners = new OwnerKeys({
      get: (address) => db.get(address.toString('hex')),
    });
    owners.note(sha256(key(1)), key(1), at(1));
    // A wrong key from the source, then bundles.db's right one.
    owners.note(sha256(key(2)), key(7));
    // bundles.db is wrong, the root right (at its second place).
    owners.note(sha256(key(3)), undefined, at(5));
    owners.note(sha256(key(3)), undefined, at(3));
    // Every place reads as something else: no key.
    owners.note(sha256(key(4)), undefined, at(6));
    // No place to read it from at all.
    owners.note(sha256(key(5)));
    const { gateway: reads, reads: count } = gateway();
    const { keys, stats } = await owners.resolve(reads);
    assert.deepEqual(
      [...keys.entries()]
        .map(([k, v]) => [Buffer.from(k, 'latin1').toString('hex'), v[0]])
        .sort(),
      [
        [sha256(key(1)).toString('hex'), 1],
        [sha256(key(2)).toString('hex'), 2],
        [sha256(key(3)).toString('hex'), 3],
      ].sort(),
    );
    assert.deepEqual(
      { ...stats, withoutKeySample: [...stats.withoutKeySample].sort() },
      {
        owners: 5,
        fromSource: 1,
        fromWalletsDb: 1,
        fromGateway: 1,
        withoutKey: 2,
        withoutKeySample: [
          toB64Url(sha256(key(4))),
          toB64Url(sha256(key(5))),
        ].sort(),
        rejectedKeys: 2,
      },
    );
    // Owner 1 needed no read; owner 3 two; owner 4 one.
    assert.equal(count(), 3);
  });

  it(`keeps at most ${KEY_CANDIDATES} places to read a key from`, async () => {
    const owners = new OwnerKeys();
    for (let n = 1; n <= 9; n++) owners.note(sha256(key(9)), undefined, at(n));
    const { gateway: reads, reads: count } = gateway();
    const { stats } = await owners.resolve(reads);
    assert.equal(stats.withoutKey, 1);
    assert.equal(count(), KEY_CANDIDATES);
  });

  it('stops when the gateway cannot serve a read, rather than leave the key out', async () => {
    const owners = new OwnerKeys();
    owners.note(sha256(key(1)), undefined, at(1));
    await assert.rejects(
      owners.resolve(gateway(true).gateway),
      ReadUnavailableError,
    );
  });

  it('reads bundles.db read-only, and does without it when it is absent', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parquet-l2-wallets-'));
    try {
      assert.equal(openWalletsDb(path.join(dir, 'missing.db')), undefined);
      assert.equal(openWalletsDb(undefined), undefined);
      const file = path.join(dir, 'bundles.db');
      const sqlite = new Sqlite(file);
      sqlite.exec(
        'CREATE TABLE wallets (address BLOB PRIMARY KEY, public_modulus BLOB)',
      );
      sqlite
        .prepare('INSERT INTO wallets VALUES (?, ?)')
        .run(sha256(key(1)), key(1));
      sqlite
        .prepare('INSERT INTO wallets VALUES (?, ?)')
        .run(sha256(key(2)), null);
      sqlite.close();
      const db = openWalletsDb(file)!;
      assert.deepEqual(db.get(sha256(key(1))), key(1));
      assert.equal(db.get(sha256(key(2))), undefined);
      assert.equal(db.get(sha256(key(3))), undefined);
      db.close();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
