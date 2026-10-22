/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';

import { FORK_1_6 } from './chain.js';
import { JudgeBlock, L1Judge } from './judge.js';

const sha384 = (...parts: Buffer[]): Buffer =>
  Buffer.from(
    crypto.createHash('sha384').update(Buffer.concat(parts)).digest(),
  );

/** An empty block, every column set: what a reader hands the judge. */
const block = (
  height: number,
  fields: Partial<JudgeBlock['row']> = {},
): JudgeBlock => ({
  row: {
    height,
    indep_hash: crypto.randomBytes(48),
    previous_block: Buffer.alloc(48),
    nonce: Buffer.alloc(32),
    hash: Buffer.alloc(32),
    block_timestamp: 1,
    diff: '1',
    cumulative_diff: '1',
    last_retarget: 1,
    reward_addr: null,
    reward_pool: '0',
    block_size: 0,
    weave_size: 0,
    usd_to_ar_rate_dividend: null,
    usd_to_ar_rate_divisor: null,
    scheduled_usd_to_ar_rate_dividend: null,
    scheduled_usd_to_ar_rate_divisor: null,
    hash_list_merkle: null,
    wallet_list: null,
    tx_root: Buffer.alloc(0),
    tx_count: 0,
    ...fields,
  },
  txs: [],
  strayLinks: [],
});

describe('L1Judge and the fork-1.6 seed', () => {
  // No built chain can span this fork — `nextHashListMerkle` treats
  // 95,000 as a seed — so the judge is driven directly.
  const chain = (upTo: number) => {
    const blocks: JudgeBlock[] = [];
    let previous: Buffer | null = null;
    let fold: Buffer = Buffer.alloc(0);
    for (let height = 0; height <= upTo; height += 1) {
      const indep = Buffer.from(
        crypto.createHash('sha384').update(`b${height}`).digest(),
      );
      blocks.push(
        block(height, {
          indep_hash: indep,
          previous_block: previous,
          hash_list_merkle: height < FORK_1_6 ? Buffer.alloc(0) : fold,
        }),
      );
      if (height <= FORK_1_6 - 2) fold = sha384(fold, indep);
      previous = indep;
    }
    return blocks;
  };

  it('folds heights 0 to 94,998 and checks the seed at the fork', async () => {
    const judge = new L1Judge(0, FORK_1_6);
    for (const b of chain(FORK_1_6)) await judge.step(b);
    const { checks, totals, unbound } = judge.finish();
    const merkle = checks.find((c) => c.name === 'hash_list_merkle');
    assert.equal(merkle?.ok, true, JSON.stringify(merkle?.failures));
    assert.equal(totals.merkleChecked, FORK_1_6);
    assert.equal(totals.merkleSkipped, 0);
    // Every one of them is below the 2.0 fork: none is bound.
    assert.equal(unbound.pre20?.blocks, FORK_1_6 + 1);
  });

  it('rejects a seed that is not the fold of the hashes below it', async () => {
    const blocks = chain(FORK_1_6);
    blocks[FORK_1_6].row.hash_list_merkle = Buffer.alloc(48, 7);
    const judge = new L1Judge(0, FORK_1_6);
    for (const b of blocks) await judge.step(b);
    const merkle = judge
      .finish()
      .checks.find((c) => c.name === 'hash_list_merkle');
    assert.equal(merkle?.ok, false);
    assert.equal(merkle?.failures?.[0].height, FORK_1_6);
  });

  it('cannot rebuild the seed for a run that did not start at height 0', async () => {
    const blocks = chain(FORK_1_6).slice(FORK_1_6 - 3);
    const judge = new L1Judge(blocks[0].row.height, FORK_1_6);
    for (const b of blocks) await judge.step(b);
    assert.ok(judge.finish().totals.merkleSkipped > 0);
  });
});

describe('L1Judge on NULLs', () => {
  it('fails a NULL weave_size or data_size rather than reading it as zero', async () => {
    const judge = new L1Judge(500_000, 500_001);
    await judge.step(block(500_000, { hash_list_merkle: Buffer.alloc(48) }));
    await judge.step(block(500_001, { weave_size: null, block_size: null }));
    const nulls = judge.finish().checks.find((c) => c.name === 'nulls');
    assert.equal(nulls?.ok, false);
    assert.match(nulls?.failures?.[0].found ?? '', /block_size|weave_size/);
  });
});
