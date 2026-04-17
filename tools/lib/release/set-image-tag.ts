/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  isValidImageTagValue,
  readImageTag,
  writeImageTag,
} from './shared.ts';

function printUsage(): void {
  console.log(`Usage: ./tools/set-image-tag <ENV_VAR_NAME> <value>

Sets the default for a single image tag env var in docker-compose.yaml.

Arguments:
  <ENV_VAR_NAME>   e.g. CORE_IMAGE_TAG, ENVOY_IMAGE_TAG, LITESTREAM_IMAGE_TAG
  <value>          "latest" or a 40-character lowercase hex git SHA

Idempotent: exits 0 with a no-op message if the tag is already set to the
given value. Fails if the env var is not found in docker-compose.yaml.`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  const [envVar, value] = args;
  if (!envVar || !value) {
    printUsage();
    process.exit(1);
  }
  if (!/^[A-Z][A-Z0-9_]*$/.test(envVar)) {
    console.error(`Invalid env var name: ${envVar}`);
    process.exit(1);
  }
  if (!isValidImageTagValue(value)) {
    console.error(`Invalid value: ${value} (expected "latest" or a 40-char git SHA)`);
    process.exit(1);
  }

  const current = await readImageTag(envVar);
  if (current === null) {
    console.error(`${envVar} not found in docker-compose.yaml`);
    process.exit(1);
  }
  if (current === value) {
    console.log(`${envVar} already at ${value}`);
    return;
  }

  const changed = await writeImageTag(envVar, value);
  if (!changed) {
    console.error(`Failed to update ${envVar}`);
    process.exit(1);
  }
  console.log(`${envVar}: ${current} -> ${value}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
