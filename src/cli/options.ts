/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Every `ar-io-node` option, in one registry composed into per-command lists,
 * as the `ar.io` CLI does (`@ar.io/sdk`, `src/cli/options.ts`).
 */
import type { CommanderOption } from './types.js';

export const optionMap = {
  debug: {
    alias: '--debug',
    description: 'Print stack traces on errors',
  },
  input: {
    alias: '--input <path>',
    description:
      'CSV of records: data_item_id,root_tx_id,path,root_data_item_offset,root_data_offset,data_item_size,height ("-" reads stdin). path must be empty. Required',
  },
  skipHeader: {
    alias: '--skip-header',
    description: 'Skip the first line of the CSV',
  },
  publisher: {
    alias: '--publisher <wallet>',
    description:
      "The publishing gateway's registered wallet, which makes band ids unique to it. Required",
  },
  kind: {
    alias: '--kind <kind>',
    description:
      'Band kind, e.g. d (delta), r (recent) or h (history). Required',
  },
  heightRange: {
    alias: '--height-range <from,to>',
    description:
      'Block heights the band covers, e.g. 2010500,tip ("tip" for a band that follows the tip). Required',
  },
  supersedes: {
    alias: '--supersedes <ids>',
    description: 'Comma-separated ids of the bands this one replaces',
  },
  metadata: {
    alias: '--metadata <json>',
    description: 'A JSON object of extra band metadata',
  },
  publishDir: {
    alias: '--publish-dir <path>',
    description: 'Where the band is published, one directory per band',
    default: 'data/indexes/published/root-tx-index',
  },
  workDir: {
    alias: '--work-dir <path>',
    description:
      'Scratch space for the build, on the same filesystem as --publish-dir',
    default: 'data/indexes/export',
  },
  gatewayUrl: {
    alias: '--gateway-url <url>',
    description:
      'Gateway the header check range-reads root transactions from: one that holds them, e.g. https://turbo-gateway.com, or http://core:4000 for roots this gateway has',
  },
  readTimeout: {
    alias: '--read-timeout <ms>',
    description:
      'How long each read from a source may take, in milliseconds (default 30000)',
  },
  skipHeaderCheck: {
    alias: '--skip-header-check',
    description:
      'Publish without checking sampled headers against their root transactions',
  },
  sampleSize: {
    alias: '--sample-size <n>',
    description: 'Entries the header check samples (default 150)',
  },
  dryRun: {
    alias: '--dry-run',
    description: 'Build and check the band but publish nothing',
  },
  bandDir: {
    alias: '--band-dir <path>',
    description: 'A built or installed band directory. Required',
  },
  source: {
    alias: '--source <json>',
    description:
      'One record source as an INDEX_EXPORT_SOURCES entry, e.g. {"type":"clickhouse"}, {"type":"sqlite"} or {"type":"csv","path":"data/indexes/overlay/bundler"}. Default: this gateway\'s ClickHouse if CLICKHOUSE_URL is set, else its SQLite',
  },
  from: {
    alias: '--from <height>',
    description: 'Lowest block height to export. Required',
  },
  to: {
    alias: '--to <height>',
    description: 'Highest block height to export. Required',
  },
  fromHeight: {
    alias: '--from <height>',
    description: 'Lowest block height to check. Defaults to the lowest held',
  },
  toHeight: {
    alias: '--to <height>',
    description: 'Highest block height to check. Defaults to the highest held',
  },
  verifyBandsDir: {
    alias: '--bands-dir <path>',
    description:
      'Check a directory of bands instead of a core.db: no gateway and no database, which is how a consumer verifies them before installing',
  },
  skipTxRoot: {
    alias: '--skip-tx-root',
    description:
      'Leave out the tx_root recomputation, the one check that reads every transaction. Everything else is seconds; this is minutes over a whole chain',
  },
  skipLookups: {
    alias: '--skip-lookups',
    description:
      "With --bands-dir, leave out the check of each band's lookup files against its tables and its band.json",
  },
  dataFrom: {
    alias: '--data-from <url>',
    description:
      'An Arweave node or gateway to fetch transaction data from. Required, and it need not be trusted: wrong data can only cause a false alarm, never a false pass',
  },
  sample: {
    alias: '--sample <n>',
    description:
      'How many blocks to audit (default 100). The full set is about 111 GB, so this samples',
  },
  anchorFrom: {
    alias: '--anchor-from <urls>',
    description:
      "Comma-separated Arweave nodes or gateways serving /block/height/N, /block/hash/H and /tx/{id}: the top block is fetched from every one, each header's hash recomputed from its fields, and compared with the index; the samples are fetched from them in turn. Names that resolve to a shared address count as one machine. Without it the run is not anchored and fails unless --allow-unanchored",
  },
  anchorMin: {
    alias: '--anchor-min <n>',
    description:
      'How many distinct machines must serve the anchor block, all with the same recomputed hash (default 2)',
  },
  allowUnanchored: {
    alias: '--allow-unanchored',
    description:
      'Pass without binding the index to the chain (no --anchor-from, or an anchor that did not bind): the result shows only that the index agrees with itself, and says so',
  },
  allowUnbound: {
    alias: '--allow-unbound',
    description:
      "Pass with pre-2.0 blocks that nothing binds: their hashes cannot be recomputed, and no witnessed 2.0 seed fold (an l1-4 band's witness_fork_2_0) reaches a value the chain fixes for them (every one with --core-db or an l1-3 band). Listed in unbound.pre20 either way",
  },
  allowUnverifiedFormat1: {
    alias: '--allow-unverified-format1',
    description:
      'Pass with blocks whose tx_root could not be recomputed because they hold a format-1 transaction with data whose v1 data root no witness gives (every one with --core-db or an l1-3 band). Listed in unbound.txRootFormat1 either way',
  },
  allowIncomplete: {
    alias: '--allow-incomplete',
    description:
      "Pass with blocks the index holds only part of: a transaction a link names, or an owner's key, missing (an exporter publishes a tip band like this). Listed in unbound.incomplete either way",
  },
  allowUnsampled: {
    alias: '--allow-unsampled',
    description:
      'Write with no sample of headers and signatures (no --anchor-from, or every --sample-* 0): transaction ids, their order and every transaction field are then unchecked against the chain',
  },
  sampleFormat1: {
    alias: '--sample-format1 <n>',
    description:
      'Format-1 transactions with data drawn per band from the 2.0 fork, checked against the chain (default 200; 0 to skip): what catches a format-2 transaction relabelled format 1, which a witnessed root does not. Needs --anchor-from',
  },
  sampleBlocks: {
    alias: '--sample-blocks <n>',
    description:
      "Blocks drawn uniformly whose headers are fetched (by the index's own hash), recomputed and compared field by field and by transaction order (default 1000; 0 to skip). Needs --anchor-from",
  },
  sampleTxs: {
    alias: '--sample-txs <n>',
    description:
      "Transactions drawn uniformly per band (per 100,000 heights of a core.db) whose signatures are fetched and verified over the index's fields (default 1000; 0 to skip). Needs --anchor-from",
  },
  sampleSeed: {
    alias: '--seed <n>',
    description:
      'Seeds the samples, to repeat a run (the result reports the seed it drew when none is given)',
  },
  sampleConcurrency: {
    alias: '--concurrency <n>',
    description: 'Sample fetches in flight at once (default 8)',
  },
  spillReserveGb: {
    alias: '--spill-reserve-gb <n>',
    description:
      'Space a run always leaves free under its spill directory, in GB (default 100). Lower it knowingly on a small disk',
  },
  arweaveNodes: {
    alias: '--arweave-nodes <urls>',
    description:
      "Read root transactions from these Arweave nodes (comma-separated, or 'default' for the tip and data nodes), proving every byte against the chain: the root's signature binds its data_root, and every chunk's proof is checked. Exclusive with --gateway-url",
  },
  l2BandsDir: {
    alias: '--bands-dir <path>',
    description:
      'A directory of parquet-l2 bands of one index, as the index-swarm sidecar installs them (data/indexes/installed/<index>) or index-export publishes them (data/indexes/published/<index>). Required',
  },
  verifyPublisher: {
    alias: '--publisher <wallet>',
    description:
      "The publishing gateway's registered wallet: band ids are then checked whole, its tag included",
  },
  onchain: {
    alias: '--onchain <n>',
    description:
      'Items per band whose headers are read at their recorded locations and checked against their ids (default 20; 0 leaves the check out). Read from Arweave nodes unless --gateway-url is given',
  },
  l2GatewayUrl: {
    alias: '--gateway-url <url>',
    description:
      'For --onchain, read root transactions through this gateway instead of Arweave nodes: faster, but the gateway is trusted. Exclusive with --arweave-nodes',
  },
  onchainSeed: {
    alias: '--seed <n>',
    description:
      "Seeds --onchain's sample, to repeat a run (the result reports the seed it drew when none is given)",
  },
  spillMax: {
    alias: '--spill-max <size>',
    description:
      'The most the lookup check may spill to the temp directory, as a DuckDB size (default 128GB); the 69-million-item h1.8M band of ardrive-l2 needs about 65GB',
  },
  l2Publication: {
    alias: '--publication <path|url>',
    description:
      "The publisher's signed index publication (a file, such as data/indexes/published/publication.json, or a URL, such as https://<gateway>/ar-io/indexes/publication.json): every band must be listed in it and every file must have the size and SHA-256 it signs. Needs --publisher-key or --registry-url. Without it the bands are checked only for internal consistency (publisherBound: false)",
  },
  l2PublisherKey: {
    alias: '--publisher-key <address>',
    description:
      "The key --publication must be signed with: the publisher's registered observer address (base58), as its gateway record shows it",
  },
  l2RegistryUrl: {
    alias: '--registry-url <url>',
    description:
      "Read --publication's key from this gateway's view of the registry (its /ar-io/peers), as the index-swarm sidecar does: e.g. http://core:4000. That gateway is trusted for the key",
  },
  l2Index: {
    alias: '--index <name>',
    description:
      'The index to bind to in --publication, when it lists more than one index of the kind checked',
  },
  l1BandsDir: {
    alias: '--l1-bands-dir <path>',
    description:
      "A directory of parquet-l1 bands to find every root transaction in, at the height and index its items give (check 'mined'); every band must be covered. Without it, data/indexes/installed/parquet-l1, then data/indexes/published/parquet-l1, are used where they exist and cover a band; 'none' uses none. The L1 index must itself be verified (index-l1-verify) for this to trust nothing",
  },
  allowAgreement: {
    alias: '--allow-agreement',
    description:
      "Accept a root whose signature arweave-js won't verify when two other machines serve the same signed header (default: such a root is an error)",
  },
  allowUnlocated: {
    alias: '--allow-unlocated',
    description:
      'Pass a band whose items all have no locations (as its band.json declares), so nothing of it can be read on chain (default: such a band fails the located and onchain checks)',
  },
  maxUnchecked: {
    alias: '--max-unchecked <n>',
    description:
      'Drawn on-chain entries per band (fewer than --onchain) that may be left unchecked (nodes busy, data unseeded, a root no node locates) and the band still pass (default 0). Past it, a band with none wrong is inconclusive: ok false, listed in onchain.inconclusiveBands. Every drawn entry counts: none is replaced by another draw',
  },
  maxUnlocatedShare: {
    alias: '--max-unlocated-share <fraction>',
    description:
      "The largest share of a band's items that may be unlocated, so not checkable on chain (default 0.001); a band's unlocated items must also be exactly the ones its band.json declares",
  },
  allowExpired: {
    alias: '--allow-expired',
    description:
      'Bind to a --publication past its expiresAt (default: refused)',
  },
  bandDeadline: {
    alias: '--band-deadline <seconds>',
    description:
      "How long one band's on-chain reads may take (default 1200); items not read by then are unchecked, so the band is inconclusive unless --max-unchecked allows them",
  },
  l2Concurrency: {
    alias: '--concurrency <n>',
    description:
      'How many DuckDB databases check side by side, two threads and 2GB of memory each: bands, and the tables and lookups of a band, are read on them at once, sharing the spill cap (default: a quarter of the CPUs, at most 4, at least 1). At most 16, and at most UV_THREADPOOL_SIZE less 2: each database holds a libuv thread while it reads, and DNS and file reads need the rest (tools/ar-io-node sets UV_THREADPOOL_SIZE=16). The result is the same at any value',
  },
  l2SkipLookups: {
    alias: '--skip-lookups',
    description:
      "Leave out the check of each band's lookup files against its tables, the slowest check on large bands",
  },
  bandsDir: {
    alias: '--bands-dir <path>',
    description:
      'A directory of parquet-l1 bands, as the index-swarm sidecar installs them (data/indexes/installed/parquet-l1). Required',
  },
  coreDb: {
    alias: '--core-db <path>',
    description:
      "The gateway's core.db. Required. Without --fill, the gateway must be stopped and must not have run on it",
  },
  coreDbReadOnly: {
    alias: '--core-db <path>',
    description:
      "The gateway's core.db. Opened read-only, so it can stay up. Required",
  },
  importFrom: {
    alias: '--from <height>',
    description:
      'Start here instead of continuing above what core.db holds. How a gateway that began mid-chain fills in the history beneath it',
  },
  importTo: {
    alias: '--to <height>',
    description:
      'Stop after the band covering this height, so a backfill need not redo what is already held',
  },
  cacheMib: {
    alias: '--cache-mib <n>',
    description:
      'SQLite page cache for the import, in MiB (default 1024). The biggest lever on a long bootstrap: too small and every insert becomes random I/O as the indexes grow',
  },
  maxBands: {
    alias: '--max-bands <n>',
    description: 'Import at most this many bands, then stop',
  },
  fill: {
    alias: '--fill',
    description:
      'Fill only the heights core.db is missing beneath what the gateway indexes itself, while the gateway runs. Short transactions with a pause after each, so the gateway keeps writing',
  },
  force: {
    alias: '--force',
    description: 'Replace --output if it exists',
  },
  output: {
    alias: '--output <path>',
    description:
      'Where to write the records, as CSV with a header line (read it with index-band-build --skip-header). Required',
  },
} satisfies Record<string, CommanderOption>;

export const globalOptions: CommanderOption[] = [optionMap.debug];

export const indexBandBuildOptions: CommanderOption[] = [
  optionMap.input,
  optionMap.skipHeader,
  optionMap.publisher,
  optionMap.kind,
  optionMap.heightRange,
  optionMap.supersedes,
  optionMap.metadata,
  optionMap.publishDir,
  optionMap.workDir,
  optionMap.gatewayUrl,
  optionMap.readTimeout,
  optionMap.skipHeaderCheck,
  optionMap.sampleSize,
  optionMap.dryRun,
];

export const indexBandVerifyOptions: CommanderOption[] = [
  optionMap.bandDir,
  optionMap.gatewayUrl,
  optionMap.arweaveNodes,
  optionMap.allowAgreement,
  optionMap.readTimeout,
  optionMap.sampleSize,
];

export const indexL1ImportOptions: CommanderOption[] = [
  optionMap.bandsDir,
  optionMap.coreDb,
  optionMap.fill,
  optionMap.importFrom,
  optionMap.importTo,
  optionMap.maxBands,
  optionMap.cacheMib,
  optionMap.anchorFrom,
  optionMap.anchorMin,
  optionMap.allowUnanchored,
  optionMap.allowUnbound,
  optionMap.allowIncomplete,
  optionMap.allowUnverifiedFormat1,
  optionMap.allowUnsampled,
  optionMap.sampleBlocks,
  optionMap.sampleTxs,
  optionMap.sampleFormat1,
  optionMap.sampleSeed,
  optionMap.sampleConcurrency,
  optionMap.readTimeout,
  optionMap.spillMax,
  optionMap.spillReserveGb,
];

export const indexL1VerifyOptions: CommanderOption[] = [
  optionMap.coreDbReadOnly,
  optionMap.verifyBandsDir,
  optionMap.skipTxRoot,
  optionMap.skipLookups,
  optionMap.spillMax,
  optionMap.spillReserveGb,
  optionMap.fromHeight,
  optionMap.toHeight,
  optionMap.anchorFrom,
  optionMap.anchorMin,
  optionMap.allowUnanchored,
  optionMap.allowUnbound,
  optionMap.allowIncomplete,
  optionMap.allowUnverifiedFormat1,
  optionMap.sampleBlocks,
  optionMap.sampleTxs,
  optionMap.sampleFormat1,
  optionMap.sampleSeed,
  optionMap.sampleConcurrency,
  optionMap.readTimeout,
  optionMap.l2Publication,
  optionMap.l2PublisherKey,
  optionMap.l2RegistryUrl,
  optionMap.l2Index,
  optionMap.allowExpired,
];

export const indexL2VerifyOptions: CommanderOption[] = [
  optionMap.l2BandsDir,
  optionMap.verifyPublisher,
  optionMap.onchain,
  optionMap.arweaveNodes,
  optionMap.l2GatewayUrl,
  optionMap.onchainSeed,
  optionMap.readTimeout,
  optionMap.fromHeight,
  optionMap.toHeight,
  optionMap.l2SkipLookups,
  optionMap.spillMax,
  optionMap.l2Publication,
  optionMap.l2PublisherKey,
  optionMap.l2RegistryUrl,
  optionMap.l2Index,
  optionMap.l1BandsDir,
  optionMap.allowAgreement,
  optionMap.allowUnlocated,
  optionMap.maxUnchecked,
  optionMap.maxUnlocatedShare,
  optionMap.allowExpired,
  optionMap.bandDeadline,
  optionMap.l2Concurrency,
];

export const indexL1AuditOptions: CommanderOption[] = [
  optionMap.coreDbReadOnly,
  optionMap.dataFrom,
  optionMap.sample,
  optionMap.fromHeight,
  optionMap.toHeight,
];

export const indexBandExportOptions: CommanderOption[] = [
  optionMap.source,
  optionMap.from,
  optionMap.to,
  optionMap.output,
  optionMap.force,
];
