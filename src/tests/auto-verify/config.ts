/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export interface AutoVerifyConfig {
  iterations: number;
  referenceUrl: string;
  gatewayPort: number;
  resultsDir: string;
  failFast: boolean;
  preserveCache: boolean;
  coreDbPath: string;
  bundlesDbPath: string;
  sqliteDir: string;
}

export function loadConfig(): AutoVerifyConfig {
  const cwd = process.cwd();

  return {
    iterations: parseInt(process.env.AUTO_VERIFY_ITERATIONS ?? '0', 10),
    referenceUrl:
      process.env.AUTO_VERIFY_REFERENCE_URL ?? 'https://arweave.net',
    gatewayPort: parseInt(process.env.AUTO_VERIFY_GATEWAY_PORT ?? '4000', 10),
    resultsDir:
      process.env.AUTO_VERIFY_RESULTS_DIR ?? `${cwd}/data/test-auto-verify`,
    failFast: process.env.AUTO_VERIFY_FAIL_FAST === 'true',
    preserveCache: process.env.AUTO_VERIFY_PRESERVE_CACHE !== 'false',
    coreDbPath: `${cwd}/data/sqlite/core.db`,
    bundlesDbPath: `${cwd}/data/sqlite/bundles.db`,
    sqliteDir: `${cwd}/data/sqlite`,
  };
}
