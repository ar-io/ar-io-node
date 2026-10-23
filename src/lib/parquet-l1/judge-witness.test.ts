/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The judge with `l1-4` witnesses, driven directly: a chain across the 2.0
 * fork whose pre-2.0 blocks carry transition `tx_root`s and folds, and
 * whose format-1 transactions carry v1 data roots. The pinned folds are the
 * test chain's own, given as `foldPins`, as the conformance suite gives
 * them; mainnet's are checked against Arweave's checkpoint in
 * `fork-2-0-pins.test.ts`.
 */
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';

import {
  computeTxRoot,
  foldBlockIndexEntry,
  FORK_2_0,
  FORK_2_0_FOLD_PINS,
  nextHashListMerkle,
} from './chain.js';
import { JudgeBlock, JudgeTx, L1Judge } from './judge.js';

const FROM = FORK_2_0 - 5;
const TO = FORK_2_0 + 2;

const tx = (
  id: Buffer,
  format: number,
  dataSize: number,
  dataRoot: Buffer | null,
  index: number,
): JudgeTx => ({
  block_transaction_index: index,
  id,
  format,
  data_size: dataSize,
  data_root: dataRoot,
  owner_address: Buffer.alloc(32, 1),
  tag_count: 0,
  nullAmounts: false,
  link: id,
  tags: { n: 0, min: null, max: null, distinct: 0 },
  ownerKnown: true,
});

interface Chain {
  blocks: JudgeBlock[];
  /** The v1 data root of every format-1 transaction with data, by base64url id. */
  roots: Map<string, Buffer>;
  /** The test chain's pins: the fold below FROM and through FORK_2_0 - 1. */
  pins: Map<number, Buffer>;
}

/**
 * Heights FROM to TO: each pre-2.0 block with two format-1 transactions
 * (one with data), FORK_2_0 + 1 with a format-1 transaction with data and a
 * format-2 one, each block's hash_list_merkle by its era's rule.
 */
async function buildChain(): Promise<Chain> {
  const roots = new Map<string, Buffer>();
  const pins = new Map<number, Buffer>();
  let fold = crypto.randomBytes(48);
  pins.set(FROM - 1, fold);
  let previous: JudgeBlock | undefined;
  let weave = 1_000_000n;
  const blocks: JudgeBlock[] = [];
  for (let h = FROM; h <= TO; h++) {
    const txs: JudgeTx[] = [];
    if (h < FORK_2_0 || h === FORK_2_0 + 1) {
      // Ids that sort format-1 data first and the format-2 one last, so a
      // relabel below keeps the tree's order.
      const withData = Buffer.concat([
        Buffer.from([0]),
        crypto.randomBytes(31),
      ]);
      roots.set(withData.toString('base64url'), crypto.randomBytes(32));
      txs.push(tx(withData, 1, 1000 + (h % 7), null, 0));
      txs.push(
        h < FORK_2_0
          ? tx(crypto.randomBytes(32), 1, 0, null, 1)
          : tx(
              Buffer.concat([Buffer.from([0xff]), crypto.randomBytes(31)]),
              2,
              500,
              crypto.randomBytes(32),
              1,
            ),
      );
    }
    const size = txs.reduce((n, t) => n + BigInt(t.data_size ?? 0), 0n);
    weave += size;
    const root = (await computeTxRoot(
      h,
      txs.map((t) => ({
        id: t.id as Buffer,
        format: t.format as number,
        data_size: t.data_size as number,
        data_root: t.data_root,
      })),
      roots,
    )) as Buffer;
    const indep = crypto.randomBytes(48);
    const block: JudgeBlock = {
      row: {
        height: h,
        indep_hash: indep,
        previous_block: previous?.row.indep_hash ?? crypto.randomBytes(48),
        nonce: Buffer.alloc(32),
        hash: Buffer.alloc(32),
        block_timestamp: 1,
        diff: '1',
        cumulative_diff: '1',
        last_retarget: 1,
        reward_addr: null,
        reward_pool: '0',
        block_size: size,
        weave_size: weave,
        usd_to_ar_rate_dividend: null,
        usd_to_ar_rate_divisor: null,
        scheduled_usd_to_ar_rate_dividend: null,
        scheduled_usd_to_ar_rate_divisor: null,
        hash_list_merkle: crypto.randomBytes(48),
        wallet_list: null,
        tx_root: h < FORK_2_0 ? null : root,
        tx_count: txs.length,
      },
      txs,
      strayLinks: [],
    };
    if (h < FORK_2_0) {
      // 1.6-2.0 recurrence: the hash of the block below.
      if (previous !== undefined) {
        block.row.hash_list_merkle = nextHashListMerkle({
          ...previous.row,
          weave_size: previous.row.weave_size as bigint,
        } as never);
      }
      fold = foldBlockIndexEntry(fold, {
        indep_hash: indep,
        weave_size: weave,
        tx_root: root,
      });
      block.witness = {
        v1Roots: new Map(
          txs
            .filter((t) => t.format === 1 && Number(t.data_size) > 0)
            .map((t) => {
              const id = (t.id as Buffer).toString('base64url');
              return [id, roots.get(id) as Buffer];
            }),
        ),
        fork20: { txRoot: root, fold },
      };
      if (h === FORK_2_0 - 1) pins.set(h, fold);
    } else {
      block.row.hash_list_merkle =
        h === FORK_2_0
          ? fold
          : nextHashListMerkle({
              ...(previous as JudgeBlock).row,
              weave_size: (previous as JudgeBlock).row.weave_size as bigint,
            } as never);
      block.witness = {
        v1Roots: new Map(
          txs
            .filter((t) => t.format === 1)
            .map((t) => {
              const id = (t.id as Buffer).toString('base64url');
              return [id, roots.get(id) as Buffer];
            }),
        ),
      };
    }
    blocks.push(block);
    previous = block;
  }
  return { blocks, roots, pins };
}

async function judgeChain(
  blocks: JudgeBlock[],
  pins: ReadonlyMap<number, Buffer>,
  from = FROM,
) {
  const judge = new L1Judge(from, TO, { foldPins: pins, witnesses: true });
  for (const b of blocks) await judge.step(b);
  const out = judge.finish();
  const failing = out.checks.filter((c) => !c.ok).map((c) => c.name);
  return { ...out, failing };
}

const strip = (b: JudgeBlock): JudgeBlock => {
  const { witness: _w, ...rest } = b;
  void _w;
  return rest;
};

describe('L1Judge with l1-4 witnesses', () => {
  it('binds every block of an honest chain: no unbound class, no failure', async () => {
    const { blocks, pins } = await buildChain();
    const out = await judgeChain(blocks, pins);
    assert.deepEqual(out.failing, []);
    assert.deepEqual(out.unbound, {});
    assert.equal(out.totals.foldBound, FORK_2_0 - FROM);
    // Every block's tx_root (transition or header) recomputed.
    assert.equal(out.totals.txRootChecked, TO - FROM + 1);
    assert.ok(out.checks.some((c) => c.name === 'witnesses' && c.ok));
  });

  it('binds through block 422,250 alone when no pin is crossed but the start', async () => {
    const { blocks, pins } = await buildChain();
    const startOnly = new Map([[FROM - 1, pins.get(FROM - 1) as Buffer]]);
    const out = await judgeChain(blocks, startOnly);
    assert.deepEqual(out.failing, []);
    assert.deepEqual(out.unbound, {});
    assert.equal(out.totals.foldBound, FORK_2_0 - FROM);
  });

  it('leaves an l1-3 chain where it was: pre20 and txRootFormat1 unbound', async () => {
    const { blocks, pins } = await buildChain();
    const out = await judgeChain(blocks.map(strip), pins);
    assert.deepEqual(out.failing, []);
    assert.equal(out.unbound.pre20?.blocks, FORK_2_0 - FROM);
    assert.equal(out.unbound.txRootFormat1?.blocks, 1);
    assert.equal(out.totals.foldBound, 0);
  });

  it('fails tx_root for a wrong v1 root above the fork, never unbound', async () => {
    const { blocks, pins } = await buildChain();
    const post = blocks.find((b) => b.row.height === FORK_2_0 + 1)!;
    const [id] = [...post.witness!.v1Roots.keys()];
    post.witness = { v1Roots: new Map([[id, crypto.randomBytes(32)]]) };
    const out = await judgeChain(blocks, pins);
    assert.deepEqual(out.failing, ['tx_root']);
    assert.equal(out.unbound.txRootFormat1, undefined);
  });

  it('fails tx_root for a wrong v1 root below the fork', async () => {
    const { blocks, pins } = await buildChain();
    const pre = blocks[1];
    const [id] = [...pre.witness!.v1Roots.keys()];
    pre.witness = {
      ...pre.witness!,
      v1Roots: new Map([[id, crypto.randomBytes(32)]]),
    };
    const out = await judgeChain(blocks, pins);
    assert.deepEqual(out.failing, ['tx_root']);
    assert.equal(
      out.checks.find((c) => c.name === 'tx_root')?.failures?.[0].height,
      pre.row.height,
    );
  });

  it('fails a wrong transition tx_root, even with every fold rebuilt on it', async () => {
    const { blocks, pins } = await buildChain();
    // A forger changes one witnessed tx_root and recomputes the folds above.
    let fold = pins.get(FROM - 1) as Buffer;
    for (const b of blocks.filter((x) => x.row.height < FORK_2_0)) {
      const w = b.witness!.fork20!;
      const txRoot =
        b.row.height === FROM + 2 ? crypto.randomBytes(32) : w.txRoot;
      fold = foldBlockIndexEntry(fold, {
        indep_hash: b.row.indep_hash as Buffer,
        weave_size: b.row.weave_size as bigint,
        tx_root: txRoot,
      });
      b.witness = { ...b.witness!, fork20: { txRoot, fold } };
    }
    const out = await judgeChain(blocks, pins);
    // Its transactions do not give it, and the fold no longer reaches the
    // chain's: both the pin and block 422,250's merkle refute it.
    assert.deepEqual(out.failing, ['hash_list_merkle', 'tx_root']);
    assert.equal(out.totals.foldBound, 0);
  });

  it('fails a witnessed fold that is not the fold of the block below', async () => {
    const { blocks, pins } = await buildChain();
    blocks[2].witness!.fork20!.fold = crypto.randomBytes(48);
    const out = await judgeChain(blocks, pins);
    assert.deepEqual(out.failing, ['witnesses']);
  });

  it('refutes a block whose hash or weave the fold does not carry', async () => {
    const { blocks, pins } = await buildChain();
    // Forged weave_size, with block_size and the links kept consistent.
    blocks[2].row.weave_size = (blocks[2].row.weave_size as bigint) + 1n;
    blocks[2].row.block_size = (blocks[2].row.block_size as bigint) + 1n;
    blocks[3].row.block_size = (blocks[3].row.block_size as bigint) - 1n;
    const out = await judgeChain(blocks, pins);
    assert.ok(out.failing.includes('witnesses'), out.failing.join());
  });

  it('fails a fold that reaches a value other than the pinned one', async () => {
    const { blocks, pins } = await buildChain();
    const wrong = new Map(pins);
    wrong.set(FORK_2_0 - 1, crypto.randomBytes(48));
    const out = await judgeChain(blocks, wrong);
    assert.ok(out.failing.includes('hash_list_merkle'), out.failing.join());
  });

  it('leaves a block without a witness row, and the run its fold is waiting on, unbound', async () => {
    const { blocks, pins } = await buildChain();
    const gap = FROM + 2;
    blocks[2].witness = { ...blocks[2].witness!, fork20: null };
    const out = await judgeChain(blocks, pins);
    assert.deepEqual(out.failing, []);
    // FROM and FROM + 1 waited on the fold through the gap; the gap itself;
    // FROM + 3 took its fold as given; FROM + 4 is bound through the pin.
    assert.deepEqual(out.unbound.pre20?.heights, [
      FROM,
      FROM + 1,
      gap,
      gap + 1,
    ]);
    assert.equal(out.totals.foldBound, 1);
  });

  it('leaves a block whose v1 root is missing in txRootFormat1, its header still bound', async () => {
    const { blocks, pins } = await buildChain();
    blocks[1].witness = { ...blocks[1].witness!, v1Roots: new Map() };
    const post = blocks.find((b) => b.row.height === FORK_2_0 + 1)!;
    post.witness = { v1Roots: new Map() };
    const out = await judgeChain(blocks, pins);
    assert.deepEqual(out.failing, []);
    assert.deepEqual(out.unbound.txRootFormat1?.heights, [
      FROM + 1,
      FORK_2_0 + 1,
    ]);
    assert.equal(out.unbound.pre20, undefined);
    assert.equal(out.totals.foldBound, FORK_2_0 - FROM);
  });

  it('takes the first fold as given when nothing pins the one below the run', async () => {
    const { blocks, pins } = await buildChain();
    const noStart = new Map(pins);
    noStart.delete(FROM - 1);
    const out = await judgeChain(blocks, noStart);
    assert.deepEqual(out.failing, []);
    assert.deepEqual(out.unbound.pre20?.heights, [FROM]);
    assert.equal(out.totals.foldBound, FORK_2_0 - FROM - 1);
  });

  it("checks block 422,250's hash_list_merkle against mainnet's pin even without witnesses", async () => {
    const { blocks } = await buildChain();
    // The test chain is not mainnet: its 2.0 seed is not the pinned one.
    const judge = new L1Judge(FROM, TO);
    for (const b of blocks.map(strip)) await judge.step(b);
    const merkle = judge
      .finish()
      .checks.find((c) => c.name === 'hash_list_merkle');
    assert.equal(merkle?.ok, false);
    assert.equal(merkle?.failures?.[0].height, FORK_2_0);
    assert.equal(
      merkle?.failures?.[0].expected,
      (FORK_2_0_FOLD_PINS.get(FORK_2_0 - 1) as Buffer).toString('base64url'),
    );
  });

  it('passes a format-2 transaction relabelled format 1 with its own root: only the sample catches that', async () => {
    const { blocks, pins } = await buildChain();
    const post = blocks.find((b) => b.row.height === FORK_2_0 + 1)!;
    const v2 = post.txs.find((t) => t.format === 2)!;
    // Sorted after the format-1 one already, so the tree is unchanged.
    post.witness = {
      v1Roots: new Map([
        ...post.witness!.v1Roots,
        [(v2.id as Buffer).toString('base64url'), v2.data_root as Buffer],
      ]),
    };
    v2.format = 1;
    v2.data_root = null;
    const out = await judgeChain(blocks, pins);
    assert.deepEqual(out.failing, []);
    assert.deepEqual(out.unbound, {});
  });
});
