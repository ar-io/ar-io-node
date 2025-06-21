/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

//==============================================================================
// Arweave chain fetching and indexing
//==============================================================================

/** An Arweave block was fetched from the network */
export const BLOCK_FETCHED = 'block-fetched';

/** An Arweave block was indexed */
export const BLOCK_INDEXED = 'block-indexed';

/** An Arweave TX from a mined block was fetched from the network */
export const BLOCK_TX_FETCHED = 'block-tx-fetched';

/** An error occurred while fetching an Arweave TX for a mined block */
export const BLOCK_TX_FETCH_FAILED = 'block-tx-fetch-failed';

/** An Arweave TX from a mined block was indexed */
export const BLOCK_TX_INDEXED = 'block-tx-indexed';

/** An Arweave TX was fetch asynchonously from the network */
export const TX_FETCHED = 'tx-fetched';

/** An Arweave TX was indexed */
export const TX_INDEXED = 'tx-indexed';

//==============================================================================
// ANS-104 bundle matching and unbundling
//==============================================================================

/** An Arweave TX containing an ANS-104 bundle was indexed */
export const ANS104_TX_INDEXED = 'ans104-tx-indexed';

/** A transaction or data item containing an ANS-104 bundle was indexed */
export const ANS104_BUNDLE_INDEXED = 'ans104-bundle-indexed';

/** An ANS-104 data item that contains a bundle was indexed */
export const ANS104_NESTED_BUNDLE_INDEXED = 'ans104-nested-bundle-indexed';

/** An ANS-104 bundle was fully unbundled */
export const ANS104_UNBUNDLE_COMPLETE = 'ans104-unbundle-complete';

/** An ANS-104 bundle was queued to be unbundled */
export const ANS104_BUNDLE_QUEUED = 'ans104-bundle-queued';

//==============================================================================
// ANS-104 data item matching and indexing
//==============================================================================

/** A data item matching the ANS-104 indexing filter was unbundled */
export const ANS104_DATA_ITEM_MATCHED = 'ans104-data-item-matched';

/** Data item metadata (tags, owner, etc.) was indexed */
export const ANS104_DATA_ITEM_INDEXED = 'ans104-data-item-indexed';

/** Data item data (hash, offset, size, etc.) was indexed */
export const ANS104_DATA_ITEM_DATA_INDEXED = 'ans104-data-item-data-indexed';
