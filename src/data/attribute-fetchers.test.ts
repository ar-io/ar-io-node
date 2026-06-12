/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { strict as assert } from 'node:assert';
import { Readable } from 'node:stream';
import { describe, it, beforeEach, mock } from 'node:test';
import {
  AttributeFetchers,
  OwnerFetcher,
  SignatureFetcher,
} from './attribute-fetchers.js';
import {
  ContiguousDataSource,
  ContiguousDataIndex,
  DataItemAttributesStore,
  TransactionAttributesStore,
  ChainSource,
  SignatureStore,
  OwnerStore,
} from '../types.js';
import * as metrics from '../metrics.js';
import { createTestLogger } from '../../test/test-logger.js';

const log = createTestLogger({ suite: 'AttributeFetcher' });
interface Mocks {
  dataSource: ContiguousDataSource;
  dataIndex: ContiguousDataIndex;
  chainSource: ChainSource;
  signatureStore: SignatureStore;
  ownerStore: OwnerStore;
  dataItemAttributesStore: DataItemAttributesStore;
  transactionAttributesStore: TransactionAttributesStore;
}
const createMocks = (): Mocks => ({
  dataSource: {
    getData: mock.fn(),
  } as unknown as ContiguousDataSource,
  dataIndex: {
    getDataItemAttributes: mock.fn(),
    getTransactionAttributes: mock.fn(),
  } as unknown as ContiguousDataIndex,
  chainSource: {
    getTxField: mock.fn(),
    getTx: mock.fn(),
  } as unknown as ChainSource,
  signatureStore: {
    get: mock.fn(),
    set: mock.fn(),
  } as unknown as SignatureStore,
  ownerStore: {
    get: mock.fn(),
    set: mock.fn(),
  } as unknown as SignatureStore,
  dataItemAttributesStore: {
    get: mock.fn(),
    set: mock.fn(),
  } as unknown as DataItemAttributesStore,
  transactionAttributesStore: {
    get: mock.fn(),
    set: mock.fn(),
  } as unknown as TransactionAttributesStore,
});

describe('AttributeFetcher', () => {
  let mocks: Mocks;
  let attributeFetcher: AttributeFetchers;

  beforeEach(() => {
    mocks = createMocks();

    attributeFetcher = new AttributeFetchers({
      log,
      dataSource: mocks.dataSource,
      dataIndex: mocks.dataIndex,
      dataItemAttributesStore: mocks.dataItemAttributesStore,
      transactionAttributesStore: mocks.transactionAttributesStore,
    });
  });

  describe('fetchDataFromParent', () => {
    it('should fetch and return data from parent', async () => {
      const testBuffer = Buffer.from('testData'); // 8 bytes
      mock.method(mocks.dataSource, 'getData', async () => ({
        stream: {
          [Symbol.asyncIterator]: async function* () {
            yield testBuffer;
          },
        },
      }));

      const result = await attributeFetcher.fetchDataFromParent({
        parentId: 'testParent',
        offset: 100,
        size: testBuffer.length,
      });

      assert.strictEqual(result, testBuffer.toString('base64url'));
    });

    // PE-9081: input validation
    it('should throw when size is 0', async () => {
      await assert.rejects(
        attributeFetcher.fetchDataFromParent({
          parentId: 'testParent',
          offset: 0,
          size: 0,
        }),
        /invalid size/,
      );
    });

    it('should throw when size is negative', async () => {
      await assert.rejects(
        attributeFetcher.fetchDataFromParent({
          parentId: 'testParent',
          offset: 0,
          size: -1,
        }),
        /invalid size/,
      );
    });

    it('should throw when offset is negative', async () => {
      await assert.rejects(
        attributeFetcher.fetchDataFromParent({
          parentId: 'testParent',
          offset: -1,
          size: 8,
        }),
        /invalid offset/,
      );
    });

    // PE-9081: streaming guards
    it('should throw and destroy stream when upstream emits more bytes than requested', async () => {
      const testBuffer = Buffer.from('TOO_MANY_BYTES_FOR_THIS_REQUEST'); // 31 bytes
      let streamDestroyed = false;
      const fakeStream: {
        destroy: () => void;
        [Symbol.asyncIterator]: () => AsyncGenerator<Buffer>;
      } = {
        destroy: () => {
          streamDestroyed = true;
        },
        [Symbol.asyncIterator]: async function* () {
          yield testBuffer;
        },
      };
      mock.method(mocks.dataSource, 'getData', async () => ({
        stream: fakeStream,
      }));

      await assert.rejects(
        attributeFetcher.fetchDataFromParent({
          parentId: 'testParent',
          offset: 0,
          size: 4, // requesting 4 bytes, upstream sends 31
        }),
        /more bytes than requested/,
      );

      assert.strictEqual(streamDestroyed, true);
    });

    it('should throw on short read', async () => {
      const testBuffer = Buffer.from('short'); // 5 bytes
      mock.method(mocks.dataSource, 'getData', async () => ({
        stream: {
          [Symbol.asyncIterator]: async function* () {
            yield testBuffer;
          },
        },
      }));

      await assert.rejects(
        attributeFetcher.fetchDataFromParent({
          parentId: 'testParent',
          offset: 0,
          size: 100, // requesting 100 bytes, upstream sends 5
        }),
        /short read/,
      );
    });

    it('should accept stream emitted across multiple chunks summing to size', async () => {
      // Verifies the chunk.copy + offset accumulation path.
      const chunk1 = Buffer.from('ab');
      const chunk2 = Buffer.from('cd');
      mock.method(mocks.dataSource, 'getData', async () => ({
        stream: {
          [Symbol.asyncIterator]: async function* () {
            yield chunk1;
            yield chunk2;
          },
        },
      }));

      const result = await attributeFetcher.fetchDataFromParent({
        parentId: 'testParent',
        offset: 0,
        size: 4,
      });

      assert.strictEqual(result, Buffer.from('abcd').toString('base64url'));
    });

    it('should short-circuit when signal is already aborted before fetch', async () => {
      // Pre-aborted signal must throw before we call dataSource.getData and
      // before we allocate the buffer. Critical for cancelling resolver work
      // whose client has already disconnected by the time the fetch is dispatched.
      const getDataMock = mock.fn(async () => ({
        stream: Readable.from([Buffer.from('unused')]),
      }));
      mocks.dataSource.getData = getDataMock as any;
      const ctrl = new AbortController();
      ctrl.abort(new Error('client gone'));

      await assert.rejects(
        attributeFetcher.fetchDataFromParent({
          parentId: 'testParent',
          offset: 0,
          size: 4,
          signal: ctrl.signal,
        }),
        /client gone/,
      );
      assert.equal(getDataMock.mock.callCount(), 0);
    });

    it('should destroy upstream stream and reject when aborted mid-stream', async () => {
      // Mid-stream abort: upstream emits a small prefix and then stalls
      // (simulating a slow gateway), the resolver-level signal fires, and
      // the stream must be destroyed so the upstream connection can
      // release and the rejection propagates promptly.
      let destroyed = false;
      let destroyError: Error | undefined;
      let pushed = false;
      const stream = new Readable({
        read() {
          // Push once, then go quiet — never end, never push again. The
          // for-await consumer in fetchDataFromParent will hang waiting
          // for more bytes; the abort handler must call destroy() to
          // unblock it.
          if (!pushed) {
            pushed = true;
            this.push(Buffer.from('ab'));
          }
        },
      });
      const origDestroy = stream.destroy.bind(stream);
      stream.destroy = ((err?: Error) => {
        destroyed = true;
        destroyError = err;
        return origDestroy(err);
      }) as typeof stream.destroy;

      mock.method(mocks.dataSource, 'getData', async () => ({ stream }));

      const ctrl = new AbortController();
      const pending = attributeFetcher.fetchDataFromParent({
        parentId: 'testParent',
        offset: 0,
        size: 1000, // larger than the 2 bytes upstream will deliver
        signal: ctrl.signal,
      });
      // Suppress the unhandled-rejection warning while the assert.rejects
      // below is being scheduled — we are intentionally aborting.
      pending.catch(() => {});

      // Let the fetch start consuming the stream, then abort.
      await new Promise((resolve) => setImmediate(resolve));
      ctrl.abort(new Error('deadline elapsed'));

      await assert.rejects(pending);
      assert.equal(destroyed, true, 'stream.destroy must be called');
      assert.match(
        destroyError?.message ?? '',
        /deadline elapsed/,
        'destroy must receive the abort reason',
      );
    });
  });

  describe('getDataItemAttributes', () => {
    const testAttributes = {
      parentId: 'parent',
      signature: 'sig',
      signatureOffset: 1,
      signatureSize: 2,
      ownerOffset: 3,
      ownerSize: 4,
    };

    it('should return attributes from store if they exist', async () => {
      mock.method(
        mocks.dataItemAttributesStore,
        'get',
        async () => testAttributes,
      );

      const result = await attributeFetcher.getDataItemAttributes('testId');

      assert.deepStrictEqual(result, testAttributes);
      assert.strictEqual(
        (mocks.dataItemAttributesStore.set as any).mock.calls.length,
        0,
      );
    });

    it('should fetch and store attributes if not in store', async () => {
      mock.method(mocks.dataItemAttributesStore, 'get', async () => undefined);
      mock.method(
        mocks.dataIndex,
        'getDataItemAttributes',
        async () => testAttributes,
      );

      const result = await attributeFetcher.getDataItemAttributes('testId');

      assert.deepStrictEqual(result, testAttributes);
      assert.strictEqual(
        (mocks.dataItemAttributesStore.set as any).mock.calls.length,
        1,
      );
    });

    it('should return undefined if attributes is not in store and not in data index', async () => {
      mock.method(mocks.dataItemAttributesStore, 'get', async () => undefined);
      mock.method(
        mocks.dataIndex,
        'getDataItemAttributes',
        async () => undefined,
      );

      const result = await attributeFetcher.getDataItemAttributes('testId');

      assert.deepStrictEqual(result, undefined);
      assert.strictEqual(
        (mocks.transactionAttributesStore.set as any).mock.calls.length,
        0,
      );
    });
  });

  describe('getTransactionAttributes', () => {
    const testAttributes = {
      signature: 'sig',
      owner: 'owner',
    };

    it('should return attributes from store if they exist', async () => {
      mock.method(
        mocks.transactionAttributesStore,
        'get',
        async () => testAttributes,
      );

      const result = await attributeFetcher.getTransactionAttributes('testId');

      assert.deepStrictEqual(result, testAttributes);
      assert.strictEqual(
        (mocks.transactionAttributesStore.set as any).mock.calls.length,
        0,
      );
    });

    it('should fetch and store attributes if not in store', async () => {
      mock.method(
        mocks.transactionAttributesStore,
        'get',
        async () => undefined,
      );
      mock.method(
        mocks.dataIndex,
        'getTransactionAttributes',
        async () => testAttributes,
      );

      const result = await attributeFetcher.getTransactionAttributes('testId');

      assert.deepStrictEqual(result, testAttributes);
      assert.strictEqual(
        (mocks.transactionAttributesStore.set as any).mock.calls.length,
        1,
      );
    });

    it('should return undefined if attributes is not in store and not in data index', async () => {
      mock.method(
        mocks.transactionAttributesStore,
        'get',
        async () => undefined,
      );
      mock.method(
        mocks.dataIndex,
        'getTransactionAttributes',
        async () => undefined,
      );

      const result = await attributeFetcher.getTransactionAttributes('testId');

      assert.deepStrictEqual(result, undefined);
      assert.strictEqual(
        (mocks.transactionAttributesStore.set as any).mock.calls.length,
        0,
      );
    });
  });
});

describe('SignatureFetcher', () => {
  let mocks: Mocks;
  let signatureFetcher: SignatureFetcher;

  beforeEach(() => {
    mocks = createMocks();

    signatureFetcher = new SignatureFetcher({
      log,
      dataSource: mocks.dataSource,
      dataIndex: mocks.dataIndex,
      chainSource: mocks.chainSource,
      dataItemAttributesStore: mocks.dataItemAttributesStore,
      transactionAttributesStore: mocks.transactionAttributesStore,
      signatureStore: mocks.signatureStore,
    });
  });

  describe('getDataItemSignature', () => {
    it('should return undefined if no attributes found', async () => {
      mock.method(
        mocks.dataIndex,
        'getDataItemAttributes',
        async () => undefined,
      );

      const result = await signatureFetcher.getDataItemSignature({
        id: 'id',
      });

      assert.strictEqual(result, undefined);
      assert.strictEqual(
        (mocks.signatureStore.set as any).mock.calls.length,
        0,
      );
    });

    it('should return signature from signature store if it exists', async () => {
      mock.method(
        mocks.signatureStore,
        'get',
        async () => 'signature-from-store',
      );

      const result = await signatureFetcher.getDataItemSignature({
        id: 'id',
      });

      assert.strictEqual(result, 'signature-from-store');
      assert.strictEqual(
        (mocks.signatureStore.set as any).mock.calls.length,
        0,
      );
    });

    it('should return signature if it exists in attributes', async () => {
      mock.method(mocks.dataIndex, 'getDataItemAttributes', async () => ({
        signature: 'signature',
      }));

      const result = await signatureFetcher.getDataItemSignature({
        id: 'id',
      });

      assert.strictEqual(result, 'signature');
      assert.strictEqual(
        (mocks.signatureStore.set as any).mock.calls.length,
        1,
      );
    });

    it('should fetch and return signature if not in attributes', async () => {
      const testSignatureBuffer = Buffer.from('testSignature');

      mock.method(signatureFetcher, 'getDataItemAttributes', async () => ({
        parentId: 'id',
        signatureOffset: 1,
        signatureSize: testSignatureBuffer.length,
      }));

      mock.method(mocks.dataSource, 'getData', async () => ({
        stream: {
          [Symbol.asyncIterator]: async function* () {
            yield testSignatureBuffer;
          },
        },
      }));

      const result = await signatureFetcher.getDataItemSignature({
        id: 'id',
      });

      assert.strictEqual(result, testSignatureBuffer.toString('base64url'));
      assert.strictEqual(
        (mocks.signatureStore.set as any).mock.calls.length,
        1,
      );
    });

    it('should fetch and return signature if parentId, signatureOffset, signatureSize is provided', async () => {
      const testSignatureBuffer = Buffer.from('testSignature');

      mock.method(mocks.dataSource, 'getData', async () => ({
        stream: {
          [Symbol.asyncIterator]: async function* () {
            yield testSignatureBuffer;
          },
        },
      }));

      const result = await signatureFetcher.getDataItemSignature({
        id: 'id',
        parentId: 'parent',
        signatureOffset: 1,
        signatureSize: testSignatureBuffer.length,
      });

      assert.strictEqual(result, testSignatureBuffer.toString('base64url'));
      assert.strictEqual(
        (mocks.signatureStore.set as any).mock.calls.length,
        1,
      );
    });

    it('should handle errors and return undefined', async () => {
      mock.method(mocks.dataIndex, 'getDataItemAttributes', async () => {
        throw new Error('Test error');
      });

      const result = await signatureFetcher.getDataItemSignature({
        id: 'id',
      });

      assert.strictEqual(result, undefined);
      assert.strictEqual(
        (mocks.signatureStore.set as any).mock.calls.length,
        0,
      );
    });

    // PE-9081: caller-side validation. Production heap analysis showed
    // upstream attribute stores returning signatureSize=0, which used to
    // be silently forwarded into fetchDataFromParent and triggered the
    // upstream-returns-full-bundle leak. These cases now bail out early.
    it('should return undefined when attribute store returns signatureSize=0', async () => {
      mock.method(signatureFetcher, 'getDataItemAttributes', async () => ({
        parentId: 'parent',
        signatureOffset: 0,
        signatureSize: 0,
      }));
      const getDataMock = mock.method(mocks.dataSource, 'getData', async () => {
        throw new Error('getData should never be called when size=0');
      });

      const result = await signatureFetcher.getDataItemSignature({ id: 'id' });

      assert.strictEqual(result, undefined);
      assert.strictEqual(getDataMock.mock.calls.length, 0);
      assert.strictEqual(
        (mocks.signatureStore.set as any).mock.calls.length,
        0,
      );
    });

    it('should return undefined when attribute store returns missing signatureSize', async () => {
      mock.method(signatureFetcher, 'getDataItemAttributes', async () => ({
        parentId: 'parent',
        signatureOffset: 0,
        // signatureSize intentionally omitted
      }));
      const getDataMock = mock.method(mocks.dataSource, 'getData', async () => {
        throw new Error(
          'getData should never be called when signatureSize is missing',
        );
      });

      const result = await signatureFetcher.getDataItemSignature({ id: 'id' });

      assert.strictEqual(result, undefined);
      assert.strictEqual(getDataMock.mock.calls.length, 0);
    });

    it('should return undefined when signatureOffset is negative', async () => {
      mock.method(signatureFetcher, 'getDataItemAttributes', async () => ({
        parentId: 'parent',
        signatureOffset: -1,
        signatureSize: 512,
      }));
      const getDataMock = mock.method(mocks.dataSource, 'getData', async () => {
        throw new Error('getData should never be called');
      });

      const result = await signatureFetcher.getDataItemSignature({ id: 'id' });

      assert.strictEqual(result, undefined);
      assert.strictEqual(getDataMock.mock.calls.length, 0);
    });
  });

  describe('getTransactionSignature', () => {
    it('should return signature from signature store if it exists', async () => {
      mock.method(
        mocks.signatureStore,
        'get',
        async () => 'signature-from-store',
      );

      const result = await signatureFetcher.getTransactionSignature({
        id: 'id',
      });

      assert.strictEqual(result, 'signature-from-store');
      assert.strictEqual(
        (mocks.signatureStore.set as any).mock.calls.length,
        0,
      );
    });

    it('should return signature if it exists in attributes', async () => {
      mock.method(mocks.dataIndex, 'getTransactionAttributes', async () => ({
        signature: 'signature',
      }));

      const result = await signatureFetcher.getTransactionSignature({
        id: 'id',
      });

      assert.strictEqual(result, 'signature');
      assert.strictEqual(
        (mocks.signatureStore.set as any).mock.calls.length,
        1,
      );
    });

    it('should fetch and return signature from chain if no attributes found', async () => {
      const testChainSignature = 'testChainSignature';
      mock.method(
        signatureFetcher,
        'getTransactionAttributes',
        async () => undefined,
      );
      mock.method(
        mocks.chainSource,
        'getTxField',
        async () => testChainSignature,
      );

      const result = await signatureFetcher.getTransactionSignature({
        id: 'id',
      });

      assert.strictEqual(result, testChainSignature);
      assert.strictEqual(
        (mocks.signatureStore.set as any).mock.calls.length,
        1,
      );
    });

    it('should fetch and return signature from chain if not in attributes', async () => {
      const testChainSignature = 'testChainSignature';

      mock.method(mocks.dataIndex, 'getTransactionAttributes', async () => ({
        signature: undefined,
      }));

      mock.method(
        mocks.chainSource,
        'getTxField',
        async () => testChainSignature,
      );

      const result = await signatureFetcher.getTransactionSignature({
        id: 'id',
      });

      assert.strictEqual(result, testChainSignature);
      assert.strictEqual(
        (mocks.signatureStore.set as any).mock.calls.length,
        1,
      );
    });

    it('should return undefined if signature not found in attributes or chain', async () => {
      mock.method(mocks.dataIndex, 'getTransactionAttributes', async () => ({
        signature: undefined,
      }));

      mock.method(mocks.chainSource, 'getTxField', async () => undefined);

      const result = await signatureFetcher.getTransactionSignature({
        id: 'id',
      });

      assert.strictEqual(result, undefined);
      assert.strictEqual(
        (mocks.signatureStore.set as any).mock.calls.length,
        0,
      );
    });

    it('should handle errors and return undefined', async () => {
      mock.method(mocks.dataIndex, 'getTransactionAttributes', async () => {
        throw new Error('Test error');
      });

      const result = await signatureFetcher.getTransactionSignature({
        id: 'id',
      });

      assert.strictEqual(result, undefined);
      assert.strictEqual(
        (mocks.signatureStore.set as any).mock.calls.length,
        0,
      );
    });
  });
});

describe('OwnerFetcher', () => {
  let mocks: Mocks;
  let ownerFetcher: OwnerFetcher;

  beforeEach(() => {
    mocks = createMocks();

    ownerFetcher = new OwnerFetcher({
      log,
      dataSource: mocks.dataSource,
      dataIndex: mocks.dataIndex,
      chainSource: mocks.chainSource,
      dataItemAttributesStore: mocks.dataItemAttributesStore,
      transactionAttributesStore: mocks.transactionAttributesStore,
      ownerStore: mocks.ownerStore,
    });
  });

  describe('getDataItemOwner', () => {
    it('should return undefined if no attributes found', async () => {
      mock.method(
        mocks.dataIndex,
        'getDataItemAttributes',
        async () => undefined,
      );

      const result = await ownerFetcher.getDataItemOwner({
        id: 'id',
      });

      assert.strictEqual(result, undefined);
      assert.strictEqual((mocks.ownerStore.set as any).mock.calls.length, 0);
    });

    it('should return owner from owner store if it exists', async () => {
      mock.method(mocks.ownerStore, 'get', async () => 'owner-from-store');

      const result = await ownerFetcher.getDataItemOwner({
        id: 'id',
      });

      assert.strictEqual(result, 'owner-from-store');
      assert.strictEqual((mocks.ownerStore.set as any).mock.calls.length, 0);
    });

    it('should fetch and return owner if attributes exist', async () => {
      const testOwnerBuffer = Buffer.from('testOwner');

      mock.method(ownerFetcher, 'getDataItemAttributes', async () => ({
        parentId: 'id',
        ownerOffset: 1,
        ownerSize: testOwnerBuffer.length,
      }));

      mock.method(mocks.dataSource, 'getData', async () => ({
        stream: {
          [Symbol.asyncIterator]: async function* () {
            yield testOwnerBuffer;
          },
        },
      }));

      const result = await ownerFetcher.getDataItemOwner({
        id: 'id',
      });

      assert.strictEqual(result, testOwnerBuffer.toString('base64url'));
      assert.strictEqual((mocks.ownerStore.set as any).mock.calls.length, 1);
    });

    it('should fetch and return owner if parentId, ownerOffset, ownerSize is provided', async () => {
      const testOwnerBuffer = Buffer.from('testOwner');

      mock.method(mocks.dataSource, 'getData', async () => ({
        stream: {
          [Symbol.asyncIterator]: async function* () {
            yield testOwnerBuffer;
          },
        },
      }));

      const result = await ownerFetcher.getDataItemOwner({
        id: 'id',
        parentId: 'parent',
        ownerOffset: 1,
        ownerSize: testOwnerBuffer.length,
      });

      assert.strictEqual(result, testOwnerBuffer.toString('base64url'));
      assert.strictEqual((mocks.ownerStore.set as any).mock.calls.length, 1);
    });

    it('should handle errors and return undefined', async () => {
      mock.method(mocks.dataIndex, 'getDataItemAttributes', async () => {
        throw new Error('Test error');
      });

      const result = await ownerFetcher.getDataItemOwner({
        id: 'id',
      });

      assert.strictEqual(result, undefined);
      assert.strictEqual((mocks.ownerStore.set as any).mock.calls.length, 0);
    });

    // PE-9081: caller-side validation, parallel to SignatureFetcher.
    it('should return undefined when attribute store returns ownerSize=0', async () => {
      mock.method(ownerFetcher, 'getDataItemAttributes', async () => ({
        parentId: 'parent',
        ownerOffset: 0,
        ownerSize: 0,
      }));
      const getDataMock = mock.method(mocks.dataSource, 'getData', async () => {
        throw new Error('getData should never be called when ownerSize=0');
      });

      const result = await ownerFetcher.getDataItemOwner({ id: 'id' });

      assert.strictEqual(result, undefined);
      assert.strictEqual(getDataMock.mock.calls.length, 0);
      assert.strictEqual((mocks.ownerStore.set as any).mock.calls.length, 0);
    });

    it('should return undefined when attribute store returns missing ownerSize', async () => {
      mock.method(ownerFetcher, 'getDataItemAttributes', async () => ({
        parentId: 'parent',
        ownerOffset: 0,
        // ownerSize intentionally omitted
      }));
      const getDataMock = mock.method(mocks.dataSource, 'getData', async () => {
        throw new Error('getData should never be called');
      });

      const result = await ownerFetcher.getDataItemOwner({ id: 'id' });

      assert.strictEqual(result, undefined);
      assert.strictEqual(getDataMock.mock.calls.length, 0);
    });

    it('should return undefined when ownerOffset is negative', async () => {
      mock.method(ownerFetcher, 'getDataItemAttributes', async () => ({
        parentId: 'parent',
        ownerOffset: -1,
        ownerSize: 512,
      }));
      const getDataMock = mock.method(mocks.dataSource, 'getData', async () => {
        throw new Error('getData should never be called');
      });

      const result = await ownerFetcher.getDataItemOwner({ id: 'id' });

      assert.strictEqual(result, undefined);
      assert.strictEqual(getDataMock.mock.calls.length, 0);
    });
  });

  describe('address-keyed owner cache (PE-9120)', () => {
    const ADDR = 'owner-address-1';

    const ownerStreamMock = () =>
      mock.method(mocks.dataSource, 'getData', async () => ({
        stream: {
          [Symbol.asyncIterator]: async function* () {
            yield Buffer.from('testOwner');
          },
        },
      }));

    it('returns from the address-keyed entry without fetching', async () => {
      mock.method(mocks.ownerStore, 'get', async (key: string) =>
        key === ADDR ? 'owner-by-address' : undefined,
      );
      const getDataMock = ownerStreamMock();

      const result = await ownerFetcher.getDataItemOwner({
        id: 'item-1',
        parentId: 'parent',
        ownerOffset: 1,
        ownerSize: 9,
        ownerAddress: ADDR,
      });

      assert.strictEqual(result, 'owner-by-address');
      assert.strictEqual(getDataMock.mock.calls.length, 0);
      assert.strictEqual((mocks.ownerStore.set as any).mock.calls.length, 0);
    });

    it('falls back to the id-keyed entry when address misses', async () => {
      mock.method(mocks.ownerStore, 'get', async (key: string) =>
        key === 'item-1' ? 'owner-by-id' : undefined,
      );
      const getDataMock = ownerStreamMock();

      const result = await ownerFetcher.getDataItemOwner({
        id: 'item-1',
        parentId: 'parent',
        ownerOffset: 1,
        ownerSize: 9,
        ownerAddress: ADDR,
      });

      assert.strictEqual(result, 'owner-by-id');
      assert.strictEqual(getDataMock.mock.calls.length, 0);
    });

    it('dual-writes by id and address after a fetch', async () => {
      mock.method(mocks.ownerStore, 'get', async () => undefined);
      ownerStreamMock();

      await ownerFetcher.getDataItemOwner({
        id: 'item-1',
        parentId: 'parent',
        ownerOffset: 1,
        ownerSize: 9,
        ownerAddress: ADDR,
      });

      const setCalls = (mocks.ownerStore.set as any).mock.calls;
      assert.strictEqual(setCalls.length, 2);
      const keys = setCalls.map((c: any) => c.arguments[0]).sort();
      assert.deepStrictEqual(keys, ['item-1', ADDR].sort());
    });

    it('coalesces concurrent fetches for the same address to one parent fetch', async () => {
      mock.method(mocks.ownerStore, 'get', async () => undefined);
      const getDataMock = ownerStreamMock();

      const results = await Promise.all(
        ['a', 'b', 'c'].map((id) =>
          ownerFetcher.getDataItemOwner({
            id,
            parentId: 'parent',
            ownerOffset: 1,
            ownerSize: 9,
            ownerAddress: ADDR,
          }),
        ),
      );

      assert.deepStrictEqual(
        results,
        results.map(() => Buffer.from('testOwner').toString('base64url')),
      );
      assert.strictEqual(getDataMock.mock.calls.length, 1);
    });
  });

  describe('getTransactionOwner', () => {
    it('should return owner from owner store if it exists', async () => {
      mock.method(mocks.ownerStore, 'get', async () => 'owner-from-store');

      const result = await ownerFetcher.getTransactionOwner({
        id: 'id',
      });

      assert.strictEqual(result, 'owner-from-store');
      assert.strictEqual((mocks.ownerStore.set as any).mock.calls.length, 0);
    });

    it('should return owner if attributes exist', async () => {
      mock.method(ownerFetcher, 'getTransactionAttributes', async () => ({
        owner: 'owner',
      }));

      const result = await ownerFetcher.getTransactionOwner({
        id: 'id',
      });

      assert.strictEqual(result, 'owner');
      assert.strictEqual((mocks.ownerStore.set as any).mock.calls.length, 1);
    });

    it('should fetch owner from chain field if no attributes found', async () => {
      mock.method(
        ownerFetcher,
        'getTransactionAttributes',
        async () => undefined,
      );
      mock.method(mocks.chainSource, 'getTxField', async () => 'owner');

      const result = await ownerFetcher.getTransactionOwner({
        id: 'id',
      });

      assert.strictEqual(result, 'owner');
      assert.strictEqual((mocks.ownerStore.set as any).mock.calls.length, 1);
    });

    it('should fetch owner from chain transaction if chain field is empty', async () => {
      mock.method(
        ownerFetcher,
        'getTransactionAttributes',
        async () => undefined,
      );
      mock.method(mocks.chainSource, 'getTxField', async () => '');
      mock.method(mocks.chainSource, 'getTx', async () => ({
        owner: 'owner-from-tx',
        id: 'id',
        signature: null,
        format: 1,
        last_tx: '',
        target: '',
        quantity: '0',
        reward: '0',
        data_size: '0',
        data_root: '',
        tags: [],
      }));

      const result = await ownerFetcher.getTransactionOwner({
        id: 'id',
      });

      assert.strictEqual(result, 'owner-from-tx');
      assert.strictEqual((mocks.ownerStore.set as any).mock.calls.length, 1);
    });

    it('should fetch owner from chain transaction if chain field is undefined', async () => {
      mock.method(
        ownerFetcher,
        'getTransactionAttributes',
        async () => undefined,
      );
      mock.method(mocks.chainSource, 'getTxField', async () => undefined);
      mock.method(mocks.chainSource, 'getTx', async () => ({
        owner: 'owner-from-tx',
        id: 'id',
        signature: null,
        format: 1,
        last_tx: '',
        target: '',
        quantity: '0',
        reward: '0',
        data_size: '0',
        data_root: '',
        tags: [],
      }));

      const result = await ownerFetcher.getTransactionOwner({
        id: 'id',
      });

      assert.strictEqual(result, 'owner-from-tx');
      assert.strictEqual((mocks.ownerStore.set as any).mock.calls.length, 1);
    });

    it('should fetch and return undefined if owner from chain is empty', async () => {
      mock.method(
        ownerFetcher,
        'getTransactionAttributes',
        async () => undefined,
      );
      mock.method(mocks.chainSource, 'getTxField', async () => '');

      const result = await ownerFetcher.getTransactionOwner({
        id: 'id',
      });

      assert.strictEqual(result, undefined);
      assert.strictEqual((mocks.ownerStore.set as any).mock.calls.length, 0);
    });

    it('should return undefined if no owner found anywhere', async () => {
      mock.method(
        ownerFetcher,
        'getTransactionAttributes',
        async () => undefined,
      );
      mock.method(mocks.chainSource, 'getTxField', async () => '');
      mock.method(mocks.chainSource, 'getTx', async () => ({}));

      const result = await ownerFetcher.getTransactionOwner({
        id: 'id',
      });

      assert.strictEqual(result, undefined);
      assert.strictEqual((mocks.ownerStore.set as any).mock.calls.length, 0);
    });

    it('should handle errors and return undefined', async () => {
      mock.method(mocks.dataIndex, 'getTransactionAttributes', async () => {
        throw new Error('Test error');
      });

      const result = await ownerFetcher.getTransactionOwner({
        id: 'id',
      });

      assert.strictEqual(result, undefined);
      assert.strictEqual((mocks.ownerStore.set as any).mock.calls.length, 0);
    });
  });
});

describe('attribute_fetch_total metric labels', () => {
  // Smaller scope than the full behavior matrix above — these tests exist
  // to lock in the (kind, subject, source, outcome) labels emitted from each
  // resolution path so dashboards built on top of this metric stay stable
  // across refactors.
  let mocks: Mocks;
  let signatureFetcher: SignatureFetcher;
  let ownerFetcher: OwnerFetcher;

  const counterValue = async (labels: {
    kind: string;
    subject: string;
    source: string;
    outcome: string;
  }): Promise<number> => {
    const out = await metrics.attributeFetchCounter.get();
    const sample = out.values.find((v) =>
      Object.entries(labels).every(([k, val]) => v.labels[k] === val),
    );
    return sample?.value ?? 0;
  };

  beforeEach(() => {
    metrics.attributeFetchCounter.reset();
    mocks = createMocks();
    signatureFetcher = new SignatureFetcher({
      log,
      dataSource: mocks.dataSource,
      dataIndex: mocks.dataIndex,
      chainSource: mocks.chainSource,
      dataItemAttributesStore: mocks.dataItemAttributesStore,
      transactionAttributesStore: mocks.transactionAttributesStore,
      signatureStore: mocks.signatureStore,
    });
    ownerFetcher = new OwnerFetcher({
      log,
      dataSource: mocks.dataSource,
      dataIndex: mocks.dataIndex,
      chainSource: mocks.chainSource,
      dataItemAttributesStore: mocks.dataItemAttributesStore,
      transactionAttributesStore: mocks.transactionAttributesStore,
      ownerStore: mocks.ownerStore,
    });
  });

  it('signature/data_item/store/hit fires when signatureStore returns a value', async () => {
    mock.method(mocks.signatureStore, 'get', async () => 'cached-sig');
    await signatureFetcher.getDataItemSignature({ id: 'id' });
    assert.equal(
      await counterValue({
        kind: 'signature',
        subject: 'data_item',
        source: 'store',
        outcome: 'hit',
      }),
      1,
    );
  });

  it('signature/data_item/incomplete_root/not_found fires on PE-9073 guard', async () => {
    mock.method(mocks.signatureStore, 'get', async () => undefined);
    mock.method(mocks.dataItemAttributesStore, 'get', async () => undefined);
    mock.method(mocks.dataIndex, 'getDataItemAttributes', async () => ({
      parentId: 'parent',
      // signatureSize=0 trips the incomplete-root-atom guard.
      signatureSize: 0,
      signatureOffset: 0,
      ownerSize: 1,
      ownerOffset: 0,
    }));
    await signatureFetcher.getDataItemSignature({ id: 'id' });
    assert.equal(
      await counterValue({
        kind: 'signature',
        subject: 'data_item',
        source: 'incomplete_root',
        outcome: 'not_found',
      }),
      1,
    );
  });

  it('signature/transaction/chain/hit fires when chainSource returns the field', async () => {
    mock.method(mocks.signatureStore, 'get', async () => undefined);
    mock.method(mocks.dataIndex, 'getTransactionAttributes', async () => ({
      signature: null,
      owner: null,
    }));
    mock.method(mocks.chainSource, 'getTxField', async () => 'chain-sig');
    await signatureFetcher.getTransactionSignature({ id: 'id' });
    assert.equal(
      await counterValue({
        kind: 'signature',
        subject: 'transaction',
        source: 'chain',
        outcome: 'hit',
      }),
      1,
    );
  });

  it('owner/transaction/attributes/hit fires when local DB has owner', async () => {
    mock.method(mocks.ownerStore, 'get', async () => undefined);
    mock.method(mocks.dataIndex, 'getTransactionAttributes', async () => ({
      signature: null,
      owner: 'cached-owner',
    }));
    await ownerFetcher.getTransactionOwner({ id: 'id' });
    assert.equal(
      await counterValue({
        kind: 'owner',
        subject: 'transaction',
        source: 'attributes',
        outcome: 'hit',
      }),
      1,
    );
  });

  it('owner/transaction/derived/hit fires on chainSource.getTx fallback', async () => {
    mock.method(mocks.ownerStore, 'get', async () => undefined);
    mock.method(mocks.dataIndex, 'getTransactionAttributes', async () => ({
      signature: null,
      owner: null,
    }));
    // Empty-string ownerChainField forces the derived-via-getTx path.
    mock.method(mocks.chainSource, 'getTxField', async () => '');
    mock.method(mocks.chainSource, 'getTx', async () => ({
      owner: 'derived-owner',
    }));
    await ownerFetcher.getTransactionOwner({ id: 'id' });
    assert.equal(
      await counterValue({
        kind: 'owner',
        subject: 'transaction',
        source: 'derived',
        outcome: 'hit',
      }),
      1,
    );
  });

  it('aborted error classification: AbortError ⇒ outcome=aborted on chain path', async () => {
    mock.method(mocks.signatureStore, 'get', async () => undefined);
    mock.method(mocks.dataIndex, 'getTransactionAttributes', async () => ({
      signature: null,
      owner: null,
    }));
    mock.method(mocks.chainSource, 'getTxField', async () => {
      const err = new Error('Client disconnected');
      (err as Error & { name: string }).name = 'AbortError';
      throw err;
    });
    await signatureFetcher.getTransactionSignature({ id: 'id' });
    assert.equal(
      await counterValue({
        kind: 'signature',
        subject: 'transaction',
        source: 'chain',
        outcome: 'aborted',
      }),
      1,
    );
  });
});
