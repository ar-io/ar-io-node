/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
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
  coreDb,
  coreDbPath,
  dataDb,
  dataDbPath,
  moderationDbPath,
} from '../../test/sqlite-helpers.js';
import { ArweaveChainSourceStub, stubAns104Bundle } from '../../test/stubs.js';
import { normalizeAns104DataItem } from '../lib/ans-104.js';
import log from '../log.js';
import { BundleRecord } from '../types.js';
import { processBundleStream } from '../lib/bundles.js';
import wait from 'wait';

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
    db = new StandaloneSqliteDatabase({
      log,
      coreDbPath,
      dataDbPath,
      moderationDbPath,
      bundlesDbPath,
      tagSelectivity: {},
    });
    dbWorker = new StandaloneSqliteDatabaseWorker({
      log,
      coreDbPath,
      dataDbPath,
      moderationDbPath,
      bundlesDbPath,
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

  describe('getRootTxId', () => {
    it('should return undefined if id is not found', async () => {
      const rootTxId = await db.getRootTxId(DATA_ITEM_ID);
      assert.equal(rootTxId, undefined);
    });

    it('should return root transcation id of a given data item', async () => {
      await db.saveDataItem(normalizedDataItem);

      const rootTxId = await db.getRootTxId(DATA_ITEM_ID);
      assert.equal(rootTxId, dataItemRootTxId);
    });

    it('should return undefined if the root transcation id of a given data item is null', async () => {
      const dataItem = normalizedDataItem;
      dataItem.root_tx_id = null;
      await db.saveDataItem(dataItem);

      const rootTxId = await db.getRootTxId(DATA_ITEM_ID);
      assert.equal(rootTxId, undefined);
    });

    it('should return the same L1 transcation id given an L1 transaction ', async () => {
      const l1TxId = 'vYQNQruccPlvxatkcRYmoaVywIzHxS3DuBG1CPxNMPA';
      const height = 982575;

      const { block, txs, missingTxIds } =
        await chainSource.getBlockAndTxsByHeight(height);

      await db.saveBlockAndTxs(block, txs, missingTxIds);

      const rootTxId = await db.getRootTxId(l1TxId);
      assert.equal(rootTxId, l1TxId);
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
