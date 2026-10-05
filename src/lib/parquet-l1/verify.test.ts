/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Sqlite from 'better-sqlite3';

import { buildCoreDb } from '../../../test/parquet-l1-core-db.js';
import {
  anchorHeights,
  checkAnchors,
  chooseRange,
  FORK_2_0_HEIGHT,
  MAX_FAILURES_REPORTED,
  stableHeightRange,
  STRICT_DATA_SPLIT_THRESHOLD,
  verifyRange,
  VerifyRefused,
} from './verify.js';

/**
 * Heights FIRST-1 .. FIRST+COUNT-1, below the strict data split and above
 * fork 1.6, which is the shape the check is written for. `hash_list_merkle`
 * is a seed at fork 2.0 itself, so no fixture can link across the real
 * fork height; FORK stands in for it, as it does on a FORKS_RESET chain.
 */
const FIRST = 300_000;
const COUNT = 40;
const LOW = FIRST - 1;
const FORK = FIRST + 10;

describe('verifyRange', () => {
  let dir: string;
  let file: string;
  let db: Sqlite.Database;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'parquet-l1-verify-'));
    file = path.join(dir, 'core.db');
    // `padded: false` is how the weave grew below the strict data split,
    // which is the range this check is for.
    await buildCoreDb(file, FIRST, COUNT, { padded: false });
    db = new Sqlite(file);
  });

  afterEach(async () => {
    db?.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const run = (from = LOW, to = FORK) =>
    verifyRange(db, { from, to, forkHeight: FORK });

  const failed = (result: ReturnType<typeof verifyRange>, name: string) =>
    result.checks.find((c) => c.name === name);

  it('passes every check on a chain that adds up', () => {
    const result = run();
    assert.equal(result.ok, true, JSON.stringify(result.checks, null, 2));
    assert.equal(result.blocks, FORK - LOW + 1);
    assert.deepEqual(
      result.checks.map((c) => c.name),
      [
        'contiguous',
        'linked',
        'hash_list_merkle',
        'block_size',
        'weave_accounting',
        'anchor',
      ],
    );
    assert.equal(result.weaveSize, result.accountedFor);
  });

  it('is anchored only when the range reaches a block that commits the weave size', () => {
    assert.equal(run(LOW, FORK).anchored, true);
    assert.equal(run(LOW, FORK).anchorHeight, FORK);

    const short = run(LOW, FORK - 5);
    assert.equal(short.anchored, false);
    assert.equal(short.anchorHeight, undefined);
    assert.equal(short.ok, true, 'still self-consistent');
    assert.match(
      failed(short, 'anchor')?.detail ?? '',
      /not committed by a post-2\.0 block/,
      'says plainly that nothing outside the index vouches for this',
    );
  });

  it("does not count the transactions of the range's first block", () => {
    // weave_size(from) is where the sum starts, so what that block added
    // belongs to the weave already. This is also why Arweave's genesis
    // block — 314 transactions the weave never counted — needs no
    // special case. Started at FIRST rather than LOW because the
    // fixture's anchor block carries none, which would prove nothing.
    const carried = db
      .prepare(
        'SELECT SUM(data_size) FROM stable_transactions WHERE height = ?',
      )
      .pluck()
      .get(FIRST + 1) as number;
    assert.ok(
      carried > 0,
      'the first block of the range does carry transactions',
    );
    const result = run(FIRST + 1, FORK);
    const above = db
      .prepare(
        'SELECT SUM(data_size) FROM stable_transactions WHERE height > ? AND height <= ?',
      )
      .pluck()
      .get(FIRST + 1, FORK) as number;
    assert.equal(result.accountedFor, String(above));
    assert.equal(result.ok, true, 'and the range still adds up');
  });

  it('rebuilds the hash_list_merkle recurrence over the whole range', () => {
    // This is what makes a single trusted hash at the top pin every
    // block hash below it. `previous_block` alone would be satisfied by
    // an index that fabricated the entire chain self-consistently.
    const result = run();
    assert.equal(result.merkleChecked, FORK - LOW);
    assert.equal(result.merkleSkipped, 0);
    assert.equal(failed(result, 'hash_list_merkle')?.ok, true);
  });

  it('catches a tampered hash_list_merkle', () => {
    db.prepare(
      'UPDATE stable_blocks SET hash_list_merkle = ? WHERE height = ?',
    ).run(Buffer.alloc(48, 3), FIRST + 2);
    const result = run();
    assert.equal(result.ok, false);
    const check = failed(result, 'hash_list_merkle');
    assert.equal(check?.failures?.[0].height, FIRST + 2);
    // The recurrence feeds forward, so the block above fails too — that
    // is the chain doing its job, not noise.
    assert.equal(check?.failures?.[1].height, FIRST + 3);
  });

  it('catches a forged indep_hash even when the links are moved with it', () => {
    // `previous_block` linkage alone cannot see this if both are moved
    // together; the merkle recurrence can, because it commits to the
    // hash of every block below.
    const other = Buffer.alloc(48, 7);
    db.prepare('UPDATE stable_blocks SET indep_hash = ? WHERE height = ?').run(
      other,
      FIRST + 4,
    );
    db.prepare(
      'UPDATE stable_blocks SET previous_block = ? WHERE height = ?',
    ).run(other, FIRST + 5);
    const result = run();
    assert.equal(result.ok, false);
    assert.equal(
      failed(result, 'linked')?.ok,
      true,
      'the links were moved together, so linkage alone is happy',
    );
    assert.equal(
      failed(result, 'hash_list_merkle')?.failures?.[0].height,
      FIRST + 5,
      'but the recurrence notices',
    );
  });

  it('catches a range whose first block is missing', () => {
    db.prepare('DELETE FROM stable_blocks WHERE height = ?').run(LOW);
    const result = run();
    assert.equal(result.ok, false);
    const check = failed(result, 'contiguous');
    assert.equal(check?.ok, false);
    assert.equal(check?.failures?.[0].height, LOW);
    assert.match(check?.failures?.[0].found ?? '', /starts at/);
  });

  it('catches a block that is missing from the middle', () => {
    db.prepare('DELETE FROM stable_blocks WHERE height = ?').run(FIRST + 2);
    const result = run();
    assert.equal(result.ok, false);
    const check = failed(result, 'contiguous');
    assert.equal(check?.ok, false);
    assert.equal(check?.failures?.[0].height, FIRST + 2);
    assert.equal(
      failed(result, 'weave_accounting')?.ok,
      true,
      'a hole is reported once, not as a mismatch at every height after it',
    );
  });

  it('catches a block that does not follow the one below it', () => {
    db.prepare(
      'UPDATE stable_blocks SET previous_block = ? WHERE height = ?',
    ).run(Buffer.alloc(48, 9), FIRST + 3);
    const result = run();
    assert.equal(result.ok, false);
    assert.equal(failed(result, 'linked')?.failures?.[0].height, FIRST + 3);
    assert.equal(failed(result, 'weave_accounting')?.ok, true);
  });

  it('catches a block_size that is not how much the weave grew', () => {
    db.prepare(
      'UPDATE stable_blocks SET block_size = block_size + 1 WHERE height = ?',
    ).run(FIRST + 4);
    const result = run();
    assert.equal(result.ok, false);
    assert.equal(failed(result, 'block_size')?.failures?.[0].height, FIRST + 4);
    assert.equal(
      failed(result, 'weave_accounting')?.ok,
      true,
      'block_size is a separate claim from the transactions themselves',
    );
  });

  it('catches a transaction whose size was changed', () => {
    db.prepare(
      'UPDATE stable_transactions SET data_size = data_size + 1 WHERE height = ? AND block_transaction_index = 0',
    ).run(FIRST + 5);
    const result = run();
    assert.equal(result.ok, false);
    assert.equal(
      failed(result, 'weave_accounting')?.failures?.[0].height,
      FIRST + 5,
    );
    assert.equal(
      failed(result, 'anchor')?.ok,
      false,
      'and the total no longer matches what the anchor commits',
    );
  });

  it('catches a transaction that was never in the chain', () => {
    const row = db
      .prepare('SELECT * FROM stable_transactions WHERE height = ? LIMIT 1')
      .get(FIRST + 6) as Record<string, unknown>;
    db.prepare(
      `INSERT INTO stable_transactions (id, height, block_transaction_index,
       format, last_tx, owner_address, quantity, reward, data_size, tag_count,
       indexed_at) VALUES (?, ?, 99, 2, ?, ?, '0', '0', 4242, 0, 5)`,
    ).run(Buffer.alloc(32, 7), FIRST + 6, row.last_tx, row.owner_address);
    const result = run();
    assert.equal(result.ok, false);
    const bad = failed(result, 'weave_accounting')?.failures?.[0];
    assert.equal(bad?.height, FIRST + 6);
    const found = Number(/(\d+)/.exec(bad?.found ?? '')?.[1]);
    const expected = Number(/(\d+)/.exec(bad?.expected ?? '')?.[1]);
    assert.equal(
      found - expected,
      4242,
      'the excess is exactly the invented transaction',
    );
  });

  it('catches a transaction that was dropped', () => {
    db.prepare(
      'DELETE FROM stable_transactions WHERE height = ? AND block_transaction_index = 0',
    ).run(FIRST + 7);
    const result = run();
    assert.equal(result.ok, false);
    assert.equal(
      failed(result, 'weave_accounting')?.failures?.[0].height,
      FIRST + 7,
    );
  });

  it('reports a bounded number of failures and counts the rest', () => {
    db.prepare(
      'UPDATE stable_transactions SET data_size = data_size + 1',
    ).run();
    const result = run(LOW, FIRST + COUNT - 1);
    const check = failed(result, 'weave_accounting');
    assert.equal(check?.failures?.length, MAX_FAILURES_REPORTED);
    assert.ok((check?.more ?? 0) > 0, 'the rest are counted, not listed');
  });

  it('refuses a range that cannot be walked', () => {
    assert.throws(
      () => verifyRange(db, { from: 100, to: 100 }),
      (e: Error) =>
        e instanceof VerifyRefused && /must be above/.test(e.message),
    );
    assert.throws(
      () => verifyRange(db, { from: -1, to: 10 }),
      (e: Error) => e instanceof VerifyRefused,
    );
  });
});

describe('verifyRange above the strict data split', () => {
  let dir: string;
  let db: Sqlite.Database;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'parquet-l1-verify-hi-'));
    const file = path.join(dir, 'core.db');
    // A weave past the threshold, where Arweave pads each transaction's
    // data to a chunk before adding it. `padded: true` matches that.
    await buildCoreDb(file, 1_900_000, 10, {
      weaveStart: STRICT_DATA_SPLIT_THRESHOLD + 1,
    });
    db = new Sqlite(file);
  });

  afterEach(async () => {
    db?.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const failed = (result: ReturnType<typeof verifyRange>, name: string) =>
    result.checks.find((c) => c.name === name);

  it('skips the accounting it cannot do, rather than reporting it as wrong', () => {
    // The identity does not hold up here, so blocks past the threshold
    // are counted out. Reporting them as failures would bury a real one.
    const result = verifyRange(db, { from: 1_899_999, to: 1_900_009 });
    assert.equal(result.accountingSkipped, 10);
    assert.equal(result.accountingChecked, 0);
    assert.equal(failed(result, 'weave_accounting')?.ok, true);
    assert.match(
      failed(result, 'weave_accounting')?.detail ?? '',
      /past the padding threshold/,
    );
    assert.equal(result.ok, true);
  });

  it('is not anchored when any block was skipped', () => {
    // A gap in the accounting breaks the chain of differences the anchor
    // is meant to pin, so claiming an anchor would overstate the result.
    const result = verifyRange(db, {
      from: 1_899_999,
      to: 1_900_009,
      forkHeight: 1_900_000,
    });
    assert.equal(result.anchored, false);
    assert.equal(
      failed(result, 'anchor'),
      undefined,
      'no anchor check is reported at all',
    );
  });

  it('still checks what does not depend on the threshold', () => {
    db.prepare(
      'UPDATE stable_blocks SET block_size = block_size + 1 WHERE height = ?',
    ).run(1_900_005);
    const result = verifyRange(db, { from: 1_899_999, to: 1_900_009 });
    assert.equal(result.ok, false);
    assert.equal(failed(result, 'block_size')?.failures?.[0].height, 1_900_005);
  });
});

describe('chooseRange', () => {
  const F = FORK_2_0_HEIGHT;

  it('caps an index that reaches below the fork at the fork', () => {
    // Reading past it is tens of millions of rows for nothing: the fork
    // block anchors everything beneath it, and tx_root proves everything
    // above it.
    assert.deepEqual(chooseRange([0, 2_014_135]), [0, F]);
  });

  it('reads an index that stops below the fork to its top', () => {
    assert.deepEqual(chooseRange([0, 300_000]), [0, 300_000]);
  });

  it('reads an index that starts above the fork whole', () => {
    // There is no pre-2.0 range to anchor, so there is nothing to cap at.
    assert.deepEqual(chooseRange([F, F + 500]), [F, F + 500]);
    assert.deepEqual(
      chooseRange([1_000_000, 1_000_050]),
      [1_000_000, 1_000_050],
    );
  });

  it('takes an explicit range over the default', () => {
    assert.deepEqual(
      chooseRange([0, 2_014_135], { from: 10, to: 900_000 }),
      [10, 900_000],
    );
    assert.deepEqual(chooseRange([0, 2_014_135], { to: 50 }), [0, 50]);
  });

  it('refuses a range the index does not hold', () => {
    assert.throws(
      () => chooseRange([100, 200], { from: 50 }),
      (e: Error) =>
        e instanceof VerifyRefused && /does not cover/.test(e.message),
    );
    assert.throws(
      () => chooseRange([100, 200], { to: 500 }),
      (e: Error) =>
        e instanceof VerifyRefused && /does not cover/.test(e.message),
    );
  });

  it('refuses an index too short to compare anything', () => {
    assert.throws(
      () => chooseRange([F, F]),
      (e: Error) =>
        e instanceof VerifyRefused && /at least two heights/.test(e.message),
    );
    assert.throws(
      () => chooseRange([0, 500], { from: 300, to: 300 }),
      (e: Error) =>
        e instanceof VerifyRefused && /at least two heights/.test(e.message),
    );
  });
});

describe('anchorHeights', () => {
  const F = FORK_2_0_HEIGHT;

  it('anchors each side of the fork separately', () => {
    // The fork-2.0 seed is not rebuildable, so the recurrence is two
    // chains and one hash cannot pin both.
    assert.deepEqual(anchorHeights(0, 2_014_815), [F - 1, 2_014_815]);
  });

  it('anchors the top of a range wholly below the fork', () => {
    assert.deepEqual(anchorHeights(0, 300_000), [300_000]);
  });

  it('anchors only the top of a range wholly above the fork', () => {
    assert.deepEqual(anchorHeights(F, 900_000), [900_000]);
    assert.deepEqual(anchorHeights(F + 10, 900_000), [900_000]);
  });
});

describe('checkAnchors', () => {
  const ours = new Map([[100, 'AAA']]);

  it('passes when enough independent sources agree with the index', () => {
    const check = checkAnchors(ours, [
      { url: 'a', height: 100, indepHash: 'AAA' },
      { url: 'b', height: 100, indepHash: 'AAA' },
    ]);
    assert.equal(check.ok, true);
    assert.match(check.detail, /2 sources agree/);
  });

  it('fails when a source says something else', () => {
    const check = checkAnchors(ours, [
      { url: 'a', height: 100, indepHash: 'AAA' },
      { url: 'b', height: 100, indepHash: 'XXX' },
      { url: 'c', height: 100, indepHash: 'AAA' },
    ]);
    assert.equal(check.ok, false);
    assert.match(check.failures?.[0].found ?? '', /b says XXX/);
  });

  it('fails when too few sources answered, because one is a single point of trust', () => {
    const check = checkAnchors(ours, [
      { url: 'a', height: 100, indepHash: 'AAA' },
      { url: 'b', height: 100, error: 'timed out' },
    ]);
    assert.equal(check.ok, false);
    assert.match(check.failures?.[0].found ?? '', /1 of 2 sources answered/);
  });

  it('counts an unreachable source as absent, not as disagreement', () => {
    const check = checkAnchors(
      ours,
      [
        { url: 'a', height: 100, indepHash: 'AAA' },
        { url: 'b', height: 100, indepHash: 'AAA' },
        { url: 'c', height: 100, error: 'ECONNREFUSED' },
      ],
      2,
    );
    assert.equal(check.ok, true);
  });

  it('says plainly when nothing was asked', () => {
    const check = checkAnchors(new Map(), []);
    assert.equal(check.ok, true);
    assert.match(check.detail, /nothing outside this index vouches/);
  });
});

describe('stableHeightRange', () => {
  it('reports nothing for a database with no stable blocks', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'parquet-l1-empty-'));
    try {
      const file = path.join(dir, 'core.db');
      const db = new Sqlite(file);
      db.exec(await fsp.readFile('test/core-schema.sql', 'utf8'));
      try {
        assert.equal(stableHeightRange(db), undefined);
      } finally {
        db.close();
      }
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('reports the heights a database holds', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'parquet-l1-range-'));
    try {
      const file = path.join(dir, 'core.db');
      await buildCoreDb(file, 300_000, 10, { padded: false });
      const db = new Sqlite(file);
      try {
        assert.deepEqual(stableHeightRange(db), [299_999, 300_009]);
      } finally {
        db.close();
      }
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
