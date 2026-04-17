/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readChangelog, writeChangelog } from './shared.ts';

function printUsage(): void {
  console.log(`Usage: ./tools/changelog-add-unreleased

Inserts a fresh "## [Unreleased]" section (with empty Added/Changed/Fixed
subheadings) before the most recent "## [Release N]" heading.

Idempotent: exits 0 with a no-op message if an [Unreleased] section already
exists. Fails if there is no [Release N] heading to anchor against.`);
}

const UNRELEASED_SECTION = `## [Unreleased]

### Added

### Changed

### Fixed

`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const content = await readChangelog();
  if (content.includes('## [Unreleased]')) {
    console.log('CHANGELOG.md already has [Unreleased] section');
    return;
  }

  const anchorMatch = content.match(/## \[Release \d+\]/);
  if (!anchorMatch || anchorMatch.index === undefined) {
    console.error('CHANGELOG.md has no [Release N] heading to anchor against');
    process.exit(1);
  }

  const idx = anchorMatch.index;
  const newContent = content.slice(0, idx) + UNRELEASED_SECTION + content.slice(idx);
  await writeChangelog(newContent);
  console.log('CHANGELOG.md: added [Unreleased] section');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
