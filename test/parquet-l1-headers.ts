/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * A test chain that verifies as Arweave's would: block headers whose
 * identity hash is recomputed by the same code the verifier uses
 * (`recomputeIndepHash`), and a scripted node that serves them, with the
 * transactions' signatures, so an anchored, sampled verification can run
 * without the network.
 *
 * The header fields an index stores come from the `core.db` row; the rest
 * (the VDF, the proofs, the block signature) are filler derived from the
 * height, so the node can rebuild the same header whenever it is asked.
 * Only eras from the 2.9 fork are built: the real headers of every era are
 * tested in `block-hash.test.ts`.
 */
import crypto from 'node:crypto';
import Sqlite from 'better-sqlite3';

import {
  FORK_2_9,
  recomputeIndepHash,
} from '../src/lib/parquet-l1/block-hash.js';
import type { FetchLike } from '../src/lib/onchain/arweave-nodes.js';

const b64 = (b: Buffer | null | undefined) =>
  (b ?? Buffer.alloc(0)).toString('base64url');

/** Deterministic filler bytes for a height and a field. */
const filler = (height: number, field: string, n: number): Buffer => {
  const out: Buffer[] = [];
  for (let i = 0; out.length * 32 < n; i += 1) {
    out.push(
      crypto.createHash('sha256').update(`${height}:${field}:${i}`).digest(),
    );
  }
  return Buffer.concat(out).subarray(0, n);
};

/** The stored columns a header is built from. */
export interface HeaderRow {
  height: number;
  indep_hash?: Buffer | null;
  previous_block: Buffer | null;
  nonce: Buffer;
  hash: Buffer;
  block_timestamp: number;
  diff: string;
  cumulative_diff: string | null;
  last_retarget: number;
  reward_addr: Buffer | null;
  reward_pool: string;
  block_size: number;
  weave_size: number;
  usd_to_ar_rate_dividend: number | null;
  usd_to_ar_rate_divisor: number | null;
  scheduled_usd_to_ar_rate_dividend: number | null;
  scheduled_usd_to_ar_rate_divisor: number | null;
  hash_list_merkle: Buffer | null;
  wallet_list: Buffer | null;
  tx_root: Buffer | string | null;
}

/**
 * A `/block/height/N` answer for a row and its transaction ids in block
 * order, its `indep_hash` the hash its fields give (or `row.indep_hash`
 * when given, as a node that lies about it would serve).
 */
export function syntheticHeader(
  row: HeaderRow,
  txIds: Buffer[],
  claimed?: Buffer,
): Record<string, any> {
  const h = row.height;
  if (h < FORK_2_9) {
    throw new Error(`test headers are built from the 2.9 fork on, not ${h}`);
  }
  const f = (field: string, n: number) => b64(filler(h, field, n));
  const poa = {
    option: '1',
    tx_path: f('tx_path', 64),
    data_path: f('data_path', 96),
    chunk: '',
  };
  const txRoot =
    typeof row.tx_root === 'string'
      ? Buffer.from(row.tx_root, 'utf8')
      : row.tx_root;
  const json: Record<string, any> = {
    nonce: b64(row.nonce),
    previous_block: b64(row.previous_block),
    timestamp: row.block_timestamp,
    last_retarget: row.last_retarget,
    diff: String(row.diff),
    height: h,
    hash: b64(row.hash),
    indep_hash: '',
    txs: txIds.map((t) => b64(t)),
    tx_root: b64(txRoot),
    wallet_list: b64(row.wallet_list),
    reward_addr: row.reward_addr === null ? 'unclaimed' : b64(row.reward_addr),
    tags: [],
    reward_pool: String(row.reward_pool),
    weave_size: String(row.weave_size),
    block_size: String(row.block_size),
    cumulative_diff: String(row.cumulative_diff ?? '0'),
    hash_list_merkle: b64(row.hash_list_merkle),
    poa,
    usd_to_ar_rate: [
      String(row.usd_to_ar_rate_dividend ?? 1),
      String(row.usd_to_ar_rate_divisor ?? 10),
    ],
    scheduled_usd_to_ar_rate: [
      String(row.scheduled_usd_to_ar_rate_dividend ?? 1),
      String(row.scheduled_usd_to_ar_rate_divisor ?? 10),
    ],
    packing_2_5_threshold: '0',
    strict_data_split_threshold: '30607159107830',
    hash_preimage: f('hash_preimage', 32),
    recall_byte: '123456',
    reward: '1000',
    previous_solution_hash: f('previous_solution_hash', 32),
    partition_number: 3,
    nonce_limiter_info: {
      output: f('output', 32),
      global_step_number: h * 10,
      seed: f('seed', 48),
      next_seed: f('next_seed', 48),
      zone_upper_bound: 1000,
      next_zone_upper_bound: 2000,
      prev_output: f('prev_output', 32),
      last_step_checkpoints: [f('lsc', 32)],
      checkpoints: [f('cp0', 32), f('cp1', 32)],
      vdf_difficulty: 600000,
      next_vdf_difficulty: 600000,
    },
    poa2: { ...poa, tx_path: f('tx_path2', 64) },
    signature: f('signature', 512),
    reward_key: f('reward_key', 512),
    price_per_gib_minute: '6000',
    scheduled_price_per_gib_minute: '6001',
    reward_history_hash: f('reward_history_hash', 32),
    debt_supply: '0',
    kryder_plus_rate_multiplier: '1',
    kryder_plus_rate_multiplier_latch: '0',
    denomination: '1',
    redenomination_height: 0,
    double_signing_proof: {},
    previous_cumulative_diff: '1',
    merkle_rebase_support_threshold: '151066495197430',
    chunk_hash: f('chunk_hash', 32),
    block_time_history_hash: f('block_time_history_hash', 32),
  };
  json.indep_hash = b64(claimed ?? recomputeIndepHash(json));
  return json;
}

/** A node's answer to one path: a status and a JSON body. */
export type NodeAnswer = { status: number; body?: unknown };

/**
 * A node serving a `core.db` built by `buildCoreDb({ verifiable: true })`:
 * `/block/height/N`, `/block/hash/H` and `/tx/{id}`, each answer passed
 * through `tamper` (to script a lying or failing node).
 */
export function chainNode(
  coreDb: string,
  tamper: (path: string, answer: NodeAnswer) => NodeAnswer = (_p, a) => a,
): (path: string) => NodeAnswer {
  return (path: string) => {
    const db = new Sqlite(coreDb, { readonly: true });
    try {
      const block = (where: string, value: unknown): NodeAnswer => {
        const row = db
          .prepare(`SELECT * FROM stable_blocks WHERE ${where} = ?`)
          .get(value) as (HeaderRow & { indep_hash: Buffer }) | undefined;
        if (row === undefined) return { status: 404 };
        const ids = db
          .prepare(
            'SELECT id FROM stable_transactions WHERE height = ? ORDER BY block_transaction_index',
          )
          .pluck()
          .all(row.height) as Buffer[];
        return { status: 200, body: syntheticHeader(row, ids) };
      };
      let m = /^\/block\/height\/(\d+)$/.exec(path);
      if (m !== null) return tamper(path, block('height', Number(m[1])));
      m = /^\/block\/hash\/([A-Za-z0-9_-]+)$/.exec(path);
      if (m !== null) {
        return tamper(
          path,
          block('indep_hash', Buffer.from(m[1], 'base64url')),
        );
      }
      m = /^\/tx\/([A-Za-z0-9_-]+)$/.exec(path);
      if (m !== null) {
        const id = Buffer.from(m[1], 'base64url');
        const row = db
          .prepare(
            'SELECT t.format, s.signature FROM stable_transactions t JOIN test_signatures s ON s.id = t.id WHERE t.id = ?',
          )
          .get(id) as { format: number; signature: Buffer } | undefined;
        if (row === undefined) return tamper(path, { status: 404 });
        return tamper(path, {
          status: 200,
          body: { id: m[1], format: row.format, signature: b64(row.signature) },
        });
      }
      return tamper(path, { status: 404 });
    } finally {
      db.close();
    }
  };
}

/**
 * A `fetch` that routes each URL to the node answering for its origin, and
 * counts the requests each origin was asked.
 */
export function scriptedFetch(
  nodes: Record<string, (path: string) => NodeAnswer>,
): FetchLike & { asked: Map<string, number> } {
  const asked = new Map<string, number>();
  const fetchFn = (async (url: string) => {
    const { origin, pathname } = new URL(url);
    asked.set(origin, (asked.get(origin) ?? 0) + 1);
    const node = nodes[origin];
    if (node === undefined) throw new TypeError(`fetch failed: ${origin}`);
    const answer = node(pathname);
    return {
      status: answer.status,
      ok: answer.status >= 200 && answer.status < 300,
      json: async () => answer.body,
    };
  }) as unknown as FetchLike & { asked: Map<string, number> };
  fetchFn.asked = asked;
  return fetchFn;
}

/** A resolver mapping each test host to its own address, or as `shared` says. */
export function scriptedLookup(
  shared: Record<string, string[]> = {},
): (host: string) => Promise<string[]> {
  let next = 1;
  const given = new Map<string, string[]>();
  return async (host: string) => {
    if (shared[host] !== undefined) return shared[host];
    if (!given.has(host)) {
      given.set(host, [`192.0.2.${next}`]);
      next += 1;
    }
    return given.get(host) as string[];
  };
}
