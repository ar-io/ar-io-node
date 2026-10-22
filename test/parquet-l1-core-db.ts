/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import Sqlite from 'better-sqlite3';

import { deepHash } from '../src/lib/parquet-l1/block-hash.js';
import {
  ChainBlock,
  computeTxRoot,
  FORK_2_0,
  nextHashListMerkle,
} from '../src/lib/parquet-l1/chain.js';
import { syntheticHeader } from './parquet-l1-headers.js';

/** `STRICT_DATA_SPLIT_THRESHOLD` (`ar_consensus.hrl`): padding begins above it. */
const STRICT_DATA_SPLIT_THRESHOLD = 30_607_159_107_830;

const random = (n: number) => crypto.randomBytes(n);

let signingKey: crypto.KeyPairKeyObjectResult | undefined;
/** One RSA key for every verifiable test chain: generating one costs a second. */
function testKey(): crypto.KeyPairKeyObjectResult {
  signingKey ??= crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicExponent: 65537,
  });
  return signingKey;
}

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
    weaveStart = 1_000_000,
    padded = weaveStart > STRICT_DATA_SPLIT_THRESHOLD,
    verifiable = false,
  }: {
    genesis?: boolean;
    signatures?: boolean;
    /**
     * A chain the verifier can bind end to end: every block's `indep_hash`
     * recomputes from its header (`syntheticHeader`, from the 2.9 fork),
     * and every transaction is signed by a real key over its fields, its id
     * the SHA-256 of the signature. The signatures are kept in a
     * `test_signatures` table, not in `stable_transactions`, as a gateway
     * that does not keep them would hold them; `chainNode` serves both.
     */
    verifiable?: boolean;
    /** The weave size the anchor block sits at, for the chain's era. */
    weaveStart?: number;
    /**
     * Whether the weave grows by each transaction's data padded to a
     * chunk, as it has since Arweave passed `STRICT_DATA_SPLIT_THRESHOLD`
     * (around height 800,000), or by the raw `data_size`, as it did
     * below that. The default follows the weave offset the chain starts
     * at, as the chain's own rule does.
     */
    padded?: boolean;
  } = {},
): Promise<void> {
  const db = new Sqlite(file);
  db.exec(fs.readFileSync('test/core-schema.sql', 'utf8'));
  const insertRow = db.prepare(`INSERT INTO stable_blocks (height, indep_hash,
    previous_block, nonce, hash, block_timestamp, diff, cumulative_diff,
    last_retarget, reward_addr, reward_pool, block_size, weave_size,
    usd_to_ar_rate_dividend, usd_to_ar_rate_divisor,
    scheduled_usd_to_ar_rate_dividend, scheduled_usd_to_ar_rate_divisor,
    hash_list_merkle, tx_root, tx_count, missing_tx_count)
    VALUES (?, ?, ?, ?, ?, ?, '1', '2', 3, ?, '4', ?, ?, 1, 10, 1, 10, ?, ?, ?, 0)`);
  if (verifiable) {
    db.exec(
      'CREATE TABLE test_signatures (id BLOB PRIMARY KEY, signature BLOB NOT NULL)',
    );
  }
  const insertSignature = verifiable
    ? db.prepare('INSERT INTO test_signatures (id, signature) VALUES (?, ?)')
    : undefined;
  /**
   * Inserts a block row. A verifiable chain's `indep_hash` (the second
   * value) is replaced by the hash its header gives, and returned.
   */
  const insertBlock = {
    run: (...values: unknown[]): Buffer => {
      const [height, indep, previous, nonce, hash, timestamp, rewardAddr] =
        values as [number, Buffer, Buffer, Buffer, Buffer, number, Buffer];
      let indepHash = indep;
      if (verifiable) {
        const [blockSize, weaveSize, merkle, txRoot] = values.slice(7) as [
          number,
          number,
          Buffer | null,
          Buffer,
        ];
        indepHash = Buffer.from(
          syntheticHeader(
            {
              height,
              previous_block: previous,
              nonce,
              hash,
              block_timestamp: timestamp,
              diff: '1',
              cumulative_diff: '2',
              last_retarget: 3,
              reward_addr: rewardAddr,
              reward_pool: '4',
              block_size: blockSize,
              weave_size: weaveSize,
              usd_to_ar_rate_dividend: 1,
              usd_to_ar_rate_divisor: 10,
              scheduled_usd_to_ar_rate_dividend: 1,
              scheduled_usd_to_ar_rate_divisor: 10,
              hash_list_merkle: merkle,
              wallet_list: null,
              tx_root: txRoot,
            },
            pendingIds,
          ).indep_hash,
          'base64url',
        );
      }
      insertRow.run(height, indepHash, ...values.slice(2));
      return indepHash;
    },
  };
  let pendingIds: Buffer[] = [];
  const insertLink = db.prepare(`INSERT INTO stable_block_transactions
    (block_indep_hash, transaction_id, block_transaction_index) VALUES (?, ?, ?)`);
  const insertTx = db.prepare(`INSERT INTO stable_transactions (id, height,
    block_transaction_index, format, last_tx, owner_address, target, quantity,
    reward, data_size, data_root, content_type, tag_count, offset, indexed_at,
    signature)
    VALUES (?, ?, ?, ?, ?, ?, NULL, '500000000000000000', '42', ?, ?, 'text/plain', ?, ?, 5, ?)`);
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
    weave_size: weaveStart,
    tx_root: Buffer.alloc(0),
    hash_list_merkle: random(48),
  };
  previous.indep_hash = insertBlock.run(
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
  const modulus = verifiable
    ? Buffer.from(
        testKey().publicKey.export({ format: 'jwk' }).n as string,
        'base64url',
      )
    : random(512);
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
      const lastTx = random(32);
      const dataSize = 1000 * (i + 1);
      // Format 2 begins at the 2.0 fork: below it every transaction is
      // format 1. A gateway stores the root it computed from a format-1
      // transaction's data; a band leaves it out.
      const format = h < FORK_2_0 ? 1 : 2;
      const dataRoot = random(32);
      const tagRows = [0, 1].map((t) => [
        Buffer.from(t === 0 ? 'Content-Type' : `Name-${t}`),
        Buffer.from(t === 0 ? 'text/plain' : `value-${h}-${i}-${t}`),
      ]);
      // A transaction's id is the SHA-256 of its signature; a verifiable
      // chain's is a real signature over its fields (format 2).
      const signature = verifiable
        ? crypto.sign(
            'sha256',
            deepHash([
              Buffer.from('2'),
              modulus,
              Buffer.alloc(0),
              Buffer.from('500000000000000000'),
              Buffer.from('42'),
              lastTx,
              tagRows,
              Buffer.from(String(dataSize)),
              dataRoot,
            ]),
            {
              key: testKey().privateKey,
              padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
              saltLength: 32,
            },
          )
        : signatures
          ? random(512)
          : null;
      return {
        id:
          signature !== null
            ? crypto.createHash('sha256').update(signature).digest()
            : random(32),
        signature,
        lastTx,
        tagRows,
        format,
        data_size: dataSize,
        data_root: dataRoot,
        bti: i,
      };
    });
    pendingIds = txs.map((tx) => tx.id);
    const size = txs.reduce(
      (s, t) =>
        s + (padded ? Math.ceil(t.data_size / 262144) * 262144 : t.data_size),
      0,
    );
    const block: ChainBlock = {
      height: h,
      indep_hash: random(48),
      previous_block: previous.indep_hash,
      weave_size: Number(previous.weave_size) + size,
      // Below the fork a block's root is the 2.0 transition's, built from
      // its v1 data; a gateway that indexed the chain holds one, which no
      // index can recompute, so a stand-in of its width does here.
      tx_root:
        h < FORK_2_0
          ? txs.length > 0
            ? random(32)
            : Buffer.alloc(0)
          : ((await computeTxRoot(h, txs)) ?? Buffer.alloc(0)),
      hash_list_merkle: nextHashListMerkle(previous),
    };
    block.indep_hash = insertBlock.run(
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
        tx.format,
        tx.lastTx,
        owner,
        tx.data_size,
        tx.data_root,
        2,
        h * 10 + tx.bti,
        verifiable ? null : tx.signature,
      );
      if (tx.signature !== null) insertSignature?.run(tx.id, tx.signature);
      // Tag 0 is the Content-Type the row's content_type is stored from, as
      // an indexer would derive it; a band derives it the same way.
      for (let t = 0; t < 2; t++) {
        const [name, value] = tx.tagRows[t];
        insertTagName.run(sha1(name), name);
        insertTagValue.run(sha1(value), value);
        insertTag.run(sha1(name), sha1(value), h, tx.bti, t, tx.id);
      }
    }
    previous = block;
  }
  db.close();
}
