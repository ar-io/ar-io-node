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
import { expect } from 'chai';
import msgpack from 'msgpack-lite';

import {
  b64UrlToUtf8,
  fromB64Url,
  fromMsgpack,
  jsonBlockToMsgpack,
  jsonBlockToMsgpackBlock,
  jsonTxToMsgpack,
  jsonTxToMsgpackTx,
  msgpackBlockToJsonBlock,
  msgpackToJsonBlock,
  msgpackToJsonTx,
  msgpackTxToJsonTx,
  resolveManifestStreamPath,
  sha256B64Url,
  toB64Url,
  toMsgpack,
  utf8ToB64Url,
} from '../../src/lib/encoding.js';
import {
  ArweaveChainSourceStub,
  exampleManifestStream,
} from '../../test/stubs.js';

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
    it('should convert a Base64 URL encoded string to a Buffer', () => {
      expect(fromB64Url(TEST_BASE_64_URL_ENCODED_STRING)).to.deep.equal(
        TEST_BASE_64_BUFFER,
      );
    });
  });

  describe('toB64Url', () => {
    it('should convert a Buffer to a Base64 URL encoded string', () => {
      expect(toB64Url(TEST_BASE_64_BUFFER)).to.equal(
        TEST_BASE_64_URL_ENCODED_STRING,
      );
    });

    it('should convert a Buffer with padding to Base64 URL encoded string', () => {
      expect(toB64Url(TEST_BASE_64_BUFFER_WITH_PADDING)).to.deep.equal(
        TEST_BASE_64_URL_ENCODED_STRING,
      );
    });
  });

  describe('sha256B64Url', () => {
    it('should convert a Buffer to a Base64 URL encoded SHA256 string', () => {
      expect(sha256B64Url(TEST_BASE_64_BUFFER)).to.deep.equal(
        TEST_BASE_64_SHA_256_STRING,
      );
    });
  });

  describe('utf8ToB64Url', () => {
    it('should convet a UTF8 string to a Base64 URL encoded string', () => {
      expect(utf8ToB64Url(TEST_STRING)).to.deep.equal(
        TEST_BASE_64_URL_ENCODED_STRING,
      );
    });
  });

  describe('b64UrlToUtf8', () => {
    it('should convert a Base64 URL encoded string to UTF8', () => {
      expect(b64UrlToUtf8(TEST_BASE_64_URL_ENCODED_STRING)).to.deep.equal(
        TEST_STRING,
      );
    });
  });
});

describe('Message pack encoding and decoding functions', () => {
  describe('toMsgpack and fromMsgpack', () => {
    it('should round trip to and from MessagePack binary data', () => {
      const testObject = {
        test: 'test',
        test2: [1, 2, 3],
      };

      const testBuffer = toMsgpack(testObject);
      const testObject2 = fromMsgpack(testBuffer);

      expect(testObject2).to.deep.equal(testObject);
    });

    it("should preserve compatibility with 'standard' MessagePack", () => {
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

describe('Block message pack encoding and decoding functions', () => {
  describe('jsonBlockToMsgpackBlock and msgpackBlockToJsonBlock', () => {
    it('should round trip to and from a MsgpackBlock', async () => {
      await Promise.all(
        [1, 982575].map(async (height) => {
          const chainSource = new ArweaveChainSourceStub();
          const block = await chainSource.getBlockByHeight(height);

          // Remove extranious header fields
          delete (block as any).poa;
          delete (block as any).tx_tree;

          const msgpackBlock = jsonBlockToMsgpackBlock(block);
          const jsonBlock = msgpackBlockToJsonBlock(msgpackBlock);

          // Check keys individual since some may be present with undefined values
          // on the jsonBlock but missing on the block
          for (const key in jsonBlock) {
            if ((block as any)[key] !== undefined) {
              expect((jsonBlock as any)[key]).to.deep.equal(
                (block as any)[key],
              );
            } else {
              expect((jsonBlock as any)[key]).to.be.undefined;
            }
          }
        }),
      );
    });
  });

  describe('jsonBlockToMsgpack and msgpackToJsonBlock', () => {
    it('should round trip to and from MessagePack binary data', async () => {
      await Promise.all(
        [1, 982575].map(async (height) => {
          const chainSource = new ArweaveChainSourceStub();
          const block = await chainSource.getBlockByHeight(height);

          // Remove extranious header fields
          delete (block as any).poa;
          delete (block as any).tx_tree;

          const buffer = jsonBlockToMsgpack(block);
          const jsonBlock = msgpackToJsonBlock(buffer);

          // Check keys individual since some may be present with undefined values
          // on the jsonBlock but missing on the block
          for (const key in jsonBlock) {
            if ((block as any)[key] !== undefined) {
              expect((jsonBlock as any)[key]).to.deep.equal(
                (block as any)[key],
              );
            } else {
              expect((jsonBlock as any)[key]).to.be.undefined;
            }
          }
        }),
      );
    });
  });
});

describe('Transaction message pack encoding and decoding functions', () => {
  describe('jsonTxToMsgpackTx and msgpackTxToJsonTx', () => {
    it('should round trip to and from a MsgpackTransaction', async () => {
      await Promise.all(
        [
          'cK9WF2XMwFj5TF1uhaCSdrA2mVoaxAz20HkDyQhq0i0',
          '8V0K0DltgqPzBDa_FYyOdWnfhSngRj7ORH0lnOeqChw', // data TX from block 800,000
        ].map(async (txId) => {
          const chainSource = new ArweaveChainSourceStub();
          const tx = await chainSource.getTx(txId);

          // Remove extranious header fields
          delete (tx as any).data;
          delete (tx as any).data_tree;

          const msgpackTx = jsonTxToMsgpackTx(tx);
          const jsonTx = msgpackTxToJsonTx(msgpackTx);

          expect(jsonTx).to.deep.equal(tx);
        }),
      );
    });
  });

  describe('jsonTxToMsgpack and msgpackToJsonTx', () => {
    it('should round trip to and from MessagePack binary data', async () => {
      [
        'cK9WF2XMwFj5TF1uhaCSdrA2mVoaxAz20HkDyQhq0i0',
        '8V0K0DltgqPzBDa_FYyOdWnfhSngRj7ORH0lnOeqChw', // data TX from block 800,000
      ].forEach(async (txId) => {
        const chainSource = new ArweaveChainSourceStub();
        const tx = await chainSource.getTx(txId);

        // Remove extranious header fields
        delete (tx as any).data;
        delete (tx as any).data_tree;

        const buffer = jsonTxToMsgpack(tx);
        const jsonTx = msgpackToJsonTx(buffer);

        expect(jsonTx).to.deep.equal(tx);
      });
    });
  });
});

// TODO add test with index last
describe('Manifest parsing', () => {
  describe('resolveManifestStreamPath', () => {
    it('should return the ID for the index path', async () => {
      const id = await resolveManifestStreamPath(exampleManifestStream());
      expect(id).to.equal('cG7Hdi_iTQPoEYgQJFqJ8NMpN4KoZ-vH_j7pG4iP7NI');
    });

    it('should return the ID for non-index paths', async () => {
      // TODO use an array here
      const id1 = await resolveManifestStreamPath(
        exampleManifestStream(),
        'css/mobile.css',
      );
      expect(id1).to.equal('fZ4d7bkCAUiXSfo3zFsPiQvpLVKVtXUKB6kiLNt2XVQ');

      const id2 = await resolveManifestStreamPath(
        exampleManifestStream(),
        'assets/img/icon.png',
      );
      expect(id2).to.equal('0543SMRGYuGKTaqLzmpOyK4AxAB96Fra2guHzYxjRGo');
    });

    it('should return undefined if the path is not found', async () => {
      const id = await resolveManifestStreamPath(
        exampleManifestStream(),
        'missing',
      );
      expect(id).to.be.undefined;
    });
  });
});
