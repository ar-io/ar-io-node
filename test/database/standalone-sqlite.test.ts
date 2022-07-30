import { expect } from 'chai';
import { ValidationError } from 'apollo-server-express';
import {
  encodeTransactionGqlCursor,
  decodeTransactionGqlCursor,
  encodeBlockGqlCursor,
  decodeBlockGqlCursor,
  toSqliteParams,
  StandaloneSqliteDatabase
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
        blockTransactionIndex: BLOCK_TX_INDEX
      })
    ).to.equal('WzExMzgsNDJd');
  });
});

describe('decodeTransactionGqlCursor', () => {
  it('should decode a height and blockTransactionIndex given an encoded cursor', () => {
    expect(decodeTransactionGqlCursor('WzExMzgsNDJd')).to.deep.equal({
      height: HEIGHT,
      blockTransactionIndex: BLOCK_TX_INDEX
    });
  });

  it('should return an undefined height and blockTransactionIndex given an undefined cursor', () => {
    expect(decodeTransactionGqlCursor(undefined)).to.deep.equal({
      height: undefined,
      blockTransactionIndex: undefined
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
        height: HEIGHT
      })
    ).to.equal('WzExMzhd');
  });
});

describe('decodeBlockGqlCursor', () => {
  it('should decode a height given an encoded cursor', () => {
    expect(decodeBlockGqlCursor('WzExMzhd')).to.deep.equal({
      height: HEIGHT
    });
  });

  it('should return an undefined height given an undefined cursor', () => {
    expect(decodeBlockGqlCursor(undefined)).to.deep.equal({
      height: undefined
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
      '2': 820389
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
    it('should save a block and its transactions', async () => {
      const { block, txs, missingTxIds } =
        await chainSource.getBlockAndTxsByHeight(982575);
      await chainDb.saveBlockAndTxs(block, txs, missingTxIds);

      const dbBlock = db
        .prepare('SELECT * FROM new_blocks WHERE height = 982575')
        .get();

      expect(toB64Url(dbBlock.indep_hash)).to.deep.equal(block.indep_hash);
      expect(dbBlock.height).to.equal(982575);
      expect(toB64Url(dbBlock.previous_block)).to.deep.equal(
        block.previous_block
      );
      expect(toB64Url(dbBlock.nonce)).to.equal(block.nonce);
      expect(toB64Url(dbBlock.hash)).to.equal(block.hash);
      expect(dbBlock.block_timestamp).to.equal(block.timestamp);
      expect(dbBlock.diff).to.equal(block.diff);
      expect(dbBlock.cumulative_diff).to.equal(block.cumulative_diff);
      expect(dbBlock.last_retarget).to.equal(block.last_retarget);
      expect(toB64Url(dbBlock.reward_addr)).to.equal(block.reward_addr);
      expect(dbBlock.block_size.toString()).to.equal(block.block_size);
      expect(dbBlock.weave_size.toString()).to.equal(block.weave_size);
      // TODO fix stored rates
      expect(toB64Url(dbBlock.hash_list_merkle)).to.equal(
        block.hash_list_merkle
      );
      expect(toB64Url(dbBlock.wallet_list)).to.equal(block.wallet_list);
      expect(toB64Url(dbBlock.tx_root)).to.equal(block.tx_root);
      expect(dbBlock.tx_count).to.equal(txs.length);
      expect(dbBlock.missing_tx_count).to.equal(0);

      const stats = await chainDb.getDebugInfo();
      expect(stats.counts.newBlocks).to.equal(1);
      expect(stats.counts.newTxs).to.equal(txs.length);
    });
  });
});
