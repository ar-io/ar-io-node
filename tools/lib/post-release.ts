/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readFile, writeFile } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import * as path from 'node:path';

interface PostReleaseOptions {
  dryRun: boolean;
}

class PostReleaseProcessor {
  private git = simpleGit();
  private rootDir: string;
  private options: PostReleaseOptions;
  private changedFiles: string[] = [];
  private currentRelease: string = '';
  private nextRelease: string = '';

  constructor(options: PostReleaseOptions) {
    this.rootDir = path.resolve(process.cwd());
    this.options = options;
  }

  async processPostRelease(): Promise<void> {
    console.log(`🧹 Processing post-release cleanup${this.options.dryRun ? ' (DRY RUN)' : ''}...\n`);

    try {
      await this.validatePreConditions();
      await this.updateVersionToPreRelease();
      await this.updateArIoNodeRelease();
      await this.resetDockerImageTags();
      await this.addUnreleasedSection();

      if (this.options.dryRun) {
        console.log('\n✅ Dry run completed successfully!');
        console.log('📝 Changes that would be made:');
        this.changedFiles.forEach(file => console.log(`   • ${file}`));
        console.log('\n💡 Run without --dry-run to apply changes');
        return;
      }

      await this.commitChanges();

      console.log('\n✅ Post-release processing completed successfully!');
      console.log(`\n🎯 Development branch ready for release ${this.nextRelease} development`);

    } catch (error) {
      if (!this.options.dryRun && this.changedFiles.length > 0) {
        console.log('\n⚠️  Rolling back changes due to error...');
        await this.rollbackChanges();
      }
      throw error;
    }
  }

  private async validatePreConditions(): Promise<void> {
    console.log('🔍 Validating preconditions...');

    // Check if on develop branch
    const currentBranch = await this.git.revparse(['--abbrev-ref', 'HEAD']);
    if (currentBranch.trim() !== 'develop') {
      throw new Error(`Must be on develop branch (currently on: ${currentBranch.trim()})`);
    }

    // Check for clean working tree
    const status = await this.git.status();
    if (!status.isClean()) {
      throw new Error('Working tree must be clean (commit or stash changes first)');
    }

    // Get current version and determine next release
    this.currentRelease = await this.getCurrentVersion();

    // Validate current version is in release format (not pre-release)
    if (this.currentRelease.includes('-pre')) {
      throw new Error(`Current version (${this.currentRelease}) is already in pre-release format. Post-release cleanup may have already been done.`);
    }

    // Validate version is numeric
    if (!/^\d+$/.test(this.currentRelease)) {
      throw new Error(`Current version (${this.currentRelease}) should be a release number`);
    }

    // Calculate next release
    this.nextRelease = (parseInt(this.currentRelease) + 1).toString();

    console.log(`✅ Current release: ${this.currentRelease}, preparing for: ${this.nextRelease}-pre`);
  }

  private async getCurrentVersion(): Promise<string> {
    try {
      const versionFile = path.join(this.rootDir, 'src/version.ts');
      const content = await readFile(versionFile, 'utf-8');
      const match = content.match(/export const release = '([^']+)'/);
      return match?.[1] ?? 'unknown';
    } catch (error) {
      throw new Error('Could not read current version from src/version.ts');
    }
  }

  private async updateVersionToPreRelease(): Promise<void> {
    console.log(`📝 Updating src/version.ts to ${this.nextRelease}-pre...`);

    const versionFile = path.join(this.rootDir, 'src/version.ts');
    const content = await readFile(versionFile, 'utf-8');

    const newContent = content.replace(
      /export const release = '[^']+'/,
      `export const release = '${this.nextRelease}-pre'`
    );

    if (content === newContent) {
      throw new Error('Failed to update src/version.ts - release constant not found');
    }

    if (!this.options.dryRun) {
      await writeFile(versionFile, newContent, 'utf-8');
    }
    this.changedFiles.push('src/version.ts');
    console.log(`✅ Updated version to ${this.nextRelease}-pre`);
  }

  private async updateArIoNodeRelease(): Promise<void> {
    console.log(`📝 Updating AR_IO_NODE_RELEASE to ${this.nextRelease}-pre...`);

    const dockerComposeFile = path.join(this.rootDir, 'docker-compose.yaml');
    const content = await readFile(dockerComposeFile, 'utf-8');

    const newContent = content.replace(
      new RegExp(`AR_IO_NODE_RELEASE=\\$\\{AR_IO_NODE_RELEASE:-${this.currentRelease}\\}`, 'g'),
      `AR_IO_NODE_RELEASE=\${AR_IO_NODE_RELEASE:-${this.nextRelease}-pre}`
    );

    if (content === newContent) {
      throw new Error(`Failed to update docker-compose.yaml - AR_IO_NODE_RELEASE:-${this.currentRelease} not found`);
    }

    if (!this.options.dryRun) {
      await writeFile(dockerComposeFile, newContent, 'utf-8');
    }
    this.changedFiles.push('docker-compose.yaml');
    console.log(`✅ Updated AR_IO_NODE_RELEASE to ${this.nextRelease}-pre`);
  }

  private async resetDockerImageTags(): Promise<void> {
    console.log('📝 Resetting docker image tags to latest...');

    const dockerComposeFile = path.join(this.rootDir, 'docker-compose.yaml');
    let content = await readFile(dockerComposeFile, 'utf-8');

    // Core images that should be reset to latest (exclude observer which stays pinned)
    const imageResets = [
      { name: 'ENVOY_IMAGE_TAG', pattern: /ENVOY_IMAGE_TAG:-[a-f0-9]{40}/ },
      { name: 'CORE_IMAGE_TAG', pattern: /CORE_IMAGE_TAG:-[a-f0-9]{40}/ },
      { name: 'CLICKHOUSE_AUTO_IMPORT_IMAGE_TAG', pattern: /CLICKHOUSE_AUTO_IMPORT_IMAGE_TAG:-[a-f0-9]{40}/ },
      { name: 'LITESTREAM_IMAGE_TAG', pattern: /LITESTREAM_IMAGE_TAG:-[a-f0-9]{40}/ }
    ];

    let resetCount = 0;
    for (const reset of imageResets) {
      const newContent = content.replace(reset.pattern, `${reset.name}:-latest`);
      if (newContent !== content) {
        content = newContent;
        resetCount++;
        console.log(`  ✅ Reset ${reset.name} to latest`);
      }
    }

    if (resetCount === 0) {
      console.log('  ⚠️  No image tags found to reset (may already be at latest)');
    }

    // Observer and AO CU images should remain pinned
    console.log('  📌 Observer and AO CU images remain pinned as intended');

    if (!this.options.dryRun) {
      await writeFile(dockerComposeFile, content, 'utf-8');
    }
    if (resetCount > 0 && !this.changedFiles.includes('docker-compose.yaml')) {
      this.changedFiles.push('docker-compose.yaml');
    }
    console.log(`✅ Reset ${resetCount} image tags to latest`);
  }

  private async addUnreleasedSection(): Promise<void> {
    console.log('📝 Adding [Unreleased] section to CHANGELOG.md...');

    const changelogFile = path.join(this.rootDir, 'CHANGELOG.md');
    const content = await readFile(changelogFile, 'utf-8');

    // Find where to insert the new Unreleased section (after the format note, before the first release)
    const insertionPoint = content.indexOf(`## [Release ${this.currentRelease}]`);

    if (insertionPoint === -1) {
      throw new Error(`Could not find Release ${this.currentRelease} section in CHANGELOG.md`);
    }

    const unreleasedSection = `## [Unreleased]

### Added

### Changed

### Fixed

`;

    const newContent = content.slice(0, insertionPoint) + unreleasedSection + content.slice(insertionPoint);

    if (!this.options.dryRun) {
      await writeFile(changelogFile, newContent, 'utf-8');
    }
    this.changedFiles.push('CHANGELOG.md');
    console.log('✅ Added [Unreleased] section to CHANGELOG.md');
  }

  private async commitChanges(): Promise<void> {
    console.log('📦 Committing changes...');

    // Auto-detect JIRA ticket from recent commits
    const jiraTicket = await this.detectJiraTicket();

    const commitMessage = `chore: begin development of release ${this.nextRelease} ${jiraTicket}

Post-release cleanup for release ${this.currentRelease}:
- Updated version to ${this.nextRelease}-pre
- Reset core docker image tags to latest (observer/AO remain pinned)
- Updated AR_IO_NODE_RELEASE to ${this.nextRelease}-pre
- Added [Unreleased] section to CHANGELOG.md

Development branch ready for release ${this.nextRelease} features and fixes.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>`;

    await this.git.add(this.changedFiles);
    await this.git.commit(commitMessage);

    const commitHash = await this.git.revparse(['HEAD']);
    console.log(`✅ Created commit: ${commitHash.trim().substring(0, 8)}`);
  }

  private async detectJiraTicket(): Promise<string> {
    try {
      // Look for PE-XXXX pattern in recent commits
      const log = await this.git.log({ maxCount: 5 });

      for (const commit of log.all) {
        const match = commit.message.match(/PE-\d+/);
        if (match) {
          return match[0];
        }
      }

      return 'PE-XXXX';
    } catch (error) {
      return 'PE-XXXX';
    }
  }

  private async rollbackChanges(): Promise<void> {
    try {
      await this.git.checkout(this.changedFiles);
      console.log('✅ Changes rolled back successfully');
    } catch (error) {
      console.error('❌ Failed to rollback changes:', error);
    }
  }
}

function printUsage(): void {
  console.log(`
AR.IO Node Post-Release Processing Tool

Usage: ./tools/post-release [options]

Options:
  --dry-run          Preview changes without applying them
  --help, -h         Show this help message

Examples:
  ./tools/post-release --dry-run
  ./tools/post-release

This tool performs post-release cleanup by:
1. Updating version to next pre-release (e.g., 52 → 53-pre)
2. Resetting core docker image tags to 'latest'
3. Updating AR_IO_NODE_RELEASE environment variable
4. Adding [Unreleased] section to CHANGELOG.md
5. Committing all changes

Observer and AO CU images remain pinned as intended.
  `);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const dryRun = args.includes('--dry-run');

  try {
    const processor = new PostReleaseProcessor({ dryRun });
    await processor.processPostRelease();
  } catch (error) {
    console.error('❌ Error processing post-release:', error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('❌ Fatal error:', error.message);
    process.exit(1);
  });
}