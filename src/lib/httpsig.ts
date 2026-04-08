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
  renameSync,
  unlinkSync,
  writeFileSync,
  constants as fsConstants,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

// @ts-expect-error bs58 v4 has no type declarations
import bs58 from 'bs58';
import { canonicalize } from 'json-canonicalize';

/**
 * Exact-match header names (lowercase) that are trust-relevant and should be
 * included in HTTP message signatures when present on a response.
 */
export const SIGNABLE_HEADERS = new Set([
  'content-type',
  'content-digest',
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
  'x-arns-process-id',
  'x-arweave-chunk-data-root',
  'x-arweave-chunk-tx-id',
  'x-ar-io-chunk-source-type',
]);

/**
 * Prefix patterns for dynamic headers that should be signed. Any header whose
 * lowercase name starts with one of these prefixes is signable.
 */
export const SIGNABLE_PREFIXES = ['x-arweave-tag-'];

/**
 * Returns true if the given header name (lowercase) should be included in an
 * HTTP message signature.
 */
export function isSignableHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    SIGNABLE_HEADERS.has(lower) ||
    SIGNABLE_PREFIXES.some((p) => lower.startsWith(p))
  );
}

// Ed25519 SPKI DER has a fixed 12-byte prefix before the raw 32-byte public key.
const SPKI_ED25519_PREFIX_LENGTH = 12;

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
 * Build the covered components list and the Signature-Input structured field
 * value per RFC 9421.
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
 *
 * Each covered component becomes a line: `"component": value`
 * The final line is: `"@signature-params": <params>`
 * Lines are joined by a single newline (0x0A) with no trailing newline.
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
): string {
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

  return lines.join('\n');
}

// --- Attestation utilities (Phase 2) ---

const REQUIRED_JWK_FIELDS = ['n', 'e', 'd', 'p', 'q', 'dp', 'dq', 'qi'];

/**
 * Derive the Solana address from an Ed25519 public key.
 * A Solana address is the base58 encoding of the raw 32-byte public key.
 */
export function getSolanaAddress(publicKey: crypto.KeyObject): string {
  return bs58.encode(getRawPublicKey(publicKey));
}

/**
 * Load and validate an Arweave wallet JWK from a file path.
 */
export function loadWalletJwk(walletFile: string): crypto.JsonWebKey {
  if (!existsSync(walletFile)) {
    throw new Error(`Wallet file not found: ${walletFile}`);
  }
  const raw = readFileSync(walletFile, 'utf8');
  let jwk: Record<string, unknown>;
  try {
    jwk = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid wallet JSON: ${walletFile}`);
  }
  for (const field of REQUIRED_JWK_FIELDS) {
    if (!(field in jwk)) {
      throw new Error(`Wallet JWK missing required field: ${field}`);
    }
  }
  return jwk as crypto.JsonWebKey;
}

/**
 * Resolve the wallet file path for a given observer wallet address.
 */
export function resolveWalletPath(
  walletsPath: string,
  observerWallet: string,
): string {
  const resolved = resolve(walletsPath, `${observerWallet}.json`);
  const normalizedBase = resolve(walletsPath);
  // Use path.relative to check containment — startsWith can be fooled by
  // sibling directories (e.g., "wallets-evil" starts with "wallets").
  const rel = relative(normalizedBase, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `OBSERVER_WALLET contains path traversal: ${observerWallet}`,
    );
  }
  return resolved;
}

/**
 * Derive an Arweave address from an RSA JWK.
 * An Arweave address is the base64url-encoded SHA-256 hash of the raw RSA
 * public key modulus (the 'n' value decoded from base64url).
 */
export function jwkToArweaveAddress(jwk: crypto.JsonWebKey): string {
  if (jwk.n === undefined) {
    throw new Error('JWK missing RSA modulus (n) field');
  }
  const nBuffer = Buffer.from(jwk.n, 'base64url');
  return crypto.createHash('sha256').update(nBuffer).digest('base64url');
}

/**
 * Canonical attestation payload fields. Serialized via json-canonicalize
 * before signing. `gatewayAddress` is undefined when the operator has not
 * set `AR_IO_WALLET`.
 */
export interface AttestationPayload {
  type: 'ar-io-gateway-key-attestation';
  version: 1;
  /** Base64url Arweave address of the observer wallet. */
  observerAddress: string;
  /** Base64url Arweave address of the staked gateway wallet (may be undefined). */
  gatewayAddress: string | undefined;
  /** Base64url 32-byte Ed25519 public key. */
  ed25519PublicKey: string;
  /** Base58 Solana address derived from the Ed25519 key. */
  solanaAddress: string;
  /** Self-contained key ID: `ed25519:<base64url-pubkey>`. */
  keyId: string;
  purpose: 'http-response-signing';
  /** ISO 8601 timestamp of attestation creation. */
  issuedAt: string;
}

/**
 * Signed attestation ready for publication. `payload` is the canonical JSON
 * string, `signature` is the RSA-PSS-SHA256 signature (base64url), and
 * `rsaPublicKey` is the signer's public key in SPKI DER format (base64url).
 */
export interface Attestation {
  payload: string;
  signature: string;
  rsaPublicKey: string;
}

/** Disk-persisted attestation with identity fields for cache invalidation. */
export interface CachedAttestation extends Attestation {
  ed25519PublicKey: string;
  observerAddress?: string;
  gatewayAddress?: string;
  txId?: string;
}

/**
 * Create an attestation document binding an Ed25519 signing key to an Arweave
 * observer wallet identity. The attestation is signed with RSA-PSS-SHA256.
 */
export function createAttestation(opts: {
  observerJwk: crypto.JsonWebKey;
  ed25519PublicKey: crypto.KeyObject;
  gatewayAddress: string | undefined;
}): Attestation {
  const { observerJwk, ed25519PublicKey, gatewayAddress } = opts;

  const observerAddress = jwkToArweaveAddress(observerJwk);
  const pubKeyB64Url = getPublicKeyBase64Url(ed25519PublicKey);
  const solanaAddress = getSolanaAddress(ed25519PublicKey);
  const keyId = deriveKeyId(ed25519PublicKey);

  const attestationObj: AttestationPayload = {
    type: 'ar-io-gateway-key-attestation',
    version: 1,
    observerAddress,
    gatewayAddress,
    ed25519PublicKey: pubKeyB64Url,
    solanaAddress,
    keyId,
    purpose: 'http-response-signing',
    issuedAt: new Date().toISOString(),
  };

  // Canonicalize for deterministic signing/verification
  const payload = canonicalize(attestationObj) as string;

  // Sign with RSA-PSS-SHA256 (salt length 0 for broadest Arweave compat)
  const rsaPrivateKey = crypto.createPrivateKey({
    key: observerJwk,
    format: 'jwk',
  });
  const signature = crypto
    .sign('sha256', Buffer.from(payload, 'utf8'), {
      key: rsaPrivateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 0,
    })
    .toString('base64url');

  // Export RSA public key as base64url DER for verifiers
  const rsaPublicKey = crypto
    .createPublicKey(rsaPrivateKey)
    .export({ type: 'spki', format: 'der' })
    .toString('base64url');

  return { payload, signature, rsaPublicKey };
}

const ATTESTATION_CACHE_FILE = 'httpsig-attestation.json';

/**
 * Load a cached attestation if it matches the current Ed25519 key, otherwise
 * create a new one and cache it to disk.
 */
export function loadOrCreateAttestation(opts: {
  keysDir: string;
  observerJwk: crypto.JsonWebKey;
  ed25519PublicKey: crypto.KeyObject;
  gatewayAddress: string | undefined;
}): Attestation & { cached: boolean; txId?: string } {
  const { keysDir, observerJwk, ed25519PublicKey, gatewayAddress } = opts;
  const cachePath = join(keysDir, ATTESTATION_CACHE_FILE);
  const currentPubKey = getPublicKeyBase64Url(ed25519PublicKey);
  const currentObserverAddr = jwkToArweaveAddress(observerJwk);

  // Try to load cached attestation — validate all identity fields
  if (existsSync(cachePath)) {
    try {
      const cached: CachedAttestation = JSON.parse(
        readFileSync(cachePath, 'utf8'),
      );
      if (
        cached.ed25519PublicKey === currentPubKey &&
        cached.observerAddress === currentObserverAddr &&
        cached.gatewayAddress === gatewayAddress
      ) {
        return {
          payload: cached.payload,
          signature: cached.signature,
          rsaPublicKey: cached.rsaPublicKey,
          txId: cached.txId,
          cached: true,
        };
      }
    } catch {
      // Corrupt cache — delete before recreating
      try {
        unlinkSync(cachePath);
      } catch {
        // Ignore delete failure
      }
    }
  }

  // Create new attestation
  const attestation = createAttestation({
    observerJwk,
    ed25519PublicKey,
    gatewayAddress,
  });

  // Cache to disk atomically (write to temp, then rename)
  const cacheData: CachedAttestation = {
    ...attestation,
    ed25519PublicKey: currentPubKey,
    observerAddress: currentObserverAddr,
    gatewayAddress,
  };
  mkdirSync(keysDir, { recursive: true });
  const tmpPath = `${cachePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(cacheData, null, 2));
  renameSync(tmpPath, cachePath);

  return { ...attestation, cached: false };
}

/**
 * Persist the Arweave TX ID of a successfully uploaded attestation into the
 * cache file so it survives restarts.
 */
export function saveAttestationTxId(keysDir: string, txId: string): void {
  const cachePath = join(keysDir, ATTESTATION_CACHE_FILE);
  if (!existsSync(cachePath)) return;

  try {
    const cached: CachedAttestation = JSON.parse(
      readFileSync(cachePath, 'utf8'),
    );
    cached.txId = txId;
    const tmpPath = `${cachePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(cached, null, 2));
    renameSync(tmpPath, cachePath);
  } catch {
    // Non-fatal — txId will be re-uploaded next restart
  }
}
