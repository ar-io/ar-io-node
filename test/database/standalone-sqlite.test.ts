import { expect } from 'chai';
import { ValidationError } from 'apollo-server-express';
import {
  encodeTransactionGqlCursor,
  decodeTransactionGqlCursor,
  encodeBlockGqlCursor,
  decodeBlockGqlCursor,
  toSqliteParams
} from '../../src/database/standalone-sqlite.js';

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
