/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import {
  ArweaveSigner,
  DataItem,
  EthereumSigner,
  HexSolanaSigner,
  Signer,
  SolanaSigner,
  createData,
} from '@dha-team/arbundles';
import Arweave from 'arweave';
// @ts-expect-error bs58 v4 has no type declarations
import bs58 from 'bs58';
import { strict as assert } from 'node:assert';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { before, describe, it } from 'node:test';

import {
  DataItemSignedFields,
  DataItemVerificationError,
  VerifyingPayloadStream,
  dataItemSignatureMessage,
  isSupportedSignatureType,
  verifyDataItemSignature,
} from './data-item-signature.js';

const signedFieldsOf = (item: DataItem): DataItemSignedFields => ({
  signatureType: item.signatureType,
  signature: item.rawSignature,
  owner: item.rawOwner,
  target: item.rawTarget,
  anchor: item.rawAnchor,
  tagsBytes: item.rawTags,
});

const sha384 = (data: Uint8Array): Buffer =>
  createHash('sha384').update(data).digest();

/** A base58 64-byte Solana secret key (seed followed by public key). */
function createSolanaSecret(): string {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey
    .export({ format: 'der', type: 'pkcs8' })
    .subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return bs58.encode(Buffer.concat([seed, pub]));
}

const createSolanaSigner = (): SolanaSigner =>
  new SolanaSigner(createSolanaSecret());

async function signedItem(
  signer: Signer,
  payload: Buffer | string,
  opts?: Parameters<typeof createData>[2],
): Promise<DataItem> {
  const item = createData(payload, signer, opts);
  await item.sign(signer);
  return item;
}

/** Pipes chunks through the verifier, collecting output and any error. */
async function runVerifier(
  verifier: VerifyingPayloadStream,
  chunks: Buffer[],
): Promise<{ output: Buffer; error?: unknown }> {
  const collected: Buffer[] = [];
  const done = (async () => {
    try {
      for await (const chunk of verifier) {
        collected.push(chunk as Buffer);
      }
      return undefined;
    } catch (error) {
      return error;
    }
  })();
  Readable.from(chunks).pipe(verifier);
  const error = await done;
  return { output: Buffer.concat(collected), error };
}

/** Splits a buffer into chunks of at most `size` bytes. */
function chunked(buffer: Buffer, size: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < buffer.length; offset += size) {
    chunks.push(buffer.subarray(offset, offset + size));
  }
  return chunks;
}

describe('data-item-signature', () => {
  let arweaveSigner: ArweaveSigner;

  before(async () => {
    arweaveSigner = new ArweaveSigner(
      await Arweave.init({}).wallets.generate(),
    );
  });

  describe('isSupportedSignatureType', () => {
    it('recognises the signature types arbundles can verify', () => {
      for (const type of [1, 2, 3, 4, 5, 6, 7]) {
        assert.equal(isSupportedSignatureType(type), true);
      }
      assert.equal(isSupportedSignatureType(0), false);
      assert.equal(isSupportedSignatureType(99), false);
    });
  });

  describe('dataItemSignatureMessage', () => {
    it('matches arbundles for an item with target, anchor and tags', async () => {
      const item = await signedItem(arweaveSigner, randomBytes(3000), {
        target: randomBytes(32).toString('base64url'),
        anchor: 'a'.repeat(32),
        tags: [
          { name: 'Content-Type', value: 'image/png' },
          { name: 'App-Name', value: 'signature-test' },
        ],
      });

      assert.deepEqual(
        dataItemSignatureMessage(
          signedFieldsOf(item),
          sha384(item.rawData),
          item.rawData.length,
        ),
        Buffer.from(await item.getSignatureData()),
      );
    });

    it('matches arbundles for an item with no target, anchor, tags or payload', async () => {
      const item = await signedItem(arweaveSigner, '');

      assert.deepEqual(
        dataItemSignatureMessage(
          signedFieldsOf(item),
          sha384(Buffer.alloc(0)),
          0,
        ),
        Buffer.from(await item.getSignatureData()),
      );
    });
  });

  describe('verifyDataItemSignature', () => {
    const signers: Array<[string, () => Signer]> = [
      ['Arweave (type 1)', () => arweaveSigner],
      ['Solana ed25519 (type 2)', () => createSolanaSigner()],
      [
        'Ethereum (type 3)',
        () => new EthereumSigner(randomBytes(32).toString('hex')),
      ],
      [
        'Solana hex-encoded message (type 4)',
        () => new HexSolanaSigner(createSolanaSecret()),
      ],
    ];

    for (const [name, makeSigner] of signers) {
      it(`accepts a valid ${name} signature and rejects a tampered message`, async () => {
        const item = await signedItem(makeSigner(), 'payload bytes', {
          tags: [{ name: 'Content-Type', value: 'text/plain' }],
        });
        const fields = signedFieldsOf(item);
        const message = dataItemSignatureMessage(
          fields,
          sha384(item.rawData),
          item.rawData.length,
        );

        assert.equal(await verifyDataItemSignature(fields, message), true);

        const tampered = Buffer.from(message);
        tampered[0] ^= 0xff;
        assert.equal(await verifyDataItemSignature(fields, tampered), false);
      });
    }

    it('agrees with the arbundles ed25519 verifier', async () => {
      const item = await signedItem(createSolanaSigner(), randomBytes(500));
      const fields = signedFieldsOf(item);
      const message = dataItemSignatureMessage(
        fields,
        sha384(item.rawData),
        item.rawData.length,
      );
      // Corrupt the second half (S) so the signature still parses but no longer
      // matches. @noble throws instead of returning false for some malformed
      // signatures; either way it counts as invalid.
      const badSignature = Buffer.from(fields.signature);
      badSignature[40] ^= 0x01;
      const nobleVerify = async (signature: Buffer): Promise<boolean> => {
        try {
          return await SolanaSigner.verify(fields.owner, message, signature);
        } catch {
          return false;
        }
      };

      for (const signature of [fields.signature, badSignature]) {
        assert.equal(
          await verifyDataItemSignature({ ...fields, signature }, message),
          await nobleVerify(signature),
        );
      }
      assert.equal(
        await verifyDataItemSignature(
          { ...fields, signature: badSignature },
          message,
        ),
        false,
      );
    });

    it('treats a malformed ed25519 key as an invalid signature', async () => {
      const item = await signedItem(createSolanaSigner(), 'x');
      const fields = { ...signedFieldsOf(item), owner: Buffer.alloc(5) };

      assert.equal(
        await verifyDataItemSignature(fields, Buffer.alloc(48)),
        false,
      );
    });

    it('throws for a signature type with no verifier', async () => {
      const item = await signedItem(createSolanaSigner(), 'x');

      await assert.rejects(
        verifyDataItemSignature(
          { ...signedFieldsOf(item), signatureType: 99 },
          Buffer.alloc(48),
        ),
        (error: unknown) =>
          error instanceof DataItemVerificationError &&
          error.reason === 'unsupported_signature_type',
      );
    });
  });

  describe('VerifyingPayloadStream', () => {
    it('passes a valid payload through unchanged', async () => {
      const item = await signedItem(createSolanaSigner(), randomBytes(10_000));
      let verified = 0;
      let rejected = 0;

      const { output, error } = await runVerifier(
        new VerifyingPayloadStream({
          fields: signedFieldsOf(item),
          payloadSize: item.rawData.length,
          onVerified: () => verified++,
          onRejected: () => rejected++,
        }),
        chunked(item.rawData, 1024),
      );

      assert.equal(error, undefined);
      assert.deepEqual(output, item.rawData);
      assert.equal(verified, 1);
      assert.equal(rejected, 0);
    });

    it('verifies an empty payload', async () => {
      const item = await signedItem(arweaveSigner, '');

      const { output, error } = await runVerifier(
        new VerifyingPayloadStream({
          fields: signedFieldsOf(item),
          payloadSize: 0,
        }),
        [],
      );

      assert.equal(error, undefined);
      assert.equal(output.length, 0);
    });

    it('rejects tampered bytes without releasing the final chunk', async () => {
      const item = await signedItem(createSolanaSigner(), randomBytes(10_000));
      const tampered = Buffer.from(item.rawData);
      tampered[5000] ^= 0xff;
      const rejections: DataItemVerificationError[] = [];
      let verified = 0;

      const { output, error } = await runVerifier(
        new VerifyingPayloadStream({
          fields: signedFieldsOf(item),
          payloadSize: tampered.length,
          onVerified: () => verified++,
          onRejected: (rejection) => rejections.push(rejection),
        }),
        chunked(tampered, 1024),
      );

      assert.ok(error instanceof DataItemVerificationError);
      assert.equal(error.reason, 'invalid_signature');
      assert.ok(output.length < tampered.length);
      assert.equal(verified, 0);
      assert.equal(rejections.length, 1);
    });

    it('rejects a payload shorter than the expected size', async () => {
      const item = await signedItem(createSolanaSigner(), randomBytes(4000));

      const { output, error } = await runVerifier(
        new VerifyingPayloadStream({
          fields: signedFieldsOf(item),
          // As if the size came from a hint claiming a longer item.
          payloadSize: item.rawData.length + 100,
        }),
        chunked(item.rawData, 1024),
      );

      assert.ok(error instanceof DataItemVerificationError);
      assert.equal(error.reason, 'size_mismatch');
      assert.ok(output.length < item.rawData.length);
    });

    it('rejects bytes beyond the expected size', async () => {
      const item = await signedItem(createSolanaSigner(), randomBytes(4000));

      const { output, error } = await runVerifier(
        new VerifyingPayloadStream({
          fields: signedFieldsOf(item),
          payloadSize: item.rawData.length - 1,
        }),
        chunked(item.rawData, 1024),
      );

      assert.ok(error instanceof DataItemVerificationError);
      assert.equal(error.reason, 'size_mismatch');
      assert.ok(output.length < item.rawData.length - 1);
    });

    it('rejects a truncated size that still frames a plausible payload', async () => {
      // A size smaller than the real item frames a prefix of the payload: the
      // length checks pass, and only the signature exposes it.
      const item = await signedItem(createSolanaSigner(), randomBytes(4000));
      const prefix = item.rawData.subarray(0, 3000);

      const { output, error } = await runVerifier(
        new VerifyingPayloadStream({
          fields: signedFieldsOf(item),
          payloadSize: prefix.length,
        }),
        chunked(prefix, 1024),
      );

      assert.ok(error instanceof DataItemVerificationError);
      assert.equal(error.reason, 'invalid_signature');
      assert.ok(output.length < prefix.length);
    });
  });
});
