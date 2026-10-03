/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import Sqlite from 'better-sqlite3';

import {
  ChainBlock,
  computeTxRoot,
  nextHashListMerkle,
} from '../src/lib/parquet-l1/chain.js';

const random = (n: number) => crypto.randomBytes(n);

/**
 * Writes a chain that obeys Arweave's rules to a `core.db` built from the
 * gateway's schema: heights `first - 1` (the anchor) to `first + count - 1`, each with
 * up to three transactions with tags. With `genesis`, a lone block at height
 * 0 as well, for a `core.db` that (as far as its lowest height says) holds
 * the chain from the start.
 */
export async function buildCoreDb(
  file: string,
  first: number,
  count: number,
  {
    genesis = false,
    signatures = false,
  }: { genesis?: boolean; signatures?: boolean } = {},
): Promise<void> {
  const db = new Sqlite(file);
  db.exec(fs.readFileSync('test/core-schema.sql', 'utf8'));
  const insertBlock = db.prepare(`INSERT INTO stable_blocks (height, indep_hash,
    previous_block, nonce, hash, block_timestamp, diff, cumulative_diff,
    last_retarget, reward_addr, reward_pool, block_size, weave_size,
    hash_list_merkle, tx_root, tx_count, missing_tx_count)
    VALUES (?, ?, ?, ?, ?, ?, '1', '2', 3, ?, '4', ?, ?, ?, ?, ?, 0)`);
  const insertLink = db.prepare(`INSERT INTO stable_block_transactions
    (block_indep_hash, transaction_id, block_transaction_index) VALUES (?, ?, ?)`);
  const insertTx = db.prepare(`INSERT INTO stable_transactions (id, height,
    block_transaction_index, format, last_tx, owner_address, target, quantity,
    reward, data_size, data_root, content_type, tag_count, offset, indexed_at,
    signature)
    VALUES (?, ?, ?, 2, ?, ?, NULL, '1000000000000', '42', ?, ?, 'text/plain', ?, ?, 5, ?)`);
  const insertTagName = db.prepare(
    'INSERT OR IGNORE INTO tag_names (hash, name) VALUES (?, ?)',
  );
  const insertTagValue = db.prepare(
    'INSERT OR IGNORE INTO tag_values (hash, value) VALUES (?, ?)',
  );
  const insertTag =
    db.prepare(`INSERT INTO stable_transaction_tags (tag_name_hash,
    tag_value_hash, height, block_transaction_index, transaction_tag_index,
    transaction_id) VALUES (?, ?, ?, ?, ?, ?)`);
  const insertWallet = db.prepare(
    'INSERT OR IGNORE INTO wallets (address, public_modulus) VALUES (?, ?)',
  );
  const sha1 = (b: Buffer) => crypto.createHash('sha1').update(b).digest();

  let previous: ChainBlock = {
    height: first - 1,
    indep_hash: random(48),
    previous_block: random(48),
    weave_size: 1_000_000,
    tx_root: Buffer.alloc(0),
    hash_list_merkle: random(48),
  };
  insertBlock.run(
    previous.height,
    previous.indep_hash,
    previous.previous_block,
    random(48),
    random(32),
    1,
    random(32),
    0,
    previous.weave_size,
    previous.hash_list_merkle,
    previous.tx_root,
    0,
  );
  // An address is the SHA-256 of its owner's key.
  const modulus = random(512);
  const owner = crypto.createHash('sha256').update(modulus).digest();
  insertWallet.run(owner, modulus);
  if (genesis) {
    insertBlock.run(
      0,
      random(48),
      random(48),
      random(48),
      random(32),
      0,
      random(32),
      0,
      0,
      null,
      Buffer.alloc(0),
      0,
    );
  }
  for (let h = first; h < first + count; h++) {
    const txs = Array.from({ length: h % 4 }, (_, i) => {
      // A transaction's id is the SHA-256 of its signature.
      const signature = signatures ? random(512) : null;
      return {
        id:
          signature !== null
            ? crypto.createHash('sha256').update(signature).digest()
            : random(32),
        signature,
        format: 2,
        data_size: 1000 * (i + 1),
        data_root: random(32),
        bti: i,
      };
    });
    const size = txs.reduce(
      (s, t) => s + Math.ceil(t.data_size / 262144) * 262144,
      0,
    );
    const block: ChainBlock = {
      height: h,
      indep_hash: random(48),
      previous_block: previous.indep_hash,
      weave_size: Number(previous.weave_size) + size,
      tx_root: (await computeTxRoot(h, txs)) ?? Buffer.alloc(0),
      hash_list_merkle: nextHashListMerkle(previous),
    };
    insertBlock.run(
      h,
      block.indep_hash,
      block.previous_block,
      random(48),
      random(32),
      h,
      random(32),
      size,
      block.weave_size,
      block.hash_list_merkle,
      block.tx_root,
      txs.length,
    );
    for (const tx of txs) {
      insertLink.run(block.indep_hash, tx.id, tx.bti);
      insertTx.run(
        tx.id,
        h,
        tx.bti,
        random(32),
        owner,
        tx.data_size,
        tx.data_root,
        2,
        h * 10 + tx.bti,
        tx.signature,
      );
      for (let t = 0; t < 2; t++) {
        const name = Buffer.from(`Name-${t}`);
        const value = Buffer.from(`value-${h}-${tx.bti}-${t}`);
        insertTagName.run(sha1(name), name);
        insertTagValue.run(sha1(value), value);
        insertTag.run(sha1(name), sha1(value), h, tx.bti, t, tx.id);
      }
    }
    previous = block;
  }
  db.close();
}
