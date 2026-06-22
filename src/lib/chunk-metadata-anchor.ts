/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { safeBigIntToNumber } from './tx-path-parser.js';
import { ChunkHeaderMetadata } from '../types.js';

/**
 * Chain-verified view of chunk-tx boundary metadata. Returned by
 * {@link anchorChunkMetadata} after the peer's headers have been
 * cross-checked against the chain — only these values are safe to feed
 * merkle proof validation.
 */
export interface AnchoredChunkMetadata {
  txId: string;
  dataRoot: Buffer;
  txStartOffset: number;
  txEndOffset: number;
}

/**
 * Thrown by {@link anchorChunkMetadata} when a peer's `X-Arweave-Chunk-*`
 * header value disagrees with the chain. Carries the field name and both
 * values so callers can log loudly and fall back to the canonical chain
 * lookup. Never silently trust the peer over the node.
 */
export class ChainAnchorMismatchError extends Error {
  readonly field: string;
  readonly headerValue: string;
  readonly chainValue: string;

  constructor(params: {
    field: string;
    headerValue: string | bigint;
    chainValue: string | bigint;
  }) {
    super(
      `Chain anchor mismatch on ${params.field}: header=${params.headerValue} chain=${params.chainValue}`,
    );
    this.name = 'ChainAnchorMismatchError';
    this.field = params.field;
    this.headerValue = String(params.headerValue);
    this.chainValue = String(params.chainValue);
  }
}

/**
 * Verify reference-gateway chunk header metadata against the chain and
 * return the chain-anchored view the caller should use for merkle proof
 * validation.
 *
 * The function is pure: it delegates HTTP to the provided fetchers and
 * performs no I/O of its own. On any disagreement between the header
 * values and the chain it throws {@link ChainAnchorMismatchError} —
 * never silently trust the reference gateway over the node.
 */
export async function anchorChunkMetadata(params: {
  headerMetadata: ChunkHeaderMetadata;
  offset: number;
  fetchTxOffset: (txId: string) => Promise<{ size: string; offset: string }>;
  fetchTransaction?: (txId: string) => Promise<{ data_root: string }>;
  anchorDataRoot?: boolean;
}): Promise<AnchoredChunkMetadata> {
  const {
    headerMetadata,
    offset,
    fetchTxOffset,
    fetchTransaction,
    anchorDataRoot = true,
  } = params;

  const chainOffset = await fetchTxOffset(headerMetadata.txId);
  const chainSize = BigInt(chainOffset.size);
  const chainEnd = BigInt(chainOffset.offset);
  const chainStart = chainEnd - chainSize + 1n;

  if (chainSize !== headerMetadata.txDataSize) {
    throw new ChainAnchorMismatchError({
      field: 'txDataSize',
      headerValue: headerMetadata.txDataSize,
      chainValue: chainSize,
    });
  }

  if (chainStart !== headerMetadata.txStartOffset) {
    throw new ChainAnchorMismatchError({
      field: 'txStartOffset',
      headerValue: headerMetadata.txStartOffset,
      chainValue: chainStart,
    });
  }

  const offsetBig = BigInt(offset);
  if (offsetBig < chainStart || offsetBig > chainEnd) {
    throw new ChainAnchorMismatchError({
      field: 'offsetInRange',
      headerValue: offsetBig,
      chainValue: `[${chainStart}, ${chainEnd}]`,
    });
  }

  if (anchorDataRoot) {
    if (fetchTransaction === undefined) {
      throw new Error(
        'anchorDataRoot requested but no fetchTransaction provided',
      );
    }
    const tx = await fetchTransaction(headerMetadata.txId);
    if (tx.data_root !== headerMetadata.dataRoot) {
      throw new ChainAnchorMismatchError({
        field: 'dataRoot',
        headerValue: headerMetadata.dataRoot,
        chainValue: tx.data_root,
      });
    }
  }

  return {
    txId: headerMetadata.txId,
    dataRoot: Buffer.from(headerMetadata.dataRoot, 'base64url'),
    txStartOffset: safeBigIntToNumber(chainStart, 'txStartOffset'),
    txEndOffset: safeBigIntToNumber(chainEnd, 'txEndOffset'),
  };
}
