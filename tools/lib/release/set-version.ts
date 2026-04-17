/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readVersion, writeVersion } from './shared.ts';

function printUsage(): void {
  console.log(`Usage: ./tools/set-version <value>

Sets the release constant in src/version.ts.

Arguments:
  <value>   Version string, e.g. "52" or "53-pre"

Idempotent: exits 0 with a no-op message if the version already matches.`);
}

function isValidVersion(value: string): boolean {
  return /^\d+(-pre)?$/.test(value);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  const value = args[0];
  if (!value) {
    printUsage();
    process.exit(1);
  }
  if (!isValidVersion(value)) {
    console.error(`Invalid version: ${value} (expected "<N>" or "<N>-pre")`);
    process.exit(1);
  }

  const current = await readVersion();
  if (current === value) {
    console.log(`src/version.ts already at ${value}`);
    return;
  }

  const changed = await writeVersion(value);
  if (!changed) {
    console.error('Failed to update src/version.ts');
    process.exit(1);
  }
  console.log(`src/version.ts: ${current} -> ${value}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
