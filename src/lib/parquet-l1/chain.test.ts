/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import { describe, it } from 'node:test';

import { ChainBlock, checkBlockChain, checkTxRoot, FORK_1_6 } from './chain.js';

/** Arweave mainnet rows (see the fixture's `source`). */
const fixture = JSON.parse(
  fs.readFileSync('test/fixtures/parquet-l1/chain.json', 'utf8'),
);
const buf = (hex: string | null) =>
  hex === null ? null : Buffer.from(hex, 'hex');
const blocks = (rows: any[]): ChainBlock[] =>
  rows.map((r) => ({
    height: r.height,
    indep_hash: buf(r.indep_hash) as Buffer,
    previous_block: buf(r.previous_block),
    weave_size: r.weave_size,
    tx_root: buf(r.tx_root),
    hash_list_merkle: buf(r.hash_list_merkle),
  }));

describe('checkBlockChain', () => {
  it('passes mainnet rows past the 1.6 seed, across the 2.0 fork, and since', () => {
    for (const range of ['seed', 'fork', 'modern']) {
      const rows = blocks(fixture[range]);
      const report = checkBlockChain(rows.slice(1), rows[0]);
      assert.deepEqual(report.failures, [], range);
    }
    // At the 2.0 fork the seed can't be rebuilt: skipped, not failed.
    const fork = blocks(fixture.fork);
    const report = checkBlockChain(fork.slice(1), fork[0]);
    assert.equal(report.hashListSkipped, 1);
    assert.equal(report.hashListChecked, fork.length - 2);
  });

  it('catches a forged hash, a broken link, a gap and a wrong weave size', () => {
    const rows = blocks(fixture.modern);
    const prior = rows[0];
    const forged = rows.slice(1).map((r) => ({ ...r }));
    forged[3].indep_hash = Buffer.alloc(48, 7);
    let report = checkBlockChain(forged, prior);
    // The next block's link and both chain values downstream break.
    assert.deepEqual(
      report.failures.map((f) => [f.height, f.check]),
      [
        [forged[4].height, 'previous_block'],
        [forged[4].height, 'hash_list_merkle'],
      ],
    );

    const weave = rows.slice(1).map((r) => ({ ...r }));
    weave[2].weave_size = BigInt(weave[2].weave_size) + 1n;
    report = checkBlockChain(weave, prior);
    assert.deepEqual(
      report.failures.map((f) => [f.height, f.check]),
      [[weave[3].height, 'hash_list_merkle']],
    );

    const gap = [...rows.slice(1, 4), ...rows.slice(5)];
    report = checkBlockChain(gap, prior);
    assert.ok(report.failures.some((f) => f.check === 'contiguous'));
  });

  it('checks the 1.6 seed when the run starts at height 0, and the empty values below it', () => {
    // A synthetic chain: hashes are arbitrary, the rule is Arweave's.
    const sha384 = (...parts: Buffer[]) => {
      const h = crypto.createHash('sha384');
      for (const p of parts) h.update(p);
      return h.digest();
    };
    const chain: ChainBlock[] = [];
    let fold: Buffer = Buffer.alloc(0);
    for (let h = 0; h <= FORK_1_6 + 1; h++) {
      const indep = crypto.createHash('sha384').update(String(h)).digest();
      let hlm: Buffer | null = null;
      if (h === FORK_1_6) hlm = fold;
      if (h === FORK_1_6 + 1)
        hlm = sha384(
          chain[h - 1].hash_list_merkle as Buffer,
          chain[h - 1].indep_hash,
        );
      chain.push({
        height: h,
        indep_hash: indep,
        previous_block: h === 0 ? null : chain[h - 1].indep_hash,
        weave_size: 0,
        tx_root: null,
        hash_list_merkle: hlm,
      });
      if (h <= FORK_1_6 - 2) fold = sha384(fold, indep);
    }
    assert.deepEqual(checkBlockChain(chain).failures, []);
    // The seed folds through 94,998, not 94,999.
    const wrong = chain.map((b) => ({ ...b }));
    wrong[FORK_1_6].hash_list_merkle = sha384(
      fold,
      chain[FORK_1_6 - 1].indep_hash,
    );
    assert.deepEqual(
      checkBlockChain(wrong).failures.map((f) => [f.height, f.check]),
      [
        [FORK_1_6, 'hash_list_merkle'],
        [FORK_1_6 + 1, 'hash_list_merkle'],
      ],
    );
    // A value below the fork, where there should be none.
    const early = chain.map((b) => ({ ...b }));
    early[10].hash_list_merkle = Buffer.alloc(48);
    assert.ok(
      checkBlockChain(early).failures.some(
        (f) => f.height === 10 && f.check === 'hash_list_merkle',
      ),
    );
  });
});

describe('checkTxRoot', () => {
  const txs = (b: any) =>
    b.txs.map((t: any) => ({
      id: buf(t.id) as Buffer,
      format: t.format,
      data_size: t.data_size,
      data_root: buf(t.data_root),
    }));

  it('rebuilds mainnet blocks’ transaction roots', async () => {
    for (const block of fixture.txRoot) {
      assert.equal(
        await checkTxRoot(
          { height: block.height, tx_root: buf(block.tx_root) },
          txs(block),
        ),
        true,
        `height ${block.height}`,
      );
    }
  });

  it('catches a missing, resized or re-rooted transaction, in any input order', async () => {
    const [block] = fixture.txRoot;
    const stored = { height: block.height, tx_root: buf(block.tx_root) };
    const all = txs(block);
    assert.equal(await checkTxRoot(stored, [...all].reverse()), true);
    assert.equal(await checkTxRoot(stored, all.slice(1)), false);
    const resized = all.map((t: any, i: number) =>
      i === 0 ? { ...t, data_size: BigInt(t.data_size) + 1n } : t,
    );
    assert.equal(await checkTxRoot(stored, resized), false);
    const rerooted = all.map((t: any, i: number) =>
      i === 0 ? { ...t, data_root: Buffer.alloc(32, 9) } : t,
    );
    assert.equal(await checkTxRoot(stored, rerooted), false);
  });

  it('leaves unchecked what stored fields can’t rebuild', async () => {
    const [block] = fixture.txRoot;
    const withFormatOneData = [
      ...txs(block),
      { id: Buffer.alloc(32, 1), format: 1, data_size: 10, data_root: null },
    ];
    assert.equal(
      await checkTxRoot(
        { height: block.height, tx_root: buf(block.tx_root) },
        withFormatOneData,
      ),
      undefined,
    );
    assert.equal(
      await checkTxRoot({ height: 400_000, tx_root: null }, txs(block)),
      undefined,
      'below the 2.0 fork',
    );
    assert.equal(
      await checkTxRoot({ height: 1_900_000, tx_root: null }, []),
      true,
      'an empty block stores an empty root',
    );
  });
});
