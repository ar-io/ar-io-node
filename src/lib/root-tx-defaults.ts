/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Defaults for the gateway's root-TX lookup, in a module of their own so
 * tools that edit a `.env` (tools/index-swarm-setup) can read them without
 * loading the whole gateway configuration.
 */

/** Default `ROOT_TX_LOOKUP_ORDER`. */
export const DEFAULT_ROOT_TX_LOOKUP_ORDER = 'db,gateways,graphql,hyperbeam,cdb';

/**
 * Default `CDB64_ROOT_TX_INDEX_SOURCES`: the shipped manifests for the
 * Arweave-hosted indexes, which stop at height 1,820,000.
 */
export const DEFAULT_CDB64_ROOT_TX_INDEX_SOURCES =
  'resources/cdb64-root-tx-index-non-ao-non-redstone-with-content-type-to-height-1820000,resources/cdb64-root-tx-index-non-ao-non-redstone-without-content-type-to-height-1820000,resources/cdb64-root-tx-index-ao-to-height-1820000';
