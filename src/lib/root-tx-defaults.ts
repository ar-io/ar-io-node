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

/**
 * Default `ROOT_TX_LOOKUP_ORDER`. `cdb` comes right after `db`: Index Sharing
 * installs root-TX bands by default, and they answer from local disk before
 * any network source is asked.
 */
export const DEFAULT_ROOT_TX_LOOKUP_ORDER = 'db,cdb,gateways,graphql,hyperbeam';

/**
 * Where the index-swarm sidecar installs root-TX bands, as a CDB64 source
 * (relative to the gateway's working directory, `/app` in the image, where
 * compose mounts `data/indexes` read only).
 */
export const INSTALLED_ROOT_TX_INDEX_SOURCE =
  'data/indexes/installed/root-tx-index';

/**
 * The shipped manifests for the Arweave-hosted indexes, which stop at height
 * 1,820,000.
 */
export const SHIPPED_CDB64_ROOT_TX_INDEX_SOURCES =
  'resources/cdb64-root-tx-index-non-ao-non-redstone-with-content-type-to-height-1820000,resources/cdb64-root-tx-index-non-ao-non-redstone-without-content-type-to-height-1820000,resources/cdb64-root-tx-index-ao-to-height-1820000';

/**
 * Default `CDB64_ROOT_TX_INDEX_SOURCES`: the bands the index-swarm sidecar
 * installs, first, so a fresh band answers before an older shipped snapshot,
 * then the shipped indexes. Sources are searched in order. The installed
 * directory need not exist: a missing directory source is waited for (checked
 * every 30 seconds while `CDB64_ROOT_TX_INDEX_WATCH` is on) and is otherwise
 * skipped, so a gateway that installs no bands loses nothing.
 */
export const DEFAULT_CDB64_ROOT_TX_INDEX_SOURCES = `${INSTALLED_ROOT_TX_INDEX_SOURCE},${SHIPPED_CDB64_ROOT_TX_INDEX_SOURCES}`;
