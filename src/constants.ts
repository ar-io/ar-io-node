/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * HTTP header names used throughout the gateway.
 *
 * @remarks
 * Header naming conventions:
 * - `X-AR-IO-*` - AR.IO gateway-specific headers for internal tracking and metadata
 * - `X-Arweave-Chunk-*` - Arweave chunk metadata headers for the raw binary chunk endpoint
 * - `X-ArNS-*` - ArNS (Arweave Name System) resolution metadata
 * - `X-Cache` - Standard cache status header
 * - `Content-Digest` - RFC 9530 standard header for content integrity
 *
 * Chunk endpoint headers (`X-Arweave-Chunk-*`):
 * - Used by `/chunk/:offset/data` endpoint to provide chunk metadata
 * - All chunk metadata is in headers instead of JSON body for the raw binary endpoint
 * - Headers follow Arweave's chunk structure and merkle tree concepts
 * - Source tracking headers (`X-AR-IO-Chunk-*`) identify where chunk data originated
 *
 * @see {@link https://www.rfc-editor.org/rfc/rfc9530.html | RFC 9530 - Content-Digest}
 */
export const headerNames = {
  hops: 'X-AR-IO-Hops',
  // Which retrieval source served the body (e.g. 'ipfs'). Declared centrally so
  // it's referenced consistently and is a candidate for HTTPSIG trigger headers.
  arIoSource: 'X-Ar-Io-Source',
  // IPFS local-only serve mode: on a request, "serve only from the local
  // blockstore, never touch public IPFS/DHT" (peer-fetch recursion guard +
  // trustless holding probe); echoed on a local-only hit so a caller/observer
  // can assert the server honored the mode.
  ipfsLocalOnly: 'X-Ar-Io-Local-Only',
  origin: 'X-AR-IO-Origin',
  originNodeRelease: 'X-AR-IO-Origin-Node-Release',
  digest: 'X-AR-IO-Digest',
  contentDigest: 'Content-Digest',
  expectedDigest: 'X-AR-IO-Expected-Digest',
  stable: 'X-AR-IO-Stable',
  verified: 'X-AR-IO-Verified',
  trusted: 'X-AR-IO-Trusted',
  cache: 'X-Cache',
  chunkSourceType: 'X-AR-IO-Chunk-Source-Type',
  chunkHost: 'X-AR-IO-Chunk-Host',
  chunkDataPath: 'X-Arweave-Chunk-Data-Path',
  chunkDataRoot: 'X-Arweave-Chunk-Data-Root',
  chunkStartOffset: 'X-Arweave-Chunk-Start-Offset',
  chunkRelativeStartOffset: 'X-Arweave-Chunk-Relative-Start-Offset',
  chunkReadOffset: 'X-Arweave-Chunk-Read-Offset',
  chunkTxDataSize: 'X-Arweave-Chunk-Tx-Data-Size',
  chunkTxPath: 'X-Arweave-Chunk-Tx-Path',
  chunkTxId: 'X-Arweave-Chunk-Tx-Id',
  chunkTxStartOffset: 'X-Arweave-Chunk-Tx-Start-Offset',
  rootTransactionId: 'X-AR-IO-Root-Transaction-Id',
  rootPath: 'X-AR-IO-Root-Path',
  rootItemOffset: 'X-AR-IO-Root-Item-Offset',
  rootItemSize: 'X-AR-IO-Root-Item-Size',
  dataItemDataOffset: 'X-AR-IO-Data-Item-Data-Offset',
  dataItemRootParentOffset: 'X-AR-IO-Data-Item-Root-Parent-Offset',
  dataItemOffset: 'X-AR-IO-Data-Item-Offset',
  dataItemSize: 'X-AR-IO-Data-Item-Size',
  rootDataItemOffset: 'X-AR-IO-Root-Data-Item-Offset',
  rootDataOffset: 'X-AR-IO-Root-Data-Offset',
  arnsTtlSeconds: 'X-ArNS-TTL-Seconds',
  arnsName: 'X-ArNS-Name',
  arnsBasename: 'X-ArNS-Basename',
  arnsRecord: 'X-ArNS-Record',
  arnsResolvedId: 'X-ArNS-Resolved-Id',
  /**
   * Storage protocol of the resolved target: `arweave` (the resolved id is an
   * Arweave TX / data-item ID served from the Arweave data path) or `ipfs`
   * (the resolved id is an IPFS CID served via the Kubo IPFS path). Mirrors the
   * ANT record's `targetProtocol`. Lets a client know how to interpret
   * `X-ArNS-Resolved-Id` (43-char TX ID vs CID) without guessing from its shape.
   */
  arnsProtocol: 'X-ArNS-Protocol',
  dataId: 'X-AR-IO-Data-Id',
  /**
   * Identifier of the Solana program that owns the ANT mint that
   * resolved this name (i.e. the AR.IO ANT program). Lets clients verify
   * the ANT lives under a known AR.IO program before trusting downstream
   * metadata.
   */
  arnsAntProgramId: 'X-ArNS-Ant-Program-Id',
  /**
   * Identifier of the specific ANT (the per-name account, not the program)
   * that resolved this request — the ANT mint's PDA (base58 pubkey).
   */
  arnsAntId: 'X-ArNS-Ant-Id',
  arnsResolvedAt: 'X-ArNS-Resolved-At',
  arnsLimit: 'X-ArNS-Undername-Limit',
  arnsIndex: 'X-ArNS-Record-Index',
  via: 'X-AR-IO-Via',
  negativeCache: 'X-AR-IO-Negative-Cache',
  /** Total number of tags on the transaction/data item. */
  arweaveTagCount: 'X-Arweave-Tag-Count',
  /** Set to 'true' when tag count exceeds ARWEAVE_TAG_RESPONSE_HEADERS_MAX. */
  arweaveTagsTruncated: 'X-Arweave-Tags-Truncated',
  // Per-tag headers are emitted dynamically as X-Arweave-Tag-{Name}
  // by setDataHeaders in src/routes/data/handlers.ts.

  // RFC 9421 HTTP Message Signatures
  signature: 'Signature',
  signatureInput: 'Signature-Input',
};

export const verificationPriorities = {
  preferredArns: 80,
  arns: 60,
} as const;

export const DATA_PATH_REGEX =
  /^\/?([a-zA-Z0-9-_]{43})\/?$|^\/?([a-zA-Z0-9-_]{43})\/(.*)$/i;
export const RAW_DATA_PATH_REGEX = /^\/raw\/([a-zA-Z0-9-_]{43})\/?$/i;
export const FARCASTER_FRAME_DATA_PATH_REGEX =
  /^\/local\/farcaster\/frame\/([a-zA-Z0-9-_]{43})\/?$/i;

// Bundle format IDs
export const ANS_102_FORMAT_ID = 0;
export const ANS_104_FORMAT_ID = 1;
