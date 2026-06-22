/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export interface CanonicalTag {
  name: string; // UTF-8
  value: string; // UTF-8
  index: number;
}

export interface CanonicalDataItem {
  id: string; // base64url
  parentId: string; // base64url
  rootTransactionId: string; // base64url
  height: number;
  ownerAddress: string; // base64url (SHA-256 of owner pubkey)
  target: string; // base64url, empty string if none
  anchor: string; // base64url
  dataSize: number;
  dataOffset: number | null;
  offset: number | null;
  size: number | null;
  ownerOffset: number | null;
  ownerSize: number | null;
  signatureOffset: number | null;
  signatureSize: number | null;
  rootParentOffset: number | null;
  contentType: string | null;
  signatureType: number | null;
  tags: CanonicalTag[];
}

export interface CanonicalTransaction {
  id: string; // base64url
  height: number;
  blockTransactionIndex: number;
  target: string; // base64url, empty string if none
  quantity: string; // decimal string
  reward: string; // decimal string
  anchor: string; // base64url (last_tx)
  dataSize: number;
  contentType: string | null;
  format: number;
  ownerAddress: string; // base64url (SHA-256 of owner pubkey)
  dataRoot: string; // base64url, empty string if none
  offset: number | null;
  tags: CanonicalTag[];
}

/**
 * Sibling of {@link CanonicalDataItem} for the unstable-head pipeline
 * (ClickHouse `new_transactions` / SQLite `new_data_items`).
 *
 * The unstable head writes data items before the offset family is known —
 * `dataOffset`, `offset`, `size`, `ownerOffset`, `ownerSize`,
 * `signatureOffset`, `signatureSize`, and `rootParentOffset` are stable-pipeline
 * artifacts produced by unbundling and post-processing, so they're omitted
 * here. In their place the unstable row carries the `signature` and `owner`
 * (RSA modulus) inline, plus the three denormalized block fields
 * (`blockIndepHash`, `blockTimestamp`, `blockPreviousBlock`) that are
 * snapshotted on each row to bound the orphan-filter join.
 *
 * Field-by-field comparison only makes sense within the unstable pass
 * (sibling-vs-sibling). Comparing against {@link CanonicalDataItem} would
 * surface noise from these intentional shape differences.
 */
export interface CanonicalUnstableDataItem {
  id: string; // base64url
  parentId: string; // base64url
  rootTransactionId: string; // base64url
  height: number;
  blockTransactionIndex: number;
  ownerAddress: string; // base64url (SHA-256 of owner pubkey)
  target: string; // base64url, empty string if none
  anchor: string; // base64url
  dataSize: number;
  contentType: string | null;
  signatureType: number | null;
  signature: string | null; // base64url, INLINE
  owner: string; // base64url RSA modulus, INLINE
  blockIndepHash: string; // base64url
  blockTimestamp: number;
  blockPreviousBlock: string; // base64url
  tags: CanonicalTag[];
}

/**
 * Sibling of {@link CanonicalTransaction} for the unstable-head pipeline
 * (ClickHouse `new_transactions` / SQLite `new_transactions`).
 *
 * Like {@link CanonicalUnstableDataItem}, this omits the offset family
 * (`offset` and friends are stable-pipeline artifacts) and adds inline
 * `signature` / `owner` plus the denormalized block fields carried on each
 * unstable row. Field-by-field comparison is sibling-vs-sibling only —
 * comparing against {@link CanonicalTransaction} would surface noise from
 * these intentional shape differences rather than real divergence.
 */
export interface CanonicalUnstableTransaction {
  id: string; // base64url
  height: number;
  blockTransactionIndex: number;
  target: string; // base64url, empty string if none
  quantity: string; // decimal string
  reward: string; // decimal string
  anchor: string; // base64url (last_tx)
  dataSize: number;
  contentType: string | null;
  format: number;
  ownerAddress: string; // base64url (SHA-256 of owner pubkey)
  dataRoot: string; // base64url, empty string if none
  signature: string | null; // base64url, INLINE
  owner: string; // base64url RSA modulus, INLINE
  blockIndepHash: string; // base64url
  blockTimestamp: number;
  blockPreviousBlock: string; // base64url
  tags: CanonicalTag[];
}

export interface CanonicalBlock {
  indepHash: string; // base64url
  height: number;
  previousBlock: string; // base64url, empty string if none
  nonce: string; // base64url
  hash: string; // base64url
  blockTimestamp: number;
  txCount: number;
  blockSize: number | null;
}

export interface BlockRange {
  start: number;
  end: number;
  description: string;
}

export interface Discrepancy {
  type:
    | 'field_mismatch'
    | 'missing_in_source'
    | 'tag_mismatch'
    | 'count_mismatch';
  entityType?: 'data_item' | 'transaction' | 'block';
  itemId?: string;
  field?: string;
  tagIndex?: number;
  sources: Record<string, unknown>;
  details?: string;
}

export interface IterationResult {
  blockRange: BlockRange;
  totalBlocks: number;
  totalDataItems: number;
  totalTransactions: number;
  discrepancies: Discrepancy[];
  blockSourceCounts: Record<string, number>;
  sourceCounts: Record<string, number>;
  transactionSourceCounts: Record<string, number>;
  durationMs: number;
}

export interface SourceAdapter {
  name: string;
  getBlocks?(startHeight: number, endHeight: number): Promise<CanonicalBlock[]>;
  getDataItems(
    startHeight: number,
    endHeight: number,
  ): Promise<CanonicalDataItem[]>;
  getTransactions?(
    startHeight: number,
    endHeight: number,
  ): Promise<CanonicalTransaction[]>;
  getUnstableDataItems?(
    startHeight: number,
    endHeight: number,
  ): Promise<CanonicalUnstableDataItem[]>;
  getUnstableTransactions?(
    startHeight: number,
    endHeight: number,
  ): Promise<CanonicalUnstableTransaction[]>;
}
