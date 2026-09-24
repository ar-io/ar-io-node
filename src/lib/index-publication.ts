/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Index publication manifests.
 *
 * A publishing gateway serves one of these documents at `/ar-io/indexes` to
 * advertise the index artifacts it makes available (CDB64 root-tx bands in
 * version 1, other `kind`s later). The document is signed with the gateway's
 * Ed25519 observer key, so a consumer that has read the publisher's registry
 * record can verify the document came from that gateway no matter which
 * mirror, cache or transport delivered it.
 *
 * Two properties this module exists to guarantee:
 *
 * 1. **Relay survival.** The signature covers a canonical (RFC 8785) form of
 *    the document rather than the bytes on the wire, so a manifest copied to
 *    another gateway, archived to Arweave or republished by a mirror still
 *    verifies against the original publisher's key.
 * 2. **Forward compatibility.** Validation ignores unknown fields and
 *    canonicalization preserves them, so a reader built against version 1 can
 *    still verify a document produced by a later version that added fields.
 *    Reconstructing the document from known fields only would silently break
 *    that, which is why canonicalization never rebuilds the object.
 *
 * Nothing here trusts a manifest's contents. A verified manifest proves only
 * who wrote it; the bytes it names are checked by their own SHA-256 digests,
 * and the offsets a CDB64 band contains are verified at use by the data
 * serving path.
 */
import crypto from 'node:crypto';
import { canonicalize } from 'json-canonicalize';

import { isSolanaAddress } from './httpsig.js';

/** Schema version this module reads and writes. */
export const INDEX_PUBLICATION_VERSION = 1;

/**
 * Largest publication document accepted from a remote publisher. Checked
 * against the raw bytes before parsing so a hostile publisher cannot force a
 * large allocation. A 256-partition band costs roughly 30 KB of JSON, so this
 * leaves room for many bands across many indexes.
 */
export const INDEX_PUBLICATION_MAX_BYTES = 4 * 1024 * 1024;

/** Ed25519 signatures are always 64 bytes. */
const ED25519_SIGNATURE_BYTES = 64;

const INDEX_NAME_PATTERN = /^[a-z0-9-]{1,64}$/;
const KIND_PATTERN = /^[a-z0-9-]{1,64}$/;
const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const INFOHASH_V1_PATTERN = /^[0-9a-f]{40}$/;
const INFOHASH_V2_PATTERN = /^[0-9a-f]{64}$/;
const ARWEAVE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** One file within a band, named and digested so it can be verified alone. */
export interface BandFile {
  /** File name as served and as written to disk. Never a path. */
  name: string;
  /** Size in bytes. */
  size: number;
  /** Lowercase hex SHA-256 of the file's contents. */
  sha256: string;
}

/**
 * Where a band can be fetched from as a torrent. Reserved for a torrent
 * transport: publishers in this release never set it, but it is validated so
 * a document from a publisher that does still parses.
 */
export interface BandTorrent {
  /** Lowercase hex SHA-1 infohash (BitTorrent v1). Always present. */
  infohashV1: string;
  /** Lowercase hex SHA-256 infohash (BitTorrent v2), for hybrid torrents. */
  infohashV2?: string;
  magnet: string;
  /** Path or URL the `.torrent` file is served from. */
  torrentUrl: string;
}

/** Where a band can be fetched from over HTTP. */
export interface BandHttp {
  /** Base path or URL; file names from `files` resolve against it. */
  baseUrl: string;
}

/** Where a band has been archived on Arweave, when it has been. */
export interface BandArweave {
  manifestTxId: string;
}

/**
 * One immutable unit of an index. Bands are added and retired over time; a
 * subscriber holding a band's files needs to re-fetch only bands whose file
 * digests it does not already have.
 */
export interface BandDescriptor {
  /** Identifier, unique within its index. Used as a directory name. */
  id: string;
  /** Block height range covered, `[start, end]`; `null` end means open. */
  heightRange?: [number, number | null];
  /** Record count, informational. */
  records?: number;
  files: BandFile[];
  torrent?: BandTorrent;
  http?: BandHttp;
  arweave?: BandArweave;
  /** Kind-specific extras; opaque to this module. */
  metadata?: Record<string, unknown>;
}

/** One index offered by the publisher. */
export interface IndexEntry {
  /** Index name, unique within the publication (e.g. `root-tx-index`). */
  name: string;
  /** Selects the artifact-kind plugin that validates and installs bands. */
  kind: string;
  /**
   * The filter the index was built under, for kinds where coverage depends on
   * one (for CDB64 root-tx indexes, the publisher's `ANS104_UNBUNDLE_FILTER`).
   * A subscriber using registry discovery matches on this; opaque here.
   */
  filter?: unknown;
  bands: BandDescriptor[];
}

export interface IndexPublicationSignature {
  alg: 'ed25519';
  /**
   * The publisher's registered observer address (base58). Deliberately not
   * the `ed25519:<base64url>` form `deriveKeyId` produces for HTTPSig: this
   * value is compared directly against `observerAddress` on the publisher's
   * gateway record, so it carries the same encoding the registry uses. Both
   * forms name the same 32-byte public key.
   */
  keyId: string;
  /** Base64 Ed25519 signature over the canonical unsigned document. */
  sig: string;
}

export interface IndexPublication {
  version: 1;
  /** The publishing gateway's wallet address, as registered. */
  publisher: string;
  /**
   * Monotonic per publisher. A subscriber never installs a publication whose
   * sequence is below the one it already holds, so a replayed or cached older
   * document cannot roll it back. An equal sequence is accepted: it is what an
   * unchanged publisher serves on every poll.
   */
  sequence: number;
  /**
   * SHA-256 of the previous publication document, or `null` for the first.
   * Chains publications into an auditable history.
   */
  previousManifestSha256: string | null;
  issuedAt: string;
  /**
   * When this publication should be considered stale. A subscriber alarms
   * rather than refusing to serve: existing bands keep working.
   */
  expiresAt: string;
  indexes: IndexEntry[];
  /** Absent on a document that has not been signed yet. */
  signature?: IndexPublicationSignature;
}

/** Raised by {@link validateIndexPublication}, naming the offending field. */
export class IndexPublicationValidationError extends Error {
  /** JSON path of the offending value, e.g. `indexes[0].bands[1].sha256`. */
  readonly path: string;

  constructor(path: string, message: string) {
    super(path.length > 0 ? `${path}: ${message}` : message);
    this.name = 'IndexPublicationValidationError';
    this.path = path;
  }
}

function fail(path: string, message: string): never {
  throw new IndexPublicationValidationError(path, message);
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, 'expected an object');
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    fail(path, 'expected an array');
  }
  return value;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    fail(path, 'expected a string');
  }
  return value;
}

function asPattern(value: unknown, path: string, pattern: RegExp): string {
  const str = asString(value, path);
  if (!pattern.test(str)) {
    fail(path, `does not match ${pattern.source}`);
  }
  return str;
}

function asInteger(
  value: unknown,
  path: string,
  { min = 0 }: { min?: number } = {},
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    fail(path, 'expected a safe integer');
  }
  if (value < min) {
    fail(path, `expected an integer >= ${min}`);
  }
  return value;
}

/**
 * Whether a string is acceptable as a band id or file name: the same rule the
 * validator applies to a manifest, exported so anything that maps request
 * input onto these names applies exactly the same one.
 */
export function isValidPathSegment(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    PATH_SEGMENT_PATTERN.test(value) &&
    !value.includes('..') &&
    value !== '.'
  );
}

/** Whether a string is acceptable as an index name. */
export function isValidIndexName(value: unknown): value is string {
  return typeof value === 'string' && INDEX_NAME_PATTERN.test(value);
}

/**
 * A path segment written to disk. Rejects traversal and separators outright
 * rather than relying on a caller to normalize: these names arrive from a
 * remote publisher and become file and directory names.
 */
function asPathSegment(value: unknown, path: string): string {
  const segment = asPattern(value, path, PATH_SEGMENT_PATTERN);
  if (segment.includes('..')) {
    fail(path, 'must not contain ".."');
  }
  if (segment === '.') {
    fail(path, 'must not be "."');
  }
  return segment;
}

function asSolanaAddress(value: unknown, path: string): string {
  if (!isSolanaAddress(value)) {
    fail(path, 'expected a base58-encoded 32-byte address');
  }
  return value;
}

function asTimestamp(value: unknown, path: string): string {
  const str = asString(value, path);
  const parsed = Date.parse(str);
  if (Number.isNaN(parsed)) {
    fail(path, 'expected an ISO 8601 timestamp');
  }
  return str;
}

function validateBandFile(value: unknown, path: string): BandFile {
  const obj = asRecord(value, path);
  return {
    name: asPathSegment(obj.name, `${path}.name`),
    size: asInteger(obj.size, `${path}.size`),
    sha256: asPattern(obj.sha256, `${path}.sha256`, SHA256_HEX_PATTERN),
  };
}

function validateHeightRange(
  value: unknown,
  path: string,
): [number, number | null] {
  const range = asArray(value, path);
  if (range.length !== 2) {
    fail(path, 'expected [start, end]');
  }
  const start = asInteger(range[0], `${path}[0]`);
  if (range[1] === null) {
    return [start, null];
  }
  const end = asInteger(range[1], `${path}[1]`, { min: start });
  return [start, end];
}

function validateBand(value: unknown, path: string): BandDescriptor {
  const obj = asRecord(value, path);

  const band: BandDescriptor = {
    id: asPathSegment(obj.id, `${path}.id`),
    files: [],
  };

  const files = asArray(obj.files, `${path}.files`);
  if (files.length === 0) {
    fail(`${path}.files`, 'expected at least one file');
  }
  const seenNames = new Set<string>();
  band.files = files.map((file, i) => {
    const validated = validateBandFile(file, `${path}.files[${i}]`);
    if (seenNames.has(validated.name)) {
      fail(`${path}.files[${i}].name`, `duplicate file name ${validated.name}`);
    }
    seenNames.add(validated.name);
    return validated;
  });

  if (obj.heightRange !== undefined) {
    band.heightRange = validateHeightRange(
      obj.heightRange,
      `${path}.heightRange`,
    );
  }

  if (obj.records !== undefined) {
    band.records = asInteger(obj.records, `${path}.records`);
  }

  if (obj.torrent !== undefined) {
    const torrent = asRecord(obj.torrent, `${path}.torrent`);
    band.torrent = {
      infohashV1: asPattern(
        torrent.infohashV1,
        `${path}.torrent.infohashV1`,
        INFOHASH_V1_PATTERN,
      ),
      magnet: asString(torrent.magnet, `${path}.torrent.magnet`),
      torrentUrl: asString(torrent.torrentUrl, `${path}.torrent.torrentUrl`),
    };
    if (torrent.infohashV2 !== undefined) {
      band.torrent.infohashV2 = asPattern(
        torrent.infohashV2,
        `${path}.torrent.infohashV2`,
        INFOHASH_V2_PATTERN,
      );
    }
  }

  if (obj.http !== undefined) {
    const http = asRecord(obj.http, `${path}.http`);
    const baseUrl = asString(http.baseUrl, `${path}.http.baseUrl`);
    if (baseUrl.length === 0) {
      fail(`${path}.http.baseUrl`, 'expected a non-empty string');
    }
    band.http = { baseUrl };
  }

  if (obj.arweave !== undefined) {
    const arweave = asRecord(obj.arweave, `${path}.arweave`);
    band.arweave = {
      manifestTxId: asPattern(
        arweave.manifestTxId,
        `${path}.arweave.manifestTxId`,
        ARWEAVE_ID_PATTERN,
      ),
    };
  }

  if (obj.metadata !== undefined) {
    band.metadata = asRecord(obj.metadata, `${path}.metadata`);
  }

  return band;
}

function validateIndexEntry(value: unknown, path: string): IndexEntry {
  const obj = asRecord(value, path);

  const entry: IndexEntry = {
    name: asPattern(obj.name, `${path}.name`, INDEX_NAME_PATTERN),
    kind: asPattern(obj.kind, `${path}.kind`, KIND_PATTERN),
    bands: [],
  };

  const bands = asArray(obj.bands, `${path}.bands`);
  const seenIds = new Set<string>();
  entry.bands = bands.map((band, i) => {
    const validated = validateBand(band, `${path}.bands[${i}]`);
    if (seenIds.has(validated.id)) {
      fail(`${path}.bands[${i}].id`, `duplicate band id ${validated.id}`);
    }
    seenIds.add(validated.id);
    return validated;
  });

  if (obj.filter !== undefined) {
    entry.filter = obj.filter;
  }

  return entry;
}

function validateSignature(
  value: unknown,
  path: string,
): IndexPublicationSignature {
  const obj = asRecord(value, path);
  if (obj.alg !== 'ed25519') {
    fail(`${path}.alg`, 'expected "ed25519"');
  }
  return {
    alg: 'ed25519',
    keyId: asSolanaAddress(obj.keyId, `${path}.keyId`),
    sig: asString(obj.sig, `${path}.sig`),
  };
}

/**
 * Validate an already-parsed publication document.
 *
 * Unknown fields are accepted and preserved by the caller's own reference to
 * the input: this function returns a typed view of the fields version 1
 * understands, and never rebuilds the document for signing.
 *
 * @throws {IndexPublicationValidationError} naming the offending JSON path.
 */
export function validateIndexPublication(input: unknown): IndexPublication {
  const obj = asRecord(input, '');

  if (obj.version !== INDEX_PUBLICATION_VERSION) {
    fail('version', `expected ${INDEX_PUBLICATION_VERSION}`);
  }

  const issuedAt = asTimestamp(obj.issuedAt, 'issuedAt');
  const expiresAt = asTimestamp(obj.expiresAt, 'expiresAt');
  if (Date.parse(expiresAt) < Date.parse(issuedAt)) {
    fail('expiresAt', 'must not precede issuedAt');
  }

  let previousManifestSha256: string | null = null;
  if (obj.previousManifestSha256 !== null) {
    previousManifestSha256 = asPattern(
      obj.previousManifestSha256,
      'previousManifestSha256',
      SHA256_HEX_PATTERN,
    );
  }

  const indexes = asArray(obj.indexes, 'indexes');
  const seenNames = new Set<string>();
  const validatedIndexes = indexes.map((entry, i) => {
    const validated = validateIndexEntry(entry, `indexes[${i}]`);
    if (seenNames.has(validated.name)) {
      fail(`indexes[${i}].name`, `duplicate index name ${validated.name}`);
    }
    seenNames.add(validated.name);
    return validated;
  });

  const publication: IndexPublication = {
    version: INDEX_PUBLICATION_VERSION,
    publisher: asSolanaAddress(obj.publisher, 'publisher'),
    sequence: asInteger(obj.sequence, 'sequence'),
    previousManifestSha256,
    issuedAt,
    expiresAt,
    indexes: validatedIndexes,
  };

  if (obj.signature !== undefined) {
    publication.signature = validateSignature(obj.signature, 'signature');
  }

  return publication;
}

/**
 * Parse and validate a document received as bytes.
 *
 * The size cap is applied to the raw bytes before parsing, so an oversized
 * document from a remote publisher never reaches `JSON.parse`.
 */
export function parseIndexPublication(raw: string | Buffer): IndexPublication {
  return parseIndexPublicationDocument(raw).publication;
}

/**
 * Parse and validate a publication, keeping the document exactly as parsed
 * alongside the validated view.
 *
 * Verify the signature against `signed`, never `publication`. Validation
 * builds `publication` from the fields this version knows, which is what the
 * rest of a reader should use, but the signature covers every member the
 * publisher wrote, including ones added by a later version. Verifying the
 * rebuilt view would drop those and fail, so a version 1 reader could never
 * accept a document from a newer publisher.
 */
export function parseIndexPublicationDocument(raw: string | Buffer): {
  publication: IndexPublication;
  signed: IndexPublication;
} {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
  if (bytes.byteLength > INDEX_PUBLICATION_MAX_BYTES) {
    fail(
      '',
      `document is ${bytes.byteLength} bytes, over the ${INDEX_PUBLICATION_MAX_BYTES} byte limit`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error: any) {
    fail('', `invalid JSON: ${error?.message ?? 'parse failed'}`);
  }

  const publication = validateIndexPublication(parsed);
  // Validation passed, so the parsed document has at least the known shape;
  // what it has beyond that is exactly what the signature must still cover.
  return { publication, signed: parsed as IndexPublication };
}

/**
 * Drop `undefined`-valued properties by round-tripping through JSON, so a
 * document built in memory canonicalizes identically to the same document
 * parsed from the wire. Unknown fields survive, which is what keeps a
 * version 1 verifier able to check a later version's signature.
 */
function toWireForm(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

/**
 * The exact string a signature covers: RFC 8785 canonical JSON of the
 * document with `signature` removed. Property order in the input does not
 * affect the result.
 */
export function canonicalizeIndexPublication(
  publication: IndexPublication,
): string {
  const { signature: _signature, ...unsigned } = publication;
  return canonicalize(toWireForm(unsigned));
}

/**
 * Serialize a publication for writing to disk or sending on the wire.
 *
 * Canonical form is used for the whole signed document, not just the signing
 * base, so that {@link manifestSha256} over this output is reproducible by
 * anyone holding the same document. A publisher must write exactly this
 * string for `previousManifestSha256` chaining to match byte for byte.
 */
export function serializeIndexPublication(
  publication: IndexPublication,
): string {
  return canonicalize(toWireForm(publication));
}

/**
 * SHA-256 of a publication document, as lowercase hex.
 *
 * Accepts either a publication (serialized canonically first) or the raw
 * bytes of one already received, so a subscriber can chain on exactly what it
 * was served.
 */
export function manifestSha256(
  input: IndexPublication | string | Buffer,
): string {
  const bytes =
    typeof input === 'string' || Buffer.isBuffer(input)
      ? input
      : serializeIndexPublication(input);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * Sign a publication, replacing any signature it already carries.
 *
 * @param keyId the publisher's registered observer address, which a verifier
 *   compares against the gateway record before trusting the key.
 */
export function signIndexPublication(
  publication: IndexPublication,
  privateKey: crypto.KeyObject,
  keyId: string,
): IndexPublication {
  const { signature: _signature, ...unsigned } = publication;
  const base = canonicalizeIndexPublication(publication);
  const sig = crypto.sign(null, Buffer.from(base, 'utf8'), privateKey);
  return {
    ...(unsigned as IndexPublication),
    signature: { alg: 'ed25519', keyId, sig: sig.toString('base64') },
  };
}

export type IndexPublicationVerification =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Check a publication's detached signature against a public key.
 *
 * Verifying only proves the document came from the holder of that key. The
 * caller is responsible for establishing that the key is the publisher's:
 * compare `signature.keyId` against the `observerAddress` on the publisher's
 * gateway record before calling this, and check `sequence` afterwards.
 */
export function verifyIndexPublication(
  publication: IndexPublication,
  publicKey: crypto.KeyObject,
): IndexPublicationVerification {
  const signature = publication.signature;
  if (signature === undefined) {
    return { ok: false, reason: 'document is not signed' };
  }
  if (signature.alg !== 'ed25519') {
    return { ok: false, reason: `unsupported algorithm: ${signature.alg}` };
  }

  let sig: Buffer;
  try {
    sig = Buffer.from(signature.sig, 'base64');
  } catch {
    return { ok: false, reason: 'signature is not valid base64' };
  }
  if (sig.byteLength !== ED25519_SIGNATURE_BYTES) {
    return {
      ok: false,
      reason: `signature is ${sig.byteLength} bytes, expected ${ED25519_SIGNATURE_BYTES}`,
    };
  }

  const base = canonicalizeIndexPublication(publication);
  let verified: boolean;
  try {
    verified = crypto.verify(null, Buffer.from(base, 'utf8'), publicKey, sig);
  } catch (error: any) {
    return {
      ok: false,
      reason: `verification failed: ${error?.message ?? 'unknown error'}`,
    };
  }

  return verified ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}
