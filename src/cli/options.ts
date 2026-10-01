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
      'CSV of records: data_item_id,root_tx_id,path,root_data_item_offset,root_data_offset,data_item_size,height ("-" reads stdin). path must be empty',
  },
  skipHeader: {
    alias: '--skip-header',
    description: 'Skip the first line of the CSV',
  },
  publisher: {
    alias: '--publisher <wallet>',
    description:
      "The publishing gateway's registered wallet, which makes band ids unique to it",
  },
  kind: {
    alias: '--kind <kind>',
    description: 'Band kind, e.g. d (delta), r (recent) or h (history)',
  },
  heightRange: {
    alias: '--height-range <from,to>',
    description:
      'Block heights the band covers; "tip" as the end for a band that follows the tip',
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
      'Gateway that range-reads root transactions for the header check (e.g. http://core:4000)',
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
    description: 'A built or installed band directory',
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
  optionMap.skipHeaderCheck,
  optionMap.sampleSize,
  optionMap.dryRun,
];

export const indexBandVerifyOptions: CommanderOption[] = [
  optionMap.bandDir,
  optionMap.gatewayUrl,
  optionMap.sampleSize,
];
