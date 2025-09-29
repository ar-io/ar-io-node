/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readFile, writeFile } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import * as path from 'node:path';

interface FinalizeReleaseOptions {
  releaseNumber: string;
}

interface ImageInfo {
  name: string;
  currentTag: string;
  envVar: string;
}

class ReleaseFinalizer {
  private git = simpleGit();
  private rootDir: string;
  private options: FinalizeReleaseOptions;
  private imageInfo: ImageInfo[] = [
    { name: 'ar-io-envoy', currentTag: '', envVar: 'ENVOY_IMAGE_TAG' },
    { name: 'ar-io-core', currentTag: '', envVar: 'CORE_IMAGE_TAG' },
    { name: 'ar-io-clickhouse-auto-import', currentTag: '', envVar: 'CLICKHOUSE_AUTO_IMPORT_IMAGE_TAG' },
    { name: 'ar-io-litestream', currentTag: '', envVar: 'LITESTREAM_IMAGE_TAG' },
  ];

  constructor(options: FinalizeReleaseOptions) {
    this.rootDir = path.resolve(process.cwd());
    this.options = options;
  }

  async finalizeRelease(): Promise<void> {
    console.log(`🚀 Finalizing release ${this.options.releaseNumber}...\n`);

    try {
      await this.validatePreConditions();
      await this.waitForGitHubActions();
      await this.fetchCurrentImageTags();
      await this.validateImageSHAs();
      await this.updateDockerCompose();
      await this.commitChanges();

      console.log('\n✅ Release finalization completed successfully!');

    } catch (error) {
      console.error(`\n❌ Error finalizing release: ${error}`);
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

    // Check working tree is clean
    const status = await this.git.status();
    if (!status.isClean()) {
      throw new Error('Working tree must be clean (commit or stash changes first)');
    }

    // Validate release number format
    if (!/^\d+$/.test(this.options.releaseNumber)) {
      throw new Error('Release number must be a positive integer');
    }

    // Check current version matches release number
    const currentVersion = await this.getCurrentVersion();
    if (currentVersion !== this.options.releaseNumber) {
      throw new Error(`Current version (${currentVersion}) should be ${this.options.releaseNumber}`);
    }

    console.log('✅ Preconditions validated');
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

  private async waitForGitHubActions(): Promise<void> {
    console.log('⏳ Checking GitHub Actions status...');

    try {
      // Check for running workflows
      const result = await this.executeCommand('gh api repos/ar-io/ar-io-node/actions/runs --jq \'.workflow_runs[] | select(.status == "in_progress" or .status == "queued") | .id\'');

      if (result.trim()) {
        const runningWorkflows = result.trim().split('\n').filter(id => id.length > 0);
        if (runningWorkflows.length > 0) {
          console.log(`Found ${runningWorkflows.length} running workflow(s). Waiting for completion...`);

          let attempts = 0;
          const maxAttempts = 60; // 30 minutes max wait

          while (attempts < maxAttempts) {
            await this.sleep(30000); // Wait 30 seconds
            attempts++;

            const stillRunning = await this.executeCommand('gh api repos/ar-io/ar-io-node/actions/runs --jq \'.workflow_runs[] | select(.status == "in_progress" or .status == "queued") | .id\'');

            if (!stillRunning.trim()) {
              console.log('✅ All workflows completed');
              break;
            }

            if (attempts >= maxAttempts) {
              throw new Error('Timeout waiting for GitHub Actions to complete');
            }

            process.stdout.write('.');
          }
        } else {
          console.log('✅ No running workflows found');
        }
      } else {
        console.log('✅ No running workflows found');
      }
    } catch (error) {
      console.log('⚠️  Could not check GitHub Actions status (continuing anyway)');
    }
  }

  private async fetchCurrentImageTags(): Promise<void> {
    console.log('🐳 Fetching current git commit SHAs for images...');

    for (const image of this.imageInfo) {
      try {
        console.log(`  Fetching ${image.name}...`);

        // Get the latest version's tags for this image
        const result = await this.executeCommand(`gh api "/orgs/ar-io/packages/container/${image.name}/versions" --jq '.[0].metadata.container.tags[]' | grep -v '^latest$' | head -1`);

        const tag = result.trim();

        if (!tag) {
          throw new Error(`Could not find git commit tag for ${image.name}`);
        }

        // Validate it looks like a git SHA (40 hex characters)
        if (!/^[a-f0-9]{40}$/.test(tag)) {
          throw new Error(`Tag ${tag} for ${image.name} does not look like a git commit SHA`);
        }

        image.currentTag = tag;
        console.log(`  ✅ ${image.name}: ${tag.substring(0, 12)}...`);

      } catch (error) {
        throw new Error(`Failed to fetch tag for ${image.name}: ${error}`);
      }
    }
  }

  private async validateImageSHAs(): Promise<void> {
    console.log('🔍 Validating image SHAs exist in git history...');

    for (const image of this.imageInfo) {
      try {
        await this.git.revparse(['--verify', image.currentTag]);
        console.log(`  ✅ ${image.name}: ${image.currentTag.substring(0, 12)} exists in git`);
      } catch (error) {
        throw new Error(`SHA ${image.currentTag} for ${image.name} does not exist in git history`);
      }
    }
  }

  private async updateDockerCompose(): Promise<void> {
    console.log('📝 Updating docker-compose.yaml with image SHAs...');

    const dockerComposeFile = path.join(this.rootDir, 'docker-compose.yaml');
    let content = await readFile(dockerComposeFile, 'utf-8');

    for (const image of this.imageInfo) {
      const oldPattern = `\${${image.envVar}:-latest}`;
      const newPattern = `\${${image.envVar}:-${image.currentTag}}`;

      if (!content.includes(oldPattern)) {
        throw new Error(`Could not find ${oldPattern} in docker-compose.yaml`);
      }

      content = content.replaceAll(oldPattern, newPattern);
      console.log(`  ✅ Updated ${image.envVar} to ${image.currentTag.substring(0, 12)}...`);
    }

    await writeFile(dockerComposeFile, content, 'utf-8');
  }

  private async commitChanges(): Promise<void> {
    console.log('📦 Committing changes...');

    // Try to detect JIRA ticket from recent commits
    const jiraTicket = await this.detectJiraTicket();

    const imageSummary = this.imageInfo
      .map(img => `${img.name}: ${img.currentTag.substring(0, 12)}`)
      .join(', ');

    const commitMessage = `chore: finalize release ${this.options.releaseNumber} with image SHAs ${jiraTicket}

Updated docker-compose.yaml with specific image SHAs:
${this.imageInfo.map(img => `- ${img.name}: ${img.currentTag}`).join('\n')}

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>`;

    await this.git.add(['docker-compose.yaml']);
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

  private async executeCommand(command: string): Promise<string> {
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);

    const { stdout } = await execAsync(command);
    return stdout;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

function printUsage(): void {
  console.log('Usage: finalize-release <release-number>');
  console.log('');
  console.log('Examples:');
  console.log('  finalize-release 52');
  console.log('');
  console.log('This script:');
  console.log('1. Waits for GitHub Actions to complete');
  console.log('2. Fetches current image tags from ghcr.io');
  console.log('3. Validates SHAs exist in git history');
  console.log('4. Updates docker-compose.yaml with specific image SHAs');
  console.log('5. Commits the changes');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  if (args.length !== 1) {
    console.error('❌ Error: Release number is required');
    printUsage();
    process.exit(1);
  }

  const releaseNumber = args[0];

  const finalizer = new ReleaseFinalizer({ releaseNumber });
  await finalizer.finalizeRelease();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('❌ Fatal error:', error.message);
    process.exit(1);
  });
}