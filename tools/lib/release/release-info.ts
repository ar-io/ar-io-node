/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  readArIoNodeRelease,
  readChangelog,
  readImageTags,
  readVersion,
  unreleasedHasContent,
} from './shared.ts';

interface ReleaseInfo {
  version: string;
  versionIsPre: boolean;
  arIoNodeRelease: string;
  changelogUnreleasedHasContent: boolean;
  imageTags: Record<string, string | null>;
}

async function collect(): Promise<ReleaseInfo> {
  const [version, arIoNodeRelease, changelog, imageTags] = await Promise.all([
    readVersion(),
    readArIoNodeRelease(),
    readChangelog(),
    readImageTags(),
  ]);
  return {
    version,
    versionIsPre: version.endsWith('-pre'),
    arIoNodeRelease,
    changelogUnreleasedHasContent: unreleasedHasContent(changelog),
    imageTags,
  };
}

function printUsage(): void {
  console.log(`Usage: ./tools/release-info [--json]

Prints release-related state from the working tree:
- version (from src/version.ts)
- versionIsPre (bool)
- arIoNodeRelease (AR_IO_NODE_RELEASE default in docker-compose.yaml)
- changelogUnreleasedHasContent (bool)
- imageTags (current defaults for tracked *_IMAGE_TAG vars)

Options:
  --json    Output JSON (default: pretty, human-readable)
  --help    Show this help`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  const asJson = args.includes('--json');
  const info = await collect();
  if (asJson) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }
  console.log(`version:                        ${info.version}`);
  console.log(`versionIsPre:                   ${info.versionIsPre}`);
  console.log(`arIoNodeRelease:                ${info.arIoNodeRelease}`);
  console.log(`changelogUnreleasedHasContent:  ${info.changelogUnreleasedHasContent}`);
  console.log(`imageTags:`);
  for (const [key, value] of Object.entries(info.imageTags)) {
    console.log(`  ${key.padEnd(34)} ${value ?? '(not found)'}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
