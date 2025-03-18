/**
 * AR.IO Gateway
 * Copyright (C) 2022-2023 Permanent Data Solutions, Inc. All Rights Reserved.
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

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, mock } from 'node:test';
import * as winston from 'winston';
import {
  AttributeFetcher,
  OwnerFetcher,
  SignatureFetcher,
} from './attribute-fetcher.js';
import {
  ContiguousDataSource,
  ContiguousDataIndex,
  DataItemAttributesStore,
  TransactionAttributesStore,
  ChainSource,
  B64UrlStore,
} from '../types.js';

const log = winston.createLogger({ silent: true });
interface Mocks {
  dataSource: ContiguousDataSource;
  dataIndex: ContiguousDataIndex;
  chainSource: ChainSource;
  signatureStore: B64UrlStore;
  ownerStore: B64UrlStore;
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
  } as unknown as B64UrlStore,
  ownerStore: {
    get: mock.fn(),
    set: mock.fn(),
  } as unknown as B64UrlStore,
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
  let attributeFetcher: AttributeFetcher;

  beforeEach(() => {
    mocks = createMocks();

    attributeFetcher = new AttributeFetcher({
      log,
      dataSource: mocks.dataSource,
      dataIndex: mocks.dataIndex,
      dataItemAttributesStore: mocks.dataItemAttributesStore,
      transactionAttributesStore: mocks.transactionAttributesStore,
    });
  });

  describe('fetchDataFromParent', () => {
    it('should fetch and return data from parent', async () => {
      const testBuffer = Buffer.from('testData');
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
        size: 512,
      });

      assert.strictEqual(result, testBuffer.toString('base64url'));
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
        signatureSize: 2,
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
        signatureSize: 2,
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
        ownerSize: 2,
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
        ownerSize: 2,
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
