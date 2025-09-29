/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readFile, writeFile } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import * as path from 'node:path';

interface PrepareReleaseOptions {
  releaseNumber: string;
  dryRun: boolean;
}

class ReleasePreparator {
  private git = simpleGit();
  private rootDir: string;
  private options: PrepareReleaseOptions;
  private changedFiles: string[] = [];

  constructor(options: PrepareReleaseOptions) {
    this.rootDir = path.resolve(process.cwd());
    this.options = options;
  }

  async prepareRelease(): Promise<void> {
    console.log(`🚀 Preparing release ${this.options.releaseNumber}${this.options.dryRun ? ' (DRY RUN)' : ''}...\n`);

    try {
      // Validation phase
      await this.validatePreConditions();

      // Update phase
      await this.updateChangelog();
      await this.updateVersionFile();
      await this.updateDockerCompose();

      if (this.options.dryRun) {
        console.log('\n✅ Dry run completed successfully!');
        console.log('📝 Changes that would be made:');
        this.changedFiles.forEach(file => console.log(`   • ${file}`));
        console.log('\n💡 Run without --dry-run to apply changes');
        return;
      }

      // Commit phase
      await this.commitChanges();

      console.log('\n✅ Release preparation completed successfully!');
      console.log('\n📋 Next steps:');
      console.log('1. Wait for image builds to complete on GitHub Actions');
      console.log('2. Run: ./tools/finalize-release <commit-sha>');
      console.log('3. Test the release: ./tools/test-release');
      console.log('4. Merge to main branch');

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

    // Validate release number format
    if (!/^\d+$/.test(this.options.releaseNumber)) {
      throw new Error('Release number must be a positive integer');
    }

    // Check current version to ensure sequence
    const currentVersion = await this.getCurrentVersion();
    const expectedPreVersion = `${this.options.releaseNumber}-pre`;
    if (currentVersion !== expectedPreVersion) {
      throw new Error(`Current version (${currentVersion}) should be ${expectedPreVersion}`);
    }

    // Check that changelog has unreleased content
    const hasUnreleasedContent = await this.checkChangelogHasUnreleased();
    if (!hasUnreleasedContent) {
      throw new Error('CHANGELOG.md must have content in [Unreleased] section');
    }

    console.log('✅ Preconditions validated');
  }

  private async getCurrentVersion(): Promise<string> {
    const versionFile = path.join(this.rootDir, 'src/version.ts');
    const content = await readFile(versionFile, 'utf-8');
    const match = content.match(/export const release = '([^']+)'/);
    return match?.[1] ?? 'unknown';
  }

  private async checkChangelogHasUnreleased(): Promise<boolean> {
    const changelogFile = path.join(this.rootDir, 'CHANGELOG.md');
    const content = await readFile(changelogFile, 'utf-8');

    const unreleasedMatch = content.match(/## \[Unreleased\](.*?)(?=## \[Release|\n## [^\[]|$)/s);
    if (!unreleasedMatch) return false;

    const unreleasedContent = unreleasedMatch[1].trim();
    return /^### (Added|Changed|Fixed)/m.test(unreleasedContent) &&
           unreleasedContent.split('\n').some(line => line.startsWith('- '));
  }

  private async updateChangelog(): Promise<void> {
    console.log('📝 Updating CHANGELOG.md...');

    const changelogFile = path.join(this.rootDir, 'CHANGELOG.md');
    const content = await readFile(changelogFile, 'utf-8');

    const today = new Date().toISOString().split('T')[0];
    const newContent = content.replace(
      /## \[Unreleased\]/,
      `## [Release ${this.options.releaseNumber}] - ${today}`
    );

    if (content === newContent) {
      throw new Error('Failed to update CHANGELOG.md - [Unreleased] section not found');
    }

    if (!this.options.dryRun) {
      await writeFile(changelogFile, newContent, 'utf-8');
    }
    this.changedFiles.push('CHANGELOG.md');
    console.log(`✅ Updated CHANGELOG.md (Release ${this.options.releaseNumber} - ${today})`);
  }

  private async updateVersionFile(): Promise<void> {
    console.log('📝 Updating src/version.ts...');

    const versionFile = path.join(this.rootDir, 'src/version.ts');
    const content = await readFile(versionFile, 'utf-8');

    const newContent = content.replace(
      /export const release = '[^']+'/,
      `export const release = '${this.options.releaseNumber}'`
    );

    if (content === newContent) {
      throw new Error('Failed to update src/version.ts - release constant not found');
    }

    if (!this.options.dryRun) {
      await writeFile(versionFile, newContent, 'utf-8');
    }
    this.changedFiles.push('src/version.ts');
    console.log(`✅ Updated version to ${this.options.releaseNumber}`);
  }

  private async updateDockerCompose(): Promise<void> {
    console.log('📝 Updating docker-compose.yaml...');
    // Note: This only updates AR_IO_NODE_RELEASE. AO CU and observer images
    // should remain pinned and are not updated during normal releases.

    const dockerComposeFile = path.join(this.rootDir, 'docker-compose.yaml');
    const content = await readFile(dockerComposeFile, 'utf-8');

    const newContent = content.replace(
      /AR_IO_NODE_RELEASE=\$\{AR_IO_NODE_RELEASE:-[^}]+\}/g,
      `AR_IO_NODE_RELEASE=\${AR_IO_NODE_RELEASE:-${this.options.releaseNumber}}`
    );

    if (content === newContent) {
      throw new Error('Failed to update docker-compose.yaml - AR_IO_NODE_RELEASE not found');
    }

    if (!this.options.dryRun) {
      await writeFile(dockerComposeFile, newContent, 'utf-8');
    }
    this.changedFiles.push('docker-compose.yaml');
    console.log(`✅ Updated AR_IO_NODE_RELEASE to ${this.options.releaseNumber}`);
  }

  private async commitChanges(): Promise<void> {
    console.log('📦 Committing changes...');

    await this.git.add(this.changedFiles);
    await this.git.commit(`chore: prepare release ${this.options.releaseNumber} PE-XXXX`);

    const commitHash = await this.git.revparse(['HEAD']);
    console.log(`✅ Created commit: ${commitHash.trim().substring(0, 8)}`);
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
AR.IO Node Release Preparation Tool

Usage: ./tools/prepare-release <release-number> [options]

Arguments:
  <release-number>    The release number (e.g., 52)

Options:
  --dry-run          Preview changes without applying them
  --help, -h         Show this help message

Examples:
  ./tools/prepare-release 52 --dry-run
  ./tools/prepare-release 52

This tool will:
1. Validate preconditions (on develop branch, clean working tree)
2. Update CHANGELOG.md to set release date
3. Remove "-pre" suffix from version in src/version.ts
4. Update AR_IO_NODE_RELEASE in docker-compose.yaml
5. Commit all changes with standard message
  `);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const releaseNumber = args.find(arg => !arg.startsWith('--'));
  const dryRun = args.includes('--dry-run');

  if (!releaseNumber) {
    console.error('❌ Error: Release number is required');
    printUsage();
    process.exit(1);
  }

  try {
    const preparator = new ReleasePreparator({ releaseNumber, dryRun });
    await preparator.prepareRelease();
  } catch (error) {
    console.error('❌ Error preparing release:', error);
    process.exit(1);
  }
}

// Run if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}