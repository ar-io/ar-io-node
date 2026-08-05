/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
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
  exampleManifestStreamInvalidIds,
  exampleManifestStreamV010,
  exampleManifestStreamV010IndexPathAtEnd,
  exampleManifestStreamV020IndexAndPathAtTheEnd,
  exampleManifestStreamV020IndexId,
  exampleManifestStreamV020IndexIdAndPath,
  exampleManifestStreamV020FallbackFirst,
  exampleManifestStreamV020IndexPath,
  exampleManifestStreamV020PathsBeforeIndexPathFirst,
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
      assert.deepEqual(
        fromB64Url(TEST_BASE_64_URL_ENCODED_STRING),
        TEST_BASE_64_BUFFER,
      );
    });
  });

  describe('toB64Url', () => {
    it('should convert a Buffer to a Base64 URL encoded string', () => {
      assert.deepEqual(
        toB64Url(TEST_BASE_64_BUFFER),
        TEST_BASE_64_URL_ENCODED_STRING,
      );
    });

    it('should convert a Buffer with padding to Base64 URL encoded string', () => {
      assert.deepEqual(
        toB64Url(TEST_BASE_64_BUFFER_WITH_PADDING),
        TEST_BASE_64_URL_ENCODED_STRING,
      );
    });
  });

  describe('sha256B64Url', () => {
    it('should convert a Buffer to a Base64 URL encoded SHA256 string', () => {
      assert.deepEqual(
        sha256B64Url(TEST_BASE_64_BUFFER),
        TEST_BASE_64_SHA_256_STRING,
      );
    });
  });

  describe('utf8ToB64Url', () => {
    it('should convet a UTF8 string to a Base64 URL encoded string', () => {
      assert.deepEqual(
        utf8ToB64Url(TEST_STRING),
        TEST_BASE_64_URL_ENCODED_STRING,
      );
    });
  });

  describe('b64UrlToUtf8', () => {
    it('should convert a Base64 URL encoded string to UTF8', () => {
      assert.deepEqual(
        b64UrlToUtf8(TEST_BASE_64_URL_ENCODED_STRING),
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

      assert.deepEqual(testObject2, testObject);
    });

    it("should preserve compatibility with 'standard' MessagePack", () => {
      const testObject = {
        test: 'test',
        test2: [1, 2, 3],
      };

      const testBuffer = toMsgpack(testObject);
      const testObject2 = msgpack.decode(testBuffer);

      assert.deepEqual(testObject2, testObject);

      const testBuffer2 = msgpack.encode(testObject);
      const testObject3 = fromMsgpack(testBuffer2);

      assert.deepEqual(testObject3, testObject);
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
              assert.deepEqual((jsonBlock as any)[key], (block as any)[key]);
            } else {
              assert.equal((jsonBlock as any)[key], undefined);
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
              assert.deepEqual((jsonBlock as any)[key], (block as any)[key]);
            } else {
              assert.equal((jsonBlock as any)[key], undefined);
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
          const tx = await chainSource.getTx({ txId });

          // Remove extranious header fields
          delete (tx as any).data;
          delete (tx as any).data_tree;

          const msgpackTx = jsonTxToMsgpackTx(tx);
          const jsonTx = msgpackTxToJsonTx(msgpackTx);

          assert.deepEqual(jsonTx, tx);
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
        const tx = await chainSource.getTx({ txId });

        // Remove extranious header fields
        delete (tx as any).data;
        delete (tx as any).data_tree;

        const buffer = jsonTxToMsgpack(tx);
        const jsonTx = msgpackToJsonTx(buffer);

        assert.deepEqual(jsonTx, tx);
      });
    });
  });
});

describe('Manifest parsing', () => {
  describe('resolveManifestStreamPath', () => {
    describe('manifest v0.1.0', () => {
      it('should return the ID and index resolution type for the index path', async () => {
        const result = await resolveManifestStreamPath(
          exampleManifestStreamV010(),
        );
        assert.equal(result.id, 'cG7Hdi_iTQPoEYgQJFqJ8NMpN4KoZ-vH_j7pG4iP7NI');
        assert.equal(result.resolutionType, 'index');
      });

      it('should return the ID and path resolution type for non-index paths', async () => {
        const paths = [
          {
            path: 'css/mobile.css',
            id: 'fZ4d7bkCAUiXSfo3zFsPiQvpLVKVtXUKB6kiLNt2XVQ',
          },
          {
            path: 'assets/img/icon.png',
            id: '0543SMRGYuGKTaqLzmpOyK4AxAB96Fra2guHzYxjRGo',
          },
          {
            path: 'assets/img/icon.png/',
            id: '0543SMRGYuGKTaqLzmpOyK4AxAB96Fra2guHzYxjRGo',
          },
        ];

        for (const { path, id } of paths) {
          const result = await resolveManifestStreamPath(
            exampleManifestStreamV010(),
            path,
          );
          assert.equal(result.id, id);
          assert.equal(result.resolutionType, 'path');
        }
      });

      it('should return undefined if the path is not found and there is no fallback', async () => {
        const result = await resolveManifestStreamPath(
          exampleManifestStreamV010(),
          'missing',
        );
        assert.equal(result.id, undefined);
        assert.equal(result.resolutionType, undefined);
      });
    });

    describe('manifest v0.1.0 with index path at end', () => {
      it('should return the ID and index resolution type for the index path', async () => {
        const result = await resolveManifestStreamPath(
          exampleManifestStreamV010IndexPathAtEnd(),
        );
        assert.equal(result.id, 'hoI_WQI9_5Mf1vASBwLdqE01goxRCgC53yuCrSaUOcs');
        assert.equal(result.resolutionType, 'index');
      });
    });

    describe('manifest v0.2.0 - index id', () => {
      it('should return the ID and index resolution type for the index path', async () => {
        const result = await resolveManifestStreamPath(
          exampleManifestStreamV020IndexId(),
        );
        assert.equal(result.id, 'QYWh-QsozsYu2wor0ZygI5Zoa_fRYFc8_X1RkYmw_fU');
        assert.equal(result.resolutionType, 'index');
      });

      it('should return the ID and path resolution type for non-index paths', async () => {
        const paths = [
          {
            path: 'css/mobile.css',
            id: 'fZ4d7bkCAUiXSfo3zFsPiQvpLVKVtXUKB6kiLNt2XVQ',
          },
          {
            path: 'assets/img/icon.png',
            id: '0543SMRGYuGKTaqLzmpOyK4AxAB96Fra2guHzYxjRGo',
          },
          {
            path: 'assets/img/icon.png/',
            id: '0543SMRGYuGKTaqLzmpOyK4AxAB96Fra2guHzYxjRGo',
          },
        ];

        for (const { path, id } of paths) {
          const result = await resolveManifestStreamPath(
            exampleManifestStreamV020IndexId(),
            path,
          );
          assert.equal(result.id, id);
          assert.equal(result.resolutionType, 'path');
        }
      });

      it('should return fallback id and resolution type if the path is not found', async () => {
        const result = await resolveManifestStreamPath(
          exampleManifestStreamV020IndexId(),
          'missing',
        );
        assert.equal(result.id, 'cG7Hdi_iTQPoEYgQJFqJ8NMpN4KoZ-vH_j7pG4iP7NI');
        assert.equal(result.resolutionType, 'fallback');
      });
    });

    describe('manifest v0.2.0 - index path', () => {
      it('should return the ID and index resolution type for the index path', async () => {
        const result = await resolveManifestStreamPath(
          exampleManifestStreamV020IndexPath(),
        );
        assert.equal(result.id, 'cG7Hdi_iTQPoEYgQJFqJ8NMpN4KoZ-vH_j7pG4iP7NI');
        assert.equal(result.resolutionType, 'index');
      });

      it('should return the ID and path resolution type for non-index paths', async () => {
        const paths = [
          {
            path: 'css/mobile.css',
            id: 'fZ4d7bkCAUiXSfo3zFsPiQvpLVKVtXUKB6kiLNt2XVQ',
          },
          {
            path: 'assets/img/icon.png',
            id: '0543SMRGYuGKTaqLzmpOyK4AxAB96Fra2guHzYxjRGo',
          },
          {
            path: 'assets/img/icon.png/',
            id: '0543SMRGYuGKTaqLzmpOyK4AxAB96Fra2guHzYxjRGo',
          },
        ];

        for (const { path, id } of paths) {
          const result = await resolveManifestStreamPath(
            exampleManifestStreamV020IndexPath(),
            path,
          );
          assert.equal(result.id, id);
          assert.equal(result.resolutionType, 'path');
        }
      });

      it('should return fallback id and resolution type if the path is not found', async () => {
        const result = await resolveManifestStreamPath(
          exampleManifestStreamV020IndexPath(),
          'missing',
        );
        assert.equal(result.id, 'cG7Hdi_iTQPoEYgQJFqJ8NMpN4KoZ-vH_j7pG4iP7NI');
        assert.equal(result.resolutionType, 'fallback');
      });
    });

    describe('manifest v0.2.0 - index id and path', () => {
      it('should return the ID and index resolution type for the index id', async () => {
        const result = await resolveManifestStreamPath(
          exampleManifestStreamV020IndexIdAndPath(),
        );
        assert.equal(result.id, 'QYWh-QsozsYu2wor0ZygI5Zoa_fRYFc8_X1RkYmw_fU');
        assert.equal(result.resolutionType, 'index');

        const indexEnd = await resolveManifestStreamPath(
          exampleManifestStreamV020IndexAndPathAtTheEnd(),
        );
        assert.equal(
          indexEnd.id,
          'QYWh-QsozsYu2wor0ZygI5Zoa_fRYFc8_X1RkYmw_fU',
        );
        assert.equal(indexEnd.resolutionType, 'index');
      });

      it('should return the ID and path resolution type for non-index paths', async () => {
        const paths = [
          {
            path: 'css/mobile.css',
            id: 'fZ4d7bkCAUiXSfo3zFsPiQvpLVKVtXUKB6kiLNt2XVQ',
          },
          {
            path: 'assets/img/icon.png',
            id: '0543SMRGYuGKTaqLzmpOyK4AxAB96Fra2guHzYxjRGo',
          },
          {
            path: 'assets/img/icon.png/',
            id: '0543SMRGYuGKTaqLzmpOyK4AxAB96Fra2guHzYxjRGo',
          },
        ];

        for (const { path, id } of paths) {
          const result = await resolveManifestStreamPath(
            exampleManifestStreamV020IndexIdAndPath(),
            path,
          );
          assert.equal(result.id, id);
          assert.equal(result.resolutionType, 'path');
        }
      });

      it('should return fallback id and resolution type if the path is not found', async () => {
        const result = await resolveManifestStreamPath(
          exampleManifestStreamV020IndexIdAndPath(),
          'missing',
        );
        assert.equal(result.id, 'cG7Hdi_iTQPoEYgQJFqJ8NMpN4KoZ-vH_j7pG4iP7NI');
        assert.equal(result.resolutionType, 'fallback');

        const fallbackEnd = await resolveManifestStreamPath(
          exampleManifestStreamV020IndexAndPathAtTheEnd(),
          'missing',
        );
        assert.equal(
          fallbackEnd.id,
          'cG7Hdi_iTQPoEYgQJFqJ8NMpN4KoZ-vH_j7pG4iP7NI',
        );
        assert.equal(fallbackEnd.resolutionType, 'fallback');
      });
    });

    describe('manifest v0.2.0 - index id precedence over index path', () => {
      // Regression test: for a v0.2.0 manifest where `paths` precede `index`
      // and `index.path` precedes `index.id`, resolution must still return
      // `index.id` (not the id that `index.path` maps to). Before the
      // deferred-resolution fix, the streaming parser emitted the path-derived
      // index id first and won, so the outcome depended on JSON key order.
      it('should return index.id regardless of key order', async () => {
        const result = await resolveManifestStreamPath(
          exampleManifestStreamV020PathsBeforeIndexPathFirst(),
        );
        assert.equal(result.id, 'QYWh-QsozsYu2wor0ZygI5Zoa_fRYFc8_X1RkYmw_fU');
        assert.equal(result.resolutionType, 'index');
      });
    });

    describe('manifest v0.2.0 - fallback declared before index/paths', () => {
      // The `fallback` event is emitted only at stream end (after all index and
      // path events), so a fallback that appears first in the JSON must never
      // preempt the index or a matching path.
      it('returns the index for the root, not the fallback', async () => {
        const result = await resolveManifestStreamPath(
          exampleManifestStreamV020FallbackFirst(),
        );
        assert.equal(result.id, 'QYWh-QsozsYu2wor0ZygI5Zoa_fRYFc8_X1RkYmw_fU');
        assert.equal(result.resolutionType, 'index');
      });

      it('returns a matching path, not the fallback', async () => {
        const result = await resolveManifestStreamPath(
          exampleManifestStreamV020FallbackFirst(),
          'css/mobile.css',
        );
        assert.equal(result.id, 'fZ4d7bkCAUiXSfo3zFsPiQvpLVKVtXUKB6kiLNt2XVQ');
        assert.equal(result.resolutionType, 'path');
      });

      it('returns the fallback only when nothing else matches', async () => {
        const result = await resolveManifestStreamPath(
          exampleManifestStreamV020FallbackFirst(),
          'missing',
        );
        assert.equal(result.id, 'cG7Hdi_iTQPoEYgQJFqJ8NMpN4KoZ-vH_j7pG4iP7NI');
        assert.equal(result.resolutionType, 'fallback');
      });
    });

    describe('manifest with malformed ids', () => {
      it('should not resolve the root when index.id and fallback.id are malformed', async () => {
        const result = await resolveManifestStreamPath(
          exampleManifestStreamInvalidIds(),
        );
        assert.equal(result.id, undefined);
        assert.equal(result.resolutionType, undefined);
      });

      it('should resolve a path with a valid id', async () => {
        const result = await resolveManifestStreamPath(
          exampleManifestStreamInvalidIds(),
          'good.txt',
        );
        assert.equal(result.id, 'cG7Hdi_iTQPoEYgQJFqJ8NMpN4KoZ-vH_j7pG4iP7NI');
        assert.equal(result.resolutionType, 'path');
      });

      it('should not resolve a path whose id is malformed', async () => {
        const result = await resolveManifestStreamPath(
          exampleManifestStreamInvalidIds(),
          'bad.txt',
        );
        assert.equal(result.id, undefined);
        assert.equal(result.resolutionType, undefined);
      });
    });
  });
});
