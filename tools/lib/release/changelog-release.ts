/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readChangelog, writeChangelog } from './shared.ts';

function printUsage(): void {
  console.log(`Usage: ./tools/changelog-release <release-number> [--date YYYY-MM-DD]

Replaces the "## [Unreleased]" heading in CHANGELOG.md with
"## [Release N] - DATE".

Arguments:
  <release-number>   Positive integer, e.g. 52

Options:
  --date YYYY-MM-DD   Release date (defaults to today, UTC)
  --help, -h          Show this help

Fails if no [Unreleased] section exists (perhaps already released?).`);
}

function todayIso(): string {
  return new Date().toISOString().split('T')[0];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const releaseNumber = args.find((a) => !a.startsWith('--'));
  const dateIdx = args.indexOf('--date');
  const date = dateIdx >= 0 ? args[dateIdx + 1] : todayIso();

  if (!releaseNumber) {
    printUsage();
    process.exit(1);
  }
  if (!/^\d+$/.test(releaseNumber)) {
    console.error(`Invalid release number: ${releaseNumber}`);
    process.exit(1);
  }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(`Invalid date: ${date} (expected YYYY-MM-DD)`);
    process.exit(1);
  }

  const content = await readChangelog();
  if (!content.includes('## [Unreleased]')) {
    console.error('CHANGELOG.md has no [Unreleased] section');
    process.exit(1);
  }

  const heading = `## [Release ${releaseNumber}] - ${date}`;
  const newContent = content.replace('## [Unreleased]', heading);
  await writeChangelog(newContent);
  console.log(`CHANGELOG.md: [Unreleased] -> [Release ${releaseNumber}] - ${date}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
