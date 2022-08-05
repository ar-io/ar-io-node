import { expect } from 'chai';
import { ValidationError } from 'apollo-server-express';
import {
  encodeTransactionGqlCursor,
  decodeTransactionGqlCursor,
  encodeBlockGqlCursor,
  decodeBlockGqlCursor,
  toSqliteParams,
  StandaloneSqliteDatabase,
} from '../../src/database/standalone-sqlite.js';
import Sqlite from 'better-sqlite3';
import fs from 'fs';
import { ArweaveChainSourceStub } from '../stubs.js';
import { toB64Url } from '../../src/lib/utils.js';

const HEIGHT = 1138;
const BLOCK_TX_INDEX = 42;

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

describe('toSqliteParams', () => {
  it('should convert SQL Bricks param values to better-sqlite3 params', () => {
    expect(toSqliteParams({ values: [820389, 820389] })).to.deep.equal({
      '1': 820389,
      '2': 820389,
    });
  });
});

describe('StandaloneSqliteDatabase', () => {
  let db: Sqlite.Database;
  let chainSource: ArweaveChainSourceStub;
  let chainDb: StandaloneSqliteDatabase;

  beforeEach(async () => {
    db = new Sqlite(':memory:');
    const schema = fs.readFileSync('schema.sql', 'utf8');
    db.exec(schema);
    chainDb = new StandaloneSqliteDatabase(db);
    chainSource = new ArweaveChainSourceStub();
  });

  describe('saveBlockAndTxs', () => {
    it('should save the block in the new_blocks table', async () => {
      const height = 982575;

      const { block, txs, missingTxIds } =
        await chainSource.getBlockAndTxsByHeight(height);

      await chainDb.saveBlockAndTxs(block, txs, missingTxIds);

      const dbBlock = db
        .prepare(`SELECT * FROM new_blocks WHERE height = ${height}`)
        .get();

      expect(dbBlock.height).to.equal(height);

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

      // Note: timestamp is renamed to block_timestamp to avoid collision with
      // the SQLite timestamp data type
      expect(dbBlock.block_timestamp).to.be.a('number');
      expect(dbBlock.block_timestamp).to.equal(block.timestamp);

      const integerFields = ['last_retarget'];
      for (const field of integerFields) {
        expect(dbBlock[field]).to.be.a('number');
        expect(dbBlock[field]).to.equal((block as any)[field]);
      }

      // These fields are strings in JSON blocks but 64 bit integers in SQLite
      // const stringIntegerFields = ['block_size', 'weave_size'];
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

      expect(dbBlock.tx_count).to.equal(block.txs.length);
      expect(dbBlock.missing_tx_count).to.equal(0);

      const stats = await chainDb.getDebugInfo();
      expect(stats.counts.newBlocks).to.equal(1);
      expect(stats.counts.newTxs).to.equal(txs.length);
    });
  });
});
