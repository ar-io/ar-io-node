import { expect } from 'chai';
import {
  fromB64Url,
  sha256B64Url,
  toB64Url,
  b64UrlToUtf8,
  utf8ToB64Url,
} from '../../src/lib/encoding.js';

const TEST_STRING = 'http://test.com';
const TEST_BASE_64_URL_ENCODED_STRING = 'aHR0cDovL3Rlc3QuY29t';
const TEST_BASE_64_BUFFER = Buffer.from(TEST_STRING);
const TEST_BASE_64_BUFFER_WITH_PADDING = Buffer.from(
  TEST_STRING.padStart(10).padEnd(10),
);
const TEST_BASE_64_SHA_256_STRING =
  'i0CKDHFj_f_wbO0-gNfSs6zZ25AJBcR4PCgpW4yZYWU';

describe('Encoding functions', () => {
  describe('fromB64Url', () => {
    it('should convert base64 url encoded string to buffer', () => {
      expect(fromB64Url(TEST_BASE_64_URL_ENCODED_STRING)).to.deep.equal(
        TEST_BASE_64_BUFFER,
      );
    });
  });

  describe('toB64Url', () => {
    it('should convert a buffer to a base64url encoded string', () => {
      expect(toB64Url(TEST_BASE_64_BUFFER)).to.equal(
        TEST_BASE_64_URL_ENCODED_STRING,
      );
    });

    it('should convert a buffer with padding to base64 url encoded string', () => {
      expect(toB64Url(TEST_BASE_64_BUFFER_WITH_PADDING)).to.deep.equal(
        TEST_BASE_64_URL_ENCODED_STRING,
      );
    });
  });

  describe('sha256B64Url', () => {
    it('should convert a buffer to a base 64 url encoded sha256 string', () => {
      expect(sha256B64Url(TEST_BASE_64_BUFFER)).to.deep.equal(
        TEST_BASE_64_SHA_256_STRING,
      );
    });
  });

  describe('utf8ToB64Url', () => {
    it('should convet a utf8 string to a base64 url encoded string', () => {
      expect(utf8ToB64Url(TEST_STRING)).to.deep.equal(
        TEST_BASE_64_URL_ENCODED_STRING,
      );
    });
  });

  describe('b64UrlToUtf8', () => {
    it('should convert a base64 url encoded string to utf8', () => {
      expect(b64UrlToUtf8(TEST_BASE_64_URL_ENCODED_STRING)).to.deep.equal(
        TEST_STRING,
      );
    });
  });
});
