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
import type { Database } from 'duckdb-async';
import { DEFAULT_L2_DUCK_LIMITS, withL2Duck } from './export.js';
import { GatewayReads, ReadUnavailableError } from './gateway-reads.js';
import {
  KEY_CANDIDATES,
  openWalletsDb,
  OWNER_NOTE_COLUMNS,
  OwnerNotes,
  resolveOwnerKeys,
} from './wallets.js';

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

/** Notes of several windows in a database, as a build gathers them. */
async function withNotes<T>(
  windows: OwnerNotes[],
  run: (duck: Database) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parquet-l2-owners-'));
  try {
    return await withL2Duck(dir, DEFAULT_L2_DUCK_LIMITS, async (duck) => {
      await duck.exec(
        `CREATE TABLE notes (${OWNER_NOTE_COLUMNS.map((c) => `"${c.name}" ${c.type}`).join(', ')})`,
      );
      for (const notes of windows) {
        for (const row of notes.rows()) {
          const [address, k, root, offset, size] = row as [
            Buffer,
            Buffer | null,
            Buffer | null,
            number | null,
            number | null,
          ];
          const blob = (b: Buffer | null) =>
            b === null ? 'NULL' : `unhex('${b.toString('hex')}')`;
          await duck.exec(
            `INSERT INTO notes VALUES (${blob(address)}, ${blob(k)}, ${blob(root)}, ${offset ?? 'NULL'}, ${size ?? 'NULL'})`,
          );
        }
      }
      return run(duck);
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('OwnerNotes and resolveOwnerKeys', () => {
  it("keeps the first key whose hash is the owner's address: the source's, then bundles.db's, then the root's", async () => {
    const db = new Map<string, Buffer>([
      [sha256(key(2)).toString('hex'), key(2)],
      // Under owner 3's address, a key that isn't owner 3's.
      [sha256(key(3)).toString('hex'), key(8)],
    ]);
    const first = new OwnerNotes();
    first.note(sha256(key(1)), key(1), at(1));
    // A wrong key from the source; bundles.db holds the right one.
    first.note(sha256(key(2)), key(7));
    // bundles.db is wrong, the root right (at its second place).
    first.note(sha256(key(3)), undefined, at(5));
    // Every place reads as something else: no key.
    first.note(sha256(key(4)), undefined, at(6));
    // No place to read it from at all.
    first.note(sha256(key(5)));
    const second = new OwnerNotes();
    // Another window: owner 3's second place; owner 1 without its key.
    second.note(sha256(key(3)), undefined, at(3));
    second.note(sha256(key(1)), undefined, at(9));
    assert.equal(first.rejectedKeys, 1);
    const { gateway: reads, reads: count } = gateway();
    const keys = new Map<string, Buffer>();
    const stats = await withNotes([first, second], (duck) =>
      resolveOwnerKeys(duck, 'notes', {
        walletsDb: {
          get: (address: Buffer) => db.get(address.toString('hex')),
        },
        reads,
        write: async (rows) => {
          for (const [address, k] of rows as Array<[Buffer, Buffer]>) {
            keys.set(address.toString('hex'), k);
          }
        },
        batch: 1,
      }),
    );
    assert.deepEqual(
      [...keys.entries()].map(([k, v]) => [k, v[0]]).sort(),
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
        fromReplaced: 0,
        fromGateway: 1,
        withoutKey: 2,
        withoutKeyBy: { unreadable: 0, wrong: 1, nowhere: 1 },
        withoutKeySample: [
          toB64Url(sha256(key(4))),
          toB64Url(sha256(key(5))),
        ].sort(),
      },
    );
    // Owner 1 needed no read; owner 3 one (its places are tried in order of
    // root and offset, so the other window's comes first); owner 4 one.
    assert.equal(count(), 2);
  });

  it(`keeps at most ${KEY_CANDIDATES} places to read a key from`, async () => {
    const notes = [new OwnerNotes(), new OwnerNotes()];
    for (let n = 1; n <= 9; n++) {
      notes[n % 2].note(sha256(key(9)), undefined, at(n));
    }
    const { gateway: reads, reads: count } = gateway();
    const stats = await withNotes(notes, (duck) =>
      resolveOwnerKeys(duck, 'notes', { reads, write: async () => undefined }),
    );
    assert.equal(stats.withoutKey, 1);
    assert.equal(count(), KEY_CANDIDATES);
  });

  it('stops when the gateway cannot serve a read, rather than leave the key out', async () => {
    const notes = new OwnerNotes();
    notes.note(sha256(key(1)), undefined, at(1));
    await assert.rejects(
      withNotes([notes], (duck) =>
        resolveOwnerKeys(duck, 'notes', {
          reads: gateway(true).gateway,
          write: async () => undefined,
        }),
      ),
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
