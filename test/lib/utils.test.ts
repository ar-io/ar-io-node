import { expect } from 'chai';
import { createHash } from 'crypto';
import { fromB64Url, sha256B64Url, toB64url } from '../../src/lib/utils.js';

describe('fromB64Url', () => {
  it('should convert string to base64 buffer', () => {
    const str = 'test';
    const result = fromB64Url(str);
    const expected = Buffer.from(str, 'base64');
    expect(result).to.deep.equal(expected);
  });
});

describe('toB64url', () => {
  it('should convert buffer to base64url string', () => {
    const str = Buffer.from('test', 'base64');
    const result = toB64url(str);
    const expected = str.toString('base64url');
    expect(result).to.equal(expected);
  });
  it('should properly handle padding', () => {
    const str = 'test';
    const buf = Buffer.from(str, 'base64');
    const paddedBuffer = Buffer.concat([buf], 32);
    const result = toB64url(paddedBuffer);
    const expected = paddedBuffer.toString('base64url');
    expect(result).to.deep.equal(expected);
  });
});

describe('sha256B64Url', () => {
  it('should convert buffer to sha256 string', () => {
    const str = Buffer.from('test', 'base64');
    const result = sha256B64Url(str);
    const expected = createHash('sha256')
      .update(str)
      .digest()
      .toString('base64url');
    expect(result).to.equal(expected);
  });
});
