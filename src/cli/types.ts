/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { OptionValues } from 'commander';

/** A value `runCommand` can print. */
export type JsonSerializable =
  | string
  | number
  | boolean
  | null
  | JsonSerializable[]
  | { [key: string]: JsonSerializable | undefined };

/** One entry of an option registry: commander's flags string and help. */
export interface CommanderOption {
  alias: string;
  description: string;
  default?: string | boolean;
}

/** Options every `ar-io-node` command takes. */
export interface GlobalCLIOptions extends OptionValues {
  debug?: boolean;
}

export interface IndexBandBuildCLIOptions extends GlobalCLIOptions {
  input?: string;
  skipHeader?: boolean;
  publisher?: string;
  kind?: string;
  heightRange?: string;
  supersedes?: string;
  metadata?: string;
  publishDir: string;
  workDir: string;
  gatewayUrl?: string;
  readTimeout?: string;
  skipHeaderCheck?: boolean;
  sampleSize?: string;
  dryRun?: boolean;
}

export interface IndexBandVerifyCLIOptions extends GlobalCLIOptions {
  bandDir?: string;
  gatewayUrl?: string;
  arweaveNodes?: string;
  allowAgreement?: boolean;
  readTimeout?: string;
  sampleSize?: string;
}

export interface IndexL1ImportCLIOptions extends GlobalCLIOptions {
  bandsDir?: string;
  coreDb?: string;
  fill?: boolean;
  maxBands?: string;
  cacheMib?: string;
  from?: string;
  to?: string;
  anchorFrom?: string;
  anchorMin?: string;
  allowUnanchored?: boolean;
  allowUnbound?: boolean;
  allowUnverifiedFormat1?: boolean;
  allowIncomplete?: boolean;
  allowUnsampled?: boolean;
  sampleBlocks?: string;
  sampleTxs?: string;
  sampleFormat1?: string;
  seed?: string;
  concurrency?: string;
  readTimeout?: string;
  spillMax?: string;
  spillReserveGb?: string;
}

export interface IndexL1VerifyCLIOptions extends GlobalCLIOptions {
  spillMax?: string;
  spillReserveGb?: string;
  coreDb?: string;
  bandsDir?: string;
  skipTxRoot?: boolean;
  skipLookups?: boolean;
  from?: string;
  to?: string;
  anchorFrom?: string;
  anchorMin?: string;
  allowUnanchored?: boolean;
  allowUnbound?: boolean;
  allowUnverifiedFormat1?: boolean;
  allowIncomplete?: boolean;
  sampleBlocks?: string;
  sampleTxs?: string;
  sampleFormat1?: string;
  seed?: string;
  concurrency?: string;
  readTimeout?: string;
  publication?: string;
  publisherKey?: string;
  registryUrl?: string;
  index?: string;
  allowExpired?: boolean;
}

export interface IndexL2VerifyCLIOptions extends GlobalCLIOptions {
  bandsDir?: string;
  publisher?: string;
  onchain?: string;
  seed?: string;
  spillMax?: string;
  arweaveNodes?: string;
  gatewayUrl?: string;
  readTimeout?: string;
  from?: string;
  to?: string;
  skipLookups?: boolean;
  publication?: string;
  publisherKey?: string;
  registryUrl?: string;
  index?: string;
  l1BandsDir?: string;
  allowAgreement?: boolean;
  allowUnlocated?: boolean;
  maxUnchecked?: string;
  maxUnlocatedShare?: string;
  allowExpired?: boolean;
  bandDeadline?: string;
  concurrency?: string;
}

export interface IndexL1AuditCLIOptions extends GlobalCLIOptions {
  coreDb?: string;
  dataFrom?: string;
  sample?: string;
  from?: string;
  to?: string;
}

export interface IndexBandExportCLIOptions extends GlobalCLIOptions {
  source?: string;
  from?: string;
  to?: string;
  output?: string;
  force?: boolean;
}

export interface IndexCensusCLIOptions extends GlobalCLIOptions {
  bundlesDb?: string;
  from?: string;
  to?: string;
  roots?: string;
  output?: string;
  force?: boolean;
  bucket?: string;
}
