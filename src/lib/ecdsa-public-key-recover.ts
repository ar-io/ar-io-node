/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
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
