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

import Transaction from 'arweave/node/lib/transaction.js';
import { SECP256k1PublicKey } from 'arweave/node/lib/crypto/keys/index.js';

import { PartialJsonTransaction } from '../types.js';

export const secp256k1OwnerFromTx = async (tx: PartialJsonTransaction) => {
  if (tx.signature === null) {
    throw new Error(
      'secp256k1OwnerFromTx error: transaction has no signature, cannot recover owner',
    );
  }
  const transaction = new (Transaction as any).default(tx);
  const signatureData = await transaction.getSignatureData();
  const publicKey = await SECP256k1PublicKey.recover({
    payload: signatureData,
    isDigest: false,
    signature: Buffer.from(tx.signature, 'base64url'),
  });

  return Buffer.from(await publicKey.identifier()).toString('base64url');
};
