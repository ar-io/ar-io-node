/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';

import Arweave from 'arweave';
import winston from 'winston';

import { Attestation } from './httpsig.js';

export interface AttestationUploadOpts {
  jwk: crypto.JsonWebKey;
  attestation: Attestation;
  gatewayAddress: string | undefined;
  observerAddress: string;
  ed25519PublicKey: string;
  keyId: string;
  log: winston.Logger;
}

/**
 * Build the Arweave transaction tags for an HTTPSIG attestation upload.
 */
export function buildAttestationTags(opts: {
  gatewayAddress: string | undefined;
  observerAddress: string;
  ed25519PublicKey: string;
  keyId: string;
}): { name: string; value: string }[] {
  const tags: { name: string; value: string }[] = [
    { name: 'App-Name', value: 'AR-IO-Gateway' },
    { name: 'Type', value: 'HTTPSIG-Key-Attestation' },
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Observer-Address', value: opts.observerAddress },
    { name: 'Ed25519-Public-Key', value: opts.ed25519PublicKey },
    { name: 'Key-Id', value: opts.keyId },
  ];
  if (opts.gatewayAddress !== undefined) {
    tags.push({ name: 'Gateway-Address', value: opts.gatewayAddress });
  }
  return tags;
}

/**
 * Try to upload via Turbo SDK. Returns the data item ID on success, or
 * undefined if the SDK is not installed (production builds strip devDeps).
 */
async function tryTurboUpload(
  jwk: crypto.JsonWebKey,
  attestationJson: string,
  tags: { name: string; value: string }[],
): Promise<string | undefined> {
  try {
    // turbo-sdk is a devDependency — may not be present in production.
    // Use createRequire to load via CJS (same pattern as
    // tools/lib/upload-cdb64-to-arweave.ts).
    const require = createRequire(import.meta.url);
    const { TurboFactory, ArweaveSigner } = require('@ardrive/turbo-sdk');

    const signer = new ArweaveSigner(jwk);
    const turbo = TurboFactory.authenticated({ signer });

    const result = await turbo.uploadFile({
      fileStreamFactory: () => Readable.from(Buffer.from(attestationJson)),
      fileSizeFactory: () => Buffer.byteLength(attestationJson),
      dataItemOpts: { tags },
    });

    return result.id;
  } catch {
    // SDK not available or upload failed — caller will fall back to L1
    return undefined;
  }
}

/**
 * Upload an HTTPSIG attestation to Arweave. Tries Turbo SDK first (if
 * available), then falls back to direct L1 posting via arweave.js.
 *
 * @returns The Arweave transaction/data-item ID.
 */
export async function uploadAttestation(
  opts: AttestationUploadOpts,
): Promise<string> {
  const {
    jwk,
    attestation,
    gatewayAddress,
    observerAddress,
    ed25519PublicKey,
    keyId,
    log,
  } = opts;

  const tags = buildAttestationTags({
    gatewayAddress,
    observerAddress,
    ed25519PublicKey,
    keyId,
  });

  const attestationJson = JSON.stringify(attestation);

  // Try Turbo SDK first (subsidized bundled upload)
  const turboId = await tryTurboUpload(jwk, attestationJson, tags);
  if (turboId !== undefined) {
    log.info('HTTPSIG attestation uploaded via Turbo', { txId: turboId });
    return turboId;
  }

  log.info('Turbo SDK not available, uploading attestation via L1');

  // Fallback: direct L1 transaction via arweave.js
  const arweave = Arweave.init({
    host: 'arweave.net',
    port: 443,
    protocol: 'https',
  });

  // Cast to any — the JWK has been validated by loadWalletJwk() upstream.
  // arweave.js expects its own JWKInterface type which is structurally
  // identical but not assignable from crypto.JsonWebKey.
  const jwkAny = jwk as any;
  const tx = await arweave.createTransaction({ data: attestationJson }, jwkAny);
  for (const tag of tags) {
    tx.addTag(tag.name, tag.value);
  }

  await arweave.transactions.sign(tx, jwkAny);
  const response = await arweave.transactions.post(tx);

  // Arweave POST /tx returns 200 (accepted) or 202 (accepted for mempool)
  if (response.status !== 200 && response.status !== 202) {
    throw new Error(
      `Failed to post attestation L1 transaction: ${response.status}`,
    );
  }

  log.info('HTTPSIG attestation uploaded via L1', { txId: tx.id });

  return tx.id;
}
