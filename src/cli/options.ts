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
      'How long the header check waits for each root range read (default 30000)',
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
    description:
      'Highest block height to check. For an index reaching below the 2.0 fork, defaults to the fork (422250) or the highest held if lower; for one starting at or above it, to the highest held',
  },
  anchorFrom: {
    alias: '--anchor-from <urls>',
    description:
      'Comma-separated Arweave nodes or gateways to ask for the anchor block hashes. Raw nodes (port 1984) are a different implementation, so their agreement is worth most',
  },
  anchorMin: {
    alias: '--anchor-min <n>',
    description:
      'How many sources must answer for each anchor height (default 2)',
  },
  bandsDir: {
    alias: '--bands-dir <path>',
    description:
      'A directory of parquet-l1 bands, as the index-swarm sidecar installs them (data/indexes/installed/parquet-l1). Required',
  },
  coreDb: {
    alias: '--core-db <path>',
    description: "The gateway's core.db. It must be stopped. Required",
  },
  coreDbReadOnly: {
    alias: '--core-db <path>',
    description:
      "The gateway's core.db. Opened read-only, so it can stay up. Required",
  },
  maxBands: {
    alias: '--max-bands <n>',
    description: 'Import at most this many bands, then stop',
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
  optionMap.readTimeout,
  optionMap.sampleSize,
];

export const indexL1ImportOptions: CommanderOption[] = [
  optionMap.bandsDir,
  optionMap.coreDb,
  optionMap.maxBands,
];

export const indexL1VerifyOptions: CommanderOption[] = [
  optionMap.coreDbReadOnly,
  optionMap.fromHeight,
  optionMap.toHeight,
  optionMap.anchorFrom,
  optionMap.anchorMin,
];

export const indexBandExportOptions: CommanderOption[] = [
  optionMap.source,
  optionMap.from,
  optionMap.to,
  optionMap.output,
  optionMap.force,
];
