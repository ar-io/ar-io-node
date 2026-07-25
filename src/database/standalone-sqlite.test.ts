/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ValidationError } from 'apollo-server-express';
import crypto from 'node:crypto';
import fs from 'node:fs';

import {
  StandaloneSqliteDatabase,
  StandaloneSqliteDatabaseWorker,
  dataItemToDbRows,
  decodeBlockGqlCursor,
  decodeTransactionGqlCursor,
  encodeBlockGqlCursor,
  encodeTransactionGqlCursor,
  toSqliteParams,
} from '../../src/database/standalone-sqlite.js';
import { fromB64Url, toB64Url } from '../../src/lib/encoding.js';
import {
  bundlesDb,
  bundlesDbPath,
  chunksDbPath,
  coreDb,
  coreDbPath,
  dataDb,
  dataDbPath,
  moderationDbPath,
} from '../../test/sqlite-helpers.js';
import { ArweaveChainSourceStub, stubAns104Bundle } from '../../test/stubs.js';
import { normalizeAns104DataItem } from '../lib/ans-104.js';
import loadSql from './sql-loader.js';
import log from '../log.js';
import { BundleRecord } from '../types.js';
import { processBundleStream } from '../lib/bundles.js';
import wait from '../lib/wait.js';

const HEIGHT = 1138;
const BLOCK_TX_INDEX = 42;
const DATA_ITEM_ID = 'zoljIRyzG5hp-R4EZV2q8kFI49OAoy23_B9YJ_yEEws';
const ID = 'zoljIRyzG5hp-R4EZV2q8kFI49OAoy23_B9YJ_yEEws';
const CURSOR =
  'WzExMzgsNDIsdHJ1ZSwiem9saklSeXpHNWhwLVI0RVpWMnE4a0ZJNDlPQW95MjNfQjlZSl95RUV3cyIsMTYzMDAwMDAwMF0';
const INDEXED_AT = 1630000000;

const dataItemRootTxId = '0000000000000000000000000000000000000000000';
const dataItem = {
  anchor: 'a',
  dataOffset: 10,
  dataSize: 1,
  id: DATA_ITEM_ID,
  offset: 10,
  owner: 'a',
  ownerOffset: 1,
  ownerSize: 1,
  sigName: 'a',
  signature: 'a',
  signatureOffset: 1,
  signatureSize: 1,
  signatureType: 1,
  size: 1,
  tags: [],
  target: 'a',
};
const normalizedDataItem = normalizeAns104DataItem({
  rootTxId: dataItemRootTxId,
  parentId: dataItemRootTxId,
  parentIndex: -1,
  index: 0,
  ans104DataItem: dataItem,
  filter: '',
  dataHash: '',
  rootParentOffset: 0,
});

describe('SQLite helper functions', () => {
  describe('toSqliteParams', () => {
    it('should convert SQL Bricks param values to better-sqlite3 params', () => {
      assert.deepEqual(toSqliteParams({ values: [820389, 820389] }), {
        '1': 820389,
        '2': 820389,
      });
    });
  });
});

describe('SQLite GraphQL cursor functions', () => {
  describe('encodeTransactionGqlCursor', () => {
    it('should encode a height, blockTransactionIndex, dataItemId, indexedAt, and id', () => {
      assert.equal(
        encodeTransactionGqlCursor({
          height: HEIGHT,
          blockTransactionIndex: BLOCK_TX_INDEX,
          dataItemId: DATA_ITEM_ID,
          indexedAt: INDEXED_AT,
          id: ID,
        }),
        CURSOR,
      );
    });
  });

  describe('decodeTransactionGqlCursor', () => {
    it('should decode a height, blockTransactionIndex, indexedAt, and dataItemId given an encoded cursor', () => {
      assert.deepEqual(decodeTransactionGqlCursor(CURSOR), {
        height: HEIGHT,
        blockTransactionIndex: BLOCK_TX_INDEX,
        dataItemId: DATA_ITEM_ID,
        indexedAt: INDEXED_AT,
        id: ID,
      });
    });

    it('should decode a cursor without a data item ID', () => {
      const cursor = encodeTransactionGqlCursor({
        height: HEIGHT,
        blockTransactionIndex: BLOCK_TX_INDEX,
        dataItemId: 'AA',
        indexedAt: INDEXED_AT,
        id: ID,
      });

      assert.deepEqual(decodeTransactionGqlCursor(cursor), {
        height: HEIGHT,
        blockTransactionIndex: BLOCK_TX_INDEX,
        dataItemId: 'AA',
        indexedAt: INDEXED_AT,
        id: ID,
      });
    });

    it('should return an null values given an undefined cursor', () => {
      assert.deepEqual(decodeTransactionGqlCursor(undefined), {
        height: null,
        blockTransactionIndex: null,
        dataItemId: null,
        indexedAt: null,
        id: null,
      });
    });

    it('should throw an error given an invalid cursor', async () => {
      await assert.rejects(
        async () => {
          decodeTransactionGqlCursor('123');
        },
        {
          name: ValidationError.name,
          message: 'Invalid transaction cursor',
        },
      );
    });
  });

  describe('encodeBlockGqlCursor', () => {
    it('should encode a cursor given a height', () => {
      assert.equal(encodeBlockGqlCursor({ height: HEIGHT }), 'WzExMzhd');
    });
  });

  describe('decodeBlockGqlCursor', () => {
    it('should decode a height given an encoded cursor', () => {
      assert.deepEqual(decodeBlockGqlCursor('WzExMzhd'), {
        height: HEIGHT,
      });
    });

    it('should return a null height value given an undefined cursor', () => {
      assert.deepEqual(decodeBlockGqlCursor(undefined), {
        height: null,
      });
    });

    it('should throw an error given an invalid cursor', async () => {
      await assert.rejects(
        async () => {
          decodeBlockGqlCursor('123');
        },
        {
          name: ValidationError.name,
          message: 'Invalid block cursor',
        },
      );
    });
  });
});

describe('SQLite data conversion functions', () => {
  describe('dataItemToDbRows', () => {
    it('should return DB rows to insert', async () => {
      const bundleStream = await stubAns104Bundle();
      const iterable = await processBundleStream(bundleStream);
      for await (const [_index, dataItem] of iterable.entries()) {
        const normalizedDataItem = normalizeAns104DataItem({
          rootTxId: '0000000000000000000000000000000000000000000',
          parentId: '0000000000000000000000000000000000000000000',
          parentIndex: -1,
          index: 0,
          ans104DataItem: dataItem,
          filter: '',
          dataHash: '',
          rootParentOffset: 0,
        });
        const rows = dataItemToDbRows(normalizedDataItem);

        assert.ok(rows.tagNames.length > 0);
        assert.ok(rows.tagValues.length > 0);
        assert.ok(rows.newDataItemTags.length > 0);
        assert.ok(rows.wallets.length > 0);
        assert.equal(typeof rows.newDataItem, 'object');
      }
    });
  });
});

describe('StandaloneSqliteDatabase', () => {
  let chainSource: ArweaveChainSourceStub;
  let db: StandaloneSqliteDatabase;
  let dbWorker: StandaloneSqliteDatabaseWorker;

  before(() => {
    process.env.GET_DEBUG_INFO_CACHE_TTL_MS = '0';
    db = new StandaloneSqliteDatabase({
      log,
      coreDbPath,
      dataDbPath,
      moderationDbPath,
      bundlesDbPath,
      chunksDbPath,
      tagSelectivity: {},
    });
    dbWorker = new StandaloneSqliteDatabaseWorker({
      log,
      coreDbPath,
      dataDbPath,
      moderationDbPath,
      bundlesDbPath,
      chunksDbPath,
      tagSelectivity: {},
    });
    chainSource = new ArweaveChainSourceStub();
  });

  after(async () => {
    db.stop();
  });

  describe('offsets', () => {
    it('should save offsets into the database and then be discoverable via getTxByOffset', async () => {
      const tx1id = '_H6KgmI_ZfSdSlf9r2xzDh_ebJnvQtTYLUBQlnRjIdM';
      const tx2id = 'UTjG9QyeQ8dJgghq_7JRYb3iTAvlc0IgVN3OfJFGwNk';

      const tx1values = {
        id: fromB64Url(tx1id),
        height: 123,
        block_transaction_index: 0,
        format: 2,
        last_tx: Buffer.alloc(32), // or a random Buffer of 32 bytes
        owner_address: Buffer.alloc(32), // also 32 bytes typically
        quantity: '0',
        reward: '0',
        tag_count: 0,
        offset: 100,
        data_size: 50,
      };
      const tx2values = {
        ...tx1values,
        id: fromB64Url(tx2id),
        offset: 200,
        last_tx: Buffer.alloc(32),
        owner_address: Buffer.alloc(32),
        data_size: 1,
      };

      const sqlQ = `
        INSERT INTO stable_transactions (
          id,
          height,
          block_transaction_index,
          format,
          last_tx,
          owner_address,
          quantity,
          reward,
          tag_count,
          offset,
          data_size
        )
        VALUES (
          @id,
          @height,
          @block_transaction_index,
          @format,
          @last_tx,
          @owner_address,
          @quantity,
          @reward,
          @tag_count,
          @offset,
          @data_size
        )
      `;

      coreDb.prepare(sqlQ).run(tx1values);
      coreDb.prepare(sqlQ).run(tx2values);

      const tx1 = coreDb
        .prepare(`SELECT * FROM stable_transactions WHERE id = @transaction_id`)
        .get({ transaction_id: fromB64Url(tx1id) });
      assert.equal(tx1.offset, 100);

      const tx2 = coreDb
        .prepare(`SELECT * FROM stable_transactions WHERE id = @transaction_id`)
        .get({ transaction_id: fromB64Url(tx2id) });

      assert.equal(tx2.offset, 200);

      // if under offset - data_size, or < 50, it should return nothing
      const txByOffsetResult1 = await db.getTxByOffset(0);
      assert.equal(txByOffsetResult1.id, undefined);
      const txByOffsetResult2 = await db.getTxByOffset(49);
      assert.equal(txByOffsetResult2.id, undefined);
      // if at 50 until end of data_size (which is 50) to <= 100, should return tx1id
      const txByOffsetResult3 = await db.getTxByOffset(50);
      assert.equal(txByOffsetResult3.id, undefined);
      const txByOffsetResult4 = await db.getTxByOffset(99);
      assert.equal(txByOffsetResult4.id, tx1id);
      const txByOffsetResult5 = await db.getTxByOffset(100);
      assert.equal(txByOffsetResult5.id, tx1id);
      // if at 101, it shouldn't return anything
      const txByOffsetResult6 = await db.getTxByOffset(101);
      assert.equal(txByOffsetResult6.id, undefined);
      // tx2 is 1 byte length, starting at 199
      const txByOffsetResult7 = await db.getTxByOffset(198);
      assert.equal(txByOffsetResult7.id, undefined);
      const txByOffsetResult8 = await db.getTxByOffset(199);
      assert.equal(txByOffsetResult8.id, undefined);
      const txByOffsetResult9 = await db.getTxByOffset(200);
      assert.equal(txByOffsetResult9.id, tx2id);
      // if at 201, it shouldn't return anything
      const txByOffsetResult10 = await db.getTxByOffset(201);
      assert.equal(txByOffsetResult10.id, undefined);
    });

    it('getTxByOffset misses resolve via a single partial-index probe (no scan past the candidate row)', async () => {
      // Regression test for the miss-scan pathology: the previous form of
      // selectStableTransactionOffsetById kept the span predicate
      // ((offset - data_size) < @offset) inside the index scan, so an offset in
      // a coverage gap walked stable_transactions_offset_idx from @offset to
      // the end of the table (tens of seconds on a production-sized DB) before
      // returning empty. The rewritten statement fetches only the first
      // candidate row and applies the span check outside. Timing is
      // meaningless on a tiny test DB, so this asserts the two things that
      // guarantee the behavior instead: (1) miss semantics stay correct, and
      // (2) the plan uses the partial index — which requires the inner query
      // to repeat the index's WHERE predicates (format = 2 AND data_size > 0)
      // verbatim; hoisting either one out silently degrades to a table scan.
      const f2id = 'iCXp6wqDLcpdOWJd6oTVz4CTS9QI9wsJp6g6oRVvv0E';
      const f1id = 'Epr8mLUZDBiTprrN1tyuKu4Ct1nkFrVzL4NBmXtj4jQ';

      const baseValues = {
        height: 124,
        block_transaction_index: 0,
        last_tx: Buffer.alloc(32),
        owner_address: Buffer.alloc(32),
        quantity: '0',
        reward: '0',
        tag_count: 0,
      };
      const insertSql = `
        INSERT INTO stable_transactions (
          id, height, block_transaction_index, format, last_tx, owner_address,
          quantity, reward, tag_count, offset, data_size
        ) VALUES (
          @id, @height, @block_transaction_index, @format, @last_tx,
          @owner_address, @quantity, @reward, @tag_count, @offset, @data_size
        )
      `;

      // format-2 tx spanning [451, 500]
      coreDb.prepare(insertSql).run({
        ...baseValues,
        id: fromB64Url(f2id),
        format: 2,
        offset: 500,
        data_size: 50,
      });
      // format-1 tx spanning [551, 600]: not in the partial index, must never
      // be returned, and offsets inside it are misses
      coreDb.prepare(insertSql).run({
        ...baseValues,
        id: fromB64Url(f1id),
        format: 1,
        offset: 600,
        data_size: 50,
      });

      // Hit within the format-2 tx
      const hit = await db.getTxByOffset(475);
      assert.equal(hit.id, f2id);

      // Miss in the gap before the format-2 tx: the first candidate row
      // (offset 500) fails the span check and the lookup must stop there
      const gapMiss = await db.getTxByOffset(300);
      assert.equal(gapMiss.id, undefined);

      // Miss inside the format-1 tx's region: the spanning tx is format-1, so
      // there is no format-2 spanner and the result is empty
      const f1Miss = await db.getTxByOffset(575);
      assert.equal(f1Miss.id, undefined);

      // Miss beyond the highest indexed offset
      const beyondEndMiss = await db.getTxByOffset(1_000_000);
      assert.equal(beyondEndMiss.id, undefined);

      // Plan assertion: the statement must probe stable_transactions via the
      // partial offset index, never scan the table
      const offsetsSqlDir = fileURLToPath(
        new URL('./sql/core', import.meta.url),
      );
      const stmt = loadSql(offsetsSqlDir)['selectStableTransactionOffsetById'];
      assert.ok(
        stmt !== undefined,
        'selectStableTransactionOffsetById statement not found',
      );
      const plan = coreDb
        .prepare(`EXPLAIN QUERY PLAN ${stmt}`)
        .all({ offset: 300 }) as { detail: string }[];
      const details = plan.map((row) => row.detail).join('\n');
      assert.ok(
        details.includes('stable_transactions_offset_idx'),
        `plan must use stable_transactions_offset_idx, got:\n${details}`,
      );
      assert.ok(
        !/SCAN stable_transactions/.test(details),
        `plan must not scan stable_transactions, got:\n${details}`,
      );
    });

    it('resolves an absolute weave offset to its containing stable block via getBlockByWeaveOffset', async () => {
      const insertBlock = (height: number, weaveSize: number) =>
        coreDb
          .prepare(
            `INSERT INTO stable_blocks (
               height, nonce, hash, block_timestamp, diff, last_retarget,
               reward_pool, block_size, weave_size, tx_count, missing_tx_count
             ) VALUES (
               @height, @nonce, @hash, 0, '0', '0',
               '0', 1, @weave_size, 0, 0
             )`,
          )
          .run({
            height,
            nonce: Buffer.alloc(1),
            hash: Buffer.alloc(1),
            weave_size: weaveSize,
          });

      // Contiguous run: weave_size is cumulative-to-end-of-block.
      insertBlock(10, 100);
      insertBlock(11, 200);
      insertBlock(12, 200); // empty block: same cumulative weave_size as 11
      insertBlock(13, 350);

      // Offset inside block 11 (100 < 150 <= 200): tightly bracketed by block 10.
      const mid = await db.getBlockByWeaveOffset(150);
      assert.equal(mid.height, 11);
      assert.equal(mid.weaveSize, 200);
      assert.equal(mid.prevWeaveSize, 100);

      // Offset exactly at block 11's end boundary resolves to block 11.
      const boundary = await db.getBlockByWeaveOffset(200);
      assert.equal(boundary.height, 11);

      // Just past block 11 lands in block 13 (block 12 added no bytes).
      const next = await db.getBlockByWeaveOffset(201);
      assert.equal(next.height, 13);
      assert.equal(next.prevWeaveSize, 200);

      // Gap guard: predecessor missing -> prevWeaveSize is undefined so the
      // caller will not trust the local result and falls back to the chain.
      insertBlock(20, 1000);
      insertBlock(22, 1200); // height 21 intentionally absent
      const gapped = await db.getBlockByWeaveOffset(1100);
      assert.equal(gapped.height, 22);
      assert.equal(gapped.prevWeaveSize, undefined);

      // Offset beyond the highest indexed block returns no row.
      const beyond = await db.getBlockByWeaveOffset(99999);
      assert.equal(beyond.height, undefined);
      assert.equal(beyond.weaveSize, undefined);
      assert.equal(beyond.prevWeaveSize, undefined);
    });

    it('resolves offsets in the not-yet-stable tip (new_blocks) across the stable boundary', async () => {
      const insertStableBlock = (height: number, weaveSize: number) =>
        coreDb
          .prepare(
            `INSERT INTO stable_blocks (
               height, nonce, hash, block_timestamp, diff, last_retarget,
               reward_pool, block_size, weave_size, tx_count, missing_tx_count
             ) VALUES (
               @height, @nonce, @hash, 0, '0', '0',
               '0', 1, @weave_size, 0, 0
             )`,
          )
          .run({
            height,
            nonce: Buffer.alloc(1),
            hash: Buffer.alloc(1),
            weave_size: weaveSize,
          });

      const insertNewBlock = (
        height: number,
        weaveSize: number,
        indepHashByte: number,
      ) =>
        coreDb
          .prepare(
            `INSERT INTO new_blocks (
               indep_hash, height, nonce, hash, block_timestamp, diff,
               last_retarget, reward_pool, block_size, weave_size, tx_count,
               missing_tx_count
             ) VALUES (
               @indep_hash, @height, @nonce, @hash, 0, '0',
               '0', '0', 1, @weave_size, 0, 0
             )`,
          )
          .run({
            indep_hash: Buffer.from([indepHashByte]),
            height,
            nonce: Buffer.alloc(1),
            hash: Buffer.alloc(1),
            weave_size: weaveSize,
          });

      // Use a high, isolated offset range so the rows inserted by the previous
      // test (heights 10–22, weave_size ≤ 1200) can never become candidates.
      // Stable chain ends at height 1003; the tip lives in new_blocks.
      insertStableBlock(1000, 10_000);
      insertStableBlock(1001, 20_000);
      insertStableBlock(1002, 20_000); // empty block, same cumulative weave_size
      insertStableBlock(1003, 35_000); // last stable block
      insertNewBlock(1004, 50_000, 0xa1); // first unstable block
      insertNewBlock(1005, 60_000, 0xa2);

      // Offset still inside the stable chain resolves as before, tagged stable.
      // 15_000 falls in block 1001 (10_000 < 15_000 <= 20_000).
      const stableHit = await db.getBlockByWeaveOffset(15_000);
      assert.equal(stableHit.height, 1001);
      assert.equal(stableHit.weaveSize, 20_000);
      assert.equal(stableHit.prevWeaveSize, 10_000); // from stable_blocks(1000)
      assert.equal(stableHit.zone, 'stable');

      // Boundary case: the FIRST new block (1004). Its predecessor is the last
      // STABLE block (1003), so prev_weave_size must come across the UNION.
      const firstTip = await db.getBlockByWeaveOffset(45_000);
      assert.equal(firstTip.height, 1004);
      assert.equal(firstTip.weaveSize, 50_000);
      assert.equal(firstTip.prevWeaveSize, 35_000); // from stable_blocks(1003)
      assert.equal(firstTip.zone, 'unstable');

      // A deeper tip offset resolves entirely within new_blocks.
      const deeperTip = await db.getBlockByWeaveOffset(55_000);
      assert.equal(deeperTip.height, 1005);
      assert.equal(deeperTip.weaveSize, 60_000);
      assert.equal(deeperTip.prevWeaveSize, 50_000); // from new_blocks(1004)
      assert.equal(deeperTip.zone, 'unstable');

      // Reorg safety: new_blocks can transiently hold a non-canonical fork at a
      // height already occupied. Add a fork of the predecessor height (1004)
      // claiming an inflated cumulative weave_size that overshoots the offset.
      // prev_weave_size takes the MAX across rows at height-1, so the bracket is
      // no longer tight (prev >= offset) and the caller must fall back rather
      // than risk trusting a forked tip — the conservative direction.
      insertNewBlock(1004, 70_000, 0xb1); // fork at height 1004
      const forked = await db.getBlockByWeaveOffset(55_000);
      assert.equal(forked.height, 1005);
      assert.equal(forked.weaveSize, 60_000);
      assert.equal(forked.prevWeaveSize, 70_000); // MAX(50_000, 70_000) at 1004
      assert.ok(
        forked.prevWeaveSize !== undefined && forked.prevWeaveSize >= 55_000,
        'forked predecessor breaks the tight bracket so the caller falls back',
      );
    });
  });

  describe('getTransactionAttributes', () => {
    // Regression coverage for a defect introduced in commit 0bcccf6e where
    // the worker checked `row.owner_key` (a column the SQL never returns)
    // instead of `row.owner`. The bug always reported owner=null even when
    // wallets.public_modulus was populated, forcing OwnerFetcher to fall
    // through to chainSource for every L1-tx owner query. No prior test
    // exercised the SQL→object boundary; AttributeFetcher tests mocked the
    // dataIndex and the resolver tests used fixtures with inline ownerKey,
    // so the typo went undetected. Keep these tests focused on that seam.
    const id = '_H6KgmI_ZfSdSlf9r2xzDh_ebJnvQtTYLUBQlnRjIdM';
    const ownerAddress = Buffer.alloc(32, 0xab);
    const publicModulus = Buffer.alloc(512, 0xcd);
    const signature = Buffer.alloc(512, 0xef);

    const insertTx = (sigValue: Buffer | null) => {
      coreDb
        .prepare(
          `INSERT OR REPLACE INTO stable_transactions
            (id, height, block_transaction_index, format, last_tx,
             owner_address, signature, quantity, reward, tag_count,
             offset, data_size)
           VALUES (@id, 1, 0, 2, @last_tx,
             @owner_address, @signature, '0', '0', 0,
             0, 0)`,
        )
        .run({
          id: fromB64Url(id),
          last_tx: Buffer.alloc(32),
          owner_address: ownerAddress,
          signature: sigValue,
        });
    };

    const insertWallet = () => {
      coreDb
        .prepare(
          `INSERT OR REPLACE INTO wallets (address, public_modulus)
           VALUES (@address, @public_modulus)`,
        )
        .run({ address: ownerAddress, public_modulus: publicModulus });
    };

    beforeEach(() => {
      coreDb.prepare(`DELETE FROM stable_transactions WHERE id = @id`).run({
        id: fromB64Url(id),
      });
      coreDb
        .prepare(`DELETE FROM wallets WHERE address = @address`)
        .run({ address: ownerAddress });
    });

    it('returns the wallet public_modulus as owner when joined', () => {
      insertTx(signature);
      insertWallet();

      const attrs = dbWorker.getTransactionAttributes(id);
      assert.equal(attrs?.owner, toB64Url(publicModulus));
      assert.equal(attrs?.signature, toB64Url(signature));
    });

    it('returns owner=null when wallets.public_modulus is missing', () => {
      // No wallet row inserted — the LEFT JOIN produces a row with
      // owner=NULL even though the tx exists.
      insertTx(signature);

      const attrs = dbWorker.getTransactionAttributes(id);
      assert.equal(attrs?.owner, null);
      assert.equal(attrs?.signature, toB64Url(signature));
    });

    it('returns signature=null when stable_transactions.signature is NULL', () => {
      insertTx(null);
      insertWallet();

      const attrs = dbWorker.getTransactionAttributes(id);
      assert.equal(attrs?.signature, null);
      assert.equal(attrs?.owner, toB64Url(publicModulus));
    });

    it('returns undefined when the transaction is unknown', () => {
      const attrs = dbWorker.getTransactionAttributes(id);
      assert.equal(attrs, undefined);
    });
  });

  // Regression coverage for the empty/NULL data_root content-confusion bug.
  // An L1 tx with an empty data_root was served unrelated content because:
  //   - the write side (insertDataRoot) planted a poison row keyed on the
  //     empty data_root pointing at whatever bytes were last streamed, and
  //   - the read side (selectDataAttributes' fallback branch) matched that
  //     poison row via `dr.data_root = :data_root` for any other
  //     empty-data_root tx, returning the unrelated file's hash.
  // The fix guards both queries with `:data_root IS NOT NULL AND
  // length(:data_root) > 0`. These tests pin both halves of the fix.
  describe('getDataAttributes — empty/NULL data_root guard', () => {
    // Synthetic ids (32-byte buffers) — the L1 tx under test.
    const txId = toB64Url(Buffer.alloc(32, 0x01));
    // A *different* tx whose content planted the empty-data_root poison row.
    const planterTxId = toB64Url(Buffer.alloc(32, 0x02));
    const txDataSize = 393110;
    const rogueHash = Buffer.alloc(32, 0x9a);
    const rogueSize = 17;
    const realHash = Buffer.alloc(32, 0x11);

    const insertL1Tx = (dataRoot: Buffer | null) => {
      // format=1 (v1 / legacy) is the real-world trigger: such txs never
      // have a chain-side data_root, so the empty-data_root poisoning the
      // guard fixes was hit on every v1 tx fetch. The SQL guard fires off
      // data_root regardless of format, so the assertions hold for any tx
      // with no data_root — but seeding the canonical case matches what
      // operators see in production.
      coreDb
        .prepare(
          `INSERT OR REPLACE INTO stable_transactions
            (id, height, block_transaction_index, format, last_tx,
             owner_address, quantity, reward, tag_count, data_size,
             data_root, content_type)
           VALUES (@id, 1, 0, 1, @last_tx,
             @owner_address, '0', '0', 0, @data_size,
             @data_root, 'text/html')`,
        )
        .run({
          id: fromB64Url(txId),
          last_tx: Buffer.alloc(32),
          owner_address: Buffer.alloc(32),
          data_size: txDataSize,
          data_root: dataRoot,
        });
    };

    const insertContiguousData = (hash: Buffer, size: number) => {
      dataDb
        .prepare(
          `INSERT OR REPLACE INTO contiguous_data
            (hash, data_size, indexed_at) VALUES (@hash, @size, 0)`,
        )
        .run({ hash, size });
    };

    const insertDataId = (id: string, hash: Buffer) => {
      dataDb
        .prepare(
          `INSERT OR REPLACE INTO contiguous_data_ids
            (id, contiguous_data_hash, verified, indexed_at)
           VALUES (@id, @hash, 1, 0)`,
        )
        .run({ id: fromB64Url(id), hash });
    };

    // Raw insert that bypasses the write-side guard, so we can reproduce the
    // state a previously-unguarded build (or the migration's target) leaves.
    const plantPoisonRow = (dataRoot: Buffer, hash: Buffer) => {
      dataDb
        .prepare(
          `INSERT OR REPLACE INTO data_roots
            (data_root, contiguous_data_hash, verified, indexed_at)
           VALUES (@data_root, @hash, 0, 0)`,
        )
        .run({ data_root: dataRoot, hash });
    };

    it('returns no hash for an empty-data_root L1 tx even when a poison data_roots row exists', () => {
      insertL1Tx(Buffer.alloc(0));
      insertContiguousData(rogueHash, rogueSize);
      // The poison row's hash must have a cdi row for the fallback JOIN to
      // fire (as it did on the planter tx) — proving the guard, not a
      // missing join, is what suppresses the match.
      insertDataId(planterTxId, rogueHash);
      plantPoisonRow(Buffer.alloc(0), rogueHash);

      const attrs = dbWorker.getDataAttributes(txId);
      assert.notEqual(attrs, undefined);
      assert.equal(attrs?.hash, undefined);
      // The tx's own declared size is still surfaced from the tx row.
      assert.equal(attrs?.size, txDataSize);
    });

    it('returns no hash for a NULL-data_root L1 tx (guard + SQL NULL semantics)', () => {
      insertL1Tx(null);
      insertContiguousData(rogueHash, rogueSize);
      insertDataId(planterTxId, rogueHash);
      plantPoisonRow(Buffer.alloc(0), rogueHash);

      const attrs = dbWorker.getDataAttributes(txId);
      assert.notEqual(attrs, undefined);
      assert.equal(attrs?.hash, undefined);
    });

    it('still returns the cdi-branch hash when a proper contiguous_data_ids row exists for the tx', () => {
      insertL1Tx(Buffer.alloc(0));
      insertContiguousData(realHash, txDataSize);
      // Proper mapping for the tx itself (first UNION branch, cdi.id = :id).
      insertDataId(txId, realHash);
      // Adversarial poison row still present — must not win.
      insertContiguousData(rogueHash, rogueSize);
      insertDataId(planterTxId, rogueHash);
      plantPoisonRow(Buffer.alloc(0), rogueHash);

      const attrs = dbWorker.getDataAttributes(txId);
      assert.equal(attrs?.hash, toB64Url(realHash));
    });
  });

  describe('insertDataRoot — empty/NULL data_root guard', () => {
    const id = toB64Url(Buffer.alloc(32, 0x01));
    const hash = Buffer.alloc(32, 0x11);
    const realDataRoot = Buffer.alloc(32, 0x22);

    const countDataRoots = () =>
      (dataDb.prepare(`SELECT COUNT(*) AS cnt FROM data_roots`).get() as any)
        .cnt;
    const countEmptyDataRoots = () =>
      (
        dataDb
          .prepare(
            `SELECT COUNT(*) AS cnt FROM data_roots
             WHERE data_root IS NULL OR length(data_root) = 0`,
          )
          .get() as any
      ).cnt;

    it('is a no-op when data_root is empty', () => {
      dbWorker.saveDataContentAttributes({
        id,
        dataRoot: '', // decodes to a zero-length blob
        hash: toB64Url(hash),
        dataSize: 17,
      });
      assert.equal(countEmptyDataRoots(), 0);
    });

    it('is a no-op when data_root is undefined (TS wrapper skips the insert)', () => {
      dbWorker.saveDataContentAttributes({
        id,
        hash: toB64Url(hash),
        dataSize: 17,
      });
      assert.equal(countDataRoots(), 0);
    });

    it('is a no-op when data_root is NULL (SQL guard, exercised directly)', () => {
      // saveDataContentAttributes never passes NULL (it skips on undefined),
      // so drive the actual prepared statement to pin the SQL-level guard.
      (dbWorker as any).stmts.data.insertDataRoot.run({
        data_root: null,
        contiguous_data_hash: hash,
        verified: 0,
        indexed_at: 0,
        verified_at: null,
      });
      assert.equal(countDataRoots(), 0);
    });

    it('still writes normally for a non-empty data_root', () => {
      dbWorker.saveDataContentAttributes({
        id,
        dataRoot: toB64Url(realDataRoot),
        hash: toB64Url(hash),
        dataSize: 17,
      });
      const row = dataDb
        .prepare(
          `SELECT contiguous_data_hash FROM data_roots WHERE data_root = @data_root`,
        )
        .get({ data_root: realDataRoot }) as any;
      assert.notEqual(row, undefined);
      assert.deepEqual(row.contiguous_data_hash, hash);
    });
  });

  describe('saveBlockAndTxs', () => {
    it('should insert the block in the new_blocks table', async () => {
      const height = 982575;

      const { block, txs, missingTxIds } =
        await chainSource.getBlockAndTxsByHeight(height);

      await db.saveBlockAndTxs(block, txs, missingTxIds);

      const stats = await db.getDebugInfo();
      assert.equal(stats.counts.newBlocks, 1);

      const dbBlock = coreDb
        .prepare(`SELECT * FROM new_blocks WHERE height = ${height}`)
        .get();

      const binaryFields = [
        'indep_hash',
        'previous_block',
        'nonce',
        'hash',
        'reward_addr',
        'hash_list_merkle',
        'wallet_list',
        'tx_root',
      ];
      for (const field of binaryFields) {
        assert.ok(dbBlock[field] instanceof Buffer);
        assert.equal(toB64Url(dbBlock[field]), (block as any)[field]);
      }

      const stringFields = ['diff', 'cumulative_diff'];
      for (const field of stringFields) {
        assert.equal(typeof dbBlock[field], 'string');
        assert.equal(dbBlock[field], (block as any)[field]);
      }

      // Note: 'timestamp' is renamed to 'block_timestamp' to avoid collision
      // with the SQLite timestamp data type
      assert.equal(typeof dbBlock.block_timestamp, 'number');
      assert.equal(dbBlock.block_timestamp, block.timestamp);

      const integerFields = ['height', 'last_retarget'];
      for (const field of integerFields) {
        assert.equal(typeof dbBlock[field], 'number');
        assert.equal(dbBlock[field], (block as any)[field]);
      }

      // These fields are strings in JSON blocks but 64 bit integers in SQLite
      const stringIntegerFields = ['block_size', 'weave_size'];
      for (const field of stringIntegerFields) {
        assert.equal(typeof dbBlock[field], 'number');
        assert.equal(typeof (block as any)[field], 'string');
        assert.equal(dbBlock[field].toString(), (block as any)[field]);
      }

      assert.equal(typeof dbBlock.usd_to_ar_rate_dividend, 'number');
      assert.equal(typeof (block.usd_to_ar_rate ?? [])[0], 'string');
      assert.equal(
        dbBlock.usd_to_ar_rate_dividend.toString(),
        (block.usd_to_ar_rate ?? [])[0],
      );

      assert.equal(typeof dbBlock.usd_to_ar_rate_divisor, 'number');
      assert.equal(typeof (block.usd_to_ar_rate ?? [])[1], 'string');
      assert.equal(
        dbBlock.usd_to_ar_rate_divisor.toString(),
        (block.usd_to_ar_rate ?? [])[1],
      );

      assert.equal(typeof dbBlock.scheduled_usd_to_ar_rate_dividend, 'number');
      assert.equal(typeof (block.scheduled_usd_to_ar_rate ?? [])[0], 'string');
      assert.equal(
        dbBlock.scheduled_usd_to_ar_rate_dividend.toString(),
        (block.scheduled_usd_to_ar_rate ?? [])[0],
      );

      assert.equal(typeof dbBlock.scheduled_usd_to_ar_rate_divisor, 'number');
      assert.equal(typeof (block.scheduled_usd_to_ar_rate ?? [])[1], 'string');
      assert.equal(
        dbBlock.scheduled_usd_to_ar_rate_divisor.toString(),
        (block.scheduled_usd_to_ar_rate ?? [])[1],
      );
    });

    it('should save the block transactions in the new_transactions table', async () => {
      const height = 982575;

      const { block, txs, missingTxIds } =
        await chainSource.getBlockAndTxsByHeight(height);

      await db.saveBlockAndTxs(block, txs, missingTxIds);

      const stats = await db.getDebugInfo();
      assert.equal(stats.counts.newTxs, txs.length);

      const sql = `
        SELECT
        nbt.height AS height,
        nt.*,
        wo.public_modulus AS owner
        FROM new_transactions nt
        JOIN new_block_transactions nbt ON nbt.transaction_id = nt.id
        JOIN new_blocks nb ON nb.indep_hash = nbt.block_indep_hash
        JOIN wallets wo ON wo.address = nt.owner_address
        WHERE nbt.height = ${height}
        ORDER BY nbt.height, nbt.block_transaction_index
      `;

      const dbTransactions = coreDb.prepare(sql).all();

      const txIds = [
        'vYQNQruccPlvxatkcRYmoaVywIzHxS3DuBG1CPxNMPA',
        'oq-v4Cv61YAGmY_KlLdxmGp5HjcldvOSLOMv0UPjSTE',
        'cK9WF2XMwFj5TF1uhaCSdrA2mVoaxAz20HkDyQhq0i0',
      ];

      txIds.forEach((txId, i) => {
        const tx = JSON.parse(
          fs.readFileSync(`test/mock_files/txs/${txId}.json`, 'utf8'),
        );

        const ownerAddress = crypto
          .createHash('sha256')
          .update(fromB64Url(tx.owner))
          .digest();
        assert.deepEqual(dbTransactions[i].owner_address, ownerAddress);

        const binaryFields = ['id', 'last_tx', 'owner', 'target', 'data_root'];

        for (const field of binaryFields) {
          assert.ok(dbTransactions[i][field] instanceof Buffer);
          assert.equal(toB64Url(dbTransactions[i][field]), (tx as any)[field]);
        }

        const stringFields = ['quantity', 'reward'];
        for (const field of stringFields) {
          assert.equal(typeof dbTransactions[i][field], 'string');
          assert.equal(dbTransactions[i][field], (tx as any)[field]);
        }

        const integerFields = ['format'];
        for (const field of integerFields) {
          assert.equal(typeof dbTransactions[i][field], 'number');
          assert.equal(dbTransactions[i][field], (tx as any)[field]);
        }

        const stringIntegerFields = ['data_size'];
        for (const field of stringIntegerFields) {
          assert.equal(typeof dbTransactions[i][field], 'number');
          assert.equal(typeof (tx as any)[field], 'string');
          assert.equal(dbTransactions[i][field].toString(), (tx as any)[field]);
        }

        const sql = `
          SELECT ntt.*, tn.name, tv.value
          FROM new_transaction_tags ntt
          JOIN tag_names tn ON tn.hash = ntt.tag_name_hash
          JOIN tag_values tv ON tv.hash = ntt.tag_value_hash
          JOIN new_transactions nt ON nt.id = ntt.transaction_id
          JOIN new_block_transactions nbt ON nbt.transaction_id = nt.id
          WHERE ntt.transaction_id = @transaction_id
          ORDER BY nbt.height, nbt.block_transaction_index, ntt.transaction_tag_index
        `;

        const dbTags = coreDb
          .prepare(sql)
          .all({ transaction_id: fromB64Url(txId) });

        assert.equal(dbTags.length, tx.tags.length);

        tx.tags.forEach((tag: any, j: number) => {
          assert.deepEqual(
            dbTags[j].tag_name_hash,
            crypto.createHash('sha1').update(fromB64Url(tag.name)).digest(),
          );
          assert.deepEqual(
            dbTags[j].tag_value_hash,
            crypto.createHash('sha1').update(fromB64Url(tag.value)).digest(),
          );
          assert.equal(toB64Url(dbTags[j].name), tag.name);
          assert.equal(toB64Url(dbTags[j].value), tag.value);
        });
      });
    });

    it('should save missing transaction IDs in missing_transactions', async () => {
      for (let height = 1; height <= 200; height++) {
        const { block, txs, missingTxIds } =
          await chainSource.getBlockAndTxsByHeight(height);

        await db.saveBlockAndTxs(block, txs, missingTxIds);
      }

      const sql = `
        SELECT * FROM missing_transactions
        ORDER BY block_indep_hash, transaction_id
      `;

      const dbMissingTxs = coreDb.prepare(sql).all();

      const missingTxs = [
        {
          block_indep_hash:
            'D2D5WWVDBxoD-hDGorPqCl5AD7a3rac_kP2s7OY80fDM_qnTqkyjLLcTEOMRA0_M',
          transaction_id: 'MmKyBBqjk-BUFEsw5chhXZZ_tv7NrTj-55htn823RSk',
          height: 107,
        },
        {
          block_indep_hash:
            'F2LVA0stDZDJpkToRVibqQAfjSiMums0rSxNJ35NaviFch7vT6EK63HxxgDgKKj0',
          transaction_id: 'lYtQ--_duWSxNwMuYruxIGE2_Le8am54jB76PoqyOk8',
          height: 65,
        },
        {
          block_indep_hash:
            'JN89gO6Ny0DRoVrw6iaJcTUo744fDXKjDj4DBtf76oFI5moQ56nRiP1cd12BrtvJ',
          transaction_id: '91LHDJSNjVFhamHNwt660yVNdZfMRNDMb8oPwZ__xW4',
          height: 176,
        },
        {
          block_indep_hash:
            'KEmoiNais6dwdWGRKuVvoqBzx9GaQvbLoQz4Gf54lzMmgGBk9okX0dHIneeFGwRD',
          transaction_id: '4yuBbZkGVOsf_QkLhC4pzVGv4XrueZZXu9x3CbnCmUc',
          height: 145,
        },
        {
          block_indep_hash:
            'NygsmnbJN9N5GfIDuuNWcD3eQoMNLmzmvAzPVEcRYHhkoVlpQAAAwoeOVZd7eYAM',
          transaction_id: 'o1UWZD7Q81SVIXj9f4ixk-9q7Ph8-Jwq0k4mQLQlGO4',
          height: 75,
        },
        {
          block_indep_hash:
            'PHP1MrQBdNm5pYo1rWC057WGwYZ7RicAu0vV2Gwri-2E827z2E6bQ7YGAXZ54rs5',
          transaction_id: 'KZj5A-tQxQUBucTnNRZMYdSkSXztW00P9hnVqIv_4AM',
          height: 167,
        },
        {
          block_indep_hash:
            'RnpZKeVgbyKcSzXAvodEuUCqN_LhaiOhsR30gb3bjKmmBhkfjbBO0OkNq1X2KIWJ',
          transaction_id: 'KJexrl4gTGrnAUwgX2UgVzQnup9P6UeGj_-8KvN9yQI',
          height: 114,
        },
        {
          block_indep_hash:
            'WAuLvCtWR7fQJYarbO1nfjqvKMJxy7dAyl7HulZOXLyy89gYhhLZuEafEhREVcOP',
          transaction_id: 'Dw6OFwh0YjVq8lHOdi7igTTbbrCR7CM7v-kXiynwdmM',
          height: 138,
        },
        {
          block_indep_hash:
            'XkZPj08mmGWSc_i5DN4v2F0R4v7HaGsX0I7OI1wtfpegPYelKWrIGwxzmdlCUktB',
          transaction_id: 'fjKUmMl67VahJqR-6oYYMQB_LSUxeXOWb-oM_JRrG5k',
          height: 54,
        },
        {
          block_indep_hash:
            'YlSZJEmac4BF0mzPbXc5F_evGBqDdPpw5JiKD-F0CPQDWR_KN3jtwa9FX-g4auX5',
          transaction_id: 'UjDaRcYs1zoEleKrl9B3miG1lwRyD_5AdM6oeEe-k2s',
          height: 151,
        },
        {
          block_indep_hash:
            'gYZpHCm6YdhiPOG6dGWGeh7zqLsQqOMJZaAkIPfr7CqYL7WktA-0tVsQUQL5en-6',
          transaction_id: '1pHqMoNBJthy3JXYJr1GmItt2_QRNBHOZBSTOQDk-r8',
          height: 153,
        },
        {
          block_indep_hash:
            'ngFDAB2KRhJgJRysuhpp1u65FjBf5WZk99_NyoMx8w6uP0IVjzb93EVkYxmcErdZ',
          transaction_id: '7BoxcxiJIjTwUp3JXp0xRJQXf6hZtyJj1kjGNiEl5A8',
          height: 100,
        },
        {
          block_indep_hash:
            'r8OR72xviqU3kq3WwbWveUuTMNsP4Of_9JDqjrgA4UrHSJm1A92_gT5ctPew7I7A',
          transaction_id: 'o5SWZckPuQ9kqIaaJJHYgfxQ8LvkeVNyiCmDxu0sg9o',
          height: 185,
        },
        {
          block_indep_hash:
            'xiLfXCBtz8K1Xhgrr2rcje43FGo2kDOG6hrxhgc6imafsR8ybLF5b3XD4hkSPzRK',
          transaction_id: 'ZaMEF5W4jk0BbL_o8DzrK0HM_RB3hoJYn_al_9pTOp0',
          height: 61,
        },
        {
          block_indep_hash:
            '6OAy50Jx7O7JxHkG8SbGenvX_aHQ-6klsc7gOhLtDF1ebleir2sSJ1_MI3VKSv7N',
          transaction_id: 't81tluHdoePSxjq7qG-6TMqBKmQLYr5gupmfvW25Y_o',
          height: 82,
        },
      ];

      assert.equal(dbMissingTxs.length, missingTxs.length);

      missingTxs.forEach((missingTx, i) => {
        assert.deepEqual(
          dbMissingTxs[i].block_indep_hash,
          fromB64Url(missingTx.block_indep_hash),
        );
        assert.deepEqual(
          dbMissingTxs[i].transaction_id,
          fromB64Url(missingTx.transaction_id),
        );
        assert.equal(dbMissingTxs[i].height, missingTx.height);
      });
    });

    it('should flush blocks and transactions to stable tables', async () => {
      for (let height = 1; height <= 200; height++) {
        const { block, txs, missingTxIds } =
          await chainSource.getBlockAndTxsByHeight(height);

        await db.saveBlockAndTxs(block, txs, missingTxIds);
      }

      // TODO replace with queries to make more focused
      const stats = await db.getDebugInfo();
      assert.equal(stats.counts.stableBlocks, 181);
    });

    it('should save stable transaction IDs to stable_block_transactions', async () => {
      for (let height = 1; height <= 200; height++) {
        const { block, txs, missingTxIds } =
          await chainSource.getBlockAndTxsByHeight(height);

        await db.saveBlockAndTxs(block, txs, missingTxIds);
      }

      const sql = `
        SELECT * FROM stable_block_transactions
        ORDER BY block_indep_hash, transaction_id
      `;

      const dbStableBlockTransactions = coreDb.prepare(sql).all();

      const stableBlockTransactions = [
        {
          block_indep_hash:
            'D2D5WWVDBxoD-hDGorPqCl5AD7a3rac_kP2s7OY80fDM_qnTqkyjLLcTEOMRA0_M',
          transaction_id: 'MmKyBBqjk-BUFEsw5chhXZZ_tv7NrTj-55htn823RSk',
          block_transaction_index: 0,
        },
        {
          block_indep_hash:
            'F2LVA0stDZDJpkToRVibqQAfjSiMums0rSxNJ35NaviFch7vT6EK63HxxgDgKKj0',
          transaction_id: 'lYtQ--_duWSxNwMuYruxIGE2_Le8am54jB76PoqyOk8',
          block_transaction_index: 0,
        },
        {
          block_indep_hash:
            'JN89gO6Ny0DRoVrw6iaJcTUo744fDXKjDj4DBtf76oFI5moQ56nRiP1cd12BrtvJ',
          transaction_id: '91LHDJSNjVFhamHNwt660yVNdZfMRNDMb8oPwZ__xW4',
          block_transaction_index: 0,
        },
        {
          block_indep_hash:
            'KEmoiNais6dwdWGRKuVvoqBzx9GaQvbLoQz4Gf54lzMmgGBk9okX0dHIneeFGwRD',
          transaction_id: '4yuBbZkGVOsf_QkLhC4pzVGv4XrueZZXu9x3CbnCmUc',
          block_transaction_index: 0,
        },
        {
          block_indep_hash:
            'NygsmnbJN9N5GfIDuuNWcD3eQoMNLmzmvAzPVEcRYHhkoVlpQAAAwoeOVZd7eYAM',
          transaction_id: 'o1UWZD7Q81SVIXj9f4ixk-9q7Ph8-Jwq0k4mQLQlGO4',
          block_transaction_index: 0,
        },
        {
          block_indep_hash:
            'PHP1MrQBdNm5pYo1rWC057WGwYZ7RicAu0vV2Gwri-2E827z2E6bQ7YGAXZ54rs5',
          transaction_id: 'KZj5A-tQxQUBucTnNRZMYdSkSXztW00P9hnVqIv_4AM',
          block_transaction_index: 0,
        },
        {
          block_indep_hash:
            'RnpZKeVgbyKcSzXAvodEuUCqN_LhaiOhsR30gb3bjKmmBhkfjbBO0OkNq1X2KIWJ',
          transaction_id: 'KJexrl4gTGrnAUwgX2UgVzQnup9P6UeGj_-8KvN9yQI',
          block_transaction_index: 0,
        },
        {
          block_indep_hash:
            'WAuLvCtWR7fQJYarbO1nfjqvKMJxy7dAyl7HulZOXLyy89gYhhLZuEafEhREVcOP',
          transaction_id: 'Dw6OFwh0YjVq8lHOdi7igTTbbrCR7CM7v-kXiynwdmM',
          block_transaction_index: 0,
        },
        {
          block_indep_hash:
            'XkZPj08mmGWSc_i5DN4v2F0R4v7HaGsX0I7OI1wtfpegPYelKWrIGwxzmdlCUktB',
          transaction_id: 'fjKUmMl67VahJqR-6oYYMQB_LSUxeXOWb-oM_JRrG5k',
          block_transaction_index: 0,
        },
        {
          block_indep_hash:
            'YlSZJEmac4BF0mzPbXc5F_evGBqDdPpw5JiKD-F0CPQDWR_KN3jtwa9FX-g4auX5',
          transaction_id: 'UjDaRcYs1zoEleKrl9B3miG1lwRyD_5AdM6oeEe-k2s',
          block_transaction_index: 0,
        },
        {
          block_indep_hash:
            'fxxFMvVrp8oOgBEjDr0WuI2PpVny1mJiq9S551y0Y5T-H7B4JKhc-gNkKz8zJ7oR',
          transaction_id: 'glHacTmLlPSw55wUOU-MMaknJjWWHBLN16U8f3YuOd4',
          block_transaction_index: 0,
        },
        {
          block_indep_hash:
            'gYZpHCm6YdhiPOG6dGWGeh7zqLsQqOMJZaAkIPfr7CqYL7WktA-0tVsQUQL5en-6',
          transaction_id: '1pHqMoNBJthy3JXYJr1GmItt2_QRNBHOZBSTOQDk-r8',
          block_transaction_index: 0,
        },
        {
          block_indep_hash:
            'ngFDAB2KRhJgJRysuhpp1u65FjBf5WZk99_NyoMx8w6uP0IVjzb93EVkYxmcErdZ',
          transaction_id: '7BoxcxiJIjTwUp3JXp0xRJQXf6hZtyJj1kjGNiEl5A8',
          block_transaction_index: 0,
        },
        {
          block_indep_hash:
            'vt3XSYzN-jjqT_bp520T0DXCvkbDlsY7WTNuH6QQzs2wjWrzJlalWp5Bn1WLtp04',
          transaction_id: 'fgZVZzLOTwdVdeqnPZrbHmtx2MXfyjqNc6xOrt6wOMk',
          block_transaction_index: 0,
        },
        {
          block_indep_hash:
            'xiLfXCBtz8K1Xhgrr2rcje43FGo2kDOG6hrxhgc6imafsR8ybLF5b3XD4hkSPzRK',
          transaction_id: 'ZaMEF5W4jk0BbL_o8DzrK0HM_RB3hoJYn_al_9pTOp0',
          block_transaction_index: 0,
        },
        {
          block_indep_hash:
            '6OAy50Jx7O7JxHkG8SbGenvX_aHQ-6klsc7gOhLtDF1ebleir2sSJ1_MI3VKSv7N',
          transaction_id: 't81tluHdoePSxjq7qG-6TMqBKmQLYr5gupmfvW25Y_o',
          block_transaction_index: 0,
        },
      ];

      assert.equal(
        dbStableBlockTransactions.length,
        stableBlockTransactions.length,
      );

      stableBlockTransactions.forEach((stableBlockTransaction, i) => {
        assert.deepEqual(
          dbStableBlockTransactions[i].block_indep_hash,
          fromB64Url(stableBlockTransaction.block_indep_hash),
        );
        assert.deepEqual(
          dbStableBlockTransactions[i].transaction_id,
          fromB64Url(stableBlockTransaction.transaction_id),
        );
        assert.equal(
          dbStableBlockTransactions[i].block_transaction_index,
          stableBlockTransaction.block_transaction_index,
        );
      });
    });

    it('should copy all the block fields to the stable_blocks table', async () => {
      const height = 982575;

      const { block, txs, missingTxIds } =
        await chainSource.getBlockAndTxsByHeight(height);

      await db.saveBlockAndTxs(block, txs, missingTxIds);
      dbWorker.saveCoreStableDataFn(height + 1);

      const stats = await db.getDebugInfo();
      assert.equal(stats.counts.stableBlocks, 1);

      const dbBlock = coreDb
        .prepare(`SELECT * FROM stable_blocks WHERE height = ${height}`)
        .get();

      const binaryFields = [
        'indep_hash',
        'previous_block',
        'nonce',
        'hash',
        'reward_addr',
        'hash_list_merkle',
        'wallet_list',
        'tx_root',
      ];
      for (const field of binaryFields) {
        assert.ok(dbBlock[field] instanceof Buffer);
        assert.equal(toB64Url(dbBlock[field]), (block as any)[field]);
      }

      const stringFields = ['diff', 'cumulative_diff'];
      for (const field of stringFields) {
        assert.equal(typeof dbBlock[field], 'string');
        assert.equal(dbBlock[field], (block as any)[field]);
      }

      // Note: 'timestamp' is renamed to 'block_timestamp' to avoid collision
      // with the SQLite timestamp data type
      assert.equal(typeof dbBlock.block_timestamp, 'number');
      assert.equal(dbBlock.block_timestamp, block.timestamp);

      const integerFields = ['height', 'last_retarget'];
      for (const field of integerFields) {
        assert.equal(typeof dbBlock[field], 'number');
        assert.equal(dbBlock[field], (block as any)[field]);
      }

      // These fields are strings in JSON blocks but 64 bit integers in SQLite
      const stringIntegerFields = ['block_size', 'weave_size'];
      for (const field of stringIntegerFields) {
        assert.equal(typeof dbBlock[field], 'number');
        assert.equal(typeof (block as any)[field], 'string');
        assert.equal(dbBlock[field].toString(), (block as any)[field]);
      }

      assert.equal(typeof dbBlock.usd_to_ar_rate_divisor, 'number');
      assert.equal(typeof (block.usd_to_ar_rate ?? [])[1], 'string');
      assert.equal(
        dbBlock.usd_to_ar_rate_divisor.toString(),
        (block.usd_to_ar_rate ?? [])[1],
      );

      assert.equal(typeof dbBlock.usd_to_ar_rate_divisor, 'number');
      assert.equal(typeof (block.usd_to_ar_rate ?? [])[1], 'string');
      assert.equal(
        dbBlock.usd_to_ar_rate_divisor.toString(),
        (block.usd_to_ar_rate ?? [])[1],
      );

      assert.equal(typeof dbBlock.scheduled_usd_to_ar_rate_dividend, 'number');
      assert.equal(typeof (block.scheduled_usd_to_ar_rate ?? [])[0], 'string');
      assert.equal(
        dbBlock.scheduled_usd_to_ar_rate_dividend.toString(),
        (block.scheduled_usd_to_ar_rate ?? [])[0],
      );

      assert.equal(typeof dbBlock.scheduled_usd_to_ar_rate_divisor, 'number');
      assert.equal(typeof (block.scheduled_usd_to_ar_rate ?? [])[1], 'string');
      assert.equal(
        dbBlock.scheduled_usd_to_ar_rate_divisor.toString(),
        (block.scheduled_usd_to_ar_rate ?? [])[1],
      );
    });

    it('should copy all the transaction fields to the stable_transactions table', async () => {
      const height = 982575;

      const { block, txs, missingTxIds } =
        await chainSource.getBlockAndTxsByHeight(height);

      await db.saveBlockAndTxs(block, txs, missingTxIds);

      const stats = await db.getDebugInfo();
      assert.equal(stats.counts.newTxs, txs.length);

      await db.saveBlockAndTxs(block, txs, missingTxIds);
      dbWorker.saveCoreStableDataFn(height + 1);

      const sql = `
        SELECT sb.*, wo.public_modulus AS owner
        FROM stable_transactions sb
        JOIN wallets wo ON wo.address = sb.owner_address
        WHERE sb.height = ${height}
        ORDER BY sb.height, sb.block_transaction_index
      `;

      const dbTransactions = coreDb.prepare(sql).all();

      const txIds = [
        'vYQNQruccPlvxatkcRYmoaVywIzHxS3DuBG1CPxNMPA',
        'oq-v4Cv61YAGmY_KlLdxmGp5HjcldvOSLOMv0UPjSTE',
        'cK9WF2XMwFj5TF1uhaCSdrA2mVoaxAz20HkDyQhq0i0',
      ];

      txIds.forEach((txId, i) => {
        const tx = JSON.parse(
          fs.readFileSync(`test/mock_files/txs/${txId}.json`, 'utf8'),
        );

        const ownerAddress = crypto
          .createHash('sha256')
          .update(fromB64Url(tx.owner))
          .digest();
        assert.deepEqual(dbTransactions[i].owner_address, ownerAddress);

        const binaryFields = ['id', 'last_tx', 'owner', 'target', 'data_root'];

        for (const field of binaryFields) {
          assert.ok(dbTransactions[i][field] instanceof Buffer);
          assert.equal(toB64Url(dbTransactions[i][field]), (tx as any)[field]);
        }

        const stringFields = ['quantity', 'reward'];
        for (const field of stringFields) {
          assert.equal(typeof dbTransactions[i][field], 'string');
          assert.equal(dbTransactions[i][field], (tx as any)[field]);
        }

        const integerFields = ['format'];
        for (const field of integerFields) {
          assert.equal(typeof dbTransactions[i][field], 'number');
          assert.equal(dbTransactions[i][field], (tx as any)[field]);
        }

        const stringIntegerFields = ['data_size'];
        for (const field of stringIntegerFields) {
          assert.equal(typeof dbTransactions[i][field], 'number');
          assert.equal(typeof (tx as any)[field], 'string');
          assert.equal(dbTransactions[i][field].toString(), (tx as any)[field]);
        }

        const sql = `
          SELECT stt.*, tn.name, tv.value
          FROM stable_transaction_tags stt
          JOIN tag_names tn ON tn.hash = stt.tag_name_hash
          JOIN tag_values tv ON tv.hash = stt.tag_value_hash
          JOIN stable_transactions st ON st.id = stt.transaction_id
          WHERE stt.transaction_id = @transaction_id
          ORDER BY st.height, st.block_transaction_index, stt.transaction_tag_index
        `;

        const dbTags = coreDb
          .prepare(sql)
          .all({ transaction_id: fromB64Url(txId) });

        assert.equal(dbTags.length, tx.tags.length);

        tx.tags.forEach((tag: any, j: number) => {
          assert.deepEqual(
            dbTags[j].tag_name_hash,
            crypto.createHash('sha1').update(fromB64Url(tag.name)).digest(),
          );
          assert.deepEqual(
            dbTags[j].tag_value_hash,
            crypto.createHash('sha1').update(fromB64Url(tag.value)).digest(),
          );
          assert.equal(toB64Url(dbTags[j].name), tag.name);
          assert.equal(toB64Url(dbTags[j].value), tag.value);
        });
      });
    });

    it('should copy all the owner fields to the stable_transactions table', async () => {
      const height = 34;

      const { block, txs, missingTxIds } =
        await chainSource.getBlockAndTxsByHeight(height);

      await db.saveBlockAndTxs(block, txs, missingTxIds);

      const stats = await db.getDebugInfo();
      assert.equal(stats.counts.newTxs, txs.length);

      await db.saveBlockAndTxs(block, txs, missingTxIds);
      dbWorker.saveCoreStableDataFn(height + 1);

      const sql = `
        SELECT sb.*, wo.public_modulus AS owner
        FROM stable_transactions sb
        JOIN wallets wo ON wo.address = sb.owner_address
        WHERE sb.height = ${height}
        ORDER BY sb.height, sb.block_transaction_index
      `;

      const dbTransactions = coreDb.prepare(sql).all();

      const txIds = ['glHacTmLlPSw55wUOU-MMaknJjWWHBLN16U8f3YuOd4'];

      txIds.forEach((txId, i) => {
        const tx = JSON.parse(
          fs.readFileSync(`test/mock_files/txs/${txId}.json`, 'utf8'),
        );

        const ownerAddress = crypto
          .createHash('sha256')
          .update(fromB64Url(tx.owner))
          .digest();
        assert.deepEqual(dbTransactions[i].owner_address, ownerAddress);

        const binaryFields = ['id', 'last_tx', 'owner', 'target', 'data_root'];

        for (const field of binaryFields) {
          assert.ok(dbTransactions[i][field] instanceof Buffer);
          assert.equal(toB64Url(dbTransactions[i][field]), (tx as any)[field]);
        }

        const stringFields = ['quantity', 'reward'];
        for (const field of stringFields) {
          assert.equal(typeof dbTransactions[i][field], 'string');
          assert.equal(dbTransactions[i][field], (tx as any)[field]);
        }

        const integerFields = ['format'];
        for (const field of integerFields) {
          assert.equal(typeof dbTransactions[i][field], 'number');
          assert.equal(dbTransactions[i][field], (tx as any)[field]);
        }

        const stringIntegerFields = ['data_size'];
        for (const field of stringIntegerFields) {
          assert.equal(typeof dbTransactions[i][field], 'number');
          assert.equal(typeof (tx as any)[field], 'string');
          assert.equal(dbTransactions[i][field].toString(), (tx as any)[field]);
        }

        const sql = `
          SELECT stt.*, tn.name, tv.value
          FROM stable_transaction_tags stt
          JOIN tag_names tn ON tn.hash = stt.tag_name_hash
          JOIN tag_values tv ON tv.hash = stt.tag_value_hash
          JOIN stable_transactions st ON st.id = stt.transaction_id
          WHERE stt.transaction_id = @transaction_id
          ORDER BY st.height, st.block_transaction_index, stt.transaction_tag_index
        `;

        const dbTags = coreDb
          .prepare(sql)
          .all({ transaction_id: fromB64Url(txId) });

        assert.equal(dbTags.length, tx.tags.length);

        tx.tags.forEach((tag: any, j: number) => {
          assert.deepEqual(
            dbTags[j].tag_name_hash,
            crypto.createHash('sha1').update(fromB64Url(tag.name)).digest(),
          );
          assert.deepEqual(
            dbTags[j].tag_value_hash,
            crypto.createHash('sha1').update(fromB64Url(tag.value)).digest(),
          );
          assert.equal(toB64Url(dbTags[j].name), tag.name);
          assert.equal(toB64Url(dbTags[j].value), tag.value);
        });
      });
    });
  });

  describe('saveTx', () => {
    const txId = 'vYQNQruccPlvxatkcRYmoaVywIzHxS3DuBG1CPxNMPA';

    beforeEach(async () => {
      const tx = JSON.parse(
        fs.readFileSync(`test/mock_files/txs/${txId}.json`, 'utf8'),
      );

      await db.saveTx(tx);
    });

    it('should insert into new_transactions', async () => {
      const sql = `
        SELECT COUNT(*) AS cnt
        FROM new_transactions
        WHERE id = @transaction_id
      `;

      assert.equal(
        coreDb.prepare(sql).get({ transaction_id: fromB64Url(txId) }).cnt,
        1,
      );
    });

    it('should insert into tag_names', async () => {
      const sql = `
        SELECT COUNT(*) AS cnt
        FROM tag_names
      `;

      assert.equal(coreDb.prepare(sql).get().cnt, 12);
    });

    it('should insert into tag_values', async () => {
      const sql = `
        SELECT COUNT(*) AS cnt
        FROM tag_values
      `;

      assert.equal(coreDb.prepare(sql).get().cnt, 12);
    });

    it('should insert into new_transaction_tags', async () => {
      const sql = `
        SELECT COUNT(*) AS cnt
        FROM new_transaction_tags
      `;

      assert.equal(coreDb.prepare(sql).get().cnt, 12);
    });

    it('should insert into wallets', async () => {
      const sql = `
        SELECT COUNT(*) AS cnt
        FROM wallets
      `;

      assert.equal(coreDb.prepare(sql).get().cnt, 1);
    });
  });

  describe('saveBundle', () => {
    const id0 = '0000000000000000000000000000000000000000000';
    const id1 = '1111111111111111111111111111111111111111111';
    const id2 = '2222222222222222222222222222222222222222222';

    const bundle: BundleRecord = {
      id: id0,
      format: 'ans-104',
      dataItemCount: 2,
      matchedDataItemCount: 2,
    };

    const bundleId1 = {
      ...bundle,
      id: id1,
      queuedAt: 1234567890,
      duplicatedDataItemCount: 1,
    };

    const sql = `
      SELECT *
      FROM bundles
      WHERE id = @id
    `;

    beforeEach(async () => {
      await db.saveBundle(bundle);
      await db.saveBundle(bundleId1);
      await db.saveBundle({
        ...bundle,
        id: id2,
        skippedAt: 1234567890,
      });
    });

    it('should insert into bundles', async () => {
      const sql = `
        SELECT COUNT(*) AS cnt
        FROM bundles
        WHERE id = @id
      `;

      assert.equal(bundlesDb.prepare(sql).get({ id: fromB64Url(id0) }).cnt, 1);
    });

    it('should update previous_unbundle_filter_id when unbundle_filter_id is not null', async () => {
      let bundle = bundlesDb.prepare(sql).get({ id: fromB64Url(id1) });

      // Verify initial state
      assert.equal(bundle.unbundle_filter_id, null);
      assert.equal(bundle.previous_unbundle_filter_id, null);

      await db.saveBundle({
        ...bundleId1,
        unbundleFilter: '{"never": true}',
      });

      bundle = bundlesDb.prepare(sql).get({ id: fromB64Url(id1) });

      assert.equal(bundle.unbundle_filter_id, 1);
      assert.equal(bundle.previous_unbundle_filter_id, null);

      await db.saveBundle({
        ...bundleId1,
        unbundleFilter: '{"always": true}',
      });

      bundle = bundlesDb.prepare(sql).get({ id: fromB64Url(id1) });

      assert.equal(bundle.unbundle_filter_id, 2);
      assert.equal(bundle.previous_unbundle_filter_id, 1);
    });

    it('should update previous_index_filter_id when index_filter_id is not null', async () => {
      let bundle = bundlesDb.prepare(sql).get({ id: fromB64Url(id1) });

      // Verify initial state
      assert.equal(bundle.index_filter_id, null);
      assert.equal(bundle.previous_index_filter_id, null);

      await db.saveBundle({
        ...bundleId1,
        indexFilter: '{"never": true}',
      });

      bundle = bundlesDb.prepare(sql).get({ id: fromB64Url(id1) });

      assert.equal(bundle.index_filter_id, 1);
      assert.equal(bundle.previous_index_filter_id, null);

      await db.saveBundle({
        ...bundleId1,
        indexFilter: '{"always": true}',
      });

      bundle = bundlesDb.prepare(sql).get({ id: fromB64Url(id1) });

      assert.equal(bundle.index_filter_id, 2);
      assert.equal(bundle.previous_index_filter_id, 1);
    });

    it('should set import_attempt_count 0 when no queuedAt or skippedAt is provided', async () => {
      assert.equal(
        bundlesDb.prepare(sql).get({ id: fromB64Url(id0) })
          .import_attempt_count,
        0,
      );
    });

    it('should set import_attempt_count 1 when queuedAt or skippedAt is provided', async () => {
      assert.equal(
        bundlesDb.prepare(sql).get({ id: fromB64Url(id1) })
          .import_attempt_count,
        1,
      );

      assert.equal(
        bundlesDb.prepare(sql).get({ id: fromB64Url(id2) })
          .import_attempt_count,
        1,
      );
    });

    it("shouldn't increment import_attempt_count when no queuedAt or skippedAt", async () => {
      await db.saveBundle({
        ...bundle,
        id: id1,
      });
      await db.saveBundle({
        ...bundle,
        id: id2,
      });

      assert.equal(
        bundlesDb.prepare(sql).get({ id: fromB64Url(id1) })
          .import_attempt_count,
        1,
      );

      assert.equal(
        bundlesDb.prepare(sql).get({ id: fromB64Url(id2) })
          .import_attempt_count,
        1,
      );
    });

    it('should increment import_attempt_count when queuedAt or skippedAt is provided', async () => {
      await db.saveBundle({
        ...bundle,
        id: id1,
        queuedAt: 1234567890,
      });
      await db.saveBundle({
        ...bundle,
        id: id2,
        skippedAt: 1234567890,
      });

      assert.equal(
        bundlesDb.prepare(sql).get({ id: fromB64Url(id1) })
          .import_attempt_count,
        2,
      );

      assert.equal(
        bundlesDb.prepare(sql).get({ id: fromB64Url(id2) })
          .import_attempt_count,
        2,
      );
    });
  });

  describe('saveBundleRetries', () => {
    const rootTxId1 = '1111111111111111111111111111111111111111111';
    const rootTxId2 = '2222222222222222222222222222222222222222222';
    const bundleId1 = '3333333333333333333333333333333333333333333';
    const bundleId2 = '4444444444444444444444444444444444444444444';
    const bundleId3 = '5555555555555555555555555555555555555555555';

    const sql = `
      SELECT *
      FROM bundles
      WHERE id = @id
    `;

    beforeEach(async () => {
      await db.saveBundle({
        id: bundleId1,
        format: 'ans-104',
        dataItemCount: 2,
        matchedDataItemCount: 2,
        rootTransactionId: rootTxId1,
      });

      await db.saveBundle({
        id: bundleId2,
        format: 'ans-104',
        dataItemCount: 2,
        matchedDataItemCount: 2,
        rootTransactionId: rootTxId1,
      });

      await db.saveBundle({
        id: bundleId3,
        format: 'ans-104',
        dataItemCount: 2,
        matchedDataItemCount: 2,
        rootTransactionId: rootTxId2,
      });
    });

    it('should update all bundles sharing the same root transaction id', async () => {
      let bundle1 = bundlesDb.prepare(sql).get({ id: fromB64Url(bundleId1) });
      let bundle2 = bundlesDb.prepare(sql).get({ id: fromB64Url(bundleId2) });
      let bundle3 = bundlesDb.prepare(sql).get({ id: fromB64Url(bundleId3) });

      assert.equal(bundle1.retry_attempt_count, null);
      assert.equal(bundle1.first_retried_at, null);
      assert.equal(bundle1.last_retried_at, null);

      assert.equal(bundle2.retry_attempt_count, null);
      assert.equal(bundle2.first_retried_at, null);
      assert.equal(bundle2.last_retried_at, null);

      assert.equal(bundle3.retry_attempt_count, null);
      assert.equal(bundle3.first_retried_at, null);
      assert.equal(bundle3.last_retried_at, null);

      await db.saveBundleRetries(rootTxId1);

      bundle1 = bundlesDb.prepare(sql).get({ id: fromB64Url(bundleId1) });
      bundle2 = bundlesDb.prepare(sql).get({ id: fromB64Url(bundleId2) });
      bundle3 = bundlesDb.prepare(sql).get({ id: fromB64Url(bundleId3) });

      assert.equal(bundle1.retry_attempt_count, 1);
      assert.ok(bundle1.first_retried_at !== null);
      assert.ok(bundle1.last_retried_at !== null);

      assert.equal(bundle2.retry_attempt_count, 1);
      assert.ok(bundle2.first_retried_at !== null);
      assert.ok(bundle2.last_retried_at !== null);

      assert.equal(bundle3.retry_attempt_count, null);
      assert.equal(bundle3.first_retried_at, null);
      assert.equal(bundle3.last_retried_at, null);

      await wait(1000);

      await db.saveBundleRetries(rootTxId1);

      bundle1 = bundlesDb.prepare(sql).get({ id: fromB64Url(bundleId1) });
      bundle2 = bundlesDb.prepare(sql).get({ id: fromB64Url(bundleId2) });
      bundle3 = bundlesDb.prepare(sql).get({ id: fromB64Url(bundleId3) });

      assert.equal(bundle1.retry_attempt_count, 2);
      assert.ok(bundle1.last_retried_at > bundle1.first_retried_at);

      assert.equal(bundle2.retry_attempt_count, 2);
      assert.ok(bundle2.last_retried_at > bundle2.first_retried_at);

      assert.equal(bundle3.retry_attempt_count, null);
      assert.equal(bundle3.first_retried_at, null);
      assert.equal(bundle3.last_retried_at, null);
    });

    it('should update timestamps correctly for multiple bundles', async () => {
      await db.saveBundleRetries(rootTxId1);

      let bundle1 = bundlesDb.prepare(sql).get({ id: fromB64Url(bundleId1) });
      let bundle2 = bundlesDb.prepare(sql).get({ id: fromB64Url(bundleId2) });

      assert.equal(bundle1.first_retried_at, bundle2.first_retried_at);
      assert.equal(bundle1.last_retried_at, bundle2.last_retried_at);

      await wait(1000);

      await db.saveBundleRetries(rootTxId1);

      bundle1 = bundlesDb.prepare(sql).get({ id: fromB64Url(bundleId1) });
      bundle2 = bundlesDb.prepare(sql).get({ id: fromB64Url(bundleId2) });

      assert.equal(bundle1.first_retried_at, bundle2.first_retried_at);

      assert.equal(bundle1.last_retried_at, bundle2.last_retried_at);
      assert.ok(bundle1.last_retried_at > bundle1.first_retried_at);
      assert.ok(bundle2.last_retried_at > bundle2.first_retried_at);
    });
  });

  describe('getFailedBundleIds — bundle-format gate (PE-9101)', () => {
    // selectFailedBundleIds must retry only actual bundles. Non-bundle
    // transactions can reach the bundles table via the admin queue-bundle
    // endpoint, which bypasses the Bundle-Format gate the live and backfill
    // queue paths enforce; without the gate they are retried forever.
    // sha256-derived ids: canonical base64url (round-trip safe through
    // fromB64Url/toB64Url) and collision-proof against other tests' rows.
    const hashId = (seed: string): string =>
      toB64Url(crypto.createHash('sha256').update(seed).digest());
    const realRootId = hashId('PE-9101 realRoot');
    const unknownRootId = hashId('PE-9101 unknownRoot');
    const nonBundleRootId = hashId('PE-9101 nonBundleRoot');

    // Bundle-Format / "binary" tag name+value hashes (see bundles/repair.sql).
    const bundleFormatNameHash = Buffer.from(
      'BF796ECA81CCE3FF36CEA53FA1EBB0F274A0FF29',
      'hex',
    );
    const binaryValueHash = Buffer.from(
      '7E57CFE843145135AEE1F4D0D63CEB7842093712',
      'hex',
    );

    const insertBundleRow = (id: string, rootId: string) => {
      bundlesDb
        .prepare(
          `INSERT INTO bundles (
             id, format_id, matched_data_item_count,
             root_transaction_id, retry_attempt_count
           ) VALUES (@id, 1, 2, @root, 0)`,
        )
        .run({ id: fromB64Url(id), root: fromB64Url(rootId) });
    };

    // beforeEach (not before): the suite's global afterEach truncates
    // every table, so fixtures must be re-seeded ahead of each test.
    beforeEach(() => {
      // Real bundle: root tx carries Bundle-Format=binary -> retried.
      insertBundleRow(realRootId, realRootId);
      coreDb
        .prepare(
          `INSERT INTO stable_transaction_tags (
             tag_name_hash, tag_value_hash, height,
             block_transaction_index, transaction_tag_index, transaction_id
           ) VALUES (@name, @value, 1, 0, 0, @txId)`,
        )
        .run({
          name: bundleFormatNameHash,
          value: binaryValueHash,
          txId: fromB64Url(realRootId),
        });

      // Non-bundle: root tx is indexed here but has no Bundle-Format tag
      // -> provably not a bundle -> excluded from the retry pool.
      insertBundleRow(nonBundleRootId, nonBundleRootId);
      coreDb
        .prepare(
          `INSERT INTO stable_transactions (
             id, height, block_transaction_index, format,
             last_tx, owner_address, quantity, reward, tag_count
           ) VALUES (@id, 1, 0, 2, @zero, @zero, '0', '0', 0)`,
        )
        .run({ id: fromB64Url(nonBundleRootId), zero: Buffer.alloc(32) });

      // Unknown: root tx is not indexed on this gateway, so we cannot
      // prove it is a non-bundle -> stays eligible for retry.
      insertBundleRow(unknownRootId, unknownRootId);
    });

    it('retries a bundle whose root carries Bundle-Format=binary', async () => {
      const ids = await db.getFailedBundleIds(100_000);
      assert.ok(ids.includes(realRootId));
    });

    it('excludes a non-bundle whose indexed root tx has no Bundle-Format tag', async () => {
      const ids = await db.getFailedBundleIds(100_000);
      assert.ok(!ids.includes(nonBundleRootId));
    });

    it('keeps a bundle whose root tx is not indexed on this gateway', async () => {
      const ids = await db.getFailedBundleIds(100_000);
      assert.ok(ids.includes(unknownRootId));
    });
  });

  describe('getFailedBundleIds — retry cap + cooldown', () => {
    // Roots are left unindexed on this gateway so they pass the bundle-format
    // gate via the "unknown root" branch; that isolates the cap/cooldown
    // clauses from the gate. Defaults under test: BUNDLE_REPAIR_MAX_RETRY_ATTEMPTS
    // = 50, BUNDLE_REPAIR_RETRY_COOLDOWN_SECONDS = 900.
    const hashId = (seed: string): string =>
      toB64Url(crypto.createHash('sha256').update(seed).digest());
    // Capture `now` per-test, not at suite load. The "within cooldown"
    // assertion compares against getFailedBundleIds's real-time @retry_cutoff
    // (now - BUNDLE_REPAIR_RETRY_COOLDOWN_SECONDS); a load-time `now` could age
    // out of the 900s window if the suite runs long enough and flake the test.
    let now: number;
    beforeEach(() => {
      now = Math.floor(Date.now() / 1000);
    });

    const insertBundleRow = (
      id: string,
      {
        retryAttemptCount = 0,
        lastRetriedAt = null,
      }: { retryAttemptCount?: number; lastRetriedAt?: number | null },
    ) => {
      bundlesDb
        .prepare(
          `INSERT INTO bundles (
             id, format_id, matched_data_item_count,
             root_transaction_id, retry_attempt_count, last_retried_at
           ) VALUES (@id, 1, NULL, @root, @retry, @lastRetried)`,
        )
        .run({
          id: fromB64Url(id),
          root: fromB64Url(id),
          retry: retryAttemptCount,
          lastRetried: lastRetriedAt,
        });
    };

    it('retries a bundle just under the attempt cap', async () => {
      const id = hashId('cap under');
      insertBundleRow(id, { retryAttemptCount: 49 });
      const ids = await db.getFailedBundleIds(100_000);
      assert.ok(ids.includes(id));
    });

    it('drops a bundle that has reached the attempt cap', async () => {
      const id = hashId('cap reached');
      insertBundleRow(id, { retryAttemptCount: 50 });
      const ids = await db.getFailedBundleIds(100_000);
      assert.ok(!ids.includes(id));
    });

    it('skips a bundle retried within the cooldown window', async () => {
      const id = hashId('cooldown recent');
      insertBundleRow(id, { lastRetriedAt: now });
      const ids = await db.getFailedBundleIds(100_000);
      assert.ok(!ids.includes(id));
    });

    it('retries a bundle whose last retry is older than the cooldown', async () => {
      const id = hashId('cooldown old');
      insertBundleRow(id, { lastRetriedAt: now - 100_000 });
      const ids = await db.getFailedBundleIds(100_000);
      assert.ok(ids.includes(id));
    });

    it('retries a bundle that has never been retried (null last_retried_at)', async () => {
      const id = hashId('cooldown null');
      insertBundleRow(id, { lastRetriedAt: null });
      const ids = await db.getFailedBundleIds(100_000);
      assert.ok(ids.includes(id));
    });
  });

  describe('getFullRepairBacklogCount (PE-9101)', () => {
    const insertBundle = (
      seed: string,
      matched: number | null,
      fullyIndexedAt: number | null,
      skippedAt: number | null,
    ) => {
      bundlesDb
        .prepare(
          `INSERT INTO bundles (
             id, format_id, matched_data_item_count,
             last_fully_indexed_at, last_skipped_at
           ) VALUES (@id, 1, @matched, @fully, @skipped)`,
        )
        .run({
          id: crypto
            .createHash('sha256')
            .update(`PE-9101 full-backlog ${seed}`)
            .digest(),
          matched,
          fully: fullyIndexedAt,
          skipped: skippedAt,
        });
    };

    beforeEach(() => {
      insertBundle('never-unbundled', null, null, null); // counted
      insertBundle('in-flight', 5, null, null); // counted
      insertBundle('finished-zero-items', 0, null, null); // excluded
      insertBundle('fully-indexed', 5, 1_700_000_000, null); // excluded
      insertBundle('skipped', 5, null, 1_700_000_000); // excluded
    });

    it('counts never-unbundled + in-flight bundles, excludes finished/indexed/skipped', async () => {
      assert.equal(await db.getFullRepairBacklogCount(), 2);
    });
  });

  describe('getVerifiableDataIds', () => {
    it("should return an empty list if there's no verifiable data ids", async () => {
      const emptyDbIds = await db.getVerifiableDataIds();
      assert.equal(emptyDbIds.length, 0);

      // inserting a verified data id
      await db.saveDataContentAttributes({
        id: '0000000000000000000000000000000000000000000',
        hash: '0000000000000000000000000000000000000000000',
        dataSize: 10,
        verified: true,
      });

      const verifiableIds = await db.getVerifiableDataIds();
      assert.equal(verifiableIds.length, 0);
    });

    it('should return a list of ids if verifiable data ids exists', async () => {
      // inserting a verified data id
      await db.saveDataContentAttributes({
        id: '0000000000000000000000000000000000000000000',
        hash: '0000000000000000000000000000000000000000000',
        dataSize: 10,
        verified: true,
      });

      // inserting an unverified data id
      await db.saveDataContentAttributes({
        id: DATA_ITEM_ID,
        hash: 'hash',
        dataSize: 10,
        verified: false,
        verificationPriority: 100, // Set priority above MIN_DATA_VERIFICATION_PRIORITY
      });

      await db.saveDataItem(normalizedDataItem);

      const verifiableIds = await db.getVerifiableDataIds();
      assert.equal(verifiableIds.length, 1);
      assert.deepEqual(verifiableIds, [DATA_ITEM_ID]);
    });
  });

  describe('getRootTx', () => {
    it('should return undefined if id is not found', async () => {
      const result = await db.getRootTx(DATA_ITEM_ID);
      assert.equal(result, undefined);
    });

    it('should return root transcation id of a given data item', async () => {
      await db.saveDataItem(normalizedDataItem);

      const result = await db.getRootTx(DATA_ITEM_ID);
      assert.equal(result?.rootTxId, dataItemRootTxId);
    });

    it('should return undefined if the root transcation id of a given data item is null', async () => {
      const dataItem = normalizedDataItem;
      dataItem.root_tx_id = null;
      await db.saveDataItem(dataItem);

      const result = await db.getRootTx(DATA_ITEM_ID);
      assert.equal(result, undefined);
    });

    it('should return the same L1 transcation id given an L1 transaction ', async () => {
      const l1TxId = 'vYQNQruccPlvxatkcRYmoaVywIzHxS3DuBG1CPxNMPA';
      const height = 982575;

      const { block, txs, missingTxIds } =
        await chainSource.getBlockAndTxsByHeight(height);

      await db.saveBlockAndTxs(block, txs, missingTxIds);

      const result = await db.getRootTx(l1TxId);
      assert.equal(result?.rootTxId, l1TxId);
    });
  });

  describe('getDataAttributes — parentId surfacing (PR #705)', () => {
    // Regression: the canonical selectDataAttributes SQL didn't SELECT
    // parent_id, so dataAttributes.parentId was always undefined. The
    // route handler's X-AR-IO-Root-Path emission depended on it
    // matching rootTransactionId for the single-level case. Without
    // these rows, the header silently never fired in production. See
    // src/database/sql/core/data-attributes.sql and
    // src/routes/data/handlers.ts:502 for the cache-and-replay path.
    // Use IDs distinct from DATA_ITEM_ID/dataItemRootTxId — earlier
    // describe blocks mutate the shared `normalizedDataItem` fixture
    // (e.g. getRootTx sets root_tx_id = null), so reusing the same
    // IDs here would inherit polluted state under full-suite ordering.
    //
    // Both IDs are 43-char base64url strings ending in '0'. The last
    // char of a 43-char b64url id encodes only the high 4 bits of a
    // byte; the trailing 2 bits MUST be zero for the string to be
    // canonical (round-trip stable through fromB64Url → toB64Url).
    // '0' = 110100 has trailing '00' — canonical. Without this, the
    // SQL row's parent_id encodes back to a different string and the
    // assertion fails on a benign-looking single-char delta.
    const PARENT_TEST_DATA_ITEM_ID =
      'PrtTstParentIdSurfaceCheckPrtTstParentIdSI0';
    const PARENT_TEST_PARENT_ID = '1111111111111111111111111111111111111111110';

    it('returns parentId from a data item row', async () => {
      const item = normalizeAns104DataItem({
        rootTxId: PARENT_TEST_PARENT_ID,
        parentId: PARENT_TEST_PARENT_ID,
        parentIndex: -1,
        index: 0,
        ans104DataItem: { ...dataItem, id: PARENT_TEST_DATA_ITEM_ID },
        filter: '',
        dataHash: '',
        rootParentOffset: 0,
      });
      await db.saveDataItem(item);

      const attrs = await db.getDataAttributes(PARENT_TEST_DATA_ITEM_ID);
      assert.notEqual(attrs, undefined);
      assert.equal(attrs!.parentId, PARENT_TEST_PARENT_ID);
      // Sanity: rootTransactionId should also be populated and equal
      // parentId in the single-level case (parentId === rootTxId) —
      // this is exactly what triggers X-AR-IO-Root-Path emission.
      assert.equal(attrs!.rootTransactionId, PARENT_TEST_PARENT_ID);
    });

    it('returns parentId === undefined for an L1 transaction', async () => {
      // L1 transactions have no parent — they ARE the root. The SQL
      // selects null AS parent_id from the stable_transactions /
      // new_transactions branches; the JS layer maps that to
      // parentId === undefined (NOT null) so consumers can use the
      // simple `!= null` guard.
      const l1TxId = 'vYQNQruccPlvxatkcRYmoaVywIzHxS3DuBG1CPxNMPA';
      const height = 982575;
      const { block, txs, missingTxIds } =
        await chainSource.getBlockAndTxsByHeight(height);
      await db.saveBlockAndTxs(block, txs, missingTxIds);

      const attrs = await db.getDataAttributes(l1TxId);
      assert.notEqual(attrs, undefined);
      assert.equal(attrs!.parentId, undefined);
      // Note: L1 txs surface rootTransactionId === undefined too — the
      // SQL selects null AS root_transaction_id from the transaction
      // branches. The route handler's path-emit guard requires both to
      // be non-null AND equal, so L1s correctly omit X-AR-IO-Root-Path.
    });

    it('returns undefined when the id is not in the database at all', async () => {
      const attrs = await db.getDataAttributes(
        'unknown-data-attributes-id-not-in-db-aaaaaaaaa',
      );
      assert.equal(attrs, undefined);
    });
  });

  describe('getDataAttributesByHash', () => {
    // Canonical (round-trip-stable) 43-char base64url values.
    const HASH = crypto
      .createHash('sha256')
      .update('by-hash-content')
      .digest('base64url');
    const ID = crypto
      .createHash('sha256')
      .update('by-hash-representative-id')
      .digest('base64url');

    it('resolves size and a representative id from the content hash', async () => {
      await db.saveDataContentAttributes({
        id: ID,
        hash: HASH,
        dataSize: 4321,
        verified: true,
      });

      const attrs = await db.getDataAttributesByHash(HASH);
      assert.notEqual(attrs, undefined);
      assert.equal(attrs!.hash, HASH);
      assert.equal(attrs!.size, 4321);
      assert.equal(attrs!.id, ID);
    });

    it('returns undefined for a hash with no content indexed', async () => {
      const unknown = crypto
        .createHash('sha256')
        .update('never-stored')
        .digest('base64url');
      const attrs = await db.getDataAttributesByHash(unknown);
      assert.equal(attrs, undefined);
    });

    it('deterministically prefers a verified id when several share a hash', async () => {
      // Two distinct ids with byte-identical content → same hash. The
      // representative must deterministically be the verified one, not
      // whichever the index happens to yield first.
      const sharedHash = crypto
        .createHash('sha256')
        .update('shared-by-two-ids')
        .digest('base64url');
      const unverifiedId = crypto
        .createHash('sha256')
        .update('dup-unverified')
        .digest('base64url');
      const verifiedId = crypto
        .createHash('sha256')
        .update('dup-verified')
        .digest('base64url');

      await db.saveDataContentAttributes({
        id: unverifiedId,
        hash: sharedHash,
        dataSize: 99,
        verified: false,
      });
      await db.saveDataContentAttributes({
        id: verifiedId,
        hash: sharedHash,
        dataSize: 99,
        verified: true,
      });

      const attrs = await db.getDataAttributesByHash(sharedHash);
      assert.equal(attrs!.id, verifiedId);
    });
  });

  describe('upsertNewDataItem clobber resistance (PE-9073)', () => {
    // Regression: after the unbundle path back-fills parent_id /
    // root_transaction_id / data_offset on a previously-optimistic data item,
    // a subsequent optimistic re-POST (which passes NULL for those fields)
    // must NOT clobber the back-filled values. Without this, a follow-up
    // flushStableDataItems would crash on stable_data_item_tags.parent_id
    // NOT NULL.
    const itemId = 'PE9073RegressionTestPE9073RegressionTestAAA';
    const bundleParentId = '2222222222222222222222222222222222222222222';
    const bundleRootTxId = '3333333333333333333333333333333333333333333';

    const optimisticItem = {
      anchor: 'YW5jaG9y',
      data_hash: null,
      data_offset: null,
      data_size: 1234,
      id: itemId,
      index: null,
      offset: null,
      owner: 'b3duZXI',
      owner_address: 'b3duZXJfYWRkcmVzcw',
      owner_offset: null,
      owner_size: null,
      parent_id: null,
      parent_index: null,
      root_parent_offset: null,
      root_tx_id: null,
      signature: 'c2lnbmF0dXJl',
      signature_offset: null,
      signature_size: null,
      signature_type: null,
      size: null,
      tags: [],
      target: 'dGFyZ2V0',
    } as unknown as NormalizedDataItem;

    const bundleBackfillItem = {
      ...optimisticItem,
      data_offset: 100,
      filter: '{"always": true}',
      index: 0,
      offset: 200,
      owner_offset: 50,
      owner_size: 32,
      parent_id: bundleParentId,
      parent_index: 0,
      root_parent_offset: 300,
      root_tx_id: bundleRootTxId,
      signature_offset: 60,
      signature_size: 32,
      signature_type: 1,
      size: 1234,
    } as unknown as NormalizedDataItem;

    it('preserves back-filled parent_id, root_transaction_id, data_offset on optimistic re-POST', async () => {
      // 1. Optimistic POST (no tuple knowledge): row inserted with NULL
      //    root-atom fields via insertOptimisticDataItem.
      await db.saveDataItem(optimisticItem, /* isOptimistic */ true);

      // 2. Unbundle back-fill (full tuple): same id, non-NULL values via
      //    the atomic root-atom upsert.
      await db.saveDataItem(bundleBackfillItem);

      // 3. Optimistic re-POST. With the structural fix, this routes to
      //    insertOptimisticDataItem (DO NOTHING on conflict) and cannot
      //    touch the root atom. Pre-structural-fix this corrupted values
      //    via the per-column COALESCE on a single shared upsert.
      await db.saveDataItem(optimisticItem, /* isOptimistic */ true);

      const row = bundlesDb
        .prepare(
          'SELECT parent_id, root_transaction_id, data_offset FROM new_data_items WHERE id = @id',
        )
        .get({ id: fromB64Url(itemId) }) as
        | {
            parent_id: Buffer | null;
            root_transaction_id: Buffer | null;
            data_offset: number | null;
          }
        | undefined;

      assert.notEqual(row, undefined, 'data item row should exist');
      assert.notEqual(
        row!.parent_id,
        null,
        'parent_id must survive optimistic re-POST',
      );
      assert.notEqual(
        row!.root_transaction_id,
        null,
        'root_transaction_id must survive optimistic re-POST',
      );
      assert.notEqual(
        row!.data_offset,
        null,
        'data_offset must survive optimistic re-POST',
      );
      assert.deepEqual(row!.parent_id, fromB64Url(bundleParentId));
      assert.deepEqual(row!.root_transaction_id, fromB64Url(bundleRootTxId));
      assert.equal(row!.data_offset, 100);

      // Now exercise the flush path that previously hit
      // SQLITE_CONSTRAINT_NOTNULL on stable_data_item_tags.parent_id
      // (Defect A). Force heights non-NULL on both the data item and
      // its tag rows, then make bundleRootTxId stable so the flush JOINs
      // match.
      const dataItemHeight = 100;
      bundlesDb
        .prepare('UPDATE new_data_items SET height = @h WHERE id = @id')
        .run({ h: dataItemHeight, id: fromB64Url(itemId) });
      bundlesDb
        .prepare(
          'UPDATE new_data_item_tags SET height = @h WHERE data_item_id = @id',
        )
        .run({ h: dataItemHeight, id: fromB64Url(itemId) });
      coreDb
        .prepare(
          `INSERT INTO stable_block_transactions (
             block_indep_hash, transaction_id, block_transaction_index
           ) VALUES (@hash, @tx, 0)`,
        )
        .run({
          hash: crypto.randomBytes(32),
          tx: fromB64Url(bundleRootTxId),
        });

      // Pre-fix this throws inside the worker transaction. With the fix
      // (back-fill preserved by COALESCE; flush guarded by IS NOT NULL),
      // it completes and the row lands in stable_data_items.
      await db.flushStableDataItems(dataItemHeight + 1, Date.now());

      const stableRow = bundlesDb
        .prepare('SELECT id FROM stable_data_items WHERE id = @id')
        .get({ id: fromB64Url(itemId) });
      assert.notEqual(
        stableRow,
        undefined,
        'data item should land in stable_data_items after flush',
      );
    });

    it('heals shadow-victim offset/size fields when unbundle follows an optimistic POST', async () => {
      // Regression for the residual half of PE-9073: pre-structural-fix
      // the upsert's UPDATE clause only covered parent_id /
      // root_transaction_id / data_offset / height. The remaining
      // root-atom fields (root_parent_offset, offset, size,
      // signature_offset, signature_size, owner_offset, owner_size,
      // signature_type) were INSERT-only — admin-first then unbundle
      // left them NULL on the existing row, which breaks GraphQL
      // signature/owner resolvers (RangeError on degenerate read range
      // from FsDataStore.get with size=0). Post-fix the unbundle path's
      // atomic root-atom upsert lands all eleven fields together.
      const shadowItemId = 'PE9073ShadowHealingPE9073ShadowHealingAAAAAA';

      const shadowOptimistic = {
        ...optimisticItem,
        id: shadowItemId,
      } as unknown as NormalizedDataItem;

      const shadowBackfill = {
        ...bundleBackfillItem,
        id: shadowItemId,
      } as unknown as NormalizedDataItem;

      // 1. Admin POST arrives first.
      await db.saveDataItem(shadowOptimistic, /* isOptimistic */ true);

      // 2. Unbundle follows with the full root atom.
      await db.saveDataItem(shadowBackfill);

      const row = bundlesDb
        .prepare(
          `SELECT parent_id, root_transaction_id, data_offset,
                  root_parent_offset, "offset", size,
                  signature_offset, signature_size,
                  owner_offset, owner_size, signature_type
           FROM new_data_items WHERE id = @id`,
        )
        .get({ id: fromB64Url(shadowItemId) }) as {
        parent_id: Buffer | null;
        root_transaction_id: Buffer | null;
        data_offset: number | null;
        root_parent_offset: number | null;
        offset: number | null;
        size: number | null;
        signature_offset: number | null;
        signature_size: number | null;
        owner_offset: number | null;
        owner_size: number | null;
        signature_type: number | null;
      };

      assert.notEqual(row, undefined, 'shadow-healed row should exist');
      // All eleven root-atom fields should be populated by the unbundle
      // upsert, not shadowed-NULL.
      assert.deepEqual(row.parent_id, fromB64Url(bundleParentId));
      assert.deepEqual(row.root_transaction_id, fromB64Url(bundleRootTxId));
      assert.equal(row.data_offset, 100);
      assert.equal(row.root_parent_offset, 300);
      assert.equal(row.offset, 200);
      assert.equal(row.size, 1234);
      assert.equal(row.signature_offset, 60);
      assert.equal(row.signature_size, 32);
      assert.equal(row.owner_offset, 50);
      assert.equal(row.owner_size, 32);
      assert.equal(row.signature_type, 1);
    });
  });

  // skipping for now as it works when running the test individually
  describe.skip('saveVerificationStatus', () => {
    const dataItemRootTxId = '0000000000000000000000000000000000000000000';
    const dataItem = {
      anchor: 'a',
      dataOffset: 10,
      dataSize: 1,
      id: DATA_ITEM_ID,
      offset: 10,
      owner: 'a',
      ownerOffset: 1,
      ownerSize: 1,
      sigName: 'a',
      signature: 'a',
      signatureOffset: 1,
      signatureSize: 1,
      signatureType: 1,
      size: 1,
      tags: [],
      target: 'a',
    };
    const normalizedDataItem = normalizeAns104DataItem({
      rootTxId: dataItemRootTxId,
      parentId: dataItemRootTxId,
      parentIndex: -1,
      index: 0,
      ans104DataItem: dataItem,
      filter: '',
      dataHash: '',
      rootParentOffset: 0,
    });
    const anotherDataItem = { ...normalizedDataItem };
    anotherDataItem.id = 'WxQdMByPoNZgUFDMbvtC5sB2OHv0LDVsRQZex7qrwUY';
    anotherDataItem.parent_id = '2222222222222222222222222222222222222222222';
    anotherDataItem.root_tx_id = '2222222222222222222222222222222222222222222';

    it('should set only bundled items as verified when bundle is set as verified', async () => {
      await db.saveDataContentAttributes({
        id: dataItemRootTxId,
        hash: 'hash',
        dataSize: 10,
      });

      await db.saveDataContentAttributes({
        id: normalizedDataItem.id,
        parentId: normalizedDataItem.parent_id ?? undefined,
        hash: 'hash',
        dataSize: 10,
      });

      await db.saveDataContentAttributes({
        id: anotherDataItem.id,
        parentId: anotherDataItem.parent_id ?? undefined,
        hash: 'hash',
        dataSize: 10,
      });

      await db.saveDataItem(normalizedDataItem);
      await db.saveDataItem(anotherDataItem);

      const sql = `
        SELECT * FROM contiguous_data_ids;
      `;
      const contiguousDataIds = dataDb
        .prepare(sql)
        .all()
        .map((row) => ({ id: toB64Url(row.id), verified: row.verified }));

      assert.equal(contiguousDataIds.length, 3);
      assert.equal(contiguousDataIds[0].id, dataItemRootTxId);
      assert.equal(contiguousDataIds[0].verified, 0);
      assert.equal(contiguousDataIds[1].id, normalizedDataItem.id);
      assert.equal(contiguousDataIds[1].verified, 0);
      assert.equal(contiguousDataIds[2].id, anotherDataItem.id);
      assert.equal(contiguousDataIds[2].verified, 0);

      await db.saveVerificationStatus(dataItemRootTxId);

      const contiguousDataIdsUpdated = dataDb
        .prepare(sql)
        .all()
        .map((row) => ({ id: toB64Url(row.id), verified: row.verified }));

      assert.equal(contiguousDataIdsUpdated.length, 3);
      assert.equal(contiguousDataIdsUpdated[0].id, dataItemRootTxId);
      assert.equal(contiguousDataIdsUpdated[0].verified, 1);
      assert.equal(contiguousDataIdsUpdated[1].id, normalizedDataItem.id);
      assert.equal(contiguousDataIdsUpdated[1].verified, 1);
      assert.equal(contiguousDataIdsUpdated[2].id, anotherDataItem.id);
      assert.equal(contiguousDataIdsUpdated[2].verified, 0);
    });
  });

  describe('cleanupWal', () => {
    it('should not throw an error when called for each database', async () => {
      const dbNames: ('core' | 'bundles' | 'data' | 'moderation')[] = [
        'core',
        'bundles',
        'data',
        'moderation',
      ];

      for (const dbName of dbNames) {
        await assert.doesNotReject(async () => {
          await db.cleanupWal(dbName);
        });
      }
    });
  });
});
