/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Recomputes the pinned 2.0 seed folds (`FORK_2_0_FOLD_PINS`) from
 * Arweave's own 2.0 checkpoint, the per-height `{hash, weave_size,
 * tx_root}` it committed for heights 0 to 399,999 and removed in
 * d43ba2b9. A pin that does not fold out of it is wrong, and every
 * `l1-4` band below the fork would be judged against it.
 *
 * Like `chain-drift.test.ts`, it needs an Arweave checkout (`$ARWEAVE_REPO`,
 * or `repos/arweave` here or up to three directories above) with its
 * history, and skips without one: CI has none. The fold at 422,249 is not
 * in the checkpoint; it was checked against block 422,250's
 * `hash_list_merkle` as two gateways serve it when the pins were taken.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import {
  foldBlockIndexEntry,
  foldH2,
  FORK_2_0,
  FORK_2_0_CHECKPOINT_SHA256,
  FORK_2_0_CHECKPOINT_TOP,
  FORK_2_0_FOLD_PINS,
  FORK_2_0_H2_PINS,
  HASH_LIST_1_0_SHA256,
} from './chain.js';

const CHECKPOINT = 'd43ba2b9^:apps/arweave/priv/fork_2_0_checkpoint';

function findArweave(): string | undefined {
  const given = process.env.ARWEAVE_REPO;
  if (given !== undefined && given !== '') {
    if (!fs.existsSync(path.join(given, 'apps/arweave/src'))) {
      throw new Error(`ARWEAVE_REPO=${given} is not an Arweave checkout`);
    }
    return path.resolve(given);
  }
  let at = path.resolve('.');
  for (let up = 0; up < 4; up += 1) {
    const candidate = path.join(at, 'repos/arweave');
    if (fs.existsSync(path.join(candidate, 'apps/arweave/src'))) {
      return candidate;
    }
    at = path.dirname(at);
  }
  return undefined;
}

/** The checkpoint's bytes, or undefined when the checkout lacks the commit. */
function readCheckpoint(repo: string): Buffer | undefined {
  try {
    return execFileSync('git', ['-C', repo, 'show', CHECKPOINT], {
      maxBuffer: 128 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
}

describe('the pinned 2.0 seed folds', () => {
  const repo = findArweave();
  const bytes = repo === undefined ? undefined : readCheckpoint(repo);
  if (bytes === undefined) {
    it('cannot be recomputed without an Arweave checkout with its history', () => {
      assert.ok(true, 'no checkout with d43ba2b9; run `mr update`');
    });

    return;
  }

  it('reads the checkpoint the build pins', () => {
    assert.equal(
      crypto.createHash('sha256').update(bytes).digest('hex'),
      FORK_2_0_CHECKPOINT_SHA256,
    );
  });

  it('folds out of it at every pinned height it covers', () => {
    const list = JSON.parse(bytes.toString('utf8')) as Array<{
      hash: string;
      weave_size: string;
      tx_root: string;
    }>;
    assert.equal(list.length, FORK_2_0_CHECKPOINT_TOP + 1);
    const covered = [...FORK_2_0_FOLD_PINS.keys()].filter(
      (h) => h <= FORK_2_0_CHECKPOINT_TOP,
    );
    assert.deepEqual(covered, [99_999, 199_999, 299_999, 399_999]);
    let fold: Buffer = Buffer.alloc(0);
    // Newest first: height h is at FORK_2_0_CHECKPOINT_TOP - h.
    for (let h = 0; h <= FORK_2_0_CHECKPOINT_TOP; h++) {
      const entry = list[FORK_2_0_CHECKPOINT_TOP - h];
      fold = foldBlockIndexEntry(fold, {
        indep_hash: Buffer.from(entry.hash, 'base64url'),
        weave_size: entry.weave_size,
        tx_root: Buffer.from(entry.tx_root, 'base64url'),
      });
      const pin = FORK_2_0_FOLD_PINS.get(h);
      if (pin !== undefined) {
        assert.equal(
          fold.toString('base64url'),
          pin.toString('base64url'),
          `the pin at ${h}`,
        );
      }
    }
  });
});

describe('the pinned folds of the 2.0 hashes', () => {
  const repo = findArweave();
  const file =
    repo === undefined
      ? undefined
      : path.join(repo, 'genesis_data/hash_list_1_0');
  if (file === undefined || !fs.existsSync(file)) {
    it('cannot be recomputed without an Arweave checkout', () => {
      assert.ok(true, 'no genesis_data/hash_list_1_0; run `mr update`');
    });

    return;
  }
  const bytes = fs.readFileSync(file);

  it('reads the list the build pins', () => {
    assert.equal(
      crypto.createHash('sha256').update(bytes).digest('hex'),
      HASH_LIST_1_0_SHA256,
    );
  });

  it('folds out of it at every pinned height', () => {
    const list = JSON.parse(bytes.toString('utf8')) as string[];
    assert.equal(list.length, FORK_2_0);
    assert.deepEqual(
      [...FORK_2_0_H2_PINS.keys()],
      [...FORK_2_0_FOLD_PINS.keys()],
    );
    let fold: Buffer = Buffer.alloc(0);
    // Newest first: height h is at FORK_2_0 - h - 1.
    for (let h = 0; h < FORK_2_0; h++) {
      fold = foldH2(fold, Buffer.from(list[FORK_2_0 - h - 1], 'base64url'));
      const pin = FORK_2_0_H2_PINS.get(h);
      if (pin !== undefined) {
        assert.equal(
          fold.toString('base64url'),
          pin.toString('base64url'),
          `the pin at ${h}`,
        );
      }
    }
  });
});
