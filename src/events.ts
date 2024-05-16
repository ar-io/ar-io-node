/**
 * AR.IO Gateway
 * Copyright (C) 2022-2023 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
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
