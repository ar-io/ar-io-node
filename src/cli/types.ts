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
  readTimeout?: string;
  sampleSize?: string;
}

export interface IndexL1ImportCLIOptions extends GlobalCLIOptions {
  bandsDir?: string;
  coreDb?: string;
  maxBands?: string;
  cacheMib?: string;
  from?: string;
  to?: string;
}

export interface IndexL1VerifyCLIOptions extends GlobalCLIOptions {
  coreDb?: string;
  from?: string;
  to?: string;
  anchorFrom?: string;
  anchorMin?: string;
}

export interface IndexBandExportCLIOptions extends GlobalCLIOptions {
  source?: string;
  from?: string;
  to?: string;
  output?: string;
  force?: boolean;
}
