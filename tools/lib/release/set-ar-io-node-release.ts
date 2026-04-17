/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readArIoNodeRelease, writeArIoNodeRelease } from './shared.ts';

function printUsage(): void {
  console.log(`Usage: ./tools/set-ar-io-node-release <value>

Sets the default for AR_IO_NODE_RELEASE in docker-compose.yaml.

Arguments:
  <value>   Version string, e.g. "52" or "53-pre"

Idempotent: exits 0 with a no-op message if already set to the given value.`);
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
  if (!/^\d+(-pre)?$/.test(value)) {
    console.error(`Invalid value: ${value} (expected "<N>" or "<N>-pre")`);
    process.exit(1);
  }

  const current = await readArIoNodeRelease();
  if (current === value) {
    console.log(`AR_IO_NODE_RELEASE already at ${value}`);
    return;
  }

  const changed = await writeArIoNodeRelease(value);
  if (!changed) {
    console.error('Failed to update AR_IO_NODE_RELEASE in docker-compose.yaml');
    process.exit(1);
  }
  console.log(`AR_IO_NODE_RELEASE: ${current} -> ${value}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
