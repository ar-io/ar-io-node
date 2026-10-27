/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Sqlite from 'better-sqlite3';

import { buildCoreDb } from '../../../test/parquet-l1-core-db.js';
import {
  chooseRange,
  MAX_FAILURES_REPORTED,
  stableHeightRange,
  STRICT_DATA_SPLIT_THRESHOLD,
  verifyCoreDb,
  VerifyRefused,
} from './verify.js';
import type { L1VerifyReport } from './verify-run.js';

/**
 * Heights FIRST-1 .. FIRST+COUNT-1, above the 2.0 fork (so `tx_root` and
 * the post-2.0 recurrence apply) and, with `padded: false`, below the
 * strict data split, where the weave grows by `data_size` exactly.
 */
const FIRST = 1_900_000;
const COUNT = 40;
const LOW = FIRST - 1;
const TOP = FIRST + COUNT - 1;
const UNANCHORED = { allow: { unanchored: true } };

describe('verifyCoreDb', () => {
  let dir: string;
  let file: string;
  let db: Sqlite.Database;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'parquet-l1-verify-'));
    file = path.join(dir, 'core.db');
    await buildCoreDb(file, FIRST, COUNT, { padded: false });
    db = new Sqlite(file);
  });

  afterEach(async () => {
    db?.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const run = (from = LOW, to = TOP, txRoot = true) =>
    verifyCoreDb(db, { from, to, txRoot, ...UNANCHORED });
  const check = (result: L1VerifyReport, name: string) =>
    result.checks.find((c) => c.name === name);

  it('passes every check on a chain that adds up, saying what it did not bind', async () => {
    const result = await run();
    assert.equal(result.ok, true, JSON.stringify(result.checks, null, 2));
    assert.equal(result.blocks, TOP - LOW + 1);
    assert.deepEqual(
      result.checks.map((c) => c.name),
      [
        'contiguous',
        'linked',
        'hash_list_merkle',
        'block_size',
        'weave_accounting',
        'tx_root',
        'nulls',
        'position',
        'tx_count',
        'tag_count',
        'owners',
        'wallets',
        'rows',
        'anchor',
        'unbound',
      ],
    );
    assert.equal(result.anchored, false);
    assert.deepEqual(result.accepted, ['--allow-unanchored']);
    assert.ok(result.skipped.includes('anchor'));
    assert.ok(result.skipped.includes('sample'));
    assert.equal(result.weaveGrowth, result.accountedFor);
    assert.match(
      check(result, 'weave_accounting')?.detail ?? '',
      /not bound to the chain/,
    );
  });

  it('fails an unanchored run unless that is accepted', async () => {
    const strict = await verifyCoreDb(db, { from: LOW, to: TOP });
    assert.equal(strict.ok, false);
    assert.equal(check(strict, 'anchor')?.ok, false);
  });

  it('reports the absolute weave size at the top, and the growth separately', async () => {
    const result = await run();
    const top = db
      .prepare('SELECT weave_size FROM stable_blocks WHERE height = ?')
      .pluck()
      .get(TOP) as number;
    assert.equal(result.weaveSize, String(top));
    assert.notEqual(result.weaveGrowth, result.weaveSize);
  });

  it("judges the range's first block against the block below it when the index holds it (D4)", async () => {
    const result = await run(FIRST + 1, TOP);
    const counted = db
      .prepare(
        'SELECT SUM(data_size) FROM stable_transactions WHERE height >= ? AND height <= ?',
      )
      .pluck()
      .get(FIRST + 1, TOP) as number;
    assert.equal(result.accountedFor, String(counted));
    assert.equal(result.ok, true);
    assert.ok(!result.skipped.includes('first_block_link'));
  });

  it('rebuilds the hash_list_merkle recurrence over the whole range', async () => {
    const result = await run();
    // LOW is the fixture's lowest block: nothing below it to judge it by.
    assert.equal(result.merkleChecked, TOP - LOW);
    assert.ok(result.skipped.includes('first_block_link'));
    assert.equal(check(result, 'hash_list_merkle')?.ok, true);
  });

  it('fails when the block below carries no hash_list_merkle', async () => {
    db.prepare(
      'UPDATE stable_blocks SET hash_list_merkle = NULL WHERE height = ?',
    ).run(FIRST + 3);
    const result = await run();
    assert.equal(result.ok, false);
    assert.equal(check(result, 'hash_list_merkle')?.ok, false);
    assert.equal(check(result, 'nulls')?.ok, false);
  });

  it('catches a tampered hash_list_merkle', async () => {
    db.prepare(
      'UPDATE stable_blocks SET hash_list_merkle = ? WHERE height = ?',
    ).run(crypto.randomBytes(48), FIRST + 2);
    const result = await run();
    assert.equal(
      check(result, 'hash_list_merkle')?.failures?.[0].height,
      FIRST + 2,
    );
  });

  it('catches a forged indep_hash even when the links are moved with it', async () => {
    const forged = crypto.randomBytes(48);
    db.prepare('UPDATE stable_blocks SET indep_hash = ? WHERE height = ?').run(
      forged,
      FIRST + 5,
    );
    db.prepare(
      'UPDATE stable_blocks SET previous_block = ? WHERE height = ?',
    ).run(forged, FIRST + 6);
    const result = await run();
    assert.equal(result.ok, false);
    assert.equal(
      check(result, 'hash_list_merkle')?.failures?.[0].height,
      FIRST + 6,
    );
  });

  it('catches missing blocks at the start and in the middle', async () => {
    db.prepare('DELETE FROM stable_blocks WHERE height IN (?, ?)').run(
      LOW,
      FIRST + 2,
    );
    const result = await run();
    assert.equal(result.ok, false);
    const contiguous = check(result, 'contiguous');
    assert.match(contiguous?.failures?.[0].found ?? '', /starts at/);
    assert.equal(contiguous?.failures?.[1].height, FIRST + 2);
    // Transactions at the missing height belong to no block.
    assert.equal(check(result, 'rows')?.ok, (FIRST + 2) % 4 === 0);
  });

  it('catches a block that does not follow the one below it', async () => {
    db.prepare(
      'UPDATE stable_blocks SET previous_block = ? WHERE height = ?',
    ).run(crypto.randomBytes(48), FIRST + 3);
    const result = await run();
    assert.equal(check(result, 'linked')?.failures?.[0].height, FIRST + 3);
  });

  it('catches a block_size that is not how much the weave grew', async () => {
    db.prepare(
      'UPDATE stable_blocks SET block_size = block_size + 1 WHERE height = ?',
    ).run(FIRST + 4);
    const result = await run();
    assert.equal(check(result, 'block_size')?.failures?.[0].height, FIRST + 4);
  });

  it('catches a transaction whose size was changed', async () => {
    db.prepare(
      'UPDATE stable_transactions SET data_size = data_size + 1 WHERE height = ? AND block_transaction_index = 0',
    ).run(FIRST + 5);
    const result = await run();
    assert.equal(
      check(result, 'weave_accounting')?.failures?.[0].height,
      FIRST + 5,
    );
    assert.equal(check(result, 'tx_root')?.failures?.[0].height, FIRST + 5);
  });

  it('catches a transaction that was never in the chain', async () => {
    db.prepare(
      `INSERT INTO stable_transactions (id, height, block_transaction_index,
         format, last_tx, owner_address, quantity, reward, data_size, tag_count)
       VALUES (?, ?, 9, 2, ?, ?, '0', '0', 0, 0)`,
    ).run(
      crypto.randomBytes(32),
      FIRST + 6,
      crypto.randomBytes(32),
      crypto.randomBytes(32),
    );
    const result = await run();
    assert.equal(result.ok, false);
    // A zero-size one moves no weave and no tx_root sum: its position does.
    assert.equal(check(result, 'position')?.failures?.[0].height, FIRST + 6);
    // And its owner's key is nowhere: the block is listed incomplete.
    assert.deepEqual(result.unbound.incomplete?.heights, [FIRST + 6]);
  });

  it('lists a transaction dropped beside its link as missing, and catches one dropped with it', async () => {
    db.prepare(
      'DELETE FROM stable_transactions WHERE height = ? AND block_transaction_index = 0',
    ).run(FIRST + 7);
    const result = await run();
    assert.equal(result.ok, false);
    // Its link stands alone: what a gateway holds for a transaction it has
    // not fetched yet. Nothing can be checked against what is not there.
    assert.deepEqual(result.unbound.incomplete?.heights, [FIRST + 7]);
    assert.equal(check(result, 'weave_accounting')?.ok, true);

    // Dropped with its link, the block's own count and the weave say so.
    db.prepare(
      `DELETE FROM stable_block_transactions WHERE block_indep_hash =
         (SELECT indep_hash FROM stable_blocks WHERE height = ?) AND block_transaction_index = 0`,
    ).run(FIRST + 7);
    const gone = await run();
    assert.equal(check(gone, 'tx_count')?.failures?.[0].height, FIRST + 7);
    assert.equal(
      check(gone, 'weave_accounting')?.failures?.[0].height,
      FIRST + 7,
    );
  });

  it('reports a bounded number of failures and counts the rest', async () => {
    db.prepare(
      'UPDATE stable_transactions SET data_size = data_size + 1',
    ).run();
    const result = await run();
    const accounting = check(result, 'weave_accounting');
    assert.equal(accounting?.failures?.length, MAX_FAILURES_REPORTED);
    assert.ok((accounting?.more ?? 0) > 0);
  });

  it('refuses a range that cannot be walked', async () => {
    await assert.rejects(run(TOP, LOW), VerifyRefused);
    await assert.rejects(run(-1, TOP), VerifyRefused);
  });

  it('catches tags that do not add up, and lists owners without keys as incomplete', async () => {
    db.prepare(
      'UPDATE stable_transactions SET tag_count = 3 WHERE height = ? AND block_transaction_index = 0',
    ).run(FIRST + 1);
    db.prepare('DELETE FROM wallets').run();
    const result = await run();
    assert.equal(check(result, 'tag_count')?.failures?.[0].height, FIRST + 1);
    assert.ok((result.unbound.incomplete?.blocks ?? 0) > 0);
    assert.equal(check(result, 'unbound')?.ok, false);
  });

  it('catches a wallet whose key does not hash to its address', async () => {
    db.prepare('UPDATE wallets SET public_modulus = ?').run(
      crypto.randomBytes(512),
    );
    const result = await run();
    assert.equal(check(result, 'wallets')?.ok, false);
  });

  it('catches a reordered block_transaction_index', async () => {
    const h = FIRST + 3; // three transactions
    db.prepare(
      'UPDATE stable_transactions SET block_transaction_index = 100 + (2 - block_transaction_index) WHERE height = ?',
    ).run(h);
    db.prepare(
      'UPDATE stable_transactions SET block_transaction_index = block_transaction_index - 100 WHERE height = ?',
    ).run(h);
    const result = await run();
    assert.equal(check(result, 'position')?.failures?.[0].height, h);
  });

  it('lists a block with a format-1 transaction carrying data as unbound, not checked', async () => {
    db.prepare(
      'UPDATE stable_transactions SET format = 1 WHERE height = ? AND block_transaction_index = 0',
    ).run(FIRST + 1);
    const result = await run();
    assert.equal(result.ok, false);
    assert.deepEqual(result.unbound.txRootFormat1?.heights, [FIRST + 1]);
    const accepted = await verifyCoreDb(db, {
      from: LOW,
      to: TOP,
      allow: { unanchored: true, unverifiedFormat1: true, unsampled: true },
    });
    assert.equal(accepted.ok, true);
  });
});

describe('verifyCoreDb above the strict data split', () => {
  let dir: string;
  let db: Sqlite.Database;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'parquet-l1-verify-'));
    const file = path.join(dir, 'core.db');
    await buildCoreDb(file, FIRST, 10, {
      weaveStart: STRICT_DATA_SPLIT_THRESHOLD_NUMBER + 1,
    });
    db = new Sqlite(file);
  });
  afterEach(async () => {
    db?.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('counts out the accounting it cannot do, and still checks the rest', async () => {
    const result = await verifyCoreDb(db, {
      from: LOW,
      to: FIRST + 9,
      ...UNANCHORED,
    });
    assert.equal(result.ok, true, JSON.stringify(result.checks));
    assert.equal(result.accountingSkipped, 10);
    assert.equal(result.accountingChecked, 0);
    assert.equal(result.txRootChecked, 11);
  });
});

const STRICT_DATA_SPLIT_THRESHOLD_NUMBER = Number(STRICT_DATA_SPLIT_THRESHOLD);

describe('chooseRange', () => {
  it('reads the whole held range by default', () => {
    assert.deepEqual(chooseRange([0, 1_999_999]), [0, 1_999_999]);
    assert.deepEqual(chooseRange([500_000, 600_000]), [500_000, 600_000]);
  });

  it('takes an explicit range over the default', () => {
    assert.deepEqual(chooseRange([0, 1_000], { from: 10, to: 20 }), [10, 20]);
  });

  it('refuses a range the index does not hold, or too short to compare', () => {
    assert.throws(() => chooseRange([10, 20], { from: 5 }), VerifyRefused);
    assert.throws(() => chooseRange([10, 20], { to: 25 }), VerifyRefused);
    assert.throws(() => chooseRange([10, 10]), VerifyRefused);
  });
});

describe('stableHeightRange', () => {
  it('reports nothing for an empty database, and the heights of a full one', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'parquet-l1-verify-'));
    try {
      const file = path.join(dir, 'core.db');
      await buildCoreDb(file, FIRST, 3);
      const db = new Sqlite(file);
      assert.deepEqual(stableHeightRange(db), [LOW, FIRST + 2]);
      db.prepare('DELETE FROM stable_blocks').run();
      assert.equal(stableHeightRange(db), undefined);
      db.close();
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
