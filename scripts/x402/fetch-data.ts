/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { type Signer, wrapFetchWithPayment } from 'x402-fetch';
import { privateKeyToAccount } from 'viem/accounts';

// Get transaction ID from command line arguments
const txId = process.argv[2];
if (!txId) {
  console.error('Usage: node fetch-data.ts <transaction-id>');
  process.exit(1);
}

// Create a wallet client (using your private key)
const privateKey = process.env.X402_TEST_PRIVATE_KEY as
  | `0x${string}`
  | undefined;
if (privateKey === undefined) {
  throw new Error('X402_TEST_PRIVATE_KEY environment variable is not set');
}
const account = privateKeyToAccount(privateKey);

// x402-fetch resolves its own nested copy of viem, so the account type from
// the top-level viem is structurally the same but nominally distinct. The
// cast only bridges the duplicate package types; the value is unchanged.
const fetchWithPayment = wrapFetchWithPayment(
  fetch,
  account as unknown as Signer,
);

fetchWithPayment(`http://localhost:4000/${txId}`, { method: 'GET' })
  .then(async (response) => {
    if (response.status !== 200) {
      const details = await response.json();
      throw new Error(
        `Request failed with status ${response.status}: ${JSON.stringify(details)}`,
      );
    }

    // print out all the headers
    console.log('\n-----Response Headers-----');
    console.log('status:', response.status);
    console.log('statusText:', response.statusText);
    response.headers.forEach((value, name) => {
      console.log(`${name}: ${value}`);
    });
  })
  .catch((error) => {
    console.error(error);
  });
