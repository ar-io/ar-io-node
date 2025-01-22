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
import {
  ArweaveSigner,
  bundleAndSignData,
  createData,
} from '@dha-team/arbundles';
import Arweave from 'arweave';
import { strict as assert } from 'node:assert';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import {
  getSignatureMeta,
  isValidSignatureConfig,
  processBundleStream,
  readBytes,
} from './bundles.js';

describe('Bundles utilities', () => {
  describe('isValidSignatureConfig', () => {
    it('should return true for valid signature types', () => {
      assert.ok(isValidSignatureConfig(1)); // arweave
      assert.ok(isValidSignatureConfig(2)); // ed25519
      assert.ok(isValidSignatureConfig(3)); // ethereum
      assert.ok(isValidSignatureConfig(4)); // solana
      assert.ok(isValidSignatureConfig(5)); // injectedaptos
      assert.ok(isValidSignatureConfig(6)); // multiaptos
      assert.ok(isValidSignatureConfig(7)); // typedethereum
      assert.equal(isValidSignatureConfig(1000), false); // invalid
    });
  });

  describe('getSignatureMeta', () => {
    it('should return the signature meta data for a valid signature type', () => {
      const arweaveSignatureMeta = getSignatureMeta(1);
      assert.equal(arweaveSignatureMeta.sigLength, 512);
      assert.equal(arweaveSignatureMeta.pubLength, 512);
      assert.equal(arweaveSignatureMeta.sigName, 'arweave');

      const ed25519SignatureMeta = getSignatureMeta(2);
      assert.equal(ed25519SignatureMeta.sigLength, 64);
      assert.equal(ed25519SignatureMeta.pubLength, 32);
      assert.equal(ed25519SignatureMeta.sigName, 'ed25519');

      const ethereumSignatureMeta = getSignatureMeta(3);
      assert.equal(ethereumSignatureMeta.sigLength, 65);
      assert.equal(ethereumSignatureMeta.pubLength, 65);
      assert.equal(ethereumSignatureMeta.sigName, 'ethereum');

      const solanaSignatureMeta = getSignatureMeta(4);
      assert.equal(solanaSignatureMeta.sigLength, 64);
      assert.equal(solanaSignatureMeta.pubLength, 32);
      assert.equal(solanaSignatureMeta.sigName, 'solana');

      const injectedAptosSignatureMeta = getSignatureMeta(5);
      assert.equal(injectedAptosSignatureMeta.sigLength, 64);
      assert.equal(injectedAptosSignatureMeta.pubLength, 32);
      assert.equal(injectedAptosSignatureMeta.sigName, 'injectedAptos');

      const multiAptosSignatureMeta = getSignatureMeta(6);
      assert.equal(multiAptosSignatureMeta.sigLength, 2052);
      assert.equal(multiAptosSignatureMeta.pubLength, 1025);
      assert.equal(multiAptosSignatureMeta.sigName, 'multiAptos');

      const typedEthereumSignatureMeta = getSignatureMeta(7);
      assert.equal(typedEthereumSignatureMeta.sigLength, 65);
      assert.equal(typedEthereumSignatureMeta.pubLength, 42);
      assert.equal(typedEthereumSignatureMeta.sigName, 'typedEthereum');

      try {
        getSignatureMeta(1000);
        assert.fail('Expected an error to be thrown');
      } catch (error: any) {
        assert.equal(error.message, 'Invalid signature type');
      }
    });
  });

  describe('readBytes', () => {
    describe('should read the correct number of bytes from a reader', () => {
      async function* generateBuffers(buffers: Buffer[]) {
        for (const buffer of buffers) {
          yield buffer;
        }
      }

      it('when the buffer already has the required length', async () => {
        const initialBuffer = Buffer.from('abcd');
        const reader = generateBuffers([]);
        const result = await readBytes(reader, initialBuffer, 4);
        assert.equal(result, initialBuffer);
      });

      it('when the buffer needs more data', async () => {
        const initialBuffer = Buffer.from('abc');
        const additionalBuffers = [Buffer.from('d'), Buffer.from('ef')];
        const reader = generateBuffers(additionalBuffers);
        const result = await readBytes(reader, initialBuffer, 4);
        assert.deepEqual(result, Buffer.from('abcd'));
      });

      it('when the reader does not provide enough data', async () => {
        const initialBuffer = Buffer.from('abc');
        const additionalBuffers = [Buffer.from('d')];
        const reader = generateBuffers(additionalBuffers);

        await assert.rejects(
          async () => {
            await readBytes(reader, initialBuffer, 6);
          },
          {
            name: 'Error',
            message: 'Invalid buffer',
          },
          'Invalid buffer error.',
        );
      });

      it('when the reader provides exactly enough data', async () => {
        const initialBuffer = Buffer.from('a');
        const additionalBuffers = [Buffer.from('bc'), Buffer.from('def')];
        const reader = generateBuffers(additionalBuffers);
        const result = await readBytes(reader, initialBuffer, 6);
        assert.deepEqual(result, Buffer.from('abcdef'));
      });
    });
  });

  describe('processBundleStream', async () => {
    const arweave = Arweave.init({});
    const arweaveWallet = await arweave.wallets.generate();

    it('should process a bundle stream', async () => {
      const signer = new ArweaveSigner(arweaveWallet);
      const owner = Buffer.from(signer.publicKey).toString('base64url');

      const helloItem = createData('hello', signer);
      const emptyItem = createData('', signer);

      const bundle = await bundleAndSignData([helloItem, emptyItem], signer);

      const stream = Readable.from(bundle.getRaw());
      const processedBundleStream = await processBundleStream(stream);

      const initialDataOffset = 160;
      const signatureType = 1;
      const signatureTypeSize = 2;
      const signatureSize = 512;
      const ownerSize = 512;
      const targetSize = 1;
      const anchorSize = 1;
      const numTagsSize = 8;
      const numTagBytesSize = 8;

      const sizeWithoutData =
        signatureTypeSize +
        signatureSize +
        ownerSize +
        targetSize +
        anchorSize +
        numTagsSize +
        numTagBytesSize;

      const initialSecondaDataItemInitialOffset =
        initialDataOffset + sizeWithoutData + Buffer.byteLength('hello');

      const expectedDataItemInfo = [
        {
          offset: initialDataOffset,
          signatureOffset: initialDataOffset + signatureTypeSize,
          ownerOffset: initialDataOffset + signatureTypeSize + signatureSize,
          size: sizeWithoutData + Buffer.byteLength('hello'),
          dataOffset: initialDataOffset + sizeWithoutData,
          anchor: '',
          dataSize: Buffer.byteLength('hello'),
          id: bundle.items[0].id,
          owner,
          ownerSize: ownerSize,
          sigName: 'arweave',
          signature: bundle.items[0].signature,
          signatureSize,
          signatureType,
          tags: [],
          target: '',
        },
        {
          offset: initialSecondaDataItemInitialOffset,
          signatureOffset:
            initialSecondaDataItemInitialOffset + signatureTypeSize,
          ownerOffset:
            initialSecondaDataItemInitialOffset +
            signatureTypeSize +
            signatureSize,
          size: sizeWithoutData + Buffer.byteLength(''),
          dataOffset: initialSecondaDataItemInitialOffset + sizeWithoutData,
          anchor: '',
          dataSize: Buffer.byteLength(''),
          id: bundle.items[1].id,
          owner,
          ownerSize,
          sigName: 'arweave',
          signature: bundle.items[1].signature,
          signatureSize,
          signatureType,
          tags: [],
          target: '',
        },
      ];

      for (let i = 0; i < processedBundleStream.length; i++) {
        const dataItem = processedBundleStream[i];

        assert.deepEqual(dataItem, expectedDataItemInfo[i]);
      }
    });

    it('should throw an error for malformed data in the stream', async () => {
      const malformedData = Readable.from([Buffer.from('malformed data')]);
      await assert.rejects(
        async () => {
          await processBundleStream(malformedData);
        },
        {
          name: 'Error',
          message: 'Invalid buffer',
        },
        'Expected processBundleStream to throw an error for malformed data',
      );
    });

    it('should handle incomplete data stream gracefully', async () => {
      const incompleteData = Readable.from([Buffer.from('incomplete')]);
      incompleteData.destroy(new Error('Stream interrupted'));
      await assert.rejects(
        async () => {
          await processBundleStream(incompleteData);
        },
        {
          name: 'Error',
          message: 'Stream interrupted',
        },
        'Expected processBundleStream to handle incomplete stream',
      );
    });
  });
});
