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
import { describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import { fromJWK } from 'arweave/node/lib/crypto/keys/index.js';
import { secp256k1OwnerFromTx } from './ecdsa-public-key-recover.js';
import Arweave from 'arweave';

const sha256 = (buffer: Buffer): Buffer => {
  return createHash('sha256').update(buffer).digest();
};

// These are our test wallet keys (JWK format) and the expected public key identifier.
const testWallet1PrivateKeyJWK = {
  kty: 'EC',
  crv: 'secp256k1',
  x: 'pb_d7Za6sUEE_5lQh2w6mrHBVye82IkUb7FxD_2h2OU',
  y: 'nZrLB1o4uE1HmUboxwo1Fyz3woK6ByXb--y2lctTSCM',
  d: 'xwYu-R8XSMWYAxNrQQ5reE-pcy7f0jWgiNer-jtHDT8',
};

const testWallet1PrivateKey = await fromJWK(testWallet1PrivateKeyJWK);

const testWallet1Address = 'Z7RxkVjLHgAniUGeEpjnaLuSYEK5RKk2Uij497DawmQ';
const testWallet1PublicKey = 'A6W_3e2WurFBBP-ZUIdsOpqxwVcnvNiJFG-xcQ_9odjl';

describe('secp256k1OwnerFromTx', () => {
  it('should throw an error if the transaction has no signature', async () => {
    // Create a dummy tx object without a signature.
    const txWithoutSignature: any = { signature: null };

    await assert.rejects(
      async () => {
        await secp256k1OwnerFromTx(txWithoutSignature);
      },
      {
        message: /transaction has no signature/,
      },
    );
  });

  it('should recover the correct owner from a signed transaction', async () => {
    // Initialize an Arweave instance.
    const arweave = Arweave.init({
      host: 'arweave.net',
      port: 443,
      protocol: 'https',
    });

    // Create a transaction with some dummy data.
    const tx = await arweave.createTransaction(
      { data: 'Test data for signature recovery' },
      testWallet1PrivateKey,
    );

    await arweave.transactions.sign(tx, testWallet1PrivateKey);

    // Convert the transaction to its JSON representation.
    const txJson = tx.toJSON();

    // Use our function to recover the owner from the signed transaction.
    const recoveredOwner = await secp256k1OwnerFromTx(txJson);

    // Assert that the recovered owner matches the expected public key.
    assert.equal(recoveredOwner, testWallet1PublicKey);

    // Assert that the recovered owner matches the expected address.
    const recoveredAddress = sha256(
      Buffer.from(recoveredOwner, 'base64url'),
    ).toString('base64url');

    assert.equal(recoveredAddress, testWallet1Address);
  });
});
