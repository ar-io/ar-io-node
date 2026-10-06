/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Sqlite from 'better-sqlite3';

import { GOLDEN_BLOCKS } from '../../../test/parquet-l1-golden-blocks.js';
import { computeTxRoot, v1DataRoot } from './chain.js';
import {
  auditBlock,
  AuditRefused,
  pickSample,
  runAudit,
  summarise,
  unverifiableBlocks,
} from './audit.js';

const b64 = (s: string) => Buffer.from(s, 'base64url');

describe('computeTxRoot with supplied data roots', () => {
  // The whole audit rests on this: feed in the data roots an index cannot
  // store and the block's committed tx_root must come back out. Checked
  // against blocks recorded from mainnet, so no network is involved.
  for (const block of GOLDEN_BLOCKS) {
    it(`reproduces the tx_root mainnet block ${block.height} commits`, async () => {
      const supplied = new Map(
        block.txs
          .filter((t) => t.derivedDataRoot !== undefined)
          .map((t) => [t.id, b64(t.derivedDataRoot as string)]),
      );
      assert.ok(supplied.size > 0, 'this block needs derived roots');
      const root = await computeTxRoot(
        block.height,
        block.txs.map((t) => ({
          id: b64(t.id),
          format: t.format,
          data_size: t.dataSize,
          data_root: t.dataRoot === null ? null : b64(t.dataRoot),
        })),
        supplied,
      );
      assert.equal(root?.toString('base64url'), block.txRoot);
    });

    it(`gives up on block ${block.height} without them, as it must`, async () => {
      const root = await computeTxRoot(
        block.height,
        block.txs.map((t) => ({
          id: b64(t.id),
          format: t.format,
          data_size: t.dataSize,
          data_root: t.dataRoot === null ? null : b64(t.dataRoot),
        })),
      );
      assert.equal(root, undefined, 'this is the gap the audit exists for');
    });
  }

  it('refuses a wrong data root rather than accepting it', async () => {
    const block = GOLDEN_BLOCKS[0];
    const wrong = new Map(
      block.txs
        .filter((t) => t.derivedDataRoot !== undefined)
        .map((t) => [t.id, Buffer.alloc(32, 9)]),
    );
    const root = await computeTxRoot(
      block.height,
      block.txs.map((t) => ({
        id: b64(t.id),
        format: t.format,
        data_size: t.dataSize,
        data_root: t.dataRoot === null ? null : b64(t.dataRoot),
      })),
      wrong,
    );
    assert.notEqual(root?.toString('base64url'), block.txRoot);
  });
});

describe('v1DataRoot', () => {
  // A format-1 transaction's data_root follows `ar_tx:chunk_binary`:
  // fixed 256 KB pieces, remainder last, no rebalancing. arweave-js's
  // `chunkData` rebalances the final two chunks when the last would fall
  // under MIN_CHUNK_SIZE (32 KB). Using the latter made 9 of 150 sampled
  // mainnet blocks look corrupt when they were fine, so the difference is
  // pinned here in both directions.
  const CHUNK = 256 * 1024;
  const MIN_CHUNK = 32 * 1024;
  const data = (n: number) => {
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i += 1) b[i] = (i * 31 + 7) & 0xff;
    return b;
  };

  it('differs from arweave-js where the remainder is under 32 KB', async () => {
    const { computeRootHash } = await import('arweave/node/lib/merkle.js');
    const n = CHUNK * 4 + 20_847; // the real case: block 766911's v1 tx
    assert.ok(20_847 < MIN_CHUNK, 'this remainder is what triggers it');
    const mine = await v1DataRoot(data(n));
    const js = Buffer.from(await computeRootHash(data(n)));
    assert.notDeepEqual(
      mine,
      js,
      'if these match, the rebalancing bug is back',
    );
  });

  it('agrees with arweave-js where the remainder is 32 KB or more', async () => {
    const { computeRootHash } = await import('arweave/node/lib/merkle.js');
    const n = CHUNK * 3 + 183_106; // block 1470474's v1 tx, which matched
    assert.ok(183_106 >= MIN_CHUNK);
    assert.deepEqual(
      await v1DataRoot(data(n)),
      Buffer.from(await computeRootHash(data(n))),
    );
  });

  it('agrees with arweave-js on data of a single chunk', async () => {
    const { computeRootHash } = await import('arweave/node/lib/merkle.js');
    for (const n of [0, 1, 1614, CHUNK - 1, CHUNK]) {
      assert.deepEqual(
        await v1DataRoot(data(n)),
        Buffer.from(await computeRootHash(data(n))),
        `size ${n}`,
      );
    }
  });

  it('is stable and length-sensitive', async () => {
    assert.deepEqual(
      await v1DataRoot(data(5000)),
      await v1DataRoot(data(5000)),
    );
    assert.notDeepEqual(
      await v1DataRoot(data(5000)),
      await v1DataRoot(data(5001)),
    );
  });
});

describe('pickSample', () => {
  const pool = Array.from({ length: 100 }, (_, i) => i * 7);

  it('takes everything when asked for more than there is', () => {
    assert.deepEqual(pickSample(pool, 1000), pool);
    assert.deepEqual(pickSample([1, 2], 2), [1, 2]);
  });

  it('takes the asked-for number, without repeats, in order', () => {
    const picked = pickSample(pool, 10, mulberry(1));
    assert.equal(picked.length, 10);
    assert.equal(new Set(picked).size, 10, 'no height twice');
    assert.deepEqual(
      picked,
      [...picked].sort((a, b) => a - b),
    );
    assert.ok(picked.every((h) => pool.includes(h)));
  });

  it('is reproducible with a given source of randomness, and differs without', () => {
    assert.deepEqual(
      pickSample(pool, 8, mulberry(42)),
      pickSample(pool, 8, mulberry(42)),
    );
    assert.notDeepEqual(
      pickSample(pool, 8, mulberry(1)),
      pickSample(pool, 8, mulberry(2)),
    );
  });

  it('can reach the last element, which an off-by-one would strand', () => {
    // From a pool of two, taking one must sometimes give the second. A
    // pool large enough to swap the last element into reach would hide
    // the off-by-one, because the swap makes the value pickable even
    // when the index is not.
    const seen = new Set<number>();
    for (let seed = 0; seed < 100; seed += 1) {
      seen.add(pickSample([10, 20], 1, mulberry(seed))[0]);
    }
    assert.deepEqual(
      [...seen].sort((a, b) => a - b),
      [10, 20],
    );
  });

  it('never repeats a height, however the randomness falls', () => {
    // Without removing what it picked, a small pool collides quickly.
    for (let seed = 0; seed < 300; seed += 1) {
      const picked = pickSample([1, 2, 3, 4], 3, mulberry(seed));
      assert.equal(
        new Set(picked).size,
        picked.length,
        `seed ${seed} picked ${picked.join(',')} twice`,
      );
    }
  });
});

/** A small seeded generator, so a sample can be reproduced in a test. */
function mulberry(seed: number): () => number {
  let a = seed + 0x6d2b79f5;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('summarise', () => {
  const block = (result: 'match' | 'mismatch' | 'unavailable', bytes = 0) => ({
    height: 1,
    result,
    transactions: 1,
    derived: 1,
    bytesFetched: bytes,
  });

  it('bounds the error rate when nothing was wrong', () => {
    const s = summarise(
      1000,
      Array.from({ length: 150 }, () => block('match')),
    );
    assert.equal(s.matched, 150);
    assert.equal(s.mismatched, 0);
    // Rule of three: 150 clean samples bound the rate at about 2%.
    assert.equal(s.errorRateUpperBound95, 3 / 150);
    assert.equal(s.mismatchRate, undefined, 'a bound, not a measurement');
  });

  it('measures the rate once something is wrong, and stops bounding', () => {
    const s = summarise(1000, [
      ...Array.from({ length: 9 }, () => block('match')),
      block('mismatch'),
    ]);
    assert.equal(s.mismatchRate, 0.1);
    assert.equal(s.errorRateUpperBound95, undefined);
  });

  it('does not count what it could not check toward either', () => {
    const s = summarise(1000, [block('match'), block('unavailable')]);
    assert.equal(s.unavailable, 1);
    assert.equal(
      s.errorRateUpperBound95,
      3 / 1,
      'one checked, so it bounds nothing useful',
    );
  });

  it('says nothing about a rate when it checked nothing', () => {
    const s = summarise(1000, [block('unavailable'), block('unavailable')]);
    assert.equal(s.errorRateUpperBound95, undefined);
    assert.equal(s.mismatchRate, undefined);
  });

  it('totals the bytes it pulled', () => {
    assert.equal(
      summarise(5, [block('match', 100), block('match', 20)]).bytesFetched,
      120,
    );
  });
});

describe('unverifiableBlocks and auditBlock', () => {
  let dir: string;
  let db: Sqlite.Database;
  const H = 500_000;
  const V1 = Buffer.alloc(32, 1);
  const V2 = Buffer.alloc(32, 2);

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'parquet-l1-audit-'));
    db = new Sqlite(path.join(dir, 'core.db'));
    db.exec(fs.readFileSync('test/core-schema.sql', 'utf8'));
    const addBlock = (height: number, root: Buffer) =>
      db
        .prepare(
          `INSERT INTO stable_blocks (height, indep_hash, previous_block, nonce,
           hash, block_timestamp, diff, cumulative_diff, last_retarget,
           reward_addr, reward_pool, block_size, weave_size, hash_list_merkle,
           tx_root, tx_count, missing_tx_count)
           VALUES (?, ?, ?, ?, ?, 1, '1', '2', 3, ?, '4', 0, 0, ?, ?, 0, 0)`,
        )
        .run(
          height,
          Buffer.alloc(48, height % 251),
          Buffer.alloc(48, 7),
          Buffer.alloc(48, 8),
          Buffer.alloc(32, 9),
          Buffer.alloc(32, 10),
          Buffer.alloc(48, 11),
          root,
        );
    const addTx = (
      height: number,
      id: Buffer,
      format: number,
      size: number | null,
      bti: number,
    ) =>
      db
        .prepare(
          `INSERT INTO stable_transactions (id, height, block_transaction_index,
           format, last_tx, owner_address, quantity, reward, data_size,
           tag_count, indexed_at) VALUES (?, ?, ?, ?, ?, ?, '0', '0', ?, 0, 5)`,
        )
        .run(
          id,
          height,
          bti,
          format,
          Buffer.alloc(48, 3),
          Buffer.alloc(32, 4),
          size,
        );

    addBlock(H, Buffer.alloc(32, 99));
    addTx(H, V1, 1, 4, 0);
    // A v2 transaction, and a v1 with no data: neither needs auditing.
    addBlock(H + 1, Buffer.alloc(32, 98));
    addTx(H + 1, V2, 2, 100, 0);
    addBlock(H + 2, Buffer.alloc(32, 97));
    addTx(H + 2, Buffer.alloc(32, 3), 1, 0, 0);
    // Below the fork, where tx_root does not exist.
    addBlock(400_000, Buffer.alloc(0));
    addTx(400_000, Buffer.alloc(32, 5), 1, 50, 0);
  });

  afterEach(async () => {
    db?.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('finds only the post-fork blocks holding a v1 transaction with data', () => {
    assert.deepEqual(unverifiableBlocks(db, { from: 0, to: 600_000 }), [H]);
  });

  it('ignores heights below the 2.0 fork, which have no tx_root at all', () => {
    assert.deepEqual(unverifiableBlocks(db, { from: 0, to: 400_000 }), []);
  });

  it('reports a mismatch when the derived root does not reproduce tx_root', async () => {
    const out = await auditBlock(db, H, async () => Buffer.alloc(4, 1));
    assert.equal(out.result, 'mismatch');
    assert.equal(out.derived, 1);
    assert.equal(out.bytesFetched, 4);
  });

  it('calls data of the wrong length unavailable, not a mismatch', async () => {
    // The data route can return someone else's bytes with a 200. Blaming
    // the index for that would turn a bad source into a false alarm
    // against an honest publisher.
    const out = await auditBlock(db, H, async () => Buffer.alloc(9, 1));
    assert.equal(out.result, 'unavailable');
    assert.match(out.reason ?? '', /9 bytes where data_size says 4/);
  });

  it('calls a failed fetch unavailable, carrying why', async () => {
    const out = await auditBlock(db, H, async () => {
      throw new Error('HTTP 429');
    });
    assert.equal(out.result, 'unavailable');
    assert.match(out.reason ?? '', /HTTP 429/);
  });

  it('reports a height the index does not hold', async () => {
    const out = await auditBlock(db, 999_999, async () => Buffer.alloc(0));
    assert.equal(out.result, 'unavailable');
    assert.match(out.reason ?? '', /no block at this height/);
  });

  it('refuses a range with nothing to audit', async () => {
    await assert.rejects(
      runAudit(db, {
        from: 0,
        to: 400_000,
        fetchTxData: async () => Buffer.alloc(0),
      }),
      (e: Error) =>
        e instanceof AuditRefused && /needs auditing/.test(e.message),
    );
  });

  it('audits every sampled block and totals them', async () => {
    const { summary, blocks } = await runAudit(db, {
      from: 0,
      to: 600_000,
      fetchTxData: async () => Buffer.alloc(4, 1),
    });
    assert.equal(summary.population, 1);
    assert.equal(summary.sampled, 1);
    assert.equal(summary.mismatched, 1);
    assert.equal(blocks[0].height, H);
  });
});
