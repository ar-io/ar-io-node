/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readFile } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import * as path from 'node:path';

interface ReleaseStatus {
  currentVersion: string;
  isPreRelease: boolean;
  currentBranch: string;
  isOnDevelop: boolean;
  hasUncommittedChanges: boolean;
  changelogHasUnreleased: boolean;
  dockerImagesOnLatest: boolean;
  arIoNodeReleaseVar: string;
  readyForRelease: boolean;
  suggestedReleaseNumber: string;
}

class ReleaseStatusChecker {
  private git = simpleGit();
  private rootDir: string;

  constructor() {
    this.rootDir = path.resolve(process.cwd());
  }

  async checkStatus(): Promise<ReleaseStatus> {
    console.log('🔍 Checking AR.IO Node release status...\n');

    const [
      currentVersion,
      currentBranch,
      hasUncommittedChanges,
      changelogHasUnreleased,
      dockerImagesOnLatest,
      arIoNodeReleaseVar,
    ] = await Promise.all([
      this.getCurrentVersion(),
      this.getCurrentBranch(),
      this.checkUncommittedChanges(),
      this.checkChangelogHasUnreleased(),
      this.checkDockerImagesOnLatest(),
      this.getArIoNodeReleaseVar(),
    ]);

    const isPreRelease = currentVersion.includes('-pre');
    const isOnDevelop = currentBranch === 'develop';
    const readyForRelease = isOnDevelop &&
      !hasUncommittedChanges &&
      changelogHasUnreleased &&
      dockerImagesOnLatest &&
      isPreRelease;

    const suggestedReleaseNumber = isPreRelease
      ? currentVersion.replace('-pre', '')
      : String(parseInt(currentVersion) + 1);

    return {
      currentVersion,
      isPreRelease,
      currentBranch,
      isOnDevelop,
      hasUncommittedChanges,
      changelogHasUnreleased,
      dockerImagesOnLatest,
      arIoNodeReleaseVar,
      readyForRelease,
      suggestedReleaseNumber,
    };
  }

  private async getCurrentVersion(): Promise<string> {
    try {
      const versionFile = path.join(this.rootDir, 'src/version.ts');
      const content = await readFile(versionFile, 'utf-8');
      const match = content.match(/export const release = '([^']+)'/);
      return match?.[1] ?? 'unknown';
    } catch (error) {
      return 'unknown';
    }
  }

  private async getCurrentBranch(): Promise<string> {
    try {
      const branch = await this.git.revparse(['--abbrev-ref', 'HEAD']);
      return branch.trim();
    } catch (error) {
      return 'unknown';
    }
  }

  private async checkUncommittedChanges(): Promise<boolean> {
    try {
      const status = await this.git.status();
      return !status.isClean();
    } catch (error) {
      return true; // Assume dirty if we can't check
    }
  }

  private async checkChangelogHasUnreleased(): Promise<boolean> {
    try {
      const changelogFile = path.join(this.rootDir, 'CHANGELOG.md');
      const content = await readFile(changelogFile, 'utf-8');

      // Look for [Unreleased] section with content
      const unreleasedMatch = content.match(/## \[Unreleased\](.*?)(?=## \[Release|\n## [^\[]|$)/s);
      if (!unreleasedMatch) return false;

      const unreleasedContent = unreleasedMatch[1].trim();
      // Check if there's meaningful content beyond just section headers
      const hasContent = /^### (Added|Changed|Fixed)/m.test(unreleasedContent) &&
        unreleasedContent.split('\n').some(line => line.startsWith('- '));

      return hasContent;
    } catch (error) {
      return false;
    }
  }

  private async checkDockerImagesOnLatest(): Promise<boolean> {
    try {
      const dockerComposeFile = path.join(this.rootDir, 'docker-compose.yaml');
      const content = await readFile(dockerComposeFile, 'utf-8');

      // Check that image tags default to 'latest' (excluding observer which should stay pinned)
      const imageLines = content.match(/image: ghcr\.io\/ar-io\/.*:\$\{[^}]+:-([^}]+)\}/g) || [];
      const coreImages = imageLines.filter(line => !line.includes('ar-io-observer'));
      return coreImages.every(line => line.includes(':-latest}'));
    } catch (error) {
      return false;
    }
  }

  private async getArIoNodeReleaseVar(): Promise<string> {
    try {
      const dockerComposeFile = path.join(this.rootDir, 'docker-compose.yaml');
      const content = await readFile(dockerComposeFile, 'utf-8');

      const match = content.match(/AR_IO_NODE_RELEASE=\$\{AR_IO_NODE_RELEASE:-([^}]+)\}/);
      return match?.[1] ?? 'unknown';
    } catch (error) {
      return 'unknown';
    }
  }

  displayStatus(status: ReleaseStatus): void {
    console.log('📊 AR.IO Node Release Status');
    console.log('============================');
    console.log(`Current Version: ${status.currentVersion} ${status.isPreRelease ? '(development)' : '(release)'}`);
    console.log(`Branch: ${status.currentBranch} ${this.getStatusIcon(status.isOnDevelop)}`);
    console.log(`Working Tree: ${status.hasUncommittedChanges ? 'dirty ❌' : 'clean ✅'}`);
    console.log(`Changelog: ${status.changelogHasUnreleased ? 'Has unreleased entries ✅' : 'No unreleased content ❌'}`);
    console.log(`Docker Images: ${status.dockerImagesOnLatest ? "Core images using 'latest' tags ✅" : "Core images not using 'latest' tags ❌"}`);
    console.log(`AR_IO_NODE_RELEASE: ${status.arIoNodeReleaseVar} ${status.arIoNodeReleaseVar.includes('-pre') ? '✅' : '⚠️'}`);
    console.log();
    console.log(`Ready for Release: ${status.readyForRelease ? '✅ YES' : '❌ NO'}`);
    console.log(`Suggested Release Number: ${status.suggestedReleaseNumber}`);

    if (!status.readyForRelease) {
      console.log('\n⚠️  Issues to resolve:');
      if (!status.isOnDevelop) {
        console.log('   • Switch to develop branch');
      }
      if (status.hasUncommittedChanges) {
        console.log('   • Commit or stash uncommitted changes');
      }
      if (!status.changelogHasUnreleased) {
        console.log('   • Add entries to [Unreleased] section in CHANGELOG.md');
      }
      if (!status.dockerImagesOnLatest) {
        console.log('   • Ensure core docker image tags default to "latest" in docker-compose.yaml (AO/observer should stay pinned)');
      }
      if (!status.isPreRelease) {
        console.log('   • Current version should be in pre-release format (e.g., "53-pre")');
      }
    } else {
      console.log('\n🚀 Ready to create release! Run:');
      console.log(`   ./tools/prepare-release ${status.suggestedReleaseNumber}`);
    }
  }

  private getStatusIcon(isGood: boolean): string {
    return isGood ? '✅' : '❌';
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`
AR.IO Node Release Status Checker

Usage: ./tools/release-status

Checks the current state of the repository and determines if it's ready
for a release. This includes verifying:
- Current version and branch
- Working tree cleanliness
- Changelog unreleased entries
- Docker image configurations
- Environment variables

Options:
  --help, -h    Show this help message
    `);
    return;
  }

  try {
    const checker = new ReleaseStatusChecker();
    const status = await checker.checkStatus();
    checker.displayStatus(status);
  } catch (error) {
    console.error('❌ Error checking release status:', error);
    process.exit(1);
  }
}

// Run if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}