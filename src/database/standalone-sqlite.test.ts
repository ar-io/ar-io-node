/**
 * AR.IO Gateway
 * Copyright (C) 2022 Permanent Data Solutions, Inc
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
import { ValidationError } from 'apollo-server-express';
import { expect } from 'chai';
import crypto from 'node:crypto';
import fs from 'node:fs';

import {
  StandaloneSqliteDatabase,
  StandaloneSqliteDatabaseWorker,
  decodeBlockGqlCursor,
  decodeTransactionGqlCursor,
  encodeBlockGqlCursor,
  encodeTransactionGqlCursor,
  toSqliteParams,
} from '../../src/database/standalone-sqlite.js';
import { fromB64Url, toB64Url } from '../../src/lib/encoding.js';
import {
  coreDb,
  coreDbPath,
  dataDbPath,
  moderationDbPath,
} from '../../test/sqlite-helpers.js';
import { ArweaveChainSourceStub } from '../../test/stubs.js';
import log from '../log.js';

const HEIGHT = 1138;
const BLOCK_TX_INDEX = 42;

describe('SQLite helper functions', () => {
  describe('toSqliteParams', () => {
    it('should convert SQL Bricks param values to better-sqlite3 params', () => {
      expect(toSqliteParams({ values: [820389, 820389] })).to.deep.equal({
        '1': 820389,
        '2': 820389,
      });
    });
  });
});

describe('SQLite GraphQL cursor functions', () => {
  describe('encodeTransactionGqlCursor', () => {
    it('should encode a cursor given a height and blockTransactionIndex', () => {
      expect(
        encodeTransactionGqlCursor({
          height: HEIGHT,
          blockTransactionIndex: BLOCK_TX_INDEX,
        }),
      ).to.equal('WzExMzgsNDJd');
    });
  });

  describe('decodeTransactionGqlCursor', () => {
    it('should decode a height and blockTransactionIndex given an encoded cursor', () => {
      expect(decodeTransactionGqlCursor('WzExMzgsNDJd')).to.deep.equal({
        height: HEIGHT,
        blockTransactionIndex: BLOCK_TX_INDEX,
      });
    });

    it('should return an undefined height and blockTransactionIndex given an undefined cursor', () => {
      expect(decodeTransactionGqlCursor(undefined)).to.deep.equal({
        height: undefined,
        blockTransactionIndex: undefined,
      });
    });

    it('should throw an error given an invalid cursor', async () => {
      expect(() => {
        decodeTransactionGqlCursor('123');
      }).to.throw(ValidationError, 'Invalid transaction cursor');
    });
  });

  describe('encodeBlockGqlCursor', () => {
    it('should encode a cursor given a height', () => {
      expect(
        encodeBlockGqlCursor({
          height: HEIGHT,
        }),
      ).to.equal('WzExMzhd');
    });
  });

  describe('decodeBlockGqlCursor', () => {
    it('should decode a height given an encoded cursor', () => {
      expect(decodeBlockGqlCursor('WzExMzhd')).to.deep.equal({
        height: HEIGHT,
      });
    });

    it('should return an undefined height given an undefined cursor', () => {
      expect(decodeBlockGqlCursor(undefined)).to.deep.equal({
        height: undefined,
      });
    });

    it('should throw an error given an invalid cursor', async () => {
      expect(() => {
        decodeBlockGqlCursor('123');
      }).to.throw(ValidationError, 'Invalid block cursor');
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
    });
    dbWorker = new StandaloneSqliteDatabaseWorker({
      coreDbPath,
      dataDbPath,
      moderationDbPath,
    });
    chainSource = new ArweaveChainSourceStub();
  });

  after(async () => {
    db.stop();
  });

  describe('saveBlockAndTxs', () => {
    it('should insert the block in the new_blocks table', async () => {
      const height = 982575;

      const { block, txs, missingTxIds } =
        await chainSource.getBlockAndTxsByHeight(height);

      await db.saveBlockAndTxs(block, txs, missingTxIds);

      const stats = await db.getDebugInfo();
      expect(stats.counts.newBlocks).to.equal(1);

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
        expect(dbBlock[field]).to.be.an.instanceof(Buffer);
        expect(toB64Url(dbBlock[field])).to.equal((block as any)[field]);
      }

      const stringFields = ['diff', 'cumulative_diff'];
      for (const field of stringFields) {
        expect(dbBlock[field]).to.be.a('string');
        expect(dbBlock[field]).to.equal((block as any)[field]);
      }

      // Note: 'timestamp' is renamed to 'block_timestamp' to avoid collision
      // with the SQLite timestamp data type
      expect(dbBlock.block_timestamp).to.be.a('number');
      expect(dbBlock.block_timestamp).to.equal(block.timestamp);

      const integerFields = ['height', 'last_retarget'];
      for (const field of integerFields) {
        expect(dbBlock[field]).to.be.a('number');
        expect(dbBlock[field]).to.equal((block as any)[field]);
      }

      // These fields are strings in JSON blocks but 64 bit integers in SQLite
      const stringIntegerFields = ['block_size', 'weave_size'];
      for (const field of stringIntegerFields) {
        expect(dbBlock[field]).to.be.a('number');
        expect((block as any)[field]).to.be.a('string');
        expect(dbBlock[field].toString()).to.equal((block as any)[field]);
      }

      expect(dbBlock.usd_to_ar_rate_dividend).to.be.a('number');
      expect((block.usd_to_ar_rate ?? [])[0]).to.be.a('string');
      expect(dbBlock.usd_to_ar_rate_dividend.toString()).to.equal(
        (block.usd_to_ar_rate ?? [])[0],
      );
      expect(dbBlock.usd_to_ar_rate_divisor).to.be.a('number');
      expect((block.usd_to_ar_rate ?? [])[1]).to.be.a('string');
      expect(dbBlock.usd_to_ar_rate_divisor.toString()).to.equal(
        (block.usd_to_ar_rate ?? [])[1],
      );
      expect(dbBlock.scheduled_usd_to_ar_rate_dividend).to.be.a('number');
      expect((block.scheduled_usd_to_ar_rate ?? [])[0]).to.be.a('string');
      expect(dbBlock.scheduled_usd_to_ar_rate_dividend.toString()).to.equal(
        (block.scheduled_usd_to_ar_rate ?? [])[0],
      );
      expect(dbBlock.scheduled_usd_to_ar_rate_divisor).to.be.a('number');
      expect((block.scheduled_usd_to_ar_rate ?? [])[1]).to.be.a('string');
      expect(dbBlock.scheduled_usd_to_ar_rate_divisor.toString()).to.equal(
        (block.scheduled_usd_to_ar_rate ?? [])[1],
      );
    });

    it('should save the block transactions in the new_transactions table', async () => {
      const height = 982575;

      const { block, txs, missingTxIds } =
        await chainSource.getBlockAndTxsByHeight(height);

      await db.saveBlockAndTxs(block, txs, missingTxIds);

      const stats = await db.getDebugInfo();
      expect(stats.counts.newTxs).to.equal(txs.length);

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
        expect(dbTransactions[i].owner_address).to.deep.equal(ownerAddress);

        const binaryFields = [
          'id',
          'signature',
          'last_tx',
          'owner',
          'target',
          'data_root',
        ];

        for (const field of binaryFields) {
          expect(dbTransactions[i][field]).to.be.an.instanceof(Buffer);
          expect(toB64Url(dbTransactions[i][field])).to.equal(
            (tx as any)[field],
          );
        }

        const stringFields = ['quantity', 'reward'];
        for (const field of stringFields) {
          expect(dbTransactions[i][field]).to.be.a('string');
          expect(dbTransactions[i][field]).to.equal((tx as any)[field]);
        }

        const integerFields = ['format'];
        for (const field of integerFields) {
          expect(dbTransactions[i][field]).to.be.a('number');
          expect(dbTransactions[i][field]).to.equal((tx as any)[field]);
        }

        const stringIntegerFields = ['data_size'];
        for (const field of stringIntegerFields) {
          expect(dbTransactions[i][field]).to.be.a('number');
          expect((tx as any)[field]).to.be.a('string');
          expect(dbTransactions[i][field].toString()).to.equal(
            (tx as any)[field],
          );
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

        expect(dbTags.length).to.equal(tx.tags.length);

        tx.tags.forEach((tag: any, j: number) => {
          expect(dbTags[j].tag_name_hash).to.deep.equal(
            crypto.createHash('sha1').update(fromB64Url(tag.name)).digest(),
          );
          expect(dbTags[j].tag_value_hash).to.deep.equal(
            crypto.createHash('sha1').update(fromB64Url(tag.value)).digest(),
          );
          expect(toB64Url(dbTags[j].name)).to.equal(tag.name);
          expect(toB64Url(dbTags[j].value)).to.equal(tag.value);
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

      expect(dbMissingTxs.length).to.equal(missingTxs.length);

      missingTxs.forEach((missingTx, i) => {
        expect(dbMissingTxs[i].block_indep_hash).to.deep.equal(
          fromB64Url(missingTx.block_indep_hash),
        );
        expect(dbMissingTxs[i].transaction_id).to.deep.equal(
          fromB64Url(missingTx.transaction_id),
        );
        expect(dbMissingTxs[i].height).to.equal(missingTx.height);
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
      expect(stats.counts.stableBlocks).to.equal(149);
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
            'fxxFMvVrp8oOgBEjDr0WuI2PpVny1mJiq9S551y0Y5T-H7B4JKhc-gNkKz8zJ7oR',
          transaction_id: 'glHacTmLlPSw55wUOU-MMaknJjWWHBLN16U8f3YuOd4',
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

      expect(dbStableBlockTransactions.length).to.equal(
        stableBlockTransactions.length,
      );

      stableBlockTransactions.forEach((stableBlockTransaction, i) => {
        expect(dbStableBlockTransactions[i].block_indep_hash).to.deep.equal(
          fromB64Url(stableBlockTransaction.block_indep_hash),
        );
        expect(dbStableBlockTransactions[i].transaction_id).to.deep.equal(
          fromB64Url(stableBlockTransaction.transaction_id),
        );
        expect(dbStableBlockTransactions[i].block_transaction_index).to.equal(
          stableBlockTransaction.block_transaction_index,
        );
      });
    });

    it('should copy all the block fields to the stable_blocks table', async () => {
      const height = 982575;

      const { block, txs, missingTxIds } =
        await chainSource.getBlockAndTxsByHeight(height);

      await db.saveBlockAndTxs(block, txs, missingTxIds);
      dbWorker.saveStableDataFn(height + 1);

      const stats = await db.getDebugInfo();
      expect(stats.counts.stableBlocks).to.equal(1);

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
        expect(dbBlock[field]).to.be.an.instanceof(Buffer);
        expect(toB64Url(dbBlock[field])).to.equal((block as any)[field]);
      }

      const stringFields = ['diff', 'cumulative_diff'];
      for (const field of stringFields) {
        expect(dbBlock[field]).to.be.a('string');
        expect(dbBlock[field]).to.equal((block as any)[field]);
      }

      // Note: 'timestamp' is renamed to 'block_timestamp' to avoid collision
      // with the SQLite timestamp data type
      expect(dbBlock.block_timestamp).to.be.a('number');
      expect(dbBlock.block_timestamp).to.equal(block.timestamp);

      const integerFields = ['height', 'last_retarget'];
      for (const field of integerFields) {
        expect(dbBlock[field]).to.be.a('number');
        expect(dbBlock[field]).to.equal((block as any)[field]);
      }

      // These fields are strings in JSON blocks but 64 bit integers in SQLite
      const stringIntegerFields = ['block_size', 'weave_size'];
      for (const field of stringIntegerFields) {
        expect(dbBlock[field]).to.be.a('number');
        expect((block as any)[field]).to.be.a('string');
        expect(dbBlock[field].toString()).to.equal((block as any)[field]);
      }

      expect(dbBlock.usd_to_ar_rate_dividend).to.be.a('number');
      expect((block.usd_to_ar_rate ?? [])[0]).to.be.a('string');
      expect(dbBlock.usd_to_ar_rate_dividend.toString()).to.equal(
        (block.usd_to_ar_rate ?? [])[0],
      );
      expect(dbBlock.usd_to_ar_rate_divisor).to.be.a('number');
      expect((block.usd_to_ar_rate ?? [])[1]).to.be.a('string');
      expect(dbBlock.usd_to_ar_rate_divisor.toString()).to.equal(
        (block.usd_to_ar_rate ?? [])[1],
      );
      expect(dbBlock.scheduled_usd_to_ar_rate_dividend).to.be.a('number');
      expect((block.scheduled_usd_to_ar_rate ?? [])[0]).to.be.a('string');
      expect(dbBlock.scheduled_usd_to_ar_rate_dividend.toString()).to.equal(
        (block.scheduled_usd_to_ar_rate ?? [])[0],
      );
      expect(dbBlock.scheduled_usd_to_ar_rate_divisor).to.be.a('number');
      expect((block.scheduled_usd_to_ar_rate ?? [])[1]).to.be.a('string');
      expect(dbBlock.scheduled_usd_to_ar_rate_divisor.toString()).to.equal(
        (block.scheduled_usd_to_ar_rate ?? [])[1],
      );
    });

    it('should copy all the transaction fields to the stable_transactions table', async () => {
      const height = 982575;

      const { block, txs, missingTxIds } =
        await chainSource.getBlockAndTxsByHeight(height);

      await db.saveBlockAndTxs(block, txs, missingTxIds);

      const stats = await db.getDebugInfo();
      expect(stats.counts.newTxs).to.equal(txs.length);

      await db.saveBlockAndTxs(block, txs, missingTxIds);
      dbWorker.saveStableDataFn(height + 1);

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
        expect(dbTransactions[i].owner_address).to.deep.equal(ownerAddress);

        const binaryFields = [
          'id',
          'signature',
          'last_tx',
          'owner',
          'target',
          'data_root',
        ];

        for (const field of binaryFields) {
          expect(dbTransactions[i][field]).to.be.an.instanceof(Buffer);
          expect(toB64Url(dbTransactions[i][field])).to.equal(
            (tx as any)[field],
          );
        }

        const stringFields = ['quantity', 'reward'];
        for (const field of stringFields) {
          expect(dbTransactions[i][field]).to.be.a('string');
          expect(dbTransactions[i][field]).to.equal((tx as any)[field]);
        }

        const integerFields = ['format'];
        for (const field of integerFields) {
          expect(dbTransactions[i][field]).to.be.a('number');
          expect(dbTransactions[i][field]).to.equal((tx as any)[field]);
        }

        const stringIntegerFields = ['data_size'];
        for (const field of stringIntegerFields) {
          expect(dbTransactions[i][field]).to.be.a('number');
          expect((tx as any)[field]).to.be.a('string');
          expect(dbTransactions[i][field].toString()).to.equal(
            (tx as any)[field],
          );
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

        expect(dbTags.length).to.equal(tx.tags.length);

        tx.tags.forEach((tag: any, j: number) => {
          expect(dbTags[j].tag_name_hash).to.deep.equal(
            crypto.createHash('sha1').update(fromB64Url(tag.name)).digest(),
          );
          expect(dbTags[j].tag_value_hash).to.deep.equal(
            crypto.createHash('sha1').update(fromB64Url(tag.value)).digest(),
          );
          expect(toB64Url(dbTags[j].name)).to.equal(tag.name);
          expect(toB64Url(dbTags[j].value)).to.equal(tag.value);
        });
      });
    });

    it('should copy all the owner fields to the stable_transactions table', async () => {
      const height = 34;

      const { block, txs, missingTxIds } =
        await chainSource.getBlockAndTxsByHeight(height);

      await db.saveBlockAndTxs(block, txs, missingTxIds);

      const stats = await db.getDebugInfo();
      expect(stats.counts.newTxs).to.equal(txs.length);

      await db.saveBlockAndTxs(block, txs, missingTxIds);
      dbWorker.saveStableDataFn(height + 1);

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
        expect(dbTransactions[i].owner_address).to.deep.equal(ownerAddress);

        const binaryFields = [
          'id',
          'signature',
          'last_tx',
          'owner',
          'target',
          'data_root',
        ];

        for (const field of binaryFields) {
          expect(dbTransactions[i][field]).to.be.an.instanceof(Buffer);
          expect(toB64Url(dbTransactions[i][field])).to.equal(
            (tx as any)[field],
          );
        }

        const stringFields = ['quantity', 'reward'];
        for (const field of stringFields) {
          expect(dbTransactions[i][field]).to.be.a('string');
          expect(dbTransactions[i][field]).to.equal((tx as any)[field]);
        }

        const integerFields = ['format'];
        for (const field of integerFields) {
          expect(dbTransactions[i][field]).to.be.a('number');
          expect(dbTransactions[i][field]).to.equal((tx as any)[field]);
        }

        const stringIntegerFields = ['data_size'];
        for (const field of stringIntegerFields) {
          expect(dbTransactions[i][field]).to.be.a('number');
          expect((tx as any)[field]).to.be.a('string');
          expect(dbTransactions[i][field].toString()).to.equal(
            (tx as any)[field],
          );
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

        expect(dbTags.length).to.equal(tx.tags.length);

        tx.tags.forEach((tag: any, j: number) => {
          expect(dbTags[j].tag_name_hash).to.deep.equal(
            crypto.createHash('sha1').update(fromB64Url(tag.name)).digest(),
          );
          expect(dbTags[j].tag_value_hash).to.deep.equal(
            crypto.createHash('sha1').update(fromB64Url(tag.value)).digest(),
          );
          expect(toB64Url(dbTags[j].name)).to.equal(tag.name);
          expect(toB64Url(dbTags[j].value)).to.equal(tag.value);
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

      expect(
        coreDb.prepare(sql).get({ transaction_id: fromB64Url(txId) }).cnt,
      ).to.be.equal(1);
    });

    it('should insert into tag_names', async () => {
      const sql = `
        SELECT COUNT(*) AS cnt
        FROM tag_names
      `;

      expect(coreDb.prepare(sql).get().cnt).to.be.equal(12);
    });

    it('should insert into tag_values', async () => {
      const sql = `
        SELECT COUNT(*) AS cnt
        FROM tag_values
      `;

      expect(coreDb.prepare(sql).get().cnt).to.be.equal(12);
    });

    it('should insert into new_transaction_tags', async () => {
      const sql = `
        SELECT COUNT(*) AS cnt
        FROM new_transaction_tags
      `;

      expect(coreDb.prepare(sql).get().cnt).to.be.equal(12);
    });

    it('should insert into wallets', async () => {
      const sql = `
        SELECT COUNT(*) AS cnt
        FROM wallets
      `;

      expect(coreDb.prepare(sql).get().cnt).to.be.equal(1);
    });
  });
});
