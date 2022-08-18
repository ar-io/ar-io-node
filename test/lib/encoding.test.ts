import { expect } from 'chai';
import msgpack from 'msgpack-lite';

import {
  b64UrlToUtf8,
  fromB64Url,
  fromMsgpack,
  jsonTxToMsgpack,
  jsonTxToMsgpackTx,
  msgpackToJsonTx,
  msgpackTxToJsonTx,
  sha256B64Url,
  toB64Url,
  toMsgpack,
  utf8ToB64Url,
} from '../../src/lib/encoding.js';
import { ArweaveChainSourceStub } from '../stubs.js';

const TEST_STRING = 'http://test.com';
const TEST_BASE_64_URL_ENCODED_STRING = 'aHR0cDovL3Rlc3QuY29t';
const TEST_BASE_64_BUFFER = Buffer.from(TEST_STRING);
const TEST_BASE_64_BUFFER_WITH_PADDING = Buffer.from(
  TEST_STRING.padStart(10).padEnd(10),
);
const TEST_BASE_64_SHA_256_STRING =
  'i0CKDHFj_f_wbO0-gNfSs6zZ25AJBcR4PCgpW4yZYWU';

describe('Base64 URL encoding functions', () => {
  describe('fromB64Url', () => {
    it('should convert a base64 url encoded string to buffer', () => {
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

describe('Message pack encoding and decoding functions', () => {
  describe('toMsgpack and fromMsgpack', () => {
    it('should round trip to and from MessagePack', () => {
      const testObject = {
        test: 'test',
        test2: [1, 2, 3],
      };

      const testBuffer = toMsgpack(testObject);
      const testObject2 = fromMsgpack(testBuffer);

      expect(testObject2).to.deep.equal(testObject);
    });

    it("should preserve compatibility with 'standard' Message Pack", () => {
      const testObject = {
        test: 'test',
        test2: [1, 2, 3],
      };

      const testBuffer = toMsgpack(testObject);
      const testObject2 = msgpack.decode(testBuffer);

      expect(testObject2).to.deep.equal(testObject);

      const testBuffer2 = msgpack.encode(testObject);
      const testObject3 = fromMsgpack(testBuffer2);

      expect(testObject3).to.deep.equal(testObject);
    });
  });
});

describe('Transaction message pack encoding and decoding functions', () => {
  describe('jsonTxToMsgpackTx and msgpackTxToJsonTx', () => {
    it('should round trip to and from a MsgpackTransaction', async () => {
      // TODO add transactions with more fields

      const chainSource = new ArweaveChainSourceStub();
      const tx = await chainSource.getTx(
        'cK9WF2XMwFj5TF1uhaCSdrA2mVoaxAz20HkDyQhq0i0',
      );

      // Remove extranious header fields
      delete (tx as any).data;
      delete (tx as any).data_tree;

      const msgpackTx = jsonTxToMsgpackTx(tx);
      const jsonTx = msgpackTxToJsonTx(msgpackTx);

      expect(jsonTx).to.deep.equal(tx);
    });
  });

  describe('jsonTxToMsgpack and msgpackToJsonTx', () => {
    it('should round trip to and from a MessagePack', async () => {
      // TODO add transactions with more fields

      const chainSource = new ArweaveChainSourceStub();
      const tx = await chainSource.getTx(
        'cK9WF2XMwFj5TF1uhaCSdrA2mVoaxAz20HkDyQhq0i0',
      );

      // Remove extranious header fields
      delete (tx as any).data;
      delete (tx as any).data_tree;

      const buffer = jsonTxToMsgpack(tx);
      const jsonTx = msgpackToJsonTx(buffer);

      expect(jsonTx).to.deep.equal(tx);
    });
  });
});