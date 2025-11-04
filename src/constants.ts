/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export const headerNames = {
  hops: 'X-AR-IO-Hops',
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
  chunkEndOffset: 'X-Arweave-Chunk-End-Offset',
  chunkRelativeStartOffset: 'X-Arweave-Chunk-Relative-Start-Offset',
  chunkRelativeEndOffset: 'X-Arweave-Chunk-Relative-End-Offset',
  chunkReadOffset: 'X-Arweave-Chunk-Read-Offset',
  chunkTxDataSize: 'X-Arweave-Chunk-Tx-Data-Size',
  chunkSize: 'X-Arweave-Chunk-Size',
  chunkTxPath: 'X-Arweave-Chunk-Tx-Path',
  chunkTxId: 'X-Arweave-Chunk-Tx-Id',
  chunkTxStartOffset: 'X-Arweave-Chunk-Tx-Start-Offset',
  chunkTxEndOffset: 'X-Arweave-Chunk-Tx-End-Offset',
  rootTransactionId: 'X-AR-IO-Root-Transaction-Id',
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
  dataId: 'X-AR-IO-Data-Id',
  arnsProcessId: 'X-ArNS-Process-Id',
  arnsResolvedAt: 'X-ArNS-Resolved-At',
  arnsLimit: 'X-ArNS-Undername-Limit',
  arnsIndex: 'X-ArNS-Record-Index',
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
