/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Verifies ANS-104 data item signatures over payload bytes as they stream.
 *
 * A data item's ID is the SHA-256 of its signature, and the signature covers a
 * deep hash of the item's owner, target, anchor, tags and payload. Checking the
 * signature against the bytes actually being served proves they are exactly the
 * item's payload: the same content and the same length.
 *
 * Code that locates an item from an offset and size it cannot otherwise vouch
 * for (a size supplied in a request, for instance) must pass the payload
 * through {@link VerifyingPayloadStream} before serving, caching or persisting
 * anything derived from that size. Checking only that the header at the offset
 * carries the right ID is not enough: a wrong size that is still larger than
 * the header passes that check and frames the wrong bytes.
 */

import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from 'node:crypto';
import { Transform, TransformCallback } from 'node:stream';
import { indexToType } from '@dha-team/arbundles';

/** The header fields an ANS-104 signature covers, besides the payload. */
export interface DataItemSignedFields {
  signatureType: number;
  signature: Buffer;
  owner: Buffer;
  /** Target bytes; empty when the item has no target */
  target: Buffer;
  /** Anchor bytes; empty when the item has no anchor */
  anchor: Buffer;
  /** The serialized tag section exactly as it appears in the header */
  tagsBytes: Buffer;
}

/** Why a payload failed verification. */
export type DataItemVerificationFailure =
  | 'size_mismatch'
  | 'invalid_signature'
  | 'unsupported_signature_type';

/** Raised when streamed payload bytes are not the data item's payload. */
export class DataItemVerificationError extends Error {
  constructor(
    message: string,
    readonly reason: DataItemVerificationFailure,
  ) {
    super(message);
    this.name = 'DataItemVerificationError';
  }
}

// Ed25519 SPKI DER prefix that precedes the raw 32-byte public key.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Whether a signature of this type can be verified. */
export function isSupportedSignatureType(signatureType: number): boolean {
  return Object.prototype.hasOwnProperty.call(indexToType, signatureType);
}

function sha384(...parts: Uint8Array[]): Buffer {
  const hash = createHash('sha384');
  for (const part of parts) {
    hash.update(part);
  }
  return hash.digest();
}

/** Deep hash of a blob, given its length and the SHA-384 of its content. */
function blobDeepHash(length: number, contentSha384: Uint8Array): Buffer {
  return sha384(sha384(Buffer.from(`blob${length}`)), contentSha384);
}

function deepHashBytes(data: Uint8Array): Buffer {
  return blobDeepHash(data.byteLength, sha384(data));
}

/**
 * Computes the message an ANS-104 data item signature signs: the deep hash of
 * `["dataitem", "1", signatureType, owner, target, anchor, tags, payload]`.
 *
 * The payload is given as its SHA-384 and length, so it can be hashed
 * incrementally while it streams. The result is identical to arbundles'
 * `deepHash` over the same fields, computed with native synchronous hashing
 * only.
 *
 * @param fields - Signed header fields
 * @param payloadSha384 - SHA-384 of the payload bytes
 * @param payloadSize - Payload length in bytes
 */
export function dataItemSignatureMessage(
  fields: DataItemSignedFields,
  payloadSha384: Uint8Array,
  payloadSize: number,
): Buffer {
  const elements = [
    deepHashBytes(Buffer.from('dataitem')),
    deepHashBytes(Buffer.from('1')),
    deepHashBytes(Buffer.from(fields.signatureType.toString())),
    deepHashBytes(fields.owner),
    deepHashBytes(fields.target),
    deepHashBytes(fields.anchor),
    deepHashBytes(fields.tagsBytes),
    blobDeepHash(payloadSize, payloadSha384),
  ];

  let accumulator = sha384(Buffer.from(`list${elements.length}`));
  for (const element of elements) {
    accumulator = sha384(accumulator, element);
  }
  return accumulator;
}

/**
 * Checks a data item signature against its signature message.
 *
 * Ed25519 (type 2, standard Solana signing) is checked with Node's native
 * implementation, which is much cheaper than the pure-JavaScript verifier
 * arbundles uses. Every other type goes through arbundles' own verifier, so
 * signer-specific message encodings (for example the hex-encoded Solana variant)
 * are handled exactly as when the item was created.
 *
 * @returns Whether the signature is valid; malformed keys or signatures count
 *   as invalid
 * @throws DataItemVerificationError for a signature type with no verifier
 */
export async function verifyDataItemSignature(
  fields: DataItemSignedFields,
  message: Uint8Array,
): Promise<boolean> {
  if (fields.signatureType === 2) {
    try {
      return verifySignature(
        null,
        message,
        createPublicKey({
          key: Buffer.concat([ED25519_SPKI_PREFIX, fields.owner]),
          format: 'der',
          type: 'spki',
        }),
        fields.signature,
      );
    } catch {
      return false;
    }
  }

  if (!isSupportedSignatureType(fields.signatureType)) {
    throw new DataItemVerificationError(
      `No verifier for signature type ${fields.signatureType}`,
      'unsupported_signature_type',
    );
  }

  try {
    return await indexToType[fields.signatureType].verify(
      fields.owner,
      message,
      fields.signature,
    );
  } catch {
    return false;
  }
}

/** Options for {@link VerifyingPayloadStream}. */
export interface VerifyingPayloadStreamOptions {
  /** Signed header fields of the item whose payload is streaming */
  fields: DataItemSignedFields;
  /** Expected payload length in bytes */
  payloadSize: number;
  /** Called once the payload verifies, before its final bytes are released */
  onVerified?: () => void;
  /** Called once when verification fails, before the stream errors */
  onRejected?: (error: DataItemVerificationError) => void;
  /**
   * Called with the time taken to finalize the hash and check the signature
   * (the incremental hashing while bytes stream is not included).
   */
  onVerificationTimed?: (durationMs: number) => void;
}

/**
 * Pass-through stream that verifies a data item's signature over the payload
 * flowing through it.
 *
 * It holds back the most recent chunk and releases it only after the signature
 * checks out at the end of the stream. When verification fails, the stream
 * errors before delivering the final chunk, so a consumer never receives the
 * full declared length. An HTTP response sized by `Content-Length` is
 * therefore visibly truncated, and downstream caches and peers never see a
 * complete body.
 *
 * Errors are {@link DataItemVerificationError}s: `size_mismatch` when more or
 * fewer bytes than `payloadSize` arrive, `invalid_signature` when they do not
 * match the signature.
 */
export class VerifyingPayloadStream extends Transform {
  private readonly payloadHash = createHash('sha384');
  private bytesSeen = 0;
  private heldChunk: Buffer | undefined;
  private settled = false;

  constructor(private readonly options: VerifyingPayloadStreamOptions) {
    super();
  }

  override _transform(
    chunk: Buffer | Uint8Array | string,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.bytesSeen += buffer.length;
    if (this.bytesSeen > this.options.payloadSize) {
      callback(
        this.reject(
          new DataItemVerificationError(
            `Payload exceeds the expected ${this.options.payloadSize} bytes`,
            'size_mismatch',
          ),
        ),
      );
      return;
    }

    this.payloadHash.update(buffer);
    if (this.heldChunk !== undefined) {
      this.push(this.heldChunk);
    }
    this.heldChunk = buffer;
    callback();
  }

  override _flush(callback: TransformCallback): void {
    if (this.bytesSeen !== this.options.payloadSize) {
      callback(
        this.reject(
          new DataItemVerificationError(
            `Payload ended after ${this.bytesSeen} of ${this.options.payloadSize} bytes`,
            'size_mismatch',
          ),
        ),
      );
      return;
    }

    const started = performance.now();
    const message = dataItemSignatureMessage(
      this.options.fields,
      this.payloadHash.digest(),
      this.bytesSeen,
    );

    verifyDataItemSignature(this.options.fields, message).then(
      (valid) => {
        this.options.onVerificationTimed?.(performance.now() - started);
        if (!valid) {
          callback(
            this.reject(
              new DataItemVerificationError(
                'Payload does not match the data item signature',
                'invalid_signature',
              ),
            ),
          );
          return;
        }

        this.settled = true;
        this.options.onVerified?.();
        if (this.heldChunk !== undefined) {
          this.push(this.heldChunk);
          this.heldChunk = undefined;
        }
        callback();
      },
      (error: unknown) => {
        callback(
          this.reject(
            error instanceof DataItemVerificationError
              ? error
              : new DataItemVerificationError(
                  error instanceof Error ? error.message : String(error),
                  'invalid_signature',
                ),
          ),
        );
      },
    );
  }

  private reject(error: DataItemVerificationError): DataItemVerificationError {
    this.heldChunk = undefined;
    if (!this.settled) {
      this.settled = true;
      this.options.onRejected?.(error);
    }
    return error;
  }
}
