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
import zlib from 'node:zlib';

import {
  BlockIndexEntry,
  hash20Of10Block,
  HeaderUnverifiable,
  hashListMerkleSeed,
  verifyHeader,
} from './block-hash.js';
import { ChainBlock, nextHashListMerkle } from './chain.js';

/**
 * Real mainnet headers, one per era, as `/block/height/N` served them on
 * 2026-10-22 (vilenarios.com and turbo-gateway.com served identical bytes).
 * From 2.6 on, the proof-of-access chunks are blanked: those eras hash the
 * chunk's hash, not the chunk.
 */
const header = (height: number): Record<string, any> =>
  JSON.parse(
    zlib
      .gunzipSync(
        fs.readFileSync(`test/fixtures/parquet-l1/headers/${height}.json.gz`),
      )
      .toString('utf8'),
  );
const ERAS = [
  422250, 422251, 633720, 812970, 1132210, 1275480, 1547120, 1602350, 2000000,
];

describe('verifyHeader', () => {
  for (const height of ERAS) {
    it(`recomputes the real header at ${height}`, () => {
      const json = header(height);
      const verified = verifyHeader(json);
      assert.equal(verified.indepHash.toString('base64url'), json.indep_hash);
      assert.equal(verified.weaveSize, BigInt(json.weave_size));
      assert.deepEqual(
        verified.txs.map((t) => t.toString('base64url')),
        json.txs,
      );
    });
  }

  const mutations: Array<[string, (j: Record<string, any>) => void]> = [
    [
      'weave_size + 1',
      (j) => (j.weave_size = String(BigInt(j.weave_size) + 1n)),
    ],
    [
      'block_size + 1',
      (j) => (j.block_size = String(BigInt(j.block_size) + 1n)),
    ],
    [
      'hash_list_merkle swapped',
      (j) =>
        (j.hash_list_merkle = crypto.randomBytes(48).toString('base64url')),
    ],
    [
      'tx_root changed',
      (j) => (j.tx_root = crypto.randomBytes(32).toString('base64url')),
    ],
    [
      'previous_block changed',
      (j) => (j.previous_block = crypto.randomBytes(48).toString('base64url')),
    ],
    [
      'a transaction added',
      (j) => j.txs.push(crypto.randomBytes(32).toString('base64url')),
    ],
  ];
  for (const height of [422250, 812970, 1132210, 2000000]) {
    for (const [name, mutate] of mutations) {
      it(`refuses ${height} with ${name}`, () => {
        const json = header(height);
        mutate(json);
        assert.throws(() => verifyHeader(json), HeaderUnverifiable);
      });
    }

    it(`refuses ${height} with its transactions reordered`, () => {
      const json = header(height);
      if (json.txs.length < 2) json.txs.push(json.txs[0] ?? 'AA');
      json.txs.reverse();
      assert.throws(() => verifyHeader(json), HeaderUnverifiable);
    });
  }

  it('refuses a header claiming a different hash for its own fields', () => {
    const json = header(2000000);
    json.indep_hash = crypto.randomBytes(48).toString('base64url');
    assert.throws(() => verifyHeader(json), /not the indep_hash/);
  });

  it('refuses a key it does not know for the era (a later fork)', () => {
    const json = header(2000000);
    json.some_future_field = 'AAAA';
    assert.throws(() => verifyHeader(json), /some_future_field/);
    const old = header(633720);
    old.usd_to_ar_rate = ['1', '2'];
    assert.throws(() => verifyHeader(old), /usd_to_ar_rate/);
  });

  it('refuses a header missing a required key', () => {
    const json = header(1275480);
    delete json.chunk_hash;
    assert.throws(() => verifyHeader(json), /chunk_hash/);
  });

  it('refuses features no tested mainnet header has: ECDSA reward_key, double-signing proof, block tags', () => {
    const ecdsa = header(2000000);
    ecdsa.reward_key = crypto.randomBytes(33).toString('base64url');
    assert.throws(() => verifyHeader(ecdsa), /reward_key/);
    const dsp = header(2000000);
    dsp.double_signing_proof = { pub_key: 'AA' };
    assert.throws(() => verifyHeader(dsp), /double_signing_proof/);
    const tags = header(1132210);
    tags.tags = ['AA'];
    assert.throws(() => verifyHeader(tags), /tags/);
  });

  it('refuses a pre-2.0 header: its hash is over the full wallet list', () => {
    const json = header(422250);
    json.height = 422249;
    assert.throws(() => verifyHeader(json), /below the 2.0 fork/);
  });

  it('refuses malformed values rather than reading them loosely', () => {
    const json = header(2000000);
    json.weave_size = '1.5e14';
    assert.throws(() => verifyHeader(json), /weave_size/);
    const bad = header(2000000);
    bad.tx_root = 'not/base64url';
    assert.throws(() => verifyHeader(bad), /tx_root/);
  });
});

/** Rows from a real `core.db`, see the fixture's `source`. */
const rows = JSON.parse(
  fs.readFileSync('test/fixtures/parquet-l1/header-rows.json', 'utf8'),
).blocks as Array<Record<string, any>>;
const hex = (v: string | null) => (v === null ? null : Buffer.from(v, 'hex'));
/** `genesis_data/hash_list_1_0` at `422250 - height - 1`, for the heights below. */
const HASH_LIST_1_0: Record<number, string> = {
  50000: 'CC9AHzXkwJo0GSAlT_3eEHRXUBhZa06bF9tiyPH0oc4zDCdhflSwT-xpposGklxw',
  300000: 'DvBQe6KADtwRWjcWXbtew3sJVZ2BoA0CADwj5fx9lCHOw_PRLC3KbwhgzMlr85jV',
  422249: 'fvMLdh-qYS8OhGA1cXTfuKX9QOQX37hTWIE1vWzLhKxg1UDBCFjOs6r4gX0Z4uOx',
};
/**
 * The transition `tx_root` of two pre-2.0 blocks with transactions,
 * computed from their v1 data as `ar_transition` did (fetched 2026-10-22).
 */
const WITNESS: Record<number, string> = {
  50000: '',
  300000: 'vNDqU8O-10RfxvpRMtAogkgkW_r2x2Kw82X6XS0tkl4',
  422249: 'V3epcNLlG2kJFeBM_z-cs3Lc4sInNZXVCUDaT5Y8R-k',
};

describe('hash20Of10Block', () => {
  const columns = (r: Record<string, any>) => ({
    height: r.height,
    previous_block: hex(r.previous_block),
    nonce: hex(r.nonce) as Buffer,
    hash: hex(r.hash) as Buffer,
    block_timestamp: r.block_timestamp,
    last_retarget: r.last_retarget,
    diff: r.diff,
    cumulative_diff: r.cumulative_diff,
    reward_addr: hex(r.reward_addr),
    reward_pool: r.reward_pool,
    block_size: r.block_size,
    weave_size: r.weave_size,
    wallet_list: hex(r.wallet_list),
    hash_list_merkle: hex(r.hash_list_merkle),
  });
  for (const height of [50000, 300000, 422249]) {
    it(`gives the hardcoded 2.0 hash of ${height} from stored columns and its witness`, () => {
      const r = rows.find((b) => b.height === height) as Record<string, any>;
      const got = hash20Of10Block(
        columns(r),
        r.txs.map((t: string) => Buffer.from(t, 'hex')),
        Buffer.from(WITNESS[height], 'base64url'),
      );
      assert.equal(got.toString('base64url'), HASH_LIST_1_0[height]);
    });
  }

  it('differs with a wrong witness or a changed column', () => {
    const r = rows.find((b) => b.height === 422249) as Record<string, any>;
    const ids = r.txs.map((t: string) => Buffer.from(t, 'hex'));
    const witness = Buffer.from(WITNESS[422249], 'base64url');
    const wrong = Buffer.from(witness);
    wrong[0] ^= 1;
    assert.notEqual(
      hash20Of10Block(columns(r), ids, wrong).toString('base64url'),
      HASH_LIST_1_0[422249],
    );
    assert.notEqual(
      hash20Of10Block(
        { ...columns(r), weave_size: Number(r.weave_size) + 1 },
        ids,
        witness,
      ).toString('base64url'),
      HASH_LIST_1_0[422249],
    );
  });
});

describe('hashListMerkleSeed', () => {
  it('is the post-2.0 recurrence folded from nothing', () => {
    const entries: Array<BlockIndexEntry & ChainBlock> = [];
    for (let i = 0; i < 6; i += 1) {
      entries.push({
        height: 500_000 + i,
        indep_hash: crypto.randomBytes(48),
        previous_block: null,
        weave_size: 1000 * i,
        tx_root: i % 2 === 0 ? Buffer.alloc(0) : crypto.randomBytes(32),
        hash_list_merkle: null,
      });
    }
    // Each block's merkle is the seed of everything below it: the fold
    // over a prefix equals the recurrence run from the fold of a shorter one.
    const seed3 = hashListMerkleSeed(entries.slice(0, 3));
    const seed4 = hashListMerkleSeed(entries.slice(0, 4));
    assert.deepEqual(
      nextHashListMerkle({ ...entries[3], hash_list_merkle: seed3 }),
      seed4,
    );
  });
});
