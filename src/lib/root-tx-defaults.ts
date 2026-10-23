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
 * The `ROOT_TX_LOOKUP_ORDER` token for CDB64 sources whose reads go over the
 * network: HTTP and Arweave sources, and the shipped `resources/` indexes,
 * whose partitions are stored on Arweave.
 */
export const CDB_REMOTE_LOOKUP_SOURCE = 'cdb-remote';

/**
 * Default `ROOT_TX_LOOKUP_ORDER`.
 *
 * - `cdb` comes right after `db`. With `cdb-remote` in the order, `cdb` asks
 *   only CDB64 sources on local disk, such as the root-TX bands Index Sharing
 *   installs by default, so they answer in milliseconds before any network
 *   source is asked.
 * - `cdb-remote` comes last. It asks the CDB64 sources read over the network,
 *   which by default are the shipped indexes (up to height 1,820,000, read
 *   from Arweave on demand). Asking them last means an ID the local bands do
 *   not hold, such as a fresh item, goes to `gateways` without first waiting
 *   on Arweave reads.
 */
export const DEFAULT_ROOT_TX_LOOKUP_ORDER =
  'db,cdb,gateways,graphql,hyperbeam,cdb-remote';

/**
 * Which CDB64 sources the `cdb` token of a `ROOT_TX_LOOKUP_ORDER` asks.
 *
 * - `all` when the order has no `cdb-remote`: every configured source, local
 *   and remote, in configured order, exactly as before `cdb-remote` existed.
 * - `local` when it has `cdb-remote`: only the sources read from local disk;
 *   `cdb-remote` asks the rest at its own place in the order.
 *
 * Tokens are compared without regard to case or surrounding spaces, as the
 * gateway reads them.
 */
export function cdbLookupScope(order: readonly string[]): 'all' | 'local' {
  return order.some(
    (token) => token.trim().toLowerCase() === CDB_REMOTE_LOOKUP_SOURCE,
  )
    ? 'local'
    : 'all';
}

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
 * skipped without a read. With {@link DEFAULT_ROOT_TX_LOOKUP_ORDER} the
 * shipped indexes, which are read from Arweave, are asked last
 * (`cdb-remote`), so a gateway that installs no bands reads nothing extra
 * before the network sources.
 */
export const DEFAULT_CDB64_ROOT_TX_INDEX_SOURCES = `${INSTALLED_ROOT_TX_INDEX_SOURCE},${SHIPPED_CDB64_ROOT_TX_INDEX_SOURCES}`;
