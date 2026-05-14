/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import crypto from 'node:crypto';
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  constants as fsConstants,
} from 'node:fs';
import { dirname } from 'node:path';

// @ts-expect-error bs58 v4 has no type declarations
import bs58 from 'bs58';

/**
 * Trust-triggering headers (lowercase). Presence of at least one of these on
 * a response indicates the response is trust-relevant and should be signed.
 * Endpoints that emit none of these (admin, /ar-io/info, GraphQL, health
 * checks, generic errors) are auto-excluded from signing.
 */
export const TRIGGER_HEADERS = new Set([
  'x-ar-io-data-id',
  'x-ar-io-verified',
  'x-ar-io-stable',
  'x-ar-io-trusted',
  'x-ar-io-root-transaction-id',
  'x-arweave-owner-address',
  'x-arweave-tags-truncated',
  'x-arns-name',
  'x-arns-resolved-id',
  'x-arns-ttl-seconds',
  'x-arns-ant-program-id',
  'x-arns-ant-id',
  'x-arweave-chunk-data-root',
  'x-arweave-chunk-tx-id',
  'x-ar-io-chunk-source-type',
]);

/**
 * Co-signable headers (lowercase). These are included in the signature ONLY
 * when at least one TRIGGER_HEADER is also present. Signing them alone is too
 * broad — nearly every response has a Content-Type.
 */
export const CO_SIGNABLE_HEADERS = new Set(['content-type', 'content-digest']);

// Header predicates normalize case defensively, but callers should pass
// lowercase where possible. Express's `res.getHeaders()` keys are already
// lowercase, so the hot-path middleware avoids redundant work.

/**
 * Returns true if the given header name should be included in the signature
 * base when a trigger header is already known to be present on the response.
 */
export function isSignableHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    TRIGGER_HEADERS.has(lower) ||
    CO_SIGNABLE_HEADERS.has(lower) ||
    lower.startsWith('x-arweave-tag-')
  );
}

/**
 * Returns true if the header is a trust-trigger — its presence means the
 * response is trust-relevant and should be signed.
 */
export function isTriggerHeader(name: string): boolean {
  return TRIGGER_HEADERS.has(name.toLowerCase());
}

// Ed25519 SPKI DER has a fixed 12-byte prefix before the raw 32-byte public key.
const SPKI_ED25519_PREFIX_LENGTH = 12;

// Ed25519 PKCS8 DER has a fixed 16-byte prefix before the raw 32-byte seed.
const PKCS8_ED25519_PREFIX = Buffer.from(
  '302e020100300506032b657004220420',
  'hex',
);

/**
 * Load an Ed25519 private key from a Solana keypair file. The file contains a
 * JSON array of 64 bytes — the first 32 bytes are the Ed25519 seed (private
 * key), the last 32 are the public key.
 */
export function loadSolanaKeypair(keypairPath: string): crypto.KeyObject {
  let raw: string;
  try {
    raw = readFileSync(keypairPath, 'utf8');
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      throw new Error(`Solana keypair file not found: ${keypairPath}`);
    }
    throw err;
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(JSON.parse(raw));
  } catch {
    throw new Error(`Invalid Solana keypair JSON: ${keypairPath}`);
  }

  if (bytes.length !== 64) {
    throw new Error(
      `Invalid Solana keypair: expected 64 bytes, got ${bytes.length}`,
    );
  }

  const seed = bytes.slice(0, 32);
  return crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]),
    format: 'der',
    type: 'pkcs8',
  });
}

/**
 * Load an Ed25519 private key from a PEM file, or generate a new keypair and
 * persist it if the file does not exist.
 */
export function loadOrGenerateKey(keyFile: string): crypto.KeyObject {
  if (existsSync(keyFile)) {
    return crypto.createPrivateKey(readFileSync(keyFile, 'utf8'));
  }

  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

  mkdirSync(dirname(keyFile), { recursive: true });

  // Write to temp file then hard-link into place for atomicity. linkSync
  // fails with EEXIST if another process already installed the key file,
  // preventing overwrites. This is safer than renameSync which silently
  // replaces the target.
  const tmpFile = `${keyFile}.tmp.${process.pid}`;
  try {
    const fd = openSync(
      tmpFile,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    );
    try {
      writeFileSync(fd, pem);
    } finally {
      closeSync(fd);
    }
    linkSync(tmpFile, keyFile);
  } catch (err: any) {
    if (err.code === 'EEXIST' && existsSync(keyFile)) {
      // Another process won the race — load their key
      return crypto.createPrivateKey(readFileSync(keyFile, 'utf8'));
    }
    throw err;
  } finally {
    // Always clean up temp file
    try {
      unlinkSync(tmpFile);
    } catch {
      // Ignore
    }
  }

  return privateKey;
}

/**
 * Extract the raw 32-byte Ed25519 public key from a KeyObject.
 */
function getRawPublicKey(publicKey: crypto.KeyObject): Buffer {
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  return spkiDer.subarray(SPKI_ED25519_PREFIX_LENGTH);
}

/**
 * Derive a self-contained key identifier from an Ed25519 public key.
 * Returns `ed25519:<base64url-encoded-32-byte-public-key>` so that verifiers
 * can extract the public key directly from the Signature-Input header without
 * needing to fetch /ar-io/info.
 */
export function deriveKeyId(publicKey: crypto.KeyObject): string {
  return `ed25519:${getPublicKeyBase64Url(publicKey)}`;
}

/**
 * Export the raw 32-byte Ed25519 public key as a base64url string (43 chars).
 */
export function getPublicKeyBase64Url(publicKey: crypto.KeyObject): string {
  return getRawPublicKey(publicKey).toString('base64url');
}

/**
 * Derive the Solana address from an Ed25519 public key.
 * A Solana address is the base58 encoding of the raw 32-byte public key.
 */
export function getSolanaAddress(publicKey: crypto.KeyObject): string {
  return bs58.encode(getRawPublicKey(publicKey));
}

/**
 * Build the covered components list and the Signature-Input structured field
 * value per RFC 9421. `coveredHeaders` names are normalized to lowercase.
 *
 * @returns The Signature-Input value (without the "sig1=" prefix).
 */
export function formatSignatureInput(
  coveredHeaders: string[],
  created: number,
  keyId: string,
  bindRequest: boolean,
): string {
  const components: string[] = ['"@status"'];
  for (const h of coveredHeaders) {
    components.push(`"${h.toLowerCase()}"`);
  }
  if (bindRequest) {
    components.push('"@method";req');
    components.push('"@path";req');
  }

  return (
    `(${components.join(' ')});created=${created}` +
    `;keyid="${keyId}";alg="ed25519"`
  );
}

/**
 * Construct the signature base string per RFC 9421 Section 2.5.
 * `coveredHeaders` names are normalized to lowercase.
 *
 * Each covered component becomes a line: `"component": value`
 * The final line is: `"@signature-params": <params>`
 * Lines are joined by a single newline (0x0A) with no trailing newline.
 *
 * @returns `{ base, paramStr }` — `paramStr` is the Signature-Input value
 *   (without the "sig1=" prefix), reused by the middleware to avoid a second
 *   call to `formatSignatureInput`.
 */
export function buildSignatureBase(
  statusCode: number,
  getHeader: (name: string) => string | number | string[] | undefined,
  coveredHeaders: string[],
  method: string,
  path: string,
  bindRequest: boolean,
  created: number,
  keyId: string,
): { base: string; paramStr: string } {
  const paramStr = formatSignatureInput(
    coveredHeaders,
    created,
    keyId,
    bindRequest,
  );

  const lines: string[] = [`"@status": ${statusCode}`];
  for (const h of coveredHeaders) {
    const value = getHeader(h);
    // Multi-value headers (from res.append) are arrays; RFC 9421 Section 2.1
    // requires the comma-separated field value representation.
    const serialized = Array.isArray(value) ? value.join(', ') : String(value);
    lines.push(`"${h.toLowerCase()}": ${serialized}`);
  }
  if (bindRequest) {
    lines.push(`"@method";req: ${method}`);
    lines.push(`"@path";req: ${path}`);
  }
  lines.push(`"@signature-params": ${paramStr}`);

  return { base: lines.join('\n'), paramStr };
}

// --- Startup init (called from config.ts) ---

/**
 * Ed25519 signing-side state. Always populated together when HTTPSIG is
 * enabled, so consumers can narrow through a single `if (signer)` check.
 */
export interface HttpSigSignerContext {
  privateKey: crypto.KeyObject;
  keyId: string;
  publicKeyB64Url: string;
  solanaAddress: string;
}

/**
 * Initialize HTTPSIG signing state from resolved configuration. When an
 * observer keypair path is provided the signing key is loaded from that
 * Solana keypair file; otherwise a standalone Ed25519 PEM is auto-generated
 * at `keyFile`. The observer keypair path is preferred because it ties the
 * HTTPSIG identity directly to the on-chain observer address, making
 * verification a simple GAR lookup with no attestation document needed.
 */
export function initHttpSig(opts: {
  keyFile: string;
  observerKeypairPath: string | undefined;
  log: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}): HttpSigSignerContext {
  const { keyFile, observerKeypairPath, log } = opts;

  let privateKey: crypto.KeyObject;
  let keySource: string;

  if (observerKeypairPath !== undefined) {
    privateKey = loadSolanaKeypair(observerKeypairPath);
    keySource = observerKeypairPath;
  } else {
    privateKey = loadOrGenerateKey(keyFile);
    keySource = keyFile;
  }

  const publicKey = crypto.createPublicKey(privateKey);
  const signer: HttpSigSignerContext = {
    privateKey,
    keyId: deriveKeyId(publicKey),
    publicKeyB64Url: getPublicKeyBase64Url(publicKey),
    solanaAddress: getSolanaAddress(publicKey),
  };

  log.info('HTTPSIG response signing enabled', {
    keyId: signer.keyId,
    publicKey: signer.publicKeyB64Url,
    solanaAddress: signer.solanaAddress,
    keySource,
    observerKeypair: observerKeypairPath !== undefined,
  });

  return signer;
}
