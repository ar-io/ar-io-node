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
  dataItemId?: string;
  field?: string;
  tagIndex?: number;
  sources: Record<string, unknown>;
  details?: string;
}

export interface IterationResult {
  blockRange: BlockRange;
  totalDataItems: number;
  discrepancies: Discrepancy[];
  sourceCounts: Record<string, number>;
  durationMs: number;
}

export interface SourceAdapter {
  name: string;
  getDataItems(
    startHeight: number,
    endHeight: number,
  ): Promise<CanonicalDataItem[]>;
}
