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
import { BlockWalker, CheckedBlock } from './verify-steps.js';

const sha384 = (...parts: Buffer[]): Buffer =>
  Buffer.from(
    crypto.createHash('sha384').update(Buffer.concat(parts)).digest(),
  );

describe('BlockWalker and the fork-1.6 seed', () => {
  // No built chain can span this fork — `nextHashListMerkle` treats
  // 95,000 as a seed, so a fixture cannot cross it, and both verifiers'
  // use of the fold was therefore untested. Driving the walker directly
  // is the only way to cover it short of the mainnet run.
  const chain = (upTo: number) => {
    const blocks: CheckedBlock[] = [];
    let previous: Buffer | null = null;
    let fold: Buffer = Buffer.alloc(0);
    for (let height = 0; height <= upTo; height += 1) {
      const indep = Buffer.from(
        crypto.createHash('sha384').update(`b${height}`).digest(),
      );
      blocks.push({
        height,
        indep_hash: indep,
        previous_block: previous,
        block_size: 0,
        weave_size: 0,
        // Empty below the fork; at the fork it must equal the fold.
        hash_list_merkle: height < FORK_1_6 ? Buffer.alloc(0) : fold,
        tx_root: null,
      });
      if (height <= FORK_1_6 - 2) fold = sha384(fold, indep);
      previous = indep;
    }
    return blocks;
  };

  it('folds heights 0 to 94,998 and checks the seed at the fork', () => {
    const blocks = chain(FORK_1_6);
    const walker = new BlockWalker(0, FORK_1_6);
    for (const block of blocks) walker.step(block, 0);
    const { checks, totals } = walker.finish();

    const merkle = checks.find((c) => c.name === 'hash_list_merkle');
    assert.equal(merkle?.ok, true, JSON.stringify(merkle?.failures));
    assert.equal(totals.blocks, FORK_1_6 + 1);
    // Every height above 0 is compared, the seed at the fork included:
    // a walker that dropped the fold would skip that one instead.
    assert.equal(totals.merkleChecked, FORK_1_6);
    assert.equal(totals.merkleSkipped, 0);
  });

  it('rejects a seed that is not the fold of the hashes below it', () => {
    const blocks = chain(FORK_1_6);
    blocks[FORK_1_6].hash_list_merkle = Buffer.alloc(48, 7);
    const walker = new BlockWalker(0, FORK_1_6);
    for (const block of blocks) walker.step(block, 0);
    const { checks } = walker.finish();
    const merkle = checks.find((c) => c.name === 'hash_list_merkle');
    assert.equal(merkle?.ok, false);
    assert.equal(merkle?.failures?.[0].height, FORK_1_6);
  });

  it('cannot rebuild the seed for a run that did not start at height 0', () => {
    // The fold needs every hash from 0, so a range starting above it
    // must count the seed out rather than guess.
    const blocks = chain(FORK_1_6).slice(FORK_1_6 - 3);
    const walker = new BlockWalker(blocks[0].height, FORK_1_6);
    for (const block of blocks) walker.step(block, 0);
    const { totals } = walker.finish();
    assert.ok(totals.merkleSkipped > 0, 'the seed was counted out');
  });
});
